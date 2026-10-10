import { annotationIdSchema, annotationStatusSchema } from "./annotations.js";
import type { DaemonRequest } from "./daemon-client.js";

export function parseAnnotationArgs(args: string[]): DaemonRequest {
  const [command, ...rest] = args;
  if (command !== "list" && command !== "get" && command !== "resolve") {
    throw new Error("Usage: annotations list [--url URL] [--status open|resolved|all] [--json] | get <id> | get --url URL | resolve <id> [--note TEXT]");
  }
  const options = new Map<string, string>();
  const ids: string[] = [];
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index]!;
    if (!arg.startsWith("--")) { ids.push(arg); continue; }
    const allowed = command === "list" ? ["--url", "--status", "--json"] : command === "get" ? ["--url"] : ["--note"];
    if (!allowed.includes(arg) || options.has(arg)) throw new Error(`Invalid or duplicate option: ${arg}`);
    if (arg === "--json") { options.set(arg, "true"); continue; }
    const value = rest[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    options.set(arg, value);
  }
  if (command === "list") {
    if (ids.length) throw new Error("annotations list does not accept an ID");
    return { action: "annotationsList", url: options.get("--url"), status: annotationStatusSchema.parse(options.get("--status") ?? "all") };
  }
  if (command === "get" && options.has("--url")) {
    if (ids.length) throw new Error("Specify an annotation ID or --url, not both");
    return { action: "annotationsGet", url: options.get("--url") };
  }
  if (ids.length !== 1) throw new Error(`annotations ${command} requires one annotation ID`);
  const annotationId = annotationIdSchema.parse(ids[0]);
  return command === "get" ? { action: "annotationsGet", annotationId } : { action: "annotationsResolve", annotationId, note: options.get("--note") };
}
