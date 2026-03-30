# codex-llmmsg-app

Codex-side message bridge using the Codex App Server protocol.

## Fast usage

1. Start a shared Codex App Server:

```bash
/home/rob/Documents/terminal/codex-llmmsg-app/start-app-server.sh
```

2. Launch Codex sessions against it:

```bash
codex --remote ws://127.0.0.1:8788
```

3. Register the session thread to an agent name:

```bash
node /home/rob/Documents/terminal/codex-llmmsg-app/bridge.mjs register mars-audit-ca --cwd /home/rob/Documents/work/pensanta/websites/evolutiva-pensanta-com/mars
```

4. Run the watcher:

```bash
node /home/rob/Documents/terminal/codex-llmmsg-app/bridge.mjs watch
```

The watcher reads messages from the shared llmmsg sqlite DB and injects them into the mapped Codex thread as a real `turn/start`.
