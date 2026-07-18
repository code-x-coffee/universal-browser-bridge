import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export function tokenPath(): string {
  // A fixed default keeps pairing stable: MCP hosts launch this server from
  // arbitrary working directories.
  if (process.env.UBB_TOKEN_FILE) return resolve(process.env.UBB_TOKEN_FILE);
  return join(homedir(), ".universal-browser-bridge", "token");
}

export async function getOrCreateToken(): Promise<string> {
  if (process.env.UBB_TOKEN) return process.env.UBB_TOKEN;
  const path = tokenPath();
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    const token = randomBytes(32).toString("base64url");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

export function tokensMatch(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
