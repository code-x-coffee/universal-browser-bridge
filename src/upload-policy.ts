import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { normalizeUploadFolders } from "../extension/upload-policy.js";

export { normalizeUploadFolders } from "../extension/upload-policy.js";
export const MAX_UPLOAD_FILES = 10;
export const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

export async function validateUploadFiles(files: unknown, allowedFolders: unknown): Promise<string[]> {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES) {
    throw new Error(`File uploads require 1..${MAX_UPLOAD_FILES} files`);
  }
  const folders: string[] = [];
  for (const folder of normalizeUploadFolders(allowedFolders)) {
    try {
      const resolved = await realpath(folder);
      if ((await stat(resolved)).isDirectory()) folders.push(resolved);
    } catch {
      // Removed or inaccessible folders do not grant access.
    }
  }
  if (!folders.length) {
    throw new Error("File uploads are disabled: no allowed upload folders are configured in Extension options");
  }
  const resolvedFiles: string[] = [];
  for (const file of files) {
    if (typeof file !== "string") throw new Error(`Invalid upload path ${String(file)}: must be a string`);
    if (!isAbsolute(file)) throw new Error(`Invalid upload path ${file}: must be absolute`);
    if (file.includes("\0")) throw new Error(`Invalid upload path ${JSON.stringify(file)}: NUL is not allowed`);
    if (file.split(/[\\/]/).includes("..")) throw new Error(`Invalid upload path ${file}: '..' segments are not allowed`);
    let resolved: string;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      resolved = await realpath(file);
      info = await stat(resolved);
    } catch (error) {
      throw new Error(`Cannot access upload file ${file}: ${(error as Error).message}`);
    }
    if (!info.isFile()) throw new Error(`Invalid upload path ${file}: must be a regular file`);
    if (info.size > MAX_UPLOAD_FILE_BYTES) throw new Error(`Upload file ${file} exceeds the 100 MB limit`);
    const inside = folders.some((folder) => {
      const remainder = relative(folder, resolved);
      return remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
    });
    if (!inside) throw new Error(`Upload file ${file} resolves outside the allowed upload folders`);
    resolvedFiles.push(resolved);
  }
  return resolvedFiles;
}
