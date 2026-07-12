#!/usr/bin/env node
import { BrowserBridge } from "./bridge.js";
import { getOrCreateToken, tokenPath } from "./auth.js";
import { runMcpServer } from "./mcp.js";

const command = process.argv[2] ?? "help";
const token = await getOrCreateToken();

if (command === "token") {
  process.stdout.write(`${token}\n`);
  process.exit(0);
}

if (command === "serve" || command === "mcp") {
  const bridge = new BrowserBridge(token);
  await bridge.start();
  if (command === "serve") {
    process.stderr.write(`Universal Browser Bridge listening on 127.0.0.1:17321\nToken: ${tokenPath()}\n`);
  } else {
    await runMcpServer(bridge);
  }
} else {
  process.stdout.write(`Universal Browser Bridge\n\nCommands:\n  serve  Start the local extension relay\n  mcp    Start the relay and MCP stdio server\n  token  Print the extension pairing token\n`);
}
