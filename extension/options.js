import { normalizeBlockedDomains } from "./url-policy.js";
import { DEFAULT_UPLOAD_FOLDERS, normalizeUploadFolders } from "./upload-policy.js";

const relayUrl = document.querySelector("#relayUrl");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
const trustAgentOwnedTabs = document.querySelector("#trustAgentOwnedTabs");
const blockedDomains = document.querySelector("#blockedDomains");
const policyStatus = document.querySelector("#policyStatus");
const uploadFolders = document.querySelector("#uploadFolders");

chrome.storage.local.get({ uploadFolders: DEFAULT_UPLOAD_FOLDERS }).then((saved) => {
  uploadFolders.value = normalizeUploadFolders(saved.uploadFolders).join("\n");
});

chrome.storage.local.get({ relayUrl: "ws://127.0.0.1:17321/extension", token: "", trustAgentOwnedTabs: true, blockedDomains: [] }).then((saved) => {
  relayUrl.value = saved.relayUrl;
  token.value = saved.token;
  trustAgentOwnedTabs.checked = saved.trustAgentOwnedTabs === true;
  blockedDomains.value = normalizeBlockedDomains(saved.blockedDomains).join("\n");
});

document.querySelector("#savePolicy").addEventListener("click", async () => {
  try {
    const entries = uploadFolders.value.split(/\r?\n/);
    const folders = normalizeUploadFolders(entries);
    const ignored = entries.filter((entry) => entry.trim() && !normalizeUploadFolders([entry]).length).length;
    const domains = normalizeBlockedDomains(blockedDomains.value.split(/\r?\n/));
    await chrome.storage.local.set({ trustAgentOwnedTabs: trustAgentOwnedTabs.checked, blockedDomains: domains });
    blockedDomains.value = domains.join("\n");
    await chrome.storage.local.set({ uploadFolders: folders });
    uploadFolders.value = folders.join("\n");
    policyStatus.textContent = "Saved. Safety settings apply immediately.";
    if (ignored) policyStatus.textContent += ` Ignored ${ignored} invalid upload folder ${ignored === 1 ? "entry" : "entries"}.`;
  } catch (error) {
    policyStatus.textContent = error.message || String(error);
  }
});

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ relayUrl: relayUrl.value.trim(), token: token.value.trim() });
  status.textContent = "Saved. The toolbar badge will clear when connected.";
  setTimeout(() => (status.textContent = ""), 5000);
});
