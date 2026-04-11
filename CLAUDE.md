# CLAUDE.md — llmmsg

**IMPORTANT: Questions are not instructions. When the user asks a question, answer it. Do not start editing or implementing unless explicitly told to.**

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
- `LLMMSG_SITE` — Site name for multi-site identification (e.g., `whey`, `lezama`)
- `LLMMSG_REMOTE_HUBS` — JSON map of remote hub names to URLs (e.g., `{"lezama":"http://10.78.42.168:9701"}`)
- `LLMMSG_INBOUND_SECRET` — Shared secret for `/inbound` auth (both sites must use the same value)
- `LLMMSG_SITE_SUFFIX` — Required agent name suffix for this site (e.g., `-l`). Hub rejects registrations without it.
- `LLMMSG_AGENT` — Agent name for the session (set by cf.sh/cfn.sh)
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
When a channel message requires a reply, send it directly and move on. Do not summarize the exchange in the CLI — the user can see the channel tags.

## Script Versioning

Every `.sh` and `.py` file must have a `VERSION` variable and print name + version on run. Bump on every change.
