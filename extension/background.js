const PROTOCOL_VERSION = 1;
const DEFAULT_URL = "ws://127.0.0.1:17321/extension";
const DEFAULT_ACTION_TITLE = "Share or unshare this tab with agents";
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
const pendingAnnotations = new Map();
const tabGenerations = new Map();
let authenticated = false;
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
  authenticated = false;
  clearTimeout(reconnectTimer);
  const { relayUrl, token } = await settings();
  if (!token) {
    setGlobalBadge("?", "#b45309");
    return;
  }
  socket?.close();
  const connection = new WebSocket(relayUrl);
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    connection.send(JSON.stringify({ type: "hello", token, version: PROTOCOL_VERSION }));
    // Regular WebSocket traffic keeps the MV3 service worker alive (Chrome 116+
    // resets the 30s idle timer on each message).
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: "ping" }), 20_000);
  });
  connection.addEventListener("message", (event) => {
    if (socket === connection) void handleMessage(JSON.parse(event.data));
  });
  connection.addEventListener("close", () => {
    if (socket !== connection) return;
    authenticated = false;
    for (const pending of pendingAnnotations.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Annotation daemon disconnected"));
    }
    pendingAnnotations.clear();
    clearInterval(keepaliveTimer);
    setGlobalBadge("!", "#b91c1c");
    reconnectTimer = setTimeout(connect, 2000);
  });
  connection.addEventListener("error", () => connection.close());
}

async function handleMessage(message) {
  if (message.type === "pong") return;
  if (message.type === "ready") {
    authenticated = true;
    setGlobalBadge("", "#0891b2");
    await restoreSharedTabs();
    await sendTabs();
    for (const tabId of sharedTabs) void refreshAnnotations(tabId).catch(() => {});
    return;
  }
  if (message.type === "annotationsResponse") {
    const pending = pendingAnnotations.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingAnnotations.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return;
  }
  if (message.type === "annotationUpdated") {
    for (const tabId of sharedTabs) {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.url === message.annotation.url) void refreshAnnotations(tabId).catch(() => {});
    }
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
  try {
    sharedTabs.add(tabId);
    await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
    await ensureAgentGroup(tabId);
    await chrome.action.setBadgeText({ tabId, text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0891b2" });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }).catch(() => {});
    await sendTabs();
    void refreshAnnotations(tabId).catch(() => {});
  } catch (error) {
    sharedTabs.delete(tabId);
    await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] }).catch(() => {});
    intentionalDetach.add(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    intentionalDetach.delete(tabId);
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    if (await isInAgentGroup(tabId)) await chrome.tabs.ungroup(tabId).catch(() => {});
    throw error;
  }
}

async function unshareTab(tabId, { ungroup = true } = {}) {
  if (!sharedTabs.has(tabId)) return;
  sharedTabs.delete(tabId);
  await chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsDestroy" }).catch(() => {});
  intentionalDetach.add(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  intentionalDetach.delete(tabId);
  await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }).catch(() => {});
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

function annotationRequest(body) {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Annotation daemon is not connected"));
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingAnnotations.delete(id);
      reject(new Error("Annotation request timed out"));
    }, 20_000);
    pendingAnnotations.set(id, { resolve, reject, timer });
    send({ ...body, id });
  });
}

async function injectAnnotations(tabId) {
  if (!sharedTabs.has(tabId)) throw new Error("Share this tab before annotating it");
  await chrome.scripting.executeScript({ target: { tabId }, files: ["annotation-utils.js", "annotations.js"] });
  if (!sharedTabs.has(tabId)) {
    await chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsDestroy" }).catch(() => {});
    throw new Error("Tab is no longer shared");
  }
}

async function refreshAnnotations(tabId) {
  if (!authenticated || !sharedTabs.has(tabId)) return;
  const tab = await chrome.tabs.get(tabId);
  const generation = tabGenerations.get(tabId);
  await injectAnnotations(tabId);
  // Keep the daemon's shared URL current before the URL-scoped request.
  await sendTabs();
  const annotations = await annotationRequest({ type: "annotationsList", tabId, url: tab.url });
  if (!sharedTabs.has(tabId) || generation !== tabGenerations.get(tabId)) return;
  const current = await chrome.tabs.get(tabId);
  if (current.url !== tab.url) return;
  await chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsRender", url: tab.url, annotations });
}

async function toggleAnnotations(tabId) {
  try {
    if (!sharedTabs.has(tabId)) throw new Error("Share this tab with the toolbar icon before annotating it");
    if (!authenticated) throw new Error("Connect the annotation daemon before annotating this tab");
    await injectAnnotations(tabId);
    await chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsToggle" });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }).catch(() => {});
    void refreshAnnotations(tabId).catch(() => {});
  } catch (error) {
    console.warn("Annotations unavailable:", error.message || String(error));
    await chrome.action.setTitle({ tabId, title: error.message || String(error) }).catch(() => {});
  }
}

async function saveAnnotation(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId || sender.frameId !== 0 || !sharedTabs.has(tabId)) throw new Error("Annotations require a shared top-level tab");
  const tab = await chrome.tabs.get(tabId);
  const generation = tabGenerations.get(tabId);
  const url = message.annotation?.url;
  const assertCurrent = async () => {
    const current = await chrome.tabs.get(tabId);
    const active = await chrome.tabs.query({ windowId: tab.windowId, active: true });
    if (!sharedTabs.has(tabId) || current.status === "loading" || current.url !== url || sender.url !== url || generation !== tabGenerations.get(tabId) || active[0]?.id !== tabId) {
      throw new Error("Keep the shared annotation tab active at the same URL while saving");
    }
    if (sender.documentId) {
      const context = await chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsCaptureContext" }, { documentId: sender.documentId });
      if (context?.url !== url || !context.hidden || context.scroll?.x !== message.annotation.scroll?.x || context.scroll?.y !== message.annotation.scroll?.y) {
        throw new Error("The page or scroll position changed during annotation capture; retry Save");
      }
    }
  };
  await assertCurrent();
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  await assertCurrent();
  await sendTabs();
  return annotationRequest({ type: "annotationsSave", tabId, annotation: { ...message.annotation, title: tab.title || "" }, screenshot });
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "toggle-annotate") return;
  if (tab?.id) void toggleAnnotations(tab.id);
  else void chrome.tabs.query({ active: true, currentWindow: true }).then(([active]) => {
    if (active?.id) void toggleAnnotations(active.id);
  });
});

void chrome.contextMenus.remove("ubb-annotate").catch(() => {}).then(() => {
  chrome.contextMenus.create({ id: "ubb-annotate", title: "Annotate this tab", contexts: ["action"] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "ubb-annotate" && tab?.id) void toggleAnnotations(tab.id);
});

function setGlobalBadge(text, color) {
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color });
}

function explainShareError(error) {
  const message = error?.message || String(error);
  if (message.includes("Cannot access a chrome-extension:// URL of different extension")) {
    return "Another extension (e.g. a password manager or Grammarly) has a frame in this page, so Chrome blocks debugging it. Limit that extension's site access to 'On click' and reload the tab, then try again.";
  }
  if (message.includes("Another debugger is already attached")) {
    return "DevTools or another tab-controlling extension is already attached to this tab. Close it, then try again.";
  }
  return `Tab sharing failed: ${message}`;
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.id || tab.url?.startsWith("chrome://") || tab.url?.startsWith("chrome-extension://")) return;
  try {
    if (sharedTabs.has(tab.id)) await unshareTab(tab.id);
    else await shareTab(tab.id);
  } catch (error) {
    // Attach can fail due to another extension's frame in the page,
    // DevTools/another debugger attached to the tab, or policy-blocked pages.
    console.error("Failed to toggle tab sharing", error);
    await chrome.action.setBadgeText({ tabId: tab.id, text: "ERR" });
    await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#b91c1c" });
    await chrome.action.setTitle({ tabId: tab.id, title: explainShareError(error) }).catch(() => {});
  }
});

chrome.debugger.onDetach.addListener(({ tabId }) => {
  if (intentionalDetach.has(tabId)) return;
  sharedTabs.delete(tabId);
  void chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsDestroy" }).catch(() => {});
  chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  void sendTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabGenerations.delete(tabId);
  sharedTabs.delete(tabId);
  agentTabs.delete(tabId);
  chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  void persistAgentTabs();
  void sendTabs();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || changeInfo.url) tabGenerations.set(tabId, (tabGenerations.get(tabId) || 0) + 1);
  if (sharedTabs.has(tabId) && (changeInfo.status === "complete" || changeInfo.url)) {
    void refreshAnnotations(tabId).catch(() => {});
  }
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

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "ubbAnnotationSave") {
    void saveAnnotation(message, sender).then((result) => respond({ result }), (error) => respond({ error: error.message || String(error) }));
    return true;
  }
  if (message?.type === "ubbAnnotationsReload" && sender.tab?.id && sender.frameId === 0 && sharedTabs.has(sender.tab.id)) {
    void refreshAnnotations(sender.tab.id).catch(() => {});
  }
  if (message?.type === "approvalDecision" && typeof message.id === "string") {
    finishApproval(message.id, message.approved === true);
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.relayUrl)) void connect();
});

void restoreAgentTabs().then(connect);
