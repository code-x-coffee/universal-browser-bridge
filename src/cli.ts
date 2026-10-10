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

const command = process.argv[2] ?? "help";
const token = await getOrCreateToken();

if (command === "token") {
  process.stdout.write(`${token}\n`);
  process.exit(0);
} else if (command === "serve") {
  const port = process.env.UBB_PORT ? Number(process.env.UBB_PORT) : 17321;
  const bridge = new BrowserBridge(token, "127.0.0.1", port);
  await bridge.start();
  const socketPath = daemonSocketPath();
  const daemon = new DaemonServer(bridge, token, socketPath);
  await daemon.start();
  process.stderr.write(
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
    process.stderr.write(`\nReceived ${signal}; shutting down the daemon...\n`);
    await daemon.stop();
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
} else if (command === "annotations") {
  let client: DaemonClient | undefined;
  try {
    const request = parseAnnotationArgs(process.argv.slice(3));
    client = new DaemonClient({ socketPath: daemonSocketPath(), token, clientId: randomUUID(), label: process.env.UBB_CLIENT_LABEL });
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
    label: process.env.UBB_CLIENT_LABEL
  });
  try {
    await client.connect();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    process.exit(1);
  }
  await runMcpServer(client);
} else {
  process.stdout.write(
    `Universal Browser Bridge\n\n` +
      `Commands:\n` +
      `  serve  Start the daemon: owns the Chrome extension connection and the control socket\n` +
      `  mcp    Connect to a running daemon and start the MCP stdio server for one adapter\n` +
      `  token  Print the extension pairing token\n\n` +
      `  annotations list [--url URL] [--status open|resolved|all] [--json]\n` +
      `  annotations get <id> | annotations get --url URL\n` +
      `  annotations resolve <id> [--note TEXT]\n` +
      `  annotations reply <id> --text TEXT [--author NAME]\n` +
      `  annotations webhook status|test\n\n` +
      `Env vars:\n` +
      `  UBB_CLIENT_LABEL       Human-readable identity for this adapter (shown in approval prompts)\n` +
      `  UBB_SOCKET_PATH        Override the daemon control socket path\n` +
      `  UBB_DATA_DIR           Annotation data root (default ~/.universal-browser-bridge)\n` +
      `  UBB_ANNOTATION_WEBHOOK_URL  Override and enable the annotation webhook (serve only)\n` +
      `  UBB_TOKEN_FILE         Override the pairing token file path\n` +
      `  UBB_PORT                Override the extension WebSocket port (serve only, default 17321)\n` +
      `  UBB_ALLOW_PRIVATE_NETWORKS  Allow navigation to localhost/private-network URLs\n`
  );
}
