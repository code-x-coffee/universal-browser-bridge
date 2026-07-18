import { afterEach, describe, expect, it } from "vitest";
import { BrowserBridge } from "./bridge.js";

let bridge: BrowserBridge | undefined;

afterEach(async () => {
  await bridge?.stop();
  bridge = undefined;
});

describe("BrowserBridge", () => {
  it("binds an OS-assigned ephemeral port when constructed with port 0", async () => {
    bridge = new BrowserBridge("test-token", "127.0.0.1", 0);
    await bridge.start();
    expect(bridge.port).toBeGreaterThan(0);
  });
});
