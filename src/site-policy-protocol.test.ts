import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { AnnotationStore } from "./annotations.js";

// Real authenticated protocol handlers with in-memory socket boundaries.
// This extension peer deliberately does not enforce the blocklist, so a
// refusal here proves the daemon independently enforces its copy of policy.
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
let liveTab: { id: number; url: string; pendingUrl?: string; title: string; active: boolean };
function push(message: unknown) { extension.emit("message", JSON.stringify(message)); }
function request(body: Record<string, unknown>): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve) => {
    control.write = (raw) => {
      const message = JSON.parse(raw);
      if (message.id === id) resolve(message);
    };
    control.emit("data", Buffer.from(JSON.stringify({ type: "request", id, ...body }) + "\n"));
  });
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-site-policy-"));
  bridge = new BrowserBridge("test-token");
  daemon = new DaemonServer(bridge, "test-token", join(directory, "daemon.sock"), new AnnotationStore(join(directory, "annotations")));
  commands = [];
  liveTab = { id: 7, url: "https://example.com/", title: "Example", active: true };
  extension = new Peer();
  extension.send = (raw) => {
    const message = JSON.parse(raw);
    if (message.type !== "command") return;
    commands.push(message);
    let result: unknown = {};
    if (message.action === "getTab") result = { ...liveTab };
    if (message.action === "createTab") result = { ...liveTab, url: message.url };
    if (message.action === "requestApproval") result = { approved: true };
    if (message.action === "listTabs") result = [{ ...liveTab }];
    if (message.action === "listAgentTabs") result = [{ tabId: liveTab.id, url: liveTab.url, title: liveTab.title, groupId: 1 }];
    if (message.action === "cdp") result = message.method === "Page.captureScreenshot" ? { data: "cG5n" } : { result: { value: { text: "Open details" } } };
    push({ type: "response", id: message.id, result });
  };
  (bridge as any).attachExtension(extension);
  push({ type: "hello", token: "test-token", version: 1, blockedDomains: ["https://WWW.Blocked.org/path"] });
  push({ type: "tabs", tabs: [{ ...liveTab }] });
  commands.length = 0;
  control = new Peer();
  (daemon as any).handleConnection(control);
  control.emit("data", Buffer.from(JSON.stringify({ type: "hello", token: "test-token", clientId: "client-1", label: "Hephaestus", version: 1 }) + "\n"));
});
afterEach(async () => {
  control.destroy(); extension.destroy();
  await daemon.stop(); await bridge.stop();
  await rm(directory, { recursive: true, force: true });
});

it("refuses a blocked new tab using the policy from the authenticated extension handshake", async () => {
  expect((await request({ action: "createTab", url: "https://login.blocked.org/" })).error).toContain("blocked by your blocklist");
  expect(commands).toEqual([]);
});

it("updates the daemon blocklist when the extension pushes a change", async () => {
  push({ type: "sitePolicy", blockedDomains: ["WWW.Example.com/path"] });
  expect((await request({ action: "createTab", url: "https://example.com/" })).error).toContain("blocked by your blocklist");
  expect(commands).toEqual([]);
  push({ type: "sitePolicy", blockedDomains: [] });
  expect((await request({ action: "createTab", url: "https://example.com/" })).error).toBeUndefined();
});

it.each(["snapshot", "screenshot", "scroll", "click", "type", "press", "navigate"])(
  "refuses %s on a hand-shared tab blocked in the daemon's cached state before dispatch", async (action) => {
    push({ type: "sitePolicy", blockedDomains: ["example.com"] });
    const response = await request({ action, tabId: 7, snapshotId: "7:0", ref: "ubb-0", text: "hello", key: "ArrowDown", url: "https://allowed.org/" });
    expect(response.error).toContain("blocked by your blocklist");
    expect(commands).toEqual([]);
  }
);

it.each(["url", "pendingUrl"] as const)("refuses reads and writes after a blocked live %s that has not been broadcast", async (field) => {
  liveTab[field] = "https://private.blocked.org/";
  for (const action of ["snapshot", "screenshot", "scroll", "click", "type", "press", "navigate"]) {
    const response = await request({ action, tabId: 7, snapshotId: "7:0", ref: "ubb-0", text: "hello", key: "ArrowDown", url: "https://allowed.org/" });
    expect(response.error).toContain("blocked by your blocklist");
  }
  expect(commands.every((command) => command.action === "getTab")).toBe(true);
  expect(commands).toHaveLength(7);
});

it("refuses a blocked navigation destination before dispatching", async () => {
  expect((await request({ action: "navigate", tabId: 7, url: "https://private.blocked.org/" })).error).toContain("blocked by your blocklist");
  expect(commands).toEqual([]);
});

it("hides blocked tabs in daemon status and extension list responses", async () => {
  push({ type: "sitePolicy", blockedDomains: ["example.com"] });
  expect((await request({ action: "status" })).result.tabs).toEqual([]);
  expect((await request({ action: "listTabs" })).result).toEqual([]);
  expect((await request({ action: "listAgentTabs" })).result).toEqual([]);
});

it("rechecks updated policy after a live tab lookup before dispatching CDP", async () => {
  const send = extension.send.bind(extension);
  extension.send = (raw) => {
    if (JSON.parse(raw).action === "getTab") push({ type: "sitePolicy", blockedDomains: ["example.com"] });
    send(raw);
  };
  expect((await request({ action: "snapshot", tabId: 7 })).error).toContain("blocked by your blocklist");
  expect(commands.map((command) => command.action)).toEqual(["getTab"]);
});

it("ignores blocklist changes from unauthenticated and replaced extension peers", async () => {
  const attacker = new Peer();
  (bridge as any).attachExtension(attacker);
  attacker.emit("message", JSON.stringify({ type: "sitePolicy", blockedDomains: [] }));
  expect(attacker.destroyed).toBe(true);
  const replacement = new Peer();
  (bridge as any).attachExtension(replacement);
  replacement.emit("message", JSON.stringify({ type: "hello", token: "test-token", version: 1, blockedDomains: ["blocked.org"] }));
  push({ type: "sitePolicy", blockedDomains: [] });
  expect((await request({ action: "createTab", url: "https://blocked.org/" })).error).toContain("blocked by your blocklist");
  replacement.destroy();
});
