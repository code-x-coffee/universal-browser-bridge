import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./test-support/chrome-mock.js";

class FakeSocket {
  static OPEN = 1;
  static instance: FakeSocket;
  static instances: FakeSocket[] = [];
  readyState = 1;
  messages: any[] = [];
  listeners = new Map<string, (event?: any) => void>();
  constructor(_url: string) { FakeSocket.instance = this; FakeSocket.instances.push(this); setTimeout(() => this.listeners.get("open")?.(), 0); }
  addEventListener(type: string, fn: (event?: any) => void) { this.listeners.set(type, fn); }
  deliver(message: unknown) { this.listeners.get("message")?.({ data: JSON.stringify(message) }); }
  send(raw: string) {
    const message = JSON.parse(raw); this.messages.push(message);
    if (message.type === "hello") setTimeout(() => this.deliver({ type: "ready" }), 0);
    if (message.type === "annotationsList") setTimeout(() => this.deliver({ type: "annotationsResponse", id: message.id, result: [] }), 0);
  }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.listeners.get("close")?.(); }
}
let mock: ReturnType<typeof createChromeMock>;
let windowId: number;
let sequence = 0;
async function settle(ms = 650) { await vi.advanceTimersByTimeAsync(ms); }
async function load() {
  vi.resetModules();
  // @ts-expect-error Plain extension script imported for its side effects.
  await import("../extension/background.js");
  await settle();
}
async function command(body: Record<string, unknown>) {
  const id = `sticky-${++sequence}`;
  FakeSocket.instance.deliver({ type: "command", id, ...body }); await settle();
  const response = FakeSocket.instance.messages.find((message) => message.id === id);
  expect(response).toBeDefined(); return response;
}
async function create(label = "Hephaestus") {
  const response = await command({ action: "createTab", label, url: "https://example.com/" });
  expect(response.error).toBeUndefined(); return response.result;
}
function detach(tabId: number, reason: string) { for (const listener of [...mock.debuggerOnDetach]) listener({ tabId }, reason); }
async function stopWorker(clearSession = true) {
  FakeSocket.instance.close(); vi.clearAllTimers(); mock.resetWorkerListeners();
  if (clearSession) await mock.chrome.storage.session.clear();
}
const entry = (tab: any, label = "Hephaestus") => ({ tabId: tab.id, label, groupTitle: label, windowId: tab.windowId });
const durable = async () => (await mock.chrome.storage.local.get("agentTabOwnersDurable")).agentTabOwnersDurable;
beforeEach(async () => {
  vi.useFakeTimers(); FakeSocket.instances = [];
  mock = createChromeMock(); vi.stubGlobal("chrome", mock.chrome); vi.stubGlobal("WebSocket", FakeSocket);
  windowId = (await mock.chrome.windows.create({ url: "about:blank", focused: false })).id;
  await mock.chrome.storage.session.set({ agentWindowId: windowId });
  await mock.chrome.storage.local.set({ token: "test-token" }); await load();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("writes durable ownership on creation and removes it when sharing is revoked", async () => {
  const tab = await create();
  expect(await durable()).toEqual([entry(tab)]);
  const unshare = mock.actionOnClicked[0]!(tab); await settle(); await unshare;
  expect(await durable()).toEqual([]);
});
it.each(["Hephaestus", "Agent Bridge", " literal.* [label] "])("restores label %j after extension reload using its exact group title", async (label) => {
  const tab = await create(label);
  await mock.chrome.storage.local.set({ agentTabOwnersDurable: [entry(tab, label)] });
  await stopWorker();
  const attach = vi.spyOn(mock.chrome.debugger, "attach"); await load();
  expect((await command({ action: "listAgentTabs", label })).result).toEqual([expect.objectContaining({ tabId: tab.id })]);
  expect(attach).toHaveBeenCalledWith({ tabId: tab.id }, "1.3");
  expect(await mock.chrome.storage.session.get("agentWindowId")).toEqual({ agentWindowId: windowId });
  expect((await command({ action: "cdp", tabId: tab.id, label: "Other", method: "Page.captureScreenshot" })).error).toMatch(/owned/i);
});
it.each(["wrong title", "ungrouped", "missing", "different label", "forged title mapping", "wrong window", "duplicates"])(
  "drops durable ownership on reload for %s", async (reason) => {
    const tab = await create(); await stopWorker();
    let records = [entry(tab)];
    if (reason === "wrong title") mock.simulateGroupRename(tab.groupId, "Other");
    if (reason === "ungrouped") await mock.chrome.tabs.ungroup(tab.id);
    if (reason === "missing") mock.tabsById.delete(tab.id);
    if (reason === "different label") records = [entry(tab, "Other")];
    if (reason === "forged title mapping") records[0]!.groupTitle = "Other";
    if (reason === "wrong window") records[0]!.windowId = windowId + 1;
    if (reason === "duplicates") records.push(entry(tab));
    await mock.chrome.storage.local.set({ agentTabOwnersDurable: records }); await load();
    expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
    expect((await command({ action: "listAgentTabs", label: "Other" })).result).toEqual([]);
    expect(await durable()).toEqual([]);
  }
);
it("keeps multiple owned tabs for the same label without adopting other tabs in its group", async () => {
  const first = await create(); const second = await create();
  const pending = mock.chrome.tabs.create({ windowId, url: "https://example.com/stranger", active: false }); await settle(); const stranger = await pending;
  const grouped = mock.chrome.tabs.group({ tabIds: [stranger.id], groupId: first.groupId }); await settle(); await grouped;
  await mock.chrome.storage.local.set({ agentTabOwnersDurable: [entry(first), entry(second)] });
  await stopWorker(); await load();
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result.map((tab: any) => tab.tabId)).toEqual([first.id, second.id]);
  expect((await command({ action: "cdp", tabId: stranger.id, label: "Hephaestus", method: "Page.captureScreenshot" })).error).toMatch(/not.*shared/i);
});
it("does not resurrect a revoked durable owner from stale session storage", async () => {
  await create();
  // Model a worker stopping after durable revocation but before the session write.
  await mock.chrome.storage.local.set({ agentTabOwnersDurable: [] });
  await stopWorker(false); await load();
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
  expect(await durable()).toEqual([]);
});
it("keeps ownership and re-attaches once after a transient detach", async () => {
  const tab = await create(); const attach = vi.spyOn(mock.chrome.debugger, "attach");
  detach(tab.id, "target_closed"); await settle();
  expect(attach).toHaveBeenCalledTimes(1);
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toHaveLength(1);
  expect(FakeSocket.instance.messages).toContainEqual(expect.objectContaining({ type: "diagnostic", event: "debuggerDetached", tabId: tab.id, label: "Hephaestus", reason: "target_closed", at: expect.any(String) }));
});
it("cancels pending recovery on canceled_by_user and drops durable ownership", async () => {
  const tab = await create(); const attach = vi.spyOn(mock.chrome.debugger, "attach");
  detach(tab.id, "target_closed"); await settle(100);
  detach(tab.id, "canceled_by_user"); await settle();
  expect(attach).not.toHaveBeenCalled();
  expect(await durable()).toEqual([]);
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
});
it("refuses recovery when group validation fails", async () => {
  const tab = await create(); const attach = vi.spyOn(mock.chrome.debugger, "attach");
  mock.simulateGroupRename(tab.groupId, "Other"); detach(tab.id, "target_closed"); await settle();
  expect(attach).not.toHaveBeenCalled(); expect(await durable()).toEqual([]);
});
it("detaches a late recovery result after the user cancels while attach is in flight", async () => {
  const tab = await create();
  let release!: () => void;
  vi.spyOn(mock.chrome.debugger, "attach").mockImplementationOnce(async () => { await new Promise<void>((resolve) => { release = resolve; }); });
  const nativeDetach = vi.spyOn(mock.chrome.debugger, "detach");
  detach(tab.id, "target_closed"); await settle();
  expect(release).toBeDefined();
  detach(tab.id, "canceled_by_user"); await settle();
  nativeDetach.mockClear(); release(); await settle();
  expect(nativeDetach).toHaveBeenCalledWith({ tabId: tab.id });
  expect(await durable()).toEqual([]);
});
it("detaches after a successful recovery attach if the group changed during that attach", async () => {
  const tab = await create();
  const nativeDetach = vi.spyOn(mock.chrome.debugger, "detach");
  vi.spyOn(mock.chrome.debugger, "attach").mockImplementationOnce(async () => { mock.simulateGroupRename(tab.groupId, "Other"); });
  detach(tab.id, "target_closed"); await settle();
  expect(nativeDetach).toHaveBeenCalledWith({ tabId: tab.id });
  expect(await durable()).toEqual([]);
});
it("drops ownership and logs a failed re-attach", async () => {
  const tab = await create();
  vi.spyOn(mock.chrome.debugger, "attach").mockRejectedValueOnce(new Error("Attach failed"));
  detach(tab.id, "target_closed"); await settle();
  expect(await durable()).toEqual([]);
  expect(FakeSocket.instance.messages).toContainEqual(expect.objectContaining({ type: "diagnostic", event: "debuggerReattachFailed", reason: "Attach failed" }));
});
it("limits re-attach attempts to three per tab per minute", async () => {
  const tab = await create(); const attach = vi.spyOn(mock.chrome.debugger, "attach");
  for (let i = 0; i < 4; i++) { detach(tab.id, "target_closed"); await settle(); }
  expect(attach).toHaveBeenCalledTimes(3);
  expect(await durable()).toEqual([]);
});
it("allows a new recovery attempt after the rate-limit window expires", async () => {
  const tab = await create(); const attach = vi.spyOn(mock.chrome.debugger, "attach");
  for (let i = 0; i < 3; i++) { detach(tab.id, "target_closed"); await settle(); }
  await settle(60000);
  detach(tab.id, "target_closed"); await settle();
  expect(attach).toHaveBeenCalledTimes(4);
  expect(await durable()).toEqual([entry(tab)]);
});
it("keeps at most 50 disconnected diagnostics and flushes them on reconnect", async () => {
  FakeSocket.instance.close();
  for (let i = 0; i < 75; i++) detach(999, `reason-${i}`);
  await settle(100);
  for (const listener of mock.alarmsOnAlarm) listener({ name: "ubb-keepalive" });
  await settle();
  const diagnostics = FakeSocket.instance.messages.filter((message) => message.type === "diagnostic");
  expect(diagnostics).toHaveLength(50);
  expect(diagnostics.at(-1)).toMatchObject({ reason: "reason-74" });
});
it("creates a keepalive alarm and reconnects a disconnected socket without replacing a healthy one", async () => {
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  expect(manifest.permissions).toContain("alarms");
  expect(mock.alarmsByName.get("ubb-keepalive")).toEqual({ periodInMinutes: 0.5 });
  const initial = FakeSocket.instances.length;
  for (const listener of mock.alarmsOnAlarm) listener({ name: "ubb-keepalive" }); await settle();
  expect(FakeSocket.instances).toHaveLength(initial);
  FakeSocket.instance.close();
  for (const listener of mock.alarmsOnAlarm) listener({ name: "ubb-keepalive" }); await settle();
  expect(FakeSocket.instances).toHaveLength(initial + 1);
});
