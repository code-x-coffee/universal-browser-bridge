import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./test-support/chrome-mock.js";

class FakeSocket {
  static OPEN = 1;
  static instance: FakeSocket;
  readyState = 1;
  messages: any[] = [];
  listeners = new Map<string, (event?: any) => void>();
  constructor(_url: string) { FakeSocket.instance = this; setTimeout(() => this.listeners.get("open")?.(), 0); }
  addEventListener(type: string, listener: (event?: any) => void) { this.listeners.set(type, listener); }
  deliver(message: unknown) { this.listeners.get("message")?.({ data: JSON.stringify(message) }); }
  send(raw: string) {
    const message = JSON.parse(raw); this.messages.push(message);
    if (message.type === "hello") setTimeout(() => this.deliver({ type: "ready" }), 0);
    if (message.type === "annotationsList") setTimeout(() => this.deliver({ type: "annotationsResponse", id: message.id, result: [] }), 0);
  }
  close() { this.readyState = 3; this.listeners.get("close")?.(); }
}
let mock: ReturnType<typeof createChromeMock>;
let tabId: number;
let sequence = 0;
let send: any;
let emitResponse: boolean;
const settle = (ms = 600) => vi.advanceTimersByTimeAsync(ms);
const deliver = (body: Record<string, unknown>) => {
  const id = `download-${++sequence}`; FakeSocket.instance.deliver({ type: "command", id, ...body }); return id;
};
async function command(body: Record<string, unknown>) {
  const id = deliver(body); await settle();
  const response = FakeSocket.instance.messages.find((m: any) => m.type === "response" && m.id === id);
  expect(response).toBeDefined(); return response;
}
const download = (extra = {}) => command({ action: "downloadStart", tabId, label: "Agent", downloadKey: "key", downloadFolder: "/tmp/",
  url: "https://cdn.example/private?token=secret", description: "Save clip", ...extra });
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  mock = createChromeMock(); vi.stubGlobal("chrome", mock.chrome); vi.stubGlobal("WebSocket", FakeSocket);
  await mock.chrome.storage.local.set({ token: "test-token", trustedDownloadHosts: [" CDN.Example. "], downloadFolders: ["/tmp/"] });
  // @ts-expect-error Plain extension script imported for side effects.
  await import("../extension/background.js"); await settle();
  tabId = (await command({ action: "createTab", label: "Agent", url: "https://flow.google.com/" })).result.id;
  emitResponse = true;
  send = vi.spyOn(mock.chrome.debugger, "sendCommand").mockImplementation(async (_target: any, method: string, params: any) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 123 };
    if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream" };
    if (method === "IO.read") return { data: "YQ==", base64Encoded: true, eof: true };
    if (method === "Runtime.evaluate" && params.expression.includes("fetch(") && emitResponse) {
      for (const listener of [...mock.debuggerOnEvent]) listener({ tabId }, "Network.requestWillBeSent", { requestId: "network", request: { url: "https://cdn.example/private?token=secret" }, initiator: { stack: { callFrames: [{ url: "ubb-download-key" }] } } });
      for (const listener of [...mock.debuggerOnEvent]) listener({ tabId }, "Fetch.requestPaused", { requestId: "r1", networkId: "network", request: { url: "https://cdn.example/private?token=secret" }, responseStatusCode: 200 });
    }
    if (method === "Runtime.evaluate") return { result: { value: true } };
    return {};
  });
});
afterEach(async () => {
  // @ts-expect-error Plain extension script.
  const { cancelNetworkDownloads } = await import("../extension/network-download.js");
  await cancelNetworkDownloads(undefined, true); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it("sends normalized trusted hosts in hello, sitePolicy and immediately on storage changes", async () => {
  expect(FakeSocket.instance.messages.find(m => m.type === "hello")).toMatchObject({ trustedDownloadHosts: ["cdn.example"] });
  expect(FakeSocket.instance.messages.find(m => m.type === "sitePolicy")).toMatchObject({ trustedDownloadHosts: ["cdn.example"] });
  await mock.chrome.storage.local.set({ trustedDownloadHosts: [] }); await settle();
  expect(FakeSocket.instance.messages.filter(m => m.type === "sitePolicy").at(-1)).toMatchObject({ trustedDownloadHosts: [] });
});
it("enforces its own host storage even when the daemon supplies a trusted list", async () => {
  await mock.chrome.storage.local.set({ trustedDownloadHosts: [] });
  const result = await download({ trustedDownloadHosts: ["cdn.example"] });
  expect(result.error).toBe('Download host cdn.example is not a trusted download host; add it under "Trusted download hosts" in Extension options');
  expect(send).not.toHaveBeenCalled();
});
it.each(["owner", "description", "blocked", "readonly", "disabled", "folder"])("enforces %s before enabling network interception", async reason => {
  const extra: any = {};
  if (reason === "owner") extra.label = "Other";
  if (reason === "description") extra.description = "";
  if (reason === "blocked") await mock.chrome.storage.local.set({ blockedDomains: ["flow.google.com"] });
  if (reason === "readonly") mock.tabsById.get(tabId)!.pendingUrl = "https://hdfcbank.com/";
  if (reason === "disabled") await mock.chrome.storage.local.set({ downloadFolders: [] });
  if (reason === "folder") extra.downloadFolder = "/other/";
  expect((await download(extra)).error).toBeDefined();
  expect(send.mock.calls.some((c: any) => c[1] === "Fetch.enable")).toBe(false);
});
it("cancels and cleans up on policy revocation, navigation and daemon disconnection", async () => {
  expect((await download()).error).toBeUndefined();
  await mock.chrome.storage.local.set({ trustedDownloadHosts: [] });
  expect((await command({ action: "downloadRead", tabId, label: "Agent", downloadKey: "key" })).error).toContain("not a trusted");
  expect(send.mock.calls.some((c: any) => c[1] === "IO.close")).toBe(true);
  await mock.chrome.storage.local.set({ trustedDownloadHosts: ["cdn.example"] });
  expect((await download()).error).toBeUndefined();
  for (const listener of mock.tabsOnUpdated) listener(tabId, { status: "loading" }, mock.tabsById.get(tabId)!);
  await settle();
  expect(mock.debuggerOnEvent).toEqual([]);
  expect((await download()).error).toBeUndefined();
  FakeSocket.instance.close(); await settle(100);
  expect(mock.debuggerOnEvent).toEqual([]);
});
