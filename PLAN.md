# Claude subscription adapter: implementation record

Implemented for a Claude Max subscription. The macOS login service is installed. The updated configuration selects the mixed subscription router. Restart the desktop app after refreshing catalog metadata. Existing adapter-backed chats can continue.

## Architecture

```text
Codex UI / app server → local Responses adapter → official Claude Agent SDK
        ↑                         ↓                         ↓
        └──── Codex tool call/result ← SDK custom MCP tool ← Claude subscription

GPT requests → local gateway → OpenAI backend using Codex's ChatGPT login
```

`src/protocol.ts` owns wire validation, schemas, namespaces, metadata, and SSE. `src/session.ts` owns subscription checks, SDK sessions, asynchronous tool handoff, cancellation, and persistence. `src/server.ts` owns loopback HTTP, local authentication, request limits, and context-window routing. `src/gateway.ts` owns native OpenAI forwarding, the mixed catalog, and durable provider locks. `scripts/setup.ts` owns the LaunchAgent and reversible configuration changes.

The SDK has no built-in execution tools. A custom MCP handler emits a Responses call and waits until Codex returns its result in the next request. No token extraction, Anthropic impersonation, proxy aggregator, app-binary patch, or hosted service is involved.

## Verified October 8, 2026

| Boundary | Evidence |
| --- | --- |
| Subscription | Refreshed supported Claude login; SDK identifies first-party Max subscription and rejects API-key routes before accepting a prompt |
| Opus tool loop | Real Codex → SDK → Claude Opus 5.5 → Codex shell → returned file marker |
| Sonnet tool loop | Same live read-file round trip on Claude Sonnet 5.5 |
| Follow-up / edit | Resumed Opus chat remembers earlier marker, accepts changed sandbox instructions, writes a scratch file through Codex, and reads it back |
| Web research | An ordinary search failed with guessed connector arguments; reading its declaration and using `system2_search_query` succeeded. Shared prompt guidance now identifies the existing connector and requires schema discovery. Live Haiku search and Opus search/open passed; no SDK web tools or credentials were added. |
| Codex subagents | Real CLI spawn/wait passes with fresh and inherited context, including two concurrent children and mid-turn completion notifications; regression tests reproduce and prevent shared-session collisions and notification 409 errors |
| Claude model switching | Opus → Sonnet → Haiku → Fable retained the original random marker in one live chat; live Haiku → Sonnet switching during tool handoff retained an image result. Regression checks cover persisted resume and waiting for SDK cleanup |
| Manual fork | Native `thread/fork` through the bundled app server preserves the selected turn’s marker, excludes later parent turns, and resumes independently on follow-up |
| Stop and recovery | Native `turn/interrupt` followed by another message succeeds in the same chat and retains the original marker. Local checks cover crashed sessions, edited user history, permission changes, and replacing a pending tool turn |
| Images | All four models identify embedded image input. Native Codex attachment plus `view_image` tool-result test passes. Fork translation keeps image pixels out of the serialized text history |
| Restart | Completed session persists and resumes through a new adapter process |
| Large context | Exact early/late UUID retrieval at 500,468 and 850,474 input tokens, measured by Claude usage events |
| Compaction | Forced Codex threshold at 5K; marker survives compaction and tool calls, including a compaction between a tool result and final answer |
| Model catalog | Desktop-bundled app server 0.162.0-alpha.2 returns exactly four Claude and three GPT models, including native GPT speed tiers, through `model/list` |
| Installation | Updated LaunchAgent serves authenticated health check; saved provider selects the subscription router; desktop-bundled CLI successfully uses GPT-6 Luna through the actual global configuration |
| Local checks | Type checking and twenty-seven checks cover namespaces, HTTP/MCP handoff, session isolation/resume, compaction, provider restoration, auth rejection, cancellation, late cache accounting, and environment isolation |

Use `npm run context-check -- 250000` or `425000` to repeat the long-context check. The argument counts synthetic filler words, not tokens; this consumes subscription allowance. Normal checks use `npm run check`, `npm test`, and `npm run doctor`.

## Boundaries still requiring verification

- Actual GUI picker, app restart, and a task submitted through the GUI: the computer-use tool refused access to `com.openai.codex`.
- Full 1M boundary, long-context Sonnet/Haiku/Fable, concurrency under load, and subscription exhaustion in a live account.
- Audio, full browser/computer interaction workflows beyond screenshot transport, voice/cloud tasks, and GPT-specific background features. Cross-provider inference is deliberately blocked within chats.
- Recovery cannot infer whether an external action with no recorded result completed. It supplies that uncertainty to the model instead of automatically reissuing the call. Newly connected tools enter the next user turn.

## Sources and decisions

- [Anthropic subscription guidance](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): use supported SDK subscription authentication.
- [Opus migration guide](https://platform.claude.com/docs/en/models/opus-5-5/migration-guide) and [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking): keep model reasoning in the SDK; never reconstruct or edit signed thinking blocks.
- [Sonnet 5.5 specification](https://platform.claude.com/docs/en/models/sonnet-5-5/overview): native 1M window; actual subscription model availability was also checked through the SDK.
- [Codex gateway contract](https://learn.chatgpt.com/docs/enterprise/gateway-compatibility): Responses and SSE tool round trips.
- [Desktop gateway configuration](https://learn.chatgpt.com/docs/enterprise/connect-to-a-gateway): custom provider in config.toml and app restart.
- Codex `rust-v0.160.0` source confirms `x-codex-turn-metadata` contains structured request kind and context window number. Compaction receives its own session; the next context window imports Codex’s summarized visible history.

Compatibility fixes are committed directly to `main`. No pull request was created. The README owns usage and recovery instructions.

## Combined picker update

Added Haiku 5.5 and Fable 5.1; both passed subscription authentication and live Codex tool round trips. GPT-6.1 Sol, GPT-6 Astra, and GPT-6 Luna passed real requests through the gateway with priority/Fast requested. The desktop-bundled app server (now 0.162.0-alpha.2) returns precisely seven visible entries and the original GPT Fast/Ultrafast metadata. The test client was refused when switching a GPT thread to Claude. Provider locks are durable across restarts and independent of context windows.

The gateway follows [ChatGPT sign-in through a gateway](https://learn.chatgpt.com/docs/enterprise/sign-in-with-chatgpt-through-a-gateway): the local credential uses a separate header, and ChatGPT authorization is forwarded unchanged only to the fixed OpenAI backend. Claude authentication remains inside its SDK. Generated native catalog metadata and all credentials stay outside Git.

The UI picker itself is not disabled within chats: the local router rejects cross-provider inference requests before forwarding. This does not classify every historical native GPT chat before its first gateway request. WebSocket transport remains disabled; native private features outside Responses are unverified.

## Web-search guidance

When a capability is exposed only inside the exec runtime, Claude must discover the selected tool’s complete declaration before calling it. For web research, the prompt points to the existing Codex search connector when present. Known schemas require no rediscovery; tasks unrelated to web research require no search. This corrects argument guessing without changing permissions or routing search through another provider.

Guidance reviewed: [Haiku 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-haiku-5-5), [Opus 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5), [Sonnet 5.5](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-sonnet-5-5), and [Fable 5.1](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-fable-5-1). Live search validation covers Haiku and Opus; Sonnet/Fable use the same prompt but were not separately exercised for this change.

## Long-running jobs

The shared prompt favors one watcher for an existing job, keeps repeated progress out of model context, and reuses yielded process/cell IDs. A one-time status question still queries once. Codex retains execution, wait limits, and cancellation; no background wake capability is invented. This follows the [Opus 5.5 agentic-run guidance](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) and uses the installed [GitHub run watcher](https://cli.github.com/manual/gh_run_watch). Live Opus checks selected the watcher, one-time status query, and existing-process wait correctly; their commands were recorded, not executed against GitHub.

The SDK MCP timeout and pending-session retention share a 24-hour limit per tool call. The activity clock starts when a tool is dispatched, so time spent generating a response does not shorten the wait. Finished session metadata retains ten-minute idle cleanup; SDK processes have the shorter idle limit described below. A fake-clock HTTP/MCP regression reproduces the old eviction, then verifies a two-hour wait resumes the same SDK query, completed/cancelled sessions expire, and an abandoned pending call is eventually closed. The 24-hour boundary is simulated, not a day-long live run.

A live Opus 5.5 subscription check held one real MCP tool call for 660 seconds through an isolated HTTP adapter, crossing both former ten-minute limits. It returned the completion marker successfully through the same session, without issuing another model request while waiting. Other Claude models share this path but were not separately tested with eleven-minute waits.


## Streaming heartbeat and reconnection

Codex's SSE reader waits for parsed events, so comment-only keepalives did not reset its idle timer. The adapter now emits real progress events every 15 seconds, including while accepting a slow request. Recovery retains a disconnected response for 30 seconds and permits two reattachments to the same SDK query, with bounded event buffering and stable response/tool-call IDs. Request fingerprints sort object keys because Codex can reorder metadata during retries. When recovery is no longer possible, persisted user-history state requires a new message before rebuilding; cancelled queries ignore late SDK completion events.

Verification used the desktop-bundled Codex client with a synthetic SDK and an isolated HTTP adapter. A 35-second silent response reproduced the idle timeout with comment keepalives and completed with event heartbeats under a 20-second client idle limit. A second check executed a harmless append in a temporary directory, then forcibly dropped the connection after the tool result. Codex reconnected successfully with exactly one SDK query and one append. Local regression checks cover heartbeat parsing, slow admission, key reordering, unchanged tool-call IDs, concurrent/changed retry rejection, reconnection expiry, restart protection, manual continuation using completed results, and the replay memory cap. These checks do not establish the cause of upstream Fable latency or prevent laptop sleep.


## Portable first-time setup

`npm run setup` now defaults to installation. Its shared `check` preflight validates the existing Codex configuration/catalog and Claude subscription login before writing settings or installing the service. Preflight sends no model request and omits account details from errors. Existing hardcoded paths, port, service identifier, and missing-model rejection are unchanged. The README documents another user's first installation, direct-command path override, verification, updates, and removal.

An isolated subprocess check uses a temporary Codex home and a synthetic CLI path containing spaces. It verifies successful read-only preflight, rejected API-key login, logged-out/malformed/unavailable CLI errors, unchanged missing-model rejection, and a missing-config message. Actual second-Mac installation has not been verified.


## Live steering and thinking progress

When an HTTP reader disconnects and an appended user message arrives, the adapter retains the live SDK query if the model, instructions, and earlier user history match and no tool result is outstanding. It stops only the old reader, preserves queued SDK events, and submits only the added user input. Completed actions and results remain in the SDK session. Permission changes, edited history, and unresolved actions still take the existing recovery path. Finished user turns retain a bounded idle SDK process as described below.

The CLI can report zero queued turns before processing client-composed steering. The adapter requests user-message replay acknowledgments and tracks submitted message IDs so it waits for the steered response. Intermediate answers finish as commentary instead of merging into the final answer. Thinking deltas become Responses reasoning-summary events; signatures are omitted and redacted thinking emits only a generic marker.

Regression checks reproduce the former second SDK query and premature completion, then verify one query, one completed action, the steering acknowledgment, safety boundaries, reader handoff, thinking ordering, and response replay. An isolated live Opus check delivers a checkpoint result, disconnects, steers, and receives the new answer through one query with no repeated checkpoint. The bundled Codex client accepts reasoning as a separate item before the final answer. The graphical desktop reasoning panel has not been manually inspected.


## Idle process reuse

Keep at most three idle SDK processes for four minutes after their last completed turn. Active requests and pending tools are outside this idle allowance. Identical model, effort, instructions, and tools reuse the live input stream; only added user messages are submitted. Changed configuration closes the idle query and resumes the saved session with the current configuration. Expiry, eviction, and an idle SDK exit preserve the clean snapshot. No timer submits a prompt, and tools are rejected after completion until a new turn is accepted. Transient compaction sessions close immediately.

Thirty local checks pass, including simulated four-minute expiry, oldest-idle eviction without cancelling pending tools, configuration changes, model-switch shutdown ordering, and tool results across warm follow-ups. A real Opus subscription check completed one checkpoint tool through an isolated HTTP adapter, idled for 30 seconds, and completed a follow-up through the same query and child PID with exactly one tool action. Prompt, assistant-message, completion, and token-usage counts were unchanged during idle. RSS was 239–242 MiB and CPU time increased by 0.28 seconds while idle. The warm follow-up completed in 941 ms; this is one small request, not a general latency benchmark. Larger histories and the three-process memory total were not stress-tested; the four-minute expiry is covered by a simulated clock.

## Transient upstream HTTP failures

Setup previously disabled native HTTP request retries, making a single upstream 503 terminate the turn. It now enables eight request retries while leaving response-stream retries disabled. Codex owns retry timing and exhaustion; the adapter continues forwarding upstream errors and retry headers unchanged. This does not implement an indefinite pause or restart failed tasks in the background.

The desktop-bundled Codex 0.162.0-alpha.17.2 reproduced the exact connection-refused 503 against an isolated synthetic endpoint with the old configuration. With the new configuration it recovered from two 503s before a tool call and two after the tool result, finished the same turn, and appended to a temporary file exactly once. A one-second Retry-After header was respected. Persistent 503s stopped after nine total attempts; a 400 stopped after one. Type checking and all 30 tests pass. No live model requests were sent for these checks; the graphical desktop retry presentation and long outages were not tested. Existing installations must reload Codex after updating configuration.
