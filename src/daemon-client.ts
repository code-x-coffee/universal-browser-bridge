import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { PROTOCOL_VERSION, type BridgeStatus, type ControlAction, type ControlClientMessage, type ControlServerMessage } from "./protocol.js";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export type DaemonRequest = Omit<Extract<ControlClientMessage, { type: "request" }>, "type" | "id">;

export type DaemonClientOptions = {
  socketPath: string;
  token: string;
  clientId: string;
  label?: string;
};

// The `mcp` process's link to the `serve` daemon: a thin authenticated client
// over a Unix domain socket (Windows named pipe), never binds any port.
export class DaemonClient {
  private socket?: Socket;
  private buffer = "";
  private pending = new Map<string, Pending>();
  private ready = false;

  constructor(private readonly options: DaemonClientOptions) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.options.socketPath);
      this.socket = socket;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(error);
      };

      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ECONNREFUSED") {
          fail(
            new Error(
              "Universal Browser Bridge daemon is not running. Start it first with `universal-browser-bridge serve` " +
                "(or `npm run serve`), then retry."
            )
          );
          return;
        }
        fail(error);
      });

      socket.once("connect", () => {
        const hello: ControlClientMessage = {
          type: "hello",
          token: this.options.token,
          clientId: this.options.clientId,
          label: this.options.label,
          version: PROTOCOL_VERSION
        };
        socket.write(`${JSON.stringify(hello)}\n`);
      });

      socket.on("data", (chunk) => this.handleData(chunk.toString(), resolve, fail));
      socket.on("close", () => {
        fail(new Error("Daemon closed the connection before authenticating"));
        for (const [id, pending] of this.pending) {
          this.pending.delete(id);
          pending.reject(new Error("Daemon connection closed"));
        }
      });
    });
  }

  private handleData(chunk: string, onReady: () => void, onAuthFail: (error: Error) => void): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      const message = JSON.parse(line) as ControlServerMessage;
      if (message.type === "ready") {
        this.ready = true;
        onReady();
        continue;
      }
      if (message.type === "response") {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      }
    }
  }

  async request(body: DaemonRequest): Promise<unknown> {
    if (!this.socket || !this.ready) throw new Error("Not connected to the Universal Browser Bridge daemon");
    const id = randomUUID();
    const message: ControlClientMessage = { type: "request", id, ...body };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket?.write(`${JSON.stringify(message)}\n`);
    });
  }

  async status(): Promise<BridgeStatus> {
    return (await this.request({ action: "status" as ControlAction })) as BridgeStatus;
  }

  async close(): Promise<void> {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(new Error("Daemon connection closed"));
    }
    this.socket?.end();
    this.socket?.destroy();
  }
}
