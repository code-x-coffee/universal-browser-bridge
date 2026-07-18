import { unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { BrowserBridge } from "./bridge.js";
import { tokensMatch } from "./auth.js";
import { isPotentiallyConsequential } from "./policy.js";
import { PROTOCOL_VERSION, type ControlClientMessage, type ControlServerMessage, type SharedTab } from "./protocol.js";
import { clickDetailsScript, clickScript, describeKey, scrollScript, snapshotScript, typeScript } from "./dom-actions.js";
import { TabLeaseManager } from "./tab-lease.js";

type ControlRequest = Extract<ControlClientMessage, { type: "request" }>;

type ClientInfo = { socket: Socket; label?: string };

// Sentinel lease key: serializes createTab calls (which have no tabId yet)
// so two adapters can never both trigger the extension's one-time
// agent-window approval/creation flow at once.
const CREATE_TAB_LOCK = -1;

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
  private knownTabIds = new Set<number>();
  private leases = new TabLeaseManager();

  constructor(
    private readonly bridge: BrowserBridge,
    private readonly token: string,
    private readonly socketPath: string
  ) {
    // Reconcile ownership/lease state for tabs that vanish out-of-band (the
    // user closes them directly in Chrome, or the extension disconnects).
    this.bridge.on("tabs", (tabs: SharedTab[]) => this.reconcileTabs(tabs));
  }

  async start(): Promise<void> {
    await this.reclaimStaleSocket();
    const server = createServer((socket) => this.handleConnection(socket));
    await this.listenWithOwnerOnlyPermissions(server);
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (process.platform !== "win32") await unlink(this.socketPath).catch(() => {});
  }

  // Restricts the socket file to owner-only (0600) from the moment it is
  // created, by narrowing the process umask around the synchronous bind()
  // that listen() performs, rather than chmod-ing after the fact (which
  // leaves a race window where the file briefly has default permissions).
  private async listenWithOwnerOnlyPermissions(server: Server): Promise<void> {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, resolve);
      });
      return;
    }
    const previousUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, resolve);
      });
    } finally {
      process.umask(previousUmask);
    }
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

  private reconcileTabs(tabs: SharedTab[]): void {
    const currentIds = new Set(tabs.map((tab) => tab.id));
    for (const id of [...this.knownTabIds]) {
      if (!currentIds.has(id)) {
        this.knownTabIds.delete(id);
        this.tabOwners.delete(id);
        this.leases.forgetTab(id);
      }
    }
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
      if (!clientId) return;
      this.clients.delete(clientId);
      // An ephemeral client ID that disconnects can never come back, so hold
      // on to that tab forever otherwise; release ownership so a later
      // client can still close it. While the owner stays connected,
      // isolation is unaffected (this only runs on disconnect).
      for (const [tabId, owner] of this.tabOwners) {
        if (owner === clientId) this.tabOwners.delete(tabId);
      }
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

  // Requests human approval, labelled with the requesting adapter's
  // identity. Only called from inside a held tab lease (or the createTab
  // lock), so it is never something an adapter can trigger unilaterally or
  // race against other operations on the same tab.
  private async approve(clientId: string, description: string): Promise<void> {
    const labelled = `[${this.requesterLabel(clientId)}] ${description}`;
    const result = (await this.bridge.command({ action: "requestApproval", description: labelled })) as { approved?: boolean };
    if (!result?.approved) throw new Error(`User denied browser action: ${description}`);
  }

  private async dispatch(message: ControlRequest, clientId: string): Promise<unknown> {
    const { action, tabId } = message;

    if (action === "status") return this.bridge.status();
    if (action === "listTabs") return this.bridge.command({ action: "listTabs" });

    if (action === "createTab") {
      return this.leases.runExclusive(CREATE_TAB_LOCK, async () => {
        const tab = (await this.bridge.command({ action: "createTab", url: message.url })) as { id: number };
        this.tabOwners.set(tab.id, clientId);
        this.knownTabIds.add(tab.id);
        return tab;
      });
    }

    if (action === "closeTab") {
      if (tabId === undefined) throw new Error("tabId is required");
      const owner = this.tabOwners.get(tabId);
      if (owner && owner !== clientId) {
        throw new Error(`Tab ${tabId} was created by another client (${this.requesterLabel(owner)}); only the owning client may close it.`);
      }
      const result = await this.bridge.command({ action: "closeTab", tabId });
      this.tabOwners.delete(tabId);
      this.knownTabIds.delete(tabId);
      this.leases.forgetTab(tabId);
      return result;
    }

    if (tabId === undefined) throw new Error(`tabId is required for action "${action}"`);
    this.knownTabIds.add(tabId);

    if (action === "snapshot") {
      return this.leases.runExclusive(tabId, async () => {
        const result = (await evaluate(this.bridge, tabId, snapshotScript)) as Record<string, unknown>;
        return { ...result, snapshotId: snapshotId(tabId, this.leases.getGeneration(tabId)) };
      });
    }

    if (action === "click") {
      // Detail lookup, the consequential-action policy decision, the human
      // approval wait, and the actual click all happen inside one held tab
      // lease: nothing else on this tab can run in between, so a navigation
      // or another click cannot slip in while a human is deciding, and a
      // stale/rejected click can never leave the lease stuck for others.
      return this.leases.runExclusive(tabId, async () => {
        this.assertGenerationCurrent(tabId, message.snapshotId);
        const ref = message.ref ?? "";
        const details = (await evaluate(this.bridge, tabId, clickDetailsScript(ref))) as {
          text?: string;
          type?: string;
          href?: string;
          formAction?: string;
        };
        const actionSummary = [message.description, details.text, details.type, details.href, details.formAction]
          .filter(Boolean)
          .join(" | ");
        if (isPotentiallyConsequential(actionSummary)) {
          await this.approve(clientId, `Allow click: ${actionSummary}`);
        }
        return evaluate(this.bridge, tabId, clickScript(ref));
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
      // Same atomicity guarantee as click: the approval wait for Enter/
      // NumpadEnter and the actual key dispatch happen under one held lease.
      return this.leases.runExclusive(tabId, async () => {
        const key = message.key ?? "";
        if (/^(enter|numpadenter)$/i.test(key)) {
          await this.approve(clientId, `Allow ${key}? It may submit the current form.`);
        }
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
