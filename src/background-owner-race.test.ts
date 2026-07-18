// Reproduces a real-Chrome E2E failure: extension/background.js's own
// chrome.tabs.onUpdated listener can race chrome.tabGroups.update() inside
// ensureAgentGroup() and misidentify a tab it just created as having "left"
// the Agent Bridge group, unsharing it. The resulting spurious "tabs"
// broadcast can land at the daemon after ownership was registered, and
// DaemonServer.reconcileTabs conflates "unshared" with "closed", silently
// releasing ownership -- letting a non-owning client close the tab.
//
// The daemon-level FakeExtension in daemon.test.ts always sends its "tabs"
// broadcast synchronously in lockstep with the command response, so it can
// never reproduce this: this test drives the real extension/background.js
// (with only the chrome.* API boundary mocked) against the real
// BrowserBridge/DaemonServer/DaemonClient over a real WebSocket + control
// socket, with mock chrome API delays tuned to force the same event
// ordering that the live-Chrome E2E hit.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket as WSImpl } from "ws";
import { BrowserBridge } from "./bridge.js";
import { DaemonClient } from "./daemon-client.js";
import { DaemonServer } from "./daemon.js";
import { createChromeMock } from "./test-support/chrome-mock.js";

const TOKEN = "background-race-test-token";

class TestWebSocket extends WSImpl {
  constructor(url: string | URL) {
    super(url, { headers: { origin: "chrome-extension://faketestid" } });
  }
}

let tempDir: string;
let bridge: BrowserBridge;
let daemon: DaemonServer;
const clients: DaemonClient[] = [];

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "ubb-bgrace-test-"));
  // extension/background.js runs module-level side effects (registers
  // listeners, kicks off connect()) on import; each test needs its own fresh
  // evaluation against its own chrome mock, not the previous test's cached
  // module instance and stale listener registrations.
  vi.resetModules();
});

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  await daemon?.stop();
  await bridge?.stop();
  await rm(tempDir, { recursive: true, force: true });
  delete (globalThis as any).chrome;
  delete (globalThis as any).WebSocket;
});

it("does not let another client close a tab that the extension's own group/title race briefly unshares", async () => {
  // Timings tuned to force the exact ordering the live E2E hit: the
  // tabs.onUpdated listener's isInAgentGroup() check (2 fast round trips)
  // reads the group's title before chrome.tabGroups.update() lands it, and
  // the resulting unshareTab() chain (paced by a slow debugger.detach)
  // finishes only after ensureAgentGroup's own tail -- and the createTab
  // response -- have already gone out.
  const { chrome } = createChromeMock({
    delays: { tabsGet: 1, tabGroupsGet: 1, tabGroupsUpdate: 5, debuggerDetach: 15, badge: 1 }
  });
  (globalThis as any).chrome = chrome;
  (globalThis as any).WebSocket = TestWebSocket;

  // Pre-seed an existing agent window so createAgentTab takes the fast path
  // (no approval popup), matching a real session where the user already
  // approved the agent window earlier.
  const win = await chrome.windows.create({ url: "about:blank", focused: false });
  await chrome.storage.session.set({ agentWindowId: win.id });

  bridge = new BrowserBridge(TOKEN, "127.0.0.1", 0);
  await bridge.start();

  const socketPath = join(tempDir, "daemon.sock");
  daemon = new DaemonServer(bridge, TOKEN, socketPath);
  await daemon.start();

  // background.js's top-level `restoreAgentTabs().then(connect)` reads
  // storage as soon as it's imported, so seed the relay URL/token first.
  await chrome.storage.local.set({ relayUrl: `ws://127.0.0.1:${bridge.port}/extension`, token: TOKEN });
  // @ts-expect-error background.js is a plain untyped extension script with no declaration file; imported only for its side effects.
  await import("../extension/background.js");

  // Let the extension's hello/ready handshake settle.
  await new Promise((resolve) => setTimeout(resolve, 100));

  const owner = new DaemonClient({ socketPath, token: TOKEN, clientId: randomUUID(), label: "owner" });
  const other = new DaemonClient({ socketPath, token: TOKEN, clientId: randomUUID(), label: "other" });
  clients.push(owner, other);
  await owner.connect();
  await other.connect();

  const created = (await owner.request({ action: "createTab", url: "https://example.com" })) as { id: number };

  // The race above resolves via fixed, mock-controlled setTimeout delays
  // (<=15ms), not real I/O, so this margin is not an arbitrary flake-prone
  // wait -- it just needs to exceed the mock's own longest configured delay.
  await new Promise((resolve) => setTimeout(resolve, 150));

  await expect(other.request({ action: "closeTab", tabId: created.id })).rejects.toThrow(/owning client|owner/i);
});

it("still revokes sharing when a human later renames the tab's group away from Agent Bridge", async () => {
  const { chrome, simulateGroupRename } = createChromeMock({
    delays: { tabsGet: 1, tabGroupsGet: 1, tabGroupsUpdate: 5, debuggerDetach: 5, badge: 1 }
  });
  (globalThis as any).chrome = chrome;
  (globalThis as any).WebSocket = TestWebSocket;

  const win = await chrome.windows.create({ url: "about:blank", focused: false });
  await chrome.storage.session.set({ agentWindowId: win.id });

  bridge = new BrowserBridge(TOKEN, "127.0.0.1", 0);
  await bridge.start();

  const socketPath = join(tempDir, "daemon.sock");
  daemon = new DaemonServer(bridge, TOKEN, socketPath);
  await daemon.start();

  await chrome.storage.local.set({ relayUrl: `ws://127.0.0.1:${bridge.port}/extension`, token: TOKEN });
  // @ts-expect-error background.js is a plain untyped extension script with no declaration file; imported only for its side effects.
  await import("../extension/background.js");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const owner = new DaemonClient({ socketPath, token: TOKEN, clientId: randomUUID(), label: "owner" });
  clients.push(owner);
  await owner.connect();

  const created = (await owner.request({ action: "createTab", url: "https://example.com" })) as { id: number };
  // Let the extension-initiated group/title race resolve; the tab must stay shared.
  await new Promise((resolve) => setTimeout(resolve, 150));
  const statusBefore = await owner.status();
  expect(statusBefore.tabs.some((tab) => tab.id === created.id)).toBe(true);

  // A human renames the group via the real Chrome UI -- a genuine departure
  // from "Agent Bridge", not the extension's own transient setup state. The
  // revocation guard debounces before re-checking live state (see
  // scheduleRevocationCheck in background.js), so allow for that window.
  const tab = await chrome.tabs.get(created.id);
  simulateGroupRename(tab.groupId, "Renamed by a human");
  await new Promise((resolve) => setTimeout(resolve, 350));

  const statusAfter = await owner.status();
  expect(statusAfter.tabs.some((t) => t.id === created.id)).toBe(false);
});

it("does not self-unshare when the group-creation event is delivered after ensureAgentGroup already finished", async () => {
  // This is the ordering the groupingInProgress-only fix missed: real Chrome
  // can deliver tabs.onUpdated/tabGroups.onUpdated for the group's creation
  // (with its still-default title) well *after* chrome.tabGroups.update()
  // already resolved and ensureAgentGroup's `finally` cleared
  // groupingInProgress -- unlike the near-instant microtask dispatch the
  // other tests here use. groupCreationEventDelay (200ms) exceeds
  // tabGroupsUpdate (5ms) + badge (1ms) + the debugger-detach/status settle
  // time, so by the time the event arrives, our own setup is long done and
  // the "actively grouping" guard offers no protection.
  const { chrome } = createChromeMock({
    delays: { tabsGet: 1, tabGroupsGet: 1, tabGroupsUpdate: 5, debuggerDetach: 5, badge: 1, groupCreationEventDelay: 200 }
  });
  (globalThis as any).chrome = chrome;
  (globalThis as any).WebSocket = TestWebSocket;

  const win = await chrome.windows.create({ url: "about:blank", focused: false });
  await chrome.storage.session.set({ agentWindowId: win.id });

  bridge = new BrowserBridge(TOKEN, "127.0.0.1", 0);
  await bridge.start();

  const socketPath = join(tempDir, "daemon.sock");
  daemon = new DaemonServer(bridge, TOKEN, socketPath);
  await daemon.start();

  await chrome.storage.local.set({ relayUrl: `ws://127.0.0.1:${bridge.port}/extension`, token: TOKEN });
  // @ts-expect-error background.js is a plain untyped extension script with no declaration file; imported only for its side effects.
  await import("../extension/background.js");
  await new Promise((resolve) => setTimeout(resolve, 100));

  const owner = new DaemonClient({ socketPath, token: TOKEN, clientId: randomUUID(), label: "owner" });
  clients.push(owner);
  await owner.connect();

  const created = (await owner.request({ action: "createTab", url: "https://example.com" })) as { id: number };

  // ensureAgentGroup (and the createTab response) settle well before the
  // 200ms-delayed creation events are delivered.
  await new Promise((resolve) => setTimeout(resolve, 60));
  const statusMidway = await owner.status();
  expect(statusMidway.tabs.some((tab) => tab.id === created.id)).toBe(true);

  // Now let the delayed creation events actually arrive.
  await new Promise((resolve) => setTimeout(resolve, 250));

  const statusAfter = await owner.status();
  expect(statusAfter.tabs.some((tab) => tab.id === created.id)).toBe(true);
});
