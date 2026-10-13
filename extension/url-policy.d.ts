export function isReadOnlyBrowserUrl(value: string): boolean;
export function normalizeBlockedDomains(values: readonly string[]): string[];
export function isBlockedBrowserUrl(value: string | undefined, blockedDomains: readonly string[]): boolean;
export function assertTabNotBlocked(tab: { url?: string; pendingUrl?: string }, blockedDomains: readonly string[]): void;
