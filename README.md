# Codex Claude

Use Claude Opus 5.5, Sonnet 5.5, Haiku 5.5, and Fable 5.1 alongside GPT-6.1 Sol, GPT-6 Astra, and GPT-6 Luna in local Codex chats. Claude models use your Claude subscription; GPT models use your existing ChatGPT login. Codex runs the tools and enforces its approvals; the official Claude Agent SDK handles subscription login and model sessions. This is an experimental local adapter, not an official integration.

## Install on a Mac

You need macOS, Node.js 22.18 or newer (with npm), Claude Code, and the Codex desktop app. Use your own Claude subscription and ChatGPT login. Your accounts must have access to the models you select. This runs directly on your Mac; no container or hosted server is needed.

1. Clone this repository into a permanent folder, then open a terminal in that folder. Share a Git clone, not someone else's working folder: the ignored `.local/` directory contains private credentials, configuration backups, and session data.
2. Open Codex, sign in with ChatGPT, and use its native model picker first. Setup requires an existing `config.toml` and `models_cache.json` in `~/.codex` (or `CODEX_HOME`). The cache must contain GPT-6.1 Sol, GPT-6 Astra, and GPT-6 Luna; setup still refuses installation if any are missing.
3. Install the repository dependencies, sign in to Claude Code with your subscription, and check prerequisites:

```sh
npm ci
claude auth login
npm run setup -- check
```

The prerequisite check reads configuration and Claude login status without installing a service, changing Codex settings, or sending a model request. API-key login is rejected. If it fails, follow the error before installing.

4. Install the adapter, then quit and reopen the Codex desktop app:

```sh
npm run setup
```

`npm run setup` is equivalent to `npm run setup -- enable`. It repeats the prerequisite check, saves your previous settings privately in `.local/config.before-claude.toml`, installs a user LaunchAgent, and enables the combined model picker. It uses the current Node executable, finds `claude` on PATH, and generates paths for your checkout and home directory. Run it as your normal macOS user, without `sudo`.

5. Check the service and, optionally, send a short live request using your subscription allowance:

```sh
npm run setup -- status
CODEX_CLAUDE_CLI="$(command -v claude)" npm run doctor
```

Select a model in a **new chat**. Claude models use your Claude subscription; GPT models use your ChatGPT login. No provider toggle is needed between chats. GPT Fast/Ultrafast options, context sizes, and native instructions come from your Codex model catalog.

Each chat stays with its first provider through this gateway. Claude-to-Claude and GPT-to-GPT model changes are supported. Switching between Claude and GPT requires a new chat; the app may display the other choices, but the gateway rejects a cross-provider request before forwarding it.

## Installation details and troubleshooting

- The service starts at login, listens only on `127.0.0.1:19382`, and writes its log to `.local/service.log`. Port 19382 must be free. Stop a foreground `npm start` before installing the service.
- The service identifier is `local.codex-claude`. Install only one checkout per macOS user, and keep its folder in place.
- `CODEX_CLAUDE_CLI` can specify an absolute Claude executable path. The installed service detects Claude on PATH, but direct `npm start`, `doctor`, and context checks still default to `/opt/homebrew/bin/claude`. For another installation location, supply the override shown above. These defaults are unchanged.
- Setup merges the four Claude entries with the three required GPT entries in your Codex cache; two internal helper models remain hidden. Missing required GPT models still cause an error. Refresh the cache using the native OpenAI provider and confirm your account has those models before retrying.
- Setup requires its default `.local` state directory and port. Foreground development can override `CODEX_CLAUDE_STATE_DIR` and `CODEX_CLAUDE_PORT`; the token helper must use the same state directory.
- A sleeping Mac cannot keep local work running. The adapter does not prevent sleep.

Verified with Node 26.8.1, Claude Code 2.1.288, SDK 0.3.295, and the desktop app's Codex 0.162.0-alpha.2 binary. Other versions and model catalogs may differ.

## Update or remove

To update, wait until adapter-backed chats have finished or pause them. From the installed checkout:

```sh
git pull --ff-only
npm ci
npm run check
npm test
npm run setup
launchctl kickstart -k "gui/$(id -u)/local.codex-claude"
npm run setup -- status
```

Setup refreshes the catalog and service configuration but does not restart an already running adapter. The `kickstart` command does restart it and interrupts active turns. Reopen Codex after catalog changes. If you move the checkout or change the Node installation, uninstall using the old checkout first, then install from the new location.

To return to your previous model configuration while keeping the service installed:

```sh
npm run setup -- disable
```

To restore your previous settings and remove the login service:

```sh
npm run setup -- uninstall
```

Reopen Codex afterward. Uninstall retains `.local` session files and the configuration backup. Remove the checkout only after uninstalling. Restoring settings preserves unrelated configuration changes made since installation; re-enabling the adapter preserves the original backup during upgrades.

## Supported behavior

- Text streaming, embedded PNG/JPEG/GIF/WebP images, function/custom tools and namespaces, tool results (including screenshots), follow-up turns, completed-turn restart, and explicit errors. Codex retains tool execution and approvals. SDK built-in tools, project settings, hooks, and slash commands are disabled.
- Web search and page reading use Codex’s existing `mcp__codex_apps__search_service_web_run` connector when connected. The adapter directs Claude to discover its declaration in `ALL_TOOLS` and use the connector’s actual argument schema. SDK built-in web tools remain disabled.
- Claude is guided to wait for long-running jobs with one watcher where available (for example, `gh run watch`), keeping routine output in a local log and continuing waits on the same Codex process/cell. Waiting inside a tool does not itself request another model response. Tool calls can remain pending for up to 24 hours; idle SDK processes close after four minutes and session metadata leaves memory after ten idle minutes. Stop/continue recovery remains available. This is not an event-driven background monitor and does not keep a sleeping laptop running.
- Up to three completed Claude processes stay alive for four idle minutes each. A follow-up with unchanged model, effort, instructions, and tools sends only its new user input to the same process. The oldest idle process closes when a fourth finishes; active responses and pending tools are not counted or evicted. Expiry or a configuration change resumes saved SDK history on the next turn without replaying completed actions. No keepalive prompts are sent. A small live Opus check held about 240 MiB per idle process, used 0.28 CPU-seconds across 30 idle seconds, and recorded no new model prompts or token usage. Larger sessions may use more RAM.
- Claude thinking streams into Codex's reasoning display before the answer. Thinking signatures and redacted content are not exposed; redacted thinking shows a generic activity marker. These events use the same bounded reconnect buffer as answer text.
- Quiet model responses send `response.in_progress` SSE events every 15 seconds, including during slow request admission. Codex ignores SSE comments for its event idle timeout, so comment-only keepalives are insufficient.
- Codex subagents use separate Claude sessions keyed by their thread IDs, even when Codex shares a transport session ID. Children can start fresh or inherit the parent’s visible history. Mid-turn notifications and steering messages enter the SDK input stream alongside tool results; queued responses finish before the adapter completes the turn.
- Manual forks start an independent SDK session from the exact visible history supplied by Codex. Later parent turns stay out of the fork. Images in forked history remain native image blocks rather than base64 text.
- Custom tool inputs use a JSON string inside the SDK and return as raw Codex input. Original grammars are included in tool descriptions; grammar-constrained decoding is unavailable.
- Claude keeps its own thinking/session state. Codex permission changes apply through the SDK’s supported custom prompt option. If instructions change during a pending tool call, the adapter rebuilds from the current visible history. Such changes can discard earlier thinking and invalidate prompt caching.
- Codex owns visible compaction. Its structured compaction metadata selects a separate, tool-free summarization session. A new Codex context window starts a fresh Claude session from the compacted visible history, without reusing old thinking blocks or replaying completed actions. SDK compaction may also occur within a long tool turn.
- All four Claude catalog entries declare the models’ native 1M context window. Codex applies each model’s own context and compaction limits, so GPT models are not forced to use Claude’s 1M setting. Live Opus retrieval passed at **500,468** and **850,474 input tokens**, using Claude’s usage accounting. The full 1M boundary and long-context Sonnet/Haiku/Fable have not been stress-tested.

## Limits and recovery

Setup enables up to eight native Codex HTTP request retries, so temporary upstream failures such as a 503 can recover within the same turn. Codex controls retry timing and honors upstream retry delays. If the retry limit is exhausted, the turn still stops with an error; send **continue** after the service recovers. This is bounded recovery, not an indefinite pause or a background task restart. Run `npm run setup` and reopen Codex to apply this setting to an existing installation. Automatic response-stream retries remain disabled, so an interrupted stream is not silently replayed.

Brief HTTP disconnects have a 30-second reconnection grace period. An identical request (ignoring JSON object key order) reattaches to the same SDK query and replays existing response events with their original response and tool-call IDs. Completed responses remain available for 30 seconds if their final bytes were lost. Recovery allows at most two reconnections per response and buffers at most 4 MiB per response, with up to 32 retained responses. It does not start another model query, resubmit tool results, or execute tools. Upstream model errors remain errors; they are not blindly retried through a fresh query.

If reconnection expires, the adapter stops the disconnected query. A repeated request without a new user message is rejected, including after a service restart, so an automatic retry cannot replay uncertain actions. Send **continue** to recover in the same chat from Codex’s visible history, including completed tool results. Edited user history and changed permissions also use that existing recovery path. A call without a recorded result has an unknown outcome; the recovery prompt requires checking that outcome before attempting that action again. Normal follow-ups still resume their SDK session, preserving caching. Forks and recovery can incur a fresh context/cache fill. During a disconnected response, Stop may take up to the 30-second grace period to close the SDK query. An appended user message with unchanged model, instructions, and earlier user history reuses the live query when no tool outcome is outstanding. The adapter hands off the HTTP reader, submits only the new message, and waits for its SDK replay acknowledgment before treating a completion as final. Changed permissions, edited history, model changes on this path, and unresolved tool outcomes retain the existing recovery behavior.

Audio, hosted OpenAI search, and importing GPT histories into standalone Claude chats remain unsupported. Images must be embedded data, as sent by Codex attachments and screenshot tools; remote image URLs are rejected. Hosted search is omitted from the Claude tool inventory; the connected search tool described above is available instead. The OpenAI route forwards native Responses requests and compaction, preserving their request bodies and streamed responses. Tool definitions stay fixed during each SDK turn; newly connected tools become available on the next user turn. Abandoned pending tools expire after 24 hours and recover from visible history if continued. Codex’s individual wait calls retain their own limits; a longer job should keep waiting on its existing process rather than restarting it.

The adapter removes API/provider environment overrides and requires first-party subscription authentication. It stops when Claude reports exhausted subscription allowance or active extra usage. This is detection, not a billing cap: **turn off extra usage in your Claude account if you require zero additional charges**. The gateway uses Codex’s supported ChatGPT authentication: the incoming ChatGPT authorization and account headers are forwarded only to the fixed OpenAI backend. They are never sent to Claude, persisted, or logged. A separate local gateway key is stored in your private Codex configuration and stripped before forwarding. Claude login remains owned by its SDK.

The server binds only to loopback, requires a private local credential, rejects browser-origin requests, bounds request size, and avoids logging request contents or credentials. The combined gateway authenticates this credential in a separate header; the legacy Claude endpoint uses a bearer token. SDK transcripts remain in Claude’s normal local storage; adapter metadata and backups live in ignored `.local` files.

The desktop’s bundled backend returns exactly the seven requested visible models, including native GPT speed tiers. Live checks passed for all three GPT models with Fast requested, and Haiku/Fable completed real tool round trips. Thirty local checks cover forwarding, credential separation, provider locks, catalog filtering, and the existing bridge behavior. Actual GUI interaction was blocked by the computer-use tool, so final model-picker and app-restart behavior still require a manual check. Provider locking covers chats after their first gateway request, plus existing adapter-backed Claude sessions; the router cannot retroactively identify every old native GPT chat. Private app features outside Responses, WebSockets, and voice are not certified through the gateway. Browser/voice/app-specific surfaces are not certified by the coding-tool tests.

See [PLAN.md](PLAN.md) for the verification record and remaining boundaries.
