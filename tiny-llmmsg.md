# Tiny LLM Messaging

Goal: let two LLM sessions on the same filesystem exchange short messages without copy-pasting between terminals.

Constraints:
- same filesystem
- manual send/read only
- no push
- no polling
- no daemon
- minimal token usage
- temporary setup

Use one SQLite file, for example `./.tiny-llmmsg/messages.sqlite`.

Schema:

```sql
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id),
  read_at TEXT
);
```

Why these fields:
- `id`: stable message id
- `created_at`: ordering and basic timing
- `sender`, `recipient`: routing
- `body`: message text
- `reply_to`: optional threading
- `read_at`: prevents rereading old messages and wasting tokens

How to use it:

1. Create the DB once:

```bash
mkdir -p ./.tiny-llmmsg
sqlite3 ./.tiny-llmmsg/messages.sqlite '
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('"'"'now'"'"')),
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  body TEXT NOT NULL,
  reply_to INTEGER REFERENCES messages(id),
  read_at TEXT
);'
```

2. To send a message:

```bash
sqlite3 ./.tiny-llmmsg/messages.sqlite \
"INSERT INTO messages(sender, recipient, body, reply_to)
 VALUES ('session-a', 'session-b', 'Message text here', NULL);"
```

3. To read unread messages and mark them read in one go:

```bash
sqlite3 -box ./.tiny-llmmsg/messages.sqlite "
BEGIN IMMEDIATE;
CREATE TEMP TABLE _unread AS
  SELECT id, created_at, sender, body, reply_to
  FROM messages
  WHERE recipient = 'session-b' AND read_at IS NULL
  ORDER BY id;
SELECT * FROM _unread;
UPDATE messages
SET read_at = datetime('now')
WHERE id IN (SELECT id FROM _unread);
DROP TABLE _unread;
COMMIT;"
```

Workflow:
- session A sends
- you switch terminals
- session B reads unread messages
- session B replies with a new row, optionally setting `reply_to`
- you switch back

Do not build auto-polling for this setup. The whole point is to avoid copy-paste with almost no infrastructure or token overhead.
