import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnotationStore, annotationDirectory } from "./annotations.js";

import { annotationDraft as draft, annotationScreenshot as screenshot } from "./test-support/annotation-fixture.js";

let directory: string;
let store: AnnotationStore;
beforeEach(async () => {
  directory = await fs.mkdtemp(join(tmpdir(), "ubb-annotations-"));
  store = new AnnotationStore(join(directory, "annotations"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("AnnotationStore", () => {
  it("creates, filters, gets and resolves annotations with persisted screenshots", async () => {
    const first = await store.create(draft, screenshot);
    const other = await store.create({ ...draft, url: "https://example.com/other", selector: null }, screenshot);
    expect(first.comment).toBe("Fix the heading");
    expect(first.textSnippet).toHaveLength(200);
    expect(isAbsolute(first.screenshotPath)).toBe(true);
    expect(await fs.readFile(first.screenshotPath)).toEqual(Buffer.from(screenshot.split(",")[1]!, "base64"));
    expect(await store.get(first.id)).toEqual(first);
    expect(await store.list({ url: draft.url })).toEqual([first]);
    const resolved = await store.resolve(first.id, "Fixed spacing");
    expect(resolved).toMatchObject({ status: "resolved", resolutionNote: "Fixed spacing" });
    expect(resolved.resolvedAt).toMatch(/^\d{4}-/);
    expect(await store.list({ status: "open" })).toEqual([other]);
    expect(await store.list({ status: "resolved" })).toEqual([resolved]);
    expect(await store.list({ url: draft.url, status: "open" })).toEqual([]);
    expect(await store.list({ status: "all" })).toHaveLength(2);
    expect(await store.resolve(first.id)).toEqual(resolved);
    expect(await new AnnotationStore(store.directory).list()).toEqual([resolved, other]);
  });

  it("writes via rename, uses private permissions and leaves no temporary files", async () => {
    const rename = vi.spyOn(fs, "rename");
    const item = await store.create(draft, screenshot);
    expect(rename).toHaveBeenCalledTimes(2);
    expect(rename.mock.calls.every(([from, to]) => String(from).endsWith(".tmp") && !String(to).endsWith(".tmp"))).toBe(true);
    expect((await fs.readdir(store.directory)).sort()).toEqual([`${item.id}.png`, "annotations.json"].sort());
    if (process.platform !== "win32") {
      expect((await fs.stat(store.directory)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(item.screenshotPath)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(join(store.directory, "annotations.json"))).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the previous JSON and in-memory state when a commit fails", async () => {
    const first = await store.create(draft, screenshot);
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("annotations.json")) throw new Error("disk failure");
      return rename(from, to);
    });
    await expect(store.create(draft, screenshot)).rejects.toThrow("disk failure");
    await expect(store.resolve(first.id)).rejects.toThrow("disk failure");
    await expect(store.reply(first.id, { text: "Not committed" })).rejects.toThrow("disk failure");
    expect(await store.list()).toEqual([first]);
    expect(await new AnnotationStore(store.directory).list()).toEqual([first]);
    expect(await fs.readdir(store.directory)).toHaveLength(2);
  });

  it("serializes concurrent saves and resolutions and returns independent records", async () => {
    const records = await Promise.all(Array.from({ length: 8 }, () => store.create(draft, screenshot)));
    await Promise.all(records.map((record) => store.resolve(record.id)));
    expect(await store.list({ status: "resolved" })).toHaveLength(8);
    const copy = await store.get(records[0]!.id);
    copy.rect.x = 999;
    expect((await store.get(copy.id)).rect.x).toBe(10);
  });

  it("rejects invalid metadata, screenshots, statuses and missing IDs", async () => {
    await expect(store.create({ ...draft, comment: " " }, screenshot)).rejects.toThrow();
    await expect(store.create({ ...draft, url: "file:///private" }, screenshot)).rejects.toThrow();
    await expect(store.create(draft, "data:image/png;base64,ZmFrZQ==")).rejects.toThrow("PNG");
    await expect(store.list({ status: "bad" as "open" })).rejects.toThrow();
    await expect(store.get("../../token")).rejects.toThrow();
    await expect(store.resolve("00000000-0000-4000-8000-000000000000")).rejects.toThrow("not found");
  });

  it("does not silently replace a corrupt store", async () => {
    await fs.mkdir(store.directory);
    await fs.writeFile(join(store.directory, "annotations.json"), "broken");
    await expect(store.list()).rejects.toThrow();
  });

  it("honors UBB_DATA_DIR", () => {
    vi.stubEnv("UBB_DATA_DIR", directory);
    expect(annotationDirectory()).toBe(join(directory, "annotations"));
  });

  it("appends trimmed replies with unique IDs, defaults authors and persists them on resolved records", async () => {
    const item = await store.create(draft, screenshot);
    expect(item.replies).toEqual([]);
    const first = await store.reply(item.id, { text: "  First reply  " });
    expect(first.replies[0]).toEqual({ id: expect.any(String), text: "First reply", author: "agent", createdAt: expect.any(String) });
    expect(first.replies[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(first.replies[0]!.createdAt).toISOString()).toBe(first.replies[0]!.createdAt);
    const resolved = await store.resolve(item.id, "Done");
    const updated = await store.reply(item.id, { text: "Confirmed", author: "  Hephaestus  " });
    expect(updated).toMatchObject({ status: "resolved", resolvedAt: resolved.resolvedAt, resolutionNote: "Done" });
    expect(updated.replies).toHaveLength(2);
    expect(updated.replies[1]).toMatchObject({ text: "Confirmed", author: "Hephaestus" });
    expect(updated.replies[0]!.id).not.toBe(updated.replies[1]!.id);
    expect(await new AnnotationStore(store.directory).get(item.id)).toEqual(updated);
    updated.replies[0]!.text = "Changed copy";
    expect((await store.get(item.id)).replies[0]!.text).toBe("First reply");
  });

  it("loads legacy records without replies and persists their first reply", async () => {
    const item = await store.create(draft, screenshot);
    const { replies: _replies, ...legacy } = item;
    await fs.writeFile(join(store.directory, "annotations.json"), JSON.stringify([legacy]));
    const legacyStore = new AnnotationStore(store.directory);
    expect((await legacyStore.get(item.id)).replies).toEqual([]);
    const updated = await legacyStore.reply(item.id, { text: "Reply on legacy record" });
    expect(await new AnnotationStore(store.directory).list()).toEqual([updated]);
  });

  it("serializes concurrent replies and resolution without losing updates", async () => {
    const item = await store.create(draft, screenshot);
    await Promise.all([...Array.from({ length: 8 }, (_, index) => store.reply(item.id, { text: `Reply ${index}` })), store.resolve(item.id)]);
    expect(await store.get(item.id)).toMatchObject({ status: "resolved", replies: Array.from({ length: 8 }, (_, index) => expect.objectContaining({ text: `Reply ${index}` })) });
  });

  it("validates reply text/author lengths and IDs at the store boundary", async () => {
    const item = await store.create(draft, screenshot);
    for (const input of [{ text: " " }, { text: "x".repeat(10_001) }, { text: "valid", author: " " }, { text: "valid", author: "x".repeat(101) }]) {
      await expect(store.reply(item.id, input)).rejects.toThrow();
    }
    await expect(store.reply("../../token", { text: "valid" })).rejects.toThrow();
    await expect(store.reply("00000000-0000-4000-8000-000000000000", { text: "valid" })).rejects.toThrow("not found");
    const boundary = await store.reply(item.id, { text: "x".repeat(10_000), author: "x".repeat(100) });
    expect(boundary.replies[0]!.text).toHaveLength(10_000);
  });
});
