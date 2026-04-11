#!/usr/bin/env bash
# cf.sh - Codex session launcher with llmmsg integration (resume or new)
# Usage: cf.sh [label] [--thread-id ID] [codex options]
VERSION="2.5"
echo "cf.sh v$VERSION"

LABEL=""
if [[ -n "${1:-}" && ! "${1:-}" == --* ]]; then
    if [[ "$1" =~ ^[0-9]+$ ]]; then
        LABEL="#$1"
    else
        LABEL="${1,,}"
    fi
    shift
fi

# Auto-detect agent name from .agent-name file in CWD if no label given
if [[ -z "$LABEL" && -f "$(pwd -P)/.agent-name" ]]; then
    LABEL="$(head -1 "$(pwd -P)/.agent-name" | tr -d '[:space:]')"
fi

# If still no label, derive from CWD basename and create .agent-name
if [[ -z "$LABEL" ]]; then
    _dir_base="$(basename "$(pwd -P)")"
    if [[ "$_dir_base" == *-ccs ]]; then
        echo "cf.sh: This is a ccs folder" >&2
        exit 1
    elif [[ "$_dir_base" == *-ca ]]; then
        LABEL="$_dir_base"
    else
        LABEL="${_dir_base}-ca"
    fi
    echo "$LABEL" > "$(pwd -P)/.agent-name"
    echo "cf.sh: Created .agent-name with '$LABEL'"
fi

THREAD_ID=""
PASSTHRU=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --thread-id)
            if [[ -z "${2:-}" ]]; then
                echo "cf.sh: --thread-id requires a value" >&2
                exit 1
            fi
            THREAD_ID="$2"
            shift 2
            ;;
        *)
            PASSTHRU+=("$1")
            shift
            ;;
    esac
done
set -- "${PASSTHRU[@]}"

WORKDIR="$(pwd -P)"
export LLMMSG_AGENT="${LABEL:-$(basename "$WORKDIR")}"
export LLMMSG_CWD="$WORKDIR"
TITLE_NAME="$LLMMSG_AGENT"

# Set terminal title
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
if [[ -x "$SCRIPT_DIR/title.sh" ]]; then
    "$SCRIPT_DIR/title.sh" "$TITLE_NAME ┃ ($(hostname))" --codex
elif command -v title.sh &>/dev/null; then
    title.sh "$TITLE_NAME ┃ ($(hostname))" --codex
else
    printf '\033]0;%s\007' "$TITLE_NAME ┃ ($(hostname))"
fi

THREAD_DB="$HOME/.codex/state_5.sqlite"
THREAD_MAP_SHIM="/opt/llmmsg/codex-llmmsg-app/cf-thread-map.mjs"
BRIDGE_SHIM="/opt/llmmsg/codex-llmmsg-app/bridge.mjs"
REGISTER_PID=""
WATCH_PID=""

sql_escape() {
    printf "%s" "$1" | sed "s/'/''/g"
}

get_mapped_thread_id() {
    [[ -f "$THREAD_MAP_SHIM" ]] || return 0
    [[ -n "$LABEL" ]] || return 0
    node "$THREAD_MAP_SHIM" get "$LABEL" "$WORKDIR" 2>/dev/null
}

store_thread_id() {
    [[ -f "$THREAD_MAP_SHIM" ]] || return 0
    [[ -n "$LABEL" ]] || return 0
    [[ -n "${1:-}" ]] || return 0
    node "$THREAD_MAP_SHIM" put "$LABEL" "$WORKDIR" "$1" >/dev/null 2>&1
}

find_bootstrap_thread_id() {
    [[ -f "$THREAD_DB" ]] || return 0
    [[ -n "$LABEL" ]] || return 0

    local label_sql cwd_sql agent_prompt
    label_sql="$(sql_escape "$LABEL")"
    cwd_sql="$(sql_escape "$WORKDIR")"
    agent_prompt="$(sql_escape "Your agent name is $LABEL.")"
    sqlite3 "$THREAD_DB" \
        "SELECT id FROM threads
         WHERE archived = 0
           AND cwd = '$cwd_sql'
           AND (
             title = '$label_sql'
             OR first_user_message LIKE '%$agent_prompt%'
           )
         ORDER BY updated_at DESC LIMIT 1;"
}

register_exact_thread() {
    [[ -n "$LABEL" ]] || return 0
    [[ -f "$BRIDGE_SHIM" ]] || return 0
    [[ -n "${1:-}" ]] || return 0

    (
        for _ in $(seq 1 10); do
            node "$BRIDGE_SHIM" register "$LABEL" --thread-id "$1" </dev/null >/dev/null 2>&1 && exit 0
            sleep 1
        done
    ) &
    REGISTER_PID=$!
    disown "$REGISTER_PID" 2>/dev/null
}

watch_and_register_new_thread() {
    [[ -n "$LABEL" ]] || return 0
    [[ -f "$THREAD_MAP_SHIM" ]] || return 0

    local baseline_json
    baseline_json="$(node "$THREAD_MAP_SHIM" loaded 2>/dev/null || printf '[]')"
    node "$THREAD_MAP_SHIM" watch "$LABEL" "$WORKDIR" "$baseline_json" 20000 </dev/null >/dev/null 2>&1 &
    WATCH_PID=$!
    disown "$WATCH_PID" 2>/dev/null
}

APP_SERVER_URL="ws://127.0.0.1:8788"
HEALTH_URL="http://127.0.0.1:8788/readyz"

if ! curl -sf "$HEALTH_URL" >/dev/null 2>&1; then
    echo "cf.sh: Codex App Server is not running (expected at $APP_SERVER_URL)" >&2
    echo "cf.sh: Start it with: sudo systemctl start codex-app-server" >&2
    exit 1
fi

REMOTE_ARGS=(--remote "$APP_SERVER_URL")
for arg in "$@"; do
    if [[ "$arg" == "--remote" ]]; then
        REMOTE_ARGS=()
        break
    fi
done

REMOTE_THREAD_ID="$THREAD_ID"
if [[ -z "$REMOTE_THREAD_ID" ]]; then
    REMOTE_THREAD_ID="$(get_mapped_thread_id)"
fi
if [[ -z "$REMOTE_THREAD_ID" ]]; then
    REMOTE_THREAD_ID="$(find_bootstrap_thread_id)"
fi
if [[ -n "$REMOTE_THREAD_ID" ]]; then
    store_thread_id "$REMOTE_THREAD_ID"
    register_exact_thread "$REMOTE_THREAD_ID"
    SET_CWD_SHIM="/opt/llmmsg/codex-llmmsg-app/set-thread-cwd.mjs"
    if [[ -f "$SET_CWD_SHIM" ]]; then
        node "$SET_CWD_SHIM" "$REMOTE_THREAD_ID" "$WORKDIR" "$APP_SERVER_URL" >/dev/null 2>&1
    fi
fi

CWD_PROMPT="Your working directory is $WORKDIR - run cd $WORKDIR before any file operations."
CODEX_CMD=(
    codex
    -c 'tui.terminal_title=[]'
    -c 'approval_policy="never"'
    -c 'sandbox_mode="danger-full-access"'
)
if [[ -n "$REMOTE_THREAD_ID" ]]; then
    CODEX_CMD+=(resume "$REMOTE_THREAD_ID" -C "$WORKDIR" --search --dangerously-bypass-approvals-and-sandbox)
elif [[ -n "$LABEL" ]]; then
    watch_and_register_new_thread
    CODEX_CMD+=(-C "$WORKDIR" --search --dangerously-bypass-approvals-and-sandbox)
    CODEX_CMD+=("${REMOTE_ARGS[@]}")
    CODEX_CMD+=("$@")
    CODEX_CMD+=(-- "$CWD_PROMPT Your agent name is $LABEL.")
    "${CODEX_CMD[@]}"
    STATUS=$?
    kill "$WATCH_PID" 2>/dev/null || true
    wait "$WATCH_PID" 2>/dev/null || true
    kill "$REGISTER_PID" 2>/dev/null || true
    wait "$REGISTER_PID" 2>/dev/null || true
    exit "$STATUS"
else
    CODEX_CMD+=(-C "$WORKDIR" --search --dangerously-bypass-approvals-and-sandbox)
    CODEX_CMD+=("${REMOTE_ARGS[@]}")
    CODEX_CMD+=("$@")
    CODEX_CMD+=(-- "$CWD_PROMPT")
    "${CODEX_CMD[@]}"
    exit $?
fi

CODEX_CMD+=("${REMOTE_ARGS[@]}")
CODEX_CMD+=("$@")
"${CODEX_CMD[@]}"
STATUS=$?
kill "$WATCH_PID" 2>/dev/null || true
wait "$WATCH_PID" 2>/dev/null || true
kill "$REGISTER_PID" 2>/dev/null || true
wait "$REGISTER_PID" 2>/dev/null || true
exit "$STATUS"
