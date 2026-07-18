import { afterEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import { daemonSocketPath } from "./daemon-socket.js";

const originalPlatform = process.platform;

function setPlatform(value: string) {
  Object.defineProperty(process, "platform", { value });
}

afterEach(() => {
  delete process.env.UBB_SOCKET_PATH;
  setPlatform(originalPlatform);
});

describe("daemonSocketPath", () => {
  it("honors an explicit UBB_SOCKET_PATH override", () => {
    process.env.UBB_SOCKET_PATH = "/tmp/custom.sock";
    expect(daemonSocketPath()).toBe("/tmp/custom.sock");
  });

  it("defaults to a Unix socket under the home directory on macOS/Linux", () => {
    setPlatform("darwin");
    expect(daemonSocketPath()).toBe(join(homedir(), ".universal-browser-bridge", "daemon.sock"));
  });

  it("defaults to a named pipe path on Windows", () => {
    setPlatform("win32");
    expect(daemonSocketPath()).toBe(String.raw`\\.\pipe\universal-browser-bridge`);
  });
});
