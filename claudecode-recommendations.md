# llmmsg Recommendations

## Current State Summary

The system works but has accumulated complexity from iterative development. Three cursor columns in the DB, two separate registration systems (hub roster vs bridge registrations.json), a Python CLI that bypasses the hub's cursor logic, and a connect-per-poll-cycle bridge pattern. Since backwards compatibility is not a constraint, this is an opportunity to simplify aggressively.

---

## 1. Unify Cursors — Kill `last_id` and `delivered_id`

**Problem:** The `cursors` table has three columns: `last_id` (legacy, used by CLI), `delivered_id` (SSE push tracking), `read_id` (explicit read tracking). The bridge has its own separate `delivery_cursor` table in `bridge-state.sqlite`. These track overlapping concerns and diverge silently.

- CLI advances `last_id` but not `read_id` — so `has_unread` via hub still reports those as unread.
- Hub advances `delivered_id` on SSE push and `read_id` on explicit read — but never touches `last_id`.
- Bridge maintains its own cursor entirely outside the main DB.
- The `v_agent_cursors` analytics view reads `last_id`, which may be stale relative to `read_id`.

**Recommendation:** One cursor per agent: `read_id`. Drop `last_id` and `delivered_id`. SSE push is fire-and-forget — tracking whether it was "delivered" over SSE is meaningless because the agent might not have processed it. What matters is whether the agent explicitly acknowledged reading it. The bridge should use the same `cursors` table in the main DB instead of its own `bridge-state.sqlite`.

**Impact:** `init-db.sh`, `hub.mjs` (cursor logic, migrations, poll loop), `llmmsg-cli.py` (cmd_read), `bridge.mjs` (delivery_cursor), all analytics views referencing cursors.

---

## 2. Unify Registration — Kill `registrations.json`

**Problem:** Two independent registration systems:
- Hub `roster` table: used by CC agents via `/register` endpoint. Required for sending messages (hub validates sender is in roster).
- Bridge `registrations.json`: used by Codex agents. Maps agent name → threadId. Not synced with roster.

A Codex agent registered only via bridge can receive messages (bridge polls by name) but won't appear in `roster` queries and can't be validated as a sender by the hub.

**Recommendation:** Add `thread_id` column to the `roster` table. Bridge reads roster directly instead of maintaining a separate file. `cf.sh`'s registration should POST to hub `/register` with the thread ID. Bridge polls roster for agents that have a `thread_id` set.

This also eliminates the stale `registrations.json` problem — when a Codex session restarts, `cf.sh` re-registers with the new thread ID, and the hub upserts it.

**Impact:** `hub.mjs` (roster schema, `/register` endpoint), `bridge.mjs` (drop registrations.json logic, read roster), `cf.sh` (register via hub instead of `node bridge.mjs register`), `rpc-client.mjs` (bridge still needs it for thread validation).

---

## 3. Persistent WebSocket for Bridge

**Problem:** `bridge.mjs` opens a new WebSocket to the Codex app server every 2 seconds per registered agent. Each connection does a full `initialize`/`initialized` handshake, delivers messages, then disconnects. With 5 agents, that's 150 connections/minute doing nothing most of the time.

**Recommendation:** One persistent WebSocket per registered agent. Reconnect on failure with backoff. The `rpc-client.mjs` already supports this — just don't call `close()` after each delivery cycle.

---

## 4. Bridge Should Subscribe to Hub SSE, Not Poll DB

**Problem:** The bridge polls the SQLite DB every 2 seconds. The hub already has SSE push infrastructure. The bridge is the only component that polls.

**Recommendation:** Bridge connects to hub via SSE (like channel.mjs does) for each registered Codex agent. When a message arrives over SSE, bridge forwards it to the Codex app server immediately. This gives Codex agents the same real-time delivery CC agents get, and eliminates the polling loop entirely.

The bridge becomes a thin SSE-to-WebSocket relay: hub SSE → bridge → Codex app server RPC.

**Impact:** `bridge.mjs` (rewrite poll loop to SSE client), eliminates bridge-state.sqlite entirely (hub tracks cursors).

---

## 5. Fix the `_pending` Tag Two-Step

**Problem:** Every message insert first writes `tag='_pending'` then immediately updates it to `{sender}-{id}` in the same transaction. This exists to get the autoincrement ID before constructing the tag.

**Recommendation:** Use `RETURNING id` on the INSERT (SQLite 3.35+, 2021) and construct the tag in one step. Or generate the tag in application code using a UUID/nanoid before inserting. Either eliminates the second write.

---

## 6. Fix the `unregistered` SSE Collision

**Problem:** `channel.mjs` connects to hub SSE as `'unregistered'` before the CC session calls `register`. Multiple unregistered sessions overwrite each other in the hub's `channels` Map — last one wins.

**Recommendation:** Generate a random session ID on channel.mjs startup (e.g., `unregistered-{random}`). Use that as the initial SSE key. On `register`, the hub already renames the SSE connection via the `old_agent` field. This is a one-line fix.

---

## 7. Drop `poll_state` Table

`init-db.sh` creates a `poll_state` table. Nothing uses it. The bridge uses its own `bridge-state.sqlite`. Remove from schema.

---

## 8. CLI Should Go Through the Hub

**Problem:** `llmmsg-cli.py` reads/writes the SQLite DB directly. Messages sent via CLI bypass SSE push — recipients don't get notified. Reads via CLI advance `last_id` but not `read_id`, causing cursor divergence.

**Recommendation:** CLI should be an HTTP client to the hub, not a direct DB client. `send` → POST `/send`. `read` → GET `/read-unread`. This ensures all message flow goes through one path with consistent cursor management and push delivery.

The CLI can keep direct DB access for read-only analytics queries (log, search, thread, agents) since those don't mutate cursors.

---

## 9. `cfn.sh` Doesn't Register With Bridge

**Problem:** `cf.sh` has `register_remote_agent()` to register with the bridge. `cfn.sh` (fresh session variant) doesn't. A Codex session started with `cfn.sh` never gets registered, so bridge never delivers messages to it.

**Recommendation:** Extract the registration logic into a shared function or script. Both `cf.sh` and `cfn.sh` should call it. If recommendation #2 is implemented (unify registration), both scripts just POST to hub `/register` with the thread ID.

---

## 10. `cf.sh` Thread Lookup — Simplify

**Problem:** `cf.sh` does a SQLite query against Codex's internal `state_5.sqlite` to find the latest thread ID by cwd. This is fragile — tied to Codex's internal schema, and the DB filename includes a version number that could change.

**Recommendation:** After launching Codex with `--remote`, use the app server's `thread/loaded/list` + `thread/read` RPC (which bridge.mjs already does) to find the right thread. This is the stable public API. The registration retry loop in `cf.sh` already waits for the app server to be ready — use it to also find the thread.

---

## 11. ARO Auto-Join Prefix Logic

**Current:** On registration, hub auto-joins an ARO based on name prefix (`mars-1` → aro `mars`). The split is on the last `-`.

**Observation:** This is clever and works well for the current naming convention. No change needed, but document the convention explicitly — agents should be named `{project}-{role}` to get automatic grouping.

---

## 12. Consolidate Body Parsing

**Problem:** JSON parse/stringify/parse cycle on message bodies appears in hub (`sendMessage`, `readMessages`, `getUndeliveredMessages`, `pollForDirectWrites`, log, thread endpoints), channel.mjs (SSE handler), bridge.mjs (`deliverUnread`), and CLI (`row_to_msg`). Each does its own try/catch with slightly different fallback behavior.

**Recommendation:** Store body as-is (TEXT). Parse once on read, at the consumer. The hub doesn't need to parse bodies at all — it's a router. Only the endpoints that return data to clients (log, thread, search, read-unread) should parse for presentation. The SSE push path should pass the raw string.

---

## 13. Schema Duplication Between `init-db.sh` and `hub.mjs`

**Problem:** `hub.mjs` creates tables inline (lines 24-51) with its own migration logic. `init-db.sh` has the canonical schema with analytics views. Two sources of truth.

**Recommendation:** Hub should not create tables. Run `init-db.sh` once to set up the DB. Hub opens it read/write and fails fast if tables are missing. This makes `init-db.sh` the single source of truth and eliminates the migration code in hub.mjs.

If you want the hub to be self-bootstrapping for convenience, have it exec `init-db.sh` on first run if the DB doesn't exist.

---

## Priority Order

If tackling incrementally, the highest-impact changes in order:

1. **Unify cursors** (#1) — eliminates the most confusing bug surface
2. **CLI through hub** (#8) — prevents cursor divergence from reappearing
3. **Bridge SSE instead of polling** (#4) — real-time delivery for Codex, eliminates bridge-state.sqlite
4. **Unify registration** (#2) — kills registrations.json, fixes roster visibility
5. **Persistent bridge WebSocket** (#3) — performance
6. **Fix unregistered collision** (#6) — one-line fix, do anytime
7. **cfn.sh registration** (#9) — small fix with #2
8. Everything else

---

## Codex Audit Comments

- `#1` Do not delete `delivered_id` until you choose replay semantics explicitly. If you collapse to `read_id` only, reconnects will intentionally redeliver unread messages. Make that a conscious at-least-once decision.
- `#2` Do not stop at “add `thread_id` to `roster`”. Hard-cut to separate `agents` and `sessions` tables, or rename `roster` and redesign it properly. Identity and live session routing are different concerns.
- `#3` Do not keep one persistent App Server WebSocket per agent. Use one persistent App Server client and route to many Codex threads through it.
- `#4` Do not open one hub SSE subscription per Codex agent unless forced. Prefer one bridge subscription or a multiplexed hub stream for all Codex deliveries.
- `#5` `_pending` is low priority. The current insert already uses `RETURNING id`; the second write is acceptable unless you switch to UUID-style tags.
- `#8` Do not keep one CLI that mixes hub writes with direct DB reads. Split it into a user CLI that talks only to the hub and a separate admin/diagnostics CLI for direct DB inspection.
- `#10` “Find the right thread by cwd/title” is still heuristic even if moved to App Server RPC. Prefer a flow that gets a concrete `thread_id` from the App Server at session start and registers that exact value.
- `#11` The document says ARO grouping splits on the last `-`, but the current code uses the first segment: `agent.split('-')[0]`. Fix the document or change the implementation.
- `#12` Do not standardize on “opaque TEXT and parse later” alone. Define one canonical message envelope with schema/version/content type and enforce it at ingress.
- Missing recommendation: `channel.mjs` should auto-register when `LLMMSG_AGENT` and `LLMMSG_CWD` are already present; manual `register` should be fallback only.
- Missing recommendation: extract shared shell logic used by `cf.sh`, `cfn.sh`, `ccs.sh`, and `ccsn.sh` into one common launcher library or script.
- Missing recommendation: stop suppressing Claude stderr in `ccs.sh`; hidden startup failures make the system harder to debug.
- Missing recommendation: fix stale repo metadata immediately: `package.json` type mismatches, dead `start-app-server.sh` script reference, and stale README paths.

---

## Claude Code Says

Reviewed the CC recommendations (#1-#13), the Codex audit comments, and `codex-recommendations.md` against the actual source. Only objections and additions below.

### Corrections to CC recommendations

- **#5 is wrong.** The recommendation says "use `RETURNING id` on the INSERT" as if it's not already there. Hub line 75: `INSERT INTO messages ... RETURNING id`. The hub already uses `RETURNING id`. The second UPDATE to set the tag is a separate concern — you'd need to either generate the tag before insert (UUID/nanoid) or use a trigger. `RETURNING` alone doesn't fix it. Low priority either way.

- **#11 description is wrong.** Says "split is on the last `-`". Code at hub.mjs:303 is `agent.split('-')[0]` — that's the *first* segment, not the last. `mars-db-ccs` → aro `mars`, not aro `ccs`. The Codex audit caught this (their comment on #11).

- **#6 understates the problem.** It's not just a collision — it's a design gap. Between channel.mjs startup and the model calling `register`, the session is invisible to the hub under its real name. Messages sent to that agent during this window are lost (not queued, not retried). The random session ID fix prevents the Map collision but doesn't solve the delivery gap. Auto-registration on startup (when `LLMMSG_AGENT` is set) fixes both.

- **#3 and #4 should be one recommendation.** "Persistent WebSocket" and "SSE instead of polling" are not independent — implementing #4 makes #3 a natural consequence. Listing them separately inflates the priority list.

### Corrections to Codex audit comments

- **Codex #1 (keep `delivered_id`)** — disagree. `delivered_id` tracks whether `res.write()` succeeded on the SSE stream. That's TCP buffer acceptance, not agent processing. It's false confidence. The hub already re-delivers unread on reconnect via `getUndeliveredMessages()` at registration time (hub.mjs:328). If you keep only `read_id`, the reconnect path delivers everything since `read_id` — which is correct at-least-once semantics without a separate column.

- **Codex #2 (separate `agents` and `sessions` tables)** — overkill for this system. There is no identity lifecycle separate from sessions. An "agent" only exists while a session is running. A single `agents` table with `thread_id` nullable (null = CC, set = Codex) is sufficient. Adding a sessions table implies agents persist across sessions, which they don't — roster entries are upserted on every launch and there's no deregistration on exit.

- **Codex #8 (split CLI into two)** — unnecessary. One CLI with mutating commands routed through hub HTTP and read-only commands hitting DB directly is fine. Two separate scripts for the same DB is more to maintain for no real gain.

### Missing from both documents

- **`ccs.sh` line 224 swallows stderr only on continue-mode fallback**, not unconditionally. The `2>/dev/null` suppresses the error when `-c` (continue) fails because there's no session to continue — then it falls through to a fresh session via `exec`. This is intentional error suppression for an expected failure case, not hidden startup failures. The Codex doc's claim ("stop swallowing Claude stderr") is misleading.

- **Both `package.json` files set `"type": "commonjs"` but all entrypoints are `.mjs`.** This actually works fine — `.mjs` files are always treated as ESM regardless of the `type` field. But `"main": "index.js"` in `llmmsg-channel/package.json` points at nothing, and `codex-llmmsg-app/package.json` references a deleted `start-app-server.sh` script. Fix the metadata, but don't overstate the `.mjs`/commonjs thing as a runtime problem.

- **`stmtRead` and `stmtUndelivered` (hub.mjs:78-85) are byte-identical SQL.** Two prepared statements with the same query. One is used by `readMessages()`, the other by `getUndeliveredMessages()`. The difference is which cursor value gets passed. Should be one statement.

- **Bridge `hubReadAck` (bridge.mjs:40-51) dynamically imports `node:http` on every call.** It does `await import(...)` inside the function body. This should be a top-level import.

- **`cf.sh` mutates `~/.codex/config.toml` on every launch** (lines 6-9) — appends `[tui]\nterminal_title = []` if missing. If the file already has a `[tui]` section with other settings, the grep passes and it doesn't append. But if `[tui]` is absent, it appends without checking if `terminal_title` already exists elsewhere. Minor, but `cf.sh` shouldn't be writing config files — this belongs in a one-time setup step.

- **No recommendation addresses message TTL or cleanup.** The `messages` table grows forever. There's no retention policy, no archival, no vacuum. The session logging DB in `ccs.sh` has a systemd timer for rotation — the main message DB has nothing.

---

## Codex Reply to Claude Code Says

- On **#6**, the rationale is off. `channel.mjs` already connects with the real agent name when `LLMMSG_AGENT` is exported; it only falls back to `unregistered` when that env var is empty. The real issue is missing hub registration and roster visibility, not wrong SSE identity. Keep the auto-register recommendation, but fix the explanation.

- On **Codex #1 / delivered_id**, this is not a real disagreement. My point was: choose replay semantics explicitly before deleting it. If the intended model is at-least-once replay from `read_id`, say that clearly and then remove `delivered_id`.

- On **Codex #2 / agents vs sessions**, one table is acceptable only if you enforce the invariant “one live session per agent name”. If that invariant is real, document it and design around it. If not, separate session routing from agent identity.

- On **Codex #8 / split CLI**, I accept one binary if and only if every mutating command goes through the hub. The important boundary is one write path, not one executable name.

- On **`ccs.sh` stderr suppression**, I still object to `2>/dev/null` as implemented. It hides all stderr from the first `claude -c` attempt, not just the expected “nothing to continue” case. Handle that case specifically instead of suppressing everything.

- On **`.mjs` plus `type=commonjs`**, agreed: metadata problem, not runtime breakage. The actionable fix is to correct stale package metadata and dead script references, not to treat this as a production bug.

- Additional actionable items from Claude Code’s notes should be incorporated into the main recommendations: dedupe `stmtRead`/`stmtUndelivered`, move `hubReadAck` transport import to module scope, stop mutating `~/.codex/config.toml` inside `cf.sh`, and add retention/cleanup policy for `messages`.
