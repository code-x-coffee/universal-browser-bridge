const relayUrl = document.querySelector("#relayUrl");
const token = document.querySelector("#token");
const status = document.querySelector("#status");

chrome.storage.local.get({ relayUrl: "ws://127.0.0.1:17321/extension", token: "" }).then((saved) => {
  relayUrl.value = saved.relayUrl;
  token.value = saved.token;
});

document.querySelector("#save").addEventListener("click", async () => {
  await chrome.storage.local.set({ relayUrl: relayUrl.value.trim(), token: token.value.trim() });
  status.textContent = "Saved. The toolbar badge will clear when connected.";
  setTimeout(() => (status.textContent = ""), 5000);
});
