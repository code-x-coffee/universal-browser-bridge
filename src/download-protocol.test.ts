import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { AnnotationStore } from "./annotations.js";

class Peer extends EventEmitter {
  readyState = 1; destroyed = false;
  send(_raw: string) {} write(_raw: string) {}
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
let owned: boolean;
let bytes: Buffer;
let page: any;
let fakeSize: number | undefined;
let failChunk: boolean;
let chunks: number;
const push = (message: unknown) => extension.emit("message", JSON.stringify(message));
function authenticate(label?: string) {
  control = new Peer();
  (daemon as any).handleConnection(control);
  control.emit("data", Buffer.from(JSON.stringify({ type: "hello", token: "test-token", clientId: randomUUID(), label, version: 1 }) + "\n"));
}
function request(body: Record<string, unknown>): Promise<any> {
  const id = randomUUID();
  return new Promise((resolve) => {
    control.write = (raw) => { const response = JSON.parse(raw); if (response.id === id) resolve(response); };
    control.emit("data", Buffer.from(JSON.stringify({ type: "request", id, ...body }) + "\n"));
  });
}
const download = (options: Record<string, unknown> = {}) => request({ action: "download", tabId: 7,
  url: "https://app.example/media", filename: "clip.bin", description: "Save media", ...options });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-download-protocol-"));
  commands = []; owned = true; fakeSize = undefined; failChunk = false; chunks = 0;
  bytes = Buffer.from([0, 1, 2, 255]); page = {};
  liveTab = { id: 7, url: "https://app.example/project", active: true };
  const context = createContext({ window: page, location: { href: liveTab.url }, URL, AbortController, Blob, Uint8Array, btoa, setTimeout, clearTimeout,
    document: { querySelector: () => ({ tagName: "VIDEO", currentSrc: "blob:https://app.example/video" }) },
    fetch: async (url: string) => ({ ok: true, status: 200, url, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array(bytes)], { type: "video/mp4" }) })
  });
  bridge = new BrowserBridge("test-token");
  daemon = new DaemonServer(bridge, "test-token", join(directory, "daemon.sock"), new AnnotationStore(join(directory, "annotations")));
  extension = new Peer();
  extension.send = (raw) => { void (async () => {
    const message = JSON.parse(raw);
    if (message.type !== "command") return;
    commands.push(message);
    let result: any = {};
    if (message.action === "getTab") result = { ...liveTab };
    if (message.action === "listAgentTabs") result = owned ? [{ tabId: 7, url: liveTab.url, title: "Media", groupId: 1 }] : [];
    if (message.method === "Runtime.evaluate") {
      try {
        if (message.params.expression.includes("blob.slice") && ++chunks > 1 && failChunk) throw new Error("Chunk transfer failed");
        const value = await runInContext(message.params.expression, context);
        if (value?.mimeType && fakeSize !== undefined) value.size = fakeSize;
        result = { result: { value } };
      } catch (error) { result = { exceptionDetails: { text: (error as Error).message } }; }
    }
    push({ type: "response", id: message.id, result });
  })(); };
  (bridge as any).attachExtension(extension);
  push({ type: "hello", version: 1, token: "test-token", downloadFolders: [directory] });
  push({ type: "tabs", tabs: [{ ...liveTab }] });
  commands.length = 0;
  authenticate("Hephaestus");
});
afterEach(async () => {
  // Any failure in the test must not leave a page timer alive.
  for (const entry of Object.values(page.__ubbDl ?? {}) as any[]) clearTimeout(entry.timer);
  control.destroy(); extension.destroy();
  await daemon.stop(); await bridge.stop();
  await rm(directory, { recursive: true, force: true });
});

it("saves exact bytes with page-side fetching and writable, folder-scoped CDP calls", async () => {
  const response = await download();
  expect(response).toMatchObject({ result: { saved: join(await realpath(directory), "clip.bin"), bytes: 4, mimeType: "video/mp4" } });
  expect(await readFile(response.result.saved)).toEqual(bytes);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
  const cdp = commands.filter((command) => command.action === "cdp");
  expect(cdp.every((command) => command.requiresWritable === true && command.downloadFolder === `${directory}/`)).toBe(true);
  expect(cdp.some((command) => command.params.userGesture === true && command.params.awaitPromise === true)).toBe(true);
});
it("supports snapshot refs and refuses stale refs before page access", async () => {
  expect((await download({ url: undefined, ref: "ubb-3", snapshotId: "7:0" })).error).toBeUndefined();
  commands.length = 0;
  expect((await download({ url: undefined, ref: "ubb-3", snapshotId: "7:9" })).error).toContain("Stale snapshot");
  expect(commands.some((command) => command.action === "cdp")).toBe(false);
});
it("streams multiple chunks and suffixes colliding destination names", async () => {
  bytes = Buffer.alloc(1048583, 0xab);
  const first = await download();
  const second = await download();
  expect(second.result.saved).toBe(join(await realpath(directory), "clip (1).bin"));
  expect(await readFile(first.result.saved)).toEqual(bytes);
  expect(await readFile(second.result.saved)).toEqual(bytes);
  expect(chunks).toBe(4);
});
it("rejects an oversized page result before chunk transfer and cleans up the blob", async () => {
  fakeSize = 524288001;
  expect((await download()).error).toContain("500 MB");
  expect(chunks).toBe(0);
  expect(await readdir(directory)).toEqual([]);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
});
it("cleans up the page blob and partial file on mid-stream failure", async () => {
  bytes = Buffer.alloc(1048577, 7); failChunk = true;
  expect((await download()).error).toContain("Chunk transfer failed");
  expect(await readdir(directory)).toEqual([]);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
});
it.each(["https://other.example/media", "blob:https://other.example/media", "file:///tmp/secret"])("rejects disallowed source %s", async (url) => {
  expect((await download({ url })).error).toMatch(/same-origin/i);
  expect(chunks).toBe(0);
  expect(await readdir(directory)).toEqual([]);
});
it.each(["unowned", "unlabelled", "blocked", "read-only", "disabled"])("refuses %s downloads before any page fetch", async (reason) => {
  if (reason === "unowned") owned = false;
  if (reason === "unlabelled") { control.destroy(); authenticate(); }
  if (reason === "blocked") liveTab.pendingUrl = "https://blocked.example/";
  if (reason === "read-only") liveTab.pendingUrl = "https://hdfcbank.com/";
  push({ type: "sitePolicy", blockedDomains: ["blocked.example"], downloadFolders: reason === "disabled" ? [] : [directory] });
  const reasonPattern = { unowned: /owned.*label/i, unlabelled: /label.*required/i, blocked: /blocked by your blocklist/, "read-only": /read-only/, disabled: /downloads are disabled/ }[reason];
  expect((await download()).error).toMatch(reasonPattern!);
  expect(commands.some((command) => command.action === "cdp")).toBe(false);
  expect(await readdir(directory)).toEqual([]);
});
it.each([{ url: undefined }, { ref: "ubb-3", snapshotId: "7:0" }, { url: undefined, ref: "ubb-3" }, { description: "" }])(
  "rejects invalid source arguments before dispatch: %j", async (options) => {
    expect((await download(options)).error).toBeDefined();
    expect(commands).toEqual([]);
  }
);
it.each(["setDownloadFolders", "downloadFolders", "setSitePolicy"])("refuses policy changes through control action %s", async (action) => {
  expect((await request({ action, tabId: 7, downloadFolders: ["/"] })).error).toContain("Unknown control action");
  expect(bridge.downloadFolders).toEqual([`${directory}/`]);
});
