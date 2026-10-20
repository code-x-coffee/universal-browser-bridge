import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BrowserBridge } from "./bridge.js";

class Peer extends EventEmitter {
  readyState = 1;
  closed = false;
  send(_raw: string) {}
  close() { this.closed = true; this.emit("close"); }
  push(message: unknown) { this.emit("message", JSON.stringify(message)); }
}
let bridge: BrowserBridge;
let peers: Peer[];
function connect(policy: Record<string, unknown> = {}) {
  const peer = new Peer();
  peers.push(peer);
  (bridge as any).attachExtension(peer);
  peer.push({ type: "hello", version: 1, token: "test-token", ...policy });
  return peer;
}
beforeEach(() => { bridge = new BrowserBridge("test-token"); peers = []; });
afterEach(async () => { for (const peer of peers) peer.close(); await bridge.stop(); });

it("normalizes upload folders from hello and sitePolicy, ignoring bad entries", () => {
  const peer = connect({ uploadFolders: [" /tmp/images ", "relative", "/x/../y", 12] });
  expect(bridge.uploadFolders).toEqual(["/tmp/images/"]);
  peer.push({ type: "sitePolicy", blockedDomains: [], uploadFolders: ["/new/", "/new", "/a\0b"] });
  expect(bridge.uploadFolders).toEqual(["/new/"]);
  expect(peer.closed).toBe(false);
});

it("disables uploads for old extensions and malformed or missing policy", () => {
  const peer = connect();
  expect(bridge.uploadFolders).toEqual([]);
  peer.push({ type: "sitePolicy", blockedDomains: [], uploadFolders: ["/new/"] });
  peer.push({ type: "sitePolicy", blockedDomains: [], uploadFolders: "bad" });
  expect(bridge.uploadFolders).toEqual([]);
  peer.push({ type: "sitePolicy", blockedDomains: [] });
  expect(bridge.uploadFolders).toEqual([]);
  expect(peer.closed).toBe(false);
});

it("ignores unauthenticated and replaced peers and resets on disconnect", () => {
  const old = connect({ uploadFolders: ["/old/"] });
  const current = connect({ uploadFolders: ["/current/"] });
  old.push({ type: "sitePolicy", blockedDomains: [], uploadFolders: ["/attack/"] });
  const attacker = new Peer();
  (bridge as any).attachExtension(attacker);
  attacker.push({ type: "sitePolicy", blockedDomains: [], uploadFolders: ["/attack/"] });
  expect(bridge.uploadFolders).toEqual(["/current/"]);
  expect(attacker.closed).toBe(true);
  current.close();
  expect(bridge.uploadFolders).toEqual([]);
});
