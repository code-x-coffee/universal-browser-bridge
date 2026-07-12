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
  | { type: "event"; tabId: number; method: string; params: unknown };

export type BridgeCommand = {
  type: "command";
  id: string;
  action: "listTabs" | "createTab" | "cdp";
  tabId?: number;
  method?: string;
  params?: Record<string, unknown>;
  url?: string;
};

export type BridgeStatus = {
  connected: boolean;
  protocolVersion: number;
  tabs: SharedTab[];
};
