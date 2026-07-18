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
  | { type: "ping" };

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

export type ControlAction =
  | "status"
  | "listTabs"
  | "createTab"
  | "closeTab"
  | "requestApproval"
  | "snapshot"
  | "clickDetails"
  | "click"
  | "type"
  | "navigate"
  | "press"
  | "scroll"
  | "screenshot";

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
    };

export type ControlServerMessage =
  | { type: "ready"; version: number }
  | { type: "response"; id: string; result?: unknown; error?: string };
