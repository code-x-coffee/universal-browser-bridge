export { normalizeUploadFolders as normalizeDownloadFolders } from './upload-policy.js';

export const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
export const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

export const DEFAULT_DOWNLOAD_FOLDERS = ['/Volumes/NVme/Projects/Stories/'];

// ASCII DNS hosts with an optional single leading "*." label. No IP or URL syntax.
export function validateTrustedDownloadHost(value) {
  if (typeof value !== 'string') return { error: 'hostname must be text' };
  const entry = value.trim().toLowerCase();
  const wildcard = entry.startsWith('*.');
  const base = (wildcard ? entry.slice(2) : entry).replace(/\.$/, '');
  if (base.includes('*')) return { error: 'wildcard must be a single leading "*." label' };
  if (!base) return { error: wildcard ? 'wildcard needs at least two labels after "*."' : 'hostname is required' };
  const host = (wildcard ? '*.' : '') + base;
  if (host.length > 253) return { error: 'hostname must be at most 253 characters' };
  if (/^[\d.]+$/.test(base) || /^\[.*\]$/.test(base)) return { error: 'IP literals are not allowed' };
  const invalidDns = { error: 'use a bare ASCII DNS hostname with labels of 1-63 letters, digits or hyphens' };
  if (!base.split('.').every(part => part.length <= 63 && /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/.test(part))) return invalidDns;
  // WHATWG canonicalizes alternate IPv4 spellings (hex, octal, integer).
  // Check the wildcard base too, before the single-label rule, to identify IPs.
  try { if (new URL('https://' + base).hostname !== base) return { error: 'IP literals are not allowed' }; }
  catch { return invalidDns; }
  if (wildcard && !base.includes('.')) return { error: 'wildcard needs at least two labels after "*."' };
  return { host };
}

export function normalizeTrustedDownloadHosts(values) {
  if (!Array.isArray(values)) return [];
  const hosts = new Set();
  for (const value of values) {
    const result = validateTrustedDownloadHost(value);
    if (result.host) hosts.add(result.host);
  }
  return [...hosts];
}

export function isTrustedDownloadHost(hostname, trustedHosts) {
  const target = validateTrustedDownloadHost(hostname);
  if (!target.host || target.host.startsWith('*.')) return false;
  return normalizeTrustedDownloadHosts(trustedHosts).some(host => host.startsWith('*.')
    ? target.host.endsWith(host.slice(1)) // Leading dot excludes the apex and lookalikes.
    : target.host === host);
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
    if (source.protocol === 'https:' && isTrustedDownloadHost(source.hostname, trustedHosts)) return source.href;
    throw new Error('Download host ' + hostname + ' is not a trusted download host' + guidance);
  }
  if (!redirect && (source.protocol === 'data:' || (source.protocol === 'blob:' && source.origin === page.origin))) return source.href;
  throw new Error('Downloads require a same-origin http(s) URL, a trusted HTTPS host, a blob URL of the tab origin, or a data URL');
}
