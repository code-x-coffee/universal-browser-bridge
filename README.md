# Universal Agent Browser Bridge

A local, agent-agnostic bridge that lets MCP-compatible AI agents operate only the Chrome tabs you explicitly share.

It works with Hermes, Claude Code, Codex, and other MCP clients while keeping your signed-in Chrome session, tab access, and consequential-action approvals under your control.

> This is an independent project inspired by visible tab-consent browser-control systems. It is not affiliated with OpenClaw, Anthropic, Google, OpenAI, or Nous Research.

## What it provides

- A Chrome Manifest V3 extension using `chrome.debugger`
- Explicit per-tab access through a visible **Agent Bridge** tab group and **ON** badge
- One local `serve` daemon that owns the Chrome connection
- Multiple simultaneous MCP clients connected through authenticated local IPC
- Navigation, snapshots, clicking, typing, key presses, scrolling, screenshots, and tab management
- Generation-scoped DOM references that become invalid after navigation
- Chrome-hosted human approval for consequential actions
- Per-client ownership of agent-created tabs
- Per-tab serialization so multiple agents cannot interleave browser actions

## Architecture

```text
Chrome extension
      |
      | authenticated WebSocket on 127.0.0.1:17321
      v
Universal Browser Bridge daemon (`serve`)
      |
      | authenticated Unix socket / Windows named pipe
      +---- MCP adapter (`mcp`) for Hermes
      +---- MCP adapter (`mcp`) for Claude Code
      +---- MCP adapter (`mcp`) for Codex
      +---- MCP adapter (`mcp`) for another session or agent
```

The Chrome extension maintains one connection to the daemon. Start the daemon once, then connect as many MCP adapter processes as you need.

## Quick start

### 1. Clone and build

Requirements:

- Google Chrome or a compatible Chromium browser with Manifest V3 and `chrome.debugger`
- Node.js and npm (the project is verified with Node.js 22)
- An MCP-compatible agent or client

```bash
git clone git@github.com:code-x-coffee/universal-browser-bridge.git
cd universal-browser-bridge
npm ci
npm run build
```

If you cloned over HTTPS instead:

```bash
git clone https://github.com/code-x-coffee/universal-browser-bridge.git
```

### 2. Generate the pairing token

```bash
npm run token
```

Copy the printed token. It is stored at:

```text
~/.universal-browser-bridge/token
```

Keep it private. The extension and every local MCP adapter use it to authenticate with the daemon.

### 3. Load the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository's `extension/` directory.
5. Open the extension's **Details** page.
6. Click **Extension options**.
7. Set **Relay URL** to:

   ```text
   ws://127.0.0.1:17321/extension
   ```

8. Paste the pairing token.
9. Click **Save and connect**.

The extension can be configured before the daemon starts. Its toolbar badge clears once the daemon is running and authentication succeeds.

> Loading the extension from a different directory creates a different unpacked-extension identity in Chrome. You must enter the relay URL and token again for that new identity.

### 4. Start the daemon

Run this in a dedicated terminal and leave it running:

```bash
npm run serve
```

Equivalent direct command:

```bash
node /absolute/path/to/universal-browser-bridge/dist/cli.js serve
```

Expected startup output resembles:

```text
Universal Browser Bridge daemon listening.
  Extension endpoint: 127.0.0.1:17321
  Control socket:     ~/.universal-browser-bridge/daemon.sock
  Token:               ~/.universal-browser-bridge/token
```

`Ctrl-C` gracefully stops the daemon, disconnects all MCP adapters, and removes the control socket.

### 5. Configure your MCP client

The MCP command is:

```bash
node /absolute/path/to/universal-browser-bridge/dist/cli.js mcp
```

Use an **absolute path** because MCP clients often launch subprocesses from a different working directory.

Standard MCP configuration:

```json
{
  "mcpServers": {
    "browser-bridge": {
      "command": "node",
      "args": [
        "/absolute/path/to/universal-browser-bridge/dist/cli.js",
        "mcp"
      ],
      "env": {
        "UBB_CLIENT_LABEL": "my-agent"
      }
    }
  }
}
```

Use a different `UBB_CLIENT_LABEL` for each responsibility, for example `research`, `marketing`, or `coding`. The label appears in Chrome approval prompts and ownership errors.

#### Hermes Agent

Add this to `~/.hermes/config.yaml`:

```yaml
mcp_servers:
  browser-bridge:
    command: node
    args:
      - /absolute/path/to/universal-browser-bridge/dist/cli.js
      - mcp
    env:
      UBB_CLIENT_LABEL: hermes
    enabled: true
```

Start a new Hermes session after changing MCP configuration. The discovered tools are prefixed by Hermes with the configured MCP server name.

#### Multiple sessions and agents

Each MCP configuration launches a lightweight adapter. All adapters connect to the same daemon, so multiple agent sessions can use the bridge simultaneously without competing for port `17321`.

Do not configure every adapter to run `serve`. Only one daemon should run. Every MCP client should run `mcp`.

### 6. Share a tab

1. Open a normal `http://` or `https://` page.
2. Click the extension toolbar icon.
3. Confirm the tab shows an **ON** badge.
4. Confirm Chrome placed it in the **Agent Bridge** tab group.
5. Ask your agent to call `browser_status`, `browser_tabs`, or `browser_snapshot`.
6. Click the toolbar icon again whenever you want to revoke access.

Chrome internal pages, extension pages, password-manager prompts, passkeys, native dialogs, and arbitrary desktop applications are intentionally outside the bridge's scope.

## Available MCP tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Show extension connection state and shared tabs |
| `browser_tabs` | List explicitly shared tabs |
| `browser_new_tab` | Open an agent-owned tab in the dedicated agent window |
| `browser_close_tab` | Close a tab owned by the calling adapter |
| `browser_snapshot` | Read compact interactive elements and receive a `snapshotId` |
| `browser_navigate` | Navigate a shared tab to an allowed URL |
| `browser_click` | Click a snapshot element, with approval when consequential |
| `browser_type` | Replace the contents of a snapshot input element |
| `browser_press` | Send a key press; Enter requires human approval |
| `browser_scroll` | Scroll a shared page by pixels |
| `browser_screenshot` | Capture a PNG screenshot of a shared tab |

`browser_click` and `browser_type` require both the element `ref` and `snapshotId` returned by `browser_snapshot`. Take another snapshot after navigating.

## Running automatically

The daemon is deliberately a foreground process by default. For long-running use, supervise it with a tool appropriate to your operating system, such as:

- macOS: LaunchAgent
- Linux: systemd user service
- Windows: Task Scheduler or a user service wrapper
- Cross-platform development: tmux or another terminal multiplexer

The daemon must run under the same user account that owns the token and control socket. Do not expose it through a public proxy.

## Standalone binary

With [Bun](https://bun.sh) installed, compile the CLI and dependencies into a self-contained executable:

```bash
npm run binary
```

Output:

```text
bin/universal-browser-bridge
```

Run it with:

```bash
./bin/universal-browser-bridge token
./bin/universal-browser-bridge serve
./bin/universal-browser-bridge mcp
```

Cross-compile by selecting a Bun target such as `bun-linux-x64`, `bun-windows-x64`, `bun-darwin-x64`, or `bun-darwin-arm64`.

## Configuration

| Variable | Applies to | Purpose |
| --- | --- | --- |
| `UBB_TOKEN_FILE` | `serve`, `mcp`, `token` | Token path; defaults to `~/.universal-browser-bridge/token` |
| `UBB_TOKEN` | `serve`, `mcp`, `token` | Supply the token directly instead of reading a file |
| `UBB_SOCKET_PATH` | `serve`, `mcp` | Control socket path; defaults to `~/.universal-browser-bridge/daemon.sock` or a Windows named pipe |
| `UBB_PORT` | `serve` | Extension WebSocket port; defaults to `17321` |
| `UBB_CLIENT_LABEL` | `mcp` | Human-readable adapter identity shown in approvals and errors |
| `UBB_ALLOW_PRIVATE_NETWORKS` | `mcp` | Set to `1` to allow localhost and private-network navigation |

If you change `UBB_PORT`, update the extension Relay URL to match:

```text
ws://127.0.0.1:<port>/extension
```

## Token rotation

To invalidate the current token:

1. Stop the daemon and all MCP adapters.
2. Delete or move `~/.universal-browser-bridge/token`.
3. Run `npm run token` to generate a fresh token.
4. Paste the new token into the extension Options page.
5. Restart the daemon and MCP clients.

A token rotation disconnects every process still using the previous token.

## Testing

### Automated tests without Chrome

```bash
npm run check
npm test
npm run build
```

The test suite includes real local sockets and real subprocesses. It starts a daemon, multiple MCP adapters, and a fake extension WebSocket peer. No Chrome interaction is required.

### Live Chrome E2E

First load and pair the extension, then run:

```bash
npm run e2e
```

The E2E suite:

- Starts a real daemon
- Connects two MCP adapters simultaneously
- Creates an agent-owned tab
- Verifies cross-adapter ownership isolation
- Exercises snapshots, navigation, keys, scrolling, clicking, typing, and screenshots
- Rejects `file://` navigation
- Rejects stale snapshot generations
- Waits 45 seconds to verify Manifest V3 service-worker keepalive
- Closes the created tab and cleans up all subprocesses

By default the E2E daemon uses an ephemeral port to avoid colliding with an existing daemon. The script prints the selected URL; update the extension Relay URL to that value. To use a stable test port:

```bash
E2E_PORT=17322 npm run e2e
```

Then set the extension Relay URL to:

```text
ws://127.0.0.1:17322/extension
```

The test never approves Chrome prompts itself. If Chrome asks to create the agent-controlled window, approve it manually.

## Troubleshooting

### Extension does not connect

1. Confirm `serve` is running.
2. Confirm the Relay URL uses the daemon's printed port.
3. Confirm the token in extension Options matches `npm run token`.
4. Click **Save and connect** after editing either field.
5. Confirm Chrome's **Loaded from** path points to the intended `extension/` directory.
6. Reload the extension after changing `extension/*.js`.
7. Restart the daemon after rebuilding `src/*.ts`.

You can inspect daemon health locally:

```bash
curl http://127.0.0.1:17321/health
```

A successful pairing reports `"connected": true`.

### Toolbar badge meanings

| Badge | Meaning |
| --- | --- |
| No badge | Connected or not currently reporting an error |
| `?` | Pairing token is missing from extension settings |
| `!` | Relay is disconnected |
| `ON` | This tab is explicitly shared |
| `ERR` | Chrome refused debugger attachment or tab sharing failed |

### `EADDRINUSE` on port 17321

Another daemon or older single-process bridge is already listening.

```bash
lsof -nP -iTCP:17321 -sTCP:LISTEN   # macOS/Linux
```

Stop the old process or choose another `UBB_PORT`. Only one `serve` daemon should own a given extension port.

### MCP reports that the daemon is not running

Start `serve` separately. The `mcp` command intentionally does not launch a hidden daemon:

```bash
npm run serve
```

### Shared tab disappears

- Confirm the tab remains in the **Agent Bridge** group.
- Renaming the group or dragging the tab out revokes access by design.
- Clicking the extension icon toggles sharing.
- Chrome may refuse debugger attachment while DevTools is attached to the same target.

### New unpacked folder lost its settings

Chrome assigns unpacked extensions an identity based partly on their loaded directory. Loading the same files from another checkout or worktree may create a separate extension with empty storage. Re-enter both the Relay URL and pairing token.

### Changes are not taking effect

- TypeScript/daemon change: run `npm run build`, then restart `serve` and MCP adapters.
- Extension JavaScript change: click **Reload** in `chrome://extensions`.
- MCP client configuration change: restart the MCP client or start a new agent session.

## Security boundaries

- All network listeners bind to IPv4 loopback.
- The extension accepts only `chrome-extension://` WebSocket origins with the pairing token.
- The local control socket is owner-only and also token-authenticated.
- Only explicitly shared tabs are attached through `chrome.debugger`.
- Password input values are omitted from snapshots.
- Navigation and new tabs accept only allowed `http:` and `https:` URLs.
- Localhost and private-network destinations are blocked unless explicitly enabled.
- Consequential clicks and Enter presses require Chrome-hosted human approval.
- The model cannot approve its own request.
- Agent-created tabs belong to their creating adapter while it is connected.
- Per-tab queues prevent concurrent agents from interleaving actions.
- Snapshot generations prevent old references from acting after navigation.
- Dragging a tab out of the **Agent Bridge** group revokes access.

Do not share banking, password-manager, payment, healthcare, or other highly sensitive tabs. Web content can contain prompt injection, and the consequential-action heuristic cannot recognize every risky interaction.

## Known limitations

- A local malicious process that binds the extension port first could capture the pairing token when the extension connects. Rotate the token if you suspect local compromise.
- Client identity is process-scoped. A harness that launches a fresh MCP adapter per turn or subagent gets a new identity.
- `UBB_CLIENT_LABEL` improves attribution but is not an authorization credential.
- The confirmation heuristic is conservative but not comprehensive.
- The extension is currently distributed as an unpacked extension rather than through the Chrome Web Store.
- The daemon is not installed as an operating-system service automatically.

## Development notes

- Extension code is plain JavaScript; no browser build step is required.
- Daemon and MCP code is TypeScript compiled to `dist/`.
- `npm test` covers unit, socket, process, ownership, and Chrome-event-ordering behavior.
- The live E2E was last verified at **17/17 passing** with two simultaneous adapters and real Chrome.

## Roadmap

- Stable logical identities and expiring grants
- Domain policies and sensitive-site defaults
- Append-only action audit log
- Prompt-injection detection and untrusted-page labelling
- Native adapters for additional agent harnesses
- Chrome Web Store packaging and reproducible releases

## License

MIT. See [LICENSE](LICENSE).
