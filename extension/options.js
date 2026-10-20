import { normalizeBlockedDomains } from "./url-policy.js";
import { DEFAULT_UPLOAD_FOLDERS, normalizeUploadFolders } from "./upload-policy.js";
import { DEFAULT_DOWNLOAD_FOLDERS, normalizeDownloadFolders, normalizeTrustedDownloadHosts, validateTrustedDownloadHost } from "./download-policy.js";

const relayUrl = document.querySelector("#relayUrl");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
const trustAgentOwnedTabs = document.querySelector("#trustAgentOwnedTabs");
const autoCreateAgentWindow = document.querySelector("#autoCreateAgentWindow");
const blockedDomains = document.querySelector("#blockedDomains");
const policyStatus = document.querySelector("#policyStatus");
const uploadFolders = document.querySelector("#uploadFolders");
const downloadFolders = document.querySelector("#downloadFolders");
const trustedDownloadHosts = document.querySelector("#trustedDownloadHosts");

chrome.storage.local.get({ trustedDownloadHosts: [] }).then((saved) => {
  trustedDownloadHosts.value = normalizeTrustedDownloadHosts(saved.trustedDownloadHosts).join("\n");
});

chrome.storage.local.get({ uploadFolders: DEFAULT_UPLOAD_FOLDERS }).then((saved) => {
  uploadFolders.value = normalizeUploadFolders(saved.uploadFolders).join("\n");
});

chrome.storage.local.get({ downloadFolders: DEFAULT_DOWNLOAD_FOLDERS }).then((saved) => {
  downloadFolders.value = normalizeDownloadFolders(saved.downloadFolders).join("\n");
});

chrome.storage.local.get({ relayUrl: "ws://127.0.0.1:17321/extension", token: "", trustAgentOwnedTabs: true, autoCreateAgentWindow: true, blockedDomains: [] }).then((saved) => {
  relayUrl.value = saved.relayUrl;
  token.value = saved.token;
  trustAgentOwnedTabs.checked = saved.trustAgentOwnedTabs === true;
  autoCreateAgentWindow.checked = saved.autoCreateAgentWindow === true;
  blockedDomains.value = normalizeBlockedDomains(saved.blockedDomains).join("\n");
});

document.querySelector("#savePolicy").addEventListener("click", async () => {
  try {
    const entries = uploadFolders.value.split(/\r?\n/);
    const folders = normalizeUploadFolders(entries);
    const ignored = entries.filter((entry) => entry.trim() && !normalizeUploadFolders([entry]).length).length;
    const downloadEntries = downloadFolders.value.split(/\r?\n/);
    const downloadPaths = normalizeDownloadFolders(downloadEntries);
    const ignoredDownloads = downloadEntries.filter((entry) => entry.trim() && !normalizeDownloadFolders([entry]).length).length;
    const hostEntries = trustedDownloadHosts.value.split(/\r?\n/);
    const hosts = normalizeTrustedDownloadHosts(hostEntries);
    const ignoredHosts = hostEntries.flatMap((entry) => {
      const result = validateTrustedDownloadHost(entry);
      return entry.trim() && result.error ? [{ entry: entry.trim(), error: result.error }] : [];
    });
    const domains = normalizeBlockedDomains(blockedDomains.value.split(/\r?\n/));
    await chrome.storage.local.set({ trustAgentOwnedTabs: trustAgentOwnedTabs.checked, autoCreateAgentWindow: autoCreateAgentWindow.checked, blockedDomains: domains });
    blockedDomains.value = domains.join("\n");
    await chrome.storage.local.set({ uploadFolders: folders });
    uploadFolders.value = folders.join("\n");
    await chrome.storage.local.set({ downloadFolders: downloadPaths });
    downloadFolders.value = downloadPaths.join("\n");
    await chrome.storage.local.set({ trustedDownloadHosts: hosts });
    trustedDownloadHosts.value = hosts.join("\n");
    policyStatus.textContent = "Saved. Safety settings apply immediately.";
    if (ignored) policyStatus.textContent += ` Ignored ${ignored} invalid upload folder ${ignored === 1 ? "entry" : "entries"}.`;
    if (ignoredDownloads) policyStatus.textContent += ` Ignored ${ignoredDownloads} invalid download folder ${ignoredDownloads === 1 ? "entry" : "entries"}.`;
    for (const { entry, error } of ignoredHosts.slice(0, 3)) {
      const preview = entry.length > 80 ? entry.slice(0, 77) + "..." : entry;
      policyStatus.textContent += ` Ignored ${JSON.stringify(preview)}: ${error}.`;
    }
    if (ignoredHosts.length > 3) policyStatus.textContent += ` ${ignoredHosts.length - 3} more invalid trusted download host entries ignored.`;
  } catch (error) {
    policyStatus.textContent = error.message || String(error);
  }
});

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ relayUrl: relayUrl.value.trim(), token: token.value.trim() });
  status.textContent = "Saved. The toolbar badge will clear when connected.";
  setTimeout(() => (status.textContent = ""), 5000);
});
