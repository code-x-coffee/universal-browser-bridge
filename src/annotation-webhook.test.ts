import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AnnotationWebhook } from "./annotation-webhook.js";
import { AnnotationStore } from "./annotations.js";
import { annotationDraft, annotationScreenshot } from "./test-support/annotation-fixture.js";

let directory: string;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
let logger: ReturnType<typeof vi.fn<(message: string) => void>>;
let env: NodeJS.ProcessEnv;
let webhook: AnnotationWebhook;
const url = "https://hooks.example.com/receive?token=query-secret";
async function configure(overrides: Record<string, unknown> = {}) {
  await fs.writeFile(join(directory, "webhook.json"), JSON.stringify({ url, headers: { Authorization: "Bearer header-secret", "X-Sender-Key": "sender-secret" }, ...overrides }), { mode: 0o600 });
}
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "ubb-webhook-"));
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 204 }));
  sleep = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined);
  logger = vi.fn();
  env = {};
  webhook = new AnnotationWebhook({ dataRoot: directory, env, fetch: fetcher, sleep, logger });
});
afterEach(async () => { vi.useRealTimers(); await fs.rm(directory, { recursive: true, force: true }); });

it("posts only the specified annotation metadata and custom/default headers", async () => {
  await configure();
  const item = await new AnnotationStore(join(directory, "annotations")).create(annotationDraft, annotationScreenshot);
  expect(await webhook.created({ ...item, screenshot: annotationScreenshot } as typeof item)).toEqual({ ok: true, status: 204, attempts: 1 });
  const [target, options] = fetcher.mock.calls[0]!;
  expect(target).toBe(url);
  expect(options).toMatchObject({ method: "POST", redirect: "manual", signal: expect.any(AbortSignal) });
  const headers = options!.headers as Headers;
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("user-agent")).toBe("universal-browser-bridge");
  expect(headers.get("authorization")).toBe("Bearer header-secret");
  expect(headers.get("x-sender-key")).toBe("sender-secret");
  const { id, comment, url: pageUrl, title, textSnippet, selector, createdAt, screenshotPath } = item;
  expect(JSON.parse(options!.body as string)).toEqual({ event: "annotation.created", annotation: { id, comment, url: pageUrl, title, textSnippet, selector, createdAt, screenshotPath } });
  expect(options!.body).not.toContain(annotationScreenshot);
});

it("honors case-insensitive User-Agent overrides and always sends JSON content type", async () => {
  await configure({ headers: { "user-agent": "my-agent", "content-type": "text/plain" } });
  await webhook.test();
  const headers = fetcher.mock.calls[0]![1]!.headers as Headers;
  expect(headers.get("user-agent")).toBe("my-agent");
  expect(headers.get("content-type")).toBe("application/json");
});

it("uses env overrides to enable a disabled file while retaining its headers", async () => {
  await configure({ enabled: false });
  env.UBB_ANNOTATION_WEBHOOK_URL = "http://env.example.com/hook";
  expect(await webhook.status()).toEqual({ configured: true, enabled: true, source: "env", host: "env.example.com", headerNames: ["Authorization", "X-Sender-Key"] });
  await webhook.test();
  expect(fetcher.mock.calls[0]![0]).toBe(env.UBB_ANNOTATION_WEBHOOK_URL);
  expect((fetcher.mock.calls[0]![1]!.headers as Headers).get("authorization")).toBe("Bearer header-secret");
});

it("enables env-only configuration and uses the shared sender for annotation.test", async () => {
  env.UBB_ANNOTATION_WEBHOOK_URL = url;
  expect(await webhook.status()).toMatchObject({ configured: true, source: "env", headerNames: [] });
  expect((await webhook.test()).ok).toBe(true);
  const payload = JSON.parse(fetcher.mock.calls[0]![1]!.body as string);
  expect(payload).toEqual({ event: "annotation.test", sentAt: expect.any(String) });
  expect(new Date(payload.sentAt).toISOString()).toBe(payload.sentAt);
});

it("stays silently off without configuration or when explicitly disabled", async () => {
  expect(await webhook.status()).toEqual({ configured: false, enabled: false, source: "none", host: null, headerNames: [] });
  expect(await webhook.test()).toMatchObject({ ok: false, attempts: 0 });
  await configure({ enabled: false });
  expect(await webhook.status()).toMatchObject({ configured: true, enabled: false, source: "file" });
  expect(await webhook.test()).toMatchObject({ ok: false, attempts: 0, error: "Webhook is disabled" });
  expect(fetcher).not.toHaveBeenCalled();
  expect(logger).not.toHaveBeenCalled();
});

it.each([
  "not-json header-secret", JSON.stringify({ url: "file:///private?token=query-secret" }),
  JSON.stringify({ url, headers: { Authorization: 123 } }),
  JSON.stringify({ url, enabled: "yes" }),
  JSON.stringify({ url, headers: { "Bad Header": "secret" } }),
  JSON.stringify({ url, headers: { Authorization: "secret\nvalue" } }),
  JSON.stringify({ url, headers: { Authorization: "secret\u2603" } })
])("disables an invalid file, warning once without leaking configuration: %s", async (raw) => {
  await fs.writeFile(join(directory, "webhook.json"), raw);
  env.UBB_ANNOTATION_WEBHOOK_URL = url;
  expect(await webhook.status()).toMatchObject({ configured: false, enabled: false, host: null, headerNames: [] });
  await webhook.test(); await webhook.test();
  expect(fetcher).not.toHaveBeenCalled();
  expect(logger.mock.calls).toEqual([["Annotation webhook: invalid configuration; delivery disabled"]]);
});

it("rejects non-HTTP or empty environment URLs without leaking them", async () => {
  env.UBB_ANNOTATION_WEBHOOK_URL = "file:///private?secret";
  expect((await webhook.test()).ok).toBe(false);
  env.UBB_ANNOTATION_WEBHOOK_URL = "";
  expect((await webhook.test()).ok).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect(logger).toHaveBeenCalledTimes(1);
});

it("re-reads file edits and deletion without restart", async () => {
  await configure(); await webhook.test();
  await configure({ url: "https://changed.example.com/", headers: { "X-New": "new-secret" } });
  await webhook.test();
  expect(fetcher.mock.calls[1]![0]).toBe("https://changed.example.com/");
  expect(await webhook.status()).toMatchObject({ host: "changed.example.com", headerNames: ["X-New"] });
  await fs.rm(join(directory, "webhook.json"));
  await webhook.test();
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([500, 503, 429])("retries HTTP %i with exponential backoff and then succeeds", async (status) => {
  await configure();
  fetcher.mockResolvedValueOnce(new Response(null, { status })).mockResolvedValueOnce(new Response(null, { status }));
  expect(await webhook.test()).toEqual({ ok: true, status: 204, attempts: 3 });
  expect(sleep.mock.calls).toEqual([[1_000], [2_000]]);
});

it("retries network failures then gives up after four attempts, keeping errors private", async () => {
  await configure();
  fetcher.mockRejectedValue(new Error(`Failed ${url} Authorization: Bearer header-secret sender-secret`));
  expect(await webhook.test()).toEqual({ ok: false, error: "network error", attempts: 4 });
  expect(sleep.mock.calls).toEqual([[1_000], [2_000], [4_000]]);
  expect(logger.mock.calls).toEqual(Array.from({ length: 4 }, () => ["Annotation webhook hooks.example.com: network error"]));
});

it("gives up after four 5xx responses and prints only host/status", async () => {
  await configure();
  fetcher.mockImplementation(async () => new Response("header-secret", { status: 500 }));
  expect(await webhook.test()).toEqual({ ok: false, status: 500, attempts: 4 });
  expect(logger.mock.calls).toEqual(Array.from({ length: 4 }, () => ["Annotation webhook hooks.example.com: HTTP 500"]));
});

it.each([400, 401, 403, 404, 422, 302])("does not retry HTTP %i", async (status) => {
  await configure();
  fetcher.mockResolvedValue(new Response(null, { status }));
  expect(await webhook.test()).toEqual({ ok: false, status, attempts: 1 });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(sleep).not.toHaveBeenCalled();
});

it("aborts hanging fetches at the deadline, retries, and finishes even if abort is ignored", async () => {
  await configure();
  vi.useFakeTimers();
  const signals: AbortSignal[] = [];
  fetcher.mockImplementation((_url, options) => {
    signals.push(options!.signal as AbortSignal);
    return new Promise(() => {});
  });
  const result = webhook.test();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  await vi.advanceTimersByTimeAsync(40_000);
  expect(await result).toEqual({ ok: false, attempts: 4, error: "timeout" });
  expect(signals).toHaveLength(4);
  expect(signals.every((signal) => signal.aborted)).toBe(true);
  expect(sleep.mock.calls).toEqual([[1_000], [2_000], [4_000]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("status JSON exposes only host and header names, never values, credentials or queries", async () => {
  await configure({ url: "https://user:password@hooks.example.com/path?token=query-secret" });
  const status = JSON.stringify(await webhook.status());
  expect(JSON.parse(status)).toEqual({ configured: true, enabled: true, source: "file", host: "hooks.example.com", headerNames: ["Authorization", "X-Sender-Key"] });
  for (const secret of ["header-secret", "sender-secret", "query-secret", "password", "/path", "Bearer"]) expect(status).not.toContain(secret);
});

it("uses injectable timing and tolerates a throwing logger", async () => {
  await configure();
  webhook = new AnnotationWebhook({ dataRoot: directory, env, fetch: fetcher, sleep, logger: () => { throw new Error("logger failed"); }, backoffMs: [7] });
  fetcher.mockRejectedValue(new Error("offline"));
  expect(await webhook.test()).toEqual({ ok: false, error: "network error", attempts: 2 });
  expect(sleep.mock.calls).toEqual([[7]]);
});

it("retries after an abort-aware timeout and clears the successful attempt's timer", async () => {
  await configure();
  vi.useFakeTimers();
  webhook = new AnnotationWebhook({ dataRoot: directory, env, fetch: fetcher, sleep, logger, timeoutMs: 25 });
  let signal: AbortSignal;
  fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
    signal = options!.signal as AbortSignal;
    signal.addEventListener("abort", () => reject(new Error("aborted query-secret header-secret")), { once: true });
  }));
  const result = webhook.test();
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1), { interval: 1 });
  await vi.advanceTimersByTimeAsync(25);
  expect(await result).toEqual({ ok: true, status: 204, attempts: 2 });
  expect(signal!.aborted).toBe(true);
  expect(logger.mock.calls).toEqual([["Annotation webhook hooks.example.com: timeout"]]);
  expect(vi.getTimerCount()).toBe(0);
});

it("resumes after fixing invalid configuration and warns again for a later invalid edit", async () => {
  await fs.writeFile(join(directory, "webhook.json"), "broken");
  await webhook.test(); await webhook.status();
  expect(logger).toHaveBeenCalledTimes(1);
  await configure();
  expect((await webhook.test()).ok).toBe(true);
  await fs.writeFile(join(directory, "webhook.json"), "broken again");
  await webhook.test();
  expect(logger).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
