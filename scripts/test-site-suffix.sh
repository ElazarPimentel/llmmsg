#!/usr/bin/env bash
# llmmsg-ecosystem
# test-site-suffix.sh - regression tests for task #11 site-suffix fix.
# Tests the shared launcher helper (scripts/lib/resolve-agent-name.sh) and
# the hub's site.conf loading path. Uses LLMMSG_SITE_CONF=<tmp> overrides so
# it never touches /etc/llmmsg/site.conf or any live state.
# See /opt/llmmsg/ECOSYSTEM.md
VERSION="1.0"
echo "test-site-suffix.sh v$VERSION"

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

HELPER="/opt/llmmsg/scripts/lib/resolve-agent-name.sh"
HUB="/opt/llmmsg/llmmsg-channel/hub.mjs"
PASS=0
FAIL=0
FAILED_TESTS=()

# ---------- helpers ----------

_tmpdir() { mktemp -d -t llmmsg-test-XXXXXX; }

_write_site_conf() {
    # $1 = path, $2 = suffix, $3 = site name, $4 = aro segment
    cat > "$1" <<EOF
SITE_SUFFIX=$2
LLMMSG_SITE=$3
LLMMSG_ARO_SEGMENT=$4
EOF
}

_run_helper_in_dir() {
    # $1 = ORIGINAL_CWD, $2 = site.conf path, $3 = kind (cc|ca), rest = helper args
    local dir="$1" conf="$2" kind="$3"
    shift 3
    (
        cd "$dir" || exit 1
        unset LABEL AGENT_NAME LLMMSG_AGENT LLMMSG_SITE_SUFFIX
        export LLMMSG_SITE_CONF="$conf"
        export ORIGINAL_CWD="$dir"
        source "$HELPER"
        load_site_conf
        resolve_agent_label "$kind" "$@"
    )
}

_assert_exit() {
    # $1 = label, $2 = expected exit code, $3 = actual exit code
    if [[ "$3" != "$2" ]]; then
        echo "  FAIL: $1 — expected exit $2, got $3"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$1")
        return 1
    fi
    return 0
}

_assert_contains() {
    # $1 = label, $2 = expected substring, $3 = actual string
    if [[ "$3" != *"$2"* ]]; then
        echo "  FAIL: $1 — expected output to contain '$2', got: $3"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("$1")
        return 1
    fi
    return 0
}

_pass() {
    echo "  PASS: $1"
    PASS=$((PASS + 1))
}

# ---------- tests ----------

test_fresh_folder_auto_create() {
    echo "[1] test_fresh_folder_auto_create"
    local tmp conf cwd
    tmp="$(_tmpdir)"
    conf="$tmp/site.conf"
    cwd="$tmp/my-project"
    mkdir -p "$cwd"
    _write_site_conf "$conf" "-l" "lezama" "1"
    local out rc
    out="$(_run_helper_in_dir "$cwd" "$conf" cc 2>&1)" ; rc=$?
    _assert_exit "fresh_auto_create exit" 0 "$rc" || { trash "$tmp"; return; }
    _assert_contains "fresh_auto_create label" "my-project-l" "$out" || { trash "$tmp"; return; }
    [[ -f "$cwd/.agent-name-cc" ]] || {
        echo "  FAIL: .agent-name-cc not created"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("fresh_auto_create file written")
        trash "$tmp"
        return
    }
    local file_content
    file_content="$(cat "$cwd/.agent-name-cc")"
    [[ "$file_content" == "my-project-l" ]] || {
        echo "  FAIL: .agent-name-cc content is '$file_content', expected 'my-project-l'"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("fresh_auto_create file content")
        trash "$tmp"
        return
    }
    _pass "fresh_auto_create"
    trash "$tmp"
}

test_env_wrong_suffix_hard_error() {
    echo "[2] test_env_wrong_suffix_hard_error"
    local tmp conf cwd
    tmp="$(_tmpdir)"
    conf="$tmp/site.conf"
    cwd="$tmp/work"
    mkdir -p "$cwd"
    _write_site_conf "$conf" "-l" "lezama" "1"
    local out rc
    out="$( (cd "$cwd" &&env -i PATH="$PATH" HOME="$HOME" LLMMSG_SITE_CONF="$conf" LLMMSG_AGENT="work-without-suffix" ORIGINAL_CWD="$cwd" bash -c "source $HELPER; load_site_conf; resolve_agent_label cc") 2>&1 )" ; rc=$?
    _assert_exit "env_wrong_suffix exit nonzero" 1 "$rc" || { trash "$tmp"; return; }
    _assert_contains "env_wrong_suffix error msg" "does not have required suffix" "$out" || { trash "$tmp"; return; }
    _assert_contains "env_wrong_suffix fix line" "echo" "$out" || { trash "$tmp"; return; }
    _pass "env_wrong_suffix"
    trash "$tmp"
}

test_stale_file_hard_error() {
    echo "[3] test_stale_file_hard_error"
    local tmp conf cwd
    tmp="$(_tmpdir)"
    conf="$tmp/site.conf"
    cwd="$tmp/pluto-pm-ccs"
    mkdir -p "$cwd"
    _write_site_conf "$conf" "-l" "lezama" "1"
    echo "pluto-pm-ccs" > "$cwd/.agent-name-cc"  # stale, no -l suffix
    local out rc
    out="$(_run_helper_in_dir "$cwd" "$conf" cc 2>&1)" ; rc=$?
    _assert_exit "stale_file exit nonzero" 1 "$rc" || { trash "$tmp"; return; }
    _assert_contains "stale_file error msg" "does not have required suffix" "$out" || { trash "$tmp"; return; }
    _assert_contains "stale_file fix command" ".agent-name-cc" "$out" || { trash "$tmp"; return; }
    _pass "stale_file_hard_error"
    trash "$tmp"
}

test_missing_config_hard_error() {
    echo "[4] test_missing_config_hard_error"
    local tmp cwd
    tmp="$(_tmpdir)"
    cwd="$tmp/any"
    mkdir -p "$cwd"
    # Point at a non-existent conf file
    local out rc
    out="$( (cd "$cwd" && env -i PATH="$PATH" HOME="$HOME" LLMMSG_SITE_CONF="$tmp/NOPE" ORIGINAL_CWD="$cwd" bash -c "source $HELPER; load_site_conf") 2>&1 )" ; rc=$?
    _assert_exit "missing_conf exit nonzero" 1 "$rc" || { trash "$tmp"; return; }
    _assert_contains "missing_conf error launcher" "missing host config" "$out" || { trash "$tmp"; return; }

    # Hub startup path
    local hub_out hub_rc
    hub_out="$(LLMMSG_SITE_CONF="$tmp/NOPE" LLMMSG_HUB_PORT=9798 LLMMSG_DB=/tmp/nope-hub.sqlite timeout 3 node -e "import('$HUB').catch(e => console.error(e.message));" 2>&1)" ; hub_rc=$?
    _assert_contains "missing_conf error hub" "missing host config" "$hub_out" || { trash "$tmp"; return; }
    _pass "missing_config_hard_error"
    trash "$tmp"
}

test_worktree_original_cwd() {
    echo "[5] test_worktree_original_cwd"
    local tmp conf real_cwd worktree_cwd
    tmp="$(_tmpdir)"
    conf="$tmp/site.conf"
    real_cwd="$tmp/main-project"
    worktree_cwd="$tmp/worktree-clone"
    mkdir -p "$real_cwd" "$worktree_cwd"
    _write_site_conf "$conf" "-l" "lezama" "1"
    # Simulate: launcher captured ORIGINAL_CWD=main-project but process cwd is worktree-clone
    local out rc
    out="$( (cd "$worktree_cwd" && env -i PATH="$PATH" HOME="$HOME" LLMMSG_SITE_CONF="$conf" ORIGINAL_CWD="$real_cwd" bash -c "source $HELPER; load_site_conf; resolve_agent_label cc") 2>&1 )" ; rc=$?
    _assert_exit "worktree exit" 0 "$rc" || { trash "$tmp"; return; }
    _assert_contains "worktree label" "main-project-l" "$out" || { trash "$tmp"; return; }
    [[ -f "$real_cwd/.agent-name-cc" ]] || {
        echo "  FAIL: .agent-name-cc should be in real_cwd, not worktree_cwd"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("worktree file location")
        trash "$tmp"
        return
    }
    [[ ! -f "$worktree_cwd/.agent-name-cc" ]] || {
        echo "  FAIL: .agent-name-cc should NOT be in worktree_cwd"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("worktree file location neg")
        trash "$tmp"
        return
    }
    _pass "worktree_original_cwd"
    trash "$tmp"
}

test_cli_agent_wrong_suffix_no_bridge_write() {
    echo "[6] test_cli_agent_wrong_suffix_no_bridge_write"
    local tmp conf cwd fake_bridge
    tmp="$(_tmpdir)"
    conf="$tmp/site.conf"
    cwd="$tmp/pluto"
    fake_bridge="$tmp/registrations.json"
    mkdir -p "$cwd"
    _write_site_conf "$conf" "-l" "lezama" "1"
    echo '{}' > "$fake_bridge"
    local bridge_mtime_before
    bridge_mtime_before="$(stat -c %Y "$fake_bridge")"

    # LABEL passed explicitly via CLI but wrong suffix
    local out rc
    out="$( (cd "$cwd" && env -i PATH="$PATH" HOME="$HOME" LABEL="pluto-pm-ccs" LLMMSG_SITE_CONF="$conf" ORIGINAL_CWD="$cwd" bash -c "source $HELPER; load_site_conf; resolve_agent_label ca") 2>&1 )" ; rc=$?
    _assert_exit "cli_wrong_suffix exit nonzero" 1 "$rc" || { trash "$tmp"; return; }
    _assert_contains "cli_wrong_suffix error" "does not have required suffix" "$out" || { trash "$tmp"; return; }

    # Verify bridge registrations.json was NOT modified
    local bridge_mtime_after
    bridge_mtime_after="$(stat -c %Y "$fake_bridge")"
    [[ "$bridge_mtime_before" == "$bridge_mtime_after" ]] || {
        echo "  FAIL: registrations.json was modified despite validation failure"
        FAIL=$((FAIL + 1))
        FAILED_TESTS+=("cli_wrong_suffix bridge write")
        trash "$tmp"
        return
    }
    _pass "cli_wrong_suffix_no_bridge_write"
    trash "$tmp"
}

# ---------- main ----------

run_all() {
    test_fresh_folder_auto_create
    test_env_wrong_suffix_hard_error
    test_stale_file_hard_error
    test_missing_config_hard_error
    test_worktree_original_cwd
    test_cli_agent_wrong_suffix_no_bridge_write
}

main() {
    if [[ $# -gt 0 ]]; then
        for fn in "$@"; do "$fn"; done
    else
        run_all
    fi
    echo ""
    echo "Results: $PASS passed, $FAIL failed"
    if [[ $FAIL -gt 0 ]]; then
        echo "Failed tests:"
        for t in "${FAILED_TESTS[@]}"; do echo "  - $t"; done
        exit 1
    fi
    exit 0
}

main "$@"
