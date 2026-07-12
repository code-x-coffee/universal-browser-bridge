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

Copy the printed token. Then:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this project's `extension/` directory.
5. Open the extension options and paste the pairing token.

The toolbar badge clears when the MCP relay is running and paired.

## Connect an MCP client

Configure the client to run:

```bash
node /absolute/path/to/universal-browser-bridge/dist/cli.js mcp
```

Example MCP configuration:

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "node",
      "args": [
        "/Volumes/NVme/StandAlones/chrome-extensions/universal-browser-bridge/dist/cli.js",
        "mcp"
      ],
      "env": {
        "UBB_TOKEN_FILE": "/Volumes/NVme/StandAlones/chrome-extensions/universal-browser-bridge/.data/token"
      }
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
- Potentially consequential click descriptions require `confirmed=true`.

The confirmation gate is intentionally conservative but not sufficient for unsupervised financial, account-administration, or production workflows. Web content can contain prompt injection. Do not share sensitive tabs.

## Development

```bash
npm run check
npm test
npm run build
```

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
