import { createContext, runInContext } from "node:vm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { downloadSourceScript, downloadFetchScript, downloadChunkScript, downloadCleanupScript } from "./download-scripts.js";
import { snapshotScript } from "./dom-actions.js";

let page: any;
let element: any;
let blob: Blob;
let fetchPage: ReturnType<typeof vi.fn>;
let context: ReturnType<typeof createContext>;
const run = (script: string) => runInContext(script, context);
beforeEach(() => {
  vi.useFakeTimers();
  page = {};
  element = { tagName: "VIDEO", currentSrc: "blob:https://app.example/media", src: "https://app.example/fallback" };
  blob = new Blob([new Uint8Array([0, 1, 2, 255])], { type: "video/mp4" });
  fetchPage = vi.fn(async (url: string) => ({ ok: true, status: 200, url, headers: { get: () => null }, blob: async () => blob }));
  context = createContext({ window: page, location: { href: "https://app.example/project" },
    document: { querySelector: () => element }, URL, Blob, AbortController, Uint8Array, btoa, fetch: fetchPage, setTimeout, clearTimeout });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(["VIDEO", "AUDIO", "SOURCE", "IMG", "A"])("resolves a %s ref using currentSrc, src or href", (tagName) => {
  element = { tagName, href: "https://app.example/anchor" };
  expect(run(downloadSourceScript({ ref: "ubb-3" }))).toBe("https://app.example/anchor");
  element.src = "/media";
  expect(run(downloadSourceScript({ ref: "ubb-3" }))).toBe("https://app.example/media");
  element.currentSrc = "blob:https://app.example/current";
  expect(run(downloadSourceScript({ ref: "ubb-3" }))).toBe("blob:https://app.example/current");
});
it("rejects expired refs and elements without a downloadable media source", () => {
  element = null;
  expect(() => run(downloadSourceScript({ ref: "ubb-3" }))).toThrow(/expired/i);
  element = { tagName: "BUTTON", href: "https://app.example/" };
  expect(() => run(downloadSourceScript({ ref: "ubb-3" }))).toThrow(/media|source/i);
});
it.each(["https://app.example/media", "blob:https://app.example/media", "data:text/plain,hello"])(
  "fetches allowed URL %s into page-held storage and transfers exact chunks", async (url) => {
    expect(await run(downloadFetchScript("key", url))).toEqual({ size: 4, mimeType: "video/mp4" });
    expect(fetchPage).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: "error", credentials: "same-origin" }));
    expect(await run(downloadChunkScript("key", 1, 3))).toBe("AQL/");
    run(downloadCleanupScript("key"));
    expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
  }
);
it.each(["https://other.example/media", "blob:https://other.example/media", "file:///etc/passwd", "javascript:alert(1)"])(
  "refuses disallowed URL %s before fetching", async (url) => {
    await expect(run(downloadFetchScript("key", url))).rejects.toThrow(/same-origin/i);
    expect(fetchPage).not.toHaveBeenCalled();
  }
);
it("checks content-length before reading the body and actual blob size before transfer", async () => {
  const readBlob = vi.fn(async () => blob);
  fetchPage.mockResolvedValue({ ok: true, headers: { get: () => "524288001" }, blob: readBlob });
  await expect(run(downloadFetchScript("key", "https://app.example/media"))).rejects.toThrow(/500 MB/);
  expect(readBlob).not.toHaveBeenCalled();
  fetchPage.mockResolvedValue({ ok: true, headers: { get: () => null }, blob: async () => ({ size: 524288001, type: "video/mp4" }) });
  await expect(run(downloadFetchScript("key", "https://app.example/media"))).rejects.toThrow(/500 MB/);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
});
it("refuses redirects and HTTP failures and clears page state", async () => {
  fetchPage.mockResolvedValue({ ok: false, status: 404 });
  await expect(run(downloadFetchScript("key", "https://app.example/media"))).rejects.toThrow(/404/);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
});
it("releases an abandoned page blob with a safety timer", async () => {
  await run(downloadFetchScript("key", "https://app.example/media"));
  await vi.advanceTimersByTimeAsync(120000);
  expect(Object.keys(page.__ubbDl ?? {})).toEqual([]);
});
it("makes visible video, image and audio refs available while keeping the 250 cap", () => {
  const nodes = Array.from({ length: 251 }, (_, index) => ({
    tagName: ["VIDEO", "IMG", "AUDIO"][index % 3]!, innerText: "", disabled: false,
    getAttribute: () => null, setAttribute: vi.fn(), getBoundingClientRect: () => ({ x: 0, y: 0, width: 20, height: 20 })
  }));
  const snapshot = runInContext(snapshotScript, createContext({
    document: { title: "Media", querySelectorAll: (selector: string) => selector === "[data-ubb-ref]" ? []
      : nodes.filter((node) => selector.split(",").includes(node.tagName.toLowerCase())) },
    getComputedStyle: () => ({ display: "block", visibility: "visible" }), location: { href: "https://app.example/" }
  }));
  expect(snapshot.nodes).toHaveLength(250);
  expect(snapshot.nodes.slice(0, 3).map((node: any) => node.tag)).toEqual(["video", "img", "audio"]);
});
