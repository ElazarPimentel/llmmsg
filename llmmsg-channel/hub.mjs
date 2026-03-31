#!/usr/bin/env node
// llmmsg-channel hub server — routes messages between CC sessions via channels
// Runs as a systemd service on localhost:9701
// Uses the existing llmmsg.sh SQLite DB for persistence

import http from 'node:http';
import Database from 'better-sqlite3';
import { existsSync } from 'node:fs';

const VERSION = '2.0';
const PORT = parseInt(process.env.LLMMSG_HUB_PORT || '9701');
const DB_PATH = process.env.LLMMSG_DB || '/opt/llmmsg/db/llmmsg.sqlite';

if (!existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Ensure tables exist
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
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
  CREATE TABLE IF NOT EXISTS cursors (
    agent   TEXT    PRIMARY KEY,
    last_id INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS roster (
    agent         TEXT PRIMARY KEY,
    cwd           TEXT NOT NULL,
    registered_at TEXT NOT NULL DEFAULT (strftime('%s','now'))
  );
  CREATE TABLE IF NOT EXISTS thread_map (
    agent      TEXT NOT NULL,
    cwd        TEXT NOT NULL,
    thread_id  TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (agent, cwd)
  );
  CREATE INDEX IF NOT EXISTS idx_recv ON messages(recipient, id);
  CREATE TABLE IF NOT EXISTS aros (
    aro   TEXT NOT NULL,
    agent TEXT NOT NULL,
    PRIMARY KEY (aro, agent)
  );
`);

for (const columnSql of [
  `ALTER TABLE cursors ADD COLUMN delivered_id INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE cursors ADD COLUMN read_id INTEGER NOT NULL DEFAULT 0`,
]) {
  try {
    db.exec(columnSql);
  } catch (error) {
    if (!String(error.message).includes('duplicate column name')) {
      throw error;
    }
  }
}

db.exec(`
  UPDATE cursors
  SET
    delivered_id = CASE WHEN delivered_id = 0 THEN last_id ELSE delivered_id END,
    read_id = CASE WHEN read_id = 0 THEN last_id ELSE read_id END
`);

// Prepared statements
const stmtInsertMsg = db.prepare(
  `INSERT INTO messages (sender, recipient, tag, re, body) VALUES (?, ?, '_pending', ?, ?) RETURNING id`
);
const stmtUpdateTag = db.prepare(`UPDATE messages SET tag = ? WHERE id = ?`);
const stmtRead = db.prepare(
  `SELECT id, sender, recipient, tag, re, body FROM messages
   WHERE (recipient = ? OR recipient = '*') AND id > ? AND retracted_at IS NULL ORDER BY id`
);
const stmtUndelivered = db.prepare(
  `SELECT id, sender, recipient, tag, re, body FROM messages
   WHERE (recipient = ? OR recipient = '*') AND id > ? AND retracted_at IS NULL ORDER BY id`
);
const stmtUnreadCount = db.prepare(
  `SELECT COUNT(*) AS count FROM messages
   WHERE (recipient = ? OR recipient = '*') AND id > ? AND retracted_at IS NULL`
);
const stmtGetCursor = db.prepare(
  `SELECT
      COALESCE(delivered_id, last_id, 0) AS delivered_id,
      COALESCE(read_id, last_id, 0) AS read_id
   FROM cursors
   WHERE agent = ?`
);
const stmtUpsertDeliveredCursor = db.prepare(
  `INSERT INTO cursors (agent, last_id, delivered_id, read_id) VALUES (?, ?, ?, 0)
   ON CONFLICT(agent) DO UPDATE SET
     last_id = MAX(cursors.last_id, excluded.last_id),
     delivered_id = MAX(COALESCE(cursors.delivered_id, cursors.last_id), excluded.delivered_id)`
);
const stmtUpsertReadCursor = db.prepare(
  `INSERT INTO cursors (agent, last_id, delivered_id, read_id) VALUES (?, 0, 0, ?)
   ON CONFLICT(agent) DO UPDATE SET
     read_id = MAX(COALESCE(cursors.read_id, cursors.last_id), excluded.read_id)`
);
const stmtRoster = db.prepare(`SELECT agent, cwd FROM roster ORDER BY agent`);
const stmtRegister = db.prepare(
  `INSERT INTO roster (agent, cwd) VALUES (?, ?)
   ON CONFLICT(agent) DO UPDATE SET cwd = excluded.cwd, registered_at = strftime('%s','now')`
);
const stmtThread = db.prepare(
  `WITH RECURSIVE thread_tags(t) AS (
     VALUES(?)
     UNION
     SELECT m.tag FROM messages m JOIN thread_tags tt ON m.re = tt.t
   )
   SELECT id, sender, recipient, tag, re, body, retracted_at FROM messages
   WHERE tag IN (SELECT t FROM thread_tags) OR re IN (SELECT t FROM thread_tags)
   ORDER BY id`
);
const stmtSearch = db.prepare(
  `SELECT id, sender, recipient, tag, re, body FROM messages
   WHERE body LIKE ? AND retracted_at IS NULL ORDER BY id`
);
const stmtLog = db.prepare(
  `SELECT id, sender, recipient, tag, re, body, retracted_at FROM messages ORDER BY id DESC LIMIT ?`
);
const stmtCheckRoster = db.prepare(`SELECT 1 FROM roster WHERE agent = ?`);
const stmtAroMembers = db.prepare(`SELECT agent FROM aros WHERE aro = ? ORDER BY agent`);
const stmtAroList = db.prepare(`SELECT aro, agent FROM aros ORDER BY aro, agent`);
const stmtAroJoin = db.prepare(`INSERT OR IGNORE INTO aros (aro, agent) VALUES (?, ?)`);
const stmtAroLeave = db.prepare(`DELETE FROM aros WHERE aro = ? AND agent = ?`);
const stmtAroByAgent = db.prepare(`SELECT aro FROM aros WHERE agent = ? ORDER BY aro`);
const stmtUnregister = db.prepare(`DELETE FROM roster WHERE agent = ?`);
const stmtDeleteAroByAgent = db.prepare(`DELETE FROM aros WHERE agent = ?`);

// Connected channel sessions: agent name → SSE response
const channels = new Map();

// Poll DB for messages written directly via llmmsg.sh CLI (bypassing hub /send)
const stmtPollNew = db.prepare(
  `SELECT id, sender, recipient, tag, re, body FROM messages
   WHERE (recipient = ? OR recipient = '*') AND id > ? AND retracted_at IS NULL ORDER BY id`
);

function pollForDirectWrites() {
  for (const [agent] of channels) {
    const cursorRow = stmtGetCursor.get(agent);
    const lastDeliveredId = cursorRow ? cursorRow.delivered_id : 0;
    const rows = stmtPollNew.all(agent, lastDeliveredId);
    if (!rows.length) continue;

    let maxId = lastDeliveredId;
    for (const r of rows) {
      if (r.id > maxId) maxId = r.id;
      let body;
      try { body = JSON.parse(r.body); } catch { body = r.body; }
      const event = { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body };
      sendToChannel(agent, event);
    }
    stmtUpsertDeliveredCursor.run(agent, maxId, maxId);
  }
}

setInterval(pollForDirectWrites, 2000);

function sendToChannel(agent, event) {
  const res = channels.get(agent);
  if (res) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    stmtUpsertDeliveredCursor.run(agent, event.id, event.id);
    return true;
  }
  return false;
}

function broadcastToChannels(event, excludeSender) {
  for (const [agent, res] of channels) {
    if (agent !== excludeSender) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      stmtUpsertDeliveredCursor.run(agent, event.id, event.id);
    }
  }
}

// Send message and push to connected channels
const sendMessage = db.transaction((sender, recipient, reTag, body) => {
  const row = stmtInsertMsg.get(sender, recipient, reTag || null, body);
  const id = row.id;
  const tag = `${sender}-${id}`;
  stmtUpdateTag.run(tag, id);

  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  const event = { id, from: sender, to: recipient, tag, re: reTag || null, body: parsed };

  if (recipient === '*') {
    broadcastToChannels(event, sender);
  } else {
    sendToChannel(recipient, event);
  }

  return { ok: true, id, tag };
});

function readMessages(agent) {
  const cursorRow = stmtGetCursor.get(agent);
  const lastReadId = cursorRow ? cursorRow.read_id : 0;
  const rows = stmtRead.all(agent, lastReadId);

  let maxId = lastReadId;
  const messages = rows.map(r => {
    if (r.id > maxId) maxId = r.id;
    let body;
    try { body = JSON.parse(r.body); } catch { body = r.body; }
    return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body };
  });

  if (maxId > lastReadId) {
    stmtUpsertReadCursor.run(agent, maxId);
  }

  return messages;
}

function getUndeliveredMessages(agent) {
  const cursorRow = stmtGetCursor.get(agent);
  const lastDeliveredId = cursorRow ? cursorRow.delivered_id : 0;
  return stmtUndelivered.all(agent, lastDeliveredId).map((r) => {
    let body;
    try { body = JSON.parse(r.body); } catch { body = r.body; }
    return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body };
  });
}

function getUnreadCount(agent) {
  const cursorRow = stmtGetCursor.get(agent);
  const lastReadId = cursorRow ? cursorRow.read_id : 0;
  const row = stmtUnreadCount.get(agent, lastReadId);
  return row ? row.count : 0;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(e); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Content-Type', 'application/json');

  try {
    // SSE: channel plugin connects here to receive pushed messages
    // Does NOT register in roster — agent must call /register explicitly
    if (req.method === 'GET' && path === '/connect') {
      const agent = (url.searchParams.get('agent') || '').toLowerCase();
      if (!agent) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing agent param' }));
        return;
      }

      // Set up SSE
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });
      res.write(`: connected as ${agent}\n\n`);

      channels.set(agent, res);
      console.log(`[connect] ${agent} (${channels.size} connected)`);

      req.on('close', () => {
        // Only delete if this response is still the active one (not replaced by a newer connection)
        if (channels.get(agent) === res) {
          channels.delete(agent);
          console.log(`[disconnect] ${agent} (${channels.size} connected)`);
        } else {
          console.log(`[disconnect] ${agent} (stale, ignored — newer connection exists)`);
        }
      });
      return;
    }

    // Register agent: adds to roster, renames SSE connection, delivers unread messages
    if (req.method === 'POST' && path === '/register') {
      const body = await parseBody(req);
      const { cwd, old_agent } = body;
      const agent = (body.agent || '').toLowerCase();
      if (!agent || !cwd) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing agent or cwd' }));
        return;
      }

      stmtRegister.run(agent, cwd);

      // Auto-join aro based on name prefix (first segment before '-')
      const prefix = agent.split('-')[0];
      if (prefix && prefix !== agent) {
        stmtAroJoin.run(prefix, agent);
      }

      // Rename SSE connection if old_agent differs
      if (old_agent && old_agent !== agent) {
        const sseRes = channels.get(old_agent);
        if (sseRes) {
          channels.delete(old_agent);
          channels.set(agent, sseRes);
          // Migrate cursor
          const oldCursor = stmtGetCursor.get(old_agent);
          if (oldCursor) {
            stmtUpsertDeliveredCursor.run(agent, oldCursor.delivered_id || oldCursor.read_id || 0, oldCursor.delivered_id || oldCursor.read_id || 0);
          }
          console.log(`[register] renamed ${old_agent} → ${agent}`);
        }
      } else {
        console.log(`[register] ${agent}`);
      }

      // Deliver any unread messages
      const sseRes = channels.get(agent);
      if (sseRes) {
        const undelivered = getUndeliveredMessages(agent);
        for (const msg of undelivered) {
          sseRes.write(`data: ${JSON.stringify(msg)}\n\n`);
          stmtUpsertDeliveredCursor.run(agent, msg.id, msg.id);
        }
      }

      res.end(JSON.stringify({ ok: true, agent }));
      return;
    }

    // Unregister agent(s): remove from roster, aros, and disconnect SSE
    if (req.method === 'POST' && path === '/unregister') {
      const body = await parseBody(req);
      const agents = Array.isArray(body.agents) ? body.agents.map(a => a.toLowerCase()) : [(body.agent || '').toLowerCase()];
      const removed = [];
      for (const agent of agents) {
        if (!agent) continue;
        const existed = stmtCheckRoster.get(agent);
        if (existed) {
          stmtUnregister.run(agent);
          stmtDeleteAroByAgent.run(agent);
          removed.push(agent);
          console.log(`[unregister] ${agent}`);
        }
      }
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }

    if (req.method === 'POST' && path === '/send') {
      const body = await parseBody(req);
      const { from, to, re, message } = body;
      if (!from || !to || !message) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing from, to, or message' }));
        return;
      }

      // Validate sender is registered
      if (!stmtCheckRoster.get(from)) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: 'not_registered',
          message: `You are not registered as '${from}'. Ask the user: "What is my agent name for this session?" Then call the register tool with that name.`,
        }));
        return;
      }
      // aro fan-out: to: "aro:mars" → send to each member individually
      if (to.startsWith('aro:')) {
        const aroName = to.slice(4);
        const members = stmtAroMembers.all(aroName).map(r => r.agent).filter(a => a !== from);
        if (!members.length) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `aro '${aroName}' has no members (or only the sender)` }));
          return;
        }
        const msgBody = typeof message === 'string' ? message : JSON.stringify(message);
        const results = members.map(member => sendMessage(from, member, re || null, msgBody));
        res.end(JSON.stringify({ ok: true, aro: aroName, members, sent: results.length, ids: results.map(r => r.id) }));
        return;
      }

      if (to !== '*' && !stmtCheckRoster.get(to)) {
        const roster = stmtRoster.all().map(r => r.agent);
        res.writeHead(400);
        res.end(JSON.stringify({ error: `recipient '${to}' not in roster`, roster }));
        return;
      }

      const msgBody = typeof message === 'string' ? message : JSON.stringify(message);
      const result = sendMessage(from, to, re || null, msgBody);
      res.end(JSON.stringify(result));
      return;
    }

    if (req.method === 'GET' && path === '/roster') {
      res.end(JSON.stringify(stmtRoster.all()));
      return;
    }

    if (req.method === 'GET' && path === '/thread') {
      const tag = url.searchParams.get('tag');
      if (!tag) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing tag' })); return; }
      const rows = stmtThread.all(tag);
      const messages = rows.map(r => {
        if (r.retracted_at) return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, retracted: true };
        let body; try { body = JSON.parse(r.body); } catch { body = r.body; }
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/search') {
      const text = url.searchParams.get('q');
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing q' })); return; }
      const rows = stmtSearch.all(`%${text}%`);
      const messages = rows.map(r => {
        let body; try { body = JSON.parse(r.body); } catch { body = r.body; }
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/log') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const rows = stmtLog.all(limit);
      const messages = rows.map(r => {
        if (r.retracted_at) return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, retracted: true };
        let body; try { body = JSON.parse(r.body); } catch { body = r.body; }
        const preview = typeof body === 'object' ? (body.summary || body.message || JSON.stringify(body)).slice(0, 120) : String(body).slice(0, 120);
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, preview };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/has-unread') {
      const agent = url.searchParams.get('agent');
      if (!agent) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing agent' })); return; }
      res.end(JSON.stringify({ agent, unread: getUnreadCount(agent) }));
      return;
    }

    if (req.method === 'GET' && path === '/read-unread') {
      const agent = url.searchParams.get('agent');
      if (!agent) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing agent' })); return; }
      const messages = readMessages(agent);
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'POST' && path === '/read-ack') {
      const body = await parseBody(req);
      const { agent, through_id } = body;
      if (!agent || !through_id) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing agent or through_id' }));
        return;
      }
      stmtUpsertReadCursor.run(agent, through_id);
      res.end(JSON.stringify({ ok: true, agent, read_id: through_id }));
      return;
    }

    if (req.method === 'GET' && path === '/aro') {
      const agent = url.searchParams.get('agent');
      if (agent) {
        res.end(JSON.stringify({ agent, aros: stmtAroByAgent.all(agent).map(r => r.aro) }));
      } else {
        const rows = stmtAroList.all();
        const map = {};
        for (const r of rows) {
          if (!map[r.aro]) map[r.aro] = [];
          map[r.aro].push(r.agent);
        }
        res.end(JSON.stringify(map));
      }
      return;
    }

    if (req.method === 'POST' && path === '/aro/join') {
      const body = await parseBody(req);
      const aro = (body.aro || '').toLowerCase();
      const agent = (body.agent || '').toLowerCase();
      if (!aro || !agent) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing aro or agent' })); return; }
      stmtAroJoin.run(aro, agent);
      res.end(JSON.stringify({ ok: true, aro, agent }));
      return;
    }

    if (req.method === 'POST' && path === '/aro/leave') {
      const body = await parseBody(req);
      const aro = (body.aro || '').toLowerCase();
      const agent = (body.agent || '').toLowerCase();
      if (!aro || !agent) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing aro or agent' })); return; }
      stmtAroLeave.run(aro, agent);
      res.end(JSON.stringify({ ok: true, aro, agent }));
      return;
    }

    if (req.method === 'GET' && path === '/status') {
      res.end(JSON.stringify({
        version: VERSION,
        connected: [...channels.keys()],
        roster: stmtRoster.all().map(r => r.agent),
        db: DB_PATH,
      }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`llmmsg-channel hub v${VERSION} listening on 127.0.0.1:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
});
