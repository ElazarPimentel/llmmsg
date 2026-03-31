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
