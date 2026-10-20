import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runMcpServer } from "./mcp.js";
import type { DaemonClient } from "./daemon-client.js";

let client: Client;
const request = vi.fn(async (_request: unknown) => ({ uploaded: 1, files: ["/allowed/ref.png"] }));
const status = vi.fn(async () => ({ tabs: [{ id: 7, active: true }, { id: 8, active: false }] }));
beforeEach(async () => {
  request.mockClear(); status.mockClear();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runMcpServer({ request, status } as unknown as DaemonClient, serverTransport);
  client = new Client({ name: "upload-test", version: "1" });
  await client.connect(clientTransport);
});
afterEach(async () => { await client.close(); });
const args = { ref: "ubb-3", description: "Attach reference", snapshotId: "7:0", files: ["/allowed/ref.png"] };

it("advertises the upload schema without a tool for changing allowed folders", async () => {
  const tools = (await client.listTools()).tools;
  expect(tools.filter((tool) => /upload|folder|policy/i.test(tool.name)).map((tool) => tool.name)).toEqual(["browser_upload_file"]);
  const tool = tools.find((tool) => tool.name === "browser_upload_file")!;
  expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["ref", "description", "snapshotId", "files"]));
  expect(tool.inputSchema.required).not.toContain("tabId");
  expect(tool.inputSchema.properties).toMatchObject({
    ref: { type: "string", pattern: "^ubb-\\d+$" }, description: { minLength: 1 }, snapshotId: { minLength: 1 },
    files: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } }, tabId: { type: "integer" },
    mode: { enum: ["auto", "input", "chooser"] }
  });
});

it.each(["auto", "input", "chooser"])("forwards upload mode %s", async (mode) => {
  expect((await client.callTool({ name: "browser_upload_file", arguments: { ...args, mode } })).isError).not.toBe(true);
  expect(request).toHaveBeenLastCalledWith({ action: "uploadFile", tabId: 7, ...args, mode });
});

it("sends the upload action using the selected or explicitly requested tab", async () => {
  expect((await client.callTool({ name: "browser_upload_file", arguments: args })).isError).not.toBe(true);
  expect(request).toHaveBeenLastCalledWith({ action: "uploadFile", tabId: 7, ...args });
  await client.callTool({ name: "browser_upload_file", arguments: { ...args, tabId: 99 } });
  expect(request).toHaveBeenLastCalledWith({ action: "uploadFile", tabId: 99, ...args });
  expect(status).toHaveBeenCalledTimes(1);
});

it.each([{ ref: "bad" }, { description: "" }, { snapshotId: "" }, { files: [] }, { files: Array(11).fill("/x") }, { files: [42] }, { mode: "unknown" }])(
  "rejects invalid upload arguments %j without dispatch", async (invalid) => {
    expect((await client.callTool({ name: "browser_upload_file", arguments: { ...args, ...invalid } })).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  }
);
