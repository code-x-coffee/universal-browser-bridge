import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { AnnotationStore } from "./annotations.js";
import { annotationDraft, annotationScreenshot } from "./test-support/annotation-fixture.js";

// Socket API boundaries only. Real-socket integration lives in daemon.test.ts;
// these also exercise authentication/dispatch in restricted test environments.
class Peer extends EventEmitter {
  readyState = 1;
  destroyed = false;
  messages: any[] = [];
  send(raw: string) { this.messages.push(JSON.parse(raw)); }
  write(raw: string) { this.send(raw); }
  close() { this.destroy(); }
  destroy() { this.destroyed = true; this.emit("close"); }
}
let directory: string;
let bridge: BrowserBridge;
let daemon: DaemonServer;
let extension: Peer;
const controlPeers: Peer[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-annotation-protocol-"));
  bridge = new BrowserBridge("test-token");
  daemon = new DaemonServer(bridge, "test-token", join(directory, "daemon.sock"), new AnnotationStore(join(directory, "annotations")));
  extension = new Peer();
  // Drive the actual connection handlers through a stand-in for the ws/net
  // boundary rather than replacing their authenticated protocol logic.
  (bridge as any).attachExtension(extension);
  extension.emit("message", JSON.stringify({ type: "hello", token: "test-token", version: 1 }));
  extension.emit("message", JSON.stringify({ type: "tabs", tabs: [{ id: 1, url: annotationDraft.url, title: "Example", active: true }] }));
});
afterEach(async () => {
  extension.destroy();
  for (const peer of controlPeers.splice(0)) peer.destroy();
  await daemon.stop();
  await rm(directory, { recursive: true, force: true });
});
function control(token = "test-token") {
  const peer = new Peer();
  controlPeers.push(peer);
  (daemon as any).handleConnection(peer);
  peer.emit("data", Buffer.from(JSON.stringify({ type: "hello", token, clientId: randomUUID(), version: 1 }) + "\n"));
  return peer;
}
async function extensionRequest(body: Record<string, unknown>) {
  const id = randomUUID();
  extension.emit("message", JSON.stringify({ ...body, id }));
  await vi.waitFor(() => expect(extension.messages.some((message) => message.type === "annotationsResponse" && message.id === id)).toBe(true));
  return extension.messages.find((message) => message.id === id);
}
async function request(peer: Peer, body: Record<string, unknown>) {
  const id = randomUUID();
  peer.emit("data", Buffer.from(JSON.stringify({ type: "request", ...body, id }) + "\n"));
  await vi.waitFor(() => expect(peer.messages.some((message) => message.id === id)).toBe(true));
  return peer.messages.find((message) => message.id === id);
}

it("handles extension save/list and control list/get/resolve, broadcasting committed updates", async () => {
  const saved = await extensionRequest({ type: "annotationsSave", tabId: 1, annotation: annotationDraft, screenshot: annotationScreenshot });
  expect(saved.error).toBeUndefined();
  const item = saved.result;
  expect((await extensionRequest({ type: "annotationsList", tabId: 1, url: annotationDraft.url })).result).toEqual([item]);
  const peer = control();
  expect((await request(peer, { action: "annotationsList", url: annotationDraft.url, status: "open" })).result).toEqual([item]);
  expect((await request(peer, { action: "annotationsGet", annotationId: item.id })).result).toEqual(item);
  expect((await request(peer, { action: "annotationsGet", url: annotationDraft.url })).result).toEqual([item]);
  const resolved = (await request(peer, { action: "annotationsResolve", annotationId: item.id, note: "Done" })).result;
  expect(resolved.status).toBe("resolved");
  expect(extension.messages).toContainEqual({ type: "annotationUpdated", annotation: resolved });
  expect((await request(peer, { action: "annotationsList", status: "open" })).result).toEqual([]);
});

it("rejects wrong tokens and pre-authentication annotation requests on both channels", async () => {
  const wrongExtension = new Peer();
  (bridge as any).attachExtension(wrongExtension);
  wrongExtension.emit("message", JSON.stringify({ type: "annotationsSave", id: "attack", tabId: 1, annotation: annotationDraft, screenshot: annotationScreenshot }));
  expect(wrongExtension.destroyed).toBe(true);
  const wrongControl = control("wrong-token");
  expect(wrongControl.destroyed).toBe(true);
  expect(wrongControl.messages).toEqual([]);
  const noHello = new Peer();
  controlPeers.push(noHello);
  (daemon as any).handleConnection(noHello);
  noHello.emit("data", Buffer.from('{"type":"request","id":"attack","action":"annotationsList"}\n'));
  expect(noHello.destroyed).toBe(true);
  expect((await request(control(), { action: "annotationsList" })).result).toEqual([]);
});

it("rejects unshared or different-URL extension writes and invalid control filters/IDs", async () => {
  expect((await extensionRequest({ type: "annotationsSave", tabId: 2, annotation: annotationDraft, screenshot: annotationScreenshot })).error).toMatch(/shared/);
  expect((await extensionRequest({ type: "annotationsList", tabId: 1, url: "https://other.example/" })).error).toMatch(/same URL/);
  expect((await extensionRequest({ type: "annotationsSave", tabId: 1, annotation: { ...annotationDraft, comment: " " }, screenshot: annotationScreenshot })).error).toBeTruthy();
  const peer = control();
  expect((await request(peer, { action: "annotationsList", status: "bad" })).error).toBeTruthy();
  expect((await request(peer, { action: "annotationsGet" })).error).toMatch(/required/);
  expect((await request(peer, { action: "annotationsGet", annotationId: "invalid", url: annotationDraft.url })).error).toMatch(/not both/);
  expect((await request(peer, { action: "annotationsResolve", annotationId: "../../token" })).error).toBeTruthy();
});
