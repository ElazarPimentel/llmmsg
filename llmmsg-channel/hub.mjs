#!/usr/bin/env node
// llmmsg-channel hub server — routes messages between CC sessions via channels
// Runs as a systemd service on localhost:9701
// Uses the existing llmmsg.sh SQLite DB for persistence

import http from 'node:http';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';

const VERSION = '2.6';
const PORT = parseInt(process.env.LLMMSG_HUB_PORT || '9701');
const BIND_ADDR = process.env.LLMMSG_HUB_BIND || '127.0.0.1';
const DB_PATH = process.env.LLMMSG_DB || '/opt/llmmsg/db/llmmsg.sqlite';
const SITE_NAME = process.env.LLMMSG_SITE || '';
const REMOTE_HUBS_JSON = process.env.LLMMSG_REMOTE_HUBS || ''; // JSON: {"lezama":"http://10.78.42.168:9701"}
const INBOUND_SECRET = process.env.LLMMSG_INBOUND_SECRET || ''; // shared secret for /inbound auth
const SITE_SUFFIX = process.env.LLMMSG_SITE_SUFFIX || ''; // required agent name suffix (e.g. -l)
const BRIDGE_REGISTRY_PATH = new URL('../codex-llmmsg-app/registrations.json', import.meta.url);

if (!existsSync(DB_PATH)) {
  console.error(`DB not found: ${DB_PATH}`);
  process.exit(1);
}

if (BIND_ADDR !== '127.0.0.1' && !INBOUND_SECRET) {
  console.error(`WARNING: binding to ${BIND_ADDR} without LLMMSG_INBOUND_SECRET — /inbound endpoint is unauthenticated`);
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Verify required tables exist (schema is managed by init-db.sh)
{
  const required = ['messages', 'cursors', 'roster', 'aros', 'config', 'outbox'];
  const existing = new Set(db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name));
  const missing = required.filter(t => !existing.has(t));
  if (missing.length) {
    console.error(`Missing tables: ${missing.join(', ')}. Run scripts/init-db.sh first.`);
    process.exit(1);
  }
}

// Migrations: add columns if missing
for (const migration of [
  `ALTER TABLE roster ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE messages ADD COLUMN origin_tag TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_origin_tag ON messages(origin_tag) WHERE origin_tag IS NOT NULL`,
]) {
  try { db.exec(migration); }
  catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
}

// Migrate legacy cursors: collapse last_id/delivered_id/read_id into read_id only.
// After migration, read_id = MAX(old last_id, old delivered_id, old read_id).
// Uses IMMEDIATE transaction to fail fast if bridge holds a lock (restart bridge first).
{
  const cols = db.pragma('table_info(cursors)').map(c => c.name);
  if (cols.includes('last_id') || cols.includes('delivered_id')) {
    try {
      db.exec(`BEGIN IMMEDIATE`);
      // Drop views that depend on cursors before replacing the table
      const depViews = db.prepare(
        `SELECT name FROM sqlite_master WHERE type='view' AND sql LIKE '%cursors%'`
      ).all().map(r => r.name);
      for (const v of depViews) db.exec(`DROP VIEW IF EXISTS ${v}`);

      db.exec(`
        CREATE TABLE cursors_new (
          agent   TEXT PRIMARY KEY,
          read_id INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR REPLACE INTO cursors_new (agent, read_id)
          SELECT agent, MAX(COALESCE(delivered_id, 0), COALESCE(read_id, 0), COALESCE(last_id, 0))
          FROM cursors;
        DROP TABLE cursors;
        ALTER TABLE cursors_new RENAME TO cursors;
      `);

      // Recreate dropped views with new schema
      db.exec(`
        CREATE VIEW IF NOT EXISTS v_overview AS
        SELECT
          (SELECT COUNT(*) FROM messages) AS total_messages,
          (SELECT COUNT(DISTINCT sender) FROM messages) AS unique_senders,
          (SELECT COUNT(DISTINCT recipient) FROM messages) AS unique_recipients,
          (SELECT COUNT(*) FROM cursors) AS registered_agents,
          (SELECT ROUND(AVG(LENGTH(body))) FROM messages) AS avg_body_chars,
          (SELECT COUNT(*) FROM messages WHERE recipient = '*') AS broadcasts,
          (SELECT COUNT(*) FROM messages WHERE re IS NOT NULL) AS replies;

        CREATE VIEW IF NOT EXISTS v_agent_cursors AS
        SELECT
          c.agent,
          c.read_id,
          (SELECT MAX(id) FROM messages) AS latest_msg_id,
          (SELECT MAX(id) FROM messages) - c.read_id AS behind_by,
          (SELECT COUNT(*) FROM messages
           WHERE (recipient = c.agent OR recipient = '*') AND id > c.read_id) AS unread
        FROM cursors c
        ORDER BY behind_by DESC;
      `);
      db.exec(`COMMIT`);
      console.log('[migrate] cursors table unified to read_id only');
    } catch (err) {
      try { db.exec(`ROLLBACK`); } catch {}
      console.error(`[migrate] cursor migration failed (restart bridge first?): ${err.message}`);
      process.exit(1);
    }
  }
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// Prepared statements
const stmtInsertMsg = db.prepare(
  `INSERT INTO messages (sender, recipient, tag, re, body) VALUES (?, ?, '_pending', ?, ?) RETURNING id`
);
const stmtUpdateTag = db.prepare(`UPDATE messages SET tag = ? WHERE id = ?`);
const stmtMessagesSince = db.prepare(
  `SELECT id, sender, recipient, tag, re, body FROM messages
   WHERE (recipient = ? OR recipient = '*') AND id > ? AND retracted_at IS NULL ORDER BY id`
);
const stmtUnreadCount = db.prepare(
  `SELECT COUNT(*) AS count FROM messages
   WHERE (recipient = ? OR recipient = '*') AND id > ? AND retracted_at IS NULL`
);
const stmtGetCursor = db.prepare(
  `SELECT read_id FROM cursors WHERE agent = ?`
);
const stmtUpsertCursor = db.prepare(
  `INSERT INTO cursors (agent, read_id) VALUES (?, ?)
   ON CONFLICT(agent) DO UPDATE SET read_id = MAX(cursors.read_id, excluded.read_id)`
);
const stmtRoster = db.prepare(`SELECT agent, cwd FROM roster ORDER BY agent`);
const stmtRosterFull = db.prepare(`SELECT agent, cwd, last_seen_at FROM roster ORDER BY agent`);
const stmtRegister = db.prepare(
  `INSERT INTO roster (agent, cwd, last_seen_at) VALUES (?, ?, strftime('%s','now'))
   ON CONFLICT(agent) DO UPDATE SET cwd = excluded.cwd, registered_at = strftime('%s','now'), last_seen_at = strftime('%s','now')`
);
const stmtUpdateLastSeen = db.prepare(
  `UPDATE roster SET last_seen_at = strftime('%s','now') WHERE agent = ?`
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
const stmtCheckTag = db.prepare(`SELECT 1 FROM messages WHERE tag = ?`);
// ARO fanout only targets agents seen in the last 30s (bridge heartbeats every 2s) or with an active SSE connection.
// Agents that went offline without unregistering are excluded after 30s of inactivity.
const stmtAroMembersAll = db.prepare(`SELECT agent FROM aros WHERE aro = ? ORDER BY agent`);
const stmtAroMembersActive = db.prepare(
  `SELECT a.agent FROM aros a
   INNER JOIN roster r ON r.agent = a.agent
   WHERE a.aro = ?
     AND r.last_seen_at > strftime('%s','now') - 30
   ORDER BY a.agent`
);
const stmtAroList = db.prepare(`SELECT aro, agent FROM aros ORDER BY aro, agent`);
const stmtAroJoin = db.prepare(`INSERT OR IGNORE INTO aros (aro, agent) VALUES (?, ?)`);
const stmtAroLeave = db.prepare(`DELETE FROM aros WHERE aro = ? AND agent = ?`);
const stmtAroByAgent = db.prepare(`SELECT aro FROM aros WHERE agent = ? ORDER BY aro`);
const stmtUnregister = db.prepare(`DELETE FROM roster WHERE agent = ?`);
const stmtDeleteAroByAgent = db.prepare(`DELETE FROM aros WHERE agent = ?`);
const stmtGetConfig = db.prepare(`SELECT value, version, updated_at FROM config WHERE key = ?`);
const stmtSetConfig = db.prepare(
  `INSERT INTO config (key, value, version, updated_at) VALUES (?, ?, ?, strftime('%s','now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, version = excluded.version, updated_at = strftime('%s','now')`
);

// --- Multi-site: remote hub forwarding ---
const remoteHubs = REMOTE_HUBS_JSON ? safeParse(REMOTE_HUBS_JSON) : {};
const remoteHubEntries = Object.entries(typeof remoteHubs === 'object' && remoteHubs ? remoteHubs : {});

// Outbox: queue messages for remote hubs when they're unreachable (table created by init-db.sh)
const stmtCheckOriginTag = db.prepare(`SELECT 1 FROM messages WHERE origin_tag = ?`);
const stmtSetOriginTag = db.prepare(`UPDATE messages SET origin_tag = ? WHERE id = ?`);
const stmtOutboxInsert = db.prepare(`INSERT INTO outbox (target_hub, payload) VALUES (?, ?)`);
const stmtOutboxPending = db.prepare(`SELECT id, target_hub, payload FROM outbox WHERE target_hub = ? ORDER BY id LIMIT 50`);
const stmtOutboxDelete = db.prepare(`DELETE FROM outbox WHERE id = ?`);
const stmtOutboxCount = db.prepare(`SELECT COUNT(*) AS count FROM outbox`);

function httpPostRemote(hubUrl, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, hubUrl);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    if (INBOUND_SECRET) headers['Authorization'] = `Bearer ${INBOUND_SECRET}`;
    const req = http.request(url, {
      method: 'POST',
      headers,
      timeout: 5000,
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ raw: out }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end(data);
  });
}

async function forwardToRemoteHub(hubName, hubUrl, payload) {
  try {
    const result = await httpPostRemote(hubUrl, '/inbound', payload);
    return { ok: true, hub: hubName, result };
  } catch {
    // Remote unreachable — queue in outbox
    stmtOutboxInsert.run(hubName, JSON.stringify(payload));
    console.log(`[outbox] queued message for ${hubName} (unreachable)`);
    return { ok: false, hub: hubName, queued: true };
  }
}

async function flushOutbox() {
  for (const [hubName, hubUrl] of remoteHubEntries) {
    const pending = stmtOutboxPending.all(hubName);
    if (!pending.length) continue;

    for (const row of pending) {
      try {
        const payload = JSON.parse(row.payload);
        await httpPostRemote(hubUrl, '/inbound', payload);
        stmtOutboxDelete.run(row.id);
      } catch {
        // Still unreachable — stop trying this hub for this cycle
        break;
      }
    }
  }
}

// Flush outbox every 30s
if (remoteHubEntries.length > 0) {
  setInterval(flushOutbox, 30000);
}

// Connected channel sessions: agent name → SSE response
const channels = new Map();

// Poll DB for messages written directly via llmmsg.sh CLI (bypassing hub /send)
function pollForDirectWrites() {
  for (const [agent] of channels) {
    const cursorRow = stmtGetCursor.get(agent);
    const cursorId = cursorRow ? cursorRow.read_id : 0;
    const rows = stmtMessagesSince.all(agent, cursorId);
    if (!rows.length) continue;

    let maxId = cursorId;
    for (const r of rows) {
      if (r.id > maxId) maxId = r.id;
      const event = { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: safeParse(r.body) };
      sendToChannel(agent, event);
    }
    stmtUpsertCursor.run(agent, maxId);
  }
}

setInterval(pollForDirectWrites, 2000);

function sendToChannel(agent, event) {
  const res = channels.get(agent);
  if (res) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    stmtUpsertCursor.run(agent, event.id);
    return true;
  }
  return false;
}

function broadcastToChannels(event, excludeSender) {
  for (const [agent, res] of channels) {
    if (agent !== excludeSender) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      stmtUpsertCursor.run(agent, event.id);
    }
  }
}

// Send message and push to connected channels
const sendMessage = db.transaction((sender, recipient, reTag, body) => {
  const row = stmtInsertMsg.get(sender, recipient, reTag || null, body);
  const id = row.id;
  const tag = `${sender}-${id}`;
  stmtUpdateTag.run(tag, id);

  const event = { id, from: sender, to: recipient, tag, re: reTag || null, body: safeParse(body) };

  if (recipient === '*') {
    broadcastToChannels(event, sender);
  } else {
    sendToChannel(recipient, event);
  }

  return { ok: true, id, tag };
});

function readMessages(agent) {
  const cursorRow = stmtGetCursor.get(agent);
  const cursorId = cursorRow ? cursorRow.read_id : 0;
  const rows = stmtMessagesSince.all(agent, cursorId);

  let maxId = cursorId;
  const messages = rows.map(r => {
    if (r.id > maxId) maxId = r.id;
    return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: safeParse(r.body) };
  });

  if (maxId > cursorId) {
    stmtUpsertCursor.run(agent, maxId);
  }

  return messages;
}

function getUnreadMessages(agent) {
  const cursorRow = stmtGetCursor.get(agent);
  const cursorId = cursorRow ? cursorRow.read_id : 0;
  return stmtMessagesSince.all(agent, cursorId).map((r) => {
    return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: safeParse(r.body) };
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

function isCodexAgent(agent) {
  return agent.endsWith('-ca');
}

function loadBridgeRegistry() {
  try {
    return JSON.parse(readFileSync(BRIDGE_REGISTRY_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function hasActiveBridgeRegistration(agent) {
  const entry = loadBridgeRegistry()[agent];
  return !!(entry && entry.threadId && !entry.suspended);
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
      stmtUpdateLastSeen.run(agent); // refresh last_seen_at so ARO fanout keeps this agent active
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

      // Enforce site suffix if configured
      if (SITE_SUFFIX && !agent.endsWith(SITE_SUFFIX)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `agent name must end with '${SITE_SUFFIX}' on this site. Register as '${agent}${SITE_SUFFIX}' instead.` }));
        return;
      }

      // Reject if another session already has an active SSE connection for this agent
      const existingSSE = channels.get(agent);
      if (existingSSE && (!old_agent || old_agent === agent)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: `agent '${agent}' already has an active session. Kill the other session first or use a different name.` }));
        return;
      }

      stmtRegister.run(agent, cwd);

      // Auto-join aro based on name prefix (first segment before '-')
      const prefix = agent.split('-')[0];
      if (prefix && prefix !== agent) {
        stmtAroJoin.run(prefix, agent);
      }

      // Migrate SSE connection from old_agent (may be an unregistered-* alias) to new agent name
      if (old_agent && old_agent !== agent) {
        const sseRes = channels.get(old_agent);
        if (sseRes) {
          channels.delete(old_agent);
          channels.set(agent, sseRes);
          const oldCursor = stmtGetCursor.get(old_agent);
          if (oldCursor) {
            stmtUpsertCursor.run(agent, oldCursor.read_id);
          }
          console.log(`[register] renamed ${old_agent} → ${agent}`);
        } else {
          console.log(`[register] ${agent} (old_agent ${old_agent} had no SSE)`);
        }
      } else {
        console.log(`[register] ${agent}`);
      }

      // Deliver any unread messages
      const sseRes = channels.get(agent);
      if (sseRes) {
        const unread = getUnreadMessages(agent);
        for (const msg of unread) {
          sseRes.write(`data: ${JSON.stringify(msg)}\n\n`);
          stmtUpsertCursor.run(agent, msg.id);
        }
      }

      const bridgeReady = !isCodexAgent(agent) || hasActiveBridgeRegistration(agent);
      const response = { ok: true, agent, bridge_ready: bridgeReady };
      if (isCodexAgent(agent) && !bridgeReady) {
        response.warning = `No active Codex bridge registration for '${agent}'. Push into Codex will not work until the session is launched or re-bound with cf ${agent}.`;
        console.warn(`[register] ${agent} has roster entry but no active bridge registration`);
      }

      res.end(JSON.stringify(response));
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

      // Reject oversized messages (1MB limit)
      const msgStr = typeof message === 'string' ? message : JSON.stringify(message);
      if (Buffer.byteLength(msgStr) > 1_048_576) {
        res.writeHead(413);
        res.end(JSON.stringify({ error: 'message body exceeds 1MB limit' }));
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
      // Validate re tag if provided (warn only — cross-site tags won't exist locally)
      if (re && !stmtCheckTag.get(re)) {
        console.log(`[send] re tag '${re}' not found locally (may be cross-site)`);
      }
      // aro fan-out: to: "aro:mars" → send to each active member individually
      // "active" = has a live SSE connection OR was seen (heartbeat/register) in the last 30s
      if (to.startsWith('aro:')) {
        const aroName = to.slice(4);
        const allMembers = stmtAroMembersAll.all(aroName).map(r => r.agent).filter(a => a !== from);
        const recentMembers = new Set(stmtAroMembersActive.all(aroName).map(r => r.agent));
        const members = allMembers.filter((a) => {
          if (channels.has(a)) return true;
          if (!recentMembers.has(a)) return false;
          return !isCodexAgent(a) || hasActiveBridgeRegistration(a);
        });
        if (!members.length) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `aro '${aroName}' has no active members (or only the sender)` }));
          return;
        }
        const msgBody = typeof message === 'string' ? message : JSON.stringify(message);
        const results = members.map(member => sendMessage(from, member, re || null, msgBody));
        res.end(JSON.stringify({ ok: true, aro: aroName, members, sent: results.length, ids: results.map(r => r.id) }));
        return;
      }

      if (to !== '*' && !stmtCheckRoster.get(to) && !hasActiveBridgeRegistration(to)) {
        // Recipient not local — try remote hubs
        if (remoteHubEntries.length > 0) {
          const msgBody = typeof message === 'string' ? message : JSON.stringify(message);
          // Store locally first so it appears in local log/search/thread
          const result = sendMessage(from, to, re || null, msgBody);
          const payload = { from, to, re: re || null, message: msgBody, origin_site: SITE_NAME, origin_tag: result.tag };
          const forwards = await Promise.all(
            remoteHubEntries.map(([name, url]) => forwardToRemoteHub(name, url, payload))
          );
          const delivered = forwards.some(f => f.ok);
          res.end(JSON.stringify({ ...result, forwarded: true, delivered, remotes: forwards.map(f => ({ hub: f.hub, ok: f.ok, queued: f.queued || false })) }));
          return;
        }
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

    if (req.method === 'POST' && path === '/heartbeat') {
      const body = await parseBody(req);
      const agent = (body.agent || '').toLowerCase();
      if (agent) stmtUpdateLastSeen.run(agent);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (req.method === 'GET' && path === '/roster') {
      res.end(JSON.stringify(stmtRoster.all()));
      return;
    }

    if (req.method === 'GET' && path === '/online') {
      const agent = (url.searchParams.get('agent') || '').toLowerCase();
      const aro = url.searchParams.get('aro');
      const nowUnix = Math.floor(Date.now() / 1000);
      const threshold = nowUnix - 30; // bridge heartbeats every 2s, so 30s catches any active agent

      // All agents that are online: active SSE or recently seen
      const rosterAll = stmtRosterFull.all();
      const allOnline = rosterAll
        .filter((r) => {
          if (channels.has(r.agent)) return true;
          if (!(r.last_seen_at && r.last_seen_at > threshold)) return false;
          return !isCodexAgent(r.agent) || hasActiveBridgeRegistration(r.agent);
        })
        .map(r => r.agent);
      const onlineSet = new Set(allOnline);

      // Determine which ARO(s) to filter by
      let aroFilter = null;
      if (aro) {
        aroFilter = [aro];
      } else if (agent) {
        aroFilter = stmtAroByAgent.all(agent).map(r => r.aro);
      }

      if (aroFilter && aroFilter.length > 0) {
        const aroMembers = new Set();
        for (const a of aroFilter) {
          for (const m of stmtAroMembersAll.all(a)) aroMembers.add(m.agent);
        }
        const filtered = [...aroMembers].filter(a => onlineSet.has(a)).sort();
        res.end(JSON.stringify({ online: filtered, count: filtered.length, aros: aroFilter }));
      } else {
        res.end(JSON.stringify({ online: allOnline.sort(), count: allOnline.length }));
      }
      return;
    }

    if (req.method === 'GET' && path === '/thread') {
      const tag = url.searchParams.get('tag');
      if (!tag) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing tag' })); return; }
      const rows = stmtThread.all(tag);
      const messages = rows.map(r => {
        if (r.retracted_at) return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, retracted: true };
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: safeParse(r.body) };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/search') {
      const text = url.searchParams.get('q');
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing q' })); return; }
      const rows = stmtSearch.all(`%${text}%`);
      const messages = rows.map(r => {
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: safeParse(r.body) };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/log') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const rows = stmtLog.all(limit);
      const messages = rows.map(r => {
        if (r.retracted_at) return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, retracted: true };
        const body = safeParse(r.body);
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
      stmtUpsertCursor.run(agent, through_id);
      stmtUpdateLastSeen.run(agent); // bridge calls this on every delivery cycle — keeps Codex agents fresh
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

    // Guide: fetch or update messaging policy
    if (req.method === 'GET' && path === '/guide') {
      const row = stmtGetConfig.get('message_guide');
      if (!row) { res.writeHead(404); res.end(JSON.stringify({ error: 'no guide configured' })); return; }
      res.end(JSON.stringify({ guide: row.value, version: row.version, updated_at: row.updated_at }));
      return;
    }

    if (req.method === 'POST' && path === '/guide') {
      const body = await parseBody(req);
      if (!body.guide || !body.version) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing guide or version' }));
        return;
      }
      stmtSetConfig.run('message_guide', body.guide, body.version);
      console.log(`[guide] updated to v${body.version}`);
      res.end(JSON.stringify({ ok: true, version: body.version }));
      return;
    }

    // Inbound: receive a forwarded message from a remote hub
    if (req.method === 'POST' && path === '/inbound') {
      // Auth: require shared secret when configured
      if (INBOUND_SECRET) {
        const auth = req.headers['authorization'] || '';
        if (auth !== `Bearer ${INBOUND_SECRET}`) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
      }

      const body = await parseBody(req);
      const { from, to, re, message, origin_site, origin_tag } = body;
      if (!from || !to || !message) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'missing from, to, or message' }));
        return;
      }

      // Dedup: skip if we already received this forwarded message
      if (origin_tag) {
        const existing = stmtCheckOriginTag.get(origin_tag);
        if (existing) {
          res.end(JSON.stringify({ ok: true, duplicate: true, origin_tag }));
          return;
        }
      }

      // Check if recipient is local
      const isLocal = stmtCheckRoster.get(to) || hasActiveBridgeRegistration(to);
      if (!isLocal && to !== '*') {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `recipient '${to}' not on this site` }));
        return;
      }

      const msgBody = typeof message === 'string' ? message : JSON.stringify(message);
      const result = sendMessage(from, to, re || null, msgBody);
      // Store origin_tag for dedup
      if (origin_tag) {
        stmtSetOriginTag.run(origin_tag, result.id);
      }
      console.log(`[inbound] ${from} → ${to} from site ${origin_site || 'unknown'} (origin tag: ${origin_tag || 'none'}) → local id ${result.id}`);
      res.end(JSON.stringify({ ok: true, id: result.id, tag: result.tag }));
      return;
    }

    if (req.method === 'GET' && path === '/status') {
      const outboxCount = stmtOutboxCount.get()?.count || 0;
      res.end(JSON.stringify({
        version: VERSION,
        site: SITE_NAME || null,
        connected: [...channels.keys()],
        roster: stmtRoster.all().map(r => r.agent),
        remoteHubs: Object.keys(remoteHubs),
        outbox: outboxCount,
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

server.listen(PORT, BIND_ADDR, () => {
  console.log(`llmmsg-channel hub v${VERSION} listening on ${BIND_ADDR}:${PORT}`);
  console.log(`DB: ${DB_PATH}`);
  if (SITE_NAME) console.log(`Site: ${SITE_NAME}`);
  if (remoteHubEntries.length) console.log(`Remote hubs: ${remoteHubEntries.map(([n, u]) => `${n}=${u}`).join(', ')}`);
});

function shutdown() {
  console.log('[shutdown] closing...');
  // Close all SSE connections
  for (const [agent, res] of channels) {
    res.end();
    console.log(`[shutdown] closed SSE for ${agent}`);
  }
  channels.clear();
  server.close(() => {
    db.close();
    console.log('[shutdown] done');
    process.exit(0);
  });
  // Force exit after 5s if connections won't drain
  setTimeout(() => {
    db.close();
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
