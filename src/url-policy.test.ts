import { afterEach, describe, expect, it } from "vitest";
import { assertBrowserUrlAllowed, isPrivateNetworkUrl, isReadOnlyBrowserUrl, normalizeBlockedDomains, isBlockedBrowserUrl } from "./url-policy.js";

afterEach(() => delete process.env.UBB_ALLOW_PRIVATE_NETWORKS);

describe("browser URL policy", () => {
  it("allows public HTTP(S) and rejects non-web schemes", () => {
    expect(assertBrowserUrlAllowed("https://example.com/path")).toBe(true);
    expect(assertBrowserUrlAllowed("file:///etc/passwd")).toBe(false);
    expect(assertBrowserUrlAllowed("not a URL")).toBe(false);
  });

  it("recognizes common private-network targets", () => {
    expect(isPrivateNetworkUrl("http://localhost:3000")).toBe(true);
    expect(isPrivateNetworkUrl("http://127.0.0.1")).toBe(true);
    expect(isPrivateNetworkUrl("http://192.168.1.1")).toBe(true);
    expect(isPrivateNetworkUrl("http://172.20.0.2")).toBe(true);
    expect(isPrivateNetworkUrl("http://[::1]")).toBe(true);
  });

  it("allows private networks only after explicit opt-in", () => {
    expect(assertBrowserUrlAllowed("http://localhost:3000")).toBe(false);
    process.env.UBB_ALLOW_PRIVATE_NETWORKS = "1";
    expect(assertBrowserUrlAllowed("http://localhost:3000")).toBe(true);
  });

  it.each(["https://netbanking.hdfcbank.com/", "https://www.onlinesbi.sbi/", "https://retail.icici.bank.in/",
    "https://www.kotak.com/", "https://www.paypal.com/", "https://checkout.stripe.com/", "https://api.razorpay.com/",
    "https://bank.example.org/", "https://example.org/%63heckout/order", "https://example.org/payments/"])(
    "protects financial URLs without relying on private-network settings: %s", (url) => {
      process.env.UBB_ALLOW_PRIVATE_NETWORKS = "1";
      expect(isReadOnlyBrowserUrl(url)).toBe(true);
    }
  );

  it.each(["https://example.com/", "https://paypal.com.example.org/", "https://example.org/checkout-guide",
    "https://example.org/?next=https://paypal.com", "https://proton.me/mail", "https://proton.me/pass-guide",
    "https://1password.com.example.org/", "https://google.com/", "https://example.org/pass"])("does not classify ordinary URLs as protected: %s", (url) => {
    expect(isReadOnlyBrowserUrl(url)).toBe(false);
  });

  it.each(["https://1password.com/", "https://my.1password.com/", "https://bitwarden.com/",
    "https://vault.bitwarden.com/", "https://lastpass.com/", "https://dashlane.com/",
    "https://keepersecurity.com/", "https://passwords.google.com/", "https://nordpass.com/",
    "https://proton.me/pass", "https://proton.me/%70ass/download", "https://pass.proton.me/",
    "https://americanexpress.com/", "https://discover.com/", "https://capitalone.com/",
    "https://visa.com/", "https://www.mastercard.com/"])("keeps password-manager and card pages read-only: %s", (url) => {
    expect(isReadOnlyBrowserUrl(url)).toBe(true);
  });
});

describe("site blocklist", () => {
  it("normalizes pasted URLs and domains, removes www, blank lines and duplicates", () => {
    expect(normalizeBlockedDomains([" HTTPS://WWW.Example.COM/private?x=1 ", "example.com", "",
      "Vault.Bitwarden.COM/path", "www.EXAMPLE.org.:443/login", "//www.example.net/path", "bücher.de"]))
      .toEqual(["example.com", "vault.bitwarden.com", "example.org", "example.net", "xn--bcher-kva.de"]);
    expect(normalizeBlockedDomains([])).toEqual([]);
    expect(() => normalizeBlockedDomains(["not a domain"])).toThrow(/invalid.*domain/i);
  });

  it("blocks exact domains and subdomains without matching lookalikes or URL text", () => {
    const domains = ["example.com", "vault.bitwarden.com"];
    for (const url of ["https://example.com/", "https://www.example.com/path", "https://a.b.example.com/",
      "https://EXAMPLE.com./", "https://vault.bitwarden.com/", "https://eu.vault.bitwarden.com/"]) {
      expect(isBlockedBrowserUrl(url, domains)).toBe(true);
    }
    for (const url of ["https://example.com.evil.org/", "https://notexample.com/", "https://example.org/example.com",
      "https://example.org/?next=https://example.com", "https://bitwarden.com/", "about:blank"]) {
      expect(isBlockedBrowserUrl(url, domains)).toBe(false);
    }
    expect(isBlockedBrowserUrl("https://example.com/", [])).toBe(false);
  });
});
