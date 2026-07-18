import { isIP } from "node:net";

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a === 0
  );
}

export function isPrivateNetworkUrl(value: string): boolean {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) return true;
  if (isIP(hostname) === 4) return isPrivateIpv4(hostname);
  if (isIP(hostname) === 6) {
    return hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8") || hostname.startsWith("fe9") || hostname.startsWith("fea") || hostname.startsWith("feb");
  }
  return false;
}

export function assertBrowserUrlAllowed(value: string): boolean {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (process.env.UBB_ALLOW_PRIVATE_NETWORKS === "1" || process.env.UBB_ALLOW_PRIVATE_NETWORKS === "true") return true;
  return !isPrivateNetworkUrl(value);
}
