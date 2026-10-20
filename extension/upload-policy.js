export const DEFAULT_UPLOAD_FOLDERS = ["/Volumes/NVme/Projects/Stories/"];

// This setting is edited only by the user in extension options. Missing or
// malformed policy received by the daemon must never restore the default.
export function normalizeUploadFolders(values) {
  if (!Array.isArray(values)) return [];
  const folders = new Set();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const folder = value.trim();
    if (!folder.startsWith("/") || folder.includes("\0") || folder.split("/").includes("..")) continue;
    const parts = folder.split("/").filter((part) => part && part !== ".");
    folders.add(parts.length ? `/${parts.join("/")}/` : "/");
  }
  return [...folders];
}
