export { normalizeUploadFolders as normalizeDownloadFolders } from './upload-policy.js';

export const DEFAULT_DOWNLOAD_FOLDERS = ['/Volumes/NVme/Projects/Stories/'];

export function assertDownloadUrl(value, pageUrl) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Download source URL is required');
  const page = new URL(pageUrl);
  const source = new URL(value, page);
  if (source.protocol === 'data:' || (['http:', 'https:', 'blob:'].includes(source.protocol) && source.origin === page.origin)) return source.href;
  throw new Error('Downloads require a same-origin http(s) URL, a blob URL of the tab origin, or a data URL');
}
