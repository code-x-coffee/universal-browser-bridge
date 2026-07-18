import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { DaemonClient } from "./daemon-client.js";

const TOKEN = "daemon-test-token";

// A minimal fake Chrome extension: connects to the real BrowserBridge's
// WebSocket endpoint and answers commands the way background.js would.
class FakeExtension {
  ws!: WebSocket;
  nextTabId = 1;
  tabs: { id: number; title: string; url: string; active: boolean }[] = [];
  delayMs = 0;
  approvalDecision = true;
  approvalDelayMs = 0;
  maxConcurrentCreateTab = 0;
  private concurrentCreateTab = 0;
  onCdp?: (method: string, params: Record<string, unknown>) => void;

  async connect(port: number): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers: { origin: "chrome-extension://fake" } });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.send(JSON.stringify({ type: "hello", token: TOKEN, version: 1 }));
    this.ws.on("message", (raw) => void this.handle(JSON.parse(raw.toString())));
  }

  private send(message: unknown) {
    this.ws.send(JSON.stringify(message));
  }

  // Simulates the user closing a shared/agent tab directly in Chrome,
  // outside of any browser_close_tab call.
  removeTabOutOfBand(tabId: number): void {
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
    this.send({ type: "tabs", tabs: this.tabs });
  }

  private async handle(message: any): Promise<void> {
    if (message.type !== "command") return;
    const { id, action } = message;
    try {
      if (action === "createTab") {
        this.concurrentCreateTab++;
        this.maxConcurrentCreateTab = Math.max(this.maxConcurrentCreateTab, this.concurrentCreateTab);
        try {
          if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
          const tab = { id: this.nextTabId++, title: "New Tab", url: message.url, active: true };
          this.tabs.push(tab);
          this.send({ type: "tabs", tabs: this.tabs });
          this.send({ type: "response", id, result: tab });
        } finally {
          this.concurrentCreateTab--;
        }
        return;
      }

      if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

      if (action === "listTabs") return this.send({ type: "response", id, result: this.tabs });
      if (action === "closeTab") {
        this.tabs = this.tabs.filter((t) => t.id !== message.tabId);
        this.send({ type: "tabs", tabs: this.tabs });
        return this.send({ type: "response", id, result: { closed: message.tabId } });
      }
      if (action === "requestApproval") {
        if (this.approvalDelayMs) await new Promise((resolve) => setTimeout(resolve, this.approvalDelayMs));
        return this.send({ type: "response", id, result: { approved: this.approvalDecision } });
      }
      if (action === "cdp") {
        this.onCdp?.(message.method, message.params ?? {});
        return this.send({ type: "response", id, result: this.cdpResult(message.method, message.params) });
      }
      this.send({ type: "response", id, error: `Unknown action ${action}` });
    } catch (error) {
      this.send({ type: "response", id, error: (error as Error).message });
    }
  }

  private cdpResult(method: string, params: Record<string, unknown>): unknown {
    if (method === "Runtime.evaluate") {
      const expression = String(params.expression);
      if (expression.includes("document.title")) {
        return { result: { value: { title: "Example", url: "https://example.com", nodes: [{ ref: "ubb-0", tag: "a" }] } } };
      }
      if (expression.includes("el.click()")) return { result: { value: true } };
      if (expression.includes("el.dispatchEvent")) return { result: { value: true } };
      return { result: { value: { text: "Click me", type: null, href: "", formAction: "" } } };
    }
    if (method === "Page.navigate") return {};
    if (method === "Input.dispatchKeyEvent") return {};
    if (method === "Page.captureScreenshot") return { data: "ZmFrZS1wbmc=" };
    return {};
  }

  close(): void {
    this.ws.close();
  }
}

let tempDir: string;
let socketPath: string;
let bridge: BrowserBridge;
let daemon: DaemonServer;
let extension: FakeExtension;
const clients: DaemonClient[] = [];

function makeClient(label?: string): DaemonClient {
  const client = new DaemonClient({ socketPath, token: TOKEN, clientId: randomUUID(), label });
  clients.push(client);
  return client;
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ubb-daemon-test-"));
  socketPath = join(tempDir, "daemon.sock");
  bridge = new BrowserBridge(TOKEN, "127.0.0.1", 0);
  await bridge.start();
  daemon = new DaemonServer(bridge, TOKEN, socketPath);
  await daemon.start();
  extension = new FakeExtension();
  await extension.connect(bridge.port);
  // Let the extension's hello/ready handshake settle.
  await new Promise((resolve) => setTimeout(resolve, 50));
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  extension.close();
  await daemon.stop();
  await bridge.stop();
  await rm(tempDir, { recursive: true, force: true });
});

describe("DaemonServer + DaemonClient", () => {
  it("lets two MCP clients connect to one daemon simultaneously without EADDRINUSE", async () => {
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await expect(a.connect()).resolves.toBeUndefined();
    await expect(b.connect()).resolves.toBeUndefined();
  });

  it("shows both clients the same shared status, and one disconnecting does not break the other", async () => {
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();

    await a.request({ action: "createTab", url: "https://example.com" });
    const statusA = await a.status();
    const statusB = await b.status();
    expect(statusA.tabs).toHaveLength(1);
    expect(statusB.tabs).toHaveLength(1);

    await a.close();
    const statusBAfter = await b.status();
    expect(statusBAfter.connected).toBe(true);
  });

  it("rejects a control connection that never authenticates with the correct token", async () => {
    const client = new DaemonClient({ socketPath, token: "wrong-token", clientId: randomUUID() });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow();
  });

  it("gives a precise error when no daemon is listening", async () => {
    const missingSocket = join(tempDir, "nothing-here.sock");
    const client = new DaemonClient({ socketPath: missingSocket, token: TOKEN, clientId: randomUUID() });
    clients.push(client);
    await expect(client.connect()).rejects.toThrow(/serve/);
  });

  it("serializes operations on the same tab across clients", async () => {
    extension.delayMs = 40;
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };
    extension.delayMs = 0;

    const order: string[] = [];
    extension.delayMs = 60;
    const first = a.request({ action: "screenshot", tabId: created.id }).then(() => order.push("first"));
    const second = b.request({ action: "screenshot", tabId: created.id }).then(() => order.push("second"));
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  it("cleans up leases on disconnect so the next client is not blocked", async () => {
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };

    await a.request({ action: "screenshot", tabId: created.id });
    await a.close();

    const result = await Promise.race([
      b.request({ action: "screenshot", tabId: created.id }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 1000))
    ]);
    expect(result).toBeTruthy();
  });

  it("rejects stale snapshot generations after a navigation", async () => {
    const a = makeClient("client-a");
    await a.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };

    const snapshot = (await a.request({ action: "snapshot", tabId: created.id })) as { snapshotId: string };
    await a.request({ action: "navigate", tabId: created.id, url: "https://example.com/2" });

    await expect(
      a.request({ action: "click", tabId: created.id, ref: "ubb-0", snapshotId: snapshot.snapshotId })
    ).rejects.toThrow(/stale/i);
  });

  it("accepts click with the current snapshot generation", async () => {
    const a = makeClient("client-a");
    await a.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };
    const snapshot = (await a.request({ action: "snapshot", tabId: created.id })) as { snapshotId: string };
    await expect(
      a.request({ action: "click", tabId: created.id, ref: "ubb-0", snapshotId: snapshot.snapshotId })
    ).resolves.toBeTruthy();
  });

  it("only lets the owning client close a tab it created", async () => {
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };

    await expect(b.request({ action: "closeTab", tabId: created.id })).rejects.toThrow(/owning client|owner/i);
    await expect(a.request({ action: "closeTab", tabId: created.id })).resolves.toBeTruthy();
  });

  it("includes requester identity in approval descriptions relayed by a consequential click", async () => {
    const seen: string[] = [];
    const originalHandle = (extension as any).handle.bind(extension);
    (extension as any).handle = async (message: any) => {
      if (message.type === "command" && message.action === "requestApproval") seen.push(message.description);
      return originalHandle(message);
    };
    const a = makeClient("agent-x");
    await a.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };
    const snapshot = (await a.request({ action: "snapshot", tabId: created.id })) as { snapshotId: string };
    await a.request({
      action: "click",
      tabId: created.id,
      ref: "ubb-0",
      description: "submit the order",
      snapshotId: snapshot.snapshotId
    });
    expect(seen[0]).toContain("agent-x");
    expect(seen[0]).toContain("submit the order");
  });

  // --- Finding 1: concurrent createTab must be serialized centrally ---

  it("serializes concurrent createTab calls so two adapters cannot race the extension's agent-window approval", async () => {
    extension.delayMs = 60;
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();

    const [tabA, tabB] = (await Promise.all([
      a.request({ action: "createTab", url: "https://example.com/a" }),
      b.request({ action: "createTab", url: "https://example.com/b" })
    ])) as [{ id: number }, { id: number }];

    expect(extension.maxConcurrentCreateTab).toBe(1);
    expect(tabA.id).not.toBe(tabB.id);
  });

  // --- Finding 2: ownership release on disconnect + reconciliation of stale tab state ---

  it("releases tab ownership when the owning client disconnects, so a later client can close it", async () => {
    const a = makeClient("client-a");
    await a.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };

    await a.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    const c = makeClient("client-c");
    await c.connect();
    await expect(c.request({ action: "closeTab", tabId: created.id })).resolves.toBeTruthy();
  });

  it("still enforces owner isolation while the owning client stays connected", async () => {
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };

    await expect(b.request({ action: "closeTab", tabId: created.id })).rejects.toThrow(/owning client|owner/i);
    // a is still connected; ownership must not have been released.
    await expect(a.request({ action: "closeTab", tabId: created.id })).resolves.toBeTruthy();
  });

  it("reconciles ownership and generation state when a tab disappears out-of-band", async () => {
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };
    await a.request({ action: "navigate", tabId: created.id, url: "https://example.com/2" });

    extension.removeTabOutOfBand(created.id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Chrome can reuse the numeric tab id for an unrelated tab later.
    extension.nextTabId = created.id;
    const reused = (await b.request({ action: "createTab", url: "https://example.com/reused" })) as { id: number };
    expect(reused.id).toBe(created.id);

    const snapshot = (await b.request({ action: "snapshot", tabId: reused.id })) as { snapshotId: string };
    expect(snapshot.snapshotId).toBe(`${reused.id}:0`);

    await expect(a.request({ action: "closeTab", tabId: reused.id })).rejects.toThrow(/owning client|owner/i);
    await expect(b.request({ action: "closeTab", tabId: reused.id })).resolves.toBeTruthy();
  });

  // --- Finding 3: click/press detail lookup + approval + execution are one atomic transaction ---

  it("keeps click's detail lookup, approval wait, and execution atomic so no other tab operation can interleave", async () => {
    extension.approvalDelayMs = 80;
    const a = makeClient("client-a");
    const b = makeClient("client-b");
    await a.connect();
    await b.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };
    const snapshot = (await a.request({ action: "snapshot", tabId: created.id })) as { snapshotId: string };

    const order: string[] = [];
    const clickPromise = a
      .request({ action: "click", tabId: created.id, ref: "ubb-0", description: "submit the order", snapshotId: snapshot.snapshotId })
      .then(() => order.push("click"));
    // Let the click acquire the tab lease and reach the approval wait before firing the other request.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const otherPromise = b.request({ action: "scroll", tabId: created.id, deltaY: 10 }).then(() => order.push("scroll"));

    await Promise.all([clickPromise, otherPromise]);
    expect(order).toEqual(["click", "scroll"]);
  });

  it("denying approval blocks the click and still releases the lease for the next operation", async () => {
    extension.approvalDecision = false;
    const a = makeClient("client-a");
    await a.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };
    const snapshot = (await a.request({ action: "snapshot", tabId: created.id })) as { snapshotId: string };

    await expect(
      a.request({ action: "click", tabId: created.id, ref: "ubb-0", description: "submit the order", snapshotId: snapshot.snapshotId })
    ).rejects.toThrow(/denied/i);

    const result = await Promise.race([
      a.request({ action: "scroll", tabId: created.id, deltaY: 5 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 1000))
    ]);
    expect(result).toBeTruthy();
  });

  it("presses Enter only after human approval, and denial prevents the key dispatch entirely", async () => {
    extension.approvalDecision = false;
    const dispatched: string[] = [];
    extension.onCdp = (method) => {
      if (method === "Input.dispatchKeyEvent") dispatched.push(method);
    };
    const a = makeClient("client-a");
    await a.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };

    await expect(a.request({ action: "press", tabId: created.id, key: "Enter" })).rejects.toThrow(/denied/i);
    expect(dispatched).toHaveLength(0);
  });

  it("presses non-Enter keys without requiring approval", async () => {
    const a = makeClient("client-a");
    await a.connect();
    const created = (await a.request({ action: "createTab", url: "https://example.com" })) as { id: number };
    await expect(a.request({ action: "press", tabId: created.id, key: "ArrowDown" })).resolves.toEqual({ pressed: "ArrowDown" });
  });

  // --- Finding 4: control socket is owner-only from creation ---

  it("creates the control socket with owner-only permissions", async () => {
    if (process.platform === "win32") return;
    const stats = await stat(socketPath);
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
