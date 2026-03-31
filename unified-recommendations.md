# Unified Recommendations — llmmsg

Agreed between Claude Code (llmmsg-ccs) and Codex (llmmsg-ca), 2026-03-31.

Backwards compatibility is not a constraint. Hard cuts are acceptable.

---

## Already Done

These items were implemented during the review process:

| Item | What | Version |
|------|------|---------|
| Auto-register | channel.mjs auto-registers on startup when `LLMMSG_AGENT` is set | channel.mjs v1.4 |
| Unregistered collision | Random suffix (`unregistered-{random}`) prevents SSE Map collisions | channel.mjs v1.4 |
| SSE close handler | Close handler checks `channels.get(agent) === res` before deleting | hub.mjs v1.9 |
| Unregister tool | MCP tool + hub endpoint to remove stale roster entries | hub v2.0, channel.mjs v1.5 |
| DB migration | Moved to `/opt/llmmsg/db/llmmsg.sqlite` | hub v2.0, all services |
| Thread map | `cf.sh` uses `thread_map` table in main DB instead of separate SQLite | cf.sh v2.2 |
| Push flag documented | `--dangerously-load-development-channels` requirement in CLAUDE.md | ccs.sh v3.7 |

---

## Agreed — To Implement

### 1. Unify Cursors

Keep only `read_id`. Drop `last_id` and `delivered_id`.

- Semantics: at-least-once replay from `read_id` on reconnect
- Bridge uses `cursors` table in main DB, kill `bridge-state.sqlite`
- Hub reconnect path delivers everything since `read_id`
- `pollForDirectWrites` uses `read_id` (or is removed per #7)
- Update `v_agent_cursors` view to use `read_id`

**Files:** hub.mjs, bridge.mjs, init-db.sh, llmmsg-cli.py

### 2. Unify Registration

Keep `roster` table name. Add columns: `thread_id` (nullable, set for Codex agents), `platform` (cc/codex), `last_seen_at`.

- **Invariant: one active session per agent name.** Document and enforce.
- Bridge reads roster for agents with `thread_id` set, instead of `registrations.json`
- `cf.sh`/`cfn.sh` register via hub `/register` with thread ID
- Delete `registrations.json`
- `thread_map` table stays as launcher bootstrap/history (cf.sh uses it to resume threads by agent+cwd). It is not a routing table — bridge does not read it. `roster.thread_id` is the live routing source for bridge delivery.
- `channel.mjs` register tool updated if `/register` accepts platform/thread metadata
- `cf-thread-map.mjs` remains for launcher use only; not affected by bridge changes

**Files:** hub.mjs (schema, `/register` endpoint), bridge.mjs, cf.sh, cfn.sh, init-db.sh, channel.mjs, cf-thread-map.mjs

### 3. Bridge: SSE + Persistent WebSocket

Rewrite bridge as an SSE-to-WebSocket relay:

- Bridge subscribes to hub SSE for each registered Codex agent (or one multiplexed stream — deferred to implementation)
- Bridge keeps persistent WebSocket(s) to Codex app server
- On incoming SSE event, bridge sends `turn/start` immediately
- Eliminates polling loop and `bridge-state.sqlite`
- One WS per agent vs one shared WS: **deferred to whoever implements the rewrite**

**Files:** bridge.mjs (rewrite), rpc-client.mjs

### 4. CLI Writes Through Hub

Mutating commands (`send`, `register`, `read`) go through hub HTTP API. Read-only commands (`log`, `search`, `thread`, `agents`, `roster`) stay as direct DB queries.

- `send` → POST `/send`
- `read` → GET `/read-unread`
- `register` → POST `/register`
- `retract` → new POST `/retract` endpoint on hub

**Files:** llmmsg-cli.py, hub.mjs (add `/retract` endpoint)

### 5. Remove `pollForDirectWrites`

Once CLI writes go through hub (#4), the hub's 2-second poll loop for direct DB writes becomes dead code. Remove it.

**Files:** hub.mjs

### 6. Add `re` Tag Validation

At send time, if `re` is provided, check that the tag exists: `SELECT 1 FROM messages WHERE tag = ?`. Reject with error if not found. Integrity validation only — no authorization model.

**Files:** hub.mjs (`/send` handler)

### 7. Schema: Single Source of Truth

Hub stops creating tables inline. `init-db.sh` is the canonical schema. Hub opens DB read/write and fails fast if tables are missing. `cf-thread-map.mjs` also stops auto-creating `thread_map` — the table must exist via `init-db.sh`.

Option: hub runs `init-db.sh` on first start if DB doesn't exist.

**Files:** hub.mjs (remove CREATE TABLE blocks), cf-thread-map.mjs (remove CREATE TABLE), init-db.sh

### 8. Drop `poll_state` Table

Unused. Remove from `init-db.sh`.

**Files:** init-db.sh

### 9. `cfn.sh` Registration

`cfn.sh` must register with the hub like `cf.sh` does. Trivial once #2 is done — both scripts POST to hub `/register` with thread ID.

**Files:** cfn.sh

### 10. ARO Auto-Join: Fix Documentation

Code uses `agent.split('-')[0]` (first segment). Document that agents should be named `{project}-{role}` for automatic ARO grouping. No code change.

**Files:** CLAUDE.md or docs/

### 11. Deduplicate Prepared Statements

`stmtRead` and `stmtUndelivered` are byte-identical SQL. Merge into one.

**Files:** hub.mjs

### 12. Fix `hubReadAck` Import

`bridge.mjs` dynamically imports `node:http` inside `hubReadAck()` on every call. Move to top-level import.

**Files:** bridge.mjs

### 13. Fix Package Metadata

- `llmmsg-channel/package.json`: change `"main": "index.js"` to `"main": "hub.mjs"`, change `"type": "commonjs"` to `"type": "module"`
- `codex-llmmsg-app/package.json`: remove dead `"app-server": "./start-app-server.sh"` script, change `"type": "commonjs"` to `"type": "module"`

**Files:** both package.json files

### 14. `ccsn.sh` Push Flag

`ccsn.sh` is missing `--dangerously-load-development-channels server:llmmsg-channel`. Without it, sessions launched via `ccsn.sh` get MCP tools but no push notifications. Add the flag (same as ccs.sh v3.7).

**Files:** ccsn.sh

### 15. Message Retention / Cleanup

Add a retention policy for the `messages` table. Options:

- Systemd timer (like ccs.sh session log rotation): delete messages older than N days, then VACUUM
- Or: archive to a separate table/file before deleting

Recommend 90-day retention with weekly timer, matching the ccs.sh pattern.

**Files:** new systemd timer + service, or a script in `scripts/`

### 16. Message Size Limit

Add `MAX_BODY_BYTES` check at hub ingress (`/send` handler). Reject bodies over the limit. Suggested: 1MB.

**Files:** hub.mjs

---

## Not Doing

| Item | Reason |
|------|--------|
| Rename `roster` to `agents` | Churn, no functional gain |
| Separate `agents` and `sessions` tables | Overkill — one active session per agent name is the invariant |
| Split CLI into two scripts | One CLI is fine if mutations go through hub |
| Shared launcher library (ccs/cf) | Only ~15 lines overlap, different concerns |
| `_pending` tag two-step fix | Low priority, current approach is safe |
| `cf.sh` config.toml mutation | Guard is cheap and prevents Codex title override |

---

## Implementation Order

1. **Unify cursors** (#1) — highest impact, clears confusion
2. **CLI through hub** (#4) — prevents cursor divergence
3. **Remove pollForDirectWrites** (#5) — follows from #4
4. **Unify registration** (#2) — kills registrations.json
5. **Bridge SSE rewrite** (#3) — real-time Codex delivery
6. **cfn.sh registration** (#9) — trivial with #2
7. **Schema single source** (#7) + drop poll_state (#8)
8. **Everything else** (#6, #10-#16) — independent, any order
