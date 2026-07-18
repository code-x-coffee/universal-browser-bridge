import { homedir } from "node:os";
import { join } from "node:path";

// Node's `net` module accepts a Windows named-pipe path anywhere it accepts a
// Unix socket path, so this is a real (not stubbed) cross-platform endpoint.
export function daemonSocketPath(): string {
  if (process.env.UBB_SOCKET_PATH) return process.env.UBB_SOCKET_PATH;
  if (process.platform === "win32") return String.raw`\\.\pipe\universal-browser-bridge`;
  return join(homedir(), ".universal-browser-bridge", "daemon.sock");
}
