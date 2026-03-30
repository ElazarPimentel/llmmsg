#!/usr/bin/env bash
set -euo pipefail

URL="${CODEX_APP_SERVER_URL:-ws://127.0.0.1:8788}"
exec codex app-server --listen "$URL"
