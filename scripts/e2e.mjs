// End-to-end smoke test: real MCP client -> dist/cli.js mcp -> relay -> extension -> Chrome.
//
// Prerequisites: `npm run build`, the extension loaded in Chrome and paired
// with the current token, and port 17321 free. If the extension is not yet
// connected the script waits up to 10 minutes for pairing.
//
// Run with: npm run e2e
// The suite opens tabs in the agent window, navigates to example.com and
// httpbin.org, and includes a deliberate 45s idle wait to verify the MV3
// service-worker keepalive.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCREENSHOT = process.env.E2E_SCREENSHOT_PATH ?? join(PROJECT, ".e2e-screenshot.png");

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

// Set E2E_BINARY=/path/to/compiled-binary to smoke-test the bun-compiled
// executable instead of the Node build.
const transport = new StdioClientTransport({
  command: process.env.E2E_BINARY ?? "node",
  args: process.env.E2E_BINARY ? ["mcp"] : ["dist/cli.js", "mcp"],
  cwd: PROJECT,
  stderr: "inherit"
});
const client = new Client({ name: "ubb-e2e", version: "0.0.1" });
await client.connect(transport);

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const textOf = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tool listing sanity check
const { tools } = await client.listTools();
record("list tools", tools.length === 10, tools.map((t) => t.name).join(", "));

// Wait up to 10 minutes for the user to reload the extension and paste the token
let status = { connected: false };
for (let i = 0; i < 600; i++) {
  status = JSON.parse(textOf(await call("browser_status")));
  if (status.connected) break;
  if (i % 15 === 0) console.log(`waiting for extension to pair... (${i}s)`);
  await sleep(1000);
}
record("extension paired", status.connected, JSON.stringify(status));
if (!status.connected) {
  await client.close();
  process.exit(1);
}

// Open an agent-owned tab
const newTab = await call("browser_new_tab", { url: "https://example.com" });
record("browser_new_tab", !newTab.isError, textOf(newTab).slice(0, 120));
await sleep(1500);

// Fresh tab list should include it
const tabsRes = JSON.parse(textOf(await call("browser_tabs")));
const exampleTab = tabsRes.find((t) => t.url.includes("example.com"));
record("browser_tabs shows shared tab", Boolean(exampleTab), JSON.stringify(tabsRes));
const tabId = exampleTab?.id;

// Snapshot returns refs
const snap1 = JSON.parse(textOf(await call("browser_snapshot", { tabId })));
const link = snap1.nodes?.find((n) => n.tag === "a");
record("browser_snapshot", snap1.url?.includes("example.com") && Boolean(link),
  `title=${snap1.title}, nodes=${snap1.nodes?.length}`);

// SECURITY: file:// navigation must be rejected by schema validation
const fileNav = await call("browser_navigate", { url: "file:///etc/passwd", tabId });
record("file:// navigation rejected", fileNav.isError === true, textOf(fileNav).slice(0, 140));

// SECURITY: unconfirmed Enter must be rejected
const enterNo = await call("browser_press", { key: "Enter", tabId });
record("unconfirmed Enter rejected", enterNo.isError === true && /Confirmation required/.test(textOf(enterNo)),
  textOf(enterNo).slice(0, 140));

// Non-consequential key works without confirmation (full descriptor path)
const arrow = await call("browser_press", { key: "ArrowDown", tabId });
record("browser_press ArrowDown", !arrow.isError, textOf(arrow));

// Scroll
const scroll = JSON.parse(textOf(await call("browser_scroll", { deltaY: 300, tabId })));
record("browser_scroll", typeof scroll.y === "number", JSON.stringify(scroll));

// Click the example.com link (harmless navigation) with an innocuous description
const click = await call("browser_click", {
  ref: link.ref, description: "open the informational IANA link", confirmed: false, tabId
});
record("browser_click via ref", !click.isError, textOf(click));
await sleep(2000);

// SECURITY: consequential click description requires confirmed=true
const conseq = await call("browser_click", {
  ref: "ubb-0", description: "submit the order and pay", confirmed: false, tabId
});
record("consequential click gated", conseq.isError === true && /Confirmation required/.test(textOf(conseq)),
  textOf(conseq).slice(0, 140));

// Navigate to a form page and test typing through the ref pipeline
const nav = await call("browser_navigate", { url: "https://httpbin.org/forms/post", tabId });
record("browser_navigate http(s)", !nav.isError, textOf(nav).slice(0, 100));
await sleep(3000);

// Refs from the previous page must fail loudly, not silently succeed
const stale = await call("browser_click", {
  ref: "ubb-0", description: "open a stale element", confirmed: false, tabId
});
record("stale ref rejected after navigation", stale.isError === true && /ref expired/i.test(textOf(stale)),
  textOf(stale).slice(0, 120));
const snap2 = JSON.parse(textOf(await call("browser_snapshot", { tabId })));
const input = snap2.nodes?.find((n) => n.tag === "input" && (n.type === "text" || n.type === "tel"));
if (input) {
  const typed = await call("browser_type", { ref: input.ref, text: "e2e test value", tabId });
  const snap3 = JSON.parse(textOf(await call("browser_snapshot", { tabId })));
  const after = snap3.nodes?.find((n) => n.tag === "input" && n.value === "e2e test value");
  record("browser_type round-trip", !typed.isError && Boolean(after), `input ref=${input.ref}`);
} else {
  record("browser_type round-trip", false, "no text input found on form page");
}

// Screenshot
const shot = await call("browser_screenshot", { tabId });
const image = shot.content?.find((c) => c.type === "image");
if (image) writeFileSync(SCREENSHOT, Buffer.from(image.data, "base64"));
record("browser_screenshot", Boolean(image), image ? `${Math.round(image.data.length * 0.75 / 1024)} KB png` : "");

// KEEPALIVE: MV3 service worker idle timeout is 30s; connection must survive 45s of silence
console.log("waiting 45s to verify the service-worker keepalive...");
await sleep(45_000);
const alive = JSON.parse(textOf(await call("browser_status")));
record("connection survives 45s idle (keepalive)", alive.connected === true, JSON.stringify(alive.tabs?.length));

const failed = results.filter((r) => !r.ok);
console.log(`\n=== E2E RESULT: ${results.length - failed.length}/${results.length} passed ===`);
await client.close();
process.exit(failed.length ? 1 : 0);
