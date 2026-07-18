import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { DaemonClient } from "./daemon-client.js";
import { assertBrowserUrlAllowed } from "./url-policy.js";

const httpUrl = z
  .string()
  .url()
  .refine(assertBrowserUrlAllowed, {
    message: "Only public http(s) URLs are allowed. Set UBB_ALLOW_PRIVATE_NETWORKS=1 to allow localhost and private networks."
  });

async function selectedTab(bridge: DaemonClient, requested?: number): Promise<number> {
  const status = await bridge.status();
  const tab = requested ? status.tabs.find((item) => item.id === requested) : status.tabs.find((item) => item.active) ?? status.tabs[0];
  if (!tab) throw new Error("No shared tab is available. Click the extension icon on a Chrome tab to share it.");
  return tab.id;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export async function runMcpServer(bridge: DaemonClient): Promise<void> {
  const server = new McpServer({ name: "universal-browser-bridge", version: "0.1.0" });

  server.tool("browser_status", "Show extension connection and explicitly shared tabs.", {}, async () => text(await bridge.status()));

  server.tool("browser_tabs", "List only the Chrome tabs explicitly shared with agents.", {}, async () =>
    text(await bridge.request({ action: "listTabs" }))
  );

  server.tool(
    "browser_new_tab",
    "Open a tab in the dedicated agent window. Chrome asks for a one-time session grant before creating that window. Only this client may close the tab it creates.",
    { url: httpUrl },
    async ({ url }) => text(await bridge.request({ action: "createTab", url }))
  );

  server.tool(
    "browser_close_tab",
    "Close an agent-created tab that this client created. User-owned shared tabs, and tabs created by other clients, cannot be closed by this tool.",
    { tabId: z.number().int() },
    async ({ tabId }) => text(await bridge.request({ action: "closeTab", tabId }))
  );

  server.tool(
    "browser_snapshot",
    "Read the current page as compact interactive elements. Returns a snapshotId that must be passed to browser_click/browser_type; it goes stale after navigation.",
    { tabId: z.number().int().optional() },
    async ({ tabId }) => {
      const id = await selectedTab(bridge, tabId);
      return text(await bridge.request({ action: "snapshot", tabId: id }));
    }
  );

  server.tool(
    "browser_navigate",
    "Navigate a shared tab to a URL. Invalidates any snapshotId previously taken for this tab.",
    { url: httpUrl, tabId: z.number().int().optional() },
    async ({ url, tabId }) => text(await bridge.request({ action: "navigate", tabId: await selectedTab(bridge, tabId), url }))
  );

  server.tool(
    "browser_click",
    "Click an element from browser_snapshot. Requires the snapshotId from that snapshot; stale snapshots (e.g. after navigation) are rejected. Consequential actions require explicit user confirmation; the daemon decides and enforces this, not the calling adapter.",
    {
      ref: z.string().regex(/^ubb-\d+$/),
      description: z.string().min(1),
      snapshotId: z.string().min(1),
      tabId: z.number().int().optional()
    },
    async ({ ref, description, snapshotId, tabId }) =>
      text(await bridge.request({ action: "click", tabId: await selectedTab(bridge, tabId), ref, description, snapshotId }))
  );

  server.tool(
    "browser_type",
    "Replace the contents of a shared-page input using a ref and snapshotId from browser_snapshot.",
    { ref: z.string().regex(/^ubb-\d+$/), text: z.string(), snapshotId: z.string().min(1), tabId: z.number().int().optional() },
    async ({ ref, text: input, snapshotId, tabId }) =>
      text(await bridge.request({ action: "type", tabId: await selectedTab(bridge, tabId), ref, text: input, snapshotId }))
  );

  server.tool(
    "browser_press",
    "Press a keyboard key in a shared tab. Enter can submit forms, so it requires explicit user confirmation; the daemon decides and enforces this, not the calling adapter.",
    {
      key: z.string().min(1).max(30),
      tabId: z.number().int().optional()
    },
    async ({ key, tabId }) => text(await bridge.request({ action: "press", tabId: await selectedTab(bridge, tabId), key }))
  );

  server.tool(
    "browser_scroll",
    "Scroll a shared page by a number of pixels.",
    { deltaY: z.number().int().min(-10000).max(10000), tabId: z.number().int().optional() },
    async ({ deltaY, tabId }) => text(await bridge.request({ action: "scroll", tabId: await selectedTab(bridge, tabId), deltaY }))
  );

  server.tool(
    "browser_screenshot",
    "Capture a PNG screenshot from a shared tab and return it as MCP image content.",
    { tabId: z.number().int().optional() },
    async ({ tabId }) => {
      const result = (await bridge.request({ action: "screenshot", tabId: await selectedTab(bridge, tabId) })) as { data?: string };
      if (!result?.data) throw new Error("Chrome did not return screenshot data");
      return { content: [{ type: "image" as const, data: result.data, mimeType: "image/png" }] };
    }
  );

  await server.connect(new StdioServerTransport());
}
