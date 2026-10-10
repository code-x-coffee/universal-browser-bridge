import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AnnotationStore } from "./annotations.js";
import { runMcpServer } from "./mcp.js";
import type { DaemonClient, DaemonRequest } from "./daemon-client.js";
import { annotationDraft, annotationScreenshot } from "./test-support/annotation-fixture.js";

let directory: string;
let client: Client;
let store: AnnotationStore;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "ubb-mcp-annotations-"));
  store = new AnnotationStore(join(directory, "annotations"));
  const daemon = {
    async request(request: DaemonRequest) {
      if (request.action === "annotationsList") return store.list({ url: request.url, status: request.status });
      if (request.action === "annotationsGet") {
        if (request.annotationId && request.url !== undefined) throw new Error("Specify ID or URL, not both");
        if (request.annotationId) return store.get(request.annotationId);
        if (request.url !== undefined) return store.list({ url: request.url });
        throw new Error("ID or URL is required");
      }
      if (request.action === "annotationsResolve") return store.resolve(request.annotationId!, request.note);
      if (request.action === "annotationsReply") return store.reply(request.annotationId!, { text: request.text!, author: request.author });
      throw new Error("Unexpected browser request");
    }
  } as DaemonClient;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await runMcpServer(daemon, serverTransport);
  client = new Client({ name: "annotation-mcp-test", version: "0.0.1" });
  await client.connect(clientTransport);
});
afterEach(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
function data(result: any) { return JSON.parse(result.content.find((part: any) => part.type === "text").text); }

it("advertises and executes all annotation tools with stable JSON results", async () => {
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["annotations_list", "annotations_get", "annotations_resolve", "annotations_reply"]));
  const item = await store.create(annotationDraft, annotationScreenshot);
  expect(data(await client.callTool({ name: "annotations_list", arguments: { url: item.url, status: "open" } }))).toEqual([item]);
  expect(data(await client.callTool({ name: "annotations_get", arguments: { id: item.id } }))).toEqual(item);
  expect(data(await client.callTool({ name: "annotations_get", arguments: { url: item.url } }))).toEqual([item]);
  const resolved = data(await client.callTool({ name: "annotations_resolve", arguments: { id: item.id, note: "Done via MCP" } }));
  expect(resolved).toMatchObject({ status: "resolved", resolutionNote: "Done via MCP", screenshotPath: item.screenshotPath });
  expect(data(await client.callTool({ name: "annotations_list", arguments: { status: "resolved" } }))).toEqual([resolved]);
});

it("replies with default or explicit authors through MCP, including on resolved annotations", async () => {
  const item = await store.create(annotationDraft, annotationScreenshot);
  const open = data(await client.callTool({ name: "annotations_reply", arguments: { id: item.id, text: "  Working on it  " } }));
  expect(open).toMatchObject({ status: "open", replies: [{ author: "agent", text: "Working on it" }] });
  await store.resolve(item.id, "Done");
  const resolved = data(await client.callTool({ name: "annotations_reply", arguments: { id: item.id, text: "Verified", author: "Hephaestus" } }));
  expect(resolved).toMatchObject({ status: "resolved", replies: [{ author: "agent" }, { author: "Hephaestus", text: "Verified" }] });
  expect(data(await client.callTool({ name: "annotations_get", arguments: { id: item.id } }))).toEqual(resolved);
  for (const args of [{ id: item.id, text: " " }, { id: item.id, text: "Hi", author: " " }, { id: "../../token", text: "Hi" }, { id: item.id }]) {
    expect((await client.callTool({ name: "annotations_reply", arguments: args })).isError).toBe(true);
  }
});

it("reports invalid filters, ambiguous get requests and invalid IDs as tool errors", async () => {
  expect((await client.callTool({ name: "annotations_list", arguments: { status: "invalid" } })).isError).toBe(true);
  expect((await client.callTool({ name: "annotations_get", arguments: {} })).isError).toBe(true);
  const item = await store.create(annotationDraft, annotationScreenshot);
  expect((await client.callTool({ name: "annotations_get", arguments: { id: item.id, url: item.url } })).isError).toBe(true);
  expect((await client.callTool({ name: "annotations_resolve", arguments: { id: "../../token" } })).isError).toBe(true);
});
