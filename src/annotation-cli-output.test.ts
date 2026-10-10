import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnotationWebhook } from "./annotation-webhook.js";

// Exercise the real CLI entry point with only its IPC/auth boundaries mocked.
const ipc = vi.hoisted(() => ({ request: vi.fn(), connect: vi.fn(), close: vi.fn() }));
vi.mock("./auth.js", () => ({ getOrCreateToken: async () => "unit-token", tokenPath: () => "unused" }));
vi.mock("./daemon-socket.js", () => ({ daemonSocketPath: () => "unused" }));
vi.mock("./daemon-client.js", () => ({ DaemonClient: class {
  connect = ipc.connect;
  request = ipc.request;
  close = ipc.close;
} }));
let stdout: string;
let stderr: string;
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  stdout = ""; stderr = ""; process.exitCode = 0;
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
});
afterEach(() => { process.argv = originalArgv; process.exitCode = originalExitCode; vi.restoreAllMocks(); });
async function run(args: string[]) {
  process.argv = ["node", "cli.js", "annotations", ...args];
  await import("./cli.js");
}

it("prints the updated reply JSON and closes its control client", async () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const updated = { id, replies: [{ text: "Done", author: "Hephaestus" }] };
  ipc.request.mockResolvedValue(updated);
  await run(["reply", id, "--text", "Done", "--author", "Hephaestus"]);
  expect(ipc.request).toHaveBeenCalledWith({ action: "annotationsReply", annotationId: id, text: "Done", author: "Hephaestus" });
  expect(JSON.parse(stdout)).toEqual(updated);
  expect(process.exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(ipc.close).toHaveBeenCalledOnce();
});

it("prints only sanitized webhook status JSON", async () => {
  const webhook = new AnnotationWebhook({ env: {} });
  vi.spyOn(webhook as any, "config").mockResolvedValue({ source: "file", config: { url: "https://hooks.example.com/?token=query-secret", enabled: true, headers: { Authorization: "Bearer header-secret" } } });
  ipc.request.mockResolvedValue(await webhook.status());
  await run(["webhook", "status"]);
  expect(ipc.request).toHaveBeenCalledWith({ action: "annotationsWebhookStatus" });
  expect(JSON.parse(stdout)).toEqual({ configured: true, enabled: true, source: "file", host: "hooks.example.com", headerNames: ["Authorization"] });
  expect(stdout).not.toMatch(/query-secret|header-secret|Bearer/);
});

it.each([
  { ok: true, status: 204, attempts: 1 },
  { ok: false, status: 401, attempts: 1 },
  { ok: false, error: "network error", attempts: 4 },
  { ok: false, error: "Webhook is not configured", attempts: 0 }
])("prints webhook test result and sets its exit code: %j", async (result) => {
  ipc.request.mockResolvedValue(result);
  await run(["webhook", "test"]);
  expect(ipc.request).toHaveBeenCalledWith({ action: "annotationsWebhookTest" });
  expect(JSON.parse(stdout)).toEqual(result);
  expect(process.exitCode).toBe(result.ok ? 0 : 1);
  expect(ipc.close).toHaveBeenCalledOnce();
});
