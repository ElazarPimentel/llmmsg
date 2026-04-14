#!/usr/bin/env node
// llmmsg-ecosystem
// llmmsg-chat.mjs - TUI chat client for llmmsg-channel (human agent)
// See /opt/llmmsg/ECOSYSTEM.md
//
// Registers as a regular agent with the llmmsg hub, subscribes to SSE for
// push delivery, and provides a blessed-based chat TUI with sidebar (joined
// AROs), chat pane, and input box. IRC-style commands via /command syntax.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import blessed from 'blessed';

const VERSION = '0.1.0';

// ---------- Settings ----------

const SETTINGS_DIR = path.join(os.homedir(), '.config', 'llmmsg-chat');
const SETTINGS_PATH = path.join(SETTINGS_DIR, 'settings.json');

const defaultSettings = {
  agent: 'elazar-tui',
  hubHost: '127.0.0.1',
  hubPort: 9701,
  defaultRooms: [],
  bell: true,
  colors: {
    self: 'cyan',
    dm: 'yellow',
    room: 'white',
    system: 'grey',
  },
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

// ---------- CLI args ----------

const args = process.argv.slice(2);
let cliAgent = null;
let cliHost = null;
let cliPort = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--agent' && args[i + 1]) { cliAgent = args[i + 1]; i++; }
  else if (args[i] === '--host' && args[i + 1]) { cliHost = args[i + 1]; i++; }
  else if (args[i] === '--port' && args[i + 1]) { cliPort = parseInt(args[i + 1]); i++; }
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`llmmsg-chat v${VERSION} - TUI chat client for llmmsg-channel`);
    console.log('');
    console.log('Usage: llmmsg-chat [--agent NAME] [--host HOST] [--port PORT]');
    console.log('');
    console.log('Commands (once running):');
    console.log('  /join <aro>       Join an ARO room');
    console.log('  /leave <aro>      Leave an ARO room');
    console.log('  /rooms            List joined rooms');
    console.log('  /room <aro|dm>    Switch active send target');
    console.log('  /who [aro]        List online agents (optionally in an ARO)');
    console.log('  /msg <agent> <text>   Send a direct message');
    console.log('  /invite <agent> <aro> Ask an agent to join an ARO');
    console.log('  /guide            Show the messaging guide');
    console.log('  /settings         Show current settings');
    console.log('  /quit             Exit');
    console.log('');
    console.log(`Settings: ${SETTINGS_PATH}`);
    process.exit(0);
  }
}

const settings = loadSettings();
if (cliAgent) settings.agent = cliAgent;
if (cliHost) settings.hubHost = cliHost;
if (cliPort) settings.hubPort = cliPort;

const AGENT = settings.agent.toLowerCase();
const HUB_URL = `http://${settings.hubHost}:${settings.hubPort}`;

// ---------- HTTP helpers ----------

function httpRequest(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    const req = http.request(`${HUB_URL}${p}`, opts, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null });
        } catch {
          resolve({ status: res.statusCode, body: out });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const hub = {
  register: (agent, cwd) => httpRequest('POST', '/register', { agent, cwd, old_agent: null }),
  unregister: (agent) => httpRequest('POST', '/unregister', { agent }),
  send: (from, to, message, re) => httpRequest('POST', '/send', { from, to, re: re || null, message }),
  aroJoin: (aro, agent) => httpRequest('POST', '/aro/join', { aro, agent }),
  aroLeave: (aro, agent) => httpRequest('POST', '/aro/leave', { aro, agent }),
  aroList: (agent) => httpRequest('GET', `/aro?agent=${encodeURIComponent(agent)}`),
  online: (agent, aro) => {
    const params = [];
    if (agent) params.push(`agent=${encodeURIComponent(agent)}`);
    if (aro) params.push(`aro=${encodeURIComponent(aro)}`);
    return httpRequest('GET', `/online?${params.join('&')}`);
  },
  log: (limit) => httpRequest('GET', `/log?limit=${limit}`),
  guide: () => httpRequest('GET', '/guide'),
  readUnread: (agent) => httpRequest('GET', `/read-unread?agent=${encodeURIComponent(agent)}`),
};

// ---------- State ----------

const state = {
  agent: AGENT,
  rooms: new Set(), // joined AROs
  currentTarget: null, // aro name or agent name for /msg, null = show all / no target
  history: { __all__: [] }, // per-room + __all__
  sseReq: null,
  unreadBuckets: new Map(), // room name -> count
  recentTags: new Map(), // outbound tag -> target (for best-effort attribution)
};

function bucketFor(target) {
  if (!target) return '__all__';
  return target;
}

function addMessage(bucket, entry) {
  if (!state.history[bucket]) state.history[bucket] = [];
  state.history[bucket].push(entry);
  // Cap at 200 per bucket
  if (state.history[bucket].length > 200) state.history[bucket].shift();
  // Also push into __all__ unless already there
  if (bucket !== '__all__') {
    state.history.__all__.push({ ...entry, _bucket: bucket });
    if (state.history.__all__.length > 500) state.history.__all__.shift();
  }
}

// ---------- TUI ----------

const screen = blessed.screen({
  smartCSR: true,
  title: `llmmsg-chat (${AGENT})`,
});

const sidebar = blessed.list({
  parent: screen,
  top: 0,
  left: 0,
  width: 20,
  height: '100%-3',
  label: ' Rooms ',
  border: { type: 'line' },
  style: {
    border: { fg: 'grey' },
    selected: { bg: 'blue', fg: 'white' },
    item: { fg: 'white' },
  },
  keys: true,
  mouse: true,
  items: ['[all]'],
});

const chatPane = blessed.log({
  parent: screen,
  top: 0,
  left: 20,
  right: 0,
  height: '100%-3',
  label: ` chat — ${AGENT} `,
  border: { type: 'line' },
  style: { border: { fg: 'grey' } },
  scrollable: true,
  scrollbar: { ch: '|', style: { inverse: true } },
  tags: true,
  mouse: true,
});

const statusBar = blessed.box({
  parent: screen,
  bottom: 2,
  left: 0,
  right: 0,
  height: 1,
  style: { fg: 'yellow' },
  content: ` SPEAKING IN: [none — select a room or use /msg]`,
});

const input = blessed.textbox({
  parent: screen,
  bottom: 0,
  left: 0,
  right: 0,
  height: 2,
  label: ' input (Enter to send, /help for commands) ',
  border: { type: 'line' },
  style: { border: { fg: 'cyan' } },
  inputOnFocus: true,
  keys: true,
  mouse: true,
});

function log(text, color = 'white') {
  const ts = new Date().toTimeString().slice(0, 8);
  chatPane.log(`{grey-fg}${ts}{/grey-fg} {${color}-fg}${text}{/${color}-fg}`);
}

function systemLog(text) {
  log(text, settings.colors.system);
}

function updateStatus() {
  let target = state.currentTarget;
  if (!target) {
    statusBar.setContent(` SPEAKING IN: [none — select a room or use /msg <agent>]`);
  } else if (target.startsWith('aro:')) {
    statusBar.setContent(` SPEAKING IN: ${target} (blast radius: all online members)`);
  } else {
    statusBar.setContent(` DM TO: ${target}`);
  }
  screen.render();
}

function updateSidebar() {
  const items = ['[all]', ...[...state.rooms].map((r) => {
    const unread = state.unreadBuckets.get(r) || 0;
    return unread > 0 ? `${r} (${unread})` : r;
  })];
  sidebar.setItems(items);
  screen.render();
}

function renderView(bucket) {
  chatPane.setContent('');
  const messages = state.history[bucket] || [];
  for (const msg of messages) {
    printMessage(msg, bucket === '__all__');
  }
  screen.render();
}

function printMessage(msg, showBucket) {
  const { from, to, tag, body, _bucket } = msg;
  const ts = new Date().toTimeString().slice(0, 8);
  const bucketTag = showBucket && _bucket ? `[${_bucket}] ` : '';
  let text = typeof body === 'object' ? (body.message || JSON.stringify(body)) : String(body);

  let color = settings.colors.room;
  if (from === state.agent) color = settings.colors.self;
  else if (to === state.agent) color = settings.colors.dm;

  chatPane.log(
    `{grey-fg}${ts}{/grey-fg} ${bucketTag}{${color}-fg}<${from}>{/${color}-fg} ${text}`
  );
}

// ---------- SSE ----------

function connectSSE() {
  const url = `${HUB_URL}/connect?agent=${encodeURIComponent(state.agent)}&cwd=${encodeURIComponent(process.cwd())}`;
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      systemLog(`SSE connect failed: HTTP ${res.statusCode}`);
      return;
    }
    systemLog(`connected to hub as ${state.agent}`);
    res.setEncoding('utf8');
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6));
              handleIncoming(event);
            } catch {}
          }
        }
      }
    });
    res.on('end', () => {
      systemLog('SSE stream ended; reconnecting in 3s...');
      setTimeout(connectSSE, 3000);
    });
    res.on('error', (err) => {
      systemLog(`SSE error: ${err.message}`);
    });
  });
  req.on('error', (err) => {
    systemLog(`SSE connect error: ${err.message}; retrying in 3s...`);
    setTimeout(connectSSE, 3000);
  });
  state.sseReq = req;
}

function handleIncoming(event) {
  // event: { id, from, to, tag, re, body }
  // Best-effort room attribution:
  //   - if re matches a recent outbound tag whose target was aro:X, treat as aro:X
  //   - else if to === our agent, it's a DM (or an ARO fanout stored as per-member)
  let bucket = null;
  if (event.re && state.recentTags.has(event.re)) {
    bucket = state.recentTags.get(event.re);
  } else if (event.to === state.agent) {
    bucket = event.from; // treat as DM bucket keyed by sender
  }
  const entry = { ...event };
  if (bucket) entry._bucket = bucket;
  addMessage(bucket || '__all__', entry);

  // Unread tracking if not currently viewing this bucket
  const viewingAll = state.currentTarget === null;
  const viewing = state.currentTarget;
  const matchesView =
    viewingAll ||
    (bucket === viewing) ||
    (viewing && viewing === event.from && event.to === state.agent);
  if (!matchesView && bucket) {
    state.unreadBuckets.set(bucket, (state.unreadBuckets.get(bucket) || 0) + 1);
    updateSidebar();
  }

  if (matchesView) {
    printMessage(entry, viewingAll);
    screen.render();
  }

  // DM bell
  if (settings.bell && event.to === state.agent && event.from !== state.agent) {
    process.stdout.write('\x07');
  }
}

// ---------- Commands ----------

async function handleInput(text) {
  if (!text.trim()) return;
  if (text.startsWith('/')) {
    const [cmd, ...rest] = text.slice(1).split(' ');
    const arg = rest.join(' ');
    return handleCommand(cmd.toLowerCase(), arg, rest);
  }
  // Plain text: send to current target
  if (!state.currentTarget) {
    systemLog('No target selected. Use /room <aro> or /msg <agent> <text>.');
    return;
  }
  const target = state.currentTarget;
  const msgBody = { message: text };
  const result = await hub.send(state.agent, target, msgBody, null);
  if (result.status !== 200) {
    systemLog(`send failed: ${result.body?.error || result.status}`);
    return;
  }
  // Remember tag → target for reply attribution
  const tag = result.body?.tag;
  if (tag && target.startsWith('aro:')) {
    state.recentTags.set(tag, target);
    if (state.recentTags.size > 200) {
      const first = state.recentTags.keys().next().value;
      state.recentTags.delete(first);
    }
  }
  // Echo locally
  const entry = { from: state.agent, to: target, tag, body: msgBody };
  if (target.startsWith('aro:')) entry._bucket = target;
  addMessage(target, entry);
  printMessage(entry, state.currentTarget === null);
  screen.render();
}

async function handleCommand(cmd, arg, rest) {
  switch (cmd) {
    case 'help':
      systemLog('Commands: /join /leave /rooms /room /who /msg /invite /guide /settings /quit');
      break;
    case 'join': {
      if (!arg) return systemLog('Usage: /join <aro-name>');
      const aro = arg.toLowerCase();
      const r = await hub.aroJoin(aro, state.agent);
      if (r.status === 200) {
        state.rooms.add(`aro:${aro}`);
        updateSidebar();
        systemLog(`joined aro:${aro}`);
      } else {
        systemLog(`join failed: ${r.body?.error || r.status}`);
      }
      break;
    }
    case 'leave': {
      if (!arg) return systemLog('Usage: /leave <aro-name>');
      const aro = arg.replace(/^aro:/, '').toLowerCase();
      const r = await hub.aroLeave(aro, state.agent);
      if (r.status === 200) {
        state.rooms.delete(`aro:${aro}`);
        if (state.currentTarget === `aro:${aro}`) state.currentTarget = null;
        updateSidebar();
        updateStatus();
        systemLog(`left aro:${aro}`);
      } else {
        systemLog(`leave failed: ${r.body?.error || r.status}`);
      }
      break;
    }
    case 'rooms':
      systemLog(`joined: ${[...state.rooms].join(', ') || '(none)'}`);
      break;
    case 'room': {
      if (!arg) return systemLog('Usage: /room <aro-name>  (or "all" to clear)');
      if (arg === 'all') {
        state.currentTarget = null;
        renderView('__all__');
        updateStatus();
        return;
      }
      const aro = arg.startsWith('aro:') ? arg : `aro:${arg.toLowerCase()}`;
      state.currentTarget = aro;
      state.unreadBuckets.delete(aro);
      updateSidebar();
      renderView(aro);
      updateStatus();
      break;
    }
    case 'who': {
      const aro = arg ? arg.replace(/^aro:/, '').toLowerCase() : null;
      const r = await hub.online(state.agent, aro);
      if (r.status === 200) {
        systemLog(`online (${r.body.count}): ${r.body.online.join(', ') || '(none)'}`);
      } else {
        systemLog(`who failed: ${r.body?.error || r.status}`);
      }
      break;
    }
    case 'msg': {
      const to = rest[0];
      const text = rest.slice(1).join(' ');
      if (!to || !text) return systemLog('Usage: /msg <agent-name> <text>');
      const r = await hub.send(state.agent, to.toLowerCase(), { message: text }, null);
      if (r.status !== 200) {
        systemLog(`msg failed: ${r.body?.error || r.status}`);
        if (r.body?.online) systemLog(`online: ${r.body.online.join(', ')}`);
      } else {
        const entry = { from: state.agent, to: to.toLowerCase(), tag: r.body?.tag, body: { message: text } };
        addMessage(to.toLowerCase(), entry);
        printMessage(entry, state.currentTarget === null);
        screen.render();
      }
      break;
    }
    case 'invite': {
      const target = rest[0];
      const aro = rest[1]?.replace(/^aro:/, '').toLowerCase();
      if (!target || !aro) return systemLog('Usage: /invite <agent-name> <aro-name>');
      const msg = { message: `Elazar asks you to join the chat room by calling: aro_join("${aro}"). This is a live chat, not a task broadcast.` };
      const r = await hub.send(state.agent, target.toLowerCase(), msg, null);
      if (r.status === 200) systemLog(`invite sent to ${target} for aro:${aro}`);
      else systemLog(`invite failed: ${r.body?.error || r.status}`);
      break;
    }
    case 'guide': {
      const r = await hub.guide();
      if (r.status === 200 && r.body?.guide) {
        for (const line of r.body.guide.split('\n')) log(line, 'grey');
      } else {
        systemLog(`guide fetch failed`);
      }
      break;
    }
    case 'settings':
      systemLog(`agent=${settings.agent} hub=${HUB_URL} bell=${settings.bell}`);
      systemLog(`settings file: ${SETTINGS_PATH}`);
      break;
    case 'quit':
    case 'exit':
      await shutdown();
      break;
    default:
      systemLog(`unknown command: /${cmd} (try /help)`);
  }
}

// ---------- Lifecycle ----------

async function startup() {
  systemLog(`llmmsg-chat v${VERSION} starting as ${AGENT} against ${HUB_URL}`);
  try {
    const reg = await hub.register(state.agent, process.cwd());
    if (reg.status !== 200) {
      systemLog(`register failed: ${reg.body?.error || reg.status}`);
      return;
    }
    systemLog(`registered with hub`);
  } catch (err) {
    systemLog(`register error: ${err.message}`);
    return;
  }

  // Fetch already-joined AROs
  try {
    const r = await hub.aroList(state.agent);
    if (r.status === 200 && Array.isArray(r.body?.aros)) {
      for (const aro of r.body.aros) state.rooms.add(`aro:${aro}`);
      updateSidebar();
    }
  } catch {}

  // Auto-join default rooms from settings
  for (const room of settings.defaultRooms || []) {
    const aro = room.replace(/^aro:/, '').toLowerCase();
    await hub.aroJoin(aro, state.agent);
    state.rooms.add(`aro:${aro}`);
  }
  updateSidebar();

  // Replay missed messages
  try {
    const r = await hub.readUnread(state.agent);
    if (r.status === 200 && Array.isArray(r.body)) {
      for (const msg of r.body) handleIncoming(msg);
      if (r.body.length) systemLog(`replayed ${r.body.length} unread messages`);
    }
  } catch {}

  connectSSE();
}

async function shutdown() {
  try {
    await hub.unregister(state.agent);
  } catch {}
  screen.destroy();
  process.exit(0);
}

// ---------- Key bindings ----------

screen.key(['C-c', 'C-q'], async () => {
  await shutdown();
});

input.key(['enter'], async () => {
  const text = input.getValue();
  input.clearValue();
  input.focus();
  screen.render();
  try {
    await handleInput(text);
  } catch (err) {
    systemLog(`error: ${err.message}`);
  }
});

sidebar.on('select', (_item, index) => {
  if (index === 0) {
    state.currentTarget = null;
    renderView('__all__');
  } else {
    const roomName = [...state.rooms][index - 1];
    if (roomName) {
      state.currentTarget = roomName;
      state.unreadBuckets.delete(roomName);
      updateSidebar();
      renderView(roomName);
    }
  }
  updateStatus();
  input.focus();
});

input.focus();
updateStatus();
updateSidebar();
screen.render();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startup();
