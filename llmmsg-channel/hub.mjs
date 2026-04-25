#!/usr/bin/env node
// llmmsg-channel hub server — routes messages between CC sessions via channels
// Runs as a systemd service on localhost:9701
// Uses the existing llmmsg.sh SQLite DB for persistence

import http from 'node:http';
import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';

const VERSION = '5.2';
const LENGTH_NUDGE_THRESHOLD = 1500;
const PORT = parseInt(process.env.LLMMSG_HUB_PORT || '9701');
const BIND_ADDR = process.env.LLMMSG_HUB_BIND || '127.0.0.1';
const DB_PATH = process.env.LLMMSG_DB || '/opt/llmmsg/db/llmmsg.sqlite';
const REMOTE_HUBS_JSON = process.env.LLMMSG_REMOTE_HUBS || ''; // JSON: {"lezama":"http://10.78.42.168:9701"}
const INBOUND_SECRET = process.env.LLMMSG_INBOUND_SECRET || ''; // shared secret for /inbound auth
const BRIDGE_REGISTRY_PATH = new URL('../codex-llmmsg-app/registrations.json', import.meta.url);

// Host-scoped site config at /etc/llmmsg/site.conf (override via LLMMSG_SITE_CONF).
// MUST exist. Hub hard-errors on startup if missing. Provides SITE_SUFFIX,
// LLMMSG_SITE, LLMMSG_ARO_SEGMENT. Env vars still override file values for
// emergency/testing use.
const SITE_CONF_PATH = process.env.LLMMSG_SITE_CONF || '/etc/llmmsg/site.conf';
function loadSiteConf() {
  if (!existsSync(SITE_CONF_PATH)) {
    console.error(`FATAL: missing host config: ${SITE_CONF_PATH}`);
    console.error(`fix:   sudo install -m 0644 -o root -g root /opt/llmmsg/config-templates/site.conf.<hostname> ${SITE_CONF_PATH}`);
    process.exit(1);
  }
  const text = readFileSync(SITE_CONF_PATH, 'utf8');
  const out = { SITE_SUFFIX: '', LLMMSG_SITE: '', LLMMSG_ARO_SEGMENT: '0' };
  for (const rawLine of text.split('\n')) {
    const noComment = rawLine.replace(/#.*$/, '').trim();
    if (!noComment) continue;
    const eq = noComment.indexOf('=');
    if (eq < 0) continue;
    const key = noComment.slice(0, eq).trim();
    let val = noComment.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key in out) out[key] = val;
  }
  return out;
}
const siteConf = loadSiteConf();
const SITE_NAME = process.env.LLMMSG_SITE || siteConf.LLMMSG_SITE || '';
const SITE_SUFFIX = process.env.LLMMSG_SITE_SUFFIX !== undefined
  ? process.env.LLMMSG_SITE_SUFFIX
  : siteConf.SITE_SUFFIX; // empty string is valid
const ARO_SEGMENT = parseInt(process.env.LLMMSG_ARO_SEGMENT || siteConf.LLMMSG_ARO_SEGMENT || '0');

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

// Migrations: add columns if missing, install/refresh views
for (const migration of [
  `ALTER TABLE roster ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE messages ADD COLUMN origin_tag TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_origin_tag ON messages(origin_tag) WHERE origin_tag IS NOT NULL`,
  `ALTER TABLE messages ADD COLUMN origin_aro TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_origin_aro ON messages(origin_aro) WHERE origin_aro IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS hub_log (
     id      INTEGER PRIMARY KEY AUTOINCREMENT,
     ts      INTEGER NOT NULL,
     level   TEXT    NOT NULL,
     message TEXT    NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_hub_log_ts ON hub_log(ts)`,
  `CREATE TABLE IF NOT EXISTS guide_delivered (
     agent         TEXT PRIMARY KEY,
     guide_version TEXT NOT NULL
   )`,
  // ARO opinion-request lifecycle. When a sender sets expects_replies on an
  // ARO send, the hub captures a snapshot of expected agents (online wheel
  // OR caller-supplied list) and a deadline. A 30s timer closes expired
  // requests as 'closed:incomplete' and emits a system message to the ARO.
  // Without this, opinion requests stalled forever when a slot stayed silent.
  `CREATE TABLE IF NOT EXISTS opinion_requests (
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
   )`,
  `CREATE INDEX IF NOT EXISTS idx_opinion_requests_open
     ON opinion_requests(status, deadline_at) WHERE status='open'`,
  // Views: DROP + CREATE on every start so definition changes propagate
  // without a separate migration step. Keep their SQL as the single source
  // of truth for fan-out collapse and online membership.
  `DROP VIEW IF EXISTS v_logical_messages`,
  `CREATE VIEW v_logical_messages AS
     SELECT MIN(id) AS id, sender, MIN(recipient) AS recipient, MIN(tag) AS tag,
            re, body, retracted_at, origin_aro, ts
     FROM messages
     GROUP BY sender, ts, body, COALESCE(re,''), COALESCE(retracted_at,0), origin_aro,
              CASE WHEN origin_aro IS NULL THEN id ELSE 0 END`,
  `DROP VIEW IF EXISTS v_roster_online`,
  `CREATE VIEW v_roster_online AS
     SELECT agent, cwd, last_seen_at
     FROM roster
     WHERE last_seen_at > strftime('%s','now') - 30`,
  `DROP VIEW IF EXISTS v_aro_members_online`,
  `CREATE VIEW v_aro_members_online AS
     SELECT a.aro, a.agent, r.cwd, r.last_seen_at
     FROM aros a
     INNER JOIN v_roster_online r ON r.agent = a.agent`,
]) {
  try { db.exec(migration); }
  catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; }
}

// Redirect runtime logs to SQLite (hub_log). Pre-DB startup errors still hit stderr
// because this wrapper is installed after db is open. Fatal post-init problems
// re-emit to stderr so systemd can surface them even if DB writes are failing.
const stmtInsertLog = db.prepare(`INSERT INTO hub_log (ts, level, message) VALUES (?, ?, ?)`);
function dbLog(level, args) {
  const msg = args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  try {
    stmtInsertLog.run(Math.floor(Date.now() / 1000), level, msg);
  } catch (err) {
    // DB write failed — fall back to stderr so we don't lose the line silently.
    process.stderr.write(`[hub_log write failed: ${err.message}] ${level}: ${msg}\n`);
  }
}
console.log = (...args) => dbLog('info', args);
console.error = (...args) => dbLog('error', args);
console.warn = (...args) => dbLog('warn', args);

// Periodic prune: keep last 14 days of logs.
setInterval(() => {
  const cutoff = Math.floor(Date.now() / 1000) - 14 * 86400;
  try { db.prepare(`DELETE FROM hub_log WHERE ts < ?`).run(cutoff); } catch {}
}, 3600_000);

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
// tag is a GENERATED column (sender || '-' || id) — never written, returned
// by RETURNING. body is plain text; if a sender passes an object we stringify
// it in normalizeBody before this INSERT runs.
const stmtInsertMsg = db.prepare(
  `INSERT INTO messages (sender, recipient, re, body, origin_aro)
   VALUES (?, ?, ?, ?, ?) RETURNING id, tag, ts`
);
const stmtMessagesSince = db.prepare(
  `SELECT id, sender, recipient, tag, re, body, origin_aro, ts FROM messages
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
   SELECT id, sender, recipient, tag, re, body, retracted_at, origin_aro, ts FROM messages
   WHERE tag IN (SELECT t FROM thread_tags) OR re IN (SELECT t FROM thread_tags)
   ORDER BY id`
);
const stmtSearch = db.prepare(
  `SELECT id, sender, recipient, tag, re, body, origin_aro, ts FROM messages
   WHERE body LIKE ? AND retracted_at IS NULL ORDER BY id`
);
// v_logical_messages is the single source of truth for "one row per logical
// message" — ARO fan-out rows (same sender/ts/body/origin_aro/re) collapse to
// one row via MIN aggregation. Both stmtLog and stmtHistoryAro read through it.
// Callers must not rely on `recipient` identifying a specific delivery.
const stmtLog = db.prepare(
  `SELECT id, sender, recipient, tag, re, body, retracted_at, origin_aro, ts
   FROM v_logical_messages
   ORDER BY id DESC LIMIT ?`
);
const stmtHistoryAro = db.prepare(
  `SELECT id, sender, recipient, tag, re, body, retracted_at, origin_aro, ts FROM (
     SELECT id, sender, recipient, tag, re, body, retracted_at, origin_aro, ts
     FROM v_logical_messages
     WHERE retracted_at IS NULL
       AND (
         origin_aro = ?
         OR re IN (SELECT tag FROM messages WHERE origin_aro = ?)
       )
     ORDER BY id DESC LIMIT ?
   ) ORDER BY id`
);
const stmtHistoryDm = db.prepare(
  `SELECT id, sender, recipient, tag, re, body, retracted_at, origin_aro, ts FROM (
     SELECT id, sender, recipient, tag, re, body, retracted_at, origin_aro, ts FROM messages
     WHERE origin_aro IS NULL
       AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
       AND retracted_at IS NULL
     ORDER BY id DESC LIMIT ?
   ) ORDER BY id`
);
const stmtCheckRoster = db.prepare(`SELECT 1 FROM roster WHERE agent = ?`);
const stmtCheckOnline = db.prepare(`SELECT 1 FROM v_roster_online WHERE agent = ?`);
const stmtReplyRoute = db.prepare(`SELECT origin_aro FROM messages WHERE tag = ?`);
// ARO fanout only targets agents seen in the last 30s (bridge heartbeats every 2s) or with an active SSE connection.
// Agents that went offline without unregistering are excluded after 30s of inactivity.
const stmtAroMembersAll = db.prepare(`SELECT agent FROM aros WHERE aro = ? ORDER BY agent`);
const stmtAroMembersActive = db.prepare(
  `SELECT agent FROM v_aro_members_online WHERE aro = ? ORDER BY agent`
);

function activeAroMembers(aroName, excludeAgent = null) {
  const allMembers = stmtAroMembersAll.all(aroName).map(r => r.agent).filter(a => a !== excludeAgent);
  const recentMembers = new Set(stmtAroMembersActive.all(aroName).map(r => r.agent));
  return allMembers.filter((agent) => {
    if (channels.has(agent)) return true;
    if (!recentMembers.has(agent)) return false;
    return !isCodexAgent(agent) || hasActiveBridgeRegistration(agent);
  });
}
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
const stmtGetGuideDelivered = db.prepare(`SELECT guide_version FROM guide_delivered WHERE agent = ?`);
const stmtSetGuideDelivered = db.prepare(
  `INSERT INTO guide_delivered (agent, guide_version) VALUES (?, ?)
   ON CONFLICT(agent) DO UPDATE SET guide_version = excluded.guide_version`
);
const stmtInsertOpinionRequest = db.prepare(
  `INSERT INTO opinion_requests (tag, aro, sender, expected_repliers, deadline_at, close_policy)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtCloseExpired = db.prepare(
  `UPDATE opinion_requests
   SET status = 'closed:incomplete', closed_at = strftime('%s','now'), closed_reason = 'deadline'
   WHERE status = 'open' AND deadline_at < strftime('%s','now')
   RETURNING tag, aro, sender, expected_repliers`
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

function httpGetRemote(hubUrl, path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, hubUrl);
    const headers = {};
    if (INBOUND_SECRET) headers['Authorization'] = `Bearer ${INBOUND_SECRET}`;
    const req = http.request(url, { method: 'GET', headers, timeout: 5000 }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ raw: out }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function listRemoteAroOnline(hubName, hubUrl, aroName) {
  try {
    const result = await httpGetRemote(hubUrl, `/online?aro=${encodeURIComponent(aroName)}&local=1`);
    const online = Array.isArray(result.online) ? result.online : [];
    return { ok: true, hub: hubName, online };
  } catch {
    return { ok: false, hub: hubName, online: [] };
  }
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

// Stale-roster sweeper. Roster rows live forever today: a CC session whose
// channel.mjs SSE child crashed silently leaves an entry that aro_list and
// other reads still return, so fanout targets ghosts. Sweep every 60s — for
// any agent without a live SSE *and* with last_seen_at older than
// ROSTER_STALE_MS, delete the roster row and any aros memberships. Live SSE
// agents stay fresh via the 25s ping (heartbeat now refreshes last_seen_at);
// Codex agents stay fresh via the bridge /heartbeat call. The 'system' agent
// is excluded because it is seeded once and never reconnects. channel.mjs
// re-issues aro_join on reconnect (v3.0+) so post-eviction returns are
// idempotent.
const ROSTER_STALE_MS = 600 * 1000;          // 10 minutes
const ROSTER_SWEEP_INTERVAL_MS = 60 * 1000;  // 1 minute
const stmtSweepCandidates = db.prepare(
  `SELECT agent FROM roster
   WHERE agent != 'system'
     AND last_seen_at < strftime('%s','now') - ?`
);
setInterval(() => {
  try {
    const thresholdSec = Math.floor(ROSTER_STALE_MS / 1000);
    const candidates = stmtSweepCandidates.all(thresholdSec);
    const removed = [];
    for (const { agent } of candidates) {
      if (channels.has(agent)) continue;
      const aroChanges = stmtDeleteAroByAgent.run(agent).changes;
      const rosterChanges = stmtUnregister.run(agent).changes;
      if (rosterChanges > 0 || aroChanges > 0) {
        removed.push(agent);
      }
    }
    if (removed.length) {
      console.log(`[sweep] roster evict: ${removed.join(', ')}`);
    }
  } catch (err) {
    console.error(`[sweep] error: ${err.message}`);
  }
}, ROSTER_SWEEP_INTERVAL_MS);

// Opinion-request deadline closer. Every 30s, find open opinion_requests
// whose deadline has elapsed, close them as 'closed:incomplete', and emit a
// system message to the originating ARO so all members see the close.
const OPINION_DEADLINE_CHECK_MS = 30 * 1000;
setInterval(() => {
  try {
    const expired = stmtCloseExpired.all();
    for (const row of expired) {
      let expectedList = [];
      try { expectedList = JSON.parse(row.expected_repliers || '[]'); } catch {}
      const expectedStr = expectedList.length ? expectedList.join(',') : '<none>';
      const notice =
        `[opinion-request closed:incomplete] tag=${row.tag} aro:${row.aro} sender=${row.sender} ` +
        `expected=[${expectedStr}] reason=deadline. The request stalled past its deadline; ` +
        `requester should proceed with the opinions received or reissue with a new deadline.`;
      try {
        sendMessage('system', `aro:${row.aro}`, null, notice, `aro:${row.aro}`);
      } catch (sendErr) {
        // sendMessage signature expects a recipient agent, not aro:X. Fall
        // back: fan out manually to current ARO members.
        try {
          const members = activeAroMembers(row.aro, 'system');
          for (const m of members) {
            sendMessage('system', m, null, notice, `aro:${row.aro}`);
          }
        } catch (fanErr) {
          console.error(`[opinion-deadline] notice fanout failed for ${row.tag}: ${fanErr.message}`);
        }
      }
      console.log(`[opinion-deadline] closed ${row.tag} (aro:${row.aro}, sender=${row.sender})`);
    }
  } catch (err) {
    console.error(`[opinion-deadline] error: ${err.message}`);
  }
}, OPINION_DEADLINE_CHECK_MS);

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
      const event = { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: r.body, origin_aro: r.origin_aro || null, ts: r.ts };
      sendToChannel(agent, event);
    }
    // sendToChannel already handles cursor for non-bridged agents
    // For bridged Codex agents, bridge advances cursor via /read-ack
    if (!isCodexAgent(agent)) {
      stmtUpsertCursor.run(agent, maxId);
    }
  }
}

setInterval(pollForDirectWrites, 2000);

function sendToChannel(agent, event) {
  const res = channels.get(agent);
  if (res) {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    // Don't advance cursor for bridged Codex agents — bridge handles it via /read-ack
    if (!isCodexAgent(agent)) {
      stmtUpsertCursor.run(agent, event.id);
    }
    return true;
  }
  return false;
}

function broadcastToChannels(event, excludeSender) {
  for (const [agent, res] of channels) {
    if (agent !== excludeSender) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
      if (!isCodexAgent(agent)) {
        stmtUpsertCursor.run(agent, event.id);
      }
    }
  }
}

// Detect the single-key {message: "..."} wrapper, accepting both the object
// form AND a JSON-stringified form (agents complying with the new string-only
// tool schema often JSON.stringify their object first and pass a string).
function unwrapSingleMessageKey(raw) {
  if (raw == null || typeof raw !== 'object') return null;
  const keys = Object.keys(raw);
  if (keys.length === 1 && keys[0] === 'message' && typeof raw.message === 'string') {
    return raw.message;
  }
  return null;
}

function tryParseJsonObject(s) {
  if (typeof s !== 'string') return null;
  const t = s.trimStart();
  if (t[0] !== '{') return null;
  try {
    const parsed = JSON.parse(s);
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : null;
  } catch { return null; }
}

// Normalise a POST /send `message` field into a plain text body.
// - object {message: "..."} → unwrap
// - string that parses to {message: "..."} → unwrap (agents pre-stringify)
// - any other object → JSON.stringify
// - anything else → coerce to string
// Clients always see body as a string and can parse it themselves if needed.
function normalizeBody(raw) {
  if (raw == null) return '';
  if (typeof raw === 'object') {
    const unwrapped = unwrapSingleMessageKey(raw);
    return unwrapped != null ? unwrapped : JSON.stringify(raw);
  }
  if (typeof raw === 'string') {
    const parsed = tryParseJsonObject(raw);
    if (parsed) {
      const unwrapped = unwrapSingleMessageKey(parsed);
      if (unwrapped != null) return unwrapped;
    }
    return raw;
  }
  return String(raw);
}

// Detect the legacy wrapper on the raw payload so /send can fire a corrective
// nudge back to the sender. Same two shapes normalizeBody accepts.
function isWrappedMessage(raw) {
  if (raw == null) return false;
  if (typeof raw === 'object') return unwrapSingleMessageKey(raw) != null;
  if (typeof raw === 'string') {
    const parsed = tryParseJsonObject(raw);
    return parsed != null && unwrapSingleMessageKey(parsed) != null;
  }
  return false;
}

// Send message and push to connected channels. originAro (optional) is the
// aro:X target the sender asked for; stored on the per-recipient row so the
// TUI/agents can reconstruct room attribution for ARO fanout messages.
const sendMessage = db.transaction((sender, recipient, reTag, body, originAro = null) => {
  const row = stmtInsertMsg.get(sender, recipient, reTag || null, body, originAro || null);
  const { id, tag, ts } = row;

  const event = {
    id, from: sender, to: recipient, tag, re: reTag || null,
    body, origin_aro: originAro || null, ts,
  };

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
    return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: r.body, origin_aro: r.origin_aro || null, ts: r.ts };
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
    return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: r.body, origin_aro: r.origin_aro || null, ts: r.ts };
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

// An agent is Codex-managed if either (a) its name uses the -ca- naming
// convention, or (b) it has an entry in the bridge registrations file. The
// registry check catches outliers like 'oid2' that predate the naming rule —
// without this, such agents were treated as CC, the hub would push to SSE
// (which Codex ignores) and silently advance their cursor. Result: messages
// marked delivered that the Codex thread never saw.
function isCodexAgent(agent) {
  const parts = agent.split('-');
  if (parts.includes('ca')) return true;
  return !!loadBridgeRegistry()[agent];
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

// True if agent is actually reachable right now:
// - CC: has live SSE connection
// - Codex: has active bridge registration AND recent heartbeat (<30s)
function isAgentOnline(agent) {
  if (channels.has(agent)) return true;
  if (isCodexAgent(agent)) {
    return hasActiveBridgeRegistration(agent) && !!stmtCheckOnline.get(agent);
  }
  return false;
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
      // TCP keepalive surfaces zombie sockets (NAT timeouts, conntrack drops) as socket errors
      // instead of silent hangs, so req.on('close') actually fires and we evict from channels.
      if (req.socket && typeof req.socket.setKeepAlive === 'function') {
        req.socket.setKeepAlive(true, 15000);
      }
      res.write(`: connected as ${agent}\n\n`);

      channels.set(agent, res);
      stmtUpdateLastSeen.run(agent); // refresh last_seen_at so ARO fanout keeps this agent active
      console.log(`[connect] ${agent} (${channels.size} connected)`);

      // Application-level heartbeat. A ping comment every 25s keeps NAT/firewall state alive
      // and, more importantly, makes write() fail with EPIPE on dead sockets so we close and
      // evict them instead of leaving the channels Map pointing at a zombie response.
      const heartbeat = setInterval(() => {
        try {
          res.write(`: ping ${Date.now()}\n\n`);
          // Refresh last_seen_at on every successful ping so live SSE agents
          // do not drift past the stale-roster sweep threshold even when they
          // never call /heartbeat or /register again. Without this, the
          // sweeper would reap genuinely-connected agents.
          stmtUpdateLastSeen.run(agent);
        } catch {
          // Write error — close handler will evict. Stop pinging.
          clearInterval(heartbeat);
          try { res.end(); } catch {}
        }
      }, 25000);

      // Deliver any unread messages so the agent catches up on anything
      // stored between /register and /connect (onboarding guide, missed
      // direct sends, etc.). Cursor is advanced by sendToChannel-equivalent
      // path below. Skip for bridged Codex agents — the bridge owns cursor.
      if (!isCodexAgent(agent)) {
        const unread = getUnreadMessages(agent);
        for (const msg of unread) {
          res.write(`data: ${JSON.stringify(msg)}\n\n`);
          stmtUpsertCursor.run(agent, msg.id);
        }
      }

      req.on('close', () => {
        clearInterval(heartbeat);
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

      // Reject if a *different* session already has an active SSE connection for this agent.
      // old_agent === agent means same session re-registering (normal after unregister+register).
      // old_agent is a different name means SSE migration (also normal).
      // No old_agent AND existing SSE means a second session is trying to claim the name.
      const existingSSE = channels.get(agent);
      if (existingSSE && !old_agent) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: `agent '${agent}' already has an active session. Kill the other session first or use a different name.` }));
        return;
      }

      stmtRegister.run(agent, cwd);

      // First-time registration: initialize cursor at MAX(id) so the agent
      // starts "caught up" without receiving the full broadcast backlog.
      // Existing agents keep their cursor (upsert only inserts if missing).
      const isFirstTimeRegister = !stmtGetCursor.get(agent);
      if (isFirstTimeRegister) {
        const maxRow = db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM messages`).get();
        stmtUpsertCursor.run(agent, maxRow.max_id);

        // Seed the system agent in the roster so it can send messages.
        stmtRegister.run('system', '/opt/llmmsg');
      }

      // Push the current messaging guide on /register only when the agent
      // has never received this version. Tracked in guide_delivered (agent
      // PK, guide_version). On version bump, every agent gets it once on
      // its next register; repeat registers of the same version are silent.
      // Cuts the dominant `system` token spend flagged by KPI v1.8.
      //
      // Order matters: write guide_delivered FIRST, then push. Prior code
      // pushed first inside an empty try/catch, so a failed
      // stmtSetGuideDelivered.run silently lost the gating record and the
      // next register re-pushed the same v2.9 guide. Confirmed cause of the
      // 24-pushes-per-day spike on mars-pm/db/coder-cc-w.
      const guideRow = stmtGetConfig.get('message_guide');
      if (guideRow && guideRow.value) {
        const delivered = stmtGetGuideDelivered.get(agent);
        if (!delivered || delivered.guide_version !== guideRow.version) {
          try {
            stmtSetGuideDelivered.run(agent, guideRow.version);
            const guideText = `Messaging guide v${guideRow.version}:\n${guideRow.value}`;
            sendMessage('system', agent, null, guideText);
          } catch (err) {
            console.error(`[register] guide-push failed for ${agent}: ${err.message}`);
          }
        }
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

      // Deliver any unread messages via SSE catch-up
      // Skip cursor advancement for bridged Codex agents — bridge handles it
      const sseRes = channels.get(agent);
      const isBridged = isCodexAgent(agent) && hasActiveBridgeRegistration(agent);
      if (sseRes) {
        const unread = getUnreadMessages(agent);
        for (const msg of unread) {
          sseRes.write(`data: ${JSON.stringify(msg)}\n\n`);
          if (!isBridged) {
            stmtUpsertCursor.run(agent, msg.id);
          }
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
        const aroChanges = stmtDeleteAroByAgent.run(agent).changes;
        const sseConn = channels.get(agent);
        if (existed) {
          stmtUnregister.run(agent);
        }
        if (sseConn) {
          sseConn.end();
          channels.delete(agent);
        }
        if (existed || aroChanges > 0 || sseConn) {
          removed.push(agent);
          console.log(`[unregister] ${agent}`);
        }
      }
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }

    if (req.method === 'POST' && path === '/send') {
      const body = await parseBody(req);
      const { from, to, re, message, expects_replies, reply_deadline_ms, close_policy } = body;
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
      // Validate reply route. If the referenced message originated in an
      // ARO, replies must stay in that ARO; otherwise agents keep dragging
      // room conversations into DMs. Cross-site tags may not exist locally,
      // so unknown tags remain warn-only.
      if (re) {
        const route = stmtReplyRoute.get(re);
        if (!route) {
          console.log(`[send] re tag '${re}' not found locally (may be cross-site)`);
        } else if (route.origin_aro && to !== route.origin_aro && to !== '*') {
          res.writeHead(400);
          res.end(JSON.stringify({
            error: 'wrong_route',
            expected_to: route.origin_aro,
            re,
            hint: `Reply to the originating ARO, not the sender. Retry with to=${route.origin_aro}.`,
          }));
          return;
        }
      }
      // Per-send corrective nudge: if the agent sent the legacy {message: "..."}
      // wrapper (object form OR a pre-stringified string form), push a system
      // message to the sender pointing at guide rule 13. Placed ABOVE the
      // aro/remote/local branch split so it fires on all send paths. Nudge is
      // fire-and-forget; failures never affect the main send result.
      if (isWrappedMessage(message)) {
        try {
          const guideRow = stmtGetConfig.get('message_guide');
          const v = guideRow ? guideRow.version : '?';
          const nudge =
            `format reminder: your last send to '${to}' used the legacy {"message":"..."} wrapper ` +
            `(object or pre-stringified). The hub unwrapped it, but send the body as a plain string. ` +
            `See guide rule 13 (v${v}) — call the 'guide' tool for the full text.`;
          sendMessage('system', from, null, nudge);
        } catch (e) {
          console.log(`[send] nudge failed for ${from}: ${e.message}`);
        }
      }

      // Per-send length nudge: ARO fan-out multiplies every byte by N recipients,
      // so long sends are the dominant token cost. Warn (never reject) when body
      // exceeds LENGTH_NUDGE_THRESHOLD. Same self-healing pattern as the wrapper
      // nudge: fire-and-forget, failures never affect the primary send result.
      try {
        const previewBody = typeof message === 'string'
          ? message
          : (message && typeof message === 'object' ? JSON.stringify(message) : String(message ?? ''));
        if (previewBody.length > LENGTH_NUDGE_THRESHOLD) {
          const guideRow = stmtGetConfig.get('message_guide');
          const v = guideRow ? guideRow.version : '?';
          const target = to.startsWith('aro:')
            ? `ARO ${to} (fan-out multiplies this by every member)`
            : `'${to}'`;
          const nudge =
            `length reminder: your last send to ${target} was ${previewBody.length} chars ` +
            `(threshold ${LENGTH_NUDGE_THRESHOLD}). See guide rules 11, 15, 17, 19 (v${v}) — ` +
            `no dossier dumps on ARO; summarize in 1–2 lines, cite by tag or offer on request. ` +
            `Exception: if the user/PM explicitly asked for the full artifact in this thread, ignore this nudge.`;
          sendMessage('system', from, null, nudge);
        }
      } catch (e) {
        console.log(`[send] length-nudge failed for ${from}: ${e.message}`);
      }

      // aro fan-out: to: "aro:mars" → send to each active member individually
      // "active" = has a live SSE connection OR was seen (heartbeat/register) in the last 30s
      if (to.startsWith('aro:')) {
        const aroName = to.slice(4);
        const msgBody = normalizeBody(message);
        const originAro = `aro:${aroName}`;
        const members = activeAroMembers(aroName, from);
        const results = members.map(member => sendMessage(from, member, re || null, msgBody, originAro));

        // Opinion-request lifecycle: when sender flags expects_replies, snapshot
        // the wheel and a deadline. The deadline timer auto-closes the request
        // as 'closed:incomplete' so opinion threads cannot stall forever.
        // Reply tracking + 'all_expected' close policy land in Phase 2b.
        if (expects_replies !== undefined && expects_replies !== false && results.length > 0) {
          try {
            let expected;
            if (Array.isArray(expects_replies)) {
              expected = expects_replies.filter(a => typeof a === 'string' && a !== from);
            } else {
              // expects_replies === true or any truthy value: snapshot online members
              expected = members.slice();
            }
            const deadlineMs = Number.isFinite(reply_deadline_ms)
              ? reply_deadline_ms
              : 15 * 60 * 1000;
            const deadlineAt = Math.floor(Date.now() / 1000) + Math.floor(deadlineMs / 1000);
            const policy = (close_policy === 'all_expected' || close_policy === 'manual') ? close_policy : 'deadline';
            stmtInsertOpinionRequest.run(
              results[0].tag,
              aroName,
              from,
              JSON.stringify(expected),
              deadlineAt,
              policy
            );
          } catch (err) {
            console.error(`[opinion-request] insert failed for ${from} on aro:${aroName}: ${err.message}`);
          }
        }

        const remoteLookups = remoteHubEntries.length > 0
          ? await Promise.all(remoteHubEntries.map(([name, url]) => listRemoteAroOnline(name, url, aroName)))
          : [];
        const remoteTargets = [];
        const seenRemoteAgents = new Set();
        for (const lookup of remoteLookups) {
          if (!lookup.ok) continue;
          const hubEntry = remoteHubEntries.find(([name]) => name === lookup.hub);
          if (!hubEntry) continue;
          for (const agent of lookup.online) {
            if (agent === from || members.includes(agent) || seenRemoteAgents.has(agent)) continue;
            seenRemoteAgents.add(agent);
            remoteTargets.push({ agent, hubName: hubEntry[0], hubUrl: hubEntry[1] });
          }
        }
        const remoteAgents = remoteTargets.map(t => t.agent).sort();
        const remoteResults = [];
        for (const target of remoteTargets) {
          const localCopy = sendMessage(from, target.agent, re || null, msgBody, originAro);
          const payload = { from, to: target.agent, re: re || null, message: msgBody, origin_site: SITE_NAME, origin_tag: localCopy.tag, origin_aro: originAro };
          const forward = await forwardToRemoteHub(target.hubName, target.hubUrl, payload);
          remoteResults.push({ agent: target.agent, tag: localCopy.tag, forwards: [forward] });
        }

        const remoteAccepted = remoteResults.some(r => r.forwards.some(f => f.ok || f.queued));
        if (!members.length && !remoteAccepted) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: `aro '${aroName}' has no active members (or only the sender)` }));
          return;
        }

        res.end(JSON.stringify({
          ok: true,
          aro: aroName,
          members: members.concat(remoteAgents),
          local_members: members,
          remote_members: remoteAgents,
          sent: results.length + remoteResults.length,
          ids: results.map(r => r.id),
          tags: results.map(r => r.tag).concat(remoteResults.map(r => r.tag)),
          forwarded: remoteResults.length > 0,
          remote_lookups: remoteLookups.map(r => ({ hub: r.hub, ok: r.ok, count: r.online.length })),
          remotes: remoteResults.flatMap(r => r.forwards.map(f => ({ agent: r.agent, hub: f.hub, ok: f.ok, queued: f.queued || false }))),
        }));
        return;
      }

      if (to !== '*') {
        const localKnown = stmtCheckRoster.get(to) || hasActiveBridgeRegistration(to);

        if (!localKnown) {
          // Recipient not local — try remote hubs
          if (remoteHubEntries.length > 0) {
            const msgBody = normalizeBody(message);
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

        // Recipient is local. Store direct messages even when the recipient is
        // currently offline; hub/bridge cursors deliver backlog on reconnect.
      }

      const msgBody = normalizeBody(message);
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
      const localOnly = url.searchParams.get('local') === '1';
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
        const merged = new Set([...aroMembers].filter(a => onlineSet.has(a)));
        // Multi-site: fold in online agents from remote hubs for each aro.
        // This closes the cross-site /online gap — without this, each agent's
        // `online` tool sees only its local hub's members of the ARO.
        // `local=1` short-circuits the merge so remote-to-remote recursion
        // can't loop.
        if (remoteHubEntries.length && !localOnly) {
          const lookups = [];
          for (const a of aroFilter) {
            for (const [name, url] of remoteHubEntries) {
              lookups.push(listRemoteAroOnline(name, url, a));
            }
          }
          const results = await Promise.all(lookups);
          for (const r of results) {
            if (!r.ok) continue;
            for (const agent of r.online) merged.add(agent);
          }
        }
        const filtered = [...merged].sort();
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
        if (r.retracted_at) return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, retracted: true, origin_aro: r.origin_aro || null, ts: r.ts };
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: r.body, origin_aro: r.origin_aro || null, ts: r.ts };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/search') {
      const text = url.searchParams.get('q');
      if (!text) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing q' })); return; }
      const rows = stmtSearch.all(`%${text}%`);
      const messages = rows.map(r => {
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: r.body, origin_aro: r.origin_aro || null, ts: r.ts };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/log') {
      const limit = parseInt(url.searchParams.get('limit') || '20');
      const rows = stmtLog.all(limit);
      const messages = rows.map(r => {
        if (r.retracted_at) return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, retracted: true, origin_aro: r.origin_aro || null, ts: r.ts };
        const preview = (r.body || '').slice(0, 120);
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, preview, origin_aro: r.origin_aro || null, ts: r.ts };
      });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.method === 'GET' && path === '/history') {
      const agent = (url.searchParams.get('agent') || '').toLowerCase();
      const bucket = url.searchParams.get('bucket');
      const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('limit') || '80')));
      if (!agent || !bucket) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing agent or bucket' })); return; }

      let rows;
      if (bucket.startsWith('aro:')) {
        rows = stmtHistoryAro.all(bucket, bucket, limit);
      } else {
        rows = stmtHistoryDm.all(agent, bucket, bucket, agent, limit);
      }
      const messages = rows.map(r => {
        if (r.retracted_at) return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, retracted: true, origin_aro: r.origin_aro || null, ts: r.ts };
        return { id: r.id, from: r.sender, to: r.recipient, tag: r.tag, re: r.re, body: r.body, origin_aro: r.origin_aro || null, ts: r.ts };
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
      const aro = (body.aro || '').toLowerCase().replace(/^aro:/, '');
      const agent = (body.agent || '').toLowerCase();
      if (!aro || !agent) { res.writeHead(400); res.end(JSON.stringify({ error: 'missing aro or agent' })); return; }
      // Reject ARO names that collide with existing agent names — these are
      // almost always a bug from client code stripping a suffix and round-
      // tripping the agent name as an ARO. Prevents oid2/sh/llmmsg-style
      // garbage rows reappearing.
      if (stmtCheckRoster.get(aro)) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: `ARO name '${aro}' collides with an existing agent; pick a different name`,
        }));
        return;
      }
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
      const { from, to, re, message, origin_site, origin_tag, origin_aro } = body;
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

      const msgBody = normalizeBody(message);

      if (to.startsWith('aro:')) {
        const aroName = to.slice(4);
        const members = activeAroMembers(aroName, from);
        if (!members.length) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: `aro '${aroName}' has no active members on this site` }));
          return;
        }

        const results = members.map(member => sendMessage(from, member, re || null, msgBody, to));
        if (origin_tag && results[0]) {
          stmtSetOriginTag.run(origin_tag, results[0].id);
        }
        console.log(`[inbound] ${from} → ${to} from site ${origin_site || 'unknown'} (origin tag: ${origin_tag || 'none'}) → local fanout ${results.length}`);
        res.end(JSON.stringify({ ok: true, aro: aroName, members, sent: results.length, ids: results.map(r => r.id) }));
        return;
      }

      // Check if recipient is local
      const isLocal = stmtCheckRoster.get(to) || hasActiveBridgeRegistration(to);
      if (!isLocal && to !== '*') {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `recipient '${to}' not on this site` }));
        return;
      }

      const result = sendMessage(from, to, re || null, msgBody, origin_aro || null);
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
