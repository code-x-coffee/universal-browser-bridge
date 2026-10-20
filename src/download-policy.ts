import { randomUUID } from "node:crypto";
import { link, mkdir, open, realpath, rm, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep, win32 } from "node:path";
import { normalizeDownloadFolders } from "../extension/download-policy.js";

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
type Destination = { directory: string; filename: string; folder: string };

export function assertDownloadSource(request: { ref?: unknown; snapshotId?: unknown; url?: unknown }): void {
  const byRef = typeof request.ref === "string" && /^ubb-\d+$/.test(request.ref)
    && typeof request.snapshotId === "string" && Boolean(request.snapshotId) && request.url === undefined;
  const byUrl = typeof request.url === "string" && Boolean(request.url.trim()) && request.ref === undefined && request.snapshotId === undefined;
  if (!byRef && !byUrl) throw new Error("Specify either ref + snapshotId or url for a download, not both");
}

export function sanitizeDownloadFilename(value: unknown): string {
  if (typeof value !== "string") throw new Error("Download filename must be a string");
  const name = value.split(/[\\/]/).at(-1)!.replace(/[\p{Cc}:]/gu, "").trim().replace(/^\.+/, "").trim();
  if (!name) throw new Error("Download filename is empty after sanitization");
  const extension = extname(name);
  if (extension.length >= 200) throw new Error("Download filename extension is too long");
  return name.slice(0, name.length - extension.length).slice(0, 200 - extension.length) + extension;
}

export async function prepareDownloadDestination(
  request: { filename?: unknown; folder?: unknown; subfolder?: unknown }, allowedFolders: unknown
): Promise<Destination> {
  const filename = sanitizeDownloadFilename(request.filename);
  const folders = normalizeDownloadFolders(allowedFolders);
  if (!folders.length) throw new Error("File downloads are disabled: no allowed download folders are configured in Extension options");
  let folder = folders[0]!;
  if (request.folder !== undefined) {
    const selected = normalizeDownloadFolders([request.folder]);
    if (selected.length !== 1 || !folders.includes(selected[0]!)) throw new Error("Download folder is not in the allowed download folders");
    folder = selected[0]!;
  }
  const subfolder = request.subfolder ?? "";
  if (typeof subfolder !== "string" || isAbsolute(subfolder) || win32.isAbsolute(subfolder) || subfolder.split(/[\\/]/).includes("..")) {
    throw new Error("Download subfolder must be relative and cannot contain '..' segments");
  }
  const segments = subfolder.split(/[\\/]/).filter(Boolean).map(sanitizeDownloadFilename);
  let root: string;
  try {
    root = await realpath(folder);
    if (!(await stat(root)).isDirectory()) throw new Error("Not a directory");
  } catch (error) { throw new Error(`Cannot access allowed download folder: ${(error as Error).message}`); }
  let directory = root;
  // Resolve each component before creating the next, so a symlink escape
  // cannot cause mkdir to create a child outside the allowed root.
  for (const segment of segments) {
    const candidate = join(directory, segment);
    await mkdir(candidate, { recursive: true });
    directory = await realpath(candidate);
    const remainder = relative(root, directory);
    if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw new Error("Download subfolder resolves outside the allowed folder");
  }
  return { directory, filename, folder };
}

export async function saveDownload(
  destination: Destination, size: number, readChunk: (offset: number, length: number) => Promise<unknown>
): Promise<string> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Invalid download size");
  if (size > MAX_DOWNLOAD_BYTES) throw new Error("Download exceeds the 500 MB limit");
  const { directory, filename } = destination;
  const partial = join(directory, `.${filename}.${randomUUID()}.ubb-partial`);
  const file = await open(partial, "wx", 0o600);
  try {
    for (let offset = 0; offset < size; offset += DOWNLOAD_CHUNK_BYTES) {
      const length = Math.min(DOWNLOAD_CHUNK_BYTES, size - offset);
      const encoded = await readChunk(offset, length);
      if (typeof encoded !== "string" || encoded.length !== Math.ceil(length / 3) * 4) throw new Error("Invalid download chunk length");
      const chunk = Buffer.from(encoded, "base64");
      if (chunk.length !== length || chunk.toString("base64") !== encoded) throw new Error("Invalid download chunk encoding or length");
      await file.writeFile(chunk);
    }
    await file.close();
    const extension = extname(filename);
    const stem = filename.slice(0, filename.length - extension.length);
    for (let index = 0; ; index++) {
      const suffix = index ? ` (${index})` : "";
      const name = stem.slice(0, 200 - extension.length - suffix.length) + suffix + extension;
      const saved = join(directory, name);
      try {
        // link is atomic and refuses existing paths, including symlinks.
        await link(partial, saved);
        return saved;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
  } finally {
    await file.close().catch(() => {});
    await rm(partial, { force: true });
  }
}
