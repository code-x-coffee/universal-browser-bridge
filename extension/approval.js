const id = new URLSearchParams(location.search).get("id");
const description = document.querySelector("#description");

if (!id) {
  description.textContent = "Invalid approval request.";
  document.querySelector("#approve").disabled = true;
} else {
  chrome.storage.session.get(`approval_${id}`).then((value) => {
    description.textContent = value[`approval_${id}`]?.description || "This request has expired.";
  });
}

async function decide(approved) {
  if (!id) return;
  await chrome.runtime.sendMessage({ type: "approvalDecision", id, approved });
  window.close();
}

document.querySelector("#approve").addEventListener("click", () => void decide(true));
document.querySelector("#deny").addEventListener("click", () => void decide(false));
