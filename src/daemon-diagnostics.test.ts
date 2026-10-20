import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import { AnnotationStore } from "./annotations.js";

class Peer extends EventEmitter {
  readyState = 1;
  send(_raw: string) {}
  close() { this.readyState = 3; this.emit("close"); }
  push(message: unknown) { this.emit("message", JSON.stringify(message)); }
}
let directory: string;
let bridge: BrowserBridge;
let daemon: DaemonServer;
let stderr: ReturnType<typeof vi.spyOn>;
let stdout: ReturnType<typeof vi.spyOn>;
const peers: Peer[] = [];
const output = (): string => stderr.mock.calls.map((args: unknown[]) => String(args[0])).join("");
function connect() {
  const peer = new Peer(); peers.push(peer);
  (bridge as any).attachExtension(peer);
  peer.push({ type: "hello", token: "test-token", version: 1 });
  return peer;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-diagnostics-"));
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  bridge = new BrowserBridge("test-token");
  daemon = new DaemonServer(bridge, "test-token", join(directory, "unused.sock"), new AnnotationStore(join(directory, "annotations")));
});
afterEach(async () => {
  await daemon.stop(); for (const peer of peers.splice(0)) peer.close(); await bridge.stop();
  vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true });
});

it("logs extension lifecycle, ownership restoration and detach diagnostics with timestamped lines", () => {
  const peer = connect();
  peer.push({ type: "tabs", tabs: [{ id: 7, ownerLabel: "Hephaestus", url: "https://example.com/", title: "Example", active: true }] });
  peer.push({ type: "diagnostic", event: "debuggerDetached", tabId: 7, reason: "target_closed\nextra", label: "Hephaestus", at: "2026-10-20T10:00:00.000Z", token: "must-not-log" });
  peer.close();
  const lines = output().trim().split("\n");
  expect(lines.some((line) => /extension connected/i.test(line))).toBe(true);
  expect(lines.some((line) => /ownership restored/i.test(line) && line.includes("Hephaestus") && line.includes("7"))).toBe(true);
  expect(lines.some((line) => line.includes("debuggerDetached") && line.includes("target_closed\\nextra"))).toBe(true);
  expect(lines.some((line) => /extension disconnected/i.test(line))).toBe(true);
  expect(lines.every((line) => /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}\] /.test(line))).toBe(true);
  expect(output()).not.toContain("must-not-log");
  expect(stdout).not.toHaveBeenCalled();
});
it("ignores unauthenticated, replaced and malformed diagnostics", () => {
  const old = connect();
  const replacement = connect();
  const attacker = new Peer(); peers.push(attacker);
  (bridge as any).attachExtension(attacker);
  stderr.mockClear();
  const event = { type: "diagnostic", event: "debuggerDetached", tabId: 7, reason: "target_closed", at: new Date().toISOString() };
  old.push(event); attacker.push(event); replacement.push({ ...event, tabId: "bad" });
  expect(output()).toBe("");
});
it("does not duplicate handlers after the daemon is stopped and restarted", async () => {
  await daemon.stop();
  daemon = new DaemonServer(bridge, "test-token", join(directory, "unused.sock"), new AnnotationStore(join(directory, "annotations")));
  const peer = connect(); stderr.mockClear();
  peer.push({ type: "diagnostic", event: "debuggerDetached", tabId: 7, reason: "canceled_by_user", at: new Date().toISOString() });
  expect(output().trim().split("\n")).toHaveLength(1);
});
