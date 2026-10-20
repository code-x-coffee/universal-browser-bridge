import { mkdtemp, mkdir, realpath, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MAX_UPLOAD_FILES, MAX_UPLOAD_FILE_BYTES, normalizeUploadFolders, validateUploadFiles } from "./upload-policy.js";

let directory: string;
let allowed: string;
let file: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-uploads-"));
  allowed = join(directory, "Stories");
  await mkdir(allowed);
  file = join(allowed, "reference.png");
  await writeFile(file, "image");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

it("returns real paths for regular files within an allowed folder", async () => {
  expect(await validateUploadFiles([file], [allowed])).toEqual([await realpath(file)]);
});

it.each([
  ["relative.png", /absolute/i],
  ["/tmp/../reference.png", /\.\./],
  ["/tmp/a\0.png", /NUL/i],
  [42, /string/i]
])("rejects invalid file paths %j", async (value, reason) => {
  await expect(validateUploadFiles([value], [allowed])).rejects.toThrow(reason as RegExp);
});

it("names nonexistent paths and directories in errors", async () => {
  await expect(validateUploadFiles([join(allowed, "missing")], [allowed])).rejects.toThrow(/missing.*exist|missing.*ENOENT/);
  await expect(validateUploadFiles([allowed], [allowed])).rejects.toThrow(/Stories.*regular file/);
});

it("rejects symlinks inside the folder pointing outside", async () => {
  const outside = join(directory, "secret");
  await writeFile(outside, "secret");
  const link = join(allowed, "escape");
  await symlink(outside, link);
  await expect(validateUploadFiles([link], [allowed])).rejects.toThrow(/escape.*outside.*allowed/i);
});

it("allows symlinks outside pointing inside and returns the resolved file", async () => {
  const link = join(directory, "link");
  await symlink(file, link);
  expect(await validateUploadFiles([link], [allowed])).toEqual([await realpath(file)]);
});

it("resolves allowed folder symlinks and skips unusable folders", async () => {
  const link = join(directory, "allowed-link");
  await symlink(allowed, link);
  expect(await validateUploadFiles([file], [join(directory, "missing"), link])).toEqual([await realpath(file)]);
});

it("rejects sibling-prefix paths", async () => {
  const sibling = join(directory, "Stories-evil");
  await mkdir(sibling);
  const outside = join(sibling, "file");
  await writeFile(outside, "secret");
  await expect(validateUploadFiles([outside], [allowed])).rejects.toThrow(/Stories-evil.*outside.*allowed/i);
});

it("enforces 1..10 files even for direct control callers", async () => {
  expect(MAX_UPLOAD_FILES).toBe(10);
  for (const files of [[], Array(11).fill(file), undefined, "file"]) {
    await expect(validateUploadFiles(files, [allowed])).rejects.toThrow(/1.*10/);
  }
  expect(await validateUploadFiles(Array(10).fill(file), [allowed])).toHaveLength(10);
});

it("accepts the size limit and rejects larger sparse files", async () => {
  expect(MAX_UPLOAD_FILE_BYTES).toBe(100 * 1024 * 1024);
  await truncate(file, MAX_UPLOAD_FILE_BYTES);
  expect(await validateUploadFiles([file], [allowed])).toEqual([await realpath(file)]);
  await truncate(file, MAX_UPLOAD_FILE_BYTES + 1);
  await expect(validateUploadFiles([file], [allowed])).rejects.toThrow(/reference.png.*100 MB/);
});

it.each([[], ["relative", "/a/../b", "/a\0b"], ["/missing-upload-folder"], null, 42])(
  "disables uploads when folders are empty or unusable: %j", async (folders) => {
    await expect(validateUploadFiles([file], folders)).rejects.toThrow("File uploads are disabled: no allowed upload folders are configured in Extension options");
  }
);

it("normalizes folders, ignores invalid entries and deduplicates equivalent paths", () => {
  expect(normalizeUploadFolders([" /x/Stories/ ", "", "relative", "/a/../b", "/a\0b", 12, "/x//Stories", "/x/./Stories", "/"]))
    .toEqual(["/x/Stories/", "/"]);
  expect(normalizeUploadFolders(undefined)).toEqual([]);
});
