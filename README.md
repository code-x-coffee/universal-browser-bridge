# Universal Agent Browser Bridge

A local, agent-agnostic bridge that lets MCP-compatible agents operate only the Chrome tabs you explicitly share.

This is an independent implementation inspired by the visible tab-consent model used by OpenClaw. It is not affiliated with OpenClaw, Anthropic, Google, or OpenAI.

## Current MVP

- Unpacked Chrome MV3 extension using `chrome.debugger`
- Explicit per-tab sharing through a visible **Agent Bridge** tab group
- Authenticated WebSocket connection bound to `127.0.0.1`
- MCP tools for tabs, navigation, snapshots, clicking, typing, keys, scrolling, and screenshots
- Temporary DOM refs rather than arbitrary selectors supplied by the model
- Basic confirmation gate for purchases, sends, deletes, submissions, and similar actions
- One active MCP host at a time

## Install

```bash
npm install
npm run build
npm run token
```

Copy the printed token (stored at `~/.universal-browser-bridge/token` by default; override with `UBB_TOKEN_FILE`). Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project's `extension/` directory.
5. Open the extension options and paste the pairing token.

The toolbar badge clears when the MCP relay is running and paired.

## Standalone binary (no Node required)

With [Bun](https://bun.sh) installed, compile the CLI and its dependencies into one self-contained executable:

```bash
npm run binary   # produces bin/universal-browser-bridge (~60 MB)
```

The binary embeds the runtime, so end users need neither Node nor `npm install`. Cross-compile for other platforms with `bun build --compile --target=bun-linux-x64` (or `bun-windows-x64`, `bun-darwin-x64`, `bun-darwin-arm64`).

## Connect an MCP client

Configure the client to run:

```bash
node /absolute/path/to/universal-browser-bridge/dist/cli.js mcp
# or, using the standalone binary:
/absolute/path/to/universal-browser-bridge/bin/universal-browser-bridge mcp
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "node",
      "args": [
        "/absolute/path/to/universal-browser-bridge/dist/cli.js",
        "mcp"
      ]
    }
  }
}
```

Use the equivalent MCP configuration surface in Codex, Claude Code, Hermes, or another compatible harness. Pi can use an MCP adapter or a future native extension.

## Share a tab

1. Open a normal web page.
2. Click the extension toolbar icon.
3. Confirm the tab shows an **ON** badge and is inside the **Agent Bridge** group.
4. Ask the connected agent to run `browser_status` or `browser_tabs`.
5. Click the extension icon again to revoke access immediately.

Chrome internal pages, extension pages, password-manager prompts, passkeys, native dialogs, and arbitrary desktop applications are intentionally outside the MVP.

## Security boundaries

- The relay listens only on IPv4 loopback.
- Extension connections must originate from a Chrome extension and present the pairing token.
- The token is generated with 256 bits of randomness and stored with user-only file permissions.
- Only explicitly shared tabs are attached with `chrome.debugger`.
- The agent cannot read password values through `browser_snapshot`.
- Navigation and new tabs are restricted to `http:` and `https:` URLs, so the agent cannot point a shared tab at `file://` paths.
- Potentially consequential click descriptions require `confirmed=true`, and pressing Enter (which can submit forms) requires confirmation as well.

Known limitations:

- The pairing token is sent by the extension to whatever process is listening on `127.0.0.1:17321`. Another local process that binds the port first could capture the token. Loopback binding keeps this local-only, but on a shared or compromised machine treat the token as exposed and rotate it by deleting the token file.
- The confirmation gate is intentionally conservative but not sufficient for unsupervised financial, account-administration, or production workflows. Web content can contain prompt injection. Do not share sensitive tabs.

## Development

```bash
npm run check
npm test
npm run build
```

With the extension loaded and paired, `npm run e2e` runs a live end-to-end smoke test through Chrome: it exercises every MCP tool, the confirmation gates, the `file://` rejection, stale-ref handling, and waits 45 seconds to verify the service-worker keepalive.

The extension is plain JavaScript, so no browser build step is required. Reload it in `chrome://extensions` after extension changes.

## Next steps

- Separate long-running bridge daemon so multiple harness adapters can share one connection
- Per-agent identities, capabilities, and expiring grants
- Human approval UI inside the extension
- Domain policies and sensitive-site defaults
- Append-only action audit log
- Prompt-injection detection and untrusted-page labelling
- Native adapters for Pi, Hermes, Codex, and OpenClaw
- Chrome Web Store packaging and reproducible release artifacts
