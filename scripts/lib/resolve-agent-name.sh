# llmmsg-ecosystem
# resolve-agent-name.sh - shared launcher helper for agent name resolution.
# Sourced by ccs.sh, ccnewnohistory.sh, cf.sh, cffresh.sh.
# See /opt/llmmsg/ECOSYSTEM.md
#
# Exports no variables by itself. Provides functions:
#   load_site_conf            — reads ${LLMMSG_SITE_CONF:-/etc/llmmsg/site.conf}
#                               and sets SITE_SUFFIX, LLMMSG_SITE, LLMMSG_ARO_SEGMENT.
#                               Hard-errors if the file is missing.
#                               Env var LLMMSG_SITE_SUFFIX overrides the file value
#                               (used for testing). LLMMSG_SITE and LLMMSG_ARO_SEGMENT
#                               env vars are NOT overridden by this helper; the hub
#                               handles those overrides independently.
#
#   resolve_agent_label KIND [--dry-run]
#                             — KIND is 'cc' or 'ca'. Resolves the effective
#                               agent label following this strict priority:
#                                 1. $LABEL (set by caller from --agent or positional)
#                                 2. .agent-name-{cc|ca} in ORIGINAL_CWD
#                                 3. LLMMSG_AGENT env var
#                                 4. basename of ORIGINAL_CWD
#                               Validates the final label against SITE_SUFFIX.
#                               Auto-creates .agent-name-{cc|ca} in ORIGINAL_CWD
#                               when the file is missing, UNLESS --dry-run.
#                               Echoes the effective label on stdout.
#                               Exits non-zero with a clear error + fix command
#                               on validation failure or missing site.conf.
#
# Caller contract:
#   - Must `source` this file before calling any function.
#   - Must set ORIGINAL_CWD to the real working directory before calling
#     resolve_agent_label (capture BEFORE any --worktree chdir).
#   - May pre-seed $LABEL with an explicit CLI value; function will honor it.
#   - Must NOT export SITE_SUFFIX before calling load_site_conf; use
#     LLMMSG_SITE_SUFFIX for the only supported per-var override.

_llmmsg_die() {
    echo "error: $1" >&2
    [[ -n "${2:-}" ]] && echo "fix:   $2" >&2
    exit 1
}

load_site_conf() {
    local conf="${LLMMSG_SITE_CONF:-/etc/llmmsg/site.conf}"
    if [[ ! -f "$conf" ]]; then
        _llmmsg_die \
            "missing host config: $conf" \
            "sudo install -m 0644 -o root -g root /opt/llmmsg/config-templates/site.conf.<hostname> $conf"
    fi

    # Parse key=value lines manually. Comments with #. Ignore unknown keys.
    # Do NOT shell-source untrusted file content; parse explicitly.
    local line key val
    SITE_SUFFIX="${SITE_SUFFIX:-}"
    LLMMSG_SITE="${LLMMSG_SITE:-}"
    LLMMSG_ARO_SEGMENT="${LLMMSG_ARO_SEGMENT:-0}"
    while IFS= read -r line; do
        line="${line%%#*}"                    # strip comments
        line="${line#"${line%%[![:space:]]*}"}"  # ltrim
        line="${line%"${line##*[![:space:]]}"}"  # rtrim
        [[ -z "$line" ]] && continue
        key="${line%%=*}"
        val="${line#*=}"
        # Strip surrounding quotes from val if present
        val="${val%\"}"; val="${val#\"}"
        val="${val%\'}"; val="${val#\'}"
        case "$key" in
            SITE_SUFFIX)       : "${LLMMSG_SITE_SUFFIX_ENV:=${LLMMSG_SITE_SUFFIX:-__unset__}}"; SITE_SUFFIX="$val" ;;
            LLMMSG_SITE)       LLMMSG_SITE="$val" ;;
            LLMMSG_ARO_SEGMENT) LLMMSG_ARO_SEGMENT="$val" ;;
            *)                 ;;
        esac
    done < "$conf"

    # Env var override: LLMMSG_SITE_SUFFIX in env beats file (for testing/emergency)
    if [[ -n "${LLMMSG_SITE_SUFFIX+x}" && "${LLMMSG_SITE_SUFFIX_ENV:-__unset__}" != "__unset__" ]]; then
        SITE_SUFFIX="$LLMMSG_SITE_SUFFIX"
    fi

    # Site suffix is defined (may be empty). Mark as loaded.
    _LLMMSG_SITE_CONF_LOADED=1
}

# Check whether $1 has the required site suffix (empty suffix accepts anything).
_llmmsg_label_valid() {
    local label="$1"
    [[ -z "$SITE_SUFFIX" ]] && return 0
    [[ "$label" == *"$SITE_SUFFIX" ]]
}

# Compute the default label for a fresh folder: <basename><suffix>, avoiding
# double-suffix if basename already ends with it.
_llmmsg_default_label() {
    local base="$1"
    if [[ -n "$SITE_SUFFIX" && "$base" != *"$SITE_SUFFIX" ]]; then
        printf '%s%s' "$base" "$SITE_SUFFIX"
    else
        printf '%s' "$base"
    fi
}

resolve_agent_label() {
    local kind="" dry_run=0
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --dry-run) dry_run=1; shift ;;
            cc|ca)     kind="$1"; shift ;;
            *)         _llmmsg_die "resolve_agent_label: unknown arg '$1'" ;;
        esac
    done
    [[ -z "$kind" ]] && _llmmsg_die "resolve_agent_label: missing kind (cc|ca)"
    [[ -z "${_LLMMSG_SITE_CONF_LOADED:-}" ]] && _llmmsg_die "resolve_agent_label: call load_site_conf first"
    [[ -z "${ORIGINAL_CWD:-}" ]] && _llmmsg_die "resolve_agent_label: ORIGINAL_CWD not set"

    local file="$ORIGINAL_CWD/.agent-name-$kind"
    local legacy="$ORIGINAL_CWD/.agent-name"
    local label_source="" label="${LABEL:-}"
    [[ -n "$label" ]] && label_source="cli"

    if [[ -z "$label" && -f "$file" ]]; then
        label="$(head -1 "$file" | tr -d '[:space:]')"
        label_source="file"
    elif [[ -z "$label" && -f "$legacy" ]]; then
        local legacy_content fixed_legacy_label
        legacy_content="$(head -1 "$legacy" | tr -d '[:space:]')"
        fixed_legacy_label="$(_llmmsg_default_label "${legacy_content,,}")"
        _llmmsg_die \
            "legacy .agent-name found at $legacy; split files .agent-name-{cc,ca} are canonical" \
            "trash '$legacy' && echo '$fixed_legacy_label' > '$file'"
    fi

    if [[ -z "$label" && -n "${LLMMSG_AGENT:-}" ]]; then
        label="$LLMMSG_AGENT"
        label_source="env"
    fi

    if [[ -z "$label" ]]; then
        label="$(_llmmsg_default_label "$(basename "$ORIGINAL_CWD")")"
        label_source="basename"
    fi

    # Lowercase
    label="${label,,}"

    # Validate against suffix
    if ! _llmmsg_label_valid "$label"; then
        local fixed_label
        fixed_label="$(_llmmsg_default_label "$label")"
        _llmmsg_die \
            "agent name '$label' (from $label_source) does not have required suffix '$SITE_SUFFIX' for site '$LLMMSG_SITE'" \
            "echo '$fixed_label' > '$file'"
    fi

    # Auto-create on miss (not in dry-run).
    if [[ "$dry_run" -eq 0 && ! -f "$file" ]]; then
        case "$label_source" in
            basename|env)
                echo "$label" > "$file"
                echo "resolve-agent-name: created $file with '$label' (source: $label_source)" >&2
                ;;
        esac
    fi

    printf '%s' "$label"
}
