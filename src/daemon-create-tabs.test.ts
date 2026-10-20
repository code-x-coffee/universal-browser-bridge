import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { BrowserBridge } from "./bridge.js";
import { DaemonServer } from "./daemon.js";
import type { DaemonRequest } from "./daemon-client.js";
import type { BridgeCommand } from "./protocol.js";

// Exercise the control protocol without binding sockets, so disconnect races
// can also be verified in environments that prohibit local listeners.
class ControlSocket extends EventEmitter {
  destroyed = false;
  messages: any[] = [];
  write(raw: string) { this.messages.push(JSON.parse(raw)); return true; }
  receive(message: unknown) { this.emit("data", Buffer.from(`${JSON.stringify(message)}\n`)); }
  destroy() { this.destroyed = true; this.emit("close"); }
  request(id: string, body: DaemonRequest) { this.receive({ type: "request", id, ...body }); }
  response(id: string) { return this.messages.find((message) => message.type === "response" && message.id === id); }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let daemon: DaemonServer;
let command: ReturnType<typeof vi.fn<(message: Omit<BridgeCommand, "type" | "id">) => Promise<unknown>>>;
let sequence: number;
const sockets: ControlSocket[] = [];
function connect(label?: string) {
  const socket = new ControlSocket();
  sockets.push(socket);
  (daemon as any).handleConnection(socket);
  socket.receive({ type: "hello", token: "test-token", clientId: `client-${sockets.length}`, label, version: 1 });
  expect(socket.messages[0]?.type).toBe("ready");
  return socket;
}

beforeEach(() => {
  sequence = 0;
  command = vi.fn(async (message: Omit<BridgeCommand, "type" | "id">) =>
    message.action === "createTab" ? { id: ++sequence } : { closed: message.tabId });
  const bridge = Object.assign(new EventEmitter(), { command, blockedDomains: [] });
  daemon = new DaemonServer(bridge as unknown as BrowserBridge, "test-token", "unused.sock");
});
afterEach(() => { for (const socket of sockets.splice(0)) socket.destroy(); });

it("never sends a queued createTab after its client disconnects", async () => {
  const first = deferred<{ id: number }>();
  command.mockImplementationOnce(() => first.promise);
  const a = connect("A");
  const b = connect("B");
  a.request("first", { action: "createTab", url: "https://example.com/a" });
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  b.request("abandoned", { action: "createTab", url: "https://example.com/b" });
  b.destroy();
  first.resolve({ id: 100 });
  await vi.waitFor(() => expect(a.response("first")?.result).toEqual({ id: 100 }));
  expect(command.mock.calls).toEqual([[{ action: "createTab", url: "https://example.com/a", label: "A" }]]);
});

it.each([undefined, "A"])("holds the queue until an in-flight orphan is closed using its original label (%s)", async (label) => {
  const first = deferred<{ id: number }>();
  const cleanup = deferred<{ closed: number }>();
  command.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => cleanup.promise);
  const a = connect(label);
  const b = connect("B");
  a.request("orphan", { action: "createTab", url: "https://example.com/orphan" });
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  b.request("next", { action: "createTab", url: "https://example.com/b" });
  a.destroy();
  first.resolve({ id: 100 });
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2));
  expect(b.response("next")).toBeUndefined();
  expect(command.mock.calls[1]).toEqual([{ action: "closeTab", tabId: 100, label }]);
  cleanup.resolve({ closed: 100 });
  await vi.waitFor(() => expect(b.response("next")?.result).toEqual({ id: 1 }));
  expect(command.mock.calls).toEqual([
    [{ action: "createTab", url: "https://example.com/orphan", label }],
    [{ action: "closeTab", tabId: 100, label }],
    [{ action: "createTab", url: "https://example.com/b", label: "B" }]
  ]);
});

it("continues after orphan cleanup fails without assigning the orphan to the disconnected client", async () => {
  const first = deferred<{ id: number }>();
  command.mockImplementationOnce(() => first.promise).mockRejectedValueOnce(new Error("close failed"));
  const a = connect();
  const b = connect();
  a.request("orphan", { action: "createTab", url: "https://example.com/orphan" });
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(1));
  b.request("next", { action: "createTab", url: "https://example.com/b" });
  a.destroy();
  first.resolve({ id: 100 });
  await vi.waitFor(() => expect(b.response("next")?.result).toEqual({ id: 1 }));
  expect(command.mock.calls[1]).toEqual([{ action: "closeTab", tabId: 100, label: undefined }]);
  b.request("close-orphan", { action: "closeTab", tabId: 100 });
  await vi.waitFor(() => expect(b.response("close-orphan")?.result).toEqual({ closed: 100 }));
});

it("preserves normal createTab results and legacy ownership while the client remains connected", async () => {
  const a = connect();
  const b = connect();
  a.request("create", { action: "createTab", url: "https://example.com/" });
  await vi.waitFor(() => expect(a.response("create")?.result).toEqual({ id: 1 }));
  b.request("denied", { action: "closeTab", tabId: 1 });
  await vi.waitFor(() => expect(b.response("denied")?.error).toMatch(/owning client/i));
  a.request("close", { action: "closeTab", tabId: 1 });
  await vi.waitFor(() => expect(a.response("close")?.result).toEqual({ closed: 1 }));
  expect(command.mock.calls).toEqual([
    [{ action: "createTab", url: "https://example.com/", label: undefined }],
    [{ action: "closeTab", tabId: 1, label: undefined }]
  ]);
});
