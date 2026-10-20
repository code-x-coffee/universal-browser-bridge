import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./test-support/chrome-mock.js";

// Exercise the extension's command protocol at the Chrome/WebSocket boundary.
class FakeSocket {
  static OPEN = 1;
  static instance: FakeSocket;
  readyState = 1;
  messages: any[] = [];
  listeners = new Map<string, (event?: any) => void>();
  constructor(_url: string) {
    FakeSocket.instance = this;
    setTimeout(() => this.listeners.get("open")?.(), 0);
  }
  addEventListener(type: string, listener: (event?: any) => void) { this.listeners.set(type, listener); }
  deliver(message: unknown) { this.listeners.get("message")?.({ data: JSON.stringify(message) }); }
  send(raw: string) {
    const message = JSON.parse(raw);
    this.messages.push(message);
    if (message.type === "hello") setTimeout(() => this.deliver({ type: "ready" }), 0);
    if (message.type === "annotationsList") setTimeout(() => this.deliver({ type: "annotationsResponse", id: message.id, result: [] }), 0);
  }
  close() { this.readyState = 3; }
}

let mock: ReturnType<typeof createChromeMock>;
let windowId: number;
let sequence = 0;
async function settle() { await vi.advanceTimersByTimeAsync(600); }
async function loadWorker() {
  vi.resetModules();
  // @ts-expect-error Plain extension script, imported for its side effects.
  await import("../extension/background.js");
  await settle();
}
async function command(body: Record<string, unknown>) {
  const id = `command-${++sequence}`;
  FakeSocket.instance.deliver({ type: "command", id, ...body });
  await settle();
  const response = FakeSocket.instance.messages.find((message) => message.type === "response" && message.id === id);
  expect(response).toBeDefined();
  return response;
}
async function create(label?: string, url = "https://example.com/") {
  const response = await command({ action: "createTab", label, url });
  expect(response.error).toBeUndefined();
  return response.result;
}

async function upload(tabId: number, label: string | undefined, files: unknown = ["/Volumes/NVme/Projects/Stories/ref.png"]) {
  return command({ action: "cdp", tabId, label, method: "DOM.setFileInputFiles", params: { files, objectId: "file-input" } });
}

beforeEach(async () => {
  vi.useFakeTimers();
  mock = createChromeMock();
  vi.stubGlobal("chrome", mock.chrome);
  vi.stubGlobal("WebSocket", FakeSocket);
  windowId = (await mock.chrome.windows.create({ url: "about:blank", focused: false })).id;
  await mock.chrome.storage.session.set({ agentWindowId: windowId });
  await mock.chrome.storage.local.set({ token: "test-token" });
  await loadWorker();
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("sends upload folders in hello and sitePolicy and resends storage changes", async () => {
  expect(FakeSocket.instance.messages.find((message) => message.type === "hello").uploadFolders)
    .toEqual(["/Volumes/NVme/Projects/Stories/"]);
  expect(FakeSocket.instance.messages.find((message) => message.type === "sitePolicy").uploadFolders)
    .toEqual(["/Volumes/NVme/Projects/Stories/"]);
  await mock.chrome.storage.local.set({ uploadFolders: [" /tmp/images ", "relative", "/x/../y"] });
  await settle();
  expect(FakeSocket.instance.messages.filter((message) => message.type === "sitePolicy").at(-1).uploadFolders)
    .toEqual(["/tmp/images/"]);
  await mock.chrome.storage.local.set({ uploadFolders: [] });
  await settle();
  expect(FakeSocket.instance.messages.filter((message) => message.type === "sitePolicy").at(-1).uploadFolders).toEqual([]);
});

it("allows file attachment only to tabs owned by the supplied label", async () => {
  const owned = await create("Hephaestus");
  const shared = await create();
  const send = vi.spyOn(mock.chrome.debugger, "sendCommand");
  expect((await upload(shared.id, "Hephaestus")).error).toMatch(/owned.*label/i);
  expect((await upload(shared.id, undefined)).error).toMatch(/label/i);
  expect((await upload(owned.id, "Hermes")).error).toMatch(/owned/i);
  expect(send).not.toHaveBeenCalled();
  expect((await upload(owned.id, "Hephaestus")).error).toBeUndefined();
  expect(send).toHaveBeenCalledWith({ tabId: owned.id }, "DOM.setFileInputFiles", expect.objectContaining({ objectId: "file-input" }));
});

it("rejects file paths outside the extension folders including sibling prefixes and traversal", async () => {
  const tab = await create("Hephaestus");
  const send = vi.spyOn(mock.chrome.debugger, "sendCommand");
  for (const path of ["/etc/passwd", "/Volumes/NVme/Projects/Stories-evil/file", "/Volumes/NVme/Projects/Stories/../secret", "/Volumes/NVme/Projects/Stories/a\0b", "relative"]) {
    expect((await upload(tab.id, "Hephaestus", [path])).error).toMatch(/allowed upload folders/i);
  }
  await mock.chrome.storage.local.set({ uploadFolders: [] });
  expect((await upload(tab.id, "Hephaestus")).error).toMatch(/disabled/i);
  expect(send).not.toHaveBeenCalled();
});

it("requires file URL permission when Chrome exposes the permission check", async () => {
  const tab = await create("Hephaestus");
  Object.assign(mock.chrome, { extension: { isAllowedFileSchemeAccess: async () => false } });
  const send = vi.spyOn(mock.chrome.debugger, "sendCommand");
  expect((await upload(tab.id, "Hephaestus")).error).toContain("Allow access to file URLs");
  expect(send).not.toHaveBeenCalled();
  Object.assign(mock.chrome, { extension: { isAllowedFileSchemeAccess: async () => true } });
  expect((await upload(tab.id, "Hephaestus")).error).toBeUndefined();
});

it("enforces writable and blocklist policy on file attachment even without requiresWritable", async () => {
  const tab = await create("Hephaestus");
  const send = vi.spyOn(mock.chrome.debugger, "sendCommand");
  mock.tabsById.get(tab.id)!.url = "https://hdfcbank.com/";
  expect((await upload(tab.id, "Hephaestus")).error).toMatch(/read-only/);
  mock.tabsById.get(tab.id)!.url = "https://example.com/";
  await mock.chrome.storage.local.set({ blockedDomains: ["example.com"] });
  expect((await upload(tab.id, "Hephaestus")).error).toMatch(/blocked by your blocklist/);
  expect(send).not.toHaveBeenCalled();
});

it.each(["url", "pendingUrl"] as const)("enforces read-only live %s on every Input method without a writable flag", async (field) => {
  const tab = await create("Hephaestus");
  const send = vi.spyOn(mock.chrome.debugger, "sendCommand");
  mock.tabsById.get(tab.id)![field] = "https://hdfcbank.com/";
  for (const method of ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Input.dispatchTouchEvent"]) {
    for (const requiresWritable of [undefined, false]) {
      expect((await command({ action: "cdp", tabId: tab.id, label: "Hephaestus", method, requiresWritable })).error).toMatch(/read-only/);
    }
  }
  expect(send).not.toHaveBeenCalled();
});

it("forwards mouse input on writable tabs while retaining ownership and blocklist checks", async () => {
  const tab = await create("Hephaestus");
  const send = vi.spyOn(mock.chrome.debugger, "sendCommand");
  const input = { action: "cdp", tabId: tab.id, method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 60, y: 50, button: "left", clickCount: 1 } };
  expect((await command({ ...input, label: "Hermes" })).error).toMatch(/owned/i);
  await mock.chrome.storage.local.set({ blockedDomains: ["example.com"] });
  expect((await command({ ...input, label: "Hephaestus" })).error).toContain("blocked by your blocklist");
  expect(send).not.toHaveBeenCalled();
  await mock.chrome.storage.local.set({ blockedDomains: [] });
  expect((await command({ ...input, label: "Hephaestus" })).error).toBeUndefined();
  expect(send).toHaveBeenCalledWith({ tabId: tab.id }, "Input.dispatchMouseEvent", input.params);
});

it("creates tabs in a group titled with the exact label and reuses it within the window", async () => {
  const first = await create("Hephaestus");
  const second = await create("Hephaestus", "https://example.com/second");
  const lookup = mock.chrome.tabs.get(first.id);
  await settle();
  const tab = await lookup;
  expect(await mock.chrome.tabGroups.query({ title: "Hephaestus", windowId })).toHaveLength(1);
  const secondLookup = mock.chrome.tabs.get(second.id);
  await settle();
  expect((await secondLookup).groupId).toBe(tab.groupId);
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([
    { tabId: first.id, url: "https://example.com/", title: "New Tab", groupId: tab.groupId },
    { tabId: second.id, url: "https://example.com/second", title: "New Tab", groupId: tab.groupId }
  ]);
});

it("isolates owned tabs from other labels and unlabeled callers for listing, reading, driving and closing", async () => {
  const owned = await create("Hephaestus");
  const send = vi.spyOn(mock.chrome.debugger, "sendCommand");
  for (const label of ["Hermes", undefined]) {
    expect((await command({ action: "listTabs", label })).result).toEqual([]);
    for (const method of ["Runtime.evaluate", "Page.navigate", "Input.dispatchKeyEvent", "Page.captureScreenshot"]) {
      expect((await command({ action: "cdp", tabId: owned.id, label, method })).error).toMatch(/owned.*Hephaestus/i);
    }
    expect((await command({ action: "closeTab", tabId: owned.id, label })).error).toMatch(/owned.*Hephaestus/i);
  }
  expect(send).not.toHaveBeenCalled();
  expect((await command({ action: "cdp", tabId: owned.id, label: "Hephaestus", method: "Page.captureScreenshot" })).error).toBeUndefined();
  expect((await command({ action: "closeTab", tabId: owned.id, label: "Hephaestus" })).result).toEqual({ closed: owned.id });
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
});

it("restores label ownership after a worker restart and reconciles closed or ungrouped tabs", async () => {
  const surviving = await create("Hephaestus");
  const closed = await create("Hephaestus");
  const ungrouped = await create("Hephaestus");
  vi.clearAllTimers();
  mock.resetWorkerListeners();
  await mock.chrome.tabs.remove(closed.id);
  await mock.chrome.tabs.ungroup(ungrouped.id);
  await loadWorker();
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([
    { tabId: surviving.id, url: "https://example.com/", title: "New Tab", groupId: surviving.groupId }
  ]);
  expect((await command({ action: "cdp", tabId: surviving.id, label: "Hermes", method: "Page.captureScreenshot" })).error).toMatch(/owned.*Hephaestus/i);
  expect((await command({ action: "cdp", tabId: ungrouped.id, label: "Hephaestus", method: "Page.captureScreenshot" })).error).toMatch(/not.*shared/i);
  expect((await command({ action: "closeTab", tabId: surviving.id, label: "Hephaestus" })).error).toBeUndefined();
  await loadWorker();
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
});

it.each(["ungroup", "rename", "toolbar", "debugger", "close"])("drops ownership when a user revokes access by %s", async (action) => {
  const tab = await create("Hephaestus");
  if (action === "ungroup") await mock.chrome.tabs.ungroup(tab.id);
  if (action === "rename") mock.simulateGroupRename(tab.groupId, "User group");
  if (action === "toolbar") {
    const click = mock.actionOnClicked[0]!(tab);
    await settle(); await click;
  }
  if (action === "debugger") for (const listener of mock.debuggerOnDetach) listener({ tabId: tab.id }, "canceled_by_user");
  if (action === "close") await mock.chrome.tabs.remove(tab.id);
  await settle();
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
  expect((await command({ action: "cdp", tabId: tab.id, label: "Hephaestus", method: "Page.captureScreenshot" })).error).toMatch(/not.*shared/i);
  vi.clearAllTimers(); mock.resetWorkerListeners();
  await loadWorker();
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
});

it("preserves hand-shared and unlabeled tabs in Agent Bridge without adopting a group's other tabs", async () => {
  const unowned = await create();
  expect((await command({ action: "listAgentTabs" })).error).toMatch(/label.*required/i);
  const human = (await mock.chrome.windows.create({ url: "https://example.org/", focused: true })).tabs[0]!;
  const click = mock.actionOnClicked[0]!(human);
  await settle(); await click;
  expect((await command({ action: "listTabs", label: "Hephaestus" })).result.map((tab: any) => tab.id)).toEqual([unowned.id, human.id]);
  const creation = mock.chrome.tabs.create({ windowId, url: "https://example.org/private", active: false });
  await settle();
  const stranger = await creation;
  const grouping = mock.chrome.tabs.group({ tabIds: [stranger.id], createProperties: { windowId } });
  await settle();
  const groupId = await grouping;
  const rename = mock.chrome.tabGroups.update(groupId, { title: "Hephaestus" });
  await settle(); await rename;
  const owned = await create("Hephaestus");
  expect(owned.groupId).toBe(groupId);
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result.map((tab: any) => tab.tabId)).toEqual([owned.id]);
  expect((await command({ action: "cdp", tabId: stranger.id, label: "Hephaestus", method: "Page.captureScreenshot" })).error).toMatch(/not.*shared/i);
  expect((await command({ action: "closeTab", tabId: human.id, label: "Hermes" })).result).toEqual({ closed: human.id });
});

it.each(["group", "badge", "ownership-storage"])("cleans up a newly opened tab when %s setup fails", async (step) => {
  if (step === "group") vi.spyOn(mock.chrome.tabGroups, "update").mockRejectedValueOnce(new Error("group failed"));
  if (step === "badge") vi.spyOn(mock.chrome.action, "setBadgeBackgroundColor").mockRejectedValueOnce(new Error("badge failed"));
  if (step === "ownership-storage") {
    const set = mock.chrome.storage.session.set;
    vi.spyOn(mock.chrome.storage.session, "set").mockImplementation(async (value) => {
      if ((value.agentTabOwners as any[])?.length) throw new Error("ownership-storage failed");
      await set(value);
    });
  }
  expect((await command({ action: "createTab", label: "Hephaestus", url: "https://example.com/" })).error).toMatch(/failed/);
  expect((await mock.chrome.tabs.query({ windowId })).map((tab) => tab.url)).toEqual(["about:blank"]);
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
});

it("never exposes a tab as unowned while persisting a revocation, even for the label Agent Bridge", async () => {
  const tab = await create("Agent Bridge");
  const set = mock.chrome.storage.session.set;
  let release!: () => void;
  vi.spyOn(mock.chrome.storage.session, "set").mockImplementation(async (value) => {
    if (Array.isArray(value.agentTabOwners) && value.agentTabOwners.length === 0) {
      await new Promise<void>((resolve) => { release = resolve; });
    }
    await set(value);
  });
  const click = mock.actionOnClicked[0]!(tab);
  await settle();
  const response = await command({ action: "cdp", tabId: tab.id, label: "Hermes", method: "Page.captureScreenshot" });
  release();
  await settle(); await click;
  expect(response.error).toMatch(/not.*shared/i);
});

it("reports creation failures without falling back to a second window or an approval popup", async () => {
  vi.spyOn(mock.chrome.tabs, "create").mockRejectedValueOnce(new Error("tab creation failed"));
  const windows = vi.spyOn(mock.chrome.windows, "create").mockRejectedValueOnce(new Error("unexpected popup"));
  const response = await command({ action: "createTab", label: "Hephaestus", url: "https://example.com/" });
  expect(response.error).toBe("tab creation failed");
  expect(windows).not.toHaveBeenCalled();
});

it("keeps a labelled tab private while Chrome is still finishing its group setup", async () => {
  const update = mock.chrome.tabGroups.update;
  let release!: () => void;
  vi.spyOn(mock.chrome.tabGroups, "update").mockImplementation(async (id, changes) => {
    const group = await update(id, changes);
    await new Promise<void>((resolve) => { release = resolve; });
    return group;
  });
  FakeSocket.instance.deliver({ type: "command", id: "creating", action: "createTab", label: "Agent Bridge", url: "https://example.com/" });
  await settle();
  const tab = (await mock.chrome.tabs.query({ windowId })).find((tab) => tab.url === "https://example.com/")!;
  const response = await command({ action: "cdp", tabId: tab.id, label: "Hermes", method: "Page.captureScreenshot" });
  release(); await settle();
  expect(response.error).toMatch(/owned.*Agent Bridge/i);
  expect(FakeSocket.instance.messages.find((message) => message.id === "creating").error).toBeUndefined();
});

it("does not restore a revoked owned tab as hand-shared when it moved to Agent Bridge while the worker was asleep", async () => {
  const tab = await create("Hephaestus");
  vi.clearAllTimers(); mock.resetWorkerListeners();
  const grouping = mock.chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId } });
  await settle();
  const groupId = await grouping;
  const rename = mock.chrome.tabGroups.update(groupId, { title: "Agent Bridge" });
  await settle(); await rename;
  await loadWorker();
  expect((await command({ action: "listAgentTabs", label: "Hephaestus" })).result).toEqual([]);
  expect((await command({ action: "listTabs", label: "Hermes" })).result).toEqual([]);
  expect((await command({ action: "cdp", tabId: tab.id, label: "Hermes", method: "Page.captureScreenshot" })).error).toMatch(/not.*shared/i);
});

it("does not restore an interrupted labelled creation as an unowned shared tab", async () => {
  const update = mock.chrome.tabGroups.update;
  vi.spyOn(mock.chrome.tabGroups, "update").mockImplementation(async (id, changes) => {
    await update(id, changes);
    // Model a worker stopping after Chrome groups the tab, before the
    // extension's ownership transaction completes. This job never resumes.
    return new Promise(() => {});
  });
  FakeSocket.instance.deliver({ type: "command", id: "interrupted", action: "createTab", label: "Agent Bridge", url: "https://example.com/" });
  await settle();
  FakeSocket.instance.close();
  vi.clearAllTimers(); mock.resetWorkerListeners(); vi.restoreAllMocks();
  await loadWorker();
  expect((await command({ action: "listTabs", label: "Hermes" })).result).toEqual([]);
});

it.each([true, false])("refuses blocked new tabs before creation or approval (agent window exists=%s)", async (hasWindow) => {
  if (!hasWindow) await mock.chrome.storage.session.remove("agentWindowId");
  await mock.chrome.storage.local.set({ autoCreateAgentWindow: true, blockedDomains: ["https://WWW.Example.com/private"] });
  const tabs = vi.spyOn(mock.chrome.tabs, "create");
  const windows = vi.spyOn(mock.chrome.windows, "create");
  const response = await command({ action: "createTab", url: "https://login.example.com/", label: "Hephaestus" });
  expect(response.error).toContain("blocked by your blocklist");
  expect(tabs).not.toHaveBeenCalled();
  expect(windows).not.toHaveBeenCalled();
});

it.each([undefined, true])("creates the first agent window without a prompt (automatic windows=%s)", async (autoCreateAgentWindow) => {
  await mock.chrome.storage.session.remove("agentWindowId");
  if (autoCreateAgentWindow !== undefined) await mock.chrome.storage.local.set({ autoCreateAgentWindow });
  const windows = vi.spyOn(mock.chrome.windows, "create");
  FakeSocket.instance.deliver({ type: "command", id: "first-window", action: "createTab", label: "Hephaestus", url: "https://example.com/" });
  await settle();
  const response = FakeSocket.instance.messages.find((message) => message.id === "first-window");
  expect(response?.error).toBeUndefined();
  expect(response?.result).toMatchObject({ url: "https://example.com/" });
  expect(windows.mock.calls).toEqual([[{ url: "https://example.com/", focused: false }]]);
  expect(await mock.chrome.storage.session.get("agentWindowId")).toEqual({ agentWindowId: response.result.windowId });
});

it.each([false, true])("uses the approval flow when automatic agent windows are disabled (approved=%s)", async (approved) => {
  await mock.chrome.storage.session.remove("agentWindowId");
  await mock.chrome.storage.local.set({ trustAgentOwnedTabs: true, autoCreateAgentWindow: false });
  const windows = vi.spyOn(mock.chrome.windows, "create");
  FakeSocket.instance.deliver({ type: "command", id: "first-window", action: "createTab", label: "Hephaestus", url: "https://example.com/" });
  await settle();
  expect(FakeSocket.instance.messages.some((message) => message.id === "first-window")).toBe(false);
  expect(windows).toHaveBeenCalledTimes(1);
  const popup = windows.mock.calls[0]![0];
  expect(popup.url).toContain("approval.html");
  const id = new URL(popup.url).searchParams.get("id")!;
  for (const listener of mock.runtimeOnMessage) listener({ type: "approvalDecision", id, approved }, {}, () => {});
  await settle();
  const response = FakeSocket.instance.messages.find((message) => message.id === "first-window");
  if (approved) {
    expect(response.error).toBeUndefined();
    expect(response.result.url).toBe("https://example.com/");
    expect(windows.mock.calls[1]).toEqual([{ url: "https://example.com/", focused: false }]);
    expect(windows).toHaveBeenCalledTimes(2);
  } else {
    expect(response.error).toMatch(/denied/i);
    expect(windows).toHaveBeenCalledTimes(1);
    expect(await mock.chrome.storage.session.get("agentWindowId")).toEqual({ agentWindowId: undefined });
  }
});

it("reads the automatic window setting live after it changes", async () => {
  await mock.chrome.storage.session.remove("agentWindowId");
  await mock.chrome.storage.local.set({ autoCreateAgentWindow: false });
  const windows = vi.spyOn(mock.chrome.windows, "create");
  FakeSocket.instance.deliver({ type: "command", id: "denied-window", action: "createTab", label: "Hephaestus", url: "https://example.com/" });
  await settle();
  const id = new URL(windows.mock.calls[0]![0].url).searchParams.get("id")!;
  for (const listener of mock.runtimeOnMessage) listener({ type: "approvalDecision", id, approved: false }, {}, () => {});
  await settle();
  expect(FakeSocket.instance.messages.find((message) => message.id === "denied-window").error).toMatch(/denied/i);
  await mock.chrome.storage.local.set({ autoCreateAgentWindow: true });
  windows.mockClear();
  await create("Hephaestus");
  expect(windows.mock.calls).toEqual([[{ url: "https://example.com/", focused: false }]]);
});

it("rechecks the blocklist after approval before creating an agent window", async () => {
  await mock.chrome.storage.session.remove("agentWindowId");
  await mock.chrome.storage.local.set({ autoCreateAgentWindow: false });
  const windows = vi.spyOn(mock.chrome.windows, "create");
  FakeSocket.instance.deliver({ type: "command", id: "first-window", action: "createTab", label: "Hephaestus", url: "https://example.com/" });
  await settle();
  const popup = windows.mock.calls[0]![0];
  const id = new URL(popup.url).searchParams.get("id")!;
  await mock.chrome.storage.local.set({ blockedDomains: ["example.com"] });
  for (const listener of mock.runtimeOnMessage) listener({ type: "approvalDecision", id, approved: true }, {}, () => {});
  await settle();
  expect(FakeSocket.instance.messages.find((message) => message.id === "first-window").error).toContain("blocked by your blocklist");
  expect(windows).toHaveBeenCalledTimes(1);
});

it("uses live ownership and pending URLs for approval rather than command-supplied trust flags", async () => {
  const tab = await create("Hephaestus");
  const windows = vi.spyOn(mock.chrome.windows, "create");
  expect((await command({ action: "requestApproval", tabId: tab.id, label: "Hermes", trustAgentOwnedTabs: true })).error)
    .toMatch(/owned.*Hephaestus/i);
  mock.tabsById.get(tab.id)!.pendingUrl = "https://passwords.google.com/";
  expect((await command({ action: "requestApproval", tabId: tab.id, label: "Hephaestus", trustAgentOwnedTabs: true })).error)
    .toMatch(/read.only/i);
  expect((await command({ action: "cdp", tabId: tab.id, label: "Hephaestus", method: "Input.dispatchKeyEvent", requiresWritable: true })).error)
    .toMatch(/read.only/i);
  expect(windows).not.toHaveBeenCalled();
});

it("sends a normalized blocklist on connect, on change and after a worker restart", async () => {
  expect(FakeSocket.instance.messages.find((message) => message.type === "hello").blockedDomains).toEqual([]);
  await mock.chrome.storage.local.set({ blockedDomains: ["HTTPS://WWW.Example.org/path", "example.org"] });
  await settle();
  expect(FakeSocket.instance.messages.filter((message) => message.type === "sitePolicy").at(-1).blockedDomains).toEqual(["example.org"]);
  FakeSocket.instance.close();
  vi.clearAllTimers(); mock.resetWorkerListeners();
  await loadWorker();
  expect(FakeSocket.instance.messages.find((message) => message.type === "hello").blockedDomains).toEqual(["example.org"]);
});

it.each(["url", "pendingUrl"] as const)("refuses every CDP call and getTab against a blocked live %s", async (field) => {
  const tab = await create("Hephaestus");
  mock.tabsById.get(tab.id)![field] = "https://vault.example.org/private";
  await mock.chrome.storage.local.set({ blockedDomains: ["example.org"], trustAgentOwnedTabs: true });
  const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
  for (const method of ["Runtime.evaluate", "Runtime.callFunctionOn", "DOM.getDocument", "Page.captureScreenshot",
    "Page.navigate", "Input.dispatchKeyEvent"]) {
    expect((await command({ action: "cdp", tabId: tab.id, label: "Hephaestus", method })).error)
      .toContain("blocked by your blocklist");
  }
  expect((await command({ action: "getTab", tabId: tab.id, label: "Hephaestus" })).error).toContain("blocked by your blocklist");
  expect(commands).not.toHaveBeenCalled();
});

it("refuses a blocked CDP navigation target while the current page is allowed", async () => {
  const tab = await create("Hephaestus");
  await mock.chrome.storage.local.set({ blockedDomains: ["example.org"] });
  const commands = vi.spyOn(mock.chrome.debugger, "sendCommand");
  expect((await command({ action: "cdp", tabId: tab.id, label: "Hephaestus", method: "Page.navigate",
    params: { url: "https://www.example.org/private" }, requiresWritable: true })).error).toContain("blocked by your blocklist");
  expect(commands).not.toHaveBeenCalled();
});

it("refuses blocked hand-shared tabs and hides them from listings", async () => {
  const tab = (await mock.chrome.windows.create({ url: "https://example.org/", focused: true })).tabs[0]!;
  const sharing = mock.actionOnClicked[0]!(tab);
  await settle(); await sharing;
  await mock.chrome.storage.local.set({ blockedDomains: ["example.org"] });
  expect((await command({ action: "cdp", tabId: tab.id, label: "Hephaestus", method: "Page.captureScreenshot" })).error)
    .toContain("blocked by your blocklist");
  expect((await command({ action: "listTabs", label: "Hephaestus" })).result).toEqual([]);
  expect((await command({ action: "getTab", tabId: tab.id, label: "Hephaestus" })).error).toContain("blocked by your blocklist");
  await mock.chrome.storage.local.set({ blockedDomains: [] });
  expect((await command({ action: "getTab", tabId: tab.id, label: "Hephaestus" })).error).toBeUndefined();
});
