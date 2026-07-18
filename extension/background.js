const PROTOCOL_VERSION = 1;
const DEFAULT_URL = "ws://127.0.0.1:17321/extension";
const AGENT_GROUP_TITLE = "Agent Bridge";
const sharedTabs = new Set();
const agentTabs = new Set();
const pendingApprovals = new Map();
const approvalWindows = new Map();
let socket;
let reconnectTimer;
let keepaliveTimer;
let intentionalDetach = new Set();
const groupingInProgress = new Set();
const revocationChecks = new Map();
// Debounce window before acting on a possible group departure. Chrome
// dispatches tabs.onUpdated/tabGroups.onUpdated over a channel that isn't
// strictly ordered against the extension's own API-call promises, and event
// payloads can reflect state from the moment of the underlying change, not
// whatever is live by delivery time. Never decide from an event's payload:
// every check below re-reads live state via isInAgentGroup() right before
// acting, so this delay only exists to let Chrome's own dispatch settle down
// and coalesce repeat events -- the final decision is always the fresh
// re-check, not the timer.
const REVOCATION_DEBOUNCE_MS = 250;

async function settings() {
  return chrome.storage.local.get({ relayUrl: DEFAULT_URL, token: "" });
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { relayUrl, token } = await settings();
  if (!token) {
    setGlobalBadge("?", "#b45309");
    return;
  }
  socket?.close();
  socket = new WebSocket(relayUrl);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ type: "hello", token, version: PROTOCOL_VERSION }));
    // Regular WebSocket traffic keeps the MV3 service worker alive (Chrome 116+
    // resets the 30s idle timer on each message).
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: "ping" }), 20_000);
  });
  socket.addEventListener("message", (event) => void handleMessage(JSON.parse(event.data)));
  socket.addEventListener("close", () => {
    clearInterval(keepaliveTimer);
    setGlobalBadge("!", "#b91c1c");
    reconnectTimer = setTimeout(connect, 2000);
  });
  socket.addEventListener("error", () => socket.close());
}

async function handleMessage(message) {
  if (message.type === "pong") return;
  if (message.type === "ready") {
    setGlobalBadge("", "#0891b2");
    await restoreSharedTabs();
    await sendTabs();
    return;
  }
  if (message.type !== "command") return;
  try {
    let result;
    if (message.action === "listTabs") result = await tabList();
    if (message.action === "createTab") {
      const tab = await createAgentTab(message.url);
      await shareTab(tab.id);
      result = tab;
    }
    if (message.action === "closeTab") {
      if (!agentTabs.has(message.tabId)) throw new Error("Only agent-created tabs can be closed by agents");
      await unshareTab(message.tabId, { ungroup: false });
      await chrome.tabs.remove(message.tabId);
      agentTabs.delete(message.tabId);
      await persistAgentTabs();
      result = { closed: message.tabId };
    }
    if (message.action === "requestApproval") {
      result = { approved: await requestApproval(message.description || "Allow this browser action?") };
    }
    if (message.action === "cdp") {
      if (!sharedTabs.has(message.tabId)) throw new Error("Tab is not shared");
      result = await chrome.debugger.sendCommand({ tabId: message.tabId }, message.method, message.params || {});
    }
    send({ type: "response", id: message.id, result });
  } catch (error) {
    send({ type: "response", id: message.id, error: error?.message || String(error) });
  }
}

async function shareTab(tabId) {
  if (!tabId || sharedTabs.has(tabId)) return;
  await chrome.debugger.attach({ tabId }, "1.3");
  sharedTabs.add(tabId);
  await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  await ensureAgentGroup(tabId);
  await chrome.action.setBadgeText({ tabId, text: "ON" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0891b2" });
  await sendTabs();
}

async function unshareTab(tabId, { ungroup = true } = {}) {
  if (!sharedTabs.has(tabId)) return;
  sharedTabs.delete(tabId);
  intentionalDetach.add(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  intentionalDetach.delete(tabId);
  await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  await chrome.action.setBadgeText({ tabId, text: "" });
  if (ungroup && await isInAgentGroup(tabId)) await chrome.tabs.ungroup(tabId).catch(() => {});
  await sendTabs();
}

async function restoreSharedTabs() {
  const { sharedTabIds = [] } = await chrome.storage.session.get({ sharedTabIds: [] });
  for (const tabId of sharedTabIds) {
    try {
      await chrome.tabs.get(tabId);
      if (!await isInAgentGroup(tabId)) throw new Error("Tab left the Agent Bridge group");
      await chrome.debugger.attach({ tabId }, "1.3").catch((error) => {
        if (!String(error).includes("already attached")) throw error;
      });
      sharedTabs.add(tabId);
      await chrome.action.setBadgeText({ tabId, text: "ON" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0891b2" });
    } catch {
      sharedTabs.delete(tabId);
    }
  }
  await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
}

// Agent-created tabs live in their own window so they never crowd the user's.
async function createAgentTab(url) {
  const { agentWindowId } = await chrome.storage.session.get("agentWindowId");
  if (agentWindowId !== undefined) {
    try {
      await chrome.windows.get(agentWindowId);
      const tab = await chrome.tabs.create({ windowId: agentWindowId, url, active: false });
      agentTabs.add(tab.id);
      await persistAgentTabs();
      return tab;
    } catch {
      // Agent window was closed; create a fresh one below.
    }
  }
  const approved = await requestApproval(
    `Create an agent-controlled Chrome window? Tabs opened there can use your signed-in Chrome session. First URL: ${url}`
  );
  if (!approved) throw new Error("User denied creation of the agent-controlled window");
  const window = await chrome.windows.create({ url, focused: false });
  await chrome.storage.session.set({ agentWindowId: window.id });
  const tab = window.tabs[0];
  agentTabs.add(tab.id);
  await persistAgentTabs();
  return tab;
}

async function ensureAgentGroup(tabId) {
  // Tab groups are per-window: reuse the Agent Bridge group in this tab's own
  // window so grouping never drags a tab across windows.
  //
  // chrome.tabs.group() and the chrome.tabGroups.update() that titles the
  // group are two separate round trips. chrome.tabs.onUpdated (and
  // chrome.tabGroups.onUpdated) can fire and be fully handled in between,
  // so a listener reacting to *this* grouping can observe the group before
  // its title is set. Track tabs we're actively (re)grouping so those
  // listeners can tell "still being grouped by us" apart from "left the
  // group" and not misfire an unshare on a tab we just shared.
  groupingInProgress.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    const groups = await chrome.tabGroups.query({ title: AGENT_GROUP_TITLE, windowId: tab.windowId });
    const groupId = groups[0]
      ? await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id })
      : await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: AGENT_GROUP_TITLE, color: "cyan", collapsed: false });
  } finally {
    groupingInProgress.delete(tabId);
  }
}

async function isInAgentGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId === undefined || tab.groupId < 0) return false;
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title === AGENT_GROUP_TITLE;
  } catch {
    return false;
  }
}

// Coalesces possible-departure signals for a tab and, after a short settle
// window, decides purely from a fresh live lookup -- never from whatever an
// event's payload said. This is what makes the guard robust regardless of
// how event delivery is timed relative to our own API calls: a stale event
// arriving after we've already finished (re)grouping a tab resolves to "no
// action" because the fresh check sees the tab correctly grouped, while a
// genuine departure still resolves to "unshare" because the fresh check
// confirms it's actually gone.
function scheduleRevocationCheck(tabId) {
  if (revocationChecks.has(tabId)) return;
  const timer = setTimeout(async () => {
    revocationChecks.delete(tabId);
    if (!sharedTabs.has(tabId) || groupingInProgress.has(tabId)) return;
    const inside = await isInAgentGroup(tabId);
    if (!inside && sharedTabs.has(tabId) && !groupingInProgress.has(tabId)) {
      await unshareTab(tabId, { ungroup: false });
    }
  }, REVOCATION_DEBOUNCE_MS);
  revocationChecks.set(tabId, timer);
}

async function persistAgentTabs() {
  await chrome.storage.session.set({ agentTabIds: [...agentTabs] });
}

async function restoreAgentTabs() {
  const { agentTabIds = [] } = await chrome.storage.session.get({ agentTabIds: [] });
  for (const tabId of agentTabIds) {
    try {
      await chrome.tabs.get(tabId);
      agentTabs.add(tabId);
    } catch {
      agentTabs.delete(tabId);
    }
  }
  await persistAgentTabs();
}

async function requestApproval(description) {
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [`approval_${id}`]: { description, createdAt: Date.now() } });
  const window = await chrome.windows.create({
    url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(id)}`),
    type: "popup",
    width: 480,
    height: 360,
    focused: true
  });
  return new Promise((resolve) => {
    const timer = setTimeout(() => finishApproval(id, false), 120_000);
    pendingApprovals.set(id, { resolve, timer, windowId: window.id });
    approvalWindows.set(window.id, id);
  });
}

function finishApproval(id, approved) {
  const pending = pendingApprovals.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingApprovals.delete(id);
  approvalWindows.delete(pending.windowId);
  chrome.storage.session.remove(`approval_${id}`);
  chrome.windows.remove(pending.windowId).catch(() => {});
  pending.resolve(Boolean(approved));
}

async function tabList() {
  const tabs = [];
  for (const id of sharedTabs) {
    try {
      const tab = await chrome.tabs.get(id);
      tabs.push({ id, title: tab.title || "", url: tab.url || "", active: Boolean(tab.active) });
    } catch {
      sharedTabs.delete(id);
    }
  }
  return tabs;
}

async function sendTabs() {
  const tabs = await tabList();
  send({ type: "tabs", tabs });
  return tabs;
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function setGlobalBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) return;
  try {
    if (sharedTabs.has(tab.id)) await unshareTab(tab.id);
    else await shareTab(tab.id);
  } catch (error) {
    // Attach can fail when DevTools is open on the tab or the page is policy-blocked.
    console.error("Failed to toggle tab sharing", error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b91c1c" });
  }
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (intentionalDetach.has(tabId)) return;
  sharedTabs.delete(tabId);
  chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  void sendTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  sharedTabs.delete(tabId);
  agentTabs.delete(tabId);
  chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  void persistAgentTabs();
  void sendTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!sharedTabs.has(tabId) || changeInfo.groupId === undefined || groupingInProgress.has(tabId)) return;
  scheduleRevocationCheck(tabId);
});

// Deliberately ignores `group.title` on the event itself -- see
// scheduleRevocationCheck's comment. An event payload can carry the group's
// state from the moment it was created (still untitled), even when it's
// delivered well after our own chrome.tabGroups.update() already landed the
// real title, so acting on it directly reintroduces the same race.
chrome.tabGroups.onUpdated.addListener((group) => {
  void chrome.tabs.query({ groupId: group.id }).then((tabs) => {
    for (const tab of tabs) {
      if (tab.id && sharedTabs.has(tab.id) && !groupingInProgress.has(tab.id)) scheduleRevocationCheck(tab.id);
    }
  });
});

chrome.windows.onRemoved.addListener((windowId) => {
  const approvalId = approvalWindows.get(windowId);
  if (approvalId) finishApproval(approvalId, false);
  void chrome.storage.session.get("agentWindowId").then(({ agentWindowId }) => {
    if (agentWindowId === windowId) chrome.storage.session.remove("agentWindowId");
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "approvalDecision" && typeof message.id === "string") {
    finishApproval(message.id, message.approved === true);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.relayUrl)) void connect();
});

void restoreAgentTabs().then(connect);
