#!/usr/bin/env node
// set-thread-cwd.mjs — preflight RPC to set cwd on a Codex thread via app server
// Usage: node set-thread-cwd.mjs <thread-id> <cwd> [app-server-url]
import { CodexRpcClient } from './rpc-client.mjs';

const [threadId, cwd, url] = process.argv.slice(2);
if (!threadId || !cwd) {
  console.error('Usage: set-thread-cwd.mjs <thread-id> <cwd> [ws://url]');
  process.exit(1);
}

const client = new CodexRpcClient({ url: url || 'ws://127.0.0.1:8788' });
try {
  await client.connect();
  await client.request('thread/resume', { threadId, cwd });
  await client.close();
} catch (err) {
  // thread may not exist yet (new session) — not fatal
  console.error(`[set-thread-cwd] ${err.message}`);
  try { await client.close(); } catch {}
  process.exit(0);
}
