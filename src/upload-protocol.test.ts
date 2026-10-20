import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { AnnotationStore } from "./annotations.js";

class Peer extends EventEmitter {
  readyState = 1;
  destroyed = false;
  send(_raw: string) {}
  write(_raw: string) {}
  close() { this.destroy(); }
  destroy() { this.destroyed = true; this.emit("close"); }
}
let directory: string;
let file: string;
let bridge: BrowserBridge;
let daemon: DaemonServer;
let extension: Peer;
let control: Peer;
let commands: any[];
let owned: boolean;
let liveTab: { id: number; url: string; pendingUrl?: string; active: boolean };
let evaluation: any;
let geometry: any;
let details: any;
let approved: boolean;
let uploadError: string | undefined;
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
const upload = (body: Record<string, unknown> = {}) => request({ action: "uploadFile", tabId: 7, ref: "ubb-3", snapshotId: "7:0", description: "Attach reference", files: [file], ...body });
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-upload-protocol-"));
  file = join(directory, "ref.png");
  await writeFile(file, "image");
  commands = []; owned = true; uploadError = undefined; approved = true;
  liveTab = { id: 7, url: "https://flow.google.com/", active: true };
  evaluation = { result: { objectId: "file-input-object" } };
  geometry = { result: { value: { x: 60, y: 50, hasSize: true, visible: true, hitTarget: true } } };
  details = { result: { value: { text: "Upload media" } } };
  bridge = new BrowserBridge("test-token");
  daemon = new DaemonServer(bridge, "test-token", join(directory, "daemon.sock"), new AnnotationStore(join(directory, "annotations")));
  extension = new Peer();
  extension.send = (raw) => {
    const message = JSON.parse(raw);
    if (message.type !== "command") return;
    commands.push(message);
    let result: unknown = {};
    if (message.action === "getTab") result = { ...liveTab };
    if (message.action === "listAgentTabs") result = owned ? [{ tabId: 7, url: liveTab.url, title: "Flow", groupId: 1 }] : [];
    if (message.action === "requestApproval") result = { approved };
    if (message.action === "uploadViaFileChooser") result = { uploaded: message.files.length, files: message.files, method: "chooser", picker: "input" };
    if (message.method === "Runtime.evaluate") {
      result = message.params.expression.includes("scrollIntoView") ? geometry
        : message.params.expression.includes("formAction") ? details : evaluation;
    }
    push({ type: "response", id: message.id, result, error: message.method === "DOM.setFileInputFiles" ? uploadError : undefined });
  };
  (bridge as any).attachExtension(extension);
  push({ type: "hello", version: 1, token: "test-token", blockedDomains: [], uploadFolders: [directory] });
  push({ type: "tabs", tabs: [{ ...liveTab }] });
  commands.length = 0;
  authenticate("Hephaestus");
});
afterEach(async () => {
  control.destroy(); extension.destroy();
  await daemon.stop(); await bridge.stop();
  await rm(directory, { recursive: true, force: true });
});

it("resolves the input then attaches real paths with the objectId without bumping generation", async () => {
  const alias = join(directory, "alias.png");
  await symlink(file, alias);
  expect(await upload({ files: [alias] })).toMatchObject({ result: { uploaded: 1, files: [await realpath(file)], method: "input", picker: "input" } });
  const cdp = commands.filter((command) => command.action === "cdp");
  expect(commands[0]).toMatchObject({ action: "listAgentTabs", label: "Hephaestus" });
  expect(cdp.map((command) => command.method)).toEqual(["Runtime.evaluate", "DOM.setFileInputFiles"]);
  expect(cdp[0]).toMatchObject({ label: "Hephaestus", requiresWritable: true, params: { returnByValue: false } });
  expect(cdp[0].params.expression).toContain("ubb-3");
  expect(cdp[1]).toMatchObject({ tabId: 7, label: "Hephaestus", requiresWritable: true, params: { files: [await realpath(file)], objectId: "file-input-object" } });
  expect((await upload()).error).toBeUndefined();
});

it("uses one chooser command with real paths and resolved center coords for a non-input ref", async () => {
  evaluation = { result: { type: "object", subtype: "null", value: null } };
  const alias = join(directory, "alias.png");
  await symlink(file, alias);
  expect(await upload({ files: [alias] })).toMatchObject({ result: { uploaded: 1, files: [await realpath(file)], method: "chooser", picker: "input" } });
  expect(commands.filter((command) => command.action === "uploadViaFileChooser")).toEqual([
    expect.objectContaining({ tabId: 7, label: "Hephaestus", files: [await realpath(file)], x: 60, y: 50, timeoutMs: 5000 })
  ]);
  expect(commands.some((command) => command.method === "DOM.setFileInputFiles" || command.method?.startsWith("Input."))).toBe(false);
});

it("forces chooser mode even when an input could resolve and uses A's script fallback for covered targets", async () => {
  geometry.result.value.hitTarget = false;
  expect((await upload({ mode: "chooser" })).result.method).toBe("chooser");
  const chooser = commands.find((command) => command.action === "uploadViaFileChooser");
  expect(chooser).toMatchObject({ ref: "ubb-3" });
  expect(chooser.x).toBeUndefined();
  expect(commands.filter((command) => command.method === "Runtime.evaluate")).toHaveLength(2);
});

it("keeps the old non-input error in input mode", async () => {
  evaluation = { exceptionDetails: { exception: { description: "Target is not a file input (or a label/button containing one)" } } };
  expect((await upload({ mode: "input" })).error).toContain("Target is not a file input");
  expect(commands.some((command) => command.action === "uploadViaFileChooser")).toBe(false);
});

it("keeps consequential approval ahead of the chooser command and denial prevents it", async () => {
  details = { result: { value: { text: "Submit order" } } };
  approved = false;
  expect((await upload({ mode: "chooser" })).error).toContain("User denied");
  expect(commands.some((command) => command.action === "requestApproval")).toBe(true);
  expect(commands.some((command) => command.action === "uploadViaFileChooser")).toBe(false);
  expect(commands.some((command) => command.params?.expression?.includes("scrollIntoView"))).toBe(false);
});

it.each(["unowned", "outside folder", "read-only", "blocked", "stale", "unlabelled"])(
  "never sends a chooser command when daemon policy rejects %s", async (reason) => {
    const options: Record<string, unknown> = { mode: "chooser" };
    if (reason === "unowned") owned = false;
    if (reason === "outside folder") options.files = [join(tmpdir(), "outside.png")];
    if (reason === "read-only") liveTab.pendingUrl = "https://hdfcbank.com/";
    if (reason === "blocked") push({ type: "sitePolicy", blockedDomains: ["flow.google.com"], uploadFolders: [directory] });
    if (reason === "stale") options.snapshotId = "7:9";
    if (reason === "unlabelled") { control.destroy(); authenticate(); }
    expect((await upload(options)).error).toBeDefined();
    expect(commands.some((command) => command.action === "uploadViaFileChooser" || command.action === "cdp")).toBe(false);
  }
);

it("rejects invalid modes before any extension command", async () => {
  expect((await upload({ mode: "invalid" })).error).toMatch(/mode/i);
  expect(commands).toEqual([]);
});

it("rejects unlabelled clients before contacting the extension", async () => {
  control.destroy(); authenticate();
  expect((await upload()).error).toMatch(/label.*required|require.*label/i);
  expect(commands).toEqual([]);
});

it("requires live ownership even when cached tabs claim ownership", async () => {
  push({ type: "tabs", tabs: [{ ...liveTab, ownerLabel: "Hephaestus" }] });
  owned = false;
  expect((await upload()).error).toMatch(/owned.*label|own.*tab/i);
  expect(commands.map((command) => command.action)).toEqual(["listAgentTabs"]);
});

it.each(["url", "pendingUrl"] as const)("rejects blocklisted live %s", async (field) => {
  push({ type: "sitePolicy", blockedDomains: ["blocked.org"], uploadFolders: [directory] });
  liveTab[field] = "https://blocked.org/";
  expect((await upload()).error).toContain("blocked by your blocklist");
  expect(commands.some((command) => command.action === "cdp")).toBe(false);
});

it.each(["url", "pendingUrl"] as const)("rejects read-only live %s", async (field) => {
  liveTab[field] = "https://hdfcbank.com/";
  expect((await upload()).error).toContain("read-only");
  expect(commands.some((command) => command.action === "cdp")).toBe(false);
});

it("rejects stale snapshot IDs before resolving the file input", async () => {
  expect((await upload({ snapshotId: "7:9" })).error).toContain("Stale snapshot");
  expect(commands.some((command) => command.action === "cdp")).toBe(false);
});

it.each(["Target is not a file input (or a label/button containing one)", "Element ref expired; take a new snapshot", "File input is disabled", "File input does not allow multiple files"])(
  "surfaces page script errors: %s", async (error) => {
    evaluation = { exceptionDetails: { exception: { description: error } } };
    expect((await upload()).error).toContain(error);
    expect(commands.some((command) => command.method === "DOM.setFileInputFiles")).toBe(false);
  }
);

it("rejects unusable CDP objects and surfaces exceptionDetails text", async () => {
  evaluation = { result: { type: "undefined" } };
  expect((await upload()).error).toMatch(/file input|objectId/i);
  evaluation = { exceptionDetails: { text: "Page script failed" } };
  expect((await upload()).error).toContain("Page script failed");
  expect(commands.some((command) => command.method === "DOM.setFileInputFiles")).toBe(false);
});

it("does not upload with an empty policy or invalid file", async () => {
  expect((await upload({ files: [join(directory, "missing")] })).error).toContain("missing");
  push({ type: "sitePolicy", blockedDomains: [], uploadFolders: [] });
  expect((await upload()).error).toContain("File uploads are disabled");
  expect(commands.some((command) => command.action === "cdp")).toBe(false);
});

it("adds the file URL permission hint for Chrome Not allowed errors", async () => {
  uploadError = "Not allowed";
  expect((await upload()).error).toContain("Allow access to file URLs");
});

it.each(["setUploadFolders", "uploadFolders", "sitePolicy", "setSitePolicy"])("rejects policy changes through control action %s", async (action) => {
  expect((await request({ action, tabId: 7, uploadFolders: ["/"] })).error).toContain("Unknown control action");
  expect(bridge.uploadFolders).toEqual([`${directory}/`]);
  expect(commands).toEqual([]);
});
