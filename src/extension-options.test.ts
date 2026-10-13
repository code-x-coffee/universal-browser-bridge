import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./test-support/chrome-mock.js";

const html = await readFile(new URL("../extension/options.html", import.meta.url), "utf8");
class Field {
  value = "";
  checked = false;
  textContent = "";
  events = new Map<string, () => Promise<void>>();
  addEventListener(type: string, listener: () => Promise<void>) { this.events.set(type, listener); }
}
let fields: Map<string, Field>;
let mock: ReturnType<typeof createChromeMock>;
async function load(saved: Record<string, unknown> = {}) {
  await mock.chrome.storage.local.set(saved);
  // @ts-expect-error Plain extension JavaScript imported for side effects.
  await import("../extension/options.js");
  await vi.advanceTimersByTimeAsync(0);
}
const field = (id: string) => fields.get(id)!;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  fields = new Map([...html.matchAll(/<(?:input|textarea|button|span)\b[^>]*\bid="([^"]+)"/g)].map((match) => [match[1]!, new Field()]));
  mock = createChromeMock();
  vi.stubGlobal("chrome", mock.chrome);
  vi.stubGlobal("document", { querySelector: (selector: string) => fields.get(selector.slice(1)) });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it("shows trust enabled and an empty blocklist on first use", async () => {
  await load();
  expect(field("trustAgentOwnedTabs")?.checked).toBe(true);
  expect(field("blockedDomains")?.value).toBe("");
});

it("loads the saved trust preference and blocklist", async () => {
  await load({ trustAgentOwnedTabs: false, blockedDomains: ["example.com", "vault.example.org"] });
  expect(field("trustAgentOwnedTabs").checked).toBe(false);
  expect(field("blockedDomains").value).toBe("example.com\nvault.example.org");
});

it("saves normalized domains and the trust checkbox without changing pairing settings", async () => {
  await load({ relayUrl: "ws://127.0.0.1:17322/extension", token: "saved-token" });
  field("trustAgentOwnedTabs").checked = false;
  field("blockedDomains").value = "HTTPS://WWW.Example.COM/path\r\n\nexample.com\nvault.example.org/private";
  await field("savePolicy").events.get("click")!();
  expect(await mock.chrome.storage.local.get(["trustAgentOwnedTabs", "blockedDomains", "relayUrl", "token"]))
    .toEqual({ trustAgentOwnedTabs: false, blockedDomains: ["example.com", "vault.example.org"],
      relayUrl: "ws://127.0.0.1:17322/extension", token: "saved-token" });
  expect(field("blockedDomains").value).toBe("example.com\nvault.example.org");
  expect(field("policyStatus").textContent).toMatch(/saved/i);
});

it("reports an invalid domain without overwriting the saved policy", async () => {
  await load({ trustAgentOwnedTabs: false, blockedDomains: ["example.com"] });
  field("blockedDomains").value = "not a domain";
  field("trustAgentOwnedTabs").checked = true;
  await field("savePolicy").events.get("click")!();
  expect(field("policyStatus").textContent).toMatch(/invalid.*domain/i);
  expect(await mock.chrome.storage.local.get(["trustAgentOwnedTabs", "blockedDomains"]))
    .toEqual({ trustAgentOwnedTabs: false, blockedDomains: ["example.com"] });
});
