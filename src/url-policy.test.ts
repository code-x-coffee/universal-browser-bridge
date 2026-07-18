import { afterEach, describe, expect, it } from "vitest";
import { assertBrowserUrlAllowed, isPrivateNetworkUrl } from "./url-policy.js";

afterEach(() => delete process.env.UBB_ALLOW_PRIVATE_NETWORKS);

describe("browser URL policy", () => {
  it("allows public HTTP(S) and rejects non-web schemes", () => {
    expect(assertBrowserUrlAllowed("https://example.com/path")).toBe(true);
    expect(assertBrowserUrlAllowed("file:///etc/passwd")).toBe(false);
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
});
