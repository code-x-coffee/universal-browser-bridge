<img src="docs/assets/logo-1024.png" width="96" alt="Universal Agent Browser Bridge logo">

# Universal Agent Browser Bridge

A local, agent-agnostic bridge that lets MCP-compatible AI agents operate Chrome tabs you explicitly share or create under their agent label.

It works with Hermes, Claude Code, Codex, and other MCP clients while keeping your signed-in Chrome session, tab access, and consequential-action approvals under your control.

> This is an independent project inspired by visible tab-consent browser-control systems. It is not affiliated with OpenClaw, Anthropic, Google, OpenAI, or Nous Research.

## What it provides

- A Chrome Manifest V3 extension using `chrome.debugger`
- Explicit per-tab access through a visible **Agent Bridge** tab group and **ON** badge
- One local `serve` daemon that owns the Chrome connection
- Multiple simultaneous MCP clients connected through authenticated local IPC
- Navigation, snapshots, clicking, typing, key presses, scrolling, screenshots, and tab management
- Generation-scoped DOM references that become invalid after navigation
- Chrome-hosted human approval for consequential actions, with configurable trust for agent-owned tabs
- A user-editable site blocklist enforced by both the extension and daemon
- Persistent label ownership of agent-created tabs in named Chrome tab groups
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

### Agent-owned tabs

Set `UBB_CLIENT_LABEL` for an MCP adapter, or pass `--label` to the CLI. A labelled `browser_new_tab` creates a tab in the dedicated agent window and groups it under the label's exact title. It reuses a matching group in that window. By default, the agent window is created without a prompt and without taking focus. Chrome asks first only if you turn off **Let agents open their window without asking** in Extension options.

The package provides both `ubb` and `universal-browser-bridge` CLI names. From a checkout, use `node dist/cli.js` in place of `ubb`:

```bash
ubb --label Hephaestus browser_new_tab '{"url":"https://example.com"}'
ubb --label Hephaestus browser_list_agent_tabs '{}'
# Use the id from browser_new_tab, or tabId from browser_list_agent_tabs:
ubb --label Hephaestus browser_close_tab '{"tabId":123}'
```

`browser_list_agent_tabs` returns `{tabId, url, title, groupId}` for each tab owned by the caller's label. `browser_status` and `browser_tabs` include hand-shared tabs and the caller's owned tabs. Every browser tool accepts owned tab IDs. Other labels, including clients without a label, cannot list, read, drive or close those tabs. A label is a caller-supplied identity: authenticated clients presenting the same label share ownership, even across separate CLI invocations or MCP sessions.

Ownership is stored in [`chrome.storage.session`](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session). It survives extension service-worker restarts and daemon/client reconnects within the Chrome session. Restarting Chrome, reloading/updating the extension, or disabling it clears session storage. Restoration reconciles closed tabs and tabs that have left their original group. Closing, ungrouping, moving a tab to another group, renaming its group, clicking the toolbar to unshare, or cancelling debugging revokes ownership. Merely placing an existing tab in a named group never grants an agent access to it.

Without a label, `browser_new_tab` keeps the existing behavior: it creates a shared, unowned tab in **Agent Bridge**. All clients may read and drive it. While its creating client remains connected, only that client may close it; after disconnect it may be closed by another client. `browser_list_agent_tabs` requires a label. `browser_close_tab` also accepts hand-shared tabs legitimately controlled by the caller. Hand sharing still uses **Agent Bridge** and the **ON** badge.

Tab creation requests are serialized. If a requesting client disconnects while its request is queued, the daemon drops the request. If it disconnects while Chrome is creating the tab, the daemon attempts to close the orphan before processing the next request, without recording ownership. Cleanup is best effort; if Chrome refuses the close, the tab may remain open.

### Trust and site safety settings

Open **Extension options** to change **Trust agent-owned tabs**, **Let agents open their window without asking**, or **Blocked sites**, then click **Save safety settings**. These settings are stored in `chrome.storage.local` and apply immediately without restarting the daemon.

**Trust agent-owned tabs** defaults to enabled (`trustAgentOwnedTabs: true` when unset). Consequential clicks and Enter/NumpadEnter skip the approval popup only when the extension confirms that the target tab is currently owned by the calling label. Turn it off to require approval in owned tabs too. Hand-shared and unlabelled tabs always retain the approval flow for these actions. Clients cannot override the setting with a request flag. Labels remain caller-supplied identities, so authenticated clients using the same label share that trust.

**Let agents open their window without asking** defaults to enabled (`autoCreateAgentWindow: true` when unset). When no live agent window exists, the extension creates one with `focused: false` without an approval popup. Turn it off to require approval before creating the window; opening more tabs in an existing agent window does not prompt. The extension reads the setting for each window creation. With this setting on, any local process holding the bridge token can open agent tabs in your signed-in Chrome without a prompt.

Bank, card, payment and password-manager URLs, including the initial URL of a newly created tab, allow snapshots, screenshots and scrolling, but block clicks, typing, key presses and navigation even with trust enabled. The shared [URL policy](extension/url-policy.js) recognizes listed financial domains (including HDFC, ICICI, SBI, Axis, Kotak, PayPal, Stripe, Razorpay, American Express, Discover, Capital One, Visa and Mastercard), password managers (1Password, Bitwarden, LastPass, Dashlane, Keeper, Google Password Manager, NordPass and Proton Pass), common banking/payment hostname labels, and `/checkout`, `/payment`, `/payments` or `/pay` path segments. It checks current and pending URLs before execution, including after approval waits. Proton's `/pass` pages and `pass.proton.me` are protected without making its other pages read-only. This is conservative URL classification, not an exhaustive sensitive-site directory. The private-network opt-in does not disable it.

**Blocked sites** defaults to empty (`blockedDomains: []`). Enter one domain per line; pasted URLs are accepted. Saving lowercases domains, strips schemes, paths, ports, leading `www.` and trailing dots, converts international names to their ASCII form, and removes empty lines and duplicates. Invalid entries show an error without replacing the saved settings. For example, `https://www.example.com/private` becomes `example.com` and blocks that domain and every subdomain, but does not match `notexample.com` or `example.com.other.org`. To allow a site again, remove its entry and save.

Blocked pages are hidden from tab listings and refuse new tabs, navigation to the domain, snapshots, screenshots, clicks, typing, keys, scrolling and every CDP command. This applies to both owned and hand-shared tabs, regardless of trust. Both the live URL and `pendingUrl` are checked. The extension sends its normalized blocklist over the authenticated connection on connect and on changes; the daemon checks its copy before dispatch and rechecks live tab state through the extension. The extension independently checks again before executing. Refusals contain **"blocked by your blocklist"**. The blocklist controls bridge access to tabs; it does not filter a page's network requests or stop you from opening sites yourself. Previously saved annotations remain available in the local annotation store.

### Uploading files

Use `browser_upload_file` to attach local files through an existing file input or an upload button that opens a file chooser. Pass `ref`, `description`, `snapshotId` and `files` (an array of absolute file paths). `tabId` is optional and otherwise uses the selected tab. Take a fresh `browser_snapshot` after navigation. Optional `mode` controls how the files are attached:

- `auto` (default): use an `<input type="file">`, an associated label, or a container with exactly one file input when available; otherwise click the ref and intercept the chooser.
- `input`: require a resolvable file input and retain the "Target is not a file input" error for other elements.
- `chooser`: always click the ref and intercept the chooser, including dynamically created inputs.

```json
{
  "ref": "ubb-3",
  "description": "Attach the reference image",
  "snapshotId": "7:0",
  "files": ["/Volumes/NVme/Projects/Stories/reference.png"],
  "mode": "auto",
  "tabId": 7
}
```

In Extension options, set **Allowed upload folders**, one absolute folder per line, then click **Save safety settings**. The default when unset is `/Volumes/NVme/Projects/Stories/`. An empty list disables uploads. Invalid and relative entries are ignored; saved paths are normalized and duplicates removed. Only extension settings can change this list. An older extension that does not send the setting leaves uploads disabled in the daemon.

Uploads require a labelled agent and a tab owned by that same label. Hand-shared tabs, blocklisted sites, and bank/card/payment/password-manager pages cannot receive files. Disabled file inputs are rejected; attaching multiple files requires the input's `multiple` attribute. Each call accepts 1–10 regular files, each at most 100 MB (104,857,600 bytes).

The daemon resolves files and allowed folders with `realpath` and checks containment, so sibling prefixes and symlinks escaping an allowed folder are rejected. Symlinks pointing into an allowed folder resolve to the real file path, which is passed to Chrome and returned as `{ "uploaded": 1, "files": ["/absolute/real/path"], "method": "input", "picker": "input" }`. `method` is `input` or `chooser`; `picker` is `input` or `showOpenFilePicker`. The extension independently checks these real paths against its configured folder prefixes; when configuring a symlinked folder, also allow its real destination. Paths containing NUL or `..` segments are refused.

Chooser mode uses the same scroll-to-center, hit-test and trusted mouse input as `browser_click`, with a user-activated script fallback for covered, zero-size or offscreen targets. Consequential clicks retain approval. The extension handles interception and attachment in one command, listens only for the target tab's chooser, and rejects multiple files if it opens in single-selection mode. If no chooser opens within 5 seconds, the error reports whether the `showOpenFilePicker` shim was triggered, with a file-scheme permission hint when that permission is off.

During a chooser call, `window.showOpenFilePicker` is temporarily replaced with a hidden file input that respects `multiple` and the file types in `accept`. Its promise resolves after the input's change event to file-handle-like objects with `kind`, `name`, `getFile`, permission methods and `isSameEntry`. These are not native `FileSystemFileHandle` instances; pages checking `instanceof FileSystemFileHandle` may fail. The extension always attempts to disable interception and restore the original picker after success, timeout or error. A 10-second page timer also restores the shim if normal cleanup cannot run.

Open `chrome://extensions`, find **Universal Browser Bridge**, open **Details**, and enable **Allow access to file URLs**. Reload the updated extension and rebuild/restart the daemon and MCP adapters before using the new tool. Live Chrome uploads are a separate manual check from automated tests.

### Downloading files

Use `browser_download` to save media from a tab owned by your agent label directly to an allowed local folder. It fetches inside the page and transfers bytes to the daemon, so Chrome's Save As preference and the background agent window do not affect saving. Pass `filename`, `description`, and either `ref` + `snapshotId` from `browser_snapshot` or `url`. Snapshots include visible video, image and audio elements within the existing 250-element cap. Ref sources can be `<video>`, `<audio>`, `<source>`, `<img>` or `<a>`; the tool uses `currentSrc`, `src` or `href`.

```json
{
  "ref": "ubb-3",
  "snapshotId": "7:0",
  "filename": "scene.mp4",
  "description": "Save the generated scene",
  "subfolder": "renders",
  "tabId": 7
}
```

For a URL source, replace `ref` and `snapshotId` with `url`. HTTP(S) URLs must have the same origin as the tab. Blob URLs must belong to that origin; data URLs are also allowed. Other schemes, cross-origin sources and redirects are refused. Downloads require a labelled agent, a tab owned by that label, and a writable, unblocked site. Hand-shared tabs cannot download files. Ref downloads require a current snapshot after navigation. The tool reads media without clicking the page.

In Extension options, edit **Allowed download folders** and click **Save safety settings**. This list is separate from upload folders and defaults to `/Volumes/NVme/Projects/Stories/` only when the setting is unset. An empty list disables downloads; an older extension that does not send the policy also leaves downloads disabled. `folder` optionally selects a configured folder; the default is the first. `subfolder` is relative to it. Neither agents nor tools can edit the allowed list.

Each download is limited to 500 MB (524,288,000 bytes), checked against Content-Length when present and the fetched Blob size before transfer. The daemon transfers 1 MB chunks into a private `.<name>.<id>.ubb-partial` file. It atomically publishes the completed file without overwriting existing files or following final-path symlinks. Collisions become `scene (1).mp4`, `scene (2).mp4`, and so on. The result is `{ "saved": "/real/path/renders/scene.mp4", "bytes": 12345, "mimeType": "video/mp4" }`.

Filenames use only the basename, remove control characters, separators, colons and leading dots, and are trimmed to 200 characters while preserving the extension. Empty names are rejected. Subfolders cannot be absolute or contain `..` segments; each segment is sanitized, created and resolved within the real allowed folder. Symlink escapes are refused before creating further directories outside that folder.

Errors remove the temporary file and attempt to release the page-held Blob. A two-minute page timer also releases abandoned fetches and Blobs when a disconnect, navigation or policy change prevents normal cleanup. Active chunk transfers refresh that timer. Download operations recheck site access and the selected folder before each page command.

## Annotations

Share a normal HTTP(S) tab with the toolbar icon, then enter annotation mode with **Alt+Shift+A** (macOS: **Control+Shift+A**) or right-click the toolbar icon and choose **Annotate this tab**. The toolbar's normal click still toggles sharing. If the shortcut conflicts, change it at `chrome://extensions/shortcuts`.

Hover to highlight an element, click to select it, or drag a rectangle. Enter a comment and click **Save**. **Cancel** discards the selection; **Esc** cancels the popup and exits annotation mode. Numbered pins show comments and reply threads on hover or click. Open pins with replies turn green, gain a badge dot, and have an **Answered** title and accessible label. Resolved pins stay grey even when they have replies. Updates appear on every shared tab at the same exact URL. Reloading that URL restores its pins. Long threads scroll; reply authors and local timestamps appear above plain-text replies.

Each save captures a PNG of the visible viewport with the annotation overlay hidden. Keep that tab active in its window until saving finishes. Metadata includes the selector, a short text snippet, page rectangle, viewport, scroll position, URL, title and timestamps. Pins follow the selector when it still exists, including the region's saved offset from its anchor; otherwise they use the original page coordinates.

The daemon stores private files in `~/.universal-browser-bridge/annotations/`: `annotations.json` and `<id>.png`. Set `UBB_DATA_DIR` on **serve** to change the data root. The daemon is the sole writer and commits files with temporary-file renames. Annotation queries, resolution and replies also work when Chrome is disconnected.

```bash
universal-browser-bridge annotations list --status open --json
universal-browser-bridge annotations list --url 'https://example.com/'
universal-browser-bridge annotations get <id>
universal-browser-bridge annotations get --url 'https://example.com/'
universal-browser-bridge annotations resolve <id> --note 'Fixed the heading'
universal-browser-bridge annotations reply <id> --text 'Fixed the spacing' --author Hephaestus
```

CLI output is JSON. List defaults to all statuses; URL filters match exactly, including query strings and fragments. `get <id>` returns one record, and `get --url` returns an array. Both include an absolute `screenshotPath`. Resolution is idempotent and preserves the first resolution timestamp and note.

Every record includes `replies`, an array of `{id, author, text, createdAt}`. Older records load with an empty array. Reply text is trimmed and must contain 1–10,000 characters. Authors are trimmed and must contain 1–100 characters; omitted authors default to `agent`. Replying to a resolved annotation preserves its resolved state. `annotations reply` prints the updated record.

MCP provides the same operations. For an existing `ubb <tool_name> '<json>'` wrapper:

```bash
ubb annotations_list '{"status":"open","url":"https://example.com/"}'
ubb annotations_get '{"id":"<id>"}'
ubb annotations_get '{"url":"https://example.com/"}'
ubb annotations_resolve '{"id":"<id>","note":"Fixed the heading"}'
ubb annotations_reply '{"id":"<id>","text":"Fixed the spacing","author":"Hephaestus"}'
```

Annotations use the existing token-authenticated WebSocket and control socket, with no additional listener. The extension adds `scripting`, `contextMenus` and `activeTab`, with no broad website host permission. Chrome grants `activeTab` on a toolbar click, annotation shortcut or context-menu invocation; automatic injection still requires the tab to be shared. Same-origin reloads retain the grant. After crossing origins, or on an agent-created tab without a user gesture, invoke the annotation shortcut or context menu again to grant access. Unsharing removes the overlay.

Annotations target the top-level document. Iframes and elements inside shadow roots cannot be individually selected. Screenshots show only the viewport; coordinates and selectors may become less accurate after major page changes. Data remains local until an agent reads it through the bridge or you enable a webhook.

### Annotation webhook

To POST each newly saved annotation to an HTTP(S) endpoint, create `<dataRoot>/webhook.json`. The data root is `UBB_DATA_DIR` on **serve**, or `~/.universal-browser-bridge` by default:

```json
{
  "url": "https://hooks.example.com/annotations",
  "headers": {
    "Authorization": "Bearer YOUR_TOKEN",
    "X-Sender-Key": "YOUR_SENDER_KEY"
  },
  "enabled": true
}
```

Keep the directory private (mode `700`) and the config file private (mode `600`, for example `chmod 600 ~/.universal-browser-bridge/webhook.json`). The CLI does not write this file. `headers` defaults to `{}` and `enabled` defaults to `true`. Set `enabled: false` to disable delivery. Set `UBB_ANNOTATION_WEBHOOK_URL` on **serve** to override the URL and enable delivery, including without a file; valid file headers still apply. File edits are read on the next send without restarting the daemon. A missing file with no override is silently disabled. Invalid JSON/configuration disables delivery, even with an env override, and emits one warning until the configuration becomes valid again.

Each successful new save sends this JSON metadata, never PNG bytes:

```json
{
  "event": "annotation.created",
  "annotation": {
    "id": "00000000-0000-4000-8000-000000000001",
    "comment": "Fix the heading",
    "url": "https://example.com/",
    "title": "Example",
    "textSnippet": "Page heading",
    "selector": "#heading",
    "createdAt": "2026-10-10T10:00:00.000Z",
    "screenshotPath": "/absolute/data/root/annotations/00000000-0000-4000-8000-000000000001.png"
  }
}
```

Requests always use `Content-Type: application/json`. `User-Agent: universal-browser-bridge` is added unless overridden (header names are case-insensitive). Delivery runs asynchronously after saving and never delays or fails the extension's save response. Queries, replies and resolutions do not send webhooks.

Each attempt has a 10-second timeout. Network failures, timeouts, HTTP `429` and `5xx` retry up to three times, with 1s, 2s and 4s backoff (four attempts total, about 47 seconds maximum). Other HTTP errors do not retry, and redirects are not followed. Failures log only the endpoint host and HTTP status or a generic error, never header values or URL paths/queries. Retries can deliver the same event more than once; consumers should deduplicate by annotation ID. Delivery is best-effort in memory, with no durable queue or restart recovery.

```bash
universal-browser-bridge annotations webhook status
universal-browser-bridge annotations webhook test
```

Both commands use the authenticated daemon control socket, so **serve** must be running. `status` prints `{configured, enabled, source, host, headerNames}` with source `file`, `env` or `none`, and never prints header values. `test` uses the same sender, headers, timeout and retry policy to send `{"event":"annotation.test","sentAt":"<ISO timestamp>"}`. It prints `{ok, attempts}` plus a status code or error, and exits non-zero for disabled configuration or failed delivery.

**After updating, reload the extension at `chrome://extensions` and rebuild/restart the daemon and MCP adapters.** Live annotation interaction in Chrome is a separate manual check from the automated mock, socket and process tests.

## Available MCP tools

| Tool | Purpose |
| --- | --- |
| `browser_status` | Show extension connection state, shared tabs and caller-owned tabs |
| `browser_tabs` | List shared tabs and caller-owned tabs |
| `browser_new_tab` | Open a tab in the agent window, owned and grouped under the caller's label when supplied |
| `browser_list_agent_tabs` | List the caller label's tabs as tabId, url, title and groupId |
| `browser_close_tab` | Close a caller-owned tab or a tab otherwise legitimately shared with the caller |
| `browser_snapshot` | Read compact interactive elements and receive a `snapshotId` |
| `browser_navigate` | Navigate a shared tab to an allowed URL |
| `browser_click` | Scroll to and click a snapshot element with trusted mouse input (script fallback); consequential approval applies unless the caller's owned tab is trusted |
| `browser_type` | Replace the contents of a snapshot input element with user activation |
| `browser_upload_file` | Attach up to 10 allowed local files through an input or intercepted chooser in a caller-owned tab; modes: auto, input, chooser |
| `browser_download` | Save same-origin, blob or data media from a caller-owned tab to an allowed download folder, up to 500 MB |
| `browser_press` | Send trusted keyboard input; Enter and NumpadEnter require approval unless the caller's owned tab is trusted |
| `browser_scroll` | Scroll a shared page by pixels |
| `browser_screenshot` | Capture a PNG screenshot of a shared tab |
| `annotations_list` | List saved annotations by exact URL and status |
| `annotations_get` | Get an annotation by ID or all annotations for a URL |
| `annotations_resolve` | Resolve an annotation and update live pins |
| `annotations_reply` | Append a reply and update live pins, including on resolved annotations |

`browser_click` and `browser_type` require both the element `ref` and `snapshotId` returned by `browser_snapshot`. Take another snapshot after navigating.

`browser_click` scrolls the element into view and checks its center with `document.elementFromPoint`. When the center is visible, has size and hits the element or a descendant, it sends trusted CDP mouse move, left-button press and release events. Zero-size, covered or offscreen targets use a script click with `userGesture: true` instead. The result is `{ clicked: true, method: "mouse" | "script" }`. The fallback click event remains synthetic, but the script runs with user activation for actions such as downloads and file pickers. `browser_type` also runs its focus/value script with user activation. `browser_press` uses trusted CDP key events and retains approval for Enter and NumpadEnter.

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
| `UBB_TOKEN_FILE` | `serve`, `mcp`, `token`, `annotations` | Token path; defaults to `~/.universal-browser-bridge/token` |
| `UBB_TOKEN` | `serve`, `mcp`, `token`, `annotations` | Supply the token directly instead of reading a file |
| `UBB_SOCKET_PATH` | `serve`, `mcp`, `annotations` | Control socket path; defaults to `~/.universal-browser-bridge/daemon.sock` or a Windows named pipe |
| `UBB_DATA_DIR` | `serve` | Annotation data root; defaults to `~/.universal-browser-bridge` |
| `UBB_ANNOTATION_WEBHOOK_URL` | `serve` | Override and enable the annotation webhook URL; retain valid file headers |
| `UBB_PORT` | `serve` | Extension WebSocket port; defaults to `17321` |
| `UBB_CLIENT_LABEL` | `mcp`, CLI tools | Persistent agent ownership label, group title and approval identity; `--label` overrides it |
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

Restricted environments can run the socket-free tests, including the real extension/bridge/daemon/MCP ownership, trust and blocklist flows over mocked socket and Chrome boundaries:

```bash
npm test -- --exclude src/bridge.test.ts --exclude src/daemon.test.ts --exclude src/background-owner-race.test.ts --exclude src/cli-integration.test.ts
```

Those four files require local listeners, and the CLI integration also requires the `tsx` IPC socket. An `EPERM` listener failure is an environment restriction; the socket-free run does not replace real-socket or live Chrome acceptance.

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

The agent-controlled window opens without a prompt by default. If you turned off **Let agents open their window without asking**, approve the window creation manually; the test never approves Chrome prompts itself.

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
| `ERR` | Tab sharing failed; hover the toolbar icon to see the reason |

### `ERR` badge when sharing a tab

Hover the toolbar icon to see why sharing failed.

- `Cannot access a chrome-extension:// URL of different extension` means another extension (e.g. a password manager or Grammarly) has a frame in the page. Open `chrome://extensions`, select that extension's **Details**, set **Site access** to **On click**, and reload the tab before trying again.
- `Another debugger is already attached` means DevTools or another debugging extension is attached to that tab. Close DevTools or disconnect the other extension from the tab, then try again.

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
- File uploads require live ownership by the caller's label, writable/unblocked sites, and user-configured allowed folders; the daemon validates real paths, file types and sizes, and the extension independently guards attachment.
- Downloads require a caller-owned, writable, unblocked tab and a separately configured allowed download folder. The daemon checks source origins, a 500 MB cap and real destination paths; the extension independently checks ownership, site access and the selected folder. Chunk transfers use private temporary files and atomic publication without overwrite. MCP tools cannot change download permissions.
- Chooser uploads retain those checks and consequential-click approval. The extension rechecks access before each operation, limits interception to one upload per tab, and restores the picker shim and interception after the call. If access is revoked mid-call, cleanup still attempts to disable interception and restore the shim.
- Navigation and new tabs accept only allowed `http:` and `https:` URLs.
- Localhost and private-network destinations are blocked unless explicitly enabled.
- Consequential clicks and Enter presses require Chrome-hosted human approval unless the extension's trust setting is enabled and the live tab belongs to the caller's label.
- Creating the agent window requires approval only when **Let agents open their window without asking** is turned off. It is enabled by default, so any local process holding the bridge token can open agent tabs in the signed-in Chrome without a prompt.
- Bank, card, payment and password-manager pages always remain read-only, regardless of either trust or automatic window creation settings.
- The daemon rechecks writable policy before CDP calls marked `requiresWritable`. The extension independently treats every `Input.*` method and `DOM.setFileInputFiles` as a write, even if the caller omits that flag. Trusted input and script user activation retain tab ownership, blocklist, snapshot and approval checks.
- Blocklisted domains and their subdomains refuse all page operations in owned and hand-shared tabs, with current and pending URL checks in both the daemon and extension.
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
