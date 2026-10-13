import { afterEach, beforeEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ options: vi.fn(), request: vi.fn(), connect: vi.fn(), close: vi.fn() }));
vi.mock("./auth.js", () => ({ getOrCreateToken: async () => "unit-token", tokenPath: () => "unused" }));
vi.mock("./daemon-socket.js", () => ({ daemonSocketPath: () => "unused" }));
vi.mock("./daemon-client.js", () => ({ DaemonClient: class {
  constructor(options: unknown) { ipc.options(options); }
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
  vi.stubEnv("UBB_CLIENT_LABEL", "env-agent");
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { stdout += String(chunk); return true; });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => { stderr += String(chunk); return true; });
});
afterEach(() => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
async function run(args: string[]) {
  process.argv = ["node", "ubb", ...args];
  await import("./cli.js");
}

it.each([
  ["browser_new_tab", { url: "https://example.com/" }, { action: "createTab", url: "https://example.com/" }, { id: 101 }],
  ["browser_list_agent_tabs", {}, { action: "listAgentTabs" }, [{ tabId: 101, url: "https://example.com/", title: "Example", groupId: 1 }]],
  ["browser_close_tab", { tabId: 101 }, { action: "closeTab", tabId: 101 }, { closed: 101 }]
])("runs %s through the labelled tool CLI and prints JSON", async (tool, args, request, result) => {
  ipc.request.mockResolvedValue(result);
  await run(["--label", "Hephaestus", tool as string, JSON.stringify(args)]);
  expect(ipc.options).toHaveBeenCalledWith(expect.objectContaining({ label: "Hephaestus" }));
  expect(ipc.request).toHaveBeenCalledWith(request);
  expect(JSON.parse(stdout)).toEqual(result);
  expect(stderr).toBe("");
  expect(process.exitCode).toBe(0);
  expect(ipc.close).toHaveBeenCalledOnce();
});

it("uses the environment label when --label is omitted", async () => {
  ipc.request.mockResolvedValue([]);
  await run(["browser_list_agent_tabs", "{}"]);
  expect(ipc.options).toHaveBeenCalledWith(expect.objectContaining({ label: "env-agent" }));
  expect(JSON.parse(stdout)).toEqual([]);
});

it.each(["null", "[]", "42", "bad json"])("rejects non-object tool arguments %s without connecting", async (args) => {
  await run(["browser_new_tab", args]);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBeTruthy();
  expect(ipc.connect).not.toHaveBeenCalled();
});

it.each([
  ["browser_new_tab", { url: "file:///etc/passwd" }],
  ["browser_close_tab", { tabId: "101" }],
  ["browser_not_a_tool", {}]
])("uses MCP validation for %s and reports errors without stdout", async (tool, args) => {
  await run([tool as string, JSON.stringify(args)]);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toBeTruthy();
  expect(ipc.request).not.toHaveBeenCalled();
  expect(ipc.close).toHaveBeenCalledOnce();
});

it("returns daemon ownership errors and closes its control connection", async () => {
  ipc.request.mockRejectedValueOnce(new Error('Tab 101 is owned by agent label "Hermes"'));
  await run(["browser_close_tab", '{"tabId":101}']);
  expect(process.exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toMatch(/owned.*Hermes/);
  expect(ipc.close).toHaveBeenCalledOnce();
});
