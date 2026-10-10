import { expect, it } from "vitest";
import { parseAnnotationArgs } from "./annotation-cli.js";
const id = "00000000-0000-4000-8000-000000000001";

it("parses the stable annotation CLI request forms", () => {
  expect(parseAnnotationArgs(["list"])).toEqual({ action: "annotationsList", status: "all" });
  expect(parseAnnotationArgs(["list", "--url", "https://example.com/", "--status", "open", "--json"])).toEqual({ action: "annotationsList", url: "https://example.com/", status: "open" });
  expect(parseAnnotationArgs(["get", id])).toEqual({ action: "annotationsGet", annotationId: id });
  expect(parseAnnotationArgs(["get", "--url", "https://example.com/"])).toEqual({ action: "annotationsGet", url: "https://example.com/" });
  expect(parseAnnotationArgs(["resolve", id, "--note", "Fixed the heading"])).toEqual({ action: "annotationsResolve", annotationId: id, note: "Fixed the heading" });
  expect(parseAnnotationArgs(["reply", id, "--text", "  Done  "])).toEqual({ action: "annotationsReply", annotationId: id, text: "Done", author: "agent" });
  expect(parseAnnotationArgs(["reply", id, "--text", "Done", "--author", "Hephaestus"])).toEqual({ action: "annotationsReply", annotationId: id, text: "Done", author: "Hephaestus" });
  expect(parseAnnotationArgs(["webhook", "status"])).toEqual({ action: "annotationsWebhookStatus" });
  expect(parseAnnotationArgs(["webhook", "test"])).toEqual({ action: "annotationsWebhookTest" });
});

it.each([
  [], ["delete", id], ["get"], ["resolve"], ["get", id, "--url", "https://example.com/"],
  ["list", "--status", "unknown"], ["list", "--url"], ["list", "--url", "--json"],
  ["list", "--json", "--json"], ["list", id], ["resolve", id, "--url", "https://example.com/"],
  ["get", "../../token"], ["resolve", id, id],
  ["reply", id], ["reply", id, "--text", " "], ["reply", id, "--text", "Done", "--author", " "],
  ["reply", id, "--text", "Done", "--text", "Again"], ["reply", id, "--note", "Done"],
  ["webhook"], ["webhook", "set"], ["webhook", "status", "--json"]
])("rejects malformed annotation arguments %j", (...args) => {
  expect(() => parseAnnotationArgs(args)).toThrow();
});

it("rejects oversized reply text and author arguments", () => {
  expect(() => parseAnnotationArgs(["reply", id, "--text", "x".repeat(10_001)])).toThrow();
  expect(() => parseAnnotationArgs(["reply", id, "--text", "Done", "--author", "x".repeat(101)])).toThrow();
});
