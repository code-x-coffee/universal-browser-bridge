import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { AnnotationStore } from "./annotations.js";

// Exercise the real daemon/bridge and page scripts without local sockets or Chrome.
class Peer extends EventEmitter {
  readyState = 1;
  destroyed = false;
  send(_raw: string) {}
  write(_raw: string) {}
  close() { this.destroy(); }
  destroy() { this.destroyed = true; this.emit("close"); }
}

let directory: string;
let bridge: BrowserBridge;
let daemon: DaemonServer;
let extension: Peer;
let control: Peer;
let commands: any[];
let liveTab: { id: number; url: string; pendingUrl?: string; active: boolean };
let rect: { x: number; y: number; width: number; height: number };
let style: { visibility: string; display: string };
let element: any;
let hit: unknown;
let expired: boolean;
let approved: boolean;
let holdApproval: boolean;
let approvalId: string | undefined;
let onApproval: (() => void) | undefined;
const child = {};
const push = (message: unknown) => extension.emit("message", JSON.stringify(message));
function request(body: Record<string, unknown>): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve) => {
    control.write = (raw) => { const response = JSON.parse(raw); if (response.id === id) resolve(response); };
    control.emit("data", Buffer.from(JSON.stringify({ type: "request", id, tabId: 7, ...body }) + "\n"));
  });
}
const click = (body: Record<string, unknown> = {}) => request({ action: "click", ref: "ubb-3", snapshotId: "7:0", description: "Open details", ...body });
const cdpCommands = () => commands.filter((command) => command.action === "cdp");
const inputCommands = () => cdpCommands().filter((command) => command.method.startsWith("Input."));

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-trusted-input-"));
  commands = []; expired = false; approved = true; holdApproval = false; approvalId = undefined; onApproval = undefined;
  liveTab = { id: 7, url: "https://example.com/", active: true };
  rect = { x: 10, y: 20, width: 100, height: 60 };
  style = { visibility: "visible", display: "block" };
  element = {
    innerText: "Open details", value: "", href: "", formAction: "",
    getAttribute: () => null,
    scrollIntoView: vi.fn(), getBoundingClientRect: () => rect,
    contains: (node: unknown) => node === child,
    click: vi.fn(), focus: vi.fn(), dispatchEvent: vi.fn()
  };
  hit = element;
  bridge = new BrowserBridge("test-token");
  daemon = new DaemonServer(bridge, "test-token", join(directory, "daemon.sock"), new AnnotationStore(join(directory, "annotations")));
  extension = new Peer();
  extension.send = (raw) => {
    const message = JSON.parse(raw);
    if (message.type !== "command") return;
    commands.push(message);
    let result: unknown = {};
    if (message.action === "getTab") result = { ...liveTab };
    if (message.action === "requestApproval") {
      approvalId = message.id;
      onApproval?.();
      if (holdApproval) return;
      result = { approved };
    }
    if (message.method === "Runtime.evaluate") {
      try {
        const value = runInNewContext(message.params.expression, {
          document: {
            querySelector: (selector: string) => {
              expect(selector).toBe('[data-ubb-ref="ubb-3"]');
              return expired ? null : element;
            },
            elementFromPoint: (x: number, y: number) => {
              expect([x, y]).toEqual([rect.x + rect.width / 2, rect.y + rect.height / 2]);
              return hit;
            }
          },
          getComputedStyle: () => style, innerWidth: 800, innerHeight: 600, Event
        });
        result = { result: { value } };
      } catch (cause) {
        result = { exceptionDetails: { exception: { description: (cause as Error).message } } };
      }
    }
    push({ type: "response", id: message.id, result });
  };
  (bridge as any).attachExtension(extension);
  push({ type: "hello", version: 1, token: "test-token", blockedDomains: [] });
  push({ type: "tabs", tabs: [{ ...liveTab }] });
  commands.length = 0;
  control = new Peer();
  (daemon as any).handleConnection(control);
  control.emit("data", Buffer.from(JSON.stringify({ type: "hello", token: "test-token", clientId: randomUUID(), label: "Hephaestus", version: 1 }) + "\n"));
});
afterEach(async () => {
  control.destroy(); extension.destroy();
  await daemon.stop(); await bridge.stop();
  await rm(directory, { recursive: true, force: true });
});

it.each(["element", "descendant"])("scrolls and dispatches trusted mouse input when the center hits the %s", async (target) => {
  hit = target === "element" ? element : child;
  rect.x = -1000;
  element.scrollIntoView.mockImplementation(() => { rect.x = 10; });
  expect(await click()).toMatchObject({ result: { clicked: true, method: "mouse" } });
  expect(element.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "center" });
  expect(inputCommands().map(({ method, params, requiresWritable, tabId, label }) => ({ method, params, requiresWritable, tabId, label }))).toEqual([
    { method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 60, y: 50 }, requiresWritable: true, tabId: 7, label: "Hephaestus" },
    { method: "Input.dispatchMouseEvent", params: { type: "mousePressed", x: 60, y: 50, button: "left", clickCount: 1 }, requiresWritable: true, tabId: 7, label: "Hephaestus" },
    { method: "Input.dispatchMouseEvent", params: { type: "mouseReleased", x: 60, y: 50, button: "left", clickCount: 1 }, requiresWritable: true, tabId: 7, label: "Hephaestus" }
  ]);
  expect(element.click).not.toHaveBeenCalled();
  expect(cdpCommands().filter((command) => command.method === "Runtime.evaluate").every((command) => !command.params.userGesture)).toBe(true);
});

it.each(["zero width", "zero height", "covered", "offscreen", "hidden", "collapsed", "display none"])(
  "falls back to a script click with user activation when the target is %s", async (reason) => {
    if (reason === "zero width") rect.width = 0;
    if (reason === "zero height") rect.height = 0;
    if (reason === "covered") hit = {};
    if (reason === "offscreen") rect.x = 900;
    if (reason === "hidden") style.visibility = "hidden";
    if (reason === "collapsed") style.visibility = "collapse";
    if (reason === "display none") style.display = "none";
    expect(await click()).toMatchObject({ result: { clicked: true, method: "script" } });
    expect(inputCommands()).toEqual([]);
    expect(element.click).toHaveBeenCalledOnce();
    expect(cdpCommands().at(-1)).toMatchObject({ method: "Runtime.evaluate", requiresWritable: true, params: { userGesture: true } });
  }
);

it("grants user activation to the input focus/value path", async () => {
  expect(await request({ action: "type", ref: "ubb-3", snapshotId: "7:0", text: "hello" })).toMatchObject({ result: true });
  expect(element.value).toBe("hello");
  expect(element.focus).toHaveBeenCalledOnce();
  expect(cdpCommands()).toEqual([expect.objectContaining({ requiresWritable: true, params: expect.objectContaining({ userGesture: true }) })]);
});

it("rejects an expired ref without dispatching input", async () => {
  expired = true;
  expect((await click()).error).toContain("Element ref expired");
  expect(inputCommands()).toEqual([]);
  expect(element.click).not.toHaveBeenCalled();
});

it("rejects stale snapshots after navigation before resolving or clicking", async () => {
  await request({ action: "navigate", url: "https://example.com/next" });
  commands.length = 0;
  expect((await click()).error).toContain("Stale snapshot");
  expect(cdpCommands()).toEqual([]);
});

it.each(["url", "pendingUrl"] as const)("rejects read-only live %s before click, type or key input", async (field) => {
  liveTab[field] = "https://hdfcbank.com/";
  for (const action of ["click", "type", "press"]) {
    expect((await request({ action, ref: "ubb-3", snapshotId: "7:0", description: "Open details", key: "ArrowDown", text: "hello" })).error).toContain("read-only");
  }
  expect(cdpCommands()).toEqual([]);
});

it.each(["url", "pendingUrl"] as const)("rejects blocked live %s before any input", async (field) => {
  push({ type: "sitePolicy", blockedDomains: ["blocked.org"] });
  liveTab[field] = "https://blocked.org/";
  expect((await click()).error).toContain("blocked by your blocklist");
  expect(cdpCommands()).toEqual([]);
});

it.each([true, false])("waits for consequential approval before any scroll or input (approved: %s)", async (decision) => {
  element.innerText = "Submit order";
  holdApproval = true;
  const response = click();
  await vi.waitFor(() => expect(approvalId).toBeDefined());
  expect(commands.find((command) => command.action === "requestApproval")).toMatchObject({ label: "Hephaestus", description: expect.stringContaining("[Hephaestus] Allow click:") });
  expect(inputCommands()).toEqual([]);
  expect(element.click).not.toHaveBeenCalled();
  expect(element.scrollIntoView).not.toHaveBeenCalled();
  push({ type: "response", id: approvalId, result: { approved: decision } });
  const result = await response;
  if (decision) {
    expect(result).toMatchObject({ result: { clicked: true, method: "mouse" } });
    expect(inputCommands()).toHaveLength(3);
  } else {
    expect(result.error).toContain("User denied");
    expect(inputCommands()).toEqual([]);
    expect(element.click).not.toHaveBeenCalled();
    expect(element.scrollIntoView).not.toHaveBeenCalled();
  }
});

it.each(["read-only", "blocked"])("rechecks %s policy after consequential approval", async (policy) => {
  element.innerText = "Submit order";
  onApproval = () => {
    if (policy === "read-only") liveTab.pendingUrl = "https://passwords.google.com/";
    else push({ type: "sitePolicy", blockedDomains: ["example.com"] });
  };
  expect((await click()).error).toContain(policy === "read-only" ? "read-only" : "blocked by your blocklist");
  expect(inputCommands()).toEqual([]);
  expect(element.click).not.toHaveBeenCalled();
  expect(element.scrollIntoView).not.toHaveBeenCalled();
});

it.each(["mouse", "script"])("rechecks writable policy before %s input after resolving the target", async (method) => {
  if (method === "script") hit = {};
  element.scrollIntoView.mockImplementation(() => { liveTab.pendingUrl = "https://passwords.google.com/"; });
  expect((await click()).error).toContain("read-only");
  expect(inputCommands()).toEqual([]);
  expect(element.click).not.toHaveBeenCalled();
});

it("keeps ordinary key presses on trusted CDP input without approval", async () => {
  expect(await request({ action: "press", key: "ArrowDown" })).toMatchObject({ result: { pressed: "ArrowDown" } });
  expect(inputCommands().map(({ method, params, requiresWritable }) => ({ method, params, requiresWritable }))).toEqual([
    { method: "Input.dispatchKeyEvent", params: { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, requiresWritable: true },
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 }, requiresWritable: true }
  ]);
  expect(commands.some((command) => command.action === "requestApproval")).toBe(false);
});

it.each(["Enter", "NumpadEnter"])("requires approval for %s and sends no input on denial", async (key) => {
  approved = false;
  expect((await request({ action: "press", key })).error).toContain("User denied");
  expect(inputCommands()).toEqual([]);
  approved = true;
  expect(await request({ action: "press", key })).toMatchObject({ result: { pressed: key } });
  expect(commands.filter((command) => command.action === "requestApproval")).toHaveLength(2);
  expect(inputCommands().map(({ method, params, requiresWritable }) => ({ method, params, requiresWritable }))).toEqual([
    { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key, code: key, windowsVirtualKeyCode: 13, text: "\r" }, requiresWritable: true },
    { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key, code: key, windowsVirtualKeyCode: 13, text: "\r" }, requiresWritable: true }
  ]);
});
