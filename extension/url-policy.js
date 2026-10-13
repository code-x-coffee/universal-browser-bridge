const READ_ONLY_DOMAINS = [
  "hdfcbank.com", "hdfc.bank.in", "icicibank.com", "icici.bank.in", "axisbank.com", "axis.bank.in",
  "kotak.com", "kotak.bank.in", "onlinesbi.com", "sbi.co.in", "sbi.bank.in", "sbi",
  "hsbc.com", "hsbc.co.in", "chase.com", "citi.com", "citibank.com", "bankofamerica.com",
  "wellsfargo.com", "barclays.co.uk", "paypal.com", "stripe.com", "razorpay.com", "payu.in",
  "payu.com", "paytm.com", "phonepe.com", "ccavenue.com", "cashfree.com", "adyen.com"
];

// Conservative URL classification, not a claim to recognize every bank.
// Never let the private-network opt-in disable financial-site protection.
export function isReadOnlyBrowserUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    return READ_ONLY_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
      || /(^|[.\-])(bank|banking|netbanking|onlinebanking|payments?|checkout)([.\-]|$)/.test(hostname)
      || /\/(checkout|payments?|pay)(\/|$)/i.test(decodeURIComponent(url.pathname));
  } catch {
    return true;
  }
}
