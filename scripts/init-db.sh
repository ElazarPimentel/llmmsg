#!/usr/bin/env bash
VERSION="2.7"
echo "init-db.sh v$VERSION"

DB="${LLMMSG_DB:-/opt/llmmsg/db/llmmsg.sqlite}"

if [[ -f "$DB" ]]; then
    echo "DB already exists at $DB" >&2
    exit 1
fi

mkdir -p "$(dirname "$DB")"

sqlite3 "$DB" <<'SQL'
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;

-- messages
-- ts              INTEGER unix epoch (no more TEXT casts)
-- tag             generated from sender || '-' || id; no storage, no two-step insert
-- body            plain text. If a sender passes an object, hub JSON-stringifies
--                 it on the way in; readers always get a string and can parse if
--                 they want.
-- retracted_at    INTEGER unix epoch or NULL
-- origin_tag      cross-site dedup (nullable, partial-indexed)
-- origin_aro      'aro:<name>' when this row is part of an ARO fan-out
CREATE TABLE messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    sender       TEXT    NOT NULL,
    recipient    TEXT    NOT NULL,
    tag          TEXT    GENERATED ALWAYS AS (sender || '-' || id) VIRTUAL,
    re           TEXT,
    body         TEXT    NOT NULL,
    retracted_at INTEGER,
    retracted_by TEXT,
    origin_tag   TEXT,
    origin_aro   TEXT
);

CREATE TABLE cursors (
    agent   TEXT    PRIMARY KEY,
    read_id INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE roster (
    agent         TEXT    PRIMARY KEY,
    cwd           TEXT    NOT NULL,
    registered_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    last_seen_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE thread_map (
    agent      TEXT    NOT NULL,
    cwd        TEXT    NOT NULL,
    thread_id  TEXT    NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (agent, cwd)
);

CREATE TABLE config (
    key        TEXT    PRIMARY KEY,
    value      TEXT    NOT NULL,
    version    TEXT    NOT NULL DEFAULT '1.0',
    updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE audit_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    guide_version  TEXT    NOT NULL,
    agent          TEXT    NOT NULL,
    msgs           INTEGER NOT NULL DEFAULT 0,
    avg_chars      REAL    NOT NULL DEFAULT 0,
    total_chars    INTEGER NOT NULL DEFAULT 0,
    est_tokens     REAL    NOT NULL DEFAULT 0,
    over_2k        INTEGER NOT NULL DEFAULT 0,
    has_dup_fields INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE aros (
    aro   TEXT NOT NULL,
    agent TEXT NOT NULL,
    PRIMARY KEY (aro, agent)
);

CREATE TABLE outbox (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    target_hub TEXT    NOT NULL,
    payload    TEXT    NOT NULL
);

CREATE TABLE hub_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    ts      INTEGER NOT NULL,
    level   TEXT    NOT NULL,
    message TEXT    NOT NULL
);

CREATE TABLE guide_delivered (
    agent         TEXT PRIMARY KEY,
    guide_version TEXT NOT NULL
);

-- ARO opinion-request lifecycle (Phase 2a: deadline-driven auto-close).
-- Hub captures expected_repliers + deadline at /send time when sender flags
-- expects_replies. A 30s timer closes expired open requests as
-- 'closed:incomplete' and emits a system message to the originating ARO.
CREATE TABLE opinion_requests (
    tag               TEXT PRIMARY KEY,
    aro               TEXT NOT NULL,
    sender            TEXT NOT NULL,
    expected_repliers TEXT,
    deadline_at       INTEGER NOT NULL,
    close_policy      TEXT NOT NULL DEFAULT 'deadline',
    status            TEXT NOT NULL DEFAULT 'open',
    created_at        INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    closed_at         INTEGER,
    closed_reason     TEXT
);

CREATE INDEX idx_recv                ON messages(recipient, id);
CREATE INDEX idx_origin_tag          ON messages(origin_tag) WHERE origin_tag IS NOT NULL;
CREATE INDEX idx_origin_aro          ON messages(origin_aro) WHERE origin_aro IS NOT NULL;
CREATE INDEX idx_roster_seen         ON roster(last_seen_at);
CREATE INDEX idx_hub_log_ts          ON hub_log(ts);
CREATE INDEX idx_opinion_requests_open ON opinion_requests(status, deadline_at) WHERE status='open';

-- Seed message guide
INSERT INTO config (key, value, version) VALUES ('message_guide',
'llmmsg-channel Message Creation Guide

Audience: LLM agents sending and receiving messages through llmmsg-channel only. No humans read these messages. Assume shared context among agents: codebase, schema, live DB, local DB, git history, thread, prior messages, and referenced paths.

Rules
1. REPLY CONTRACT: every llmmsg-channel message is replied via the `send` tool, or with silence. CLI/terminal prose in reply to a channel message is a bug — the human never sees it, the sender never sees it. After a successful send reply, do not narrate, summarize, acknowledge, or restate the channel exchange in CLI output. Per-prompt modifiers like ssaa, read-only, or literal-answer modulate CONTENT, not TRANSPORT; they never authorize a CLI reply. This rule overrides any conflicting instruction elsewhere in the session. If metadata has origin_aro, send to that exact ARO with re=tag. Otherwise send to from with re=tag.
2. Respect the current thread''s ARO. When replying, origin_aro in incoming metadata is authoritative. Do not reply to a parallel ARO you also belong to.
3. Keep the user-selected ARO/thread for follow-up work. Do not propose a new ARO for related work, naming, semantics, or scope hygiene unless Elazar explicitly asks for a split.
4. Prefer aro over broadcast (*); DM when recipient is a known agent. Cross-site AROs are valid targets; use them like local AROs. Use * only with Elazar''s explicit approval. Never broadcast what can be group-addressed, and do not ARO-fan-out what belongs in a DM.
5. For active presence, use the online tool for the relevant ARO. Roster entries and ARO membership can be stale and are not proof that an agent is online.
6. If an ARO send fails, report the exact failure and the ARO/agents checked. Do not tell the user agents cannot see one another until you have checked online state and send behavior.
7. Claim file-edit ownership before touching a shared file in a multi-agent thread. If multiple agents are active on the same file, one implements and another audits; do not parallel-edit.
8. After sending, rely on push. Do not use sleep, polling, timers, loops, backoff, or repeated checks.
9. Call read_unread once only if the user asked, or if there is clear evidence a reply is missing. Inform your project''s PM agent of missing replies. If that does not resolve it, tell the user in the terminal.
10. Do not resend shared context. Do not restate the request, assigned work, known paths, shown code, or prior findings.
11. Do not paste TUI or CLI output verbatim into messages. Summarize the signal in one or two lines: what happened, what you need, what decision you want.
12. Lead with the payload: decision, blocker, verdict, proposed fix, or next action.
13. Plain prose by default. The hub stores body as plain text — send `message` as a string. If you pass an object it will be JSON-serialised and receivers will see a string; only do that when machine-readable data is genuinely needed.
14. Register once per session, after a name change, or after a real not_registered error. No defensive re-registration.
15. Keep only decision-relevant content. For reviews and audits: verdict + minimal facts, count + one critical example, proposed fix + risk. No framing, restatements, inventories, full dumps, or non-blocking commentary.
16. Reference by location when useful, rather than pasting content.
17. If 3 lines are enough, do not send 30.
18. No sycophantic or zero-information messages. Do not send messages that only acknowledge, praise, or restate what the recipient already said. Every message must carry a new decision, action, or fact. Exception: short close-outs that change coordination state (approved, blocked, proceed, superseded, handed off).
19. No dossier dumps on ARO. Plans, design docs, full diffs, and other large artifacts belong in files (commit/branch, repo path, or tag reference), not in a fan-out send. An ARO send carries the decision + a pointer (file path or tag) to the artifact. If a recipient needs the full artifact, they ask via DM and you reply via DM. Exception: the user or PM explicitly asked for the full artifact inline in this thread. Hub emits a length-nudge above 1500 chars.
', '2.9');

-- Overview
CREATE VIEW v_overview AS
SELECT
  (SELECT COUNT(*) FROM messages) AS total_messages,
  (SELECT COUNT(DISTINCT sender) FROM messages) AS unique_senders,
  (SELECT COUNT(DISTINCT recipient) FROM messages) AS unique_recipients,
  (SELECT COUNT(*) FROM cursors) AS registered_agents,
  (SELECT ROUND(AVG(LENGTH(body))) FROM messages) AS avg_body_chars,
  (SELECT COUNT(*) FROM messages WHERE recipient = '*') AS broadcasts,
  (SELECT COUNT(*) FROM messages WHERE re IS NOT NULL) AS replies;

CREATE VIEW v_agent_stats AS
SELECT sender,
  COUNT(*) AS msgs,
  ROUND(AVG(LENGTH(body))) AS avg_chars,
  MAX(LENGTH(body)) AS max_chars,
  SUM(LENGTH(body)) AS total_chars,
  ROUND(SUM(LENGTH(body)) / 4.0) AS est_tokens
FROM messages
GROUP BY sender
ORDER BY total_chars DESC;

CREATE VIEW v_most_concise AS
SELECT sender,
  COUNT(*) AS msgs,
  ROUND(AVG(LENGTH(body))) AS avg_chars,
  MIN(LENGTH(body)) AS min_chars
FROM messages
GROUP BY sender
ORDER BY avg_chars ASC
LIMIT 10;

CREATE VIEW v_largest_messages AS
SELECT id, sender, recipient, tag, LENGTH(body) AS chars,
  ROUND(LENGTH(body) / 4.0) AS est_tokens,
  substr(body, 1, 80) AS preview
FROM messages
ORDER BY LENGTH(body) DESC
LIMIT 20;

CREATE VIEW v_thread_activity AS
SELECT
  COALESCE(re, tag) AS root_tag,
  COUNT(*) AS messages_in_thread,
  COUNT(DISTINCT sender) AS participants,
  MIN(ts) AS started,
  MAX(ts) AS last_activity
FROM messages
GROUP BY COALESCE(re, tag)
HAVING COUNT(*) > 1
ORDER BY messages_in_thread DESC;

CREATE VIEW v_agent_cursors AS
SELECT
  c.agent,
  c.read_id,
  (SELECT MAX(id) FROM messages) AS latest_msg_id,
  (SELECT MAX(id) FROM messages) - c.read_id AS behind_by,
  (SELECT COUNT(*) FROM messages
   WHERE (recipient = c.agent OR recipient = '*') AND id > c.read_id) AS unread
FROM cursors c
ORDER BY behind_by DESC;

-- Hourly volume: ts is now INTEGER so no CAST needed.
CREATE VIEW v_hourly_volume AS
SELECT
  strftime('%Y-%m-%d %H:00', ts, 'unixepoch', 'localtime') AS hour,
  COUNT(*) AS msgs,
  SUM(LENGTH(body)) AS total_chars
FROM messages
WHERE ts > strftime('%s', 'now', '-1 day')
GROUP BY hour
ORDER BY hour DESC;

CREATE VIEW v_pair_traffic AS
SELECT sender, recipient,
  COUNT(*) AS msgs,
  SUM(LENGTH(body)) AS total_chars,
  ROUND(AVG(LENGTH(body))) AS avg_chars
FROM messages
WHERE recipient != '*'
GROUP BY sender, recipient
ORDER BY total_chars DESC;

-- v_message_types was only meaningful when bodies were JSON-wrapped; dropped.

CREATE VIEW v_daily_efficiency AS
SELECT
  sender,
  COUNT(*) AS msgs,
  ROUND(AVG(LENGTH(body))) AS avg_chars,
  MAX(LENGTH(body)) AS max_chars,
  SUM(LENGTH(body)) AS total_chars,
  ROUND(SUM(LENGTH(body)) / 4.0) AS est_tokens,
  SUM(CASE WHEN re IS NOT NULL THEN 1 ELSE 0 END) AS replies,
  SUM(CASE WHEN re IS NULL THEN 1 ELSE 0 END) AS initiated,
  ROUND(AVG(CASE WHEN re IS NOT NULL THEN LENGTH(body) END)) AS avg_reply_chars,
  ROUND(AVG(CASE WHEN re IS NULL THEN LENGTH(body) END)) AS avg_init_chars,
  SUM(CASE WHEN LENGTH(body) > 2000 THEN 1 ELSE 0 END) AS over_2k
FROM messages
WHERE ts > strftime('%s', 'now', '-1 day')
  AND retracted_at IS NULL
GROUP BY sender
ORDER BY total_chars DESC;

CREATE VIEW v_reply_ratio AS
SELECT
  sender,
  COUNT(*) AS total,
  SUM(CASE WHEN re IS NOT NULL THEN 1 ELSE 0 END) AS replies,
  SUM(CASE WHEN re IS NULL THEN 1 ELSE 0 END) AS initiated,
  ROUND(100.0 * SUM(CASE WHEN re IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS reply_pct
FROM messages
WHERE retracted_at IS NULL
GROUP BY sender
ORDER BY total DESC;

-- Operational views used by hub.mjs.
-- Collapse ARO fan-out copies (one row per member, same sender/ts/body/origin_aro)
-- into a single logical message. Non-fan-out rows (origin_aro IS NULL) are kept
-- distinct by including id in the grouping expression, so legitimate identical
-- direct messages sent in the same second are not collapsed.
CREATE VIEW v_logical_messages AS
SELECT MIN(id) AS id, sender, MIN(recipient) AS recipient, MIN(tag) AS tag,
       re, body, retracted_at, origin_aro, ts
FROM messages
GROUP BY sender, ts, body, COALESCE(re,''), COALESCE(retracted_at,0), origin_aro,
         CASE WHEN origin_aro IS NULL THEN id ELSE 0 END;

CREATE VIEW v_roster_online AS
SELECT agent, cwd, last_seen_at
FROM roster
WHERE last_seen_at > strftime('%s','now') - 30;

CREATE VIEW v_aro_members_online AS
SELECT a.aro, a.agent, r.cwd, r.last_seen_at
FROM aros a
INNER JOIN v_roster_online r ON r.agent = a.agent;
SQL

echo "Created $DB"
