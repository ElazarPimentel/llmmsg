# CLAUDE.md — llmmsg

**IMPORTANT: Questions are not instructions. When the user asks a question, answer it. Do not start editing or implementing unless explicitly told to.**

## Ecosystem Map

Before editing anything, read **[ECOSYSTEM.md](./ECOSYSTEM.md)** — it is the canonical map of the llmmsg ecosystem. Covers components, data flow, env vars, state files, invariants, quickstart for new members, and out-of-scope items. Every launcher, hub, bridge, MCP server, and tool in the system is documented there.

**Critical prerequisites for this host:**
- `/etc/llmmsg/site.conf` MUST exist. Hub and launchers hard-error if missing. Templates in `config-templates/site.conf.{whey,lezama}`. Install once per host with `sudo install -m 0644 -o root -g root config-templates/site.conf.<hostname> /etc/llmmsg/site.conf`.
- Launcher source of truth is `~/Documents/terminal/sh/` (separate repo `ElazarPimentel/sh`). `/opt/llmmsg/launchers/` is a real symlink mirror into that repo — never edit via the mirror path.
- Shared launcher helper at `scripts/lib/resolve-agent-name.sh` is sourced by ccs.sh, ccsn.sh, cf.sh, cfn.sh to load site config and resolve/validate the agent label. Do not duplicate that logic in new launchers.

## Project Overview

Inter-agent messaging system for Claude Code and OpenAI Codex sessions. Enables CC and Codex sessions to send/receive messages via a shared SQLite DB and hub server.

## Architecture

- **`llmmsg-channel/hub.mjs`** — Central message router. Systemd service (`llmmsg-hub`) on port 9701. Reads/writes to SQLite DB.
- **`llmmsg-channel/channel.mjs`** — MCP server spawned by each CC session. Connects to hub via SSE for push delivery. Exposes tools: register, send, read_unread, has_unread, log, thread, search, roster, online (ARO-scoped, CC+Codex), aro_join/leave/list. Auto-unregisters on SIGTERM/SIGINT.
- **`codex-llmmsg-app/bridge.mjs`** — Bridge for Codex sessions. Polls DB for unread messages and injects them into Codex threads via `turn/start` RPC over WebSocket to the Codex app server (ws://127.0.0.1:8788). Systemd service (`llmmsg-bridge`).
- **`codex-llmmsg-app/rpc-client.mjs`** — WebSocket JSON-RPC client for the Codex app server.
- **`scripts/init-db.sh`** — Creates the SQLite DB with schema and analytics views.
- **`scripts/llmmsg-cli.py`** — Python CLI for direct DB operations (register, send, read, search, log).

## Key Paths

- **SQLite DB:** `/opt/llmmsg/db/llmmsg.sqlite`
- **Bridge state:** `/opt/llmmsg/codex-llmmsg-app/bridge-state.sqlite`
- **Bridge registrations:** `/opt/llmmsg/codex-llmmsg-app/registrations.json`
- **Codex MCP config:** `~/.codex/config.toml` (section `[mcp_servers.llmmsg-channel]`)
- **CC MCP config:** `~/.claude.json` (section `mcpServers.llmmsg-channel`)

## Systemd Services

```bash
sudo systemctl restart llmmsg-hub          # port 9701
sudo systemctl restart llmmsg-bridge       # codex bridge watcher
sudo systemctl restart codex-app-server    # ws://127.0.0.1:8788
```

Service files: `/etc/systemd/system/llmmsg-hub.service`, `llmmsg-bridge.service`, `codex-app-server.service`

## Environment Variables

- `LLMMSG_DB` — Path to SQLite DB (default: `/opt/llmmsg/db/llmmsg.sqlite`)
- `LLMMSG_HUB_PORT` — Hub port (default: 9701)
- `LLMMSG_HUB_BIND` — Hub bind address (default: `127.0.0.1`, set to `0.0.0.0` for multi-site)
- `LLMMSG_HUB_HOST` — Hub host for channel.mjs to connect to (default: `127.0.0.1`)
- `LLMMSG_SITE` — Site identity. **Source: `/etc/llmmsg/site.conf`.** Env var overrides file.
- `LLMMSG_SITE_SUFFIX` — Required agent name suffix (empty on whey, `-l` on lezama). **Source: `/etc/llmmsg/site.conf`.** Env var overrides file for testing.
- `LLMMSG_ARO_SEGMENT` — Which name segment is the project (whey=0, lezama=1). **Source: `/etc/llmmsg/site.conf`.**
- `LLMMSG_SITE_CONF` — Override path for `/etc/llmmsg/site.conf` (testing only).
- `LLMMSG_REMOTE_HUBS` — JSON map of remote hub names to URLs (env only, secret-adjacent)
- `LLMMSG_INBOUND_SECRET` — Shared secret for `/inbound` auth (env only, both sites must match)
- `LLMMSG_AGENT` — Agent name for the session (set by launcher via `.agent-name-{cc,ca}` + site suffix)
- `CODEX_APP_SERVER_URL` — Codex app server URL (default: `ws://127.0.0.1:8788`)

## Critical: Push Delivery Requirements

CC push notifications (`notifications/claude/channel`) require **two things** to work:

1. **`--dangerously-load-development-channels server:llmmsg-channel`** must be passed to the `claude` CLI. Without this flag, CC loads channel.mjs as a regular MCP server — tools work but push notifications are silently ignored. This flag is set in `ccs.sh`. **Do not remove it.**

2. **Hub SSE close handler must compare response objects** (hub.mjs). When a session reconnects, the old TCP connection's close handler can fire late and delete the new connection from the `channels` Map. The close handler must check `channels.get(agent) === res` before deleting. Fixed in hub v1.9.

## Known Issues

- **Codex `--remote` ignores `-C` flag** — Threads get cwd from the app server's WorkingDirectory, not from `-C`. Workaround: cf.sh sends cwd as initial prompt text.
- **Bridge registration goes stale** — When a codex session restarts, old thread IDs in registrations.json point to dead threads. Bridge falls back to most recent loaded thread when cwd filter fails.
- **Codex MCP shows Tools: (none)** — Display bug in codex `/mcp` output. Tools actually work (register, send confirmed functional).
- **Push delivery CC-only** — `notifications/claude/channel` is CC-specific. Codex receives messages only via the bridge's `turn/start` injection.
- **Cross-site `re` tags are warn-only** — `re` tag validation on `/send` checks local DB only. Cross-site tags don't exist locally, so validation logs a warning instead of rejecting. Threading still works.
- **Multi-site tunnels require VPN** — SSH tunnels (autossh via vpn.sh) only work when VPN is up. When VPN is down, cross-site messages queue in outbox and flush when VPN reconnects.
- **registrations.json read from disk on every poll/send** — hub.mjs and bridge.mjs both call readFileSync on every cycle. Should cache in memory with file watcher.
- **Bridge creates new WebSocket per delivery** — A new CodexRpcClient connection per agent per poll cycle. Should use a persistent connection.

## Development

```bash
cd llmmsg-channel && npm install
cd ../codex-llmmsg-app && npm install
node --check llmmsg-channel/hub.mjs        # syntax check
node --check codex-llmmsg-app/bridge.mjs   # syntax check
```

No automated tests. Smoke test: register → send → read_unread with a live hub.

## MCP Reference

For Codex-compatible local MCP server design and configuration, consult `docs/codex-mcp-local-servers-reference.md`. It summarizes the official OpenAI Codex MCP, config, AGENTS.md, and Docs MCP documentation as of 2026-03-30.

## DB Analytics Views

Run `SELECT * FROM v_<name>` against the live DB:
- `v_overview` — totals, averages
- `v_agent_stats` — per-agent volume and verbosity
- `v_pair_traffic` — who talks to whom
- `v_message_types` — type distribution
- `v_largest_messages` — biggest messages by chars
- `v_agent_cursors` — how far behind each agent is
- `v_hourly_volume` — last 24h traffic
- `v_thread_activity` — thread sizes and participants

## Message Format

Message body is a JSON object. Minimum: `{"message": "your text"}`. Keep payloads lean.

Messaging guide source of truth: DB `config` row `message_guide`, served by hub `/guide`, fetched by the `guide` MCP tool, and pushed by `channel.mjs` on register. Do not use markdown files as the guide source.

Optional fields only when they serve a purpose:
- Avoid `type` unless a specific tool or workflow explicitly requires it.
- Structured keys (`file`, `items`, `error`, etc.) only when machine-readable data is truly needed.

Do **not** use `summary` + `details` as default. Put the content in `message`.

The `log` endpoint previews use `summary` or `message` (first 120 chars) for display.
`llmmsg` is push-based. After sending, rely on push. Do not use sleep, polling, timers, loops, backoff, or repeated checks.
Call `read_unread` once only if the user asked, or if there is clear evidence a reply is missing. Inform your project's PM agent of missing replies. If that does not resolve it, tell the user in the terminal.
Do not re-register defensively before sends. Register at session start, after a name change, or only after an actual `not_registered` error.
For group-wide notices, default to `aro:{group}`. Use `*` only with Elazar's explicit approval. Never broadcast what can be group-addressed.
Do not resend shared context. Lead with the payload. Prefer plain prose. If 3 lines are enough, do not send 30.
When a channel message requires a reply, send it with the `send` MCP tool only and move on. Do not echo, recap, or summarize the channel exchange in the terminal/CLI unless Elazar explicitly asks.
If a channel message needs no reply or is only a no-op acknowledgment, stay silent. Do not write CLI prose that references, acknowledges, summarizes, or explains a channel message.
Reply routing: if the incoming channel metadata has `origin_aro`, reply to that exact ARO (`to=origin_aro`) with `re=tag`. Otherwise reply directly to the sender (`to=from`) with `re=tag`.

## Engineering Principles

- **Prefer native library/widget behavior.** Do not reimplement normal terminal/editor/shell behavior unless the library genuinely cannot do it. If you find yourself writing a cursor, a word-boundary parser, a history buffer, a readline clone, stop and check whether the underlying library already provides it. The v0.2.6 TUI regression reimplemented text-input navigation with a custom buffer that broke Home/End/Ctrl-Left, then compounded the problem with a fake inverse-tag cursor that rendered as literal `{inverse}` text. Both were fixed by using `blessed.textbox` natively.
- **Minimal viable fix.** When a bug is reported, diagnose the root cause, apply the smallest change that fixes it, and stop. Do not bundle refactors, add features, or expand scope. If a refactor is needed, it's a separate commit with explicit approval.
- **Coordinate before editing shared files.** Multi-agent work (ca / cc / sh-cc-w) must assign file ownership before anyone edits. One agent edits, another reviews. Never parallel-edit the same file.

## Script Versioning

Every `.sh` and `.py` file must have a `VERSION` variable and print name + version on run. Bump on every change.
