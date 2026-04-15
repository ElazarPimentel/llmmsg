#!/usr/bin/env bash
# setup.sh - Bootstrap llmmsg on a fresh machine
# Prerequisites: node >= 18, npm, sqlite3, systemd
# Run as the user who will own the services (not root), from the repo root.
VERSION="1.1"
echo "setup.sh v$VERSION"

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LLMMSG_USER="${LLMMSG_USER:-$(whoami)}"
LLMMSG_DB="${LLMMSG_DB:-$REPO_DIR/db/llmmsg.sqlite}"
LLMMSG_HUB_PORT="${LLMMSG_HUB_PORT:-9701}"

echo "Repo dir:  $REPO_DIR"
echo "User:      $LLMMSG_USER"
echo "DB path:   $LLMMSG_DB"
echo "Hub port:  $LLMMSG_HUB_PORT"
echo ""

# --- 1. Check prerequisites ---
echo "--- Checking prerequisites ---"
for cmd in node npm sqlite3 systemctl; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "ERROR: $cmd not found. Install it first." >&2
        exit 1
    fi
done

NODE_MAJOR=$(node -v | sed 's/v//' | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
    echo "ERROR: Node >= 18 required (found $(node -v))" >&2
    exit 1
fi
echo "node $(node -v), npm $(npm -v), sqlite3 $(sqlite3 --version | cut -d' ' -f1)"

# --- 1b. Check /etc/llmmsg/site.conf (MANDATORY for hub and launchers) ---
echo ""
echo "--- Checking host config /etc/llmmsg/site.conf ---"
if [[ ! -f /etc/llmmsg/site.conf ]]; then
    echo "ERROR: /etc/llmmsg/site.conf is required but missing." >&2
    echo "Install a template for this host, e.g.:" >&2
    HOSTNAME_LOWER="$(hostname | tr '[:upper:]' '[:lower:]')"
    TEMPLATE="$REPO_DIR/config-templates/site.conf.$HOSTNAME_LOWER"
    if [[ -f "$TEMPLATE" ]]; then
        echo "  sudo install -m 0644 -o root -g root $TEMPLATE /etc/llmmsg/site.conf" >&2
    else
        echo "  sudo mkdir -p /etc/llmmsg" >&2
        echo "  sudo tee /etc/llmmsg/site.conf <<EOF" >&2
        echo "  SITE_SUFFIX=-$HOSTNAME_LOWER   # or '' if no suffix" >&2
        echo "  LLMMSG_SITE=$HOSTNAME_LOWER" >&2
        echo "  LLMMSG_ARO_SEGMENT=0" >&2
        echo "  EOF" >&2
    fi
    exit 1
fi
echo "found /etc/llmmsg/site.conf"

# --- 2. Install npm dependencies ---
echo ""
echo "--- Installing npm dependencies ---"
(cd "$REPO_DIR/llmmsg-channel" && npm install --production)
(cd "$REPO_DIR/codex-llmmsg-app" && npm install --production)

# --- 3. Initialize DB ---
echo ""
echo "--- Initializing database ---"
if [[ -f "$LLMMSG_DB" ]]; then
    echo "DB already exists at $LLMMSG_DB - skipping init"
else
    LLMMSG_DB="$LLMMSG_DB" bash "$REPO_DIR/scripts/init-db.sh"
fi

# --- 4. Install systemd services ---
echo ""
echo "--- Installing systemd services ---"
echo "This step requires sudo."

SERVICES_DIR="$REPO_DIR/services"
for svc in llmmsg-hub.service llmmsg-bridge.service codex-app-server.service; do
    SRC="$SERVICES_DIR/$svc"
    DEST="/etc/systemd/system/$svc"

    if [[ ! -f "$SRC" ]]; then
        echo "WARNING: $SRC not found, skipping"
        continue
    fi

    # Patch User= and paths for current user/repo location
    PATCHED=$(sed \
        -e "s|User=rob|User=$LLMMSG_USER|g" \
        -e "s|/opt/llmmsg|$REPO_DIR|g" \
        -e "s|HOME=/home/rob|HOME=$HOME|g" \
        -e "s|WorkingDirectory=/home/rob|WorkingDirectory=$HOME|g" \
        -e "s|LLMMSG_DB=.*|LLMMSG_DB=$LLMMSG_DB|g" \
        -e "s|LLMMSG_HUB_PORT=.*|LLMMSG_HUB_PORT=$LLMMSG_HUB_PORT|g" \
        "$SRC")

    if [[ -f "$DEST" ]]; then
        echo "$svc already installed - skipping (remove $DEST to reinstall)"
    else
        echo "$PATCHED" | sudo tee "$DEST" > /dev/null
        echo "Installed $svc"
    fi
done

sudo systemctl daemon-reload

# --- 5. Configure CC MCP (claude.json) ---
echo ""
echo "--- Claude Code MCP config ---"
CLAUDE_JSON="$HOME/.claude.json"
if [[ -f "$CLAUDE_JSON" ]] && grep -q "llmmsg-channel" "$CLAUDE_JSON" 2>/dev/null; then
    echo "llmmsg-channel already in $CLAUDE_JSON - skipping"
else
    echo "Add this to $CLAUDE_JSON mcpServers section:"
    echo ""
    cat "$REPO_DIR/config-templates/claude-json-mcp-entry.json"
    echo ""
    echo "(Manual step - merge into your existing ~/.claude.json)"
fi

# --- 6. Configure Codex MCP (config.toml) ---
echo ""
echo "--- Codex MCP config ---"
CODEX_TOML="$HOME/.codex/config.toml"
if [[ -f "$CODEX_TOML" ]] && grep -q "llmmsg-channel" "$CODEX_TOML" 2>/dev/null; then
    echo "llmmsg-channel already in $CODEX_TOML - skipping"
else
    echo "Add this to $CODEX_TOML:"
    echo ""
    cat "$REPO_DIR/config-templates/codex-config-mcp-entry.toml"
    echo ""
    echo "(Manual step - merge into your existing ~/.codex/config.toml)"
fi

# --- 7. Install launchers ---
echo ""
echo "--- Launcher scripts ---"
echo "Launcher scripts are in $REPO_DIR/launchers/"
echo "  ccs.sh  - Claude Code session launcher"
echo "  cf.sh   - Codex session launcher (resume or new)"
echo "  cfn.sh  - Codex session launcher (always fresh)"
echo ""
echo "To use them, either:"
echo "  a) Add $REPO_DIR/launchers to your PATH"
echo "  b) Symlink them into an existing PATH directory"
echo "  c) Copy and customize for your environment"

# --- 8. Start services ---
echo ""
echo "--- Starting services ---"
echo "To start the hub (required):"
echo "  sudo systemctl enable --now llmmsg-hub"
echo ""
echo "To start the Codex bridge (optional, only if using Codex):"
echo "  sudo systemctl enable --now codex-app-server"
echo "  sudo systemctl enable --now llmmsg-bridge"
echo ""
echo "--- Setup complete ---"
echo "Smoke test: launch a CC session with ccs.sh, then register and send a test message."
