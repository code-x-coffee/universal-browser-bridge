import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./test-support/chrome-mock.js";
import { annotationDraft } from "./test-support/annotation-fixture.js";

// WebSocket boundary only, so the real background handlers can be exercised
// without requiring a running Chrome or opening a network listener.
class FakeSocket {
  static OPEN = 1;
  static instance: FakeSocket;
  readyState = 1;
  messages: any[] = [];
  annotations: any[] = [];
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
    if (message.type === "annotationsList") setTimeout(() => this.deliver({ type: "annotationsResponse", id: message.id, result: this.annotations.filter((item) => item.url === message.url) }), 0);
    if (message.type === "annotationsSave") setTimeout(() => this.deliver({ type: "annotationsResponse", id: message.id, result: { ...message.annotation, id: "saved" } }), 0);
  }
  close() { this.readyState = 3; }
}
let mock: ReturnType<typeof createChromeMock>;
let tab: Awaited<ReturnType<typeof mock.chrome.tabs.get>>;
async function settle() { await vi.advanceTimersByTimeAsync(100); }
async function share() {
  const sharing = mock.actionOnClicked[0]!(tab);
  await settle();
  await sharing;
}
async function save(message: any, sender: any = { tab, frameId: 0, url: tab.url }) {
  let response: any;
  expect(mock.runtimeOnMessage[0]!(message, sender, (result) => { response = result; })).toBe(true);
  await settle();
  return response;
}
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mock = createChromeMock();
  vi.stubGlobal("chrome", mock.chrome);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const win = await mock.chrome.windows.create({ url: annotationDraft.url, focused: true });
  tab = win.tabs[0]!;
  await mock.chrome.storage.local.set({ relayUrl: "ws://127.0.0.1:17321/extension", token: "unit-token" });
  // @ts-expect-error Plain extension JavaScript imported for side effects.
  await import("../extension/background.js");
  await settle();
});
afterEach(() => {
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it("creates a toolbar context menu and gates both entry points on explicit sharing", async () => {
  const injection = vi.spyOn(mock.chrome.scripting, "executeScript");
  mock.commandsOnCommand[0]!("toggle-annotate", tab);
  mock.contextMenusOnClicked[0]!({ menuItemId: "ubb-annotate" }, tab);
  await settle();
  expect(injection).not.toHaveBeenCalled();
  expect(mock.actionTitles.get(tab.id)).toMatch(/share this tab/i);
  await share();
  const send = vi.spyOn(mock.chrome.tabs, "sendMessage");
  mock.commandsOnCommand[0]!("toggle-annotate", tab);
  await settle();
  mock.contextMenusOnClicked[0]!({ menuItemId: "ubb-annotate" }, tab);
  await settle();
  expect(send.mock.calls.filter(([, message]) => (message as any).type === "ubbAnnotationsToggle")).toHaveLength(2);
  expect(injection).toHaveBeenCalledWith({ target: { tabId: tab.id }, files: ["annotation-utils.js", "annotations.js"] });
});

it("captures the requesting window and saves through the authenticated WebSocket", async () => {
  await share();
  const capture = vi.spyOn(mock.chrome.tabs, "captureVisibleTab");
  const result = await save({ type: "ubbAnnotationSave", annotation: annotationDraft });
  expect(capture).toHaveBeenCalledWith(tab.windowId, { format: "png" });
  expect(result.result.id).toBe("saved");
  expect(FakeSocket.instance.messages.find((message) => message.type === "annotationsSave")).toMatchObject({ tabId: tab.id, annotation: { url: tab.url } });
});

it("checks that the originating document stays hidden at the same scroll position during capture", async () => {
  await share();
  const send = vi.spyOn(mock.chrome.tabs, "sendMessage").mockImplementation(async (_id, message) => {
    if ((message as any).type === "ubbAnnotationsCaptureContext") return { url: tab.url, hidden: true, scroll: annotationDraft.scroll };
    return {};
  });
  const result = await save({ type: "ubbAnnotationSave", annotation: annotationDraft }, { tab, frameId: 0, url: tab.url, documentId: "document-one" });
  expect(result.result.id).toBe("saved");
  expect(send).toHaveBeenCalledWith(tab.id, { type: "ubbAnnotationsCaptureContext" }, { documentId: "document-one" });
  send.mockResolvedValue({ url: tab.url, hidden: true, scroll: { x: 0, y: 999 } });
  const changed = await save({ type: "ubbAnnotationSave", annotation: annotationDraft }, { tab, frameId: 0, url: tab.url, documentId: "document-one" });
  expect(changed.error).toMatch(/scroll position changed/);
});

it.each(["unshared", "iframe", "inactive", "wrong-url", "navigation", "unshare-during-capture"])("rejects %s saves without persisting a screenshot from another tab", async (scenario) => {
  if (scenario !== "unshared") await share();
  const sender = { tab, frameId: scenario === "iframe" ? 1 : 0, url: tab.url };
  const capture = vi.spyOn(mock.chrome.tabs, "captureVisibleTab");
  if (scenario === "inactive") mock.tabsById.get(tab.id)!.active = false;
  if (scenario === "wrong-url") sender.url = "https://different.example/";
  if (scenario === "navigation") capture.mockImplementation(async () => {
    for (const listener of mock.tabsOnUpdated) listener(tab.id, { status: "loading" }, tab);
    return "data:image/png;base64,iVBORw0KGgo=";
  });
  if (scenario === "unshare-during-capture") capture.mockImplementation(async () => {
    await mock.actionOnClicked[0]!(tab);
    return "data:image/png;base64,iVBORw0KGgo=";
  });
  const result = await save({ type: "ubbAnnotationSave", annotation: annotationDraft }, sender);
  expect(result.error).toMatch(/shared|active|URL/i);
  expect(FakeSocket.instance.messages.some((message) => message.type === "annotationsSave")).toBe(false);
});

it("refreshes pins on reload and on a matching live resolution, then removes UI on unshare", async () => {
  await share();
  const send = vi.spyOn(mock.chrome.tabs, "sendMessage");
  for (const listener of mock.tabsOnUpdated) listener(tab.id, { status: "complete" }, tab);
  await settle();
  expect(send).toHaveBeenCalledWith(tab.id, { type: "ubbAnnotationsRender", url: tab.url, annotations: [] });
  send.mockClear();
  FakeSocket.instance.deliver({ type: "annotationUpdated", annotation: { url: "https://another.example/" } });
  await settle();
  expect(send).not.toHaveBeenCalled();
  FakeSocket.instance.deliver({ type: "annotationUpdated", annotation: { url: tab.url, status: "resolved" } });
  await settle();
  expect(send).toHaveBeenCalledWith(tab.id, { type: "ubbAnnotationsRender", url: tab.url, annotations: [] });
  await share();
  expect(send).toHaveBeenCalledWith(tab.id, { type: "ubbAnnotationsDestroy" });
});

it("reports disconnection and rejects pending saves instead of leaving the popup waiting", async () => {
  await share();
  FakeSocket.instance.listeners.get("close")?.();
  const result = await save({ type: "ubbAnnotationSave", annotation: annotationDraft });
  expect(result.error).toMatch(/not connected/);
  mock.commandsOnCommand[0]!("toggle-annotate", tab);
  await settle();
  expect(mock.actionTitles.get(tab.id)).toMatch(/connect.*daemon/i);
});

it("refreshes reply threads on every shared tab at the same exact URL", async () => {
  await share();
  const matching = (await mock.chrome.windows.create({ url: tab.url, focused: false })).tabs[0]!;
  const different = (await mock.chrome.windows.create({ url: tab.url + "?other", focused: false })).tabs[0]!;
  for (const shared of [matching, different]) {
    const sharing = mock.actionOnClicked[0]!(shared);
    await settle(); await sharing;
  }
  const send = vi.spyOn(mock.chrome.tabs, "sendMessage");
  const annotation = { ...annotationDraft, id: "saved", status: "open", replies: [{ id: "reply", author: "agent", text: "Fixed", createdAt: "2026-10-10T10:00:00.000Z" }] };
  FakeSocket.instance.annotations = [annotation];
  FakeSocket.instance.deliver({ type: "annotationUpdated", annotation });
  await settle();
  for (const id of [tab.id, matching.id]) expect(send).toHaveBeenCalledWith(id, { type: "ubbAnnotationsRender", url: tab.url, annotations: [annotation] });
  expect(send.mock.calls.some(([id]) => id === different.id)).toBe(false);
});
