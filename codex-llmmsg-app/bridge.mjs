#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CodexRpcClient } from './rpc-client.mjs';

const VERSION = '1.4';

import { execSync } from 'node:child_process';

const APP_DIR = path.dirname(new URL(import.meta.url).pathname);
const REGISTRY_PATH = path.join(APP_DIR, 'registrations.json');
const MESSAGE_DB = process.env.LLMMSG_DB || '/opt/llmmsg/db/llmmsg.sqlite';
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:8788';

// Headless Codex threads (no CLI) accumulate in registrations.json and silently
// bill tokens whenever messages arrive. Sweep entries that show no activity
// (no deliveries, no re-register) for INACTIVITY_TTL_MS — applies to both
// active and suspended entries. Override with LLMMSG_BRIDGE_TTL_MS for tests.
const INACTIVITY_TTL_MS = parseInt(process.env.LLMMSG_BRIDGE_TTL_MS || `${24 * 60 * 60 * 1000}`, 10);
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1h

// Orphan detector: every 5min, scan running codex CLIs and archive +
// unregister any registration whose agent has no attached CLI. Honors a
// grace window (ORPHAN_GRACE_MS) so a registration created moments ago by
// cf.sh isn't reaped before its CLI process is fully visible to ps.
const ORPHAN_SCAN_INTERVAL_MS = 5 * 60 * 1000;
const ORPHAN_GRACE_MS = 2 * 60 * 1000;

fs.mkdirSync(APP_DIR, { recursive: true });

function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) return {};
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function saveRegistry(registry) {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
}

const HUB_URL = process.env.LLMMSG_HUB_URL || 'http://127.0.0.1:9701';

import http from 'node:http';

function hubRegister(agent, cwd) {
  if (!cwd) return Promise.resolve();
  // old_agent: agent makes the hub treat this as a self-refresh instead of a
  // new-session claim. Without this, running `bridge.mjs register <agent>` for
  // an already-connected Codex agent hits the hub's "active session" 409.
  const data = JSON.stringify({ agent, cwd, old_agent: agent });
  return new Promise((resolve, reject) => {
    const req = http.request(`${HUB_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => reject(new Error(`hub register failed: ${res.statusCode} ${Buffer.concat(chunks).toString('utf8')}`)));
        return;
      }
      res.resume();
      resolve();
    });
    req.on('error', reject);
    req.end(data);
  });
}

function hubReadAck(agent, throughId) {
  const data = JSON.stringify({ agent, through_id: throughId });
  return new Promise((resolve) => {
    const req = http.request(`${HUB_URL}/read-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.end(data);
  });
}

const msgDb = new Database(MESSAGE_DB);
msgDb.pragma('journal_mode = WAL');
msgDb.pragma('busy_timeout = 2000');

const messageColumns = new Set(msgDb.pragma('table_info(messages)').map((col) => col.name));
const originAroSelect = messageColumns.has('origin_aro') ? 'origin_aro' : 'NULL AS origin_aro';
const selectUnread = msgDb.prepare(`
  SELECT id, sender, recipient, tag, re, body, ${originAroSelect}
  FROM messages
  WHERE (recipient = ? OR recipient = '*')
    AND id > ?
    AND retracted_at IS NULL
  ORDER BY id
`);
const getCursor = msgDb.prepare('SELECT read_id FROM cursors WHERE agent = ?');
const setCursor = msgDb.prepare(`
  INSERT INTO cursors (agent, read_id) VALUES (?, ?)
  ON CONFLICT(agent) DO UPDATE SET read_id = MAX(cursors.read_id, excluded.read_id)
`);

function safeParse(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// REPLY CONTRACT wrap was removed in v1.2 — it rendered in Codex TUI scrollback
// on every inbound message (top + bottom), producing visible noise that scaled
// linearly with traffic. The transport rule lives durably in channel.mjs MCP
// instructions, the DB message_guide (rule 1), CODEX.md, and AGENTS.md; those
// surfaces reach the model without user-visible terminal spam.
function buildPrompt(message) {
  const body = typeof message.body === 'string' ? message.body : JSON.stringify(message.body);
  const replyTo = message.origin_aro || message.from;
  const to = message.recipient || message.to || '';
  const attrs = [
    `from="${message.from}"`,
    `to="${to}"`,
    `tag="${message.tag}"`,
    `reply_to="${replyTo}"`,
    `reply_via="llmmsg-channel"`,
    message.origin_aro ? `origin_aro="${message.origin_aro}"` : '',
    message.re ? `re="${message.re}"` : '',
  ].filter(Boolean).join(' ');
  return `<channel ${attrs}>${body}</channel>`;
}

async function listLoadedThreads(client) {
  const loaded = await client.request('thread/loaded/list', {});
  return loaded.data;
}

async function readThread(client, threadId) {
  const result = await client.request('thread/read', { threadId, includeTurns: false });
  return result.thread;
}

function isThreadGoneError(error) {
  return /thread.*(not found|does not exist)/i.test(error.message);
}

async function startTurnWithResume(agent, client, mapping, input) {
  try {
    await client.request('turn/start', {
      threadId: mapping.threadId,
      input,
    });
    return;
  } catch (error) {
    if (!isThreadGoneError(error) || !mapping.cwd) {
      throw error;
    }

    process.stdout.write('[recover] ' + agent + ': retrying after thread/resume for ' + mapping.threadId + '\n');
    try {
      await client.request('thread/resume', {
        threadId: mapping.threadId,
        cwd: mapping.cwd,
      });
      await client.request('turn/start', {
        threadId: mapping.threadId,
        input,
      });
      process.stdout.write('[recovered] ' + agent + ': ' + mapping.threadId + '\n');
    } catch (retryError) {
      throw new Error(error.message + '; recovery failed: ' + retryError.message);
    }
  }
}

async function registerAgent(agent, { threadId, cwd, latest } = {}) {
  const client = new CodexRpcClient({ url: APP_SERVER_URL });
  await client.connect();

  try {
    let resolvedThread = null;
    let resolvedThreadId = threadId;
    if (!resolvedThreadId) {
      const loaded = await listLoadedThreads(client);
      const threads = [];
      for (const id of loaded) {
        const thread = await readThread(client, id);
        threads.push(thread);
      }
      let filtered = threads;
      if (cwd) filtered = filtered.filter((thread) => thread.cwd === cwd);
      if (!filtered.length) filtered = threads;
      filtered.sort((a, b) => b.updatedAt - a.updatedAt);
      if (!filtered.length) {
        throw new Error('no loaded thread matches registration query');
      }
      resolvedThread = filtered[0];
      resolvedThreadId = resolvedThread.id;
    } else if (!cwd) {
      resolvedThread = await readThread(client, resolvedThreadId);
    }

    const registry = loadRegistry();
    const resolvedCwd = cwd || resolvedThread?.cwd || registry[agent]?.cwd || null;
    registry[agent] = {
      threadId: resolvedThreadId,
      registeredAt: new Date().toISOString(),
      cwd: resolvedCwd,
      // clear any suspension — registration is always authoritative
    };
    saveRegistry(registry);
    await hubRegister(agent, resolvedCwd);
    return registry[agent];
  } finally {
    await client.close();
  }
}

async function deliverUnread(agent) {
  const registry = loadRegistry();
  const mapping = registry[agent];
  if (!mapping) {
    throw new Error(`agent '${agent}' is not registered`);
  }
  if (mapping.suspended) {
    return { delivered: 0, cursorId: getCursor.get(agent)?.read_id || 0 };
  }

  const cursorId = getCursor.get(agent)?.read_id || 0;
  const rows = selectUnread.all(agent, cursorId);
  if (!rows.length) {
    return { delivered: 0, cursorId };
  }

  const client = new CodexRpcClient({ url: APP_SERVER_URL });
  await client.connect();

  let maxId = cursorId;
  try {
    for (const row of rows) {
      if (row.id > maxId) maxId = row.id;
      const body = safeParse(row.body);
      await startTurnWithResume(agent, client, mapping, [
        { type: 'text', text: buildPrompt({ id: row.id, from: row.sender, to: row.recipient, tag: row.tag, re: row.re, body }), text_elements: [] },
      ]);
    }

    setCursor.run(agent, maxId);
    await hubReadAck(agent, maxId);
    // Mark this registration as recently active so the inactivity sweep does
    // not reap it. Re-read the file to avoid clobbering parallel updates.
    const reg = loadRegistry();
    if (reg[agent]) {
      reg[agent].lastActivityAt = new Date().toISOString();
      saveRegistry(reg);
    }
  } finally {
    await client.close();
  }
  return { delivered: rows.length, cursorId: maxId };
}

// Archive a thread on the codex-app-server. Best-effort: if the thread is
// already gone or the server doesn't recognize it, we still proceed.
async function archiveThread(threadId) {
  if (!threadId) return false;
  const client = new CodexRpcClient({ url: APP_SERVER_URL });
  try {
    await client.connect();
    await client.request('thread/archive', { threadId });
    return true;
  } catch (err) {
    if (!isThreadGoneError(err)) {
      process.stderr.write(`[archive] ${threadId}: ${err.message}\n`);
    }
    return false;
  } finally {
    await client.close().catch(() => {});
  }
}

// Notify the hub to drop the agent from roster + aros. Best-effort.
function hubUnregister(agent) {
  return new Promise((resolve) => {
    const data = JSON.stringify({ agent });
    const req = http.request(`${HUB_URL}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.end(data);
  });
}

// Inspect running codex CLI processes. Returns the set of agent labels
// found in argv ("Your agent name is X.") and the set of threadIds found
// in argv ("codex resume <uuid>"). Either match counts as "attached".
function listAttachedSessions() {
  const attachedAgents = new Set();
  const attachedThreads = new Set();
  let psOut = '';
  try {
    psOut = execSync('ps -eo args --no-headers', { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  } catch {
    return { attachedAgents, attachedThreads };
  }
  for (const line of psOut.split('\n')) {
    if (!/\bcodex\b/.test(line) || !/--remote\b/.test(line)) continue;
    const nameMatch = line.match(/Your agent name is ([A-Za-z0-9_.-]+)/);
    if (nameMatch) attachedAgents.add(nameMatch[1].toLowerCase());
    const tidMatch = line.match(/\bresume\s+([0-9a-f-]{36})/);
    if (tidMatch) attachedThreads.add(tidMatch[1]);
  }
  return { attachedAgents, attachedThreads };
}

// Orphan sweep: archive + unregister registrations whose agent has no
// attached CLI process. Skips entries within ORPHAN_GRACE_MS of registration
// to avoid racing cf.sh's launch sequence. Suspended entries are considered
// orphans-by-definition and pass through to inactivity TTL.
async function sweepOrphans() {
  const registry = loadRegistry();
  const { attachedAgents, attachedThreads } = listAttachedSessions();
  const now = Date.now();
  const toRemove = [];
  for (const [agent, mapping] of Object.entries(registry)) {
    if (mapping.suspended) continue;
    const regAt = Date.parse(mapping.registeredAt || '');
    if (Number.isFinite(regAt) && now - regAt < ORPHAN_GRACE_MS) continue;
    const lastAt = Date.parse(mapping.lastActivityAt || mapping.registeredAt || '');
    if (Number.isFinite(lastAt) && now - lastAt < ORPHAN_GRACE_MS) continue;
    const hasAgentCli = attachedAgents.has(agent.toLowerCase());
    const hasThreadCli = mapping.threadId && attachedThreads.has(mapping.threadId);
    if (!hasAgentCli && !hasThreadCli) {
      toRemove.push({ agent, threadId: mapping.threadId });
    }
  }
  if (!toRemove.length) return;
  for (const { agent, threadId } of toRemove) {
    await archiveThread(threadId);
  }
  // Re-read registry to avoid clobbering parallel writes (deliverUnread sets lastActivityAt).
  const reg = loadRegistry();
  for (const { agent } of toRemove) {
    delete reg[agent];
  }
  saveRegistry(reg);
  for (const { agent, threadId } of toRemove) {
    process.stdout.write(`[orphan-sweep] archived ${agent} (thread ${threadId}) — no attached CLI\n`);
    await hubUnregister(agent);
  }
}

// Reap registrations that have shown no activity for INACTIVITY_TTL_MS.
// "Activity" = lastActivityAt (set on delivery) OR registeredAt (the act of
// (re-)registering counts). Applies to suspended entries too — if a session
// died and never came back, the suspended row only takes up space.
function sweepInactive() {
  const registry = loadRegistry();
  const now = Date.now();
  const removed = [];
  for (const [agent, mapping] of Object.entries(registry)) {
    const tsStr = mapping.lastActivityAt || mapping.registeredAt;
    if (!tsStr) continue;
    const last = Date.parse(tsStr);
    if (Number.isNaN(last)) continue;
    if (now - last > INACTIVITY_TTL_MS) {
      removed.push({ agent, age_h: ((now - last) / 3600000).toFixed(1), suspended: !!mapping.suspended });
      delete registry[agent];
    }
  }
  if (removed.length) {
    saveRegistry(registry);
    for (const r of removed) {
      process.stdout.write(`[sweep] removed ${r.agent} (age ${r.age_h}h, ${r.suspended ? 'suspended' : 'active'})\n`);
    }
  }
}

// Heartbeat: tell the hub this agent is alive so /online includes bridge-polled agents
function hubHeartbeat(agent) {
  const data = JSON.stringify({ agent });
  return new Promise((resolve) => {
    const req = http.request(`${HUB_URL}/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); resolve(); });
    req.on('error', () => resolve());
    req.end(data);
  });
}

const staleErrors = new Map(); // agent → consecutive error count

async function watchAgents(pollMs = 2000) {
  let lastSweep = Date.now();
  let lastOrphanScan = Date.now();
  sweepInactive();
  // Initial orphan scan deferred to first interval — startup race.
  for (;;) {
    if (Date.now() - lastSweep > SWEEP_INTERVAL_MS) {
      sweepInactive();
      lastSweep = Date.now();
    }
    if (Date.now() - lastOrphanScan > ORPHAN_SCAN_INTERVAL_MS) {
      try { await sweepOrphans(); } catch (err) {
        process.stderr.write(`[orphan-sweep] error: ${err.message}\n`);
      }
      lastOrphanScan = Date.now();
    }
    const registry = loadRegistry();
    for (const [agent, mapping] of Object.entries(registry)) {
      if (mapping.suspended) continue; // skip until re-registered
      await hubHeartbeat(agent); // keep last_seen_at fresh so /online includes this agent
      try {
        const result = await deliverUnread(agent);
        if (result.delivered > 0) {
          process.stdout.write(`[delivered] ${agent}: ${result.delivered}\n`);
        }
        staleErrors.delete(agent);
      } catch (error) {
        const count = (staleErrors.get(agent) || 0) + 1;
        staleErrors.set(agent, count);
        const isThreadGone = isThreadGoneError(error);
        if (isThreadGone || count >= 10) {
          // Suspend delivery but keep the registration — the session may restart
          // and re-register with a new thread ID. Deleting here would lose state.
          process.stderr.write(`[suspend] ${agent}: ${count} consecutive errors (${error.message}), suspending delivery until re-register\n`);
          const reg = loadRegistry();
          if (reg[agent]) {
            reg[agent].suspended = true;
            reg[agent].suspendedAt = new Date().toISOString();
            reg[agent].suspendReason = error.message;
            saveRegistry(reg);
          }
          staleErrors.delete(agent);
        } else {
          process.stderr.write(`[error] ${agent} (${count}/10): ${error.message}\n`);
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'register') {
    const agent = args[0];
    const threadId = args.includes('--thread-id') ? args[args.indexOf('--thread-id') + 1] : undefined;
    const cwd = args.includes('--cwd') ? args[args.indexOf('--cwd') + 1] : undefined;
    const result = await registerAgent(agent, { threadId, cwd, latest: true });
    console.log(JSON.stringify({ ok: true, agent, ...result }, null, 2));
    return;
  }

  if (command === 'deliver') {
    const agent = args[0];
    const result = await deliverUnread(agent);
    console.log(JSON.stringify({ ok: true, agent, ...result }, null, 2));
    return;
  }

  if (command === 'watch') {
    const pollMs = args.includes('--poll-ms') ? parseInt(args[args.indexOf('--poll-ms') + 1], 10) : 2000;
    await watchAgents(pollMs);
    return;
  }

  if (command === 'list') {
    console.log(JSON.stringify(loadRegistry(), null, 2));
    return;
  }

  if (command === 'unregister') {
    const agent = args[0];
    if (!agent) {
      console.error('unregister requires an agent name');
      process.exit(1);
    }
    const registry = loadRegistry();
    const existed = Object.prototype.hasOwnProperty.call(registry, agent);
    if (existed) {
      delete registry[agent];
      saveRegistry(registry);
    }
    console.log(JSON.stringify({ ok: true, agent, removed: existed }));
    return;
  }

  if (command === 'archive') {
    // Archive the codex thread and remove the bridge registration. Used by
    // cf.sh's exit trap so a CLI session cannot leave a thread loaded
    // server-side after it exits. agent OR --thread-id must be supplied.
    const agent = args[0];
    const tidIdx = args.indexOf('--thread-id');
    let threadId = tidIdx >= 0 ? args[tidIdx + 1] : null;
    const registry = loadRegistry();
    if (!threadId && agent) {
      threadId = registry[agent]?.threadId || null;
    }
    if (!threadId) {
      console.error('archive requires --thread-id or a known agent');
      process.exit(1);
    }
    const archived = await archiveThread(threadId);
    let removed = false;
    if (agent && registry[agent]) {
      delete registry[agent];
      saveRegistry(registry);
      removed = true;
      await hubUnregister(agent);
    }
    console.log(JSON.stringify({ ok: true, agent: agent || null, threadId, archived, registry_removed: removed }));
    return;
  }

  if (command === 'is-suspended') {
    const agent = args[0];
    if (!agent) {
      console.error('is-suspended requires an agent name');
      process.exit(1);
    }
    const registry = loadRegistry();
    const entry = registry[agent];
    const suspended = Boolean(entry?.suspended);
    const threadId = entry?.threadId || null;
    console.log(JSON.stringify({ agent, suspended, threadId }));
    return;
  }

  console.error('Usage: bridge.mjs register <agent> [--thread-id <id> | --cwd <cwd>] | deliver <agent> | watch [--poll-ms N] | list | unregister <agent> | is-suspended <agent> | archive <agent> [--thread-id <id>]');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
