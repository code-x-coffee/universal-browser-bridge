// Real-process, non-Chrome integration test: spawns the actual `serve` and
// `mcp` CLI commands (via tsx, no build step required) as separate OS
// processes and drives them with a real MCP client and a fake extension over
// a real WebSocket, proving the daemon/adapter split works end-to-end.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX = join(PROJECT_ROOT, "node_modules", ".bin", "tsx");

class FakeExtension {
  ws!: WebSocket;
  private nextTabId = 1;
  tabs: { id: number; title: string; url: string; active: boolean }[] = [];

  async connect(port: number, token: string): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/extension`, { headers: { origin: "chrome-extension://fake" } });
    await new Promise<void>((resolve, reject) => {
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.send(JSON.stringify({ type: "hello", token, version: 1 }));
    this.ws.on("message", (raw) => void this.handle(JSON.parse(raw.toString())));
  }

  private send(message: unknown) {
    this.ws.send(JSON.stringify(message));
  }

  private async handle(message: any): Promise<void> {
    if (message.type !== "command") return;
    const { id, action } = message;
    if (action === "listTabs") return this.send({ type: "response", id, result: this.tabs });
    if (action === "createTab") {
      const tab = { id: this.nextTabId++, title: "New Tab", url: message.url, active: true };
      this.tabs.push(tab);
      this.send({ type: "tabs", tabs: this.tabs });
      return this.send({ type: "response", id, result: tab });
    }
    if (action === "closeTab") {
      this.tabs = this.tabs.filter((t) => t.id !== message.tabId);
      this.send({ type: "tabs", tabs: this.tabs });
      return this.send({ type: "response", id, result: { closed: message.tabId } });
    }
    if (action === "cdp") {
      const expression = String(message.params?.expression ?? "");
      if (message.method === "Runtime.evaluate") {
        if (expression.includes("document.title")) {
          return this.send({
            type: "response",
            id,
            result: { result: { value: { title: "Example", url: "https://example.com", nodes: [{ ref: "ubb-0", tag: "a" }] } } }
          });
        }
        return this.send({ type: "response", id, result: { result: { value: true } } });
      }
      return this.send({ type: "response", id, result: {} });
    }
    this.send({ type: "response", id, result: {} });
  }

  close(): void {
    this.ws.close();
  }
}

function waitForLine(child: ChildProcessWithoutNullStreams, pattern: RegExp, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${pattern} in: ${buffer}`)), timeoutMs);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const match = buffer.match(pattern);
      if (match) {
        clearTimeout(timer);
        child.stderr.off("data", onData);
        resolve(match[0]);
      }
    };
    child.stderr.on("data", onData);
  });
}

let tempDir: string;
let env: NodeJS.ProcessEnv;
let serveProcess: ChildProcessWithoutNullStreams | undefined;
let extension: FakeExtension | undefined;
const mcpClients: Client[] = [];
const mcpProcesses: ChildProcessWithoutNullStreams[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ubb-cli-test-"));
  env = {
    ...process.env,
    UBB_TOKEN_FILE: join(tempDir, "token"),
    UBB_SOCKET_PATH: join(tempDir, "daemon.sock"),
    UBB_PORT: "0"
  };
});

afterEach(async () => {
  for (const client of mcpClients.splice(0)) await client.close().catch(() => {});
  for (const child of mcpProcesses.splice(0)) child.kill();
  extension?.close();
  extension = undefined;
  serveProcess?.kill();
  serveProcess = undefined;
  await rm(tempDir, { recursive: true, force: true });
});

async function startServe(): Promise<{ port: number; token: string }> {
  serveProcess = spawn(TSX, ["src/cli.ts", "serve"], { cwd: PROJECT_ROOT, env });
  const line = await waitForLine(serveProcess, /Extension endpoint: 127\.0\.0\.1:(\d+)/);
  const port = Number(line.match(/:(\d+)$/)?.[1]);
  const token = await import("node:fs/promises").then((fs) => fs.readFile(env.UBB_TOKEN_FILE as string, "utf8"));
  return { port, token: token.trim() };
}

async function startMcpClient(label: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: TSX,
    args: ["src/cli.ts", "mcp"],
    cwd: PROJECT_ROOT,
    env: { ...env, UBB_CLIENT_LABEL: label },
    stderr: "pipe"
  });
  const client = new Client({ name: `test-${label}`, version: "0.0.1" });
  await client.connect(transport);
  mcpClients.push(client);
  return client;
}

const textOf = (result: any) => result.content?.find((c: any) => c.type === "text")?.text ?? "";

describe("CLI serve + mcp (real processes, no Chrome)", () => {
  it(
    "runs two simultaneous mcp adapters against one serve daemon end-to-end",
    async () => {
      const { port, token } = await startServe();
      extension = new FakeExtension();
      await extension.connect(port, token);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const clientA = await startMcpClient("client-a");
      const clientB = await startMcpClient("client-b");

      const statusA = JSON.parse(textOf(await clientA.callTool({ name: "browser_status", arguments: {} })));
      expect(statusA.connected).toBe(true);

      const newTab = JSON.parse(
        textOf(await clientA.callTool({ name: "browser_new_tab", arguments: { url: "https://example.com" } }))
      );
      const tabId = newTab.id;

      const tabsFromB = JSON.parse(textOf(await clientB.callTool({ name: "browser_tabs", arguments: {} })));
      expect(tabsFromB.some((t: any) => t.id === tabId)).toBe(true);

      const snapshot = JSON.parse(textOf(await clientA.callTool({ name: "browser_snapshot", arguments: { tabId } })));
      expect(snapshot.snapshotId).toBe(`${tabId}:0`);

      await clientA.callTool({ name: "browser_navigate", arguments: { url: "https://example.com/2", tabId } });

      const staleClick = await clientA.callTool({
        name: "browser_click",
        arguments: { ref: "ubb-0", description: "open link", snapshotId: snapshot.snapshotId, tabId }
      });
      expect(staleClick.isError).toBe(true);
      expect(textOf(staleClick)).toMatch(/stale/i);

      const closeByB = await clientB.callTool({ name: "browser_close_tab", arguments: { tabId } });
      expect(closeByB.isError).toBe(true);
      expect(textOf(closeByB)).toMatch(/owning client|owner/i);

      const closeByA = await clientA.callTool({ name: "browser_close_tab", arguments: { tabId } });
      expect(closeByA.isError).toBeFalsy();
    },
    20_000
  );

  it(
    "shuts down gracefully on SIGTERM, cleaning up the control socket",
    async () => {
      await startServe();
      const socketPath = env.UBB_SOCKET_PATH as string;
      expect(existsSync(socketPath)).toBe(true);

      const exited = new Promise<number>((resolve) => serveProcess!.once("exit", (code) => resolve(code ?? -1)));
      serveProcess!.kill("SIGTERM");
      const exitCode = await exited;
      serveProcess = undefined;

      expect(exitCode).toBe(0);
      expect(existsSync(socketPath)).toBe(false);
    },
    10_000
  );

  it(
    "gives a precise, fast error from mcp when no daemon is running",
    async () => {
      const child = spawn(TSX, ["src/cli.ts", "mcp"], {
        cwd: PROJECT_ROOT,
        env: { ...env, UBB_SOCKET_PATH: join(tempDir, "nothing-listens-here.sock") }
      });
      mcpProcesses.push(child);
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      const exitCode = await new Promise<number>((resolve) => child.once("exit", (code) => resolve(code ?? -1)));
      expect(exitCode).toBe(1);
      expect(stderr).toMatch(/serve/);
    },
    10_000
  );
});
