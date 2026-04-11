#!/usr/bin/env node

import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { CodexRpcClient } from './rpc-client.mjs';

const MESSAGE_DB_PATH = process.env.LLMMSG_DB || '/opt/llmmsg/db/llmmsg.sqlite';
const APP_SERVER_URL = process.env.CODEX_APP_SERVER_URL || 'ws://127.0.0.1:8788';
const BRIDGE_SHIM = '/opt/llmmsg/codex-llmmsg-app/bridge.mjs';

mkdirSync(path.dirname(MESSAGE_DB_PATH), { recursive: true });

const db = new Database(MESSAGE_DB_PATH);
// thread_map table is created by init-db.sh — fail fast if missing
{
  const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_map'`).get();
  if (!exists) {
    console.error('thread_map table missing. Run scripts/init-db.sh first.');
    process.exit(1);
  }
}

const stmtGet = db.prepare(
  'SELECT thread_id FROM thread_map WHERE agent = ? AND cwd = ?',
);
const stmtPut = db.prepare(`
  INSERT INTO thread_map (agent, cwd, thread_id, updated_at)
  VALUES (?, ?, ?, strftime('%s','now'))
  ON CONFLICT(agent, cwd) DO UPDATE SET
    thread_id = excluded.thread_id,
    updated_at = excluded.updated_at
`);

function getMapping(agent, cwd) {
  return stmtGet.get(agent, cwd)?.thread_id || '';
}

function putMapping(agent, cwd, threadId) {
  stmtPut.run(agent, cwd, threadId);
}

async function withClient(fn) {
  const client = new CodexRpcClient({ url: APP_SERVER_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}

async function listLoadedThreadIds() {
  return withClient(async (client) => {
    const result = await client.request('thread/loaded/list', {});
    return result.data;
  });
}

async function readThread(client, threadId) {
  const result = await client.request('thread/read', { threadId, includeTurns: false });
  return result.thread;
}

async function waitForNewThread(agent, cwd, baselineJson, timeoutMs = 15000) {
  const baseline = new Set(JSON.parse(baselineJson || '[]'));
  const deadline = Date.now() + timeoutMs;

  return withClient(async (client) => {
    while (Date.now() < deadline) {
      const loaded = await client.request('thread/loaded/list', {});
      const newIds = loaded.data.filter((id) => !baseline.has(id));

      if (newIds.length > 0) {
        const threads = [];
        for (const id of newIds) {
          threads.push(await readThread(client, id));
        }

        const normalizedAgent = agent.toLowerCase();
        const withPromptMatch = threads.find((thread) => {
          const preview = thread.preview || '';
          return preview.includes(`Your working directory is ${cwd}`) &&
            preview.toLowerCase().includes(`your agent name is ${normalizedAgent}`);
        });
        const withCwdPrompt = threads.find((thread) => (thread.preview || '').includes(`Your working directory is ${cwd}`));
        const newest = [...threads].sort((a, b) => b.updatedAt - a.updatedAt)[0];
        const chosen = withPromptMatch || withCwdPrompt || newest;

        if (chosen?.id) {
          putMapping(agent, cwd, chosen.id);
          if (existsSync(BRIDGE_SHIM)) {
            spawn('node', [BRIDGE_SHIM, 'register', agent, '--thread-id', chosen.id], {
              stdio: 'ignore',
              detached: false,
            }).unref();
          }
          return chosen.id;
        }
      }

      await sleep(500);
    }

    throw new Error(`timed out waiting for a new thread for ${agent} @ ${cwd}`);
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === 'get') {
    const [agent, cwd] = args;
    process.stdout.write(getMapping(agent, cwd));
    return;
  }

  if (command === 'put') {
    const [agent, cwd, threadId] = args;
    putMapping(agent, cwd, threadId);
    return;
  }

  if (command === 'loaded') {
    const loaded = await listLoadedThreadIds();
    process.stdout.write(JSON.stringify(loaded));
    return;
  }

  if (command === 'watch') {
    const [agent, cwd, baselineJson, timeoutMsArg] = args;
    const threadId = await waitForNewThread(agent, cwd, baselineJson, timeoutMsArg ? parseInt(timeoutMsArg, 10) : 15000);
    process.stdout.write(threadId);
    return;
  }

  console.error('Usage: cf-thread-map.mjs get <agent> <cwd> | put <agent> <cwd> <threadId> | loaded | watch <agent> <cwd> <baselineJson> [timeoutMs]');
  process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
