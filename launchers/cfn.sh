#!/usr/bin/env bash
# cfn.sh - Codex wrapper, always fresh session (no resume)
# Usage: cfn.sh [label] [codex options]
VERSION="1.9"
echo "cfn.sh v$VERSION"

LABEL=""
if [[ -n "${1:-}" && ! "${1:-}" == --* ]]; then
    if [[ "$1" =~ ^[0-9]+$ ]]; then
        LABEL="#$1"
    else
        LABEL="${1,,}"
    fi
    shift
fi
export LLMMSG_AGENT="${LABEL:-$(basename "$(pwd)")}"
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

CWD_PROMPT="Your working directory is $PWD - run cd $PWD before any file operations."
if [[ -n "$LABEL" ]]; then
    exec codex -c 'tui.terminal_title=[]' -C "$PWD" --search --dangerously-bypass-approvals-and-sandbox "$@" -- "$CWD_PROMPT Your agent name is $LABEL."
else
    exec codex -c 'tui.terminal_title=[]' -C "$PWD" --search --dangerously-bypass-approvals-and-sandbox "$@" -- "$CWD_PROMPT"
fi
