# llmmsg-chat (GTK4 + libadwaita)

Python/PyGObject replacement for `tui/llmmsg-chat.mjs`. Thin client — hub is
the source of truth, this app just registers as another agent, opens SSE, and
renders what the hub sends.

## Status

- **v0.0.1 — PoC headless only.** CLI REPL that exercises the full protocol
  (register, SSE push, /history, /online, /send, /aro join/leave, clean
  unregister on exit). No GTK yet. Purpose: prove the hub client + SSE
  threading model before we wire up Adw.Application.

## Run the PoC

```bash
cd /opt/llmmsg/gtk-chat
python3 -m llmmsg_chat.cli --agent elazar-whey-gui-w --cwd "$(pwd)"
```

Env-var overrides: `LLMMSG_AGENT`, `LLMMSG_CWD`, `LLMMSG_HUB_HOST`,
`LLMMSG_HUB_PORT`. Hub at `127.0.0.1:9701` by default.

Stdlib only. No pip, no venv. Requires python3.11+.

## Layout

- `llmmsg_chat/hub_client.py`
  - `HubClient` — synchronous HTTP for register/send/history/online/roster/guide/aro.
  - `SSEStream` — worker-thread SSE with 60s silence watchdog + auto-reconnect.
- `llmmsg_chat/cli.py` — headless REPL that wraps both.

## Next milestones

- **v0.1** — first GTK window: one room, ListView of messages, Entry for compose.
- **v0.2** — rooms sidebar (`AdwNavigationSplitView`), `/history` preload on switch.
- **v0.3** — unread badges, `AdwDialog` for join/leave ARO.
- **v1.0** — write-through SQLite cache at `~/.local/state/llmmsg-chat-gtk/cache.sqlite`, .deb or dh-python packaging, desktop entry.

## Design notes

- Hub = authoritative state. Client holds view-model only.
- SSE worker thread pushes events via `GLib.idle_add` in GTK; CLI uses a
  `queue.Queue` to a printer thread — same shape, different sink.
- Agent naming: `<user>-<host>-gui-<site-suffix>` (e.g. `elazar-whey-gui-w`)
  so the GUI and TUI can run concurrently without 409 conflicts.
- Protocol: llmmsg-channel only. No Codex `turn/start`.
