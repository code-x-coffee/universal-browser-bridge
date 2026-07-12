import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { BrowserBridge } from "./bridge.js";
import { requireConfirmation } from "./policy.js";

const KEY_DESCRIPTORS: Record<string, { code: string; windowsVirtualKeyCode: number; text?: string }> = {
  Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
  NumpadEnter: { code: "NumpadEnter", windowsVirtualKeyCode: 13, text: "\r" },
  Tab: { code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { code: "Backspace", windowsVirtualKeyCode: 8 },
  Delete: { code: "Delete", windowsVirtualKeyCode: 46 },
  ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39 },
  Home: { code: "Home", windowsVirtualKeyCode: 36 },
  End: { code: "End", windowsVirtualKeyCode: 35 },
  PageUp: { code: "PageUp", windowsVirtualKeyCode: 33 },
  PageDown: { code: "PageDown", windowsVirtualKeyCode: 34 }
};

const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:$/.test(new URL(value).protocol), {
    message: "Only http: and https: URLs are allowed"
  });

const selectorScript = String.raw`
(() => {
  document.querySelectorAll('[data-ubb-ref]').forEach((el) => el.removeAttribute('data-ubb-ref'));
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const nodes = [...document.querySelectorAll('a,button,input,textarea,select,[role],[contenteditable="true"]')]
    .filter(visible)
    .slice(0, 250)
    .map((el, index) => {
      const ref = 'ubb-' + index;
      el.setAttribute('data-ubb-ref', ref);
      const rect = el.getBoundingClientRect();
      return {
        ref,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        type: el.getAttribute('type') || undefined,
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 300),
        value: 'value' in el && el.type !== 'password' ? String(el.value).slice(0, 300) : undefined,
        disabled: Boolean(el.disabled),
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2)
      };
    });
  return { title: document.title, url: location.href, nodes };
})()
`;

function selectedTab(bridge: BrowserBridge, requested?: number): number {
  const tabs = bridge.status().tabs;
  const tab = requested ? tabs.find((item) => item.id === requested) : tabs.find((item) => item.active) ?? tabs[0];
  if (!tab) throw new Error("No shared tab is available. Click the extension icon on a Chrome tab to share it.");
  return tab.id;
}

async function cdp(
  bridge: BrowserBridge,
  tabId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<any> {
  return bridge.command({ action: "cdp", tabId, method, params });
}

// Runtime.evaluate reports page-script throws via exceptionDetails instead of
// failing the CDP call, so surface those as real errors and unwrap the value.
async function evaluate(bridge: BrowserBridge, tabId: number, expression: string): Promise<unknown> {
  const result = await cdp(bridge, tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  });
  if (result?.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Page script failed"
    );
  }
  return result?.result?.value;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

export async function runMcpServer(bridge: BrowserBridge): Promise<void> {
  const server = new McpServer({ name: "universal-browser-bridge", version: "0.1.0" });

  server.tool("browser_status", "Show extension connection and explicitly shared tabs.", {}, async () => text(bridge.status()));

  server.tool("browser_tabs", "List only the Chrome tabs explicitly shared with agents.", {}, async () =>
    text(await bridge.command({ action: "listTabs" }))
  );

  server.tool(
    "browser_new_tab",
    "Open a new agent-owned tab and share it automatically.",
    { url: httpUrl },
    async ({ url }) => text(await bridge.command({ action: "createTab", url }))
  );

  server.tool(
    "browser_snapshot",
    "Read the current page as compact interactive elements. Use the returned refs for click and type.",
    { tabId: z.number().int().optional() },
    async ({ tabId }) => {
      const id = selectedTab(bridge, tabId);
      return text(await evaluate(bridge, id, selectorScript));
    }
  );

  server.tool(
    "browser_navigate",
    "Navigate a shared tab to a URL.",
    { url: httpUrl, tabId: z.number().int().optional() },
    async ({ url, tabId }) => text(await cdp(bridge, selectedTab(bridge, tabId), "Page.navigate", { url }))
  );

  server.tool(
    "browser_click",
    "Click an element from browser_snapshot. Consequential actions require explicit user confirmation.",
    {
      ref: z.string().regex(/^ubb-\d+$/),
      description: z.string().min(1),
      confirmed: z.boolean().default(false),
      tabId: z.number().int().optional()
    },
    async ({ ref, description, confirmed, tabId }) => {
      requireConfirmation(description, confirmed);
      const expression = `(() => { const el = document.querySelector('[data-ubb-ref="${ref}"]'); if (!el) throw new Error('Element ref expired; take a new snapshot'); el.click(); return true; })()`;
      return text(await evaluate(bridge, selectedTab(bridge, tabId), expression));
    }
  );

  server.tool(
    "browser_type",
    "Replace the contents of a shared-page input using a ref from browser_snapshot.",
    { ref: z.string().regex(/^ubb-\d+$/), text: z.string(), tabId: z.number().int().optional() },
    async ({ ref, text: input, tabId }) => {
      const expression = `(() => { const el = document.querySelector('[data-ubb-ref="${ref}"]'); if (!el) throw new Error('Element ref expired; take a new snapshot'); el.focus(); if ('value' in el) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; setter ? setter.call(el, ${JSON.stringify(input)}) : el.value = ${JSON.stringify(input)}; } else { el.textContent = ${JSON.stringify(input)}; } el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); return true; })()`;
      return text(await evaluate(bridge, selectedTab(bridge, tabId), expression));
    }
  );

  server.tool(
    "browser_press",
    "Press a keyboard key in a shared tab. Enter can submit forms, so it requires explicit user confirmation.",
    {
      key: z.string().min(1).max(30),
      confirmed: z.boolean().default(false),
      tabId: z.number().int().optional()
    },
    async ({ key, confirmed, tabId }) => {
      if (/^(enter|numpadenter)$/i.test(key)) {
        requireConfirmation(`press ${key} which may submit a form`, confirmed);
      }
      const id = selectedTab(bridge, tabId);
      const descriptor = KEY_DESCRIPTORS[key] ?? (key.length === 1 ? { text: key } : {});
      const params = { key, ...descriptor };
      await cdp(bridge, id, "Input.dispatchKeyEvent", { type: params.text ? "keyDown" : "rawKeyDown", ...params });
      await cdp(bridge, id, "Input.dispatchKeyEvent", { type: "keyUp", ...params });
      return text({ pressed: key });
    }
  );

  server.tool(
    "browser_scroll",
    "Scroll a shared page by a number of pixels.",
    { deltaY: z.number().int().min(-10000).max(10000), tabId: z.number().int().optional() },
    async ({ deltaY, tabId }) => {
      const expression = `window.scrollBy({top:${deltaY},behavior:'instant'}); ({x:scrollX,y:scrollY})`;
      return text(await evaluate(bridge, selectedTab(bridge, tabId), expression));
    }
  );

  server.tool(
    "browser_screenshot",
    "Capture a PNG screenshot from a shared tab and return it as MCP image content.",
    { tabId: z.number().int().optional() },
    async ({ tabId }) => {
      const result = await cdp(bridge, selectedTab(bridge, tabId), "Page.captureScreenshot", { format: "png" });
      if (!result?.data) throw new Error("Chrome did not return screenshot data");
      return { content: [{ type: "image" as const, data: result.data, mimeType: "image/png" }] };
    }
  );

  await server.connect(new StdioServerTransport());
}
