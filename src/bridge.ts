import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import { PROTOCOL_VERSION, type BridgeCommand, type BridgeStatus, type ExtensionMessage, type SharedTab } from "./protocol.js";
import { tokensMatch } from "./auth.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class BrowserBridge {
  private extension?: WebSocket;
  private tabs: SharedTab[] = [];
  private pending = new Map<string, Pending>();

  constructor(
    private readonly token: string,
    private readonly host = "127.0.0.1",
    private readonly port = 17321
  ) {}

  async start(): Promise<void> {
    const server = createServer((req, res) => void this.handleHttp(req, res));
    const wss = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      if (req.url !== "/extension" || req.headers.origin?.startsWith("chrome-extension://") !== true) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attachExtension(ws));
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.port, this.host, resolve);
    });
  }

  status(): BridgeStatus {
    return { connected: this.extension?.readyState === WebSocket.OPEN, protocolVersion: PROTOCOL_VERSION, tabs: this.tabs };
  }

  async command(command: Omit<BridgeCommand, "type" | "id">): Promise<unknown> {
    if (!this.extension || this.extension.readyState !== WebSocket.OPEN) {
      throw new Error("Chrome extension is not connected");
    }
    const id = randomUUID();
    const payload: BridgeCommand = { type: "command", id, ...command };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Browser command timed out: ${command.action}`));
      }, 20_000);
      this.pending.set(id, { resolve, reject, timer });
      this.extension?.send(JSON.stringify(payload));
    });
  }

  private attachExtension(ws: WebSocket): void {
    let authenticated = false;
    const authTimer = setTimeout(() => ws.close(4401, "Authentication timeout"), 3_000);

    ws.on("message", (raw) => {
      let message: ExtensionMessage;
      try {
        message = JSON.parse(raw.toString()) as ExtensionMessage;
      } catch {
        ws.close(4400, "Invalid JSON");
        return;
      }

      if (!authenticated) {
        if (
          message.type !== "hello" ||
          message.version !== PROTOCOL_VERSION ||
          !tokensMatch(message.token, this.token)
        ) {
          ws.close(4401, "Authentication failed");
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        this.extension?.close(4409, "Replaced by a newer extension connection");
        this.extension = ws;
        ws.send(JSON.stringify({ type: "ready", version: PROTOCOL_VERSION }));
        ws.send(JSON.stringify({ type: "command", id: randomUUID(), action: "listTabs" }));
        return;
      }

      if (message.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (message.type === "tabs") this.tabs = message.tabs;
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      }
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (this.extension === ws) {
        this.extension = undefined;
        this.tabs = [];
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          this.pending.delete(id);
          pending.reject(new Error("Chrome extension disconnected"));
        }
      }
    });
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("content-type", "application/json");
    if (req.socket.remoteAddress !== "127.0.0.1" && req.socket.remoteAddress !== "::ffff:127.0.0.1") {
      res.writeHead(403).end(JSON.stringify({ error: "Loopback only" }));
      return;
    }
    if (req.url === "/health" && req.method === "GET") {
      res.end(JSON.stringify(this.status()));
      return;
    }
    res.writeHead(404).end(JSON.stringify({ error: "Not found" }));
  }
}
