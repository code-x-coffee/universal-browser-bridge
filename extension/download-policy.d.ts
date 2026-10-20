export const DEFAULT_DOWNLOAD_FOLDERS: readonly string[];
export function normalizeDownloadFolders(values: unknown): string[];
export function validateTrustedDownloadHost(value: unknown): { host: string } | { error: string };
export function normalizeTrustedDownloadHosts(values: unknown): string[];
export function isTrustedDownloadHost(hostname: string, trustedHosts: readonly string[]): boolean;
export function assertDownloadUrl(value: unknown, pageUrl: string, trustedHosts?: readonly string[], options?: { redirect?: boolean; blockedDomains?: readonly string[] }): string;

export const MAX_DOWNLOAD_BYTES: number;
export const DOWNLOAD_CHUNK_BYTES: number;
