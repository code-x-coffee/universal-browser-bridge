# Universal Agent Browser Bridge

A local, agent-agnostic bridge that lets MCP-compatible agents operate only the Chrome tabs you explicitly share.

This is an independent implementation inspired by the visible tab-consent model used by OpenClaw. It is not affiliated with OpenClaw, Anthropic, Google, or OpenAI.

## Current MVP

- Unpacked Chrome MV3 extension using `chrome.debugger`
- Explicit per-tab sharing through a visible **Agent Bridge** tab group
- Authenticated WebSocket connection bound to `127.0.0.1`
- A single long-running `serve` daemon owns the extension connection; any number of `mcp` adapters (Claude Code, Codex, Hermes, etc.) connect to it at once over an authenticated local control socket
- MCP tools for tabs, navigation, snapshots, clicking, typing, keys, scrolling, and screenshots
- Temporary DOM refs rather than arbitrary selectors supplied by the model, gated by a `snapshotId` that goes stale on navigation
- Chrome-hosted human approval for purchases, sends, deletes, submissions, Enter presses, and agent-window creation, and approval prompts name which adapter asked
- Agent-created tabs are owned by the adapter that created them; only that adapter can close them

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

The toolbar badge clears when the `serve` daemon is running and paired. The first agent-created window opens a one-time Chrome approval prompt for that window's session.

## Standalone binary (no Node required)

With [Bun](https://bun.sh) installed, compile the CLI and its dependencies into one self-contained executable:

```bash
npm run binary   # produces bin/universal-browser-bridge (~60 MB)
```

The binary embeds the runtime, so end users need neither Node nor `npm install`. Cross-compile for other platforms with `bun build --compile --target=bun-linux-x64` (or `bun-windows-x64`, `bun-darwin-x64`, `bun-darwin-arm64`).

## Start the daemon

`serve` is the one long-running process that owns the extension WebSocket (port `17321` by default) and the authoritative tab/pending-command state. Start it once, before connecting any MCP client:

```bash
node /absolute/path/to/universal-browser-bridge/dist/cli.js serve
# or, using the standalone binary:
/absolute/path/to/universal-browser-bridge/bin/universal-browser-bridge serve
```

It prints the extension endpoint, the control socket path, and the token path, then keeps running. Leave it running (in a terminal, tmux pane, or process supervisor) for as long as you want agents to have browser access; `Ctrl-C` stops it and disconnects every adapter.

## Connect MCP clients (adapters)

`mcp` is a lightweight client of the daemon: it never binds `17321` and holds no browser state of its own. Configure each MCP-compatible harness to run it — every harness gets its own adapter process, and any number can connect to the same `serve` daemon at once:

```bash
node /absolute/path/to/universal-browser-bridge/dist/cli.js mcp
# or, using the standalone binary:
/absolute/path/to/universal-browser-bridge/bin/universal-browser-bridge mcp
```

If `serve` isn't running, `mcp` fails immediately with an explicit instruction to start it — it will not silently spawn a background daemon for you.

Example MCP configuration:

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "node",
      "args": [
        "/absolute/path/to/universal-browser-bridge/dist/cli.js",
        "mcp"
      ],
      "env": { "UBB_CLIENT_LABEL": "claude-code" }
    }
  }
}
```

Use the equivalent MCP configuration surface in Codex, Claude Code, Hermes, or another compatible harness. Pi can use an MCP adapter or a future native extension.

### Env vars

| Variable | Applies to | Purpose |
| --- | --- | --- |
| `UBB_TOKEN_FILE` | `serve`, `mcp`, `token` | Override the pairing token file path (default `~/.universal-browser-bridge/token`) |
| `UBB_SOCKET_PATH` | `serve`, `mcp` | Override the daemon control socket path (default `~/.universal-browser-bridge/daemon.sock`, or a named pipe on Windows) |
| `UBB_PORT` | `serve` | Override the extension WebSocket port (default `17321`) |
| `UBB_CLIENT_LABEL` | `mcp` | Human-readable identity for this adapter; shown in Chrome approval prompts and ownership errors so a person can tell which agent asked |
| `UBB_ALLOW_PRIVATE_NETWORKS` | `mcp` | Allow navigation to `localhost`/private-network URLs |

### Logical identity limitation

Each `mcp` process generates a random client ID at startup and reports `UBB_CLIENT_LABEL` if set; the daemon uses that identity to attribute approval requests and to enforce tab-close ownership. A harness that spawns a fresh `mcp` process per turn or per subagent (some Hermes and generic subagent setups do this) gets a **new** logical identity each time, so a subagent cannot close a tab an earlier subagent created under the same harness — set a stable `UBB_CLIENT_LABEL` per logical agent (not per process) if you want approval prompts to read consistently, but be aware tab ownership is still tied to the process-level client ID, not the label.

## Share a tab

1. Open a normal web page.
2. Click the extension toolbar icon.
3. Confirm the tab shows an **ON** badge and is inside the **Agent Bridge** group.
4. Ask the connected agent to run `browser_status` or `browser_tabs`.
5. Click the extension icon again to revoke access immediately.

Chrome internal pages, extension pages, password-manager prompts, passkeys, native dialogs, and arbitrary desktop applications are intentionally outside the MVP.

## Security boundaries

- The extension WebSocket listens only on IPv4 loopback.
- Extension connections must originate from a Chrome extension and present the pairing token.
- The daemon control socket (`serve` <-> `mcp` adapters) is a Unix domain socket (or Windows named pipe) under the user's home directory, created with owner-only (`0600`) permissions, and additionally requires every adapter to present the same pairing token before the daemon accepts any request — an unauthenticated or mistoken connection is dropped within 3 seconds without a response.
- The token is generated with 256 bits of randomness and stored with user-only file permissions.
- Only explicitly shared tabs are attached with `chrome.debugger`.
- The agent cannot read password values through `browser_snapshot`.
- Navigation and new tabs are restricted to `http:` and `https:` URLs, so the agent cannot point a shared tab at `file://` paths.
- Potentially consequential clicks and Enter presses pause until you approve them in a Chrome popup, which now also states which adapter (`UBB_CLIENT_LABEL`, or a short client ID) is asking. The model cannot approve its own request.
- The **Agent Bridge** tab group is enforced: dragging a tab out immediately revokes debugger access, and toolbar revocation removes it from the group.
- Agent-created tabs live in a dedicated window and are owned by the adapter that created them; only that adapter's control-socket connection can close them, and every other client's close attempt is rejected before it ever reaches the extension. Creating the agent window requires a one-time human grant.
- Per-tab operations (snapshot/click/type/navigate/press/scroll/screenshot) are serialized by the daemon through a per-tab queue, so two adapters acting on the same tab at once cannot interleave mid-action; a disconnecting client never leaves the queue stuck for the next one.
- `browser_snapshot` returns a `snapshotId` tied to a per-tab generation counter that the daemon bumps on every navigation. `browser_click`/`browser_type` must pass the current `snapshotId` back; a stale one (taken before a navigation) is rejected with a clear error instead of silently acting on a different page.
- Literal localhost and private-network URLs are blocked by default. For personal development against local apps, add `UBB_ALLOW_PRIVATE_NETWORKS=1` to the MCP server environment.

Known limitations:

- The pairing token is sent by the extension to whatever process is listening on the extension port (`127.0.0.1:17321` by default). Another local process that binds the port first could capture the token. Loopback binding keeps this local-only, but on a shared or compromised machine treat the token as exposed and rotate it by deleting the token file.
- The confirmation heuristic is intentionally conservative and cannot identify every consequential action. Web content can contain prompt injection. Do not share banking, password-manager, or other highly sensitive tabs.
- See [Logical identity limitation](#logical-identity-limitation) above: harnesses that respawn `mcp` per turn/subagent get a fresh, unrelated client identity each time, which affects tab-close ownership.

## Development

```bash
npm run check
npm test
npm run build
```

`npm test` includes real-socket/real-process integration tests (`src/daemon.test.ts`, `src/cli-integration.test.ts`) that spin up an actual `serve` daemon and multiple `mcp`/control-socket clients against a fake (non-Chrome) extension WebSocket peer — no Chrome required, and no timers/sockets/temp files left behind.

With the extension loaded and paired, `npm run e2e` runs a live end-to-end smoke test through Chrome: it starts a real `serve` daemon, connects two simultaneous `mcp` adapters, and exercises the non-consequential MCP tools, cross-adapter tab-ownership rejection, URL rejection, stale-snapshot handling, cleanup, and a 45-second wait to verify the service-worker keepalive. It never approves a Chrome dialog on your behalf — if one appears (e.g. the one-time agent-window grant), approve it by hand or the run stalls until its timeout.

The extension is plain JavaScript, so no browser build step is required. Reload it in `chrome://extensions` after extension changes.

## Next steps

- Per-agent identities, capabilities, and expiring grants (beyond the current per-process client ID + label)
- Domain policies and sensitive-site defaults
- Append-only action audit log
- Prompt-injection detection and untrusted-page labelling
- Native adapters for Pi, Hermes, Codex, and OpenClaw
- Chrome Web Store packaging and reproducible release artifacts
