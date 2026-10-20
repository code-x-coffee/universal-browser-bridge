import { expect, it } from "vitest";
import { normalizeTrustedDownloadHosts, validateTrustedDownloadHost, isTrustedDownloadHost, assertDownloadUrl } from "../extension/download-policy.js";

it("normalizes exact DNS hosts and ignores malformed entries and IP literals", () => {
  expect(normalizeTrustedDownloadHosts([" Storage.GoogleAPIs.COM. ", "storage.googleapis.com", "flow.google.com", "localhost",
    "https://cdn.example", "cdn.example/path", "cdn.example:443", "user@cdn.example", "cdn.example?q=x", "two hosts",
    "*.example.com", "127.0.0.1", "[::1]", "0x7f000001", "-bad.example", "bad_.example", "", null]))
    .toEqual(["storage.googleapis.com", "flow.google.com", "localhost", "*.example.com"]);
  expect(normalizeTrustedDownloadHosts(undefined)).toEqual([]);
});
it("deduplicates wildcards while allowing exact hosts and wildcard bases to coexist", () => {
  expect(normalizeTrustedDownloadHosts([" *.Example.COM. ", "*.example.com", "example.com", "a.example.com", "*.co.uk"]))
    .toEqual(["*.example.com", "example.com", "a.example.com", "*.co.uk"]);
  expect(validateTrustedDownloadHost(" *.GOOGLEVIDEO.COM. ")).toEqual({ host: "*.googlevideo.com" });
});
it.each<[unknown, string]>([
  ["*", 'wildcard must be a single leading "*." label'],
  ["*.", 'wildcard needs at least two labels after "*."'],
  ["*.com", 'wildcard needs at least two labels after "*."'],
  ["*.google", 'wildcard needs at least two labels after "*."'],
  ...["**.x.com", "*.*.x.com", "a.*.com", "*x.com", "x*.com"].map<[string, string]>(entry => [entry, 'wildcard must be a single leading "*." label']),
  ...["*.1.2.3.4", "*.127.1", "*.0177.0.0.1", "*.0x7f.0.0.1", "*.0x7f000001", "*.2130706433", "127.0.0.1", "0x7f000001", "[::1]", "*.[::1]"].map<[string, string]>(entry => [entry, "IP literals are not allowed"]),
  ...["https://cdn.example", "cdn.example/path", "cdn.example:443", "user@cdn.example", "cdn.example?q=x", "two hosts",
    "-bad.example", "bad-.example", "bad_.example", "a..example", "é.example", "*.bad_.example", "*.example.com..", "*.https://example.com", "a".repeat(64) + ".com"]
    .map<[string, string]>(entry => [entry, "use a bare ASCII DNS hostname with labels of 1-63 letters, digits or hyphens"]),
  ["a.".repeat(127) + "com", "hostname must be at most 253 characters"],
  ["", "hostname is required"],
  [null, "hostname must be text"],
])("rejects trusted host %s with a specific reason", (entry, error) => {
  expect(validateTrustedDownloadHost(entry)).toEqual({ error });
  expect(normalizeTrustedDownloadHosts([entry])).toEqual([]);
});
it.each([
  ["a.example.com", ["*.example.com"], true],
  ["a.b.example.com", ["*.example.com"], true],
  ["A.B.EXAMPLE.COM.", [" *.Example.Com. "], true],
  ["CDN.EXAMPLE.", ["cdn.example."], true],
  ["example.com", ["*.example.com"], false],
  ["example.com.", ["*.example.com."], false],
  ["evilexample.com", ["*.example.com"], false],
  ["example.com.evil.net", ["*.example.com"], false],
  ["sub.cdn.example", ["cdn.example"], false],
  ["example.com", ["*.example.com", "example.com"], true],
  ["a.example.com", ["*", "*.*.example.com", "*.com"], false],
])("matches %s only at exact or wildcard dot boundaries", (hostname, hosts, expected) => {
  expect(isTrustedDownloadHost(hostname as string, hosts as string[])).toBe(expected);
});
it("uses wildcard matching for sources and redirects, with blocklist precedence", () => {
  const url = "https://RR4---SN-H5576N7K.GoogleVideo.COM./private?token=secret";
  expect(assertDownloadUrl(url, "https://flow.google.com/", ["*.googlevideo.com."]))
    .toBe("https://rr4---sn-h5576n7k.googlevideo.com./private?token=secret");
  expect(assertDownloadUrl(url, "https://flow.google.com/", ["*.googlevideo.com"], { redirect: true })).toContain("rr4---sn");
  expect(() => assertDownloadUrl(url, "https://flow.google.com/", ["*.googlevideo.com"], { blockedDomains: ["googlevideo.com"] }))
    .toThrow("Download host rr4---sn-h5576n7k.googlevideo.com is blocked by your blocklist");
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
  ["https://googlevideo.com.evil.net/private/path?token=secret#fragment", ["*.googlevideo.com"], /not a trusted download host/],
  ["https://a.example.com../private?token=secret", ["*.example.com"], /not a trusted download host/],
])("refuses %s with hostname-only guidance", (url, hosts, pattern) => {
  let error = "";
  try { assertDownloadUrl(url, "https://flow.google.com/", hosts as string[]); } catch (value) { error = (value as Error).message; }
  expect(error).toMatch(pattern as RegExp);
  expect(error).toContain(new URL(url as string).hostname.replace(/\.$/, ""));
  expect(error).toContain('"Trusted download hosts" in Extension options');
  expect(error).not.toMatch(/private|token|secret|fragment/);
});
it("requires HTTPS even for same-origin redirect hops and refuses blocklisted hosts", () => {
  expect(() => assertDownloadUrl("http://flow.google.com/private?token=secret", "http://flow.google.com/", [], { redirect: true }))
    .toThrow(/flow.google.com uses plain http/);
  expect(() => assertDownloadUrl("https://cdn.example/private?token=secret", "https://flow.google.com/", ["cdn.example"], { blockedDomains: ["example"] }))
    .toThrow("Download host cdn.example is blocked by your blocklist");
});
