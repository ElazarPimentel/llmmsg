#!/usr/bin/env bash
VERSION="1.0"
echo "init-db.sh v$VERSION"

DB="${LLMMSG_DB:-$HOME/Documents/work/llmmsg/llmmsg.sqlite}"

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
SQL

echo "Created $DB"
