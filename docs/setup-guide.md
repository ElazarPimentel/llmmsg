# llmmsg Setup Guide

Complete setup instructions for llmmsg on a new machine, including multi-site configuration.

## Prerequisites

1. **Node.js >= 18** (tested with v24)
2. **sqlite3** CLI (for init-db.sh)
3. **systemd** (for running hub as a service)
4. **pnpm** (not npm — project uses pnpm)

### sqlite3 installation gotcha

On Pop!_OS/Ubuntu with mixed Debian packages, `libsqlite3-0` may be a newer Debian version that conflicts with Ubuntu's `sqlite3` package. Fix:

```bash
sudo apt-get -y --allow-downgrades install libsqlite3-0=3.37.2-2ubuntu0.5 sqlite3
```

## Single-site setup

### 1. Clone and install dependencies

```bash
git clone <repo> /opt/llmmsg
cd /opt/llmmsg/llmmsg-channel && pnpm install
cd /opt/llmmsg/codex-llmmsg-app && pnpm install
```

### 2. Approve better-sqlite3 native build

pnpm blocks native addon builds by default. If you see "Ignored build scripts: better-sqlite3":

```bash
cd /opt/llmmsg/llmmsg-channel
# Option A: edit package.json
node -e "
const pkg = require('./package.json');
if (!pkg.pnpm) pkg.pnpm = {};
pkg.pnpm.onlyBuiltDependencies = ['better-sqlite3'];
delete pkg.pnpm.ignoredBuiltDependencies;
require('fs').writeFileSync('./package.json', JSON.stringify(pkg, null, 2) + '\n');
"
pnpm install
pnpm rebuild better-sqlite3
```

Verify the native binary exists:
```bash
ls node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/build/Release/better_sqlite3.node
```

If missing, the hub will crash with `Could not locate the bindings file`.

### 3. Initialize the database

```bash
bash /opt/llmmsg/scripts/init-db.sh
```

Creates `/opt/llmmsg/db/llmmsg.sqlite` with all tables, indexes, views, and the message guide seed.

### 4. Install and start the hub service

```bash
sudo cp /opt/llmmsg/services/llmmsg-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now llmmsg-hub
```

Verify:
```bash
curl -s http://127.0.0.1:9701/status
```

Should return JSON with `version`, `connected`, `roster`.

### 5. Configure Claude Code MCP

Add to `~/.claude.json`:

```json
{
  "mcpServers": {
    "llmmsg-channel": {
      "command": "node",
      "args": ["/opt/llmmsg/llmmsg-channel/channel.mjs"],
      "env": {
        "LLMMSG_HUB_PORT": "9701",
        "LLMMSG_HUB_HOST": "127.0.0.1"
      }
    }
  }
}
```

Or programmatically:
```bash
python3 -c "
import json
with open('$HOME/.claude.json', 'r') as f:
    d = json.load(f)
d.setdefault('mcpServers', {})['llmmsg-channel'] = {
    'command': 'node',
    'args': ['/opt/llmmsg/llmmsg-channel/channel.mjs'],
    'env': {'LLMMSG_HUB_PORT': '9701', 'LLMMSG_HUB_HOST': '127.0.0.1'}
}
with open('$HOME/.claude.json', 'w') as f:
    json.dump(d, f, indent=2)
"
```

**After adding the MCP config, restart the CC session.** The MCP server won't load until the session is restarted via `ccs.sh`.

### 6. Launch a session

Always use `ccs.sh` to launch sessions. It passes `--dangerously-load-development-channels server:llmmsg-channel` which is required for push notifications. Without this flag, MCP tools work but messages won't be delivered via push.

```bash
ccs.sh llmmsg-ccs
```

## Multi-site setup

Multi-site connects two or more hubs so agents on different machines can message each other.

### Architecture

```
Machine A (lezama)                    Machine B (whey)
  hub:9701  <--- SSH tunnel --->  hub:9701
  agents: *-l                     agents: *-w
```

Each hub stores messages locally and forwards to remote hubs when the recipient isn't local. An outbox table queues messages when the remote hub is unreachable, flushing every 30s.

### Network connectivity

The hubs need to reach each other. If machines aren't on the same network, use a reverse SSH tunnel:

```bash
# From whey, create a tunnel so lezama can reach whey's hub:
ssh -R 9702:127.0.0.1:9701 lezama

# Now lezama reaches whey's hub at 127.0.0.1:9702
```

For persistence, set up autossh or a systemd service for the tunnel.

### Configuration

Each site needs these environment variables in its systemd service file:

| Variable | Description | Example (lezama) | Example (whey) |
|----------|-------------|-------------------|-----------------|
| `LLMMSG_HUB_BIND` | Bind address | `0.0.0.0` | `0.0.0.0` |
| `LLMMSG_SITE` | Site name | `lezama` | `whey` |
| `LLMMSG_REMOTE_HUBS` | JSON map of remote hubs | `{"whey":"http://127.0.0.1:9702"}` | `{"lezama":"http://127.0.0.1:9702"}` |
| `LLMMSG_INBOUND_SECRET` | Shared secret (same on both) | `<shared-secret>` | `<shared-secret>` |
| `LLMMSG_SITE_SUFFIX` | Required agent name suffix | `-l` | `-w` |

Generate a shared secret:
```bash
openssl rand -hex 32
```

### systemd service file for multi-site

**Critical: JSON in systemd Environment= must be quoted with escaped inner quotes.**

Wrong (hub will parse the URL as individual characters):
```
Environment=LLMMSG_REMOTE_HUBS={"whey":"http://127.0.0.1:9702"}
```

Correct:
```
Environment="LLMMSG_REMOTE_HUBS={\"whey\":\"http://127.0.0.1:9702\"}"
```

Full example for lezama:
```ini
[Unit]
Description=llmmsg-channel hub server
After=network.target

[Service]
Type=simple
User=rob
Environment=HOME=/home/rob
Environment=LLMMSG_DB=/opt/llmmsg/db/llmmsg.sqlite
Environment=LLMMSG_HUB_PORT=9701
Environment=LLMMSG_HUB_BIND=0.0.0.0
Environment=LLMMSG_SITE=lezama
Environment="LLMMSG_REMOTE_HUBS={\"whey\":\"http://127.0.0.1:9702\"}"
Environment=LLMMSG_INBOUND_SECRET=<your-shared-secret>
Environment=LLMMSG_SITE_SUFFIX=-l
ExecStart=/usr/bin/node /opt/llmmsg/llmmsg-channel/hub.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

**Do not copy the service file directly from the repo** — use `sudo cp` from a temp file, or `setup.sh` which patches paths and usernames. Writing via heredoc + sudo pipe causes stdin conflicts (pipe feeds password to sudo, heredoc feeds content to tee — they compete for stdin).

### Applying the service file

```bash
# Write to temp file first, then copy
cp /opt/llmmsg/services/llmmsg-hub.service /tmp/llmmsg-hub.service
# Edit /tmp/llmmsg-hub.service with your site-specific values
sudo cp /tmp/llmmsg-hub.service /etc/systemd/system/llmmsg-hub.service
sudo systemctl daemon-reload
sudo systemctl restart llmmsg-hub
```

### Verification

```bash
# Check hub status
curl -s http://127.0.0.1:9701/status | python3 -m json.tool

# Verify remoteHubs shows the correct site names (not character indices)
# Good: "remoteHubs": ["whey"]
# Bad:  "remoteHubs": ["0","1","2",...] — JSON wasn't quoted properly

# Test cross-site send
curl -s -X POST http://127.0.0.1:9701/register \
  -H 'Content-Type: application/json' \
  -d '{"agent":"test-l","cwd":"/tmp"}'

curl -s -X POST http://127.0.0.1:9701/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"test-l","to":"some-agent-on-remote","message":{"message":"test"}}'

# Response should include "forwarded":true
# If remote is down: "queued":true (outbox will retry every 30s)
```

## Known gotchas

### 1. registrations.json must not be in git

This file (`codex-llmmsg-app/registrations.json`) contains per-machine Codex bridge state (thread IDs, suspension status). If it's committed and pulled to another machine, the hub will think remote agents are local Codex agents and skip forwarding.

It's in `.gitignore` now. If you have a stale copy from before, clear it:
```bash
echo '{}' > /opt/llmmsg/codex-llmmsg-app/registrations.json
```

### 2. MCP tools not loading

If the llmmsg MCP tools (register, send, read_unread, etc.) don't appear in a CC session:

1. Check `~/.claude.json` has the `mcpServers.llmmsg-channel` entry
2. Session must be launched with `ccs.sh` (provides `--dangerously-load-development-channels`)
3. Restart the session after adding the MCP config — it only loads at session start
4. Do NOT fall back to curl for messaging. Curl is for troubleshooting only.

### 3. better-sqlite3 native binary

The `better-sqlite3` package requires a compiled native addon. If the prebuilt binary doesn't match your Node version, you get `Could not locate the bindings file`. Fix:

```bash
cd /opt/llmmsg/llmmsg-channel
pnpm rebuild better-sqlite3
```

If pnpm blocks it, approve the build first (see step 2 above).

### 4. Hub crashes on startup with "Missing tables"

The hub no longer creates tables — `init-db.sh` is the single schema source. Run it first:
```bash
bash /opt/llmmsg/scripts/init-db.sh
```

### 5. Binding to 0.0.0.0 without a secret

The hub warns on startup if `LLMMSG_HUB_BIND` is not `127.0.0.1` and `LLMMSG_INBOUND_SECRET` is empty. The `/inbound` endpoint accepts unauthenticated messages in this state — anyone who can reach the port can inject messages as any sender. Always set a secret for multi-site.
