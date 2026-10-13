const READ_ONLY_DOMAINS = [
  "hdfcbank.com", "hdfc.bank.in", "icicibank.com", "icici.bank.in", "axisbank.com", "axis.bank.in",
  "kotak.com", "kotak.bank.in", "onlinesbi.com", "sbi.co.in", "sbi.bank.in", "sbi",
  "hsbc.com", "hsbc.co.in", "chase.com", "citi.com", "citibank.com", "bankofamerica.com",
  "wellsfargo.com", "barclays.co.uk", "paypal.com", "stripe.com", "razorpay.com", "payu.in",
  "payu.com", "paytm.com", "phonepe.com", "ccavenue.com", "cashfree.com", "adyen.com",
  "americanexpress.com", "discover.com", "capitalone.com", "visa.com", "mastercard.com",
  "1password.com", "bitwarden.com", "lastpass.com", "dashlane.com", "keepersecurity.com",
  "passwords.google.com", "nordpass.com", "pass.proton.me"
];

// Conservative URL classification, not an exhaustive sensitive-site directory.
// Never let the private-network opt-in disable financial-site protection.
export function isReadOnlyBrowserUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return READ_ONLY_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
      || /(^|[.\-])(bank|banking|netbanking|onlinebanking|payments?|checkout)([.\-]|$)/.test(hostname)
      || ((hostname === "proton.me" || hostname.endsWith(".proton.me")) && /^\/pass(\/|$)/i.test(decodeURIComponent(url.pathname)))
      || /\/(checkout|payments?|pay)(\/|$)/i.test(decodeURIComponent(url.pathname));
  } catch {
    return true;
  }
}

export function normalizeBlockedDomains(values) {
  if (!Array.isArray(values)) throw new Error("Blocked domains must be an array");
  const domains = new Set();
  for (const value of values) {
    if (typeof value !== "string") throw new Error("Invalid blocked domain");
    const input = value.trim();
    if (!input) continue;
    try {
      const url = new URL(input.startsWith("//") ? `https:${input}`
        : /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
      const domain = url.hostname.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
      if (!domain || (!/^\[[a-f\d:]+\]$/i.test(domain)
        && !domain.split(".").every((part) => /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(part)))) {
        throw new Error("Invalid hostname");
      }
      domains.add(domain);
    } catch {
      throw new Error(`Invalid blocked domain: ${input}`);
    }
  }
  return [...domains];
}

export function isBlockedBrowserUrl(value, blockedDomains) {
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.+$/, "");
    return blockedDomains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

export function assertTabNotBlocked(tab, blockedDomains) {
  if (isBlockedBrowserUrl(tab.url, blockedDomains) || isBlockedBrowserUrl(tab.pendingUrl, blockedDomains)) {
    throw new Error("This site is blocked by your blocklist");
  }
}
