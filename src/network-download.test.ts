import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createChromeMock } from "./test-support/chrome-mock.js";
import { assertDownloadUrl } from "../extension/download-policy.js";

let mock: ReturnType<typeof createChromeMock>;
let networkDownload: (message: any, guard?: any) => Promise<any>;
let cancelNetworkDownloads: (tabId?: number, detached?: boolean) => Promise<void>;
let send: any;
let next: number;
let responses: any[];
let reads: any[];
let hosts: string[];
let blocked: string[];
let revoked: boolean;
const message = (action: string, extra = {}) => ({ action, tabId: 7, label: "Agent", downloadKey: "test-key", downloadFolder: "/tmp/", ...extra });
const guard = async (url: string, redirect = false) => {
  if (revoked) throw new Error("Tab is no longer shared or owned by this agent");
  return assertDownloadUrl(url, "https://flow.google.com/", hosts, { redirect, blockedDomains: blocked });
};
const event = (params: any, tabId = 7) => { for (const listener of [...mock.debuggerOnEvent]) listener({ tabId }, "Fetch.requestPaused", params); };
function identify() {
  for (const listener of [...mock.debuggerOnEvent]) listener({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "network", request: { url: "https://flow.google.com/clip?token=secret" }, initiator: { stack: { callFrames: [{ url: "ubb-download-test-key" }] } }
  });
}
function response() {
  const value = responses[next++];
  if (value && next === 1) {
    for (const listener of [...mock.debuggerOnEvent]) listener({ tabId: 7 }, "Network.requestWillBeSent", {
      requestId: "network", request: { url: value.request.url }, initiator: { stack: { callFrames: [{ url: "ubb-download-test-key" }] } }
    });
  }
  if (value) event({ resourceType: "Fetch", requestId: `r${next}`, networkId: "network", redirectedRequestId: next > 1 ? `r${next - 1}` : undefined, ...value });
}
const start = (url = "https://flow.google.com/clip?token=secret") => networkDownload(message("downloadStart", { url }), guard);
const advance = () => networkDownload(message("downloadContinue"));
const read = () => networkDownload(message("downloadRead"));
const close = () => networkDownload(message("downloadCancel"));
const tick = () => vi.advanceTimersByTimeAsync(0);
const final = (url = "https://flow.google.com/clip?token=secret", headers: any[] = []) => ({ request: { url }, responseStatusCode: 200, responseHeaders: headers });
const redirect = (url: string, location: string) => ({ request: { url }, responseStatusCode: 302, responseHeaders: [{ name: "Location", value: location }] });
function cleaned() {
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.disable", {});
  expect(mock.debuggerOnEvent).toEqual([]);
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  mock = createChromeMock(); vi.stubGlobal("chrome", mock.chrome);
  // @ts-expect-error Plain extension JavaScript.
  ({ networkDownload, cancelNetworkDownloads } = await import("../extension/network-download.js"));
  next = 0; responses = [final()]; hosts = ["cdn.example"]; blocked = []; revoked = false;
  reads = [{ data: "AAEC/w==", base64Encoded: true, eof: true }];
  send = vi.spyOn(mock.chrome.debugger, "sendCommand").mockImplementation(async (_target: unknown, method: string, params: any) => {
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
    if (method === "Page.createIsolatedWorld") return { executionContextId: 123 };
    if (method === "Runtime.evaluate" && params.expression.includes("fetch(")) response();
    if (method === "Fetch.continueRequest" && params.requestId.startsWith("r")) response();
    if (method === "Fetch.takeResponseBodyAsStream") return { stream: "stream-1" };
    if (method === "IO.read") return reads.shift();
    if (method === "Runtime.evaluate") return { result: { value: true } };
    return {};
  });
});
afterEach(async () => {
  await cancelNetworkDownloads(undefined, true); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});
it("streams cross-origin no-cors bytes through Chrome IO and closes every resource", async () => {
  responses = [final("https://cdn.example/clip?token=secret", [{ name: "Content-Type", value: "video/mp4" }])];
  expect(await start("https://cdn.example/clip?token=secret")).toMatchObject({ mimeType: "video/mp4" });
  expect(await read()).toEqual({ data: "AAEC/w==", base64Encoded: true, eof: true });
  const expression = send.mock.calls.find((call: any) => call[1] === "Runtime.evaluate" && call[2].expression.includes("fetch("))[2].expression;
  expect(expression).toContain("no-cors"); expect(expression).toContain("include"); expect(expression).toContain("no-store");
  expect(send.mock.calls.some((call: any) => call[1] === "Runtime.evaluate" && call[2].contextId === 123)).toBe(true);
  await close();
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "IO.read", { handle: "stream-1", size: 1048576 });
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "IO.close", { handle: "stream-1" });
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" });
  cleaned();
});
it("holds a same-origin to trusted redirect for daemon validation before continuing", async () => {
  responses = [redirect("https://flow.google.com/clip?token=secret", "https://cdn.example/media?token=secret"), final("https://cdn.example/media?token=secret")];
  expect(await start()).toEqual({ redirectUrl: "https://cdn.example/media?token=secret" });
  expect(next).toBe(1);
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest" && call[2].requestId === "r1")).toBe(false);
  expect(await advance()).toMatchObject({ mimeType: "application/octet-stream" });
  expect(next).toBe(2);
});
it("holds a same-origin redirect to a wildcard subdomain until the daemon continues", async () => {
  hosts = ["*.googlevideo.com"];
  const target = "https://rr4---sn-h5576n7k.googlevideo.com/media?token=secret";
  responses = [redirect("https://flow.google.com/clip?token=secret", target), final(target)];
  expect(await start()).toEqual({ redirectUrl: target });
  expect(next).toBe(1);
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest")).toBe(false);
  expect(await advance()).toMatchObject({ mimeType: "application/octet-stream" });
  expect(await read()).toMatchObject({ data: "AAEC/w==", eof: true });
  await close(); cleaned();
});
it("refuses a wildcard lookalike redirect before continuation with hostname-only guidance", async () => {
  hosts = ["*.googlevideo.com"];
  responses = [redirect("https://flow.google.com/clip?token=secret", "https://googlevideo.com.evil.net/private?token=secret#fragment")];
  await expect(start()).rejects.toThrow('Download host googlevideo.com.evil.net is not a trusted download host; add it under "Trusted download hosts" in Extension options');
  expect(next).toBe(1);
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest")).toBe(false);
  cleaned();
});
it.each([
  ["https://evil.example/private?token=secret", /evil.example is not a trusted download host/],
  ["http://cdn.example/private?token=secret", /cdn.example uses plain http/]
])("refuses redirect %s before sending the next hop", async (location, pattern) => {
  responses = [redirect("https://flow.google.com/clip?token=secret", location as string)];
  const result = start(); const check = expect(result).rejects.toThrow(pattern as RegExp); await check;
  expect(next).toBe(1);
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest")).toBe(false);
  cleaned();
});
it("refuses an untrusted initial URL before enabling Fetch", async () => {
  await expect(start("https://evil.example/private?token=secret")).rejects.toThrow(/evil.example/);
  expect(send).not.toHaveBeenCalled();
});
it("rechecks live host policy before continuing a paused redirect", async () => {
  responses = [redirect("https://flow.google.com/clip?token=secret", "https://cdn.example/media")];
  await start(); hosts = [];
  await expect(advance()).rejects.toThrow(/cdn.example is not a trusted/);
  expect(next).toBe(1); cleaned();
});
it("caps redirect chains at ten hops", async () => {
  responses = Array.from({ length: 11 }, (_, i) => redirect(`https://flow.google.com/${i || "clip?token=secret"}`, `/${i + 1}`));
  await start(); for (let i = 1; i < 10; i++) await advance();
  await expect(advance()).rejects.toThrow(/redirect limit/i);
  expect(next).toBe(11); cleaned();
});
it("continues unrelated requests immediately, including a different redirect chain at the expected URL", async () => {
  responses = [];
  const pending = start(); await tick();
  event({ requestId: "other", request: { url: "https://unrelated.example/private" }, responseStatusCode: 200 });
  await tick();
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.continueRequest", { requestId: "other" });
  identify();
  event({ requestId: "r1", networkId: "network", request: { url: "https://flow.google.com/clip?token=secret" }, responseStatusCode: 200 });
  await pending;
});
it("refuses oversized content-length before taking a body stream", async () => {
  responses = [final(undefined, [{ name: "Content-Length", value: "524288001" }])];
  await expect(start()).rejects.toThrow(/500 MB/);
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.takeResponseBodyAsStream")).toBe(false); cleaned();
});
it("counts streamed bytes even without content-length and handles textual IO chunks", async () => {
  reads = Array.from({ length: 500 }, () => ({ data: "a".repeat(1048576), base64Encoded: false, eof: false }));
  reads.push({ data: "é", base64Encoded: false, eof: true });
  await start(); for (let i = 0; i < 500; i++) await read();
  await expect(read()).rejects.toThrow(/500 MB/);
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "IO.close", { handle: "stream-1" }); cleaned();
});
it.each(["IO.read", "Fetch.takeResponseBodyAsStream"])("cleans up on %s error without echoing signed CDP errors", async (method) => {
  const impl = send.getMockImplementation();
  send.mockImplementation(async (target: any, name: string, params: any) => { if (name === method) throw new Error("private?token=secret"); return impl(target, name, params); });
  if (method === "IO.read") { await start(); await expect(read()).rejects.toThrow(/IO.read failed/); }
  else await expect(start()).rejects.toThrow(/Fetch.takeResponseBodyAsStream failed/);
  cleaned();
});
it("cleans up on permission revocation and disconnect without requiring renewed permission", async () => {
  await start(); revoked = true;
  await expect(read()).rejects.toThrow(/no longer shared/); cleaned();
  revoked = false; next = 0; await start();
  await cancelNetworkDownloads(); cleaned();
});
it("times out abandoned redirects and hung requests, disabling interception", async () => {
  responses = [];
  const pending = start(); const check = expect(pending).rejects.toThrow(/timed out/i);
  await vi.advanceTimersByTimeAsync(120001); await check; cleaned();
});
it("rejects non-2xx status codes and blocklisted redirect hosts", async () => {
  responses = [{ ...final(), responseStatusCode: 403 }];
  await expect(start()).rejects.toThrow(/HTTP 403/); cleaned();
  next = 0; blocked = ["cdn.example"];
  responses = [redirect("https://flow.google.com/clip?token=secret", "https://cdn.example/private?token=secret")];
  await expect(start()).rejects.toThrow("Download host cdn.example is blocked by your blocklist");
});

it("keeps a different request at the redirect URL outside the download chain", async () => {
  responses = [redirect("https://flow.google.com/clip?token=secret", "https://cdn.example/next")];
  await start();
  const pending = advance(); await tick();
  event({ requestId: "other", networkId: "other-network", request: { url: "https://cdn.example/next" }, responseStatusCode: 200 });
  await tick();
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.continueRequest", { requestId: "other" });
  event({ requestId: "r2", redirectedRequestId: "r1", networkId: "network", request: { url: "https://cdn.example/next" }, responseStatusCode: 200 });
  expect(await pending).toMatchObject({ mimeType: "application/octet-stream" });
});
it("closes a body handle returned after its CDP operation timed out", async () => {
  const impl = send.getMockImplementation();
  let late: (result: unknown) => void = () => {};
  send.mockImplementation((target: any, method: string, params: any) => method === "Fetch.takeResponseBodyAsStream"
    ? new Promise(resolve => { late = resolve; }) : impl(target, method, params));
  const pending = start(); const check = expect(pending).rejects.toThrow(/Fetch.takeResponseBodyAsStream timed out/);
  await vi.advanceTimersByTimeAsync(15001); await check;
  late({ stream: "late-stream" }); await tick();
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "IO.close", { handle: "late-stream" }); cleaned();
});
it("attempts all cleanup operations even when IO.close fails", async () => {
  await start();
  const impl = send.getMockImplementation();
  send.mockImplementation((target: any, method: string, params: any) => method === "IO.close" ? Promise.reject(new Error("failed")) : impl(target, method, params));
  await expect(close()).rejects.toThrow(/cleanup incomplete/);
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.failRequest", { requestId: "r1", errorReason: "Aborted" });
  send.mockImplementation(impl); await vi.advanceTimersByTimeAsync(5001); cleaned();
});
it("rejects malformed redirects, response errors and wrong-session cancellation", async () => {
  responses = [redirect("https://flow.google.com/clip?token=secret", "https://[invalid?token=secret")];
  await expect(start()).rejects.toThrow("Invalid download redirect URL"); cleaned();
  next = 0; responses = [{ ...final(), responseErrorReason: "Failed" }];
  await expect(start()).rejects.toThrow("Download request failed in Chrome"); cleaned();
  next = 0; responses = [final()]; await start();
  await expect(networkDownload(message("downloadCancel", { label: "Other" }))).rejects.toThrow(/owned by another/);
  expect(await read()).toMatchObject({ eof: true });
});

it("bypasses service workers for the transaction and always restores interception settings", async () => {
  await start(); await close();
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Network.setBypassServiceWorker", { bypass: true });
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Network.setBypassServiceWorker", { bypass: false });
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Network.disable", {});
});
it("continues a page fetch of the exact source URL instead of mistaking it for our download", async () => {
  responses = [];
  const pending = start(); await tick();
  event({ requestId: "page-request", networkId: "page-network", ...final() }); await tick();
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.takeResponseBodyAsStream")).toBe(false);
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest" && call[2].requestId === "page-request")).toBe(false);
  for (const listener of [...mock.debuggerOnEvent]) listener({ tabId: 7 }, "Network.requestWillBeSent", {
    requestId: "network", request: { url: "https://flow.google.com/clip?token=secret" }, initiator: { stack: { callFrames: [{ url: "ubb-download-test-key" }] } }
  });
  event({ requestId: "r1", networkId: "network", ...final() });
  expect(await pending).toMatchObject({ mimeType: "application/octet-stream" });
});

it("keeps the real redirect blocked when a page fetch to the same URL arrives first", async () => {
  responses = [];
  const pending = start(); const check = expect(pending).rejects.toThrow(/evil.example is not a trusted/); await tick();
  event({ requestId: "page-request", networkId: "page-network", ...final() }); await tick();
  identify();
  event({ requestId: "r1", networkId: "network", ...redirect("https://flow.google.com/clip?token=secret", "https://evil.example/private?token=secret") });
  await check;
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.continueRequest", { requestId: "page-request" });
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest" && call[2].requestId === "r1")).toBe(false);
  cleaned();
});
it("retains interception if both request cancellation and page abort fail, then retries safely", async () => {
  responses = [redirect("https://flow.google.com/clip?token=secret", "https://evil.example/private?token=secret")];
  const impl = send.getMockImplementation();
  let failures = true;
  send.mockImplementation((target: any, method: string, params: any) => {
    if (failures && (method === "Fetch.failRequest" || method === "Runtime.evaluate" && !params.expression.includes("fetch("))) return Promise.reject(new Error("private?token=secret"));
    return impl(target, method, params);
  });
  await expect(start()).rejects.toThrow(/evil.example/);
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.disable")).toBe(false);
  expect(mock.debuggerOnEvent).toHaveLength(1);
  failures = false;
  await vi.advanceTimersByTimeAsync(5001);
  cleaned();
});

it("fails closed when Chrome omits the tagged request identity", async () => {
  responses = [];
  const pending = start(); const check = expect(pending).rejects.toThrow(/identified safely/); await tick();
  event({ requestId: "unknown", networkId: "unknown-network", ...redirect("https://flow.google.com/clip?token=secret", "https://evil.example/private?token=secret") });
  await vi.advanceTimersByTimeAsync(120001); await check;
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest")).toBe(false);
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.failRequest", { requestId: "unknown", errorReason: "Aborted" }); cleaned();
});
it("retains its listener when Fetch.disable fails and retries without releasing own requests", async () => {
  await start();
  const impl = send.getMockImplementation(); let failed = true;
  send.mockImplementation((target: any, method: string, params: any) => failed && method === "Fetch.disable" ? Promise.reject(new Error("failed")) : impl(target, method, params));
  await expect(close()).rejects.toThrow(/cleanup incomplete/);
  expect(mock.debuggerOnEvent).toHaveLength(1);
  event({ requestId: "late-own", networkId: "network", ...final() }); await tick();
  expect(send).toHaveBeenCalledWith({ tabId: 7 }, "Fetch.failRequest", { requestId: "late-own", errorReason: "Aborted" });
  expect(send.mock.calls.some((call: any) => call[1] === "Fetch.continueRequest" && call[2].requestId === "late-own")).toBe(false);
  failed = false; await vi.advanceTimersByTimeAsync(5001); cleaned();
});


it("cleans up when page fetch rejects before creating a network request", async () => {
  responses = [];
  const impl = send.getMockImplementation();
  const context = createContext({ AbortController, setTimeout, clearTimeout, fetch: async () => { throw new Error("CSP blocked"); } });
  send.mockImplementation(async (target: any, method: string, params: any) => method === "Runtime.evaluate"
    ? { result: { value: runInContext(params.expression, context) } } : impl(target, method, params));
  const pending = start(); const check = expect(pending).rejects.toThrow(/timed out/i);
  await vi.advanceTimersByTimeAsync(120001); await check; cleaned();
});

it("recovers when IO.close succeeds after the command timeout", async () => {
  await start();
  const impl = send.getMockImplementation(); let late: (value: unknown) => void = () => {};
  send.mockImplementation((target: any, method: string, params: any) => method === "IO.close"
    ? new Promise(resolve => { late = resolve; }) : impl(target, method, params));
  const closing = close(); const check = expect(closing).rejects.toThrow(/cleanup incomplete/);
  await vi.advanceTimersByTimeAsync(5001); await check;
  late({}); await tick(); await vi.advanceTimersByTimeAsync(5001); cleaned();
});

it("recovers when cancellation of an unidentified request succeeds after timeout", async () => {
  responses = [];
  const impl = send.getMockImplementation(); let late: (value: unknown) => void = () => {};
  send.mockImplementation((target: any, method: string, params: any) => method === "Fetch.failRequest" && params.requestId === "unknown"
    ? new Promise(resolve => { late = resolve; }) : impl(target, method, params));
  const pending = start(); const check = expect(pending).rejects.toThrow(/identified safely/); await tick();
  event({ requestId: "unknown", networkId: "unknown-network", ...final() });
  await vi.advanceTimersByTimeAsync(125001); await check;
  expect(mock.debuggerOnEvent).toHaveLength(1);
  late({}); await tick(); await vi.advanceTimersByTimeAsync(5001); cleaned();
});

it("uses terminal network evidence after navigation invalidates request and context IDs", async () => {
  await start();
  const impl = send.getMockImplementation();
  send.mockImplementation((target: any, method: string, params: any) => ["Fetch.failRequest", "Runtime.evaluate"].includes(method)
    ? Promise.reject(new Error("no such request or context")) : impl(target, method, params));
  await expect(close()).rejects.toThrow(/cleanup incomplete/);
  for (const listener of [...mock.debuggerOnEvent]) listener({ tabId: 7 }, "Network.loadingFailed", { requestId: "network", canceled: true });
  await vi.advanceTimersByTimeAsync(5001); cleaned();
});
it("retries closing a late stream handle until Chrome acknowledges it", async () => {
  const impl = send.getMockImplementation(); let late: (value: unknown) => void = () => {}; let closeFailed = true;
  send.mockImplementation((target: any, method: string, params: any) => {
    if (method === "Fetch.takeResponseBodyAsStream") return new Promise(resolve => { late = resolve; });
    if (method === "IO.close" && closeFailed) return Promise.reject(new Error("temporary failure"));
    return impl(target, method, params);
  });
  const pending = start(); const check = expect(pending).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(15001); await check;
  late({ stream: "late-stream" }); await tick(); closeFailed = false;
  await vi.advanceTimersByTimeAsync(5001);
  expect(send.mock.calls.filter((call: any) => call[1] === "IO.close" && call[2].handle === "late-stream")).toHaveLength(2);
});

it("stops retrying when a late-stream close is acknowledged after timeout", async () => {
  const impl = send.getMockImplementation(); let late: (value: unknown) => void = () => {}; let closed: (value: unknown) => void = () => {};
  send.mockImplementation((target: any, method: string, params: any) => {
    if (method === "Fetch.takeResponseBodyAsStream") return new Promise(resolve => { late = resolve; });
    if (method === "IO.close") return new Promise(resolve => { closed = resolve; });
    return impl(target, method, params);
  });
  const pending = start(); const check = expect(pending).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(15001); await check;
  late({ stream: "late-stream" }); await tick(); await vi.advanceTimersByTimeAsync(5001);
  closed({}); await tick(); await vi.advanceTimersByTimeAsync(5001);
  expect(send.mock.calls.filter((call: any) => call[1] === "IO.close")).toHaveLength(1);
});
