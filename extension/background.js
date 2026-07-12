const PROTOCOL_VERSION = 1;
const DEFAULT_URL = "ws://127.0.0.1:17321/extension";
const sharedTabs = new Set();
let socket;
let reconnectTimer;
let keepaliveTimer;
let intentionalDetach = new Set();

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
      const tab = await chrome.tabs.create({ url: message.url, active: false });
      await shareTab(tab.id);
      result = tab;
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

async function unshareTab(tabId) {
  if (!sharedTabs.has(tabId)) return;
  sharedTabs.delete(tabId);
  intentionalDetach.add(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  intentionalDetach.delete(tabId);
  await chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  await chrome.action.setBadgeText({ tabId, text: "" });
  await sendTabs();
}

async function restoreSharedTabs() {
  const { sharedTabIds = [] } = await chrome.storage.session.get({ sharedTabIds: [] });
  for (const tabId of sharedTabIds) {
    try {
      await chrome.tabs.get(tabId);
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

async function ensureAgentGroup(tabId) {
  const groups = await chrome.tabGroups.query({ title: "Agent Bridge" });
  const groupId = await chrome.tabs.group({ tabIds: [tabId], groupId: groups[0]?.id });
  await chrome.tabGroups.update(groupId, { title: "Agent Bridge", color: "cyan", collapsed: false });
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
  chrome.storage.session.set({ sharedTabIds: [...sharedTabs] });
  void sendTabs();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && (changes.token || changes.relayUrl)) void connect();
});

void connect();
