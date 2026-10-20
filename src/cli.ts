#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { BrowserBridge } from "./bridge.js";
import { getOrCreateToken, tokenPath } from "./auth.js";
import { daemonSocketPath } from "./daemon-socket.js";
import { DaemonServer } from "./daemon.js";
import { DaemonClient } from "./daemon-client.js";
import { runMcpServer } from "./mcp.js";
import { parseAnnotationArgs } from "./annotation-cli.js";
import type { WebhookResult } from "./annotation-webhook.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { log } from "./log.js";

const args = process.argv.slice(2);
let label = process.env.UBB_CLIENT_LABEL;
if (args[0] === "--label") {
  args.shift();
  label = args.shift();
  if (!label?.trim() || label.startsWith("--")) throw new Error("--label requires a non-empty agent name");
}
const command = args.shift() ?? "help";
let token: string;
try { token = command === "help" ? "" : await getOrCreateToken(); }
catch (error) {
  if (command !== "serve") throw error;
  log((error as Error).stack ?? String(error));
  process.exit(1);
}

if (command === "token") {
  process.stdout.write(`${token}\n`);
  process.exit(0);
} else if (command === "serve") {
  const port = process.env.UBB_PORT ? Number(process.env.UBB_PORT) : 17321;
  const bridge = new BrowserBridge(token, "127.0.0.1", port);
  const socketPath = daemonSocketPath();
  const daemon = new DaemonServer(bridge, token, socketPath);
  try {
    await bridge.start();
    await daemon.start();
  } catch (error) {
    log((error as Error).stack ?? String(error));
    await bridge.stop();
    process.exit(1);
  }
  log(
    `Universal Browser Bridge daemon listening.\n` +
      `  Extension endpoint: 127.0.0.1:${bridge.port}\n` +
      `  Control socket:     ${socketPath}\n` +
      `  Token:               ${tokenPath()}\n` +
      `Connect MCP adapters with \`universal-browser-bridge mcp\` (each adapter is a lightweight client of this daemon).\n`
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}; shutting down the daemon...`);
    let code = 0;
    await daemon.stop().catch((error) => { log((error as Error).stack ?? String(error)); code = 1; });
    await bridge.stop().catch((error) => { log((error as Error).stack ?? String(error)); code = 1; });
    process.exit(code);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} else if (command === "annotations") {
  let client: DaemonClient | undefined;
  try {
    const request = parseAnnotationArgs(args);
    client = new DaemonClient({ socketPath: daemonSocketPath(), token, clientId: randomUUID(), label });
    await client.connect();
    const result = await client.request(request);
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (request.action === "annotationsWebhookTest" && !(result as WebhookResult).ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await client?.close();
  }
} else if (command === "mcp") {
  const client = new DaemonClient({
    socketPath: daemonSocketPath(),
    token,
    clientId: randomUUID(),
    label
  });
  try {
    await client.connect();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
  await runMcpServer(client);
} else if (/^(browser_|annotations_)/.test(command)) {
  const client = new DaemonClient({ socketPath: daemonSocketPath(), token, clientId: randomUUID(), label });
  const toolClient = new Client({ name: "ubb-cli", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    if (args.length > 1) throw new Error("Expected one JSON object after the tool name");
    const parameters = JSON.parse(args[0] ?? "{}");
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) throw new Error("Tool arguments must be a JSON object");
    await client.connect();
    // Reuse MCP tool schemas and handlers, including all validation, rather
    // than maintaining a second CLI-to-control-action mapping.
    await runMcpServer(client, serverTransport);
    await toolClient.connect(clientTransport);
    const result = await toolClient.callTool({ name: command, arguments: parameters });
    const content = result.content as Array<{ type: string; text?: string }>;
    if (result.isError) throw new Error(content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
    process.stdout.write((content.length === 1 && content[0]?.type === "text" ? content[0].text : JSON.stringify(result, null, 2)) + "\n");
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await toolClient.close();
    await serverTransport.close();
    await client.close();
  }
} else {
  process.stdout.write(
    `Universal Browser Bridge\n\n` +
      `Commands:\n` +
      `  serve  Start the daemon: owns the Chrome extension connection and the control socket\n` +
      `  mcp    Connect to a running daemon and start the MCP stdio server for one adapter\n` +
      `  token  Print the extension pairing token\n\n` +
      `  [--label NAME] <browser_tool|annotations_tool> '<json>'\n` +
      `  Example: ubb --label Hephaestus browser_list_agent_tabs '{}'\n\n` +
      `  annotations list [--url URL] [--status open|resolved|all] [--json]\n` +
      `  annotations get <id> | annotations get --url URL\n` +
      `  annotations resolve <id> [--note TEXT]\n` +
      `  annotations reply <id> --text TEXT [--author NAME]\n` +
      `  annotations webhook status|test\n\n` +
      `Env vars:\n` +
      `  UBB_CLIENT_LABEL       Agent identity, ownership group and approval label (--label overrides it)\n` +
      `  UBB_SOCKET_PATH        Override the daemon control socket path\n` +
      `  UBB_DATA_DIR           Annotation data root (default ~/.universal-browser-bridge)\n` +
      `  UBB_ANNOTATION_WEBHOOK_URL  Override and enable the annotation webhook (serve only)\n` +
      `  UBB_TOKEN_FILE         Override the pairing token file path\n` +
      `  UBB_PORT                Override the extension WebSocket port (serve only, default 17321)\n` +
      `  UBB_ALLOW_PRIVATE_NETWORKS  Allow navigation to localhost/private-network URLs\n`
  );
}
