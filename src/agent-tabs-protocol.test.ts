import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { AnnotationStore } from "./annotations.js";
import { runMcpServer } from "./mcp.js";
import type { DaemonClient, DaemonRequest } from "./daemon-client.js";
import { createChromeMock } from "./test-support/chrome-mock.js";

// Real bridge, daemon, MCP and extension protocol handlers. Only the socket
// and chrome.* boundaries are in memory, so these run without local listeners.
class Peer extends EventEmitter {
  readyState = 1;
  destroyed = false;
  messages: any[] = [];
  send(raw: string) { this.messages.push(JSON.parse(raw)); }
  write(raw: string) { this.send(raw); }
  close() { this.destroy(); }
  destroy() { this.destroyed = true; this.emit("close"); }
}
class WorkerSocket {
  static OPEN = 1;
  static instance: WorkerSocket;
  readyState = 1;
  peer = new Peer();
  listeners = new Map<string, (event?: any) => void>();
  constructor(_url: string) {
    WorkerSocket.instance = this;
    this.peer.send = (raw) => this.listeners.get("message")?.({ data: raw });
    (bridge as any).attachExtension(this.peer);
    setTimeout(() => this.listeners.get("open")?.(), 0);
  }
  addEventListener(type: string, listener: (event?: any) => void) { this.listeners.set(type, listener); }
  send(raw: string) { this.peer.emit("message", raw); }
  close() { this.readyState = 3; this.peer.destroy(); }
}
let directory: string;
let bridge: BrowserBridge;
let daemon: DaemonServer;
let mock: ReturnType<typeof createChromeMock>;
const peers: Peer[] = [];
const mcpClients: Client[] = [];
async function settle() { await vi.advanceTimersByTimeAsync(600); }
function control(label?: string) {
  const peer = new Peer();
  peers.push(peer);
  (daemon as any).handleConnection(peer);
  peer.emit("data", Buffer.from(JSON.stringify({ type: "hello", token: "test-token", clientId: randomUUID(), label, version: 1 }) + "\n"));
  return peer;
}
async function request(peer: Peer, body: Record<string, unknown>) {
  const id = randomUUID();
  peer.emit("data", Buffer.from(JSON.stringify({ type: "request", ...body, id }) + "\n"));
  await settle();
  const response = peer.messages.find((message) => message.id === id);
  expect(response).toBeDefined();
  return response;
}
async function create(peer: Peer, url = "https://example.com/") {
  const response = await request(peer, { action: "createTab", url });
  expect(response.error).toBeUndefined();
  return response.result;
}
async function mcp(peer: Peer) {
  const adapter = {
    async request(body: DaemonRequest) {
      const response = await request(peer, body);
      if (response.error) throw new Error(response.error);
      return response.result;
    },
    async status() { return this.request({ action: "status" }); }
  } as DaemonClient;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runMcpServer(adapter, serverTransport);
  const client = new Client({ name: "agent-tab-test", version: "0.0.1" });
  await client.connect(clientTransport);
  mcpClients.push(client);
  return client;
}
function data(result: any) { return JSON.parse(result.content.find((part: any) => part.type === "text").text); }

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  directory = await mkdtemp(join(tmpdir(), "ubb-agent-tabs-"));
  bridge = new BrowserBridge("test-token");
  daemon = new DaemonServer(bridge, "test-token", join(directory, "daemon.sock"), new AnnotationStore(join(directory, "annotations")));
  mock = createChromeMock();
  vi.stubGlobal("chrome", mock.chrome);
  vi.stubGlobal("WebSocket", WorkerSocket);
  const win = await mock.chrome.windows.create({ url: "about:blank", focused: false });
  await mock.chrome.storage.session.set({ agentWindowId: win.id });
  await mock.chrome.storage.local.set({ token: "test-token" });
  vi.spyOn(mock.chrome.debugger, "sendCommand").mockImplementation(async (_target?: unknown, method?: string, params?: any) => {
    if (method === "Runtime.evaluate") return { result: { value: params.expression.includes("document.title")
      ? { title: "Example", url: "https://example.com/", nodes: [] } : { text: "Submit order" } } };
    if (method === "Page.captureScreenshot") return { data: "cG5n" };
    return {};
  });
  // @ts-expect-error Plain extension script, imported for its side effects.
  await import("../extension/background.js");
  await settle();
});
afterEach(async () => {
  for (const client of mcpClients.splice(0)) await client.close();
  for (const peer of peers.splice(0)) peer.destroy();
  WorkerSocket.instance.close();
  await daemon.stop();
  await bridge.stop();
  await rm(directory, { recursive: true, force: true });
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("keeps tabs accessible to later clients with the same label and hides them from other labels", async () => {
  const owner = control("Hephaestus");
  const tab = await create(owner);
  owner.destroy();
  const later = control("Hephaestus");
  const other = control("Hermes");
  expect((await request(later, { action: "status" })).result.tabs).toEqual([expect.objectContaining({ id: tab.id, ownerLabel: "Hephaestus" })]);
  expect((await request(other, { action: "status" })).result.tabs).toEqual([]);
  expect((await request(later, { action: "listAgentTabs" })).result).toEqual([
    { tabId: tab.id, url: "https://example.com/", title: "New Tab", groupId: tab.groupId }
  ]);
  expect((await request(other, { action: "snapshot", tabId: tab.id })).error).toMatch(/owned.*Hephaestus/i);
  expect((await request(later, { action: "snapshot", tabId: tab.id })).result.snapshotId).toBe(`${tab.id}:0`);
  expect((await request(later, { action: "closeTab", tabId: tab.id })).result).toEqual({ closed: tab.id });
});

it("advertises owned-tab tools over MCP and accepts owned IDs in every browser tool", async () => {
  const owner = await mcp(control("Hephaestus"));
  const other = await mcp(control("Hermes"));
  expect((await owner.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["browser_list_agent_tabs", "browser_close_tab"]));
  const tab = data(await owner.callTool({ name: "browser_new_tab", arguments: { url: "https://example.com/" } }));
  expect(data(await owner.callTool({ name: "browser_list_agent_tabs", arguments: {} }))).toEqual([
    { tabId: tab.id, url: "https://example.com/", title: "New Tab", groupId: tab.groupId }
  ]);
  const snapshot = data(await owner.callTool({ name: "browser_snapshot", arguments: { tabId: tab.id } }));
  const click = vi.spyOn(mock.chrome.debugger, "sendCommand").mockResolvedValue({ result: { value: { text: "Open details" } } });
  for (const [name, args] of [
    ["browser_click", { ref: "ubb-0", snapshotId: snapshot.snapshotId, description: "Open details" }],
    ["browser_type", { ref: "ubb-0", snapshotId: snapshot.snapshotId, text: "hello" }],
    ["browser_press", { key: "ArrowDown" }],
    ["browser_scroll", { deltaY: 50 }],
    ["browser_navigate", { url: "https://example.com/next" }]
  ] as const) {
    const denied = await other.callTool({ name, arguments: { ...args, tabId: tab.id } });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual([expect.objectContaining({ text: expect.stringMatching(/owned.*Hephaestus/i) })]);
    expect((await owner.callTool({ name, arguments: { ...args, tabId: tab.id } })).isError).toBeFalsy();
  }
  click.mockResolvedValue({ data: "cG5n" });
  expect((await owner.callTool({ name: "browser_screenshot", arguments: { tabId: tab.id } })).content).toEqual([
    { type: "image", data: "cG5n", mimeType: "image/png" }
  ]);
  expect((await other.callTool({ name: "browser_close_tab", arguments: { tabId: tab.id } })).isError).toBe(true);
  expect(data(await owner.callTool({ name: "browser_close_tab", arguments: { tabId: tab.id } }))).toEqual({ closed: tab.id });
});

it.each(["https://netbanking.hdfcbank.com/", "https://checkout.stripe.com/session", "https://example.com/checkout",
  "https://vault.bitwarden.com/", "https://passwords.google.com/", "https://proton.me/pass", "https://americanexpress.com/"])(
  "keeps an initial sensitive URL read-only even with owned-tab trust on: %s", async (url) => {
    const owner = control("Hephaestus");
    const tab = await create(owner, url);
    const snapshot = (await request(owner, { action: "snapshot", tabId: tab.id })).result;
    expect(snapshot.snapshotId).toBe(`${tab.id}:0`);
    expect((await request(owner, { action: "screenshot", tabId: tab.id })).result).toEqual({ data: "cG5n" });
    const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
    commands.mockClear();
    commands.mockResolvedValue({ result: { value: { text: "Open details" } } });
    const windows = vi.spyOn(mock.chrome.windows, "create");
    for (const args of [
      { action: "click", ref: "ubb-0", description: "Open details", snapshotId: snapshot.snapshotId },
      { action: "type", ref: "ubb-0", text: "hello", snapshotId: snapshot.snapshotId },
      { action: "press", key: "Enter" },
      { action: "press", key: "ArrowDown" },
      { action: "navigate", url: "https://example.com/" }
    ]) {
      expect((await request(owner, { ...args, tabId: tab.id })).error).toMatch(/read.only/i);
    }
    expect(commands).not.toHaveBeenCalled();
    expect(windows).not.toHaveBeenCalled();
  }
);

it.each([
  { action: "click", setting: undefined }, { action: "press", setting: undefined },
  { action: "click", setting: true }, { action: "press", setting: true }
])("trusts an owned-tab $action without opening an approval popup (setting=$setting)", async ({ action, setting }) => {
  if (setting !== undefined) await mock.chrome.storage.local.set({ trustAgentOwnedTabs: setting });
  const owner = control("Hephaestus");
  const tab = await create(owner);
  const snapshot = (await request(owner, { action: "snapshot", tabId: tab.id })).result;
  const windows = vi.spyOn(mock.chrome.windows, "create");
  const response = await request(owner, { action, tabId: tab.id, snapshotId: snapshot.snapshotId,
    ref: "ubb-0", description: "Submit order", key: "Enter", trustAgentOwnedTabs: false });
  expect(response.error).toBeUndefined();
  expect(windows).not.toHaveBeenCalled();
});

it.each([
  { action: "click", approved: false }, { action: "click", approved: true },
  { action: "press", approved: false }, { action: "press", approved: true }
])("requires Chrome approval with owned-tab trust off for $action (approved=$approved)", async ({ action, approved }) => {
  await mock.chrome.storage.local.set({ trustAgentOwnedTabs: false });
  const owner = control("Hephaestus");
  const tab = await create(owner);
  const snapshot = (await request(owner, { action: "snapshot", tabId: tab.id })).result;
  const windows = vi.spyOn(mock.chrome.windows, "create");
  const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
  commands.mockClear();
  const id = randomUUID();
  owner.emit("data", Buffer.from(JSON.stringify({ type: "request", id, action, tabId: tab.id,
    snapshotId: snapshot.snapshotId, ref: "ubb-0", description: "Open details", key: "Enter", trustAgentOwnedTabs: true }) + "\n"));
  await settle();
  const mutations = () => commands.mock.calls.filter(([, method, params]) => method === "Input.dispatchKeyEvent" || String(params.expression).includes("el.click()"));
  expect(mutations()).toEqual([]);
  expect(owner.messages.some((message) => message.id === id)).toBe(false);
  const popup = windows.mock.calls.find(([options]) => options.url.includes("approval.html"))![0];
  const approvalId = new URL(popup.url).searchParams.get("id")!;
  expect((await mock.chrome.storage.session.get(`approval_${approvalId}`))[`approval_${approvalId}`]).toMatchObject({ description: expect.stringContaining("Hephaestus") });
  for (const listener of mock.runtimeOnMessage) listener({ type: "approvalDecision", id: approvalId, approved }, {}, () => {});
  await settle();
  const response = owner.messages.find((message) => message.id === id);
  expect(response).toBeDefined();
  if (approved) {
    expect(response.error).toBeUndefined();
    expect(mutations()).toHaveLength(action === "press" ? 2 : 1);
  } else {
    expect(response.error).toMatch(/denied/i);
    expect(mutations()).toEqual([]);
  }
});

it.each(["bank-redirect", "ungroup", "blocklist-change", "blocked-redirect"])("rechecks safety after approval when the user causes a %s", async (change) => {
  await mock.chrome.storage.local.set({ trustAgentOwnedTabs: false });
  const owner = control("Hephaestus");
  const tab = await create(owner);
  const windows = vi.spyOn(mock.chrome.windows, "create");
  const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
  commands.mockClear();
  const id = randomUUID();
  owner.emit("data", Buffer.from(JSON.stringify({ type: "request", id, action: "press", tabId: tab.id, key: "Enter" }) + "\n"));
  await settle();
  const popup = windows.mock.calls.find(([options]) => options.url.includes("approval.html"))![0];
  const approvalId = new URL(popup.url).searchParams.get("id")!;
  if (change === "bank-redirect") mock.tabsById.get(tab.id)!.url = "https://netbanking.hdfcbank.com/";
  if (change === "ungroup") await mock.chrome.tabs.ungroup(tab.id);
  if (change === "blocklist-change") await mock.chrome.storage.local.set({ blockedDomains: ["example.com"] });
  if (change === "blocked-redirect") {
    await mock.chrome.storage.local.set({ blockedDomains: ["example.org"] });
    mock.tabsById.get(tab.id)!.pendingUrl = "https://private.example.org/";
  }
  for (const listener of mock.runtimeOnMessage) listener({ type: "approvalDecision", id: approvalId, approved: true }, {}, () => {});
  await settle();
  expect(owner.messages.find((message) => message.id === id)?.error).toMatch(change === "bank-redirect" ? /read.only/i
    : change === "ungroup" ? /no.*shared/i : /blocked by your blocklist/);
  expect(commands.mock.calls.filter(([, method]) => method === "Input.dispatchKeyEvent")).toEqual([]);
});

it.each(["hand-shared", "unlabelled-created"])("still prompts for Enter in a %s tab when owned-tab trust is on", async (kind) => {
  const owner = control("Hephaestus");
  let tab;
  if (kind === "hand-shared") {
    tab = (await mock.chrome.windows.create({ url: "https://example.com/", focused: true })).tabs[0]!;
    const sharing = mock.actionOnClicked[0]!(tab);
    await settle(); await sharing;
  } else tab = await create(control());
  const windows = vi.spyOn(mock.chrome.windows, "create");
  const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
  commands.mockClear();
  const id = randomUUID();
  owner.emit("data", Buffer.from(JSON.stringify({ type: "request", id, action: "press", tabId: tab.id, key: "Enter", trustAgentOwnedTabs: true }) + "\n"));
  await settle();
  expect(owner.messages.some((message) => message.id === id)).toBe(false);
  expect(commands).not.toHaveBeenCalled();
  const popup = windows.mock.calls.find(([options]) => options.url.includes("approval.html"))![0];
  const approvalId = new URL(popup.url).searchParams.get("id")!;
  for (const listener of mock.runtimeOnMessage) listener({ type: "approvalDecision", id: approvalId, approved: true }, {}, () => {});
  await settle();
  expect(owner.messages.find((message) => message.id === id)?.result).toEqual({ pressed: "Enter" });
});

it.each(["owned", "hand-shared"])("refuses every page action in a blocked %s tab with trust on", async (kind) => {
  const owner = control("Hephaestus");
  let tab;
  if (kind === "owned") tab = await create(owner);
  else {
    tab = (await mock.chrome.windows.create({ url: "https://example.com/", focused: true })).tabs[0]!;
    const sharing = mock.actionOnClicked[0]!(tab);
    await settle(); await sharing;
  }
  await mock.chrome.storage.local.set({ blockedDomains: ["example.com"], trustAgentOwnedTabs: true });
  await settle();
  const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
  commands.mockClear();
  for (const action of ["snapshot", "screenshot", "scroll", "click", "type", "press", "navigate"]) {
    expect((await request(owner, { action, tabId: tab.id, snapshotId: `${tab.id}:0`, ref: "ubb-0", key: "Enter", text: "hello", url: "https://example.org/" })).error)
      .toContain("blocked by your blocklist");
  }
  expect(commands).not.toHaveBeenCalled();
  expect((await request(owner, { action: "createTab", url: "https://sub.example.com/" })).error).toContain("blocked by your blocklist");
});

it("keeps label ownership through extension reconnects and daemon restarts", async () => {
  const owner = control("Hephaestus");
  const tab = await create(owner);
  WorkerSocket.instance.close();
  vi.clearAllTimers(); mock.resetWorkerListeners(); vi.resetModules();
  // @ts-expect-error Plain extension script, imported for its side effects.
  await import("../extension/background.js");
  await settle();
  expect((await request(owner, { action: "listAgentTabs" })).result).toEqual([expect.objectContaining({ tabId: tab.id })]);
  for (const peer of peers.splice(0)) peer.destroy();
  await daemon.stop();
  daemon = new DaemonServer(bridge, "test-token", join(directory, "daemon.sock"), new AnnotationStore(join(directory, "annotations")));
  expect((await request(control("Hermes"), { action: "closeTab", tabId: tab.id, label: "Hephaestus" })).error).toMatch(/owned.*Hephaestus/i);
  expect((await request(control("Hephaestus"), { action: "closeTab", tabId: tab.id })).result).toEqual({ closed: tab.id });
});

it("rejects invalid/private initial URLs at the control protocol boundary", async () => {
  vi.stubEnv("UBB_ALLOW_PRIVATE_NETWORKS", "");
  const owner = control("Hephaestus");
  for (const url of ["file:///etc/passwd", "http://127.0.0.1/", "not a URL"]) {
    expect((await request(owner, { action: "createTab", url })).error).toMatch(/allowed.*http/i);
  }
  expect((await request(owner, { action: "listAgentTabs" })).result).toEqual([]);
  vi.unstubAllEnvs();
});

it("rejects a payment redirect that happens while a mutating command is in flight to Chrome", async () => {
  const owner = control("Hephaestus");
  const tab = await create(owner);
  const peer = WorkerSocket.instance.peer;
  const deliver = peer.send.bind(peer);
  peer.send = (raw) => {
    const message = JSON.parse(raw);
    if (message.type === "command" && message.action === "cdp" && message.method === "Input.dispatchKeyEvent") {
      mock.tabsById.get(tab.id)!.url = "https://checkout.stripe.com/session";
    }
    deliver(raw);
  };
  const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
  commands.mockClear();
  expect((await request(owner, { action: "press", tabId: tab.id, key: "ArrowDown" })).error).toMatch(/read.only/i);
  expect(commands).not.toHaveBeenCalled();
});
