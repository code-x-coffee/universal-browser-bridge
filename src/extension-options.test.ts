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

it("enables trust and automatic agent windows with an empty blocklist on first use", async () => {
  await load();
  expect(field("trustAgentOwnedTabs")?.checked).toBe(true);
  expect(field("autoCreateAgentWindow")?.checked).toBe(true);
  expect(field("blockedDomains")?.value).toBe("");
});

it("loads the saved trust and agent window preferences and blocklist", async () => {
  await load({ trustAgentOwnedTabs: false, autoCreateAgentWindow: false, blockedDomains: ["example.com", "vault.example.org"] });
  expect(field("trustAgentOwnedTabs").checked).toBe(false);
  expect(field("autoCreateAgentWindow")?.checked).toBe(false);
  expect(field("blockedDomains").value).toBe("example.com\nvault.example.org");
});

it.each([true, false])("saves normalized domains and safety checkboxes (automatic windows=%s) without changing pairing settings", async (autoCreate) => {
  await load({ relayUrl: "ws://127.0.0.1:17322/extension", token: "saved-token" });
  field("trustAgentOwnedTabs").checked = false;
  field("autoCreateAgentWindow").checked = autoCreate;
  field("blockedDomains").value = "HTTPS://WWW.Example.COM/path\r\n\nexample.com\nvault.example.org/private";
  await field("savePolicy").events.get("click")!();
  expect(await mock.chrome.storage.local.get(["trustAgentOwnedTabs", "autoCreateAgentWindow", "blockedDomains", "relayUrl", "token"]))
    .toEqual({ trustAgentOwnedTabs: false, autoCreateAgentWindow: autoCreate, blockedDomains: ["example.com", "vault.example.org"],
      relayUrl: "ws://127.0.0.1:17322/extension", token: "saved-token" });
  expect(field("blockedDomains").value).toBe("example.com\nvault.example.org");
  expect(field("policyStatus").textContent).toMatch(/saved/i);
});

it("reports an invalid domain without overwriting the saved policy", async () => {
  await load({ trustAgentOwnedTabs: false, autoCreateAgentWindow: false, blockedDomains: ["example.com"] });
  field("blockedDomains").value = "not a domain";
  field("trustAgentOwnedTabs").checked = true;
  field("autoCreateAgentWindow").checked = true;
  await field("savePolicy").events.get("click")!();
  expect(field("policyStatus").textContent).toMatch(/invalid.*domain/i);
  expect(await mock.chrome.storage.local.get(["trustAgentOwnedTabs", "autoCreateAgentWindow", "blockedDomains"]))
    .toEqual({ trustAgentOwnedTabs: false, autoCreateAgentWindow: false, blockedDomains: ["example.com"] });
});

it("shows the default upload folder only when the key is unset", async () => {
  await load();
  expect(field("uploadFolders")?.value).toBe("/Volumes/NVme/Projects/Stories/");
});

it("preserves an explicitly empty upload folder list", async () => {
  await load({ uploadFolders: [] });
  expect(field("uploadFolders")?.value).toBe("");
});

it("saves normalized upload folders and reports ignored entries", async () => {
  await load();
  field("uploadFolders").value = " /tmp/images \r\nrelative\n/tmp/images/\n/tmp/a/../b\n/tmp/other/";
  await field("savePolicy").events.get("click")!();
  expect(await mock.chrome.storage.local.get("uploadFolders")).toEqual({ uploadFolders: ["/tmp/images/", "/tmp/other/"] });
  expect(field("uploadFolders").value).toBe("/tmp/images/\n/tmp/other/");
  expect(field("policyStatus").textContent).toMatch(/ignored.*2/i);
});

it("saves an empty textarea as an empty array to disable uploads", async () => {
  await load();
  field("uploadFolders").value = "\n ";
  await field("savePolicy").events.get("click")!();
  expect(await mock.chrome.storage.local.get("uploadFolders")).toEqual({ uploadFolders: [] });
});

it("does not save upload folders when a blocklist entry is invalid", async () => {
  await load({ uploadFolders: ["/saved/"] });
  field("blockedDomains").value = "not a domain";
  field("uploadFolders").value = "/new/";
  await field("savePolicy").events.get("click")!();
  expect(await mock.chrome.storage.local.get("uploadFolders")).toEqual({ uploadFolders: ["/saved/"] });
  expect(field("policyStatus").textContent).toMatch(/invalid.*domain/i);
});

it("shows default download folders independently of upload settings", async () => {
  await load({ uploadFolders: [] });
  expect(field("downloadFolders")?.value).toBe("/Volumes/NVme/Projects/Stories/");
});
it("loads and preserves an explicitly empty download folder list", async () => {
  await load({ downloadFolders: [] });
  expect(field("downloadFolders")?.value).toBe("");
});
it("saves normalized download folders separately and reports ignored entries", async () => {
  await load({ uploadFolders: ["/uploads/"] });
  field("downloadFolders").value = " /tmp/media \r\nrelative\n/tmp/media/\n/tmp/a/../b\n/tmp/other/";
  await field("savePolicy").events.get("click")!();
  expect(await mock.chrome.storage.local.get(["uploadFolders", "downloadFolders"]))
    .toEqual({ uploadFolders: ["/uploads/"], downloadFolders: ["/tmp/media/", "/tmp/other/"] });
  expect(field("policyStatus").textContent).toMatch(/ignored 2 invalid download folder/i);
  field("downloadFolders").value = "\n ";
  await field("savePolicy").events.get("click")!();
  expect(await mock.chrome.storage.local.get("downloadFolders")).toEqual({ downloadFolders: [] });
});
