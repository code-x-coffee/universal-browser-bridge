import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./test-support/chrome-mock.js";

const DEFAULT_TITLE = "Share or unshare this tab with agents";
let mock: ReturnType<typeof createChromeMock>;
let tab: Awaited<ReturnType<typeof mock.chrome.tabs.get>>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  mock = createChromeMock();
  vi.stubGlobal("chrome", mock.chrome);
  // The empty token prevents connect() from opening a socket.
  vi.stubGlobal("WebSocket", class { static OPEN = 1; });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const win = await mock.chrome.windows.create({ url: "https://furlenco.xumane.com", focused: true });
  tab = win.tabs[0]!;
  // @ts-expect-error background.js is a plain untyped extension script, imported for its side effects.
  await import("../extension/background.js");
  await vi.runAllTimersAsync();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function clickTab() {
  const clicked = mock.actionOnClicked[0]!(tab);
  await vi.runAllTimersAsync();
  await clicked;
}

it("explains when another extension's frame blocks sharing", async () => {
  const error = new Error("Cannot access a chrome-extension:// URL of different extension");
  vi.spyOn(mock.chrome.debugger, "attach").mockRejectedValueOnce(error);
  const detach = vi.spyOn(mock.chrome.debugger, "detach");
  const badge = vi.spyOn(mock.chrome.action, "setBadgeText");
  const color = vi.spyOn(mock.chrome.action, "setBadgeBackgroundColor");

  await clickTab();

  expect(badge).toHaveBeenCalledWith({ tabId: tab.id, text: "ERR" });
  expect(color).toHaveBeenCalledWith({ tabId: tab.id, color: "#b91c1c" });
  expect(mock.actionTitles.get(tab.id)).toMatch(/another extension.*frame/i);
  expect(mock.actionTitles.get(tab.id)).toContain("On click");
  expect(mock.actionTitles.get(tab.id)).toMatch(/reload/i);
  expect(console.error).toHaveBeenCalledWith("Failed to toggle tab sharing", error);
  expect(detach).not.toHaveBeenCalled();
});

it.each([
  [new Error("Another debugger is already attached to the tab"), "DevTools"],
  [new Error("Blocked by enterprise policy"), "Tab sharing failed: Blocked by enterprise policy"],
  ["Unexpected attach failure", "Tab sharing failed: Unexpected attach failure"]
])("explains attach failure %s", async (error, reason) => {
  vi.spyOn(mock.chrome.debugger, "attach").mockRejectedValueOnce(error);
  const badge = vi.spyOn(mock.chrome.action, "setBadgeText");

  await clickTab();

  expect(badge).toHaveBeenCalledWith({ tabId: tab.id, text: "ERR" });
  expect(mock.actionTitles.get(tab.id)).toContain(reason);
});

it("resets the error title after a successful share and when unsharing", async () => {
  vi.spyOn(mock.chrome.debugger, "attach").mockRejectedValueOnce(new Error("Attach failed"));
  const title = vi.spyOn(mock.chrome.action, "setTitle");

  await clickTab();
  expect(mock.actionTitles.get(tab.id)).toContain("Attach failed");

  await clickTab();
  expect(mock.actionTitles.get(tab.id)).toBe(DEFAULT_TITLE);
  expect(await mock.chrome.storage.session.get("sharedTabIds")).toEqual({ sharedTabIds: [tab.id] });

  title.mockClear();
  await clickTab();
  expect(title).toHaveBeenCalledWith({ tabId: tab.id, title: DEFAULT_TITLE });
  expect(await mock.chrome.storage.session.get("sharedTabIds")).toEqual({ sharedTabIds: [] });
});

it.each(["grouping", "badge"])("rolls back attachment and sharing after a %s failure, then allows retry", async (step) => {
  const error = new Error(`${step} failed after attach`);
  if (step === "grouping") vi.spyOn(mock.chrome.tabGroups, "query").mockRejectedValueOnce(error);
  else vi.spyOn(mock.chrome.action, "setBadgeBackgroundColor").mockRejectedValueOnce(error);
  const attach = vi.spyOn(mock.chrome.debugger, "attach");
  const detach = vi.spyOn(mock.chrome.debugger, "detach").mockImplementation(async (source) => {
    for (const listener of mock.debuggerOnDetach) listener(source, "canceled_by_user");
  });
  const storage = vi.spyOn(mock.chrome.storage.session, "set");
  const badge = vi.spyOn(mock.chrome.action, "setBadgeText");

  await clickTab();

  const rolledBackTab = mock.chrome.tabs.get(tab.id);
  await vi.runAllTimersAsync();
  expect((await rolledBackTab).groupId).toBe(-1);
  expect(detach).toHaveBeenCalledWith({ tabId: tab.id });
  expect(await mock.chrome.storage.session.get("sharedTabIds")).toEqual({ sharedTabIds: [] });
  // Intentional detach must not trigger the onDetach listener's duplicate cleanup.
  expect(storage).toHaveBeenCalledTimes(2);
  const clearBadgeCall = step === "badge" ? 2 : 1;
  expect(badge).toHaveBeenNthCalledWith(clearBadgeCall, { tabId: tab.id, text: "" });
  expect(badge).toHaveBeenNthCalledWith(clearBadgeCall + 1, { tabId: tab.id, text: "ERR" });
  expect(badge).toHaveBeenCalledTimes(clearBadgeCall + 1);
  expect(badge).toHaveBeenCalledWith({ tabId: tab.id, text: "ERR" });
  expect(mock.actionTitles.get(tab.id)).toContain(error.message);
  expect(console.error).toHaveBeenCalledWith("Failed to toggle tab sharing", error);

  await clickTab();
  expect(attach).toHaveBeenCalledTimes(2);
  expect(await mock.chrome.storage.session.get("sharedTabIds")).toEqual({ sharedTabIds: [tab.id] });
  expect(mock.actionTitles.get(tab.id)).toBe(DEFAULT_TITLE);
});

it.each(["storage", "badge"])("rolls back after a %s failure even if detach rejects", async (step) => {
  const error = new Error(`${step} failed after attach`);
  if (step === "storage") vi.spyOn(mock.chrome.storage.session, "set").mockRejectedValueOnce(error);
  else vi.spyOn(mock.chrome.action, "setBadgeBackgroundColor").mockRejectedValueOnce(error);
  const detach = vi.spyOn(mock.chrome.debugger, "detach").mockRejectedValueOnce(new Error("Tab already gone"));
  const badge = vi.spyOn(mock.chrome.action, "setBadgeText");

  await clickTab();

  expect(detach).toHaveBeenCalledWith({ tabId: tab.id });
  expect(await mock.chrome.storage.session.get("sharedTabIds")).toEqual({ sharedTabIds: [] });
  expect(badge).toHaveBeenCalledWith({ tabId: tab.id, text: "ERR" });
  expect(mock.actionTitles.get(tab.id)).toContain(error.message);
});

it("keeps sharing and unsharing successful when title updates fail", async () => {
  vi.spyOn(mock.chrome.action, "setTitle").mockRejectedValue(new Error("Tab already gone"));
  const badge = vi.spyOn(mock.chrome.action, "setBadgeText");
  const detach = vi.spyOn(mock.chrome.debugger, "detach");

  await clickTab();
  expect(await mock.chrome.storage.session.get("sharedTabIds")).toEqual({ sharedTabIds: [tab.id] });
  expect(detach).not.toHaveBeenCalled();

  await clickTab();
  expect(await mock.chrome.storage.session.get("sharedTabIds")).toEqual({ sharedTabIds: [] });
  expect(badge).not.toHaveBeenCalledWith({ tabId: tab.id, text: "ERR" });
});
