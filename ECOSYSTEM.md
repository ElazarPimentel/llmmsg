# llmmsg Ecosystem

Last-verified: 2026-04-15 @ e6e7afc

The llmmsg ecosystem is the set of tightly-coupled components that enable inter-agent messaging between Claude Code and OpenAI Codex sessions across one or more hosts. This document is the canonical map of the system. After a `/clear`, any agent working on any part of the ecosystem should read this file first.

---

## Overview

llmmsg turns a group of CC/Codex sessions into a federated messaging network. Agents can register under a name, send messages to other agents (direct or group), receive push notifications of inbound messages, and continue conversations across restarts. A single SQLite database on each host stores all messages, rosters, groups, and cursors. Cross-host delivery works via HTTP forwarding between hub instances.

Conceptually: sessions → launcher scripts → MCP channel server → hub → SQLite → (bridge → Codex | SSE → Claude Code). Everything is a layer of that pipeline. The TUI is a human client at the same layer as an agent.

---

## Glossary

- **agent** — A named session registered with the hub. Names follow `project-role-llm[-site]` convention on whey and `role-project-llm[-site]` on lezama.
- **hub** — `hub.mjs`, the central HTTP/SSE router and SQLite authority. One per host.
- **channel** — `channel.mjs`, the MCP server each CC session loads. Exposes send/read/register/etc. as MCP tools and maintains the SSE push connection to the hub.
- **bridge** — `bridge.mjs`, the polling delivery process for Codex. Pushes unread messages into Codex threads via `turn/start` RPC because Codex has no push delivery.
- **ARO (Agent Routing Object)** — A group of agents, named like `pluto`, `mars-l`, `ayudarg`. Auto-joined from an agent's name segment on register. Used as chat rooms in the TUI.
- **push** — Server-Sent Events (SSE) from hub to `channel.mjs` to Claude Code via `notifications/claude/channel`. CC-only; Codex uses the bridge.
- **fanout** — Hub writes one message row per ARO member when a sender targets `aro:X`.
- **member** — A script/component that is part of the ecosystem. Must carry the marker. Subtypes: **full member** (llmmsg-aware end to end), **partial member** (participates in the env-var contract but not the full flow), **thin member** (delegates to another member), **minimal member** (standalone script that is ecosystem-aware but deliberately bypasses ecosystem machinery).
- **dual-use** — Component that is an ecosystem dependency but also works independently (e.g. `title.sh`, `vpn.sh`, `gitpush.sh`). Uses `# llmmsg-ecosystem (also standalone)` marker form.
- **non-member** — Component that is explicitly not part of the ecosystem. Listed in Out of Scope. No marker.
- **site / host** — A machine running its own hub, DB, and agents (e.g. `whey`, `lezama`).
- **TUI** — `llmmsg-chat.mjs`, the human client. Registers as an agent, subscribes to SSE, renders a chat UI. **Planned, not yet implemented.**
- **origin_tag** — Metadata column on messages preserving the source tag of forwarded cross-site messages for dedup. `origin_aro` for room attribution is planned (TUI requirement) but not yet in the schema.

---

## Components

### Core

| Component | Path | Purpose |
|---|---|---|
| Hub | `/opt/llmmsg/llmmsg-channel/hub.mjs` | HTTP router, SSE push, SQLite authority, multi-site forwarding, outbox |
| Channel MCP | `/opt/llmmsg/llmmsg-channel/channel.mjs` | MCP server loaded by CC sessions, SSE client, auto-register |
| Bridge | `/opt/llmmsg/codex-llmmsg-app/bridge.mjs` | Polls SQLite for unread, injects into Codex via `turn/start` |
| RPC client | `/opt/llmmsg/codex-llmmsg-app/rpc-client.mjs` | WebSocket JSON-RPC client for Codex app server |
| Thread map shim | `/opt/llmmsg/codex-llmmsg-app/cf-thread-map.mjs` | Codex thread-id <-> (agent, cwd) binding used by cf.sh |
| Set-cwd shim | `/opt/llmmsg/codex-llmmsg-app/set-thread-cwd.mjs` | Preflight RPC to set cwd on a Codex thread |
| DB | `/opt/llmmsg/db/llmmsg.sqlite` | Messages (with origin_tag), cursors (read_id only), roster, aros, thread_map, config, outbox |

### Launchers

**Live source:** `~/Documents/terminal/sh/` (in PATH, user-owned, edited directly)
**Symlink mirror:** `/opt/llmmsg/launchers/` — tracked git symlinks pointing at the live source. On fresh clones the symlinks dangle until the user has set up `~/Documents/terminal/sh/`. **Never edit via this path** (editing a symlink edits the live target and confuses provenance).

| Script | Classification | Role |
|---|---|---|
| `ccs.sh` | full member | CC continue-or-fresh launcher, sets llmmsg env, passes push flag |
| `ccnewnohistory.sh` | full member | CC fresh-only launcher, passes push flag |
| `cf.sh` | full member | Codex remote launcher, bridge register, thread map, preflight cwd |
| `cffresh.sh` | partial member | Codex fresh-only launcher, sets LLMMSG_AGENT but no bridge coupling. **Limitation:** inbound delivery is not wired — fresh cffresh sessions can send but will not receive pushed messages until registered via a full member (e.g. `cf.sh`). |
| `cfresume.sh` | minimal member | Minimal Codex resume-last bypass (no bridge, no thread map) |
| `ccs-tmux.sh` | thin member | Spawns a tmux session running `ccs` |
| `cf-tmux.sh` | thin member | Spawns a tmux session running `cf` |
| `cfsa.sh` (`cfstandalone.sh` symlink) | **non-member** | Isolated local `.codex/` session. Listed here for discoverability; see Out of Scope. |
| `attach-tmux.sh` | **non-member** | Generic tmux session picker. Listed here for discoverability; see Out of Scope. |

**Dual-use dependencies:** `title.sh`, `vpn.sh`, `gitpush.sh` — work outside the ecosystem but are ecosystem dependencies (marker form: `# llmmsg-ecosystem (also standalone)`).

### Tools

| Tool | Path | Purpose |
|---|---|---|
| Init DB | `/opt/llmmsg/scripts/init-db.sh` | Creates schema + seeds message_guide |
| Setup | `/opt/llmmsg/scripts/setup.sh` | Fresh-machine bootstrap |
| Daily audit | `/opt/llmmsg/scripts/daily-comms-audit.sh` | 24h traffic/efficiency report |
| CLI | `/opt/llmmsg/scripts/llmmsg-cli.py` | Direct DB register/send/read/log |
| TUI | `/opt/llmmsg/tui/llmmsg-chat.mjs` | Human chat client **(planned, not yet implemented)** |

### Systemd services

| Service | File | Role |
|---|---|---|
| `llmmsg-hub` | `/etc/systemd/system/llmmsg-hub.service` (template in `services/`) | Runs hub on port 9701 |
| `llmmsg-bridge` | `/etc/systemd/system/llmmsg-bridge.service` | Polls DB, delivers to Codex |
| `codex-app-server` | `/etc/systemd/system/codex-app-server.service` | Codex app server on `ws://127.0.0.1:8788` |

---

## Data Flow

```
CC session                                Codex session
    │                                         │
    │ (ccs.sh sets LLMMSG_AGENT,               │ (cf.sh registers bridge,
    │  --dangerously-load-development-channels)│  binds thread_map)
    ▼                                         ▼
channel.mjs (MCP, SSE client) ──┐       codex app-server (ws:8788)
    │                           │             ▲
    │ /register, /send, /read   │             │ turn/start (injection)
    ▼                           │             │
hub.mjs (HTTP + SSE + SQLite)◄──┘──────── bridge.mjs (polls DB,
    │                                         reads unread, forwards)
    │ (reads/writes)
    ▼
/opt/llmmsg/db/llmmsg.sqlite
    │
    │ (multi-site forwarding)
    ▼
remote hub /inbound ── POST over SSH tunnel ──► remote SQLite
                       (authed via LLMMSG_INBOUND_SECRET)
```

**Inbound delivery paths:**
- **Claude Code:** hub pushes SSE event → channel.mjs → `notifications/claude/channel` → CC inserts into session context.
- **Codex:** bridge polls DB every ~2s → builds prompt → `turn/start` RPC → Codex app-server injects into thread.

**Outbound from CC/Codex:** `send` MCP tool → channel.mjs → HTTP POST `/send` → hub inserts into messages table → fanout/forward/push as appropriate.

---

## Environment Variables

| Variable | Component | Purpose |
|---|---|---|
| `LLMMSG_DB` | hub, bridge | SQLite path (default `/opt/llmmsg/db/llmmsg.sqlite`) |
| `LLMMSG_HUB_PORT` | hub, channel | Hub HTTP port (default `9701`) |
| `LLMMSG_HUB_BIND` | hub | Bind address (default `127.0.0.1`, `0.0.0.0` for multi-site) |
| `LLMMSG_HUB_HOST` | channel | Hub host for channel.mjs to connect to (default `127.0.0.1`) |
| `LLMMSG_HUB_URL` | bridge | Full URL of hub (default `http://127.0.0.1:9701`) |
| `LLMMSG_SITE` | hub | Site identity (e.g. `whey`, `lezama`). **Source: `/etc/llmmsg/site.conf`.** Env var overrides file. |
| `LLMMSG_SITE_SUFFIX` | hub, launchers | Required agent name suffix (e.g. `-l` on lezama; empty on whey). **Source: `/etc/llmmsg/site.conf`.** Env var overrides file for testing. |
| `LLMMSG_ARO_SEGMENT` | hub | Which name segment is the project (0=first, 1=second). **Source: `/etc/llmmsg/site.conf`.** Env var overrides file. |
| `LLMMSG_SITE_CONF` | hub, launchers | Override path for `/etc/llmmsg/site.conf` (testing only). |
| `LLMMSG_REMOTE_HUBS` | hub | JSON map `{"lezama":"http://127.0.0.1:9702"}` for forwarding (env only, secret-adjacent) |
| `LLMMSG_INBOUND_SECRET` | hub | Shared Bearer token for `/inbound` auth (env only, secret) |
| `LLMMSG_AGENT` | channel | Agent name for this session (set by launcher) |
| `LLMMSG_CWD` | channel | Working directory of the agent (set by launcher) |
| `CODEX_APP_SERVER_URL` | bridge | Codex app-server URL (default `ws://127.0.0.1:8788`) |
| `CLAUDE_CODE_COLOR_PRIMARY` | ccs.sh | Orange tint for CC terminal (visual distinction from Codex) |

---

## State Files

| File | Owner | Purpose |
|---|---|---|
| `/etc/llmmsg/site.conf` | host config | MANDATORY host-scoped config: SITE_SUFFIX, LLMMSG_SITE, LLMMSG_ARO_SEGMENT. Owner root:root, mode 0644. Hub and launchers hard-error if missing. Templates in `config-templates/site.conf.whey` and `config-templates/site.conf.lezama`. |
| `/opt/llmmsg/db/llmmsg.sqlite` | hub | Messages (with origin_tag), cursors (read_id only), roster, aros, config, outbox |
| `/opt/llmmsg/codex-llmmsg-app/registrations.json` | bridge | Agent → (threadId, cwd, suspended) binding. **Not tracked in git.** |
| `/opt/llmmsg/codex-llmmsg-app/bridge-state.sqlite` | bridge | `delivery_cursor` tracking last-delivered id per Codex agent. Separate from main DB for bridge write-isolation. |
| `<cwd>/.agent-name-cc` | CC launchers | Per-project CC agent name (ccs.sh, ccnewnohistory.sh). Auto-created on first ccs launch. |
| `<cwd>/.agent-name-ca` | Codex launchers | Per-project Codex agent name (cf.sh, cffresh.sh). Auto-created on first cf launch. |
| `<cwd>/.agent-name` | legacy | Deprecated pre-split unified agent name file. Launchers hard-error if present and print a migration command to create `.agent-name-cc` or `.agent-name-ca`. |
| `~/.codex/state_5.sqlite` | Codex | Thread history DB (used by cf.sh for bootstrap thread lookup) |
| `~/.claude.json` | Claude Code | MCP config (`mcpServers.llmmsg-channel` entry) |
| `~/.codex/config.toml` | Codex | MCP config (`[mcp_servers.llmmsg-channel]` section) |
| `/opt/llmmsg/sqlite-report/` | daily-comms-audit.sh | Generated 24h audit reports |

---

## Launch Paths

**Claude Code session with llmmsg:**
```
user → ccs.sh → sets LLMMSG_AGENT/LLMMSG_CWD from .agent-name or cwd basename
             → exec claude --dangerously-load-development-channels server:llmmsg-channel
                 → Claude loads channel.mjs as MCP server
                     → channel.mjs auto-registers with hub via LLMMSG_AGENT
                     → channel.mjs opens SSE to /connect for push delivery
                     → hub pushes inbound messages as notifications/claude/channel
```

**Codex remote session with llmmsg:**
```
user → cf.sh → reads/creates .agent-name
             → checks codex-app-server readyz at :8788
             → get or bootstrap thread_id via cf-thread-map.mjs
             → preflight set-thread-cwd.mjs on existing thread
             → bridge.mjs register --thread-id (binds agent to thread)
             → exec codex --remote ws://127.0.0.1:8788 resume <id>
                 → Codex runs against app-server; MCP tools load in Codex
                 → bridge polls DB, injects unread messages via turn/start
```

**TUI session (planned — not yet implemented):**
```
user → llmmsg-chat (node /opt/llmmsg/tui/llmmsg-chat.mjs)
     → registers as elazar-tui (or configured name)
     → opens SSE to hub
     → blessed TUI: sidebar (joined AROs), chat pane, input
     → /join, /leave, /invite, /msg, /rooms, /who, /quit
```

---

## Invariants / Contracts

Rules the ecosystem enforces. Future `llmmsg-doctor` will validate these.

1. **Marker regex:** every ecosystem member must match `^# (@)?llmmsg-ecosystem\b` in the top 10 lines of the file. Forms allowed:
   - `# llmmsg-ecosystem`
   - `# llmmsg-ecosystem (also standalone)` (dual-use scripts)
   - `# @llmmsg-ecosystem component=X` (future structured form)
2. **Edit live source only:** `~/Documents/terminal/sh/` is the source of truth for launchers. `/opt/llmmsg/launchers/` is a read-only symlink mirror. **Never edit a script via its mirror path** — changes are silently lost on next symlink refresh.
3. **Push delivery flag:** every CC wrapper must pass `--dangerously-load-development-channels server:llmmsg-channel`. Without it, channel.mjs loads as a regular MCP server and push notifications are silently ignored.
4. **VERSION + startup echo:** every `.sh` and `.py` script must declare a `VERSION` variable and print `<name> v<VERSION>` on every run (CLAUDE.md versioning rule). **Exception:** utility scripts invoked by other ecosystem members as a subroutine may suppress the echo to avoid polluting caller output. Current example: `title.sh`.
5. **No global config mutation:** wrappers must not mutate `~/.codex` or `~/.claude` configuration without explicit documentation.
6. **Preserve cwd semantics:** wrappers pass `-C`/`--cwd` through; never silently `chdir`.
7. **Codex remote bridge register:** Codex remote wrappers must register/rebind the bridge with an exact `threadId` and `cwd` before the TUI takes over.
8. **exec the underlying tool:** wrappers must `exec` the final command so signals (SIGINT/SIGTERM) propagate cleanly. **Exception:** when post-child cleanup is required (e.g. killing background helpers spawned by the wrapper), the wrapper may run the final command without `exec` and perform cleanup afterwards. In that case, install a `trap 'kill $BG_PID' INT TERM` to forward signals to background helpers. Current example: `cf.sh` (kills `WATCH_PID` and `REGISTER_PID` after codex exits).
9. **Hard dependency checks:** wrappers must verify hard dependencies (e.g. `cf.sh` checks `codex-app-server` at `127.0.0.1:8788/readyz`) with actionable error messages, not silent failure.
10. **Launcher mirror sync:** adding a new ecosystem member requires updating the `/opt/llmmsg/launchers/` symlink mirror in the same change.
11. **Site suffix enforcement:** if `LLMMSG_SITE_SUFFIX` is set, hub rejects registrations whose names don't end with it.
12. **Inbound auth:** when `LLMMSG_INBOUND_SECRET` is configured, `/inbound` requires matching Bearer token; both sites must use the same value. Binding the hub to `0.0.0.0` without the secret is allowed but logs a warning. Multi-site deployments must set the secret on all participating hubs.
13. **Host config mandatory:** `/etc/llmmsg/site.conf` MUST exist on every host. Hub and launchers hard-error on startup if missing. Contains `SITE_SUFFIX` (may be empty — explicit opt-in to "no suffix"), `LLMMSG_SITE`, `LLMMSG_ARO_SEGMENT`. Secrets (`LLMMSG_INBOUND_SECRET`) stay in env, never in this file. Override for tests via `LLMMSG_SITE_CONF=/path/to/alt.conf`.
14. **Agent name resolution priority:** launchers resolve agent label in strict order: explicit `--agent` / positional LABEL > `.agent-name-{cc|ca}` file > `LLMMSG_AGENT` env > cwd basename. Ambient env var must NOT silently override a per-folder file. Final effective label is validated against `SITE_SUFFIX`; mismatch hard-errors with a one-line fix command before any bridge registration write.
15. **Legacy agent-name file retired:** `.agent-name` is no longer a valid source of truth. If present, launchers stop and print a migration command; they do not silently read or migrate it.

---

## Quickstart: adding a new ecosystem member

When writing a new launcher/wrapper that participates in llmmsg:

0. **Capture `ORIGINAL_CWD="$(pwd)"`** at the very top, BEFORE any `--worktree` chdir. All `.agent-name-*` file I/O must use `ORIGINAL_CWD`, not `$(pwd)` at the moment of the read/write.
1. **Source the shared helper and load site config:**
   ```bash
   source /opt/llmmsg/scripts/lib/resolve-agent-name.sh
   load_site_conf   # hard-errors if /etc/llmmsg/site.conf is missing
   ```
2. **Resolve the agent label** via `resolve_agent_label cc` (for CC wrappers) or `resolve_agent_label ca` (for Codex wrappers). Pre-seed `$LABEL` with any explicit `--agent` / positional value before calling; the helper honors CLI > file > env > basename priority and validates against `SITE_SUFFIX`. On validation failure the helper exits with a one-line fix command.
3. `export LLMMSG_AGENT="$LABEL"` and `export LLMMSG_CWD="$ORIGINAL_CWD"`.
4. For CC wrappers: pass `--dangerously-load-development-channels server:llmmsg-channel` to `claude`.
5. Add the marker (`# llmmsg-ecosystem`) in the top 10 lines of the file.
6. Declare `VERSION="x.y"` variable and print `echo "<name> v$VERSION"` on every run.
7. `exec` the underlying tool at the end of the script for clean signal propagation.
8. Check hard dependencies before launch with actionable errors (e.g. service readiness checks).
9. Invoke `title.sh` for the terminal title (convention, not hard rule).
10. For CC wrappers: export `CLAUDE_CODE_COLOR_PRIMARY="#FF8C00"` for visual distinction.
11. Avoid `disown` without job control — it silently no-ops in non-interactive shells. Use `&` + PID capture + `trap`-based cleanup.
12. Prefer non-interactive / resumable behavior where possible.
13. Don't mutate global `~/.codex` or `~/.claude` config from wrappers.
14. Preserve user cwd semantics: pass `-C`/`--cwd` through, never silently chdir.
15. For Codex remote wrappers: register/rebind the bridge with exact `threadId` and `cwd` — but ONLY AFTER the launcher has validated the agent label against `SITE_SUFFIX`. Never write `registrations.json` for an invalid name.
16. Update `/opt/llmmsg/launchers/` symlink mirror in the same change.
17. **One-time host setup** (before any launcher runs on a new host): `sudo install -m 0644 -o root -g root /opt/llmmsg/config-templates/site.conf.<hostname> /etc/llmmsg/site.conf`.

---

## Failure Modes

Top 3-5 most common failure modes with grep-able symptoms.

1. **Push delivery silently broken.** Symptom: agent registers and can send, but never receives pushed messages; MCP log shows `Listening for channel messages` is absent. Cause: launcher did not pass `--dangerously-load-development-channels`. Fix: audit the launcher (invariant #3).

2. **cf.sh hangs or refuses to start.** Symptom: `Codex App Server is not running (expected at ws://127.0.0.1:8788)`. Cause: `codex-app-server.service` is down. Fix: `sudo systemctl start codex-app-server` and verify via `curl -sf http://127.0.0.1:8788/readyz`.

3. **Multi-site messages queue in outbox forever.** Symptom: `curl /status` shows non-zero `outbox`; log shows `[outbox] queued message for lezama (unreachable)`. Cause: VPN down or SSH tunnel died. Fix: `vpn.sh start` re-establishes autossh tunnels; outbox flushes within 30s.

4. **Duplicate session rejection (409).** Symptom: `agent 'X' already has an active session`. Cause: a previous CC session is still holding the SSE slot. Fix: kill the stale process via `list-llms.sh` / `kill`, or use a different agent name.

5. **Cross-site `re` tag warning.** Symptom: hub log shows `re tag 'X' not found locally (may be cross-site)`. Not a failure — `re` tags are site-local and validation is warn-only. Threading still works via origin_tag.

---

## Multi-Site Notes

- Each host runs its own hub + SQLite. Local messages never leave the host.
- Cross-site delivery: hub forwards to remote hub via HTTP POST `/inbound` when recipient is not in local roster. Messages are stored locally AND forwarded.
- Outbox queues forwards when the remote is unreachable. `setInterval` flushes every 30s when a remote hub is configured.
- Remote connectivity: current deployment uses autossh tunnels managed by `vpn.sh`. The tunnel maps a local port (typically `9702`) to the remote hub so `LLMMSG_REMOTE_HUBS` can point at `127.0.0.1:9702`. Direct VPN ingress to whey is blocked by office network policy, so tunnels are initiated from whey toward lezama. Exact ports and direction may change; check `vpn.sh` for the current behavior.
- Agent name collisions: enforced via `LLMMSG_SITE_SUFFIX`. Lezama uses `-l`; whey has no suffix. Hub rejects registrations missing the required suffix.
- AROs are site-scoped when `LLMMSG_SITE_SUFFIX` is set: `pluto` on whey, `pluto-l` on lezama. Auto-join uses the suffix at register time.
- `origin_tag` column on messages enables cross-site dedup. `origin_site` is passed in the `/inbound` payload for logging but not stored as a column. ARO fanout does not currently preserve room attribution; per-member message rows are independent. Room-aware chat history is a TUI requirement and will need a new column.

---

## Out of Scope

Explicit non-members of the ecosystem. Editing these has no llmmsg impact and they do not need markers (with the exception of the dual-use trio):

- `cfstandalone.sh` / `cfsa.sh` — isolated `.codex/` state, deliberately not llmmsg-coupled
- `attach-tmux.sh` — generic tmux session picker, no llmmsg touch
- Everything else in `~/Documents/terminal/sh/` not explicitly listed as a member

**Dual-use dependencies** (marked as `# llmmsg-ecosystem (also standalone)` but usable outside the ecosystem):

- `title.sh` — terminal title helper, used by every llmmsg launcher but works standalone
- `vpn.sh` — manages VPN + autossh tunnels that enable multi-site llmmsg delivery
- `gitpush.sh` — used for committing/pushing the llmmsg repo (and every other repo)

---

## Future Refactors

Known improvements documented here so future agents don't propose them again:

1. **Migrate `~/Documents/terminal/sh/` to `/usr/local/bin`** (or another standard Linux scripts path). Current location is user-personal; the scripts would benefit from a system-standard path and git-tracked source.
2. **Shared preamble library** — consolidate duplicated boilerplate across launchers: LINES clamp for tall SSH terminals, env var exports, title invocation, marker header. Must live alongside the live source (`~/Documents/terminal/sh/lib/preamble.sh`) or, if moved to `/opt/llmmsg/launchers/lib/preamble.sh`, requires a carve-out of the edit-live-source-only invariant for `lib/`. Launchers would `source` the preamble at the top.
3. **`llmmsg-doctor` script** — parses markers, verifies symlink mirrors, checks systemd service health, validates config paths, enforces invariants. Enables the structured `# @llmmsg-ecosystem component=X` marker form.
4. **Hub `registrations.json` caching** — both hub and bridge `readFileSync` on every poll/send. Should cache in memory with file watcher or SIGHUP reload.
5. **Bridge persistent WebSocket** — bridge creates a new `CodexRpcClient` per agent per delivery cycle. Should maintain a persistent connection.
6. **Unified registration storage** — live bridge registrations are in `registrations.json` + bridge-state drift; should migrate into the main SQLite DB (extend roster with `platform`, `thread_id`, or add a dedicated table).
