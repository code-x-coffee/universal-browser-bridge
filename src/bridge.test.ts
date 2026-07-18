import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
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

  it("emits a tabs event whenever the extension reports an updated tab list", async () => {
    bridge = new BrowserBridge("test-token", "127.0.0.1", 0);
    await bridge.start();

    const seen: unknown[] = [];
    bridge.on("tabs", (tabs) => seen.push(tabs));

    const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}/extension`, { headers: { origin: "chrome-extension://fake" } });
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "hello", token: "test-token", version: 1 }));
    const tab = { id: 1, title: "T", url: "https://example.com", active: true };
    await new Promise((resolve) => setTimeout(resolve, 30));
    ws.send(JSON.stringify({ type: "tabs", tabs: [tab] }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(seen).toContainEqual([tab]);

    ws.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toContainEqual([]);
  });
});
