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
let networkUrls: string[];
let networkIndex: number;
let ioIndex: number;
let networkReadError: boolean;
let networkSizeError: boolean;
let ioText: boolean;
let pageResponseType: string;
let pageFetchFailure: string | undefined;
let pageStatus: number;
let pageFetches: { url: string; options: { redirect: string; credentials: string } }[];
let pageEntriesAtNetworkStart: string[][];
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
  url: "blob:https://app.example/media", filename: "clip.bin", description: "Save media", ...options });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-download-protocol-"));
  pageResponseType = "basic"; pageFetchFailure = undefined; pageStatus = 200; pageFetches = []; pageEntriesAtNetworkStart = [];
  networkUrls = []; networkIndex = 0; ioIndex = 0; networkReadError = false; networkSizeError = false; ioText = false;
  commands = []; owned = true; fakeSize = undefined; failChunk = false; chunks = 0;
  bytes = Buffer.from([0, 1, 2, 255]); page = {};
  liveTab = { id: 7, url: "https://app.example/project", active: true };
  const context = createContext({ window: page, location: { href: liveTab.url }, URL, AbortController, Blob, Uint8Array, btoa, setTimeout, clearTimeout,
    document: { querySelector: () => ({ tagName: "VIDEO", currentSrc: "blob:https://app.example/video" }) },
    fetch: async (url: string, options: { redirect: string; credentials: string }) => {
      pageFetches.push({ url, options });
      if (pageFetchFailure) throw new Error(pageFetchFailure);
      return { type: pageResponseType, ok: pageResponseType !== "opaqueredirect" && pageStatus >= 200 && pageStatus < 300,
        status: pageStatus, url, headers: { get: () => null }, blob: async () => new Blob([new Uint8Array(bytes)], { type: "video/mp4" }) };
    }
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
    if (message.action === "downloadStart") pageEntriesAtNetworkStart.push(Object.keys(page.__ubbDl ?? {}));
    if (message.action === "downloadStart" || message.action === "downloadContinue") {
      if (networkSizeError) { push({ type: "response", id: message.id, error: "Download exceeds the 500 MB limit" }); return; }
      result = networkIndex < networkUrls.length ? { redirectUrl: networkUrls[networkIndex++] } : { mimeType: "video/mp4" };
    }
    if (message.action === "downloadRead") {
      if (networkReadError && ioIndex > 0) { push({ type: "response", id: message.id, error: "IO.read failed" }); return; }
      const chunk = bytes.subarray(ioIndex, ioIndex + 1048576); ioIndex += chunk.length;
      result = { data: chunk.toString(ioText ? "utf8" : "base64"), base64Encoded: !ioText, eof: ioIndex >= bytes.length };
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
  expect((await download({ url })).error).toMatch(/same-origin|trusted download host/i);
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


it("falls back after a same-origin opaqueredirect and streams exact bytes", async () => {
  pageResponseType = "opaqueredirect";
  bytes = Buffer.alloc(1048583, 0xab);
  const result = await download({ url: "https://app.example/media" });
  expect(result.error).toBeUndefined();
  expect(await readFile(result.result.saved)).toEqual(bytes);
  expect(result.result.bytes).toBe(bytes.length);
  expect(commands.filter(command => command.action === "downloadRead")).toHaveLength(2);
  expect(pageFetches).toHaveLength(1);
  expect(pageFetches[0]).toMatchObject({ url: "https://app.example/media", options: { redirect: "manual" } });
  expect(pageEntriesAtNetworkStart).toEqual([[]]);
  expect(commands.some(command => command.action === "downloadCancel")).toBe(true);
});
it("falls back from same-origin opaqueredirect and independently checks a trusted redirect", async () => {
  pageResponseType = "opaqueredirect";
  push({ type: "sitePolicy", blockedDomains: [], downloadFolders: [directory], trustedDownloadHosts: ["cdn.example"] });
  networkUrls = ["https://cdn.example/media?token=secret"];
  const result = await download({ url: "https://app.example/media" });
  expect(await readFile(result.result.saved)).toEqual(bytes);
  expect(commands.filter(command => command.action === "downloadContinue")).toHaveLength(1);
  const start = commands.find(command => command.action === "downloadStart");
  expect(start).not.toHaveProperty("trustedDownloadHosts");
  expect(start.description).toBe("Save media");
  expect(pageFetches).toHaveLength(1);
  expect(pageEntriesAtNetworkStart).toEqual([[]]);
});
it.each(["https://untrusted.example/private?token=secret", "http://cdn.example/private?token=secret", "https://blocked.example/private?token=secret"])(
  "refuses fallback redirect %s without continuation or token leakage", async url => {
    pageResponseType = "opaqueredirect";
    push({ type: "sitePolicy", blockedDomains: ["blocked.example"], downloadFolders: [directory], trustedDownloadHosts: ["cdn.example", "blocked.example"] });
    networkUrls = [url];
    const result = await download({ url: "https://app.example/media" });
    expect(result.error).toContain(new URL(url).hostname);
    expect(result.error).not.toMatch(/private|token|secret/);
    expect(commands.some(command => command.action === "downloadContinue")).toBe(false);
    expect(commands.some(command => command.action === "downloadCancel")).toBe(true);
    expect(await readdir(directory)).toEqual([]);
  }
);
it("caps hops independently of the extension", async () => {
  pageResponseType = "opaqueredirect";
  networkUrls = Array.from({ length: 11 }, (_, index) => `https://app.example/${index}`);
  expect((await download({ url: "https://app.example/media" })).error).toMatch(/redirect limit/i);
  expect(commands.filter(command => command.action === "downloadContinue")).toHaveLength(10);
});
it("allows trusted initial HTTPS and textual IO chunks", async () => {
  push({ type: "sitePolicy", blockedDomains: [], downloadFolders: [directory], trustedDownloadHosts: ["cdn.example"] });
  bytes = Buffer.from("héllo"); ioText = true;
  const result = await download({ url: "https://cdn.example/clip?token=secret" });
  expect(result.result.bytes).toBe(bytes.length);
  expect(await readFile(result.result.saved)).toEqual(bytes);
  expect(pageFetches).toEqual([]);
  expect(commands.filter(command => command.action === "downloadStart")).toHaveLength(1);
});
it("removes partial files and closes the network session on read failures and size failures", async () => {
  pageResponseType = "opaqueredirect";
  bytes = Buffer.alloc(1048577); networkReadError = true;
  expect((await download({ url: "https://app.example/media" })).error).toContain("IO.read failed");
  expect(await readdir(directory)).toEqual([]);
  expect(commands.some(command => command.action === "downloadCancel")).toBe(true);
  commands = []; networkSizeError = true;
  expect((await download({ url: "https://app.example/media" })).error).toContain("500 MB");
  expect(commands.some(command => command.action === "downloadRead")).toBe(false);
  expect(commands.some(command => command.action === "downloadCancel")).toBe(true);
});
it.each(["setTrustedDownloadHosts", "trustedDownloadHosts", "downloadStart", "downloadContinue", "downloadRead", "downloadCancel"])(
  "keeps internal policy and transfer action %s out of the control protocol", async action => {
    expect((await request({ action, tabId: 7, trustedDownloadHosts: ["attack.example"] })).error).toContain("Unknown control action");
    expect(bridge.trustedDownloadHosts).toEqual([]);
  }
);


it("keeps same-origin non-redirect image downloads on the page path without Fetch.enable", async () => {
  const result = await download({ url: "https://app.example/image.png", filename: "image.png" });
  expect(result.error).toBeUndefined();
  expect(await readFile(result.result.saved)).toEqual(bytes);
  expect(pageFetches).toHaveLength(1);
  expect(pageFetches[0]).toMatchObject({ options: { redirect: "manual", credentials: "same-origin" } });
  expect(commands.some(command => command.action === "downloadStart" || command.method === "Fetch.enable")).toBe(false);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
});
it.each(["network error", "HTTP error", "opaque response", "size limit"])("preserves same-origin page %s without interception fallback", async reason => {
  if (reason === "network error") pageFetchFailure = "Page fetch failed";
  if (reason === "HTTP error") pageStatus = 404;
  if (reason === "opaque response") { pageResponseType = "opaque"; pageStatus = 0; }
  if (reason === "size limit") fakeSize = 524288001;
  const result = await download({ url: "https://app.example/media" });
  expect(result.error).toMatch(/Page fetch failed|HTTP 404|HTTP 0|500 MB/);
  expect(pageFetches).toHaveLength(1);
  expect(commands.some(command => command.action === "downloadStart")).toBe(false);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
  expect(await readdir(directory)).toEqual([]);
});
