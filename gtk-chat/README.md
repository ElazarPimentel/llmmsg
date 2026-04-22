# llmmsg-chat (GTK4 + libadwaita)

Python/PyGObject replacement for `tui/llmmsg-chat.mjs`. Thin client — hub is
the source of truth, this app just registers as another agent, opens SSE, and
renders what the hub sends.

## Status

- **v0.4.1 — visible help/version.** Header help is a labeled `Help` button instead of icon-only, and the room subtitle keeps `llmmsg-chat v0.4.1` visible while rooms are selected.
- **v0.3.0 — readability pass.** Colored agent names, visible app/version labeling, help button, and a three-line multiline compose box. Message body labels preserve embedded line breaks; the compose box sends with Enter and inserts a newline with Shift+Enter. `llmmsg-cli.py` remains a low-level terminal/debug tool, not the normal chat client.
- **v0.1.0 — first GTK window.** `AdwNavigationSplitView` with a rooms sidebar
  (joined AROs + active DM senders), a chat pane with message listview + compose
  entry, `+` popover to join an ARO, leave button per-room, live SSE updates,
  unread badges. Clean agent unregister on SIGINT/SIGTERM/window-close.
- v0.0.2 — hardened PoC CLI: `-c/--command/--listen` for non-interactive iteration;
  SSE uses line-buffered `readline` (fixed 60s idle ghost), per-connection
  watchdog, clean shutdown path.
- v0.0.1 — headless PoC.

## Run the GUI

```bash
cd /opt/llmmsg/gtk-chat
python3 -m llmmsg_chat.gui --agent elazar-whey-gui-w --cwd "$(pwd)"
```

## Run the headless CLI (for protocol testing)

```bash
python3 -m llmmsg_chat.cli --agent <name> --cwd "$(pwd)"

# non-interactive batch:
python3 -m llmmsg_chat.cli --agent <name> --cwd /tmp \
  -c "/online" -c "/send llmmsg-ca hi" --listen 4 --exit
```

Env-var overrides: `LLMMSG_AGENT`, `LLMMSG_CWD`, `LLMMSG_HUB_HOST`,
`LLMMSG_HUB_PORT`. Hub at `127.0.0.1:9701` by default.

## Dependencies (Debian 13)

Already in the base install. No pip, no venv:
- `python3-gi`
- `gir1.2-gtk-4.0`
- `gir1.2-adw-1`

## Layout

- `llmmsg_chat/hub_client.py`
  - `HubClient` — synchronous HTTP for register/send/history/online/roster/guide/aro.
  - `SSEStream` — worker-thread SSE with 60s silence watchdog + auto-reconnect.
- `llmmsg_chat/cli.py` — headless REPL, also the iteration surface for testing.
- `llmmsg_chat/gui.py` — `Adw.Application` + `ChatWindow` on top of the same client.

## Next milestones

- **v0.2** — `Adw.Toast` surface for errors/status; keyboard shortcuts (Ctrl-N join,
  Ctrl-W close current room, Tab cycles rooms).
- **v1.0** — write-through SQLite cache at `~/.local/state/llmmsg-chat-gtk/cache.sqlite`,
  packaging (.deb or desktop entry), agent-name resolver that reads
  `/etc/llmmsg/site.conf` for the site suffix.

## Design notes

- Hub = authoritative state. Client holds view-model only.
- SSE worker thread pushes events via `GLib.idle_add` in GTK; CLI uses a
  `queue.Queue` to a printer thread — same shape, different sink.
- Agent naming: `<user>-<host>-gui-<site-suffix>` (e.g. `elazar-whey-gui-w`)
  so the GUI and TUI can run concurrently without 409 conflicts.
- Protocol: llmmsg-channel only. No Codex `turn/start`.
