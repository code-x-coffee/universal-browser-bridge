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

it("syncs download folders separately from uploads and fails closed on missing or malformed policy", () => {
  const peer = connect({ uploadFolders: ["/uploads/"], downloadFolders: [" /media ", "/media/", "relative"] });
  expect(bridge.downloadFolders).toEqual(["/media/"]);
  expect(bridge.uploadFolders).toEqual(["/uploads/"]);
  peer.push({ type: "sitePolicy", blockedDomains: [], uploadFolders: ["/uploads/"], downloadFolders: ["/new/"] });
  expect(bridge.downloadFolders).toEqual(["/new/"]);
  peer.push({ type: "sitePolicy", blockedDomains: [], downloadFolders: "bad" });
  expect(bridge.downloadFolders).toEqual([]);
  peer.push({ type: "sitePolicy", blockedDomains: [], downloadFolders: ["/new/"] });
  peer.push({ type: "sitePolicy", blockedDomains: [] });
  expect(bridge.downloadFolders).toEqual([]);
  peer.close();
  expect(bridge.downloadFolders).toEqual([]);
});

it("syncs exact and wildcard trusted download hosts through hello/sitePolicy, failing closed and ignoring replaced peers", () => {
  const old = connect({ trustedDownloadHosts: ["OLD.example.", "*.example"] });
  expect(bridge.trustedDownloadHosts).toEqual(["old.example"]);
  const current = connect({ trustedDownloadHosts: [" CDN.Example. ", "cdn.example", "*.googlevideo.com", "https://invalid"] });
  old.push({ type: "sitePolicy", blockedDomains: [], trustedDownloadHosts: ["attack.example"] });
  expect(bridge.trustedDownloadHosts).toEqual(["cdn.example", "*.googlevideo.com"]);
  current.push({ type: "sitePolicy", blockedDomains: [], trustedDownloadHosts: ["new.example", "*.googlevideo.com"] });
  expect(bridge.trustedDownloadHosts).toEqual(["new.example", "*.googlevideo.com"]);
  current.push({ type: "sitePolicy", blockedDomains: [] });
  expect(bridge.trustedDownloadHosts).toEqual([]);
  current.push({ type: "sitePolicy", blockedDomains: [], trustedDownloadHosts: "bad" });
  expect(bridge.trustedDownloadHosts).toEqual([]);
  current.close();
  expect(bridge.trustedDownloadHosts).toEqual([]);
});
