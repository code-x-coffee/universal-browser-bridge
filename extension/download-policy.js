export { normalizeUploadFolders as normalizeDownloadFolders } from './upload-policy.js';

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

export const DEFAULT_DOWNLOAD_FOLDERS = ['/Volumes/NVme/Projects/Stories/'];

// Exact ASCII DNS hostnames only. No IP literals, wildcard expansion or URL syntax.
export function normalizeTrustedDownloadHosts(values) {
  if (!Array.isArray(values)) return [];
  const hosts = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const host = value.trim().toLowerCase().replace(/\.$/, '');
    if (!host || host.length > 253 || /^[\d.]+$/.test(host)
      || !host.split('.').every(part => part.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(part))) continue;
    // WHATWG canonicalizes alternate IPv4 spellings (hex, octal, integer).
    try { if (new URL('https://' + host).hostname !== host) continue; } catch { continue; }
    hosts.add(host);
  }
  return [...hosts];
}

export function assertDownloadUrl(value, pageUrl, trustedHosts = [], { redirect = false, blockedDomains = [] } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Download source URL is required');
  let page, source;
  try { page = new URL(pageUrl); source = new URL(value, page); }
  catch { throw new Error('Invalid download source URL'); } // Never echo signed URLs.
  const hostname = source.hostname.toLowerCase().replace(/\.$/, '');
  if (blockedDomains.some(domain => hostname === domain || hostname.endsWith('.' + domain))) {
    throw new Error('Download host ' + hostname + ' is blocked by your blocklist');
  }
  const guidance = '; add it under "Trusted download hosts" in Extension options';
  if (source.protocol === 'http:' && (redirect || source.origin !== page.origin)) {
    throw new Error('Download host ' + hostname + ' uses plain http' + guidance);
  }
  if (['http:', 'https:'].includes(source.protocol)) {
    if (source.origin === page.origin) return source.href;
    if (source.protocol === 'https:' && trustedHosts.some(host => typeof host === 'string'
      && host.trim().toLowerCase().replace(/\.$/, '') === hostname)) return source.href;
    throw new Error('Download host ' + hostname + ' is not a trusted download host' + guidance);
  }
  if (!redirect && (source.protocol === 'data:' || (source.protocol === 'blob:' && source.origin === page.origin))) return source.href;
  throw new Error('Downloads require a same-origin http(s) URL, a trusted HTTPS host, a blob URL of the tab origin, or a data URL');
}
