#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { CodexRpcClient } from './rpc-client.mjs';

const APP_DIR = path.dirname(new URL(import.meta.url).pathname);
const REGISTRY_PATH = path.join(APP_DIR, 'registrations.json');
const STATE_DB = path.join(APP_DIR, 'bridge-state.sqlite');
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

const stateDb = new Database(STATE_DB);
stateDb.exec(`
  CREATE TABLE IF NOT EXISTS delivery_cursor (
    agent TEXT PRIMARY KEY,
    last_id INTEGER NOT NULL DEFAULT 0
  );
`);
const getCursor = stateDb.prepare('SELECT last_id FROM delivery_cursor WHERE agent = ?');
const setCursor = stateDb.prepare(`
  INSERT INTO delivery_cursor (agent, last_id) VALUES (?, ?)
  ON CONFLICT(agent) DO UPDATE SET last_id = MAX(delivery_cursor.last_id, excluded.last_id)
`);

const HUB_URL = process.env.LLMMSG_HUB_URL || 'http://127.0.0.1:9701';

import http from 'node:http';

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

const msgDb = new Database(MESSAGE_DB, { readonly: true });
const selectUnread = msgDb.prepare(`
  SELECT id, sender, recipient, tag, re, body
  FROM messages
  WHERE (recipient = ? OR recipient = '*')
    AND id > ?
    AND retracted_at IS NULL
  ORDER BY id
`);

function buildPrompt(message) {
  const body = typeof message.body === 'string' ? message.body : JSON.stringify(message.body);
  return `<channel from="${message.from}" tag="${message.tag}"${message.re ? ` re="${message.re}"` : ''}>${body}</channel>`;
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
    resolvedThreadId = filtered[0].id;
  }

  const registry = loadRegistry();
  registry[agent] = {
    threadId: resolvedThreadId,
    registeredAt: new Date().toISOString(),
    cwd: cwd || null,
    // clear any suspension — registration is always authoritative
  };
  saveRegistry(registry);
  await client.close();
  return registry[agent];
}

async function deliverUnread(agent) {
  const registry = loadRegistry();
  const mapping = registry[agent];
  if (!mapping) {
    throw new Error(`agent '${agent}' is not registered`);
  }
  if (mapping.suspended) {
    return { delivered: 0, lastId: getCursor.get(agent)?.last_id || 0 };
  }

  const lastId = getCursor.get(agent)?.last_id || 0;
  const rows = selectUnread.all(agent, lastId);
  if (!rows.length) {
    return { delivered: 0, lastId };
  }

  const client = new CodexRpcClient({ url: APP_SERVER_URL });
  await client.connect();

  let maxId = lastId;
  try {
    for (const row of rows) {
      if (row.id > maxId) maxId = row.id;
      let body;
      try { body = JSON.parse(row.body); } catch { body = row.body; }
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
  return { delivered: rows.length, lastId: maxId };
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

  console.error('Usage: bridge.mjs register <agent> [--thread-id <id> | --cwd <cwd>] | deliver <agent> | watch [--poll-ms N] | list');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
