#!/usr/bin/env bash
VERSION="1.3"
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

CREATE TABLE messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        TEXT    NOT NULL DEFAULT (strftime('%s','now')),
    sender    TEXT    NOT NULL,
    recipient TEXT    NOT NULL,
    tag       TEXT    NOT NULL UNIQUE,
    re        TEXT,
    body      TEXT    NOT NULL,
    retracted_at TEXT,
    retracted_by TEXT
);

CREATE TABLE cursors (
    agent        TEXT    PRIMARY KEY,
    last_id      INTEGER NOT NULL DEFAULT 0,
    delivered_id INTEGER NOT NULL DEFAULT 0,
    read_id      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE roster (
    agent         TEXT PRIMARY KEY,
    cwd           TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE thread_map (
    agent      TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (agent, cwd)
);

CREATE TABLE poll_state (
    agent      TEXT PRIMARY KEY,
    empty_since TEXT
);

CREATE TABLE aros (
    aro   TEXT NOT NULL,
    agent TEXT NOT NULL,
    PRIMARY KEY (aro, agent)
);

CREATE INDEX idx_recv ON messages(recipient, id);

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

-- Per-agent stats: volume, verbosity, token estimate
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

-- Most concise agents
CREATE VIEW v_most_concise AS
SELECT sender,
  COUNT(*) AS msgs,
  ROUND(AVG(LENGTH(body))) AS avg_chars,
  MIN(LENGTH(body)) AS min_chars
FROM messages
GROUP BY sender
ORDER BY avg_chars ASC
LIMIT 10;

-- Largest individual messages
CREATE VIEW v_largest_messages AS
SELECT id, sender, recipient, tag, LENGTH(body) AS chars,
  ROUND(LENGTH(body) / 4.0) AS est_tokens,
  COALESCE(json_extract(body, '$.summary'), json_extract(body, '$.message'), json_extract(body, '$.text')) AS preview
FROM messages
ORDER BY LENGTH(body) DESC
LIMIT 20;

-- Thread activity
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

-- Agent cursor status: how far behind each agent is
CREATE VIEW v_agent_cursors AS
SELECT
  c.agent,
  c.last_id,
  (SELECT MAX(id) FROM messages) AS latest_msg_id,
  (SELECT MAX(id) FROM messages) - c.last_id AS behind_by,
  (SELECT COUNT(*) FROM messages
   WHERE (recipient = c.agent OR recipient = '*') AND id > c.last_id) AS unread
FROM cursors c
ORDER BY behind_by DESC;

-- Hourly volume (last 24h)
CREATE VIEW v_hourly_volume AS
SELECT
  strftime('%Y-%m-%d %H:00', ts, 'unixepoch', 'localtime') AS hour,
  COUNT(*) AS msgs,
  SUM(LENGTH(body)) AS total_chars
FROM messages
WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
GROUP BY hour
ORDER BY hour DESC;

-- Agent pair traffic: who talks to whom most
CREATE VIEW v_pair_traffic AS
SELECT sender, recipient,
  COUNT(*) AS msgs,
  SUM(LENGTH(body)) AS total_chars,
  ROUND(AVG(LENGTH(body))) AS avg_chars
FROM messages
WHERE recipient != '*'
GROUP BY sender, recipient
ORDER BY total_chars DESC;

-- Message type distribution
CREATE VIEW v_message_types AS
SELECT
  json_extract(body, '$.type') AS msg_type,
  COUNT(*) AS count,
  ROUND(AVG(LENGTH(body))) AS avg_chars
FROM messages
GROUP BY msg_type
ORDER BY count DESC;

-- Daily efficiency: last 24h per-agent stats with waste flags
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
  SUM(CASE WHEN LENGTH(body) > 2000 THEN 1 ELSE 0 END) AS over_2k,
  SUM(CASE WHEN json_extract(body, '$.summary') IS NOT NULL AND json_extract(body, '$.details') IS NOT NULL THEN 1 ELSE 0 END) AS has_summary_and_details,
  SUM(CASE WHEN json_extract(body, '$.summary') IS NOT NULL AND json_extract(body, '$.message') IS NOT NULL THEN 1 ELSE 0 END) AS has_summary_and_message
FROM messages
WHERE CAST(ts AS INTEGER) > CAST(strftime('%s', 'now', '-1 day') AS INTEGER)
  AND retracted_at IS NULL
GROUP BY sender
ORDER BY total_chars DESC;

-- Reply ratio per agent
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
SQL

echo "Created $DB"
