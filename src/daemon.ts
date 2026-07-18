import { unlink } from "node:fs/promises";
import { chmod } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { BrowserBridge } from "./bridge.js";
import { tokensMatch } from "./auth.js";
import { PROTOCOL_VERSION, type ControlClientMessage, type ControlServerMessage } from "./protocol.js";
import { clickDetailsScript, clickScript, describeKey, scrollScript, snapshotScript, typeScript } from "./dom-actions.js";
import { TabLeaseManager } from "./tab-lease.js";

type ControlRequest = Extract<ControlClientMessage, { type: "request" }>;

type ClientInfo = { socket: Socket; label?: string };

async function cdp(bridge: BrowserBridge, tabId: number, method: string, params: Record<string, unknown> = {}): Promise<any> {
  return bridge.command({ action: "cdp", tabId, method, params });
}

// Runtime.evaluate reports page-script throws via exceptionDetails instead of
// failing the CDP call outright, so surface those as real errors.
async function evaluate(bridge: BrowserBridge, tabId: number, expression: string): Promise<unknown> {
  const result = await cdp(bridge, tabId, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result?.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Page script failed");
  }
  return result?.result?.value;
}

function snapshotId(tabId: number, generation: number): string {
  return `${tabId}:${generation}`;
}

// The one long-running process that owns the extension connection (via
// BrowserBridge) and authoritative tab state, exposed to many simultaneous
// MCP adapters over a local control socket.
export class DaemonServer {
  private server?: Server;
  private clients = new Map<string, ClientInfo>();
  private tabOwners = new Map<number, string>();
  private leases = new TabLeaseManager();

  constructor(
    private readonly bridge: BrowserBridge,
    private readonly token: string,
    private readonly socketPath: string
  ) {}

  async start(): Promise<void> {
    await this.reclaimStaleSocket();
    const server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    this.server = server;
    if (process.platform !== "win32") await chmod(this.socketPath, 0o600).catch(() => {});
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private async reclaimStaleSocket(): Promise<void> {
    if (process.platform === "win32") return; // named pipes leave no file behind
    const alive = await new Promise<boolean>((resolve) => {
      const probe = createConnection(this.socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (alive) throw new Error(`A Universal Browser Bridge daemon is already listening on ${this.socketPath}`);
    await unlink(this.socketPath).catch(() => {});
  }

  private handleConnection(socket: Socket): void {
    let authenticated = false;
    let buffer = "";
    let clientId = "";
    const authTimer = setTimeout(() => socket.destroy(), 3_000);

    const send = (message: ControlServerMessage) => {
      if (socket.destroyed) return;
      socket.write(`${JSON.stringify(message)}\n`);
    };

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        let message: ControlClientMessage;
        try {
          message = JSON.parse(line) as ControlClientMessage;
        } catch {
          socket.destroy();
          return;
        }

        if (!authenticated) {
          if (message.type !== "hello" || !tokensMatch(message.token, this.token)) {
            socket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          clientId = message.clientId;
          this.clients.set(clientId, { socket, label: message.label });
          send({ type: "ready", version: PROTOCOL_VERSION });
          continue;
        }

        if (message.type === "request") void this.handleRequest(message, clientId, send);
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (clientId) this.clients.delete(clientId);
    });
    socket.on("error", () => {});
  }

  private async handleRequest(message: ControlRequest, clientId: string, send: (message: ControlServerMessage) => void): Promise<void> {
    try {
      const result = await this.dispatch(message, clientId);
      send({ type: "response", id: message.id, result });
    } catch (error) {
      send({ type: "response", id: message.id, error: (error as Error).message });
    }
  }

  private requesterLabel(clientId: string): string {
    return this.clients.get(clientId)?.label || clientId.slice(0, 8);
  }

  private assertGenerationCurrent(tabId: number, requestSnapshotId: string | undefined): void {
    const current = snapshotId(tabId, this.leases.getGeneration(tabId));
    if (requestSnapshotId !== current) {
      throw new Error(`Stale snapshot generation for tab ${tabId}; take a new snapshot before acting.`);
    }
  }

  private async dispatch(message: ControlRequest, clientId: string): Promise<unknown> {
    const { action, tabId } = message;

    if (action === "status") return this.bridge.status();
    if (action === "listTabs") return this.bridge.command({ action: "listTabs" });

    if (action === "createTab") {
      const tab = (await this.bridge.command({ action: "createTab", url: message.url })) as { id: number };
      this.tabOwners.set(tab.id, clientId);
      return tab;
    }

    if (action === "closeTab") {
      if (tabId === undefined) throw new Error("tabId is required");
      const owner = this.tabOwners.get(tabId);
      if (owner && owner !== clientId) {
        throw new Error(`Tab ${tabId} was created by another client (${this.requesterLabel(owner)}); only the owning client may close it.`);
      }
      const result = await this.bridge.command({ action: "closeTab", tabId });
      this.tabOwners.delete(tabId);
      this.leases.forgetTab(tabId);
      return result;
    }

    if (action === "requestApproval") {
      const description = `[${this.requesterLabel(clientId)}] ${message.description ?? ""}`;
      return this.bridge.command({ action: "requestApproval", description });
    }

    if (tabId === undefined) throw new Error(`tabId is required for action "${action}"`);

    if (action === "snapshot") {
      return this.leases.runExclusive(tabId, async () => {
        const result = (await evaluate(this.bridge, tabId, snapshotScript)) as Record<string, unknown>;
        return { ...result, snapshotId: snapshotId(tabId, this.leases.getGeneration(tabId)) };
      });
    }

    if (action === "clickDetails") {
      return this.leases.runExclusive(tabId, async () => {
        this.assertGenerationCurrent(tabId, message.snapshotId);
        return evaluate(this.bridge, tabId, clickDetailsScript(message.ref ?? ""));
      });
    }

    if (action === "click") {
      return this.leases.runExclusive(tabId, async () => {
        this.assertGenerationCurrent(tabId, message.snapshotId);
        return evaluate(this.bridge, tabId, clickScript(message.ref ?? ""));
      });
    }

    if (action === "type") {
      return this.leases.runExclusive(tabId, async () => {
        this.assertGenerationCurrent(tabId, message.snapshotId);
        return evaluate(this.bridge, tabId, typeScript(message.ref ?? "", message.text ?? ""));
      });
    }

    if (action === "navigate") {
      return this.leases.runExclusive(tabId, async () => {
        const result = await cdp(this.bridge, tabId, "Page.navigate", { url: message.url });
        this.leases.bumpGeneration(tabId);
        return result;
      });
    }

    if (action === "press") {
      return this.leases.runExclusive(tabId, async () => {
        const key = message.key ?? "";
        const descriptor = describeKey(key);
        const params = { key, ...descriptor };
        await cdp(this.bridge, tabId, "Input.dispatchKeyEvent", { type: params.text ? "keyDown" : "rawKeyDown", ...params });
        await cdp(this.bridge, tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
        return { pressed: key };
      });
    }

    if (action === "scroll") {
      return this.leases.runExclusive(tabId, () => evaluate(this.bridge, tabId, scrollScript(message.deltaY ?? 0)));
    }

    if (action === "screenshot") {
      return this.leases.runExclusive(tabId, async () => {
        const result = await cdp(this.bridge, tabId, "Page.captureScreenshot", { format: "png" });
        if (!result?.data) throw new Error("Chrome did not return screenshot data");
        return result;
      });
    }

    throw new Error(`Unknown control action "${action}"`);
  }
}
