import { unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { BrowserBridge } from "./bridge.js";
import { tokensMatch } from "./auth.js";
import { AnnotationStore } from "./annotations.js";
import { AnnotationWebhook } from "./annotation-webhook.js";
import { isPotentiallyConsequential } from "./policy.js";
import { PROTOCOL_VERSION, type AnnotationExtensionRequest, type ControlClientMessage, type ControlServerMessage, type SharedTab } from "./protocol.js";
import { clickDetailsScript, clickTargetScript, clickScript, describeKey, scrollScript, snapshotScript, typeScript, uploadFileScript } from "./dom-actions.js";
import { TabLeaseManager } from "./tab-lease.js";
import { assertBrowserUrlAllowed, isReadOnlyBrowserUrl, assertTabNotBlocked, isBlockedBrowserUrl } from "./url-policy.js";
import { validateUploadFiles } from "./upload-policy.js";

type ControlRequest = Extract<ControlClientMessage, { type: "request" }>;

type ClientInfo = { socket: Socket; label?: string; connected: boolean };
type ClickTarget = { x: number; y: number; hasSize: boolean; visible: boolean; hitTarget: boolean };

// Sentinel lease key: serializes createTab calls (which have no tabId yet)
// so adapters cannot race the agent-window creation/optional approval flow.
// Abandoned requests are dropped or cleaned up before the next job runs.
const CREATE_TAB_LOCK = -1;

async function getUnblockedTab(bridge: BrowserBridge, tabId: number, label: string | undefined): Promise<{ url: string; pendingUrl?: string }> {
  const cached = bridge.status().tabs.find((tab) => tab.id === tabId);
  if (cached) assertTabNotBlocked(cached, bridge.blockedDomains);
  const tab = await bridge.command({ action: "getTab", tabId, label }) as { url: string; pendingUrl?: string };
  // Policy may change while the live lookup is in flight.
  assertTabNotBlocked(tab, bridge.blockedDomains);
  return tab;
}

async function cdp(bridge: BrowserBridge, tabId: number, label: string | undefined, method: string, params: Record<string, unknown> = {}, requiresWritable = false): Promise<any> {
  if (method === "Page.navigate") assertTabNotBlocked({ url: params.url as string }, bridge.blockedDomains);
  const tab = await getUnblockedTab(bridge, tabId, label);
  if (requiresWritable) assertTabWritable(tab);
  return bridge.command({ action: "cdp", tabId, label, method, params, requiresWritable });
}

function assertTabWritable(tab: { url: string; pendingUrl?: string }): void {
  if (isReadOnlyBrowserUrl(tab.url) || (tab.pendingUrl && isReadOnlyBrowserUrl(tab.pendingUrl))) {
    throw new Error("Bank, card, payment and password-manager pages are read-only; clicking, typing, key presses and navigation are disabled");
  }
}

// Runtime.evaluate reports page-script throws via exceptionDetails instead of
// failing the CDP call outright, so surface those as real errors.
async function evaluate(bridge: BrowserBridge, tabId: number, label: string | undefined, expression: string, options: { requiresWritable?: boolean; userGesture?: boolean } = {}): Promise<unknown> {
  const result = await cdp(bridge, tabId, label, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise: true, userGesture: options.userGesture
  }, options.requiresWritable);
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
    private readonly socketPath: string,
    private readonly annotations = new AnnotationStore(),
    private readonly webhook: Pick<AnnotationWebhook, "created" | "status" | "test"> = new AnnotationWebhook({ dataRoot: dirname(annotations.directory) })
  ) {
    // Reconcile ownership/lease state for tabs that vanish out-of-band (the
    // user closes them directly in Chrome, or the extension disconnects).
    this.bridge.on("tabs", (tabs: SharedTab[]) => this.reconcileTabs(tabs));
    this.bridge.on("annotations", this.handleAnnotations);
  }

  async start(): Promise<void> {
    await this.reclaimStaleSocket();
    const server = createServer((socket) => this.handleConnection(socket));
    await this.listenWithOwnerOnlyPermissions(server);
    this.server = server;
  }

  async stop(): Promise<void> {
    this.bridge.off("annotations", this.handleAnnotations);
    for (const client of this.clients.values()) client.socket.destroy();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    if (process.platform !== "win32") await unlink(this.socketPath).catch(() => {});
  }

  private handleAnnotations = async (message: AnnotationExtensionRequest): Promise<void> => {
    try {
      const tab = this.bridge.status().tabs.find((tab) => tab.id === message.tabId);
      const url = message.type === "annotationsSave" ? message.annotation?.url : message.url;
      if (!tab || tab.url !== url) throw new Error("Annotations require a currently shared tab at the same URL");
      const result = message.type === "annotationsSave"
        ? await this.annotations.create(message.annotation, message.screenshot)
        : await this.annotations.list({ url });
      this.bridge.sendAnnotations({ type: "annotationsResponse", id: message.id, result });
      if (message.type === "annotationsSave") {
        const annotation = result as Awaited<ReturnType<AnnotationStore["create"]>>;
        this.bridge.sendAnnotations({ type: "annotationUpdated", annotation });
        // Detach delivery (including synchronous throws) from the committed save.
        void Promise.resolve().then(() => this.webhook.created(annotation)).catch(() => {
          process.stderr.write("Annotation webhook: delivery error\n");
        });
      }
    } catch (error) {
      this.bridge.sendAnnotations({ type: "annotationsResponse", id: message.id, error: (error as Error).message });
    }
  };

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
    let client: ClientInfo | undefined;
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
          if (message.type !== "hello" || typeof message.token !== "string" || !tokensMatch(message.token, this.token)) {
            socket.destroy();
            return;
          }
          authenticated = true;
          clearTimeout(authTimer);
          clientId = message.clientId;
          client = { socket, label: message.label, connected: true };
          this.clients.set(clientId, client);
          send({ type: "ready", version: PROTOCOL_VERSION });
          continue;
        }

        if (message.type === "request") void this.handleRequest(message, clientId, send);
      }
    });

    socket.on("close", () => {
      clearTimeout(authTimer);
      if (client) client.connected = false;
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

  private async assertWritableTab(tabId: number, label: string | undefined): Promise<void> {
    // Read live Chrome state under the tab lease, including after an approval
    // wait. Cached broadcasts can lag redirects or a user's navigation.
    assertTabWritable(await getUnblockedTab(this.bridge, tabId, label));
  }

  // Requests human approval, labelled with the requesting adapter's
  // identity. Only called from inside a held tab lease (or the createTab
  // lock), so it is never something an adapter can trigger unilaterally or
  // race against other operations on the same tab.
  private async approve(clientId: string, tabId: number, description: string): Promise<void> {
    const labelled = `[${this.requesterLabel(clientId)}] ${description}`;
    const label = this.clients.get(clientId)?.label;
    const result = (await this.bridge.command({ action: "requestApproval", tabId, label, description: labelled })) as { approved?: boolean };
    if (!result?.approved) throw new Error(`User denied browser action: ${description}`);
  }

  private async approveClickIfNeeded(clientId: string, tabId: number, message: ControlRequest): Promise<void> {
    const label = this.clients.get(clientId)?.label;
    const details = (await evaluate(this.bridge, tabId, label, clickDetailsScript(message.ref ?? ""))) as {
      text?: string; type?: string; href?: string; formAction?: string;
    };
    const actionSummary = [message.description, details.text, details.type, details.href, details.formAction]
      .filter(Boolean).join(" | ");
    if (isPotentiallyConsequential(actionSummary)) {
      await this.approve(clientId, tabId, `Allow click: ${actionSummary}`);
      await this.assertWritableTab(tabId, label);
    }
  }

  private async dispatch(message: ControlRequest, clientId: string): Promise<unknown> {
    const { action, tabId } = message;
    const client = this.clients.get(clientId);
    const label = client?.label;
    const unblocked = (tab: { url: string; pendingUrl?: string }) =>
      !isBlockedBrowserUrl(tab.url, this.bridge.blockedDomains) && !isBlockedBrowserUrl(tab.pendingUrl, this.bridge.blockedDomains);

    if (action === "status") {
      const status = this.bridge.status();
      return { ...status, tabs: status.tabs.filter((tab) => (!tab.ownerLabel || tab.ownerLabel === label) && unblocked(tab)) };
    }
    if (action === "listTabs" || action === "listAgentTabs") {
      const tabs = await this.bridge.command({ action, label }) as Array<{ url: string; pendingUrl?: string }>;
      return tabs.filter(unblocked);
    }
    if (action === "annotationsList") return this.annotations.list({ url: message.url, status: message.status });
    if (action === "annotationsWebhookStatus") return this.webhook.status();
    if (action === "annotationsWebhookTest") return this.webhook.test();
    if (action === "annotationsGet") {
      if (message.annotationId && message.url !== undefined) throw new Error("Specify an annotation ID or URL, not both");
      if (message.annotationId) return this.annotations.get(message.annotationId);
      if (message.url !== undefined) return this.annotations.list({ url: message.url });
      throw new Error("annotationId or url is required");
    }
    if (action === "annotationsResolve") {
      if (!message.annotationId) throw new Error("annotationId is required");
      const annotation = await this.annotations.resolve(message.annotationId, message.note);
      this.bridge.sendAnnotations({ type: "annotationUpdated", annotation });
      return annotation;
    }
    if (action === "annotationsReply") {
      if (!message.annotationId) throw new Error("annotationId is required");
      const annotation = await this.annotations.reply(message.annotationId, { text: message.text!, author: message.author });
      this.bridge.sendAnnotations({ type: "annotationUpdated", annotation });
      return annotation;
    }

    if (action === "createTab") {
      return this.leases.runExclusive(CREATE_TAB_LOCK, async () => {
        if (!client?.connected) throw new Error("createTab abandoned: client disconnected");
        if (!message.url || !assertBrowserUrlAllowed(message.url)) throw new Error("Only allowed public http(s) URLs can be opened");
        assertTabNotBlocked({ url: message.url }, this.bridge.blockedDomains);
        const tab = (await this.bridge.command({ action: "createTab", url: message.url, label })) as { id: number };
        if (!client.connected) {
          await this.bridge.command({ action: "closeTab", tabId: tab.id, label }).catch(() => {});
          throw new Error("createTab abandoned: client disconnected");
        }
        if (!label) this.tabOwners.set(tab.id, clientId);
        this.knownTabIds.add(tab.id);
        return tab;
      });
    }

    if (action === "closeTab") {
      if (tabId === undefined) throw new Error("tabId is required");
      return this.leases.runExclusive(tabId, async () => {
        const owner = this.tabOwners.get(tabId);
        if (owner && owner !== clientId) {
          throw new Error(`Tab ${tabId} was created by another client (${this.requesterLabel(owner)}); only the owning client may close it.`);
        }
        const result = await this.bridge.command({ action: "closeTab", tabId, label });
        this.tabOwners.delete(tabId);
        this.knownTabIds.delete(tabId);
        this.leases.forgetTab(tabId);
        return result;
      });
    }

    if (tabId === undefined) throw new Error(`tabId is required for action "${action}"`);
    this.knownTabIds.add(tabId);

    if (action === "snapshot") {
      return this.leases.runExclusive(tabId, async () => {
        const result = (await evaluate(this.bridge, tabId, label, snapshotScript)) as Record<string, unknown>;
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
        await this.assertWritableTab(tabId, label);
        this.assertGenerationCurrent(tabId, message.snapshotId);
        const ref = message.ref ?? "";
        await this.approveClickIfNeeded(clientId, tabId, message);
        const target = (await evaluate(this.bridge, tabId, label, clickTargetScript(ref), { requiresWritable: true })) as ClickTarget;
        if (target.hasSize && target.visible && target.hitTarget) {
          const { x, y } = target;
          await cdp(this.bridge, tabId, label, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, true);
          await cdp(this.bridge, tabId, label, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, true);
          await cdp(this.bridge, tabId, label, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, true);
          return { clicked: true, method: "mouse" };
        }
        await evaluate(this.bridge, tabId, label, clickScript(ref), { requiresWritable: true, userGesture: true });
        return { clicked: true, method: "script" };
      });
    }

    if (action === "type") {
      return this.leases.runExclusive(tabId, async () => {
        await this.assertWritableTab(tabId, label);
        this.assertGenerationCurrent(tabId, message.snapshotId);
        return evaluate(this.bridge, tabId, label, typeScript(message.ref ?? "", message.text ?? ""), { requiresWritable: true, userGesture: true });
      });
    }

    if (action === "uploadFile") {
      return this.leases.runExclusive(tabId, async () => {
        const mode = message.mode ?? "auto";
        if (!["auto", "input", "chooser"].includes(mode)) throw new Error("Upload mode must be auto, input or chooser");
        if (typeof label !== "string" || !label.trim()) throw new Error("An agent label is required for file uploads");
        const ownedTabs = await this.bridge.command({ action: "listAgentTabs", label });
        if (!Array.isArray(ownedTabs) || !ownedTabs.some((tab) => tab.tabId === tabId)) {
          throw new Error("File uploads require a tab owned by your agent label; hand-shared and other-label tabs cannot upload files");
        }
        await this.assertWritableTab(tabId, label);
        this.assertGenerationCurrent(tabId, message.snapshotId);
        const realPaths = await validateUploadFiles(message.files, this.bridge.uploadFolders);
        if (mode !== "chooser") {
          const target = await cdp(this.bridge, tabId, label, "Runtime.evaluate", {
            expression: uploadFileScript(message.ref ?? "", realPaths.length, mode === "auto"), returnByValue: false
          }, true);
          if (target?.exceptionDetails) {
            throw new Error(target.exceptionDetails.exception?.description ?? target.exceptionDetails.text ?? "Page script failed");
          }
          if (target?.result?.subtype !== "null") {
            const objectId = target?.result?.objectId;
            if (typeof objectId !== "string" || !objectId) throw new Error("Chrome did not return a file input objectId");
            try {
              await cdp(this.bridge, tabId, label, "DOM.setFileInputFiles", { files: realPaths, objectId }, true);
            } catch (error) {
              if (/not allowed/i.test((error as Error).message)) {
                throw new Error(`${(error as Error).message}. Enable "Allow access to file URLs" for Universal Browser Bridge in chrome://extensions`);
              }
              throw error;
            }
            return { uploaded: realPaths.length, files: realPaths, method: "input", picker: "input" };
          }
        }
        await this.approveClickIfNeeded(clientId, tabId, message);
        const target = (await evaluate(this.bridge, tabId, label, clickTargetScript(message.ref ?? ""), { requiresWritable: true })) as ClickTarget;
        await this.assertWritableTab(tabId, label);
        this.assertGenerationCurrent(tabId, message.snapshotId);
        return this.bridge.command({ action: "uploadViaFileChooser", tabId, label, files: realPaths, timeoutMs: 5000,
          ...(target.hasSize && target.visible && target.hitTarget ? { x: target.x, y: target.y } : { ref: message.ref }) });
      });
    }

    if (action === "navigate") {
      return this.leases.runExclusive(tabId, async () => {
        if (!message.url || !assertBrowserUrlAllowed(message.url)) throw new Error("Only allowed public http(s) URLs can be opened");
        assertTabNotBlocked({ url: message.url }, this.bridge.blockedDomains);
        await this.assertWritableTab(tabId, label);
        const result = await cdp(this.bridge, tabId, label, "Page.navigate", { url: message.url }, true);
        this.leases.bumpGeneration(tabId);
        return result;
      });
    }

    if (action === "press") {
      // Same atomicity guarantee as click: the approval wait for Enter/
      // NumpadEnter and the actual key dispatch happen under one held lease.
      return this.leases.runExclusive(tabId, async () => {
        await this.assertWritableTab(tabId, label);
        const key = message.key ?? "";
        if (/^(enter|numpadenter)$/i.test(key)) {
          await this.approve(clientId, tabId, `Allow ${key}? It may submit the current form.`);
          await this.assertWritableTab(tabId, label);
        }
        const descriptor = describeKey(key);
        const params = { key, ...descriptor };
        await cdp(this.bridge, tabId, label, "Input.dispatchKeyEvent", { type: params.text ? "keyDown" : "rawKeyDown", ...params }, true);
        await cdp(this.bridge, tabId, label, "Input.dispatchKeyEvent", { type: "keyUp", ...params }, true);
        return { pressed: key };
      });
    }

    if (action === "scroll") {
      return this.leases.runExclusive(tabId, () => evaluate(this.bridge, tabId, label, scrollScript(message.deltaY ?? 0)));
    }

    if (action === "screenshot") {
      return this.leases.runExclusive(tabId, async () => {
        const result = await cdp(this.bridge, tabId, label, "Page.captureScreenshot", { format: "png" });
        if (!result?.data) throw new Error("Chrome did not return screenshot data");
        return result;
      });
    }

    throw new Error(`Unknown control action "${action}"`);
  }
}
