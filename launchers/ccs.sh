#!/bin/bash
# ccs.sh - Claude Code session launcher with llmmsg integration
# Usage: ccs.sh [--nocont] [--agent NAME] [label] [claude options]
VERSION="3.7"

if [[ "$1" == "-h" ]]; then
    echo "ccs.sh v$VERSION - Claude Code session launcher"
    echo "  ccs.sh                  Continue last session (default)"
    echo "  ccs.sh 583              Continue session, set terminal title to ticket #583"
    echo "  ccs.sh --nocont         Start fresh session"
    echo "  ccs.sh --nocont 583     Fresh session with ticket #583 in title"
    echo "  ccs.sh --agent NAME     Set agent name for llmmsg channel messaging"
    echo "  ccs.sh [claude opts]    Pass any claude CLI options through"
    exit 0
fi

FLAGS="-c --dangerously-skip-permissions"
EXTRA_FLAGS=""
AGENT_NAME=""

while [[ "${1:-}" == --* ]]; do
    case "$1" in
        --nocont) FLAGS="--dangerously-skip-permissions"; shift ;;
        --agent) AGENT_NAME="$2"; shift 2 ;;
        *) break ;;
    esac
done

# First non-flag arg = name or ticket number
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
if [[ -z "$LABEL" && -f "$(pwd)/.agent-name" ]]; then
    LABEL="$(head -1 "$(pwd)/.agent-name" | tr -d '[:space:]')"
fi

TITLE_NAME="${LABEL:-$(basename "$(pwd)")}"

# Set terminal title if title.sh is available
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
if [[ -x "$SCRIPT_DIR/title.sh" ]]; then
    "$SCRIPT_DIR/title.sh" "$TITLE_NAME ┃ ($(hostname))" --claude
elif command -v title.sh &>/dev/null; then
    title.sh "$TITLE_NAME ┃ ($(hostname))" --claude
else
    printf '\033]0;%s\007' "$TITLE_NAME ┃ ($(hostname))"
fi

# llmmsg-channel: set agent name and enable development channels for push delivery
LLMMSG_AGENT="${AGENT_NAME:-${LABEL:-$(basename "$(pwd)")}}"
export LLMMSG_AGENT="${LLMMSG_AGENT,,}"
export LLMMSG_CWD="$(pwd)"
# REQUIRED: without this flag, CC loads channel.mjs as a regular MCP server and
# notifications/claude/channel push is silently ignored. Do NOT remove.
EXTRA_FLAGS="$EXTRA_FLAGS --dangerously-load-development-channels server:llmmsg-channel"

if [[ "$FLAGS" == *"-c"* ]]; then
    claude $FLAGS $EXTRA_FLAGS "$@" 2>/dev/null \
        || exec claude --dangerously-skip-permissions $EXTRA_FLAGS "$@"
else
    exec claude $FLAGS $EXTRA_FLAGS "$@"
fi
