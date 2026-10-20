import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { DaemonClient } from "./daemon-client.js";
import { assertBrowserUrlAllowed } from "./url-policy.js";
import { annotationIdSchema, annotationReplySchema, annotationStatusSchema } from "./annotations.js";
import { assertDownloadSource } from "./download-policy.js";

const httpUrl = z
  .string()
  .url()
  .refine(assertBrowserUrlAllowed, {
    message: "Only public http(s) URLs are allowed. Set UBB_ALLOW_PRIVATE_NETWORKS=1 to allow localhost and private networks."
  });

async function selectedTab(bridge: DaemonClient, requested?: number): Promise<number> {
  // Explicit IDs are authorized by the daemon/extension, which can report a
  // precise ownership error instead of hiding it behind a selection failure.
  if (requested !== undefined) return requested;
  const status = await bridge.status();
  const tab = status.tabs.find((item) => item.active) ?? status.tabs[0];
  if (!tab) throw new Error("No shared or agent-owned tab is available. Share a tab or call browser_new_tab.");
  return tab.id;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export async function runMcpServer(bridge: DaemonClient, transport: Transport = new StdioServerTransport()): Promise<void> {
  const server = new McpServer({ name: "universal-browser-bridge", version: "0.1.0" });

  server.tool("browser_status", "Show extension connection, shared tabs and tabs owned by your agent label.", {}, async () => text(await bridge.status()));

  server.tool("browser_tabs", "List Chrome tabs shared with agents or owned by your agent label.", {}, async () =>
    text(await bridge.request({ action: "listTabs" }))
  );

  server.tool("browser_list_agent_tabs", "List tabs owned by your agent label, including tabId, url, title and groupId. Requires a label. Recorded ownership can survive extension reloads after exact label/group-title and agent-window validation; other tabs in the group are never adopted.", {}, async () =>
    text(await bridge.request({ action: "listAgentTabs" }))
  );

  server.tool(
    "annotations_list",
    "List saved page annotations, optionally filtered by exact URL and status. Includes absolute screenshot paths; works without Chrome connected.",
    { url: z.string().optional(), status: annotationStatusSchema.optional() },
    async ({ url, status }) => text(await bridge.request({ action: "annotationsList", url, status }))
  );
  server.tool(
    "annotations_get",
    "Get one annotation by ID, or all annotations for an exact URL. Supply exactly one of id or url. Includes absolute screenshotPath.",
    { id: annotationIdSchema.optional(), url: z.string().optional() },
    async ({ id, url }) => text(await bridge.request({ action: "annotationsGet", annotationId: id, url }))
  );
  server.tool(
    "annotations_resolve",
    "Resolve an annotation with an optional resolution note and update its pins on open shared tabs.",
    { id: annotationIdSchema, note: z.string().max(10_000).optional() },
    async ({ id, note }) => text(await bridge.request({ action: "annotationsResolve", annotationId: id, note }))
  );

  server.tool(
    "annotations_reply",
    "Reply to an open or resolved annotation and update its pins on open shared tabs. Author defaults to agent.",
    { id: annotationIdSchema, ...annotationReplySchema.shape },
    async ({ id, text: replyText, author }) => text(await bridge.request({ action: "annotationsReply", annotationId: id, text: replyText, author }))
  );
  server.tool(
    "browser_new_tab",
    "Open a tab in the dedicated agent window. With a label, use that literal label as the group title and durably own the tab across client invocations and extension reloads, subject to stored group/window validation. Without a label, create an unowned shared tab. Explicit debugging cancellation revokes ownership. The window is created without a prompt by default. Chrome asks first only if the user turned off \"Let agents open their window without asking\".",
    { url: httpUrl },
    async ({ url }) => text(await bridge.request({ action: "createTab", url }))
  );

  server.tool(
    "browser_close_tab",
    "Close a tab owned by your agent label or otherwise shared with you. Tabs owned by other labels cannot be closed.",
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
    "Scroll an element from browser_snapshot into view and click its center with trusted mouse input when visible and hit-testable. Otherwise use a script click with user activation. Returns { clicked: true, method: 'mouse' | 'script' }. Requires the snapshotId from that snapshot; stale snapshots (e.g. after navigation) are rejected. Consequential actions require explicit user confirmation; the daemon decides and enforces this, not the calling adapter.",
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
    "Replace the contents of a shared-page input using a ref and snapshotId from browser_snapshot. The focus/value script runs with user activation.",
    { ref: z.string().regex(/^ubb-\d+$/), text: z.string(), snapshotId: z.string().min(1), tabId: z.number().int().optional() },
    async ({ ref, text: input, snapshotId, tabId }) =>
      text(await bridge.request({ action: "type", tabId: await selectedTab(bridge, tabId), ref, text: input, snapshotId }))
  );

  server.tool(
    "browser_upload_file",
    "Attach local files in a tab owned by your agent label. Mode auto (default) uses a file input or associated label/descendant when available, otherwise clicks the ref and intercepts its file chooser. Mode input requires a file input; mode chooser always clicks. Chooser mode waits up to 5 s and temporarily shims showOpenFilePicker with file-handle-like objects, which may fail instanceof FileSystemFileHandle checks. Returns uploaded, files, method (input/chooser) and picker (input/showOpenFilePicker). Files must be inside a folder the user allowed in Extension options. Never available in hand-shared tabs, blocklisted sites, or bank/card/payment/password-manager pages. Requires description and the ref and snapshotId from browser_snapshot; consequential chooser clicks require approval.",
    {
      ref: z.string().regex(/^ubb-\d+$/),
      description: z.string().min(1),
      snapshotId: z.string().min(1),
      files: z.array(z.string()).min(1).max(10),
      mode: z.enum(["auto", "input", "chooser"]).optional(),
      tabId: z.number().int().optional()
    },
    async ({ ref, description, snapshotId, files, mode, tabId }) =>
      text(await bridge.request({ action: "uploadFile", tabId: await selectedTab(bridge, tabId), ref, description, snapshotId, files, ...(mode === undefined ? {} : { mode }) }))
  );

  server.tool(
    "browser_download",
    "Save media from a tab owned by your agent label without Chrome's Save As prompt. Supply either ref + snapshotId from browser_snapshot (video/audio/source/img/a) or url, plus filename and description. URLs must be same-origin http(s), cross-origin HTTPS matching an exact hostname or explicit leading *. wildcard under Trusted download hosts in Extension options, blob URLs of the tab origin, or data URLs. A wildcard matches subdomains at any depth, excludes the bare base, and needs at least two base labels. Matching ignores case and a trailing dot. No public suffix list is checked (so *.co.uk is accepted). For Google Flow, examples are *.googlevideo.com for clip nodes and flow-content.google for thumbnails. Trusted hosts default to empty; agents cannot change them. Every redirect must use HTTPS and be same-origin or trusted (10-hop cap), checked before the next request. Host blocklists still apply. Same-origin HTTP(S) first uses the page-Blob path with manual redirects; only opaqueredirect retries via interception, requesting that source twice. Trusted cross-origin HTTPS goes directly through Chrome debugger interception despite CORS, with cookies kept inside Chrome. Video/audio/source snapshot nodes show srcHost only; refusal errors name only the refused hostname, never signed paths or queries. Saves up to 500 MB in an allowed download folder from Extension options. Folder defaults to the first configured folder; subfolder must be relative. Filenames are sanitized and collisions get numeric suffixes without overwriting. Ref downloads require a current snapshot. Hand-shared, blocked and bank/card/payment/password-manager tabs cannot download. Returns saved (real path), bytes and mimeType.",
    {
      ref: z.string().regex(/^ubb-\d+$/).optional(), snapshotId: z.string().min(1).optional(), url: z.string().min(1).optional(),
      filename: z.string().min(1), description: z.string().min(1),
      folder: z.string().optional(), subfolder: z.string().optional(), tabId: z.number().int().optional()
    },
    async ({ tabId, ...args }) => {
      assertDownloadSource(args);
      return text(await bridge.request({ action: "download", tabId: await selectedTab(bridge, tabId), ...args }));
    }
  );

  server.tool(
    "browser_press",
    "Press a keyboard key in a shared tab using trusted CDP keyboard input. Enter and NumpadEnter can submit forms, so they require explicit user confirmation; the daemon decides and enforces this, not the calling adapter.",
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

  await server.connect(transport);
}
