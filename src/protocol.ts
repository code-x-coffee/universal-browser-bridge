import type { Annotation, AnnotationDraft, AnnotationFilter } from "./annotations.js";

export const PROTOCOL_VERSION = 1;

export type SharedTab = {
  id: number;
  title: string;
  url: string;
  active: boolean;
};

export type ExtensionMessage =
  | { type: "hello"; token: string; version: number }
  | { type: "tabs"; tabs: SharedTab[] }
  | { type: "response"; id: string; result?: unknown; error?: string }
  | { type: "event"; tabId: number; method: string; params: unknown }
  | { type: "annotationsSave"; id: string; tabId: number; annotation: AnnotationDraft; screenshot: string }
  | { type: "annotationsList"; id: string; tabId: number; url: string }
  | { type: "ping" };

export type AnnotationExtensionRequest = Extract<ExtensionMessage, { type: "annotationsSave" | "annotationsList" }>;
export type AnnotationExtensionMessage =
  | { type: "annotationsResponse"; id: string; result?: Annotation | Annotation[]; error?: string }
  | { type: "annotationUpdated"; annotation: Annotation };

export type BridgeCommand = {
  type: "command";
  id: string;
  action: "listTabs" | "createTab" | "closeTab" | "requestApproval" | "cdp";
  tabId?: number;
  method?: string;
  params?: Record<string, unknown>;
  url?: string;
  description?: string;
};

export type BridgeStatus = {
  connected: boolean;
  protocolVersion: number;
  tabs: SharedTab[];
};

// --- Daemon control protocol (MCP adapter <-> serve daemon, NDJSON over a
// Unix domain socket / Windows named pipe) ---
//
// Deliberately excludes any standalone "requestApproval"/"clickDetails"
// action: approval policy is a daemon-owned decision made atomically inside
// the "click"/"press" handlers (element inspection, policy check, human
// approval, and execution all happen under one held tab lease), not
// something an MCP adapter can request or bypass on its own.

export type ControlAction =
  | "status"
  | "listTabs"
  | "createTab"
  | "closeTab"
  | "snapshot"
  | "click"
  | "type"
  | "navigate"
  | "press"
  | "scroll"
  | "screenshot"
  | "annotationsList"
  | "annotationsGet"
  | "annotationsResolve";

export type ControlClientMessage =
  | { type: "hello"; token: string; clientId: string; label?: string; version: number }
  | {
      type: "request";
      id: string;
      action: ControlAction;
      tabId?: number;
      url?: string;
      description?: string;
      ref?: string;
      text?: string;
      snapshotId?: string;
      key?: string;
      deltaY?: number;
      annotationId?: string;
      status?: AnnotationFilter["status"];
      note?: string;
    };

export type ControlServerMessage =
  | { type: "ready"; version: number }
  | { type: "response"; id: string; result?: unknown; error?: string };
