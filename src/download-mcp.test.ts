import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMcpServer } from "./mcp.js";
import type { DaemonClient } from "./daemon-client.js";

let client: Client;
const request = vi.fn(async (_request: unknown) => ({ saved: "/allowed/clip.mp4", bytes: 3, mimeType: "video/mp4" }));
const status = vi.fn(async () => ({ tabs: [{ id: 7, active: true }] }));
const args = { filename: "clip.mp4", description: "Save the clip", url: "blob:https://app.example/media" };
beforeEach(async () => {
  request.mockClear(); status.mockClear();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runMcpServer({ request, status } as unknown as DaemonClient, serverTransport);
  client = new Client({ name: "download-test", version: "1" }); await client.connect(clientTransport);
});
afterEach(async () => { await client.close(); });

it("advertises filename and description without a tool to change download folders", async () => {
  const tools = (await client.listTools()).tools;
  expect(tools.filter((tool) => /download|folder|policy/i.test(tool.name)).map((tool) => tool.name)).toEqual(["browser_download"]);
  const tool = tools.find((tool) => tool.name === "browser_download")!;
  expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["filename", "description"]));
  expect(tool.inputSchema.required).not.toContain("tabId");
});
it("forwards URL and ref downloads using selected or explicit tabs", async () => {
  const result = await client.callTool({ name: "browser_download", arguments: args });
  expect(result.isError).not.toBe(true);
  expect(request).toHaveBeenLastCalledWith({ action: "download", tabId: 7, ...args });
  const refArgs = { filename: "image.png", description: "Save image", ref: "ubb-3", snapshotId: "9:0", tabId: 9, folder: "/allowed/", subfolder: "media" };
  await client.callTool({ name: "browser_download", arguments: refArgs });
  expect(request).toHaveBeenLastCalledWith({ action: "download", ...refArgs });
});
it.each([
  { filename: "" }, { description: "" }, { url: "" }, { ref: "ubb-3", snapshotId: "7:0" },
  { url: undefined }, { url: undefined, ref: "ubb-3" }, { snapshotId: "7:0" }, { url: undefined, ref: "invalid", snapshotId: "7:0" }
])("rejects invalid download arguments %j before dispatch", async (invalid) => {
  expect((await client.callTool({ name: "browser_download", arguments: { ...args, ...invalid } })).isError).toBe(true);
  expect(request).not.toHaveBeenCalled();
});
