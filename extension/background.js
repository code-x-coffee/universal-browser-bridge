import { isReadOnlyBrowserUrl, normalizeBlockedDomains, isBlockedBrowserUrl, assertTabNotBlocked } from "./url-policy.js";
import { DEFAULT_UPLOAD_FOLDERS, normalizeUploadFolders } from "./upload-policy.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_URL = "ws://127.0.0.1:17321/extension";
const DEFAULT_ACTION_TITLE = "Share or unshare this tab with agents";
const AGENT_GROUP_TITLE = "Agent Bridge";
const sharedTabs = new Set();
const agentTabs = new Set();
const agentTabOwners = new Map();
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
  const saved = await chrome.storage.local.get({ relayUrl: DEFAULT_URL, token: "", trustAgentOwnedTabs: true, autoCreateAgentWindow: true, blockedDomains: [] });
  return { ...saved, blockedDomains: normalizeBlockedDomains(saved.blockedDomains) };
}

// Kept apart from settings() so the upload policy can evolve independently.
async function uploadSettings() {
  const { uploadFolders } = await chrome.storage.local.get({ uploadFolders: DEFAULT_UPLOAD_FOLDERS });
  return { uploadFolders: normalizeUploadFolders(uploadFolders) };
}

async function connect() {
  authenticated = false;
  clearTimeout(reconnectTimer);
  const { relayUrl, token, blockedDomains } = await settings();
  const { uploadFolders } = await uploadSettings();
  if (!token) {
    setGlobalBadge("?", "#b45309");
    return;
  }
  socket?.close();
  const connection = new WebSocket(relayUrl);
  socket = connection;
  connection.addEventListener("open", () => {
    if (socket !== connection) return;
    connection.send(JSON.stringify({ type: "hello", token, version: PROTOCOL_VERSION, blockedDomains, uploadFolders }));
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
    await tabStateReady;
    await sendSitePolicy();
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
    await tabStateReady;
    let result;
    if (message.action === "listTabs") result = (await tabList()).filter((tab) => !tab.ownerLabel || tab.ownerLabel === message.label);
    if (message.action === "getTab") {
      result = await assertControlledTab(message.tabId, message.label);
      await assertUnblockedTab(result);
    }
    if (message.action === "listAgentTabs") {
      if (!message.label) throw new Error("An agent label is required to list owned tabs");
      result = (await tabList()).filter((tab) => tab.ownerLabel === message.label)
        .map(({ id, url, title, groupId }) => ({ tabId: id, url, title, groupId }));
    }
    if (message.action === "createTab") {
      const tab = await createAgentTab(message.url, message.label);
      agentTabs.add(tab.id);
      try {
        await shareTab(tab.id, message.label);
        if (!message.label) await persistAgentTabs();
        result = await chrome.tabs.get(tab.id);
        await assertUnblockedTab(result);
      } catch (error) {
        await unshareTab(tab.id, { ungroup: false }).catch(() => {});
        await chrome.tabs.remove(tab.id).catch(() => {});
        agentTabs.delete(tab.id);
        agentTabOwners.delete(tab.id);
        await persistAgentTabs().catch(() => {});
        throw error;
      }
    }
    if (message.action === "closeTab") {
      await assertControlledTab(message.tabId, message.label);
      await unshareTab(message.tabId, { ungroup: false });
      await chrome.tabs.remove(message.tabId);
      agentTabs.delete(message.tabId);
      await persistAgentTabs();
      result = { closed: message.tabId };
    }
    if (message.action === "requestApproval") {
      let trusted = false;
      if (message.tabId !== undefined) {
        const tab = await assertControlledTab(message.tabId, message.label);
        const { trustAgentOwnedTabs, blockedDomains } = await settings();
        assertTabNotBlocked(tab, blockedDomains);
        assertWritableTab(tab);
        trusted = trustAgentOwnedTabs === true && Boolean(message.label)
          && agentTabOwners.get(message.tabId)?.label === message.label;
      }
      result = { approved: trusted || await requestApproval(message.description || "Allow this browser action?") };
    }
    if (message.action === "cdp") {
      const tab = await assertControlledTab(message.tabId, message.label);
      const { blockedDomains } = await settings();
      assertTabNotBlocked(tab, blockedDomains);
      if (message.method === "Page.navigate") assertTabNotBlocked({ url: message.params?.url }, blockedDomains);
      if (message.requiresWritable) assertWritableTab(tab);
      if (message.method === "DOM.setFileInputFiles") await assertFileUploadAllowed(message, tab);
      result = await chrome.debugger.sendCommand({ tabId: message.tabId }, message.method, message.params || {});
    }
    send({ type: "response", id: message.id, result });
  } catch (error) {
    send({ type: "response", id: message.id, error: error?.message || String(error) });
  }
}

async function assertUnblockedTab(tab) {
  const { blockedDomains } = await settings();
  assertTabNotBlocked(tab, blockedDomains);
}

async function sendSitePolicy() {
  const { blockedDomains } = await settings();
  const { uploadFolders } = await uploadSettings();
  if (authenticated) send({ type: "sitePolicy", blockedDomains, uploadFolders });
}

async function assertFileUploadAllowed(message, tab) {
  if (!message.label || agentTabOwners.get(message.tabId)?.label !== message.label) {
    throw new Error("File uploads require a tab owned by your agent label; hand-shared tabs cannot upload files");
  }
  const { blockedDomains } = await settings();
  const { uploadFolders } = await uploadSettings();
  assertTabNotBlocked(tab, blockedDomains);
  assertWritableTab(tab);
  if (!uploadFolders.length) {
    throw new Error("File uploads are disabled: no allowed upload folders are configured in Extension options");
  }
  const files = message.params?.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 10) throw new Error("File uploads require 1..10 files");
  for (const file of files) {
    if (typeof file !== "string" || !file.startsWith("/") || file.includes("\0") || file.split("/").includes("..")
      || !uploadFolders.some((folder) => file.startsWith(folder))) {
      throw new Error(`Upload file ${String(file)} is outside the allowed upload folders`);
    }
  }
  if (chrome.extension?.isAllowedFileSchemeAccess && !await chrome.extension.isAllowedFileSchemeAccess()) {
    throw new Error('Enable "Allow access to file URLs" for Universal Browser Bridge in chrome://extensions');
  }
}

function assertWritableTab(tab) {
  if (isReadOnlyBrowserUrl(tab.url) || (tab.pendingUrl && isReadOnlyBrowserUrl(tab.pendingUrl))) {
    throw new Error("Bank, card, payment and password-manager pages are read-only");
  }
}

async function assertControlledTab(tabId, label) {
  const owner = agentTabOwners.get(tabId);
  if (owner && owner.label !== label) throw new Error(`Tab ${tabId} is owned by agent label "${owner.label}"`);
  if (!sharedTabs.has(tabId)) throw new Error("Tab is not shared or owned by this agent");
  if (groupingInProgress.has(tabId)) throw new Error("Tab sharing is still in progress");
  if (!await isInAgentGroup(tabId)) {
    await unshareTab(tabId, { ungroup: false });
    throw new Error("Tab is no longer shared or owned by this agent");
  }
  const tab = await chrome.tabs.get(tabId);
  if (!sharedTabs.has(tabId)) throw new Error("Tab is not shared or owned by this agent");
  return tab;
}

async function shareTab(tabId, label) {
  if (!tabId || sharedTabs.has(tabId)) return;
  await assertUnblockedTab(await chrome.tabs.get(tabId));
  await chrome.debugger.attach({ tabId }, "1.3");
  groupingInProgress.add(tabId);
  try {
    if (label) agentTabOwners.set(tabId, { label, groupId: -1 });
    sharedTabs.add(tabId);
    // Labelled tabs commit their access with finalized ownership below.
    if (!label) await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
    const groupId = await ensureAgentGroup(tabId, label || AGENT_GROUP_TITLE);
    if (label) {
      agentTabOwners.set(tabId, { label, groupId });
      await persistAgentTabs();
    }
    await chrome.action.setBadgeText({ tabId, text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0891b2" });
    await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }).catch(() => {});
    groupingInProgress.delete(tabId);
    await sendTabs();
    void refreshAnnotations(tabId).catch(() => {});
  } catch (error) {
    const inside = await isInAgentGroup(tabId);
    sharedTabs.delete(tabId);
    if (agentTabOwners.delete(tabId)) await persistAgentTabs().catch(() => {});
    await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] }).catch(() => {});
    intentionalDetach.add(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
    intentionalDetach.delete(tabId);
    await chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
    if (inside) await chrome.tabs.ungroup(tabId).catch(() => {});
    throw error;
  } finally {
    groupingInProgress.delete(tabId);
  }
}

async function unshareTab(tabId, { ungroup = true, notify = true } = {}) {
  if (!sharedTabs.has(tabId)) return;
  const inside = ungroup && await isInAgentGroup(tabId);
  sharedTabs.delete(tabId);
  if (agentTabOwners.delete(tabId)) await persistAgentTabs();
  await chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsDestroy" }).catch(() => {});
  intentionalDetach.add(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  intentionalDetach.delete(tabId);
  await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  await chrome.action.setBadgeText({ tabId, text: "" });
  await chrome.action.setTitle({ tabId, title: DEFAULT_ACTION_TITLE }).catch(() => {});
  if (inside) await chrome.tabs.ungroup(tabId).catch(() => {});
  if (notify) await sendTabs();
}

async function restoreSharedTabs(revokedOwnedTabIds = new Set()) {
  const { sharedTabIds = [] } = await chrome.storage.session.get({ sharedTabIds: [] });
  for (const tabId of sharedTabIds) {
    try {
      if (revokedOwnedTabIds.has(tabId)) throw new Error("Agent ownership was revoked while the worker was stopped");
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
      agentTabOwners.delete(tabId);
      intentionalDetach.add(tabId);
      await chrome.debugger.detach({ tabId }).catch(() => {});
      intentionalDetach.delete(tabId);
    }
  }
  await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  await persistAgentTabs();
}

// Agent-created tabs live in their own window so they never crowd the user's.
async function createAgentTab(url, label) {
  await assertUnblockedTab({ url });
  const { agentWindowId } = await chrome.storage.session.get("agentWindowId");
  if (agentWindowId !== undefined) {
    const window = await chrome.windows.get(agentWindowId).catch(() => undefined);
    if (window) {
      await assertUnblockedTab({ url });
      return chrome.tabs.create({ windowId: agentWindowId, url, active: false });
    }
  }
  const { autoCreateAgentWindow } = await settings();
  if (autoCreateAgentWindow !== true) {
    const approved = await requestApproval(
      `${label ? `[${label}] ` : ""}Create an agent-controlled Chrome window? Tabs opened there can use your signed-in Chrome session. First URL: ${url}`
    );
    if (!approved) throw new Error("User denied creation of the agent-controlled window");
  }
  await assertUnblockedTab({ url });
  const window = await chrome.windows.create({ url, focused: false });
  await chrome.storage.session.set({ agentWindowId: window.id });
  return window.tabs[0];
}

async function ensureAgentGroup(tabId, title = AGENT_GROUP_TITLE) {
  // Reuse the exact title in this window without moving tabs across windows.
  // shareTab holds groupingInProgress across setup, persistence and badges,
  // since Chrome's events are not ordered against these API-call promises.
  const tab = await chrome.tabs.get(tabId);
  // Chrome's title query is a pattern; compare titles literally for labels.
  const groups = (await chrome.tabGroups.query({ windowId: tab.windowId })).filter((group) => group.title === title);
  const groupId = groups[0]
    ? await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0].id })
    : await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
  await chrome.tabGroups.update(groupId, { title, color: "cyan", collapsed: false });
  return groupId;
}

async function isInAgentGroup(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId === undefined || tab.groupId < 0) return false;
    const group = await chrome.tabGroups.get(tab.groupId);
    const owner = agentTabOwners.get(tabId);
    return owner ? tab.groupId === owner.groupId && group.title === owner.label : group.title === AGENT_GROUP_TITLE;
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
  // Persist access and ownership together so a worker stopping mid-revocation
  // cannot restore an owned tab as an unowned, universally shared tab.
  await chrome.storage.session.set({ agentTabIds: [...agentTabs], agentTabOwners: [...agentTabOwners], sharedTabIds: [...sharedTabs] });
}

async function restoreAgentTabs() {
  const revokedOwnedTabIds = new Set();
  const { agentTabIds = [], agentTabOwners: owners = [] } = await chrome.storage.session.get({ agentTabIds: [], agentTabOwners: [] });
  for (const [tabId, owner] of owners) {
    agentTabOwners.set(tabId, owner);
    if (!await isInAgentGroup(tabId)) {
      agentTabOwners.delete(tabId);
      revokedOwnedTabIds.add(tabId);
    }
  }
  for (const tabId of agentTabIds) {
    try {
      await chrome.tabs.get(tabId);
      agentTabs.add(tabId);
    } catch {
      agentTabs.delete(tabId);
    }
  }
  return revokedOwnedTabIds;
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
  const { blockedDomains } = await settings();
  for (const id of sharedTabs) {
    if (groupingInProgress.has(id)) continue;
    try {
      const tab = await chrome.tabs.get(id);
      if (isBlockedBrowserUrl(tab.url, blockedDomains) || isBlockedBrowserUrl(tab.pendingUrl, blockedDomains)) continue;
      if (!await isInAgentGroup(id)) {
        await unshareTab(id, { ungroup: false, notify: false });
        continue;
      }
      const owner = agentTabOwners.get(id);
      tabs.push({ id, title: tab.title || "", url: tab.url || "", active: Boolean(tab.active),
        ...(tab.pendingUrl ? { pendingUrl: tab.pendingUrl } : {}),
        ...(owner ? { ownerLabel: owner.label, groupId: tab.groupId } : {}) });
    } catch {
      sharedTabs.delete(id);
      if (agentTabOwners.delete(id)) await persistAgentTabs();
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
  await assertUnblockedTab(await chrome.tabs.get(tabId));
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
    await assertUnblockedTab(current);
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
  agentTabOwners.delete(tabId);
  void persistAgentTabs();
  void chrome.tabs.sendMessage(tabId, { type: "ubbAnnotationsDestroy" }).catch(() => {});
  chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  void sendTabs();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabGenerations.delete(tabId);
  sharedTabs.delete(tabId);
  agentTabs.delete(tabId);
  agentTabOwners.delete(tabId);
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
  if (area === "local" && (changes.blockedDomains || changes.uploadFolders)) void sendSitePolicy().then(sendTabs);
});

const tabStateReady = restoreAgentTabs().then(restoreSharedTabs);
void tabStateReady.then(connect);
