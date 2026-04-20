#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CodexRpcClient } from './rpc-client.mjs';

const APP_DIR = path.dirname(new URL(import.meta.url).pathname);
const REGISTRY_PATH = path.join(APP_DIR, 'registrations.json');
const MESSAGE_DB = process.env.LLMMSG_DB || '/opt/llmmsg/db/llmmsg.sqlite';
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:8788';

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

function buildPrompt(message) {
  const body = typeof message.body === 'string' ? message.body : JSON.stringify(message.body);
  const replyTo = message.origin_aro || message.from;
  const attrs = [
    `from="${message.from}"`,
    `to="${message.recipient}"`,
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
      await client.request('turn/start', {
        threadId: mapping.threadId,
        input: [{ type: 'text', text: buildPrompt({ id: row.id, from: row.sender, to: row.recipient, tag: row.tag, re: row.re, body }), text_elements: [] }],
      });
    }

    setCursor.run(agent, maxId);
    await hubReadAck(agent, maxId);
  } finally {
    await client.close();
  }
  return { delivered: rows.length, cursorId: maxId };
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
  for (;;) {
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
        const isThreadGone = /thread.*(not found|does not exist)/i.test(error.message);
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

  console.error('Usage: bridge.mjs register <agent> [--thread-id <id> | --cwd <cwd>] | deliver <agent> | watch [--poll-ms N] | list | unregister <agent>');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
