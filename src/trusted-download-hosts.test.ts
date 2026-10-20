import { expect, it } from "vitest";
import { normalizeTrustedDownloadHosts, assertDownloadUrl } from "../extension/download-policy.js";

it("normalizes exact DNS hosts and ignores malformed entries, wildcards and IP literals", () => {
  expect(normalizeTrustedDownloadHosts([" Storage.GoogleAPIs.COM. ", "storage.googleapis.com", "flow.google.com", "localhost",
    "https://cdn.example", "cdn.example/path", "cdn.example:443", "user@cdn.example", "cdn.example?q=x", "two hosts",
    "*.example.com", "127.0.0.1", "[::1]", "0x7f000001", "-bad.example", "bad_.example", "", null]))
    .toEqual(["storage.googleapis.com", "flow.google.com", "localhost"]);
  expect(normalizeTrustedDownloadHosts(undefined)).toEqual([]);
});
it("allows only explicitly trusted cross-origin HTTPS and unchanged local sources", () => {
  expect(assertDownloadUrl("https://CDN.example/clip?token=secret", "https://flow.google.com/", ["cdn.example"]))
    .toBe("https://cdn.example/clip?token=secret");
  for (const url of ["https://flow.google.com/media", "blob:https://flow.google.com/id", "data:text/plain,ok"])
    expect(assertDownloadUrl(url, "https://flow.google.com/")).toBe(url);
  expect(assertDownloadUrl("http://local.example/media", "http://local.example/")).toBe("http://local.example/media");
});
it.each([
  ["https://cdn.example/private/path?token=secret#fragment", [], /not a trusted download host/],
  ["https://sub.cdn.example/private?token=secret", ["cdn.example"], /not a trusted download host/],
  ["http://cdn.example/private?token=secret", ["cdn.example"], /uses plain http/],
])("refuses %s with hostname-only guidance", (url, hosts, pattern) => {
  let error = "";
  try { assertDownloadUrl(url, "https://flow.google.com/", hosts as string[]); } catch (value) { error = (value as Error).message; }
  expect(error).toMatch(pattern as RegExp);
  expect(error).toContain("cdn.example");
  expect(error).toContain('"Trusted download hosts" in Extension options');
  expect(error).not.toMatch(/private|token|secret|fragment/);
});
it("requires HTTPS even for same-origin redirect hops and refuses blocklisted hosts", () => {
  expect(() => assertDownloadUrl("http://flow.google.com/private?token=secret", "http://flow.google.com/", [], { redirect: true }))
    .toThrow(/flow.google.com uses plain http/);
  expect(() => assertDownloadUrl("https://cdn.example/private?token=secret", "https://flow.google.com/", ["cdn.example"], { blockedDomains: ["example"] }))
    .toThrow("Download host cdn.example is blocked by your blocklist");
});
