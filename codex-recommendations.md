# Codex / Claude Refactor Recommendations

## Bottom line

Keep the Codex App Server path. It is not the architectural problem; it is the mechanism that makes Codex push possible today.

One `codex app-server` process can host many separate Codex threads. That is not “all sessions are one session”. It is one server process hosting many conversations, the same way a database process can host many connections. The real problem in this codebase is duplicated state, polling, and launcher drift.

Given the hard requirement of push delivery, do **not** spend time trying to replace the current Codex path with pure MCP. As of 2026-03-30, the Claude side has real channel push, while the Codex side still needs the App Server bridge workaround.

## Keep vs delete

Keep:

- `llmmsg-channel/hub.mjs` as the single message router
- `llmmsg-channel/channel.mjs` for Claude Code push delivery
- the Codex App Server + `--remote` model for Codex push delivery
- wrapper scripts as launch UX, not as places that own business logic

Delete in a hard cut:

- `codex-llmmsg-app/registrations.json`
- `codex-llmmsg-app/bridge-state.sqlite`
- `poll_state` from `scripts/init-db.sh`
- `last_id` and `delivered_id` cursor semantics
- direct DB writes from `scripts/llmmsg-cli.py`
- thread lookup against `~/.codex/state_5.sqlite` in `cf.sh`
- stale packaging and docs that no longer match production behavior

## Recommended target architecture

### 1. Make the hub the only source of truth

Today state is split across:

- SQLite `roster`
- SQLite `cursors`
- `registrations.json`
- `bridge-state.sqlite`
- Codex internal `state_5.sqlite`

That is too much.

Replace it with one authoritative agent/session model in the main llmmsg DB, for example:

- `agents(agent PRIMARY KEY, platform, cwd, thread_id, status, registered_at, last_seen_at)`
- `messages(...)`
- `read_cursors(agent PRIMARY KEY, read_id)`
- `aros(...)`

If you are willing to hard cut, rename `roster` to `agents` and rebuild the DB.

### 2. Preserve push, but remove polling

The Claude path already works the right way:

- `channel.mjs` connects to hub SSE
- hub pushes messages immediately
- Claude receives a real pushed event

The Codex path should mirror that:

- bridge subscribes to hub push instead of polling SQLite every 2 seconds
- bridge keeps a persistent WebSocket client to the App Server
- on incoming hub event, bridge sends `turn/start` to the mapped Codex thread immediately

The bridge should become an SSE-to-App-Server relay, not a DB poller.

### 3. Registration must be unified

Current split:

- Claude sessions register via hub `/register`
- Codex sessions register via `bridge.mjs register`

That split is the root of several problems. Codex agents can receive through the bridge but are not first-class in the hub roster model.

Hard-cut recommendation:

- all session registration goes through the hub
- hub stores `thread_id` for Codex agents
- bridge reads active Codex sessions from the hub, not from `registrations.json`

Then `cf.sh`, `cfn.sh`, `ccs.sh`, and `ccsn.sh` all become simple launchers that export metadata and call one registration path.

## Script-specific recommendations

### `cf.sh`

What is good:

- it enforces `--remote`, which is required for Codex push
- it resumes the right thread by cwd/label
- it registers the remote session with the bridge

What should change:

- stop reading `~/.codex/state_5.sqlite`; use the App Server RPC only
- stop mutating `~/.codex/config.toml` on launch
- move all reusable logic into a shared shell library

The core idea of `cf.sh` is correct. The implementation is too coupled to Codex internals.

### `cfn.sh`

This is currently incomplete for a push-based system. It launches Codex remotely, but unlike `cf.sh`, it does not register the session for bridge delivery. In a push-first architecture, `cfn.sh` must participate in registration too.

### `ccs.sh`

What is good:

- it sets `LLMMSG_AGENT` and `LLMMSG_CWD`
- it standardizes permissions and title behavior
- it gives Claude sessions a stable session identity

What should change:

- stop swallowing Claude stderr with `2>/dev/null`
- share launcher logic with `ccsn.sh`
- if `LLMMSG_AGENT` is present, `channel.mjs` should auto-register on startup instead of relying on the model to call `register`

### `ccsn.sh`

This should differ from `ccs.sh` only in “resume vs fresh” and optional logging. Right now it is a second copy of the launcher logic. Merge the common behavior.

## Claude-side recommendations

### 4. Auto-register Claude sessions

`ccs.sh` and `ccsn.sh` already export agent identity. `channel.mjs` should use that and register automatically on startup. Manual registration through the MCP tool should be only a fallback, not the normal path.

Also fix the current `unregistered` collision in `channel.mjs`: multiple unregistered sessions all connect as `unregistered`, so they overwrite one another in the hub map.

### 5. Keep Claude channels simple

Do not add Codex-specific complexity to the Claude path. The Claude side is already the clean side of the architecture:

- stdio MCP server
- SSE subscription
- native pushed event delivery

The main Claude-side work is cleanup, not redesign.

## Codex-side recommendations

### 6. Keep the App Server, simplify the bridge

The shared App Server is acceptable. The issue is not “many Codex sessions under one server”; the issue is that the bridge reconnects constantly and keeps separate state files.

Recommended hard cut:

- one persistent bridge daemon
- one persistent App Server RPC client
- one hub subscription per registered Codex agent, or one multiplexed hub stream if you redesign the hub protocol
- no per-cycle reconnects
- no separate bridge DB

### 7. Thread binding should use public RPC, not private SQLite

`cf.sh` should not inspect Codex’s internal `state_5.sqlite`. That is an implementation detail. Use App Server methods to list and inspect loaded threads, then bind the agent to the selected thread.

### 8. Treat thread ID as session routing state

For Codex push, the critical piece of state is `thread_id`. Put it in the main DB next to the agent registration. That keeps the routing model explicit:

- agent name = address
- thread ID = Codex delivery target

## DB and API recommendations

### 9. Use one cursor: `read_id`

You do not need three cursor concepts plus a bridge cursor.

Keep:

- `read_id`

Delete:

- `last_id`
- `delivered_id`
- bridge-local delivery cursor

Push delivery is best-effort transport. The only state that matters is whether the receiving side has acknowledged reading through a single cursor model.

### 10. All writes go through the hub

`scripts/llmmsg-cli.py` should stop writing directly to SQLite for send/register/read flows. Route those through the hub so that push, cursor updates, and validation all happen in one place.

If you want a local admin CLI, keep direct DB access only for read-only diagnostics.

### 11. Remove schema duplication

Right now the schema is defined in both:

- `scripts/init-db.sh`
- `llmmsg-channel/hub.mjs`

That guarantees drift.

Pick one:

- either SQL migrations under version control
- or a single canonical schema script

Then make the hub fail fast if the DB is missing or outdated.

## Packaging, docs, and operational cleanup

### 12. Fix stale repository metadata

Current mismatches:

- both `package.json` files declare `"type": "commonjs"` while the runtime entrypoints are `.mjs`
- `codex-llmmsg-app/package.json` still references `./start-app-server.sh`
- `codex-llmmsg-app/README.md` still points at old paths outside `/opt/llmmsg`

Those should be fixed immediately. They create false information for future maintenance.

### 13. Add integration tests for the only thing that matters: push

Test these flows automatically:

1. Claude agent A sends to Claude agent B and B receives push
2. Claude agent sends to Codex agent and Codex thread gets `turn/start`
3. Codex agent sends to Claude agent and Claude receives push
4. broadcast and `aro:` fan-out
5. restart hub / restart bridge / restart app-server recovery

Without those tests, every refactor risks silently breaking the only feature that justifies the system.

### 14. Add explicit architecture docs

Document one clear statement:

“Codex uses App Server + bridge because Codex MCP alone does not provide native inbound channel push.”

That should be in the main architecture doc so future refactors do not waste time trying to remove the wrong piece.

## Suggested implementation order

1. Hard-cut the schema and registration model.
2. Rewrite the bridge as hub-push -> persistent App Server relay.
3. Refactor `cf.sh` and `cfn.sh` to use the new registration path and App Server RPC only.
4. Auto-register Claude sessions from `channel.mjs`; keep `register` as fallback.
5. Merge launcher common code across `cf.sh`, `cfn.sh`, `ccs.sh`, and `ccsn.sh`.
6. Move CLI mutations behind hub APIs.
7. Fix packaging, README, and tests.

## Recommended final shape

If I were hard-resetting this repo, I would aim for this:

- one DB
- one hub
- one Claude channel server
- one Codex bridge daemon
- one registration model
- one cursor model
- one launcher library shared by Claude and Codex wrappers
- zero direct DB mutation outside the hub
- zero dependence on Codex internal SQLite files

That preserves the only feature that matters, push, while removing nearly all of the accidental complexity that has grown around it.

---

## Claude Code Says

Reviewed against the actual source code. Only disagreements, corrections, and additions.

### Disagreements

- **#2 "rename `roster` to `agents`"** — the name change adds nothing. `roster` is already clear and used consistently across hub, CLI, and channel.mjs. Renaming forces changes in every file for zero functional gain. Add `thread_id`, `platform`, `last_seen_at` columns to `roster` — don't rename it.

- **#3 "one persistent App Server client"** — risky. If the single WebSocket dies, all Codex agents lose delivery until reconnect. One connection per agent means a failure isolates to that agent. The overhead of multiple WebSocket connections to localhost is negligible. The real waste is the connect/disconnect per poll cycle, not the number of connections.

- **"stop mutating `~/.codex/config.toml` on launch" (cf.sh section)** — the mutation is a guard, not a config rewrite. Lines 6-9 only append `[tui]\nterminal_title = []` if the `[tui]` section doesn't exist. Without it, Codex overwrites the terminal title on every keystroke, making the title-keeper loop pointless. Moving this to a "one-time setup step" means every new machine or config reset silently breaks title behavior. The guard is cheap and correct.

- **"shared launcher library" (#5, cf.sh section, implementation order #5)** — mentioned three times but the overlap is smaller than implied. `ccs.sh` and `cf.sh` share: label parsing, title setting, terminal clamping. That's ~15 lines. They differ on: session logging (ccs.sh only), system prompt injection (ccs.sh only), channel loading (ccs.sh only), thread lookup (cf.sh only), bridge registration (cf.sh only), app server health check (cf.sh only), Termux proot (ccs.sh only). Extracting the shared bits into a library creates a dependency between CC and Codex launchers that currently don't need to know about each other. Not worth it unless the shared logic grows.

- **#13 "add integration tests"** — the five test scenarios listed require a running hub, a running app server, a running bridge, and a live Codex session accepting `turn/start`. That's not an integration test — it's a full system test requiring four daemons. More practical: test hub endpoints with curl against a temp DB, test bridge delivery with a mock WebSocket server. The document skips this and jumps straight to end-to-end.

### Corrections

- **"both `package.json` files declare `"type": "commonjs"` while the runtime entrypoints are `.mjs`"** — this is flagged as a problem but it isn't one. Node treats `.mjs` as ESM unconditionally regardless of the `type` field. The actual metadata issues are: `llmmsg-channel/package.json` has `"main": "index.js"` (doesn't exist) and `codex-llmmsg-app/package.json` references `./start-app-server.sh` (deleted). Fix those, but the `commonjs`/`.mjs` mismatch is cosmetic.

- **"stop swallowing Claude stderr in `ccs.sh`"** — the `2>/dev/null` at ccs.sh:224 is only on the continue-mode attempt: `claude -c ... 2>/dev/null || exec claude ...`. It suppresses the error when there's no session to continue, then falls through to a fresh session. This is deliberate error handling for an expected failure, not hidden debugging. The `exec` fallback on line 225 does not suppress stderr.

- **#7 "thread binding should use public RPC, not private SQLite"** — correct in principle, but the document doesn't acknowledge the timing problem. `cf.sh` needs the thread ID *before* launching Codex (to pass to `bridge.mjs register`). The App Server RPC only works *after* Codex has loaded the thread. That's why cf.sh currently reads `state_5.sqlite` for `resume` (pre-launch) and the registration retry loop (lines 79-89) exists for new sessions (post-launch). Moving to RPC-only means registration must always be post-launch, which is already what the retry loop does. The `find_latest_thread_id` function and the `resume` codex command using that ID would need a different flow.

### Missing

- **No mention of the hub's `pollForDirectWrites` loop (hub.mjs:146-163).** The hub polls its own DB every 2 seconds to catch messages written directly via CLI. If recommendation #10 (all writes through hub) is implemented, this poll loop becomes dead code. It should be explicitly listed for removal.

- **No mention of `broadcastToChannels` double-writing the cursor.** `sendMessage` (hub.mjs:187-204) calls `sendToChannel` or `broadcastToChannels`, both of which call `stmtUpsertDeliveredCursor`. Then `sendToChannel` is also called from `pollForDirectWrites`, which does its own cursor write. For a broadcast to 5 agents, that's 5 cursor upserts in the same transaction. If `delivered_id` is dropped per recommendation #9/#1, these writes disappear — but the document doesn't connect these dots.

- **No mention of the `re` field's lack of validation.** Any agent can set `re` to any tag, including tags from conversations they weren't part of. The hub doesn't verify the sender has access to the referenced thread. In a multi-project environment with aros, this means an agent in project A can reply to a thread in project B. May not matter today, but worth noting if the system grows.

- **No mention of message size limits.** The hub accepts any body size. A single `POST /send` with a 50MB body would work. The hub parses it, stores it, and pushes it over SSE. No validation, no cap. Worth adding a `MAX_BODY_BYTES` check at ingress.

- **No retention/cleanup recommendation.** The `messages` table grows without bound. `ccs.sh` has a systemd timer rotating its session log DB (90-day retention). The main message DB has nothing. This is the most operationally relevant missing item — a table that only grows will eventually degrade SQLite performance, especially with the analytics views doing full scans.
