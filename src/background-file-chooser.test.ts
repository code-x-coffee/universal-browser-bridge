import { createContext, runInContext } from "node:vm";
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
    const message = JSON.parse(raw);
    this.messages.push(message);
    if (message.type === "hello") setTimeout(() => this.deliver({ type: "ready" }), 0);
    if (message.type === "annotationsList") setTimeout(() => this.deliver({ type: "annotationsResponse", id: message.id, result: [] }), 0);
  }
  close() { this.readyState = 3; }
}

let mock: ReturnType<typeof createChromeMock>;
let tabId: number;
let sequence = 0;
let pageWindow: any;
let originalPicker: ReturnType<typeof vi.fn>;
let inputs: any[];
let pickerPromise: Promise<any[]> | undefined;
let pickerKind: "input" | "showOpenFilePicker";
let emitChooser: boolean;
let chooserMode: string;
let failMethod: string | undefined;
let changeDelayMs: number;
let send: ReturnType<typeof vi.spyOn>;
const files = ["/Volumes/NVme/Projects/Stories/ref.png"];
const selectedFile = { name: "ref.png" };
async function settle(ms = 600) { await vi.advanceTimersByTimeAsync(ms); }
function deliver(body: Record<string, unknown>) {
  const id = `chooser-${++sequence}`;
  FakeSocket.instance.deliver({ type: "command", id, ...body });
  return id;
}
async function command(body: Record<string, unknown>) {
  const id = deliver(body);
  await settle();
  const response = FakeSocket.instance.messages.find((message) => message.type === "response" && message.id === id);
  expect(response).toBeDefined();
  return response;
}
const chooser = (body: Record<string, unknown> = {}) => command({ action: "uploadViaFileChooser", tabId, label: "Hephaestus", files, x: 60, y: 50, ...body });
function fireChooser(id = tabId, backendNodeId = 42) {
  if (emitChooser) for (const listener of [...mock.debuggerOnEvent]) listener({ tabId: id }, "Page.fileChooserOpened", { mode: chooserMode, backendNodeId, frameId: "main" });
}
function openPicker() {
  if (pickerKind === "input") fireChooser();
  else {
    pickerPromise = pageWindow.showOpenFilePicker({ multiple: true, types: [{ accept: { "image/png": [".png"] } }] });
    // Cancellation on failure is observable by the page, without an unhandled rejection in the test.
    pickerPromise!.catch(() => {});
  }
}
function expectCleanedUp() {
  expect(send).toHaveBeenCalledWith({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: false });
  expect(pageWindow.showOpenFilePicker).toBe(originalPicker);
  expect(mock.debuggerOnEvent).toEqual([]);
  expect(inputs.every((input) => input.remove.mock.calls.length > 0)).toBe(true);
}

beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  mock = createChromeMock();
  vi.stubGlobal("chrome", mock.chrome); vi.stubGlobal("WebSocket", FakeSocket);
  const win = await mock.chrome.windows.create({ url: "about:blank", focused: false });
  await mock.chrome.storage.session.set({ agentWindowId: win.id });
  await mock.chrome.storage.local.set({ token: "test-token" });
  // @ts-expect-error Plain extension script, imported for its side effects.
  await import("../extension/background.js");
  await settle();
  tabId = (await command({ action: "createTab", label: "Hephaestus", url: "https://example.com/" })).result.id;
  inputs = []; pickerPromise = undefined; pickerKind = "input"; emitChooser = true; chooserMode = "selectMultiple"; failMethod = undefined; changeDelayMs = 0;
  originalPicker = vi.fn(); pageWindow = { showOpenFilePicker: originalPicker };
  const context = createContext({
    window: pageWindow, setTimeout, clearTimeout, DOMException,
    document: {
      body: { appendChild: () => {} }, documentElement: { appendChild: () => {} },
      querySelector: () => ({ click: openPicker }),
      createElement: () => {
        const listeners = new Map<string, () => void>();
        const input = { files: [], remove: vi.fn(), addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
          click: () => fireChooser(), change: () => listeners.get("change")?.() };
        inputs.push(input);
        return input;
      }
    }
  });
  send = vi.spyOn(mock.chrome.debugger, "sendCommand").mockImplementation(async (_target: unknown, method: string, params: any) => {
    if (method === failMethod) throw new Error(`Failed ${method}`);
    if (method === "Runtime.evaluate") {
      try {
        const value = runInContext(params.expression, context);
        return value?.then && !params.awaitPromise ? { result: { type: "object", subtype: "promise", objectId: "pending" } }
          : { result: { value: params.awaitPromise ? await value : value } };
      }
      catch (error) { return { exceptionDetails: { text: (error as Error).message } }; }
    }
    if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") openPicker();
    if (method === "DOM.setFileInputFiles" && inputs.length) {
      const input = inputs.at(-1);
      const change = () => { input.files = [selectedFile]; input.change(); };
      if (changeDelayMs) setTimeout(change, changeDelayMs);
      else change();
    }
    return {};
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("attaches files using the chooser backendNodeId and always disables interception", async () => {
  expect(await chooser()).toMatchObject({ result: { uploaded: 1, files, method: "chooser", picker: "input" } });
  expect(send).toHaveBeenCalledWith({ tabId }, "Page.enable", {});
  expect(send).toHaveBeenCalledWith({ tabId }, "Page.setInterceptFileChooserDialog", { enabled: true });
  expect(send).toHaveBeenCalledWith({ tabId }, "DOM.setFileInputFiles", { files, backendNodeId: 42 });
  expect(send.mock.calls.filter((call: any[]) => call[1] === "Input.dispatchMouseEvent").map((call: any[]) => call[2])).toEqual([
    { type: "mouseMoved", x: 60, y: 50 },
    { type: "mousePressed", x: 60, y: 50, button: "left", clickCount: 1 },
    { type: "mouseReleased", x: 60, y: 50, button: "left", clickCount: 1 }
  ]);
  expectCleanedUp();
});

it("shims showOpenFilePicker, preserves options, resolves file handles and restores the original", async () => {
  pickerKind = "showOpenFilePicker";
  expect((await chooser()).result.picker).toBe("showOpenFilePicker");
  expect(inputs[0]).toMatchObject({ type: "file", hidden: true, multiple: true, accept: "image/png,.png" });
  const [handle] = await pickerPromise!;
  expect(handle).toMatchObject({ kind: "file", name: "ref.png" });
  expect(await handle.getFile()).toBe(selectedFile);
  expect(await handle.queryPermission()).toBe("granted");
  expect(await handle.requestPermission()).toBe("granted");
  expect(await handle.isSameEntry(handle)).toBe(true);
  expect(await handle.isSameEntry({})).toBe(false);
  expectCleanedUp();
});

it("waits for a delayed change event before restoring the picker shim", async () => {
  pickerKind = "showOpenFilePicker"; changeDelayMs = 50;
  expect((await chooser()).error).toBeUndefined();
  await expect(pickerPromise).resolves.toHaveLength(1);
  expectCleanedUp();
});

it("uses a user-activated script click for A's non-hit-testable target fallback", async () => {
  expect((await chooser({ x: undefined, y: undefined, ref: "ubb-3" })).error).toBeUndefined();
  expect(send.mock.calls.filter((call: any[]) => call[1] === "Input.dispatchMouseEvent")).toEqual([]);
  expect(send.mock.calls.some((call: any[]) => call[1] === "Runtime.evaluate" && call[2].userGesture === true)).toBe(true);
  expectCleanedUp();
});

it.each(["DOM.setFileInputFiles", "Page.enable", "Page.setInterceptFileChooserDialog", "Input.dispatchMouseEvent"])("restores the shim and interception on %s failure", async (method) => {
  failMethod = method;
  expect((await chooser()).error).toContain(`Failed ${method}`);
  expectCleanedUp();
});

it("restores a missing native picker by removing the temporary property", async () => {
  delete pageWindow.showOpenFilePicker;
  expect((await chooser()).error).toBeUndefined();
  expect(Object.hasOwn(pageWindow, "showOpenFilePicker")).toBe(false);
});

it("uses the 10 s page safety timer when the restore command fails", async () => {
  const implementation = send.getMockImplementation()!;
  send.mockImplementation(async (target: unknown, method: string, params: any) => {
    if (method === "Runtime.evaluate" && params.expression === "window.__ubbRestoreFilePicker?.()") throw new Error("Restore connection lost");
    return implementation(target, method, params);
  });
  expect((await chooser()).error).toContain("cleanup failed");
  expect(pageWindow.showOpenFilePicker).not.toBe(originalPicker);
  await settle(10000);
  expect(pageWindow.showOpenFilePicker).toBe(originalPicker);
});

it("still restores the shim when disabling interception fails after attachment", async () => {
  const implementation = send.getMockImplementation()!;
  send.mockImplementation(async (target: unknown, method: string, params: any) => {
    if (method === "Page.setInterceptFileChooserDialog" && !params.enabled) throw new Error("Disable failed");
    return implementation(target, method, params);
  });
  expect((await chooser()).error).toContain("cleanup failed: Disable failed");
  expect(pageWindow.showOpenFilePicker).toBe(originalPicker);
  expect(mock.debuggerOnEvent).toEqual([]);
});

it("rejects multiple files in selectSingle mode and cleans up", async () => {
  chooserMode = "selectSingle";
  expect((await chooser({ files: [...files, "/Volumes/NVme/Projects/Stories/second.png"] })).error).toMatch(/single|multiple/i);
  expect(send.mock.calls.some((call: any[]) => call[1] === "DOM.setFileInputFiles")).toBe(false);
  expectCleanedUp();
});

it.each(["input", "showOpenFilePicker"] as const)("reports a 5 s timeout with %s diagnostics and cleans up", async (kind) => {
  pickerKind = kind; emitChooser = false;
  const id = deliver({ action: "uploadViaFileChooser", tabId, label: "Hephaestus", files, x: 60, y: 50 });
  await settle(5200);
  const response = FakeSocket.instance.messages.find((message) => message.id === id);
  expect(response?.error).toContain("No file chooser opened within 5 s");
  expect(response.error).toContain(kind === "input" ? "showOpenFilePicker shim not triggered / none detected" : "page used: showOpenFilePicker");
  expectCleanedUp();
});

it("adds the file-scheme hint if permission is turned off during the chooser wait", async () => {
  emitChooser = false;
  const id = deliver({ action: "uploadViaFileChooser", tabId, label: "Hephaestus", files, x: 60, y: 50 });
  await settle();
  Object.assign(mock.chrome, { extension: { isAllowedFileSchemeAccess: async () => false } });
  await settle(5000);
  const response = FakeSocket.instance.messages.find((message) => message.id === id);
  expect(response.error).toContain("No file chooser opened within 5 s");
  expect(response.error).toContain("Allow access to file URLs");
  expectCleanedUp();
});

it("rejects choosers without a usable backendNodeId without attaching files", async () => {
  emitChooser = false;
  const id = deliver({ action: "uploadViaFileChooser", tabId, label: "Hephaestus", files, x: 60, y: 50 });
  await settle();
  emitChooser = true; fireChooser(tabId, 0); await settle();
  expect(FakeSocket.instance.messages.find((message) => message.id === id).error).toContain("backendNodeId");
  expect(send.mock.calls.some((call: any[]) => call[1] === "DOM.setFileInputFiles")).toBe(false);
  expectCleanedUp();
});

it("rejects concurrent chooser commands for the same tab without disrupting the first", async () => {
  emitChooser = false;
  const id = deliver({ action: "uploadViaFileChooser", tabId, label: "Hephaestus", files, x: 60, y: 50 });
  await settle();
  expect((await chooser()).error).toContain("already active");
  expect(mock.debuggerOnEvent).toHaveLength(1);
  expect(pageWindow.showOpenFilePicker).not.toBe(originalPicker);
  emitChooser = true; fireChooser(); await settle();
  expect(FakeSocket.instance.messages.find((message) => message.id === id).result.uploaded).toBe(1);
  expectCleanedUp();
});

it("ignores events from other tabs and rechecks read-only policy before attaching", async () => {
  emitChooser = false;
  const id = deliver({ action: "uploadViaFileChooser", tabId, label: "Hephaestus", files, x: 60, y: 50 });
  await settle();
  emitChooser = true;
  fireChooser(tabId + 1);
  await settle();
  expect(send.mock.calls.some((call: any[]) => call[1] === "DOM.setFileInputFiles")).toBe(false);
  mock.tabsById.get(tabId)!.pendingUrl = "https://hdfcbank.com/";
  fireChooser(); await settle();
  expect(FakeSocket.instance.messages.find((message) => message.id === id).error).toContain("read-only");
  expect(send.mock.calls.some((call: any[]) => call[1] === "DOM.setFileInputFiles")).toBe(false);
  expectCleanedUp();
});

it.each(["unowned", "wrong label", "no label", "outside folder", "read-only", "blocked", "file scheme"])(
  "rejects direct chooser commands for %s before CDP", async (reason) => {
    const options: Record<string, unknown> = {};
    if (reason === "unowned") options.tabId = (await command({ action: "createTab", url: "https://example.com/" })).result.id;
    if (reason === "wrong label") options.label = "Hermes";
    if (reason === "no label") options.label = undefined;
    if (reason === "outside folder") options.files = ["/etc/passwd"];
    if (reason === "read-only") mock.tabsById.get(tabId)!.pendingUrl = "https://hdfcbank.com/";
    if (reason === "blocked") await mock.chrome.storage.local.set({ blockedDomains: ["example.com"] });
    if (reason === "file scheme") Object.assign(mock.chrome, { extension: { isAllowedFileSchemeAccess: async () => false } });
    send.mockClear();
    expect((await chooser(options)).error).toBeDefined();
    expect(send).not.toHaveBeenCalled();
    expect(mock.debuggerOnEvent).toEqual([]);
  }
);
