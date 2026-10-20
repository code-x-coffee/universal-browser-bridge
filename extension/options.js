import { normalizeBlockedDomains } from "./url-policy.js";

const relayUrl = document.querySelector("#relayUrl");
const token = document.querySelector("#token");
const status = document.querySelector("#status");
const trustAgentOwnedTabs = document.querySelector("#trustAgentOwnedTabs");
const autoCreateAgentWindow = document.querySelector("#autoCreateAgentWindow");
const blockedDomains = document.querySelector("#blockedDomains");
const policyStatus = document.querySelector("#policyStatus");

chrome.storage.local.get({ relayUrl: "ws://127.0.0.1:17321/extension", token: "", trustAgentOwnedTabs: true, autoCreateAgentWindow: true, blockedDomains: [] }).then((saved) => {
  relayUrl.value = saved.relayUrl;
  token.value = saved.token;
  trustAgentOwnedTabs.checked = saved.trustAgentOwnedTabs === true;
  autoCreateAgentWindow.checked = saved.autoCreateAgentWindow === true;
  blockedDomains.value = normalizeBlockedDomains(saved.blockedDomains).join("\n");
});

document.querySelector("#savePolicy").addEventListener("click", async () => {
  try {
    const domains = normalizeBlockedDomains(blockedDomains.value.split(/\r?\n/));
    await chrome.storage.local.set({ trustAgentOwnedTabs: trustAgentOwnedTabs.checked, autoCreateAgentWindow: autoCreateAgentWindow.checked, blockedDomains: domains });
    blockedDomains.value = domains.join("\n");
    policyStatus.textContent = "Saved. Safety settings apply immediately.";
  } catch (error) {
    policyStatus.textContent = error.message || String(error);
  }
});

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ relayUrl: relayUrl.value.trim(), token: token.value.trim() });
  status.textContent = "Saved. The toolbar badge will clear when connected.";
  setTimeout(() => (status.textContent = ""), 5000);
});
