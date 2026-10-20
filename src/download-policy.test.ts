import { mkdtemp, mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { prepareDownloadDestination, saveDownload, sanitizeDownloadFilename, MAX_DOWNLOAD_BYTES } from "./download-policy.js";

let directory: string;
let allowed: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-download-policy-"));
  allowed = join(directory, "allowed");
  await mkdir(allowed);
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it.each([
  ["../../.clip:bad\0\n.mp4 ", "clipbad.mp4"],
  ["C:\\private\\...image.png", "image.png"],
  ["  audio.wav  ", "audio.wav"],
  ["x".repeat(300) + ".mp4", "x".repeat(196) + ".mp4"]
])("sanitizes filenames without losing the extension: %j", (input, expected) => {
  expect(sanitizeDownloadFilename(input)).toBe(expected);
});
it.each(["", "...", ":\0\n", "/tmp/", 42])("rejects an empty or invalid filename: %j", (input) => {
  expect(() => sanitizeDownloadFilename(input)).toThrow(/filename/i);
});

it("selects the first folder by default and resolves a sanitized nested subfolder", async () => {
  const result = await prepareDownloadDestination({ filename: ".movie.mp4", subfolder: " .project:/daily " }, [allowed]);
  expect(result).toMatchObject({ directory: join(await realpath(allowed), "project", "daily"), filename: "movie.mp4" });
});
it("allows selection only from configured folders and resolves allowed folder symlinks", async () => {
  const second = join(directory, "second"); await mkdir(second);
  const alias = join(directory, "alias"); await symlink(second, alias);
  expect(await prepareDownloadDestination({ filename: "a.png", folder: alias }, [allowed, alias]))
    .toMatchObject({ directory: await realpath(second) });
  await expect(prepareDownloadDestination({ filename: "a.png", folder: second }, [allowed])).rejects.toThrow(/allowed/i);
});
it.each([[], undefined, ["relative"], ["/missing-download-folder"]])("fails closed with disabled or unusable folders: %j", async (folders) => {
  await expect(prepareDownloadDestination({ filename: "x" }, folders)).rejects.toThrow(/downloads are disabled|cannot access.*folder/i);
});
it.each(["../escape", "nested/../escape", "/absolute", "C:\\absolute", "\\absolute", "a\\..\\b"])(
  "rejects escaping subfolders: %j", async (subfolder) => {
    await expect(prepareDownloadDestination({ filename: "x", subfolder }, [allowed])).rejects.toThrow(/subfolder/i);
  }
);
it("rejects symlink escapes before creating directories outside the allowed folder", async () => {
  const outside = join(directory, "outside"); await mkdir(outside);
  await symlink(outside, join(allowed, "escape"));
  await expect(prepareDownloadDestination({ filename: "x", subfolder: "escape/new" }, [allowed])).rejects.toThrow(/outside.*allowed/i);
  expect(await readdir(outside)).toEqual([]);
});

it("writes exact bytes over multiple chunks and publishes without overwriting files or symlinks", async () => {
  const destination = await prepareDownloadDestination({ filename: "clip.bin" }, [allowed]);
  const data = Buffer.alloc(1024 * 1024 + 7, 0xab);
  data[0] = 0; data[data.length - 1] = 0xff;
  await writeFile(join(allowed, "clip.bin"), "existing");
  const outside = join(directory, "outside.bin"); await writeFile(outside, "secret");
  await symlink(outside, join(allowed, "clip (1).bin"));
  const reads: number[] = [];
  const saved = await saveDownload(destination, data.length, async (offset, length) => {
    reads.push(length); return data.subarray(offset, offset + length).toString("base64");
  });
  expect(reads).toEqual([1048576, 7]);
  expect(saved).toBe(join(await realpath(allowed), "clip (2).bin"));
  expect(await readFile(saved)).toEqual(data);
  expect(await readFile(join(allowed, "clip.bin"), "utf8")).toBe("existing");
  expect(await readFile(outside, "utf8")).toBe("secret");
  expect((await readdir(allowed)).some((name) => name.endsWith(".ubb-partial"))).toBe(false);
});
it("removes partial files after a mid-stream failure", async () => {
  const destination = await prepareDownloadDestination({ filename: "clip.bin" }, [allowed]);
  await expect(saveDownload(destination, 1048577, async (offset) => {
    if (offset) throw new Error("Page disconnected");
    return Buffer.alloc(1048576).toString("base64");
  })).rejects.toThrow("Page disconnected");
  expect(await readdir(allowed)).toEqual([]);
});
it.each([-1, 524288001, NaN, 1.5])("rejects invalid or oversized metadata before writing: %j", async (size) => {
  const destination = await prepareDownloadDestination({ filename: "x" }, [allowed]);
  await expect(saveDownload(destination, size, async () => "")).rejects.toThrow(/size|500 MB/i);
  expect(await readdir(allowed)).toEqual([]);
});
it("checks chunk lengths and supports empty files", async () => {
  const destination = await prepareDownloadDestination({ filename: "x" }, [allowed]);
  await expect(saveDownload(destination, 2, async () => "AQ==")).rejects.toThrow(/chunk/i);
  expect(await readdir(allowed)).toEqual([]);
  const saved = await saveDownload(destination, 0, async () => { throw new Error("No chunks expected"); });
  expect((await readFile(saved)).length).toBe(0);
  expect(MAX_DOWNLOAD_BYTES).toBe(524288000);
});
