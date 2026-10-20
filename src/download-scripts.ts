import { assertDownloadUrl, isTrustedDownloadHost, normalizeTrustedDownloadHosts, validateTrustedDownloadHost } from "../extension/download-policy.js";
import { MAX_DOWNLOAD_BYTES } from "./download-policy.js";

export function downloadSourceScript(source: { ref?: string; url?: string }): string {
  return `(() => {
    const source = ${JSON.stringify(source)};
    let url = source.url;
    if (source.ref !== undefined) {
      const el = document.querySelector('[data-ubb-ref="' + source.ref + '"]');
      if (!el) throw new Error('Element ref expired; take a new snapshot');
      if (!['VIDEO', 'AUDIO', 'SOURCE', 'IMG', 'A'].includes(el.tagName)) throw new Error('Element is not a downloadable media source or link');
      url = el.currentSrc || el.src || (['VIDEO', 'AUDIO'].includes(el.tagName) ? el.querySelector('source')?.src : undefined) || el.href;
    }
    if (!url) throw new Error('Element has no downloadable source URL');
    return new URL(url, location.href).href;
  })()`;
}

export function downloadFetchScript(key: string, url: string): string {
  return `(async () => {
    const validateTrustedDownloadHost = ${validateTrustedDownloadHost.toString()};
    const normalizeTrustedDownloadHosts = ${normalizeTrustedDownloadHosts.toString()};
    const isTrustedDownloadHost = ${isTrustedDownloadHost.toString()};
    const assertDownloadUrl = ${assertDownloadUrl.toString()};
    const url = assertDownloadUrl(${JSON.stringify(url)}, location.href);
    const key = ${JSON.stringify(key)};
    const store = window.__ubbDl ??= Object.create(null);
    const entry = { controller: new AbortController(), blob: null };
    entry.expire = () => { entry.controller.abort(); delete store[key]; };
    entry.timer = setTimeout(entry.expire, 120000);
    store[key] = entry;
    try {
      const manualRedirect = /^https?:/.test(url);
      const response = await fetch(url, { credentials: 'same-origin', redirect: manualRedirect ? 'manual' : 'error', signal: entry.controller.signal });
      if (manualRedirect && response.type === 'opaqueredirect') {
        clearTimeout(entry.timer);
        entry.expire();
        return { redirected: true };
      }
      if (!response.ok) throw new Error('Download fetch failed (HTTP ' + response.status + ')');
      if (response.url) assertDownloadUrl(response.url, location.href);
      const length = Number(response.headers.get('content-length'));
      if (length > ${MAX_DOWNLOAD_BYTES}) throw new Error('Download exceeds the 500 MB limit');
      const blob = await response.blob();
      if (blob.size > ${MAX_DOWNLOAD_BYTES}) throw new Error('Download exceeds the 500 MB limit');
      entry.blob = blob;
      clearTimeout(entry.timer);
      entry.timer = setTimeout(entry.expire, 120000);
      return { size: blob.size, mimeType: blob.type || 'application/octet-stream' };
    } catch (error) {
      clearTimeout(entry.timer);
      entry.expire();
      throw error;
    }
  })()`;
}

export function downloadChunkScript(key: string, offset: number, length: number): string {
  return `(async () => {
    const entry = window.__ubbDl?.[${JSON.stringify(key)}];
    if (!entry?.blob) throw new Error('Download blob expired; start the download again');
    clearTimeout(entry.timer);
    entry.timer = setTimeout(entry.expire, 120000);
    const blob = entry.blob;
    const bytes = new Uint8Array(await blob.slice(${offset}, ${offset + length}).arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(binary);
  })()`;
}

export function downloadCleanupScript(key: string): string {
  return `(() => {
    const store = window.__ubbDl;
    const key = ${JSON.stringify(key)};
    const entry = store?.[key];
    if (entry) { clearTimeout(entry.timer); entry.expire(); }
    if (store && !Object.keys(store).length) delete window.__ubbDl;
  })()`;
}
