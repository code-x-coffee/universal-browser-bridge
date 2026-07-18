// End-to-end smoke test: this script spawns the real `serve` daemon, then two
// real MCP clients -> dist/cli.js mcp -> daemon control socket -> extension
// WebSocket -> Chrome, proving the daemon + multi-adapter architecture works
// against a live extension.
//
// Prerequisites: `npm run build`, the extension loaded in Chrome and paired
// with the current token. If the extension is not yet connected the script
// waits up to 10 minutes for pairing. Uses UBB_PORT=0 (ephemeral) unless
// E2E_PORT is set, so it never collides with a `serve` you already have
// running — repoint the extension's relay URL at the printed port to pair.
//
// Run with: npm run e2e
// The suite opens tabs in the agent window, navigates to example.com and
// httpbin.org, and includes a deliberate 45s idle wait to verify the MV3
// service-worker keepalive. Every exception or early failure runs the same
// cleanup path (see run()'s finally block): both MCP client connections are
// closed and the spawned `serve` process is terminated, so a failing run
// never leaves orphaned serve/mcp processes behind.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCREENSHOT = process.env.E2E_SCREENSHOT_PATH ?? join(PROJECT, ".e2e-screenshot.png");
const BINARY = process.env.E2E_BINARY;

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (result) => result.content?.find((c) => c.type === "text")?.text ?? "";

// A failed tool call's text is a plain error message, not JSON — never feed
// it to JSON.parse (that throws an opaque SyntaxError that obscures the real
// failure). Surface the real error message instead, and only attempt to
// parse JSON when the call actually succeeded.
function readJson(result, label) {
  const raw = textOf(result);
  if (result.isError) throw new Error(`${label} failed: ${raw}`);
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} did not return JSON: ${raw.slice(0, 200)}`);
  }
}

// Set E2E_BINARY=/path/to/compiled-binary to smoke-test the bun-compiled
// executable instead of the Node build.
function mcpTransport(label) {
  return new StdioClientTransport({
    command: BINARY ?? "node",
    args: BINARY ? ["mcp"] : ["dist/cli.js", "mcp"],
    cwd: PROJECT,
    env: { ...process.env, UBB_CLIENT_LABEL: label },
    stderr: "inherit"
  });
}

async function startServe() {
  const serveProcess = spawn(BINARY ?? "node", BINARY ? ["serve"] : ["dist/cli.js", "serve"], {
    cwd: PROJECT,
    env: { ...process.env, UBB_PORT: process.env.E2E_PORT ?? "0" }
  });
  let serveBanner = "";
  try {
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not start in time: ${serveBanner}`)), 10_000);
      serveProcess.stderr.on("data", (chunk) => {
        serveBanner += chunk.toString();
        process.stderr.write(chunk);
        const match = serveBanner.match(/Extension endpoint: 127\.0\.0\.1:(\d+)/);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
      serveProcess.once("exit", (code) => reject(new Error(`serve exited early with code ${code}`)));
    });
    console.log(`serve daemon is up (extension endpoint 127.0.0.1:${port}). Pair the extension at ws://127.0.0.1:${port}/extension if needed.`);
    return { serveProcess, port };
  } catch (error) {
    serveProcess.kill();
    throw error;
  }
}

// Runs the actual scenario against two already-connected MCP clients. Any
// thrown error here (including via readJson on an unexpected tool failure)
// propagates to run()'s single cleanup path.
async function runScenario(client, secondClient) {
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const callSecond = (name, args = {}) => secondClient.callTool({ name, arguments: args });

  // Tool listing sanity check
  const { tools } = await client.listTools();
  record("list tools", tools.length === 11, tools.map((t) => t.name).join(", "));

  // Wait up to 10 minutes for the user to reload the extension and pair it
  let status = { connected: false };
  for (let i = 0; i < 600; i++) {
    status = readJson(await call("browser_status"), "browser_status");
    if (status.connected) break;
    if (i % 15 === 0) console.log(`waiting for extension to pair... (${i}s)`);
    await sleep(1000);
  }
  record("extension paired", status.connected, JSON.stringify(status));
  if (!status.connected) throw new Error("extension never paired");

  const secondStatus = readJson(await callSecond("browser_status"), "browser_status (second adapter)");
  record("second simultaneous adapter shares status", secondStatus.connected === true, JSON.stringify(secondStatus));

  // Open an agent-owned tab
  const newTab = await call("browser_new_tab", { url: "https://example.com" });
  record("browser_new_tab", !newTab.isError, textOf(newTab).slice(0, 120));
  const createdTab = readJson(newTab, "browser_new_tab");
  const tabId = createdTab.id;
  await sleep(1500);

  // A tab created by the primary adapter cannot be closed by another adapter
  const closeByOther = await callSecond("browser_close_tab", { tabId });
  record(
    "other adapter cannot close this tab",
    closeByOther.isError === true && /owning client|owner/i.test(textOf(closeByOther)),
    textOf(closeByOther).slice(0, 140)
  );

  // Fresh tab list should include it
  const tabsRes = readJson(await call("browser_tabs"), "browser_tabs");
  const exampleTab = tabsRes.find((t) => t.id === tabId);
  record("browser_tabs shows shared tab", Boolean(exampleTab), JSON.stringify(tabsRes));

  // Snapshot returns refs and a snapshotId
  const snap1 = readJson(await call("browser_snapshot", { tabId }), "browser_snapshot");
  const link = snap1.nodes?.find((n) => n.tag === "a");
  record(
    "browser_snapshot",
    snap1.url?.includes("example.com") && Boolean(link) && Boolean(snap1.snapshotId),
    `title=${snap1.title}, nodes=${snap1.nodes?.length}, snapshotId=${snap1.snapshotId}`
  );

  // SECURITY: file:// navigation must be rejected by schema validation
  const fileNav = await call("browser_navigate", { url: "file:///etc/passwd", tabId });
  record("file:// navigation rejected", fileNav.isError === true, textOf(fileNav).slice(0, 140));

  // Non-consequential key works without confirmation (full descriptor path)
  const arrow = await call("browser_press", { key: "ArrowDown", tabId });
  record("browser_press ArrowDown", !arrow.isError, textOf(arrow));

  // Scroll
  const scroll = readJson(await call("browser_scroll", { deltaY: 300, tabId }), "browser_scroll");
  record("browser_scroll", typeof scroll.y === "number", JSON.stringify(scroll));

  // Click the example.com link (harmless navigation) with an innocuous description
  const click = await call("browser_click", {
    ref: link.ref,
    description: "open the informational IANA link",
    snapshotId: snap1.snapshotId,
    tabId
  });
  record("browser_click via ref", !click.isError, textOf(click));
  await sleep(2000);

  // Navigate to a form page; this invalidates the snapshot generation
  const nav = await call("browser_navigate", { url: "https://httpbin.org/forms/post", tabId });
  record("browser_navigate http(s)", !nav.isError, textOf(nav).slice(0, 100));
  await sleep(3000);

  // A snapshotId from before the navigation must be rejected, not silently accepted
  const stale = await call("browser_click", {
    ref: "ubb-0",
    description: "open a stale element",
    snapshotId: snap1.snapshotId,
    tabId
  });
  record(
    "stale snapshotId rejected after navigation",
    stale.isError === true && /stale/i.test(textOf(stale)),
    textOf(stale).slice(0, 120)
  );
  const snap2 = readJson(await call("browser_snapshot", { tabId }), "browser_snapshot (after navigate)");
  const input = snap2.nodes?.find((n) => n.tag === "input" && (n.type === "text" || n.type === "tel"));
  if (input) {
    const typed = await call("browser_type", { ref: input.ref, text: "e2e test value", snapshotId: snap2.snapshotId, tabId });
    const snap3 = readJson(await call("browser_snapshot", { tabId }), "browser_snapshot (after type)");
    const after = snap3.nodes?.find((n) => n.tag === "input" && n.value === "e2e test value");
    record("browser_type round-trip", !typed.isError && Boolean(after), `input ref=${input.ref}`);
  } else {
    record("browser_type round-trip", false, "no text input found on form page");
  }

  // Screenshot
  const shot = await call("browser_screenshot", { tabId });
  const image = shot.content?.find((c) => c.type === "image");
  if (image) writeFileSync(SCREENSHOT, Buffer.from(image.data, "base64"));
  record("browser_screenshot", Boolean(image), image ? `${Math.round((image.data.length * 0.75) / 1024)} KB png` : "");

  // KEEPALIVE: MV3 service worker idle timeout is 30s; connection must survive 45s of silence
  console.log("waiting 45s to verify the service-worker keepalive...");
  await sleep(45_000);
  const alive = readJson(await call("browser_status"), "browser_status (post-keepalive)");
  record("connection survives 45s idle (keepalive)", alive.connected === true, JSON.stringify(alive.tabs?.length));

  const closed = await call("browser_close_tab", { tabId });
  record("browser_close_tab cleans up agent tab", !closed.isError, textOf(closed));
}

async function run() {
  let serveProcess;
  let client;
  let secondClient;
  let exitCode = 1;
  try {
    ({ serveProcess } = await startServe());

    client = new Client({ name: "ubb-e2e-primary", version: "0.0.1" });
    await client.connect(mcpTransport("e2e-primary"));
    secondClient = new Client({ name: "ubb-e2e-secondary", version: "0.0.1" });
    await secondClient.connect(mcpTransport("e2e-secondary"));

    await runScenario(client, secondClient);

    const failed = results.filter((r) => !r.ok);
    console.log(`\n=== E2E RESULT: ${results.length - failed.length}/${results.length} passed ===`);
    exitCode = failed.length ? 1 : 0;
  } catch (error) {
    console.error(`\nE2E run failed: ${error?.message ?? error}`);
    exitCode = 1;
  } finally {
    // Every exit path — success, a recorded failure, or an uncaught
    // exception anywhere above — goes through this same cleanup, so a
    // failing run never leaves orphaned serve/mcp processes behind.
    await Promise.allSettled([client?.close(), secondClient?.close()]);
    serveProcess?.kill();
  }
  process.exit(exitCode);
}

await run();
