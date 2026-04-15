#!/usr/bin/env node
// llmmsg-ecosystem
// llmmsg-chat.mjs - TUI chat client for llmmsg-channel (human agent)
// See /opt/llmmsg/ECOSYSTEM.md

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import blessed from 'blessed';
import Database from 'better-sqlite3';

const VERSION = '0.2.2';

// ---------- Settings ----------

const CONFIG_DIR = path.join(os.homedir(), '.config', 'llmmsg-chat');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const EVENTS_DB_PATH = path.join(CONFIG_DIR, 'llmmsg-chat.sqlite');
const DEBUG = true; // hardcoded debug logger; toggle later if needed

fs.mkdirSync(CONFIG_DIR, { recursive: true });

const defaultSettings = {
  agent: 'elazar-tui',
  hubHost: '127.0.0.1',
  hubPort: 9701,
  joinedRooms: [],
  bell: true,
  sidebarWidth: 30,
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
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
}

function normalizeAroName(room) {
  return String(room || '').trim().replace(/^aro:/, '').toLowerCase();
}

function persistJoinedRooms() {
  settings.joinedRooms = [...state.rooms]
    .map(normalizeAroName)
    .filter(Boolean)
    .sort();
  saveSettings(settings);
  logEvent('info', 'settings_saved', { joinedRooms: settings.joinedRooms });
}

// ---------- Event logger ----------

const eventsDb = new Database(EVENTS_DB_PATH);
eventsDb.pragma('journal_mode = WAL');
eventsDb.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    ts    TEXT NOT NULL DEFAULT (strftime('%s','now')),
    level TEXT NOT NULL,
    event TEXT NOT NULL,
    data  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
`);
// Retention cap: keep last 10k events max. Pruned once on startup.
eventsDb.exec(`
  DELETE FROM events WHERE id <= (
    SELECT COALESCE(MAX(id), 0) - 10000 FROM events
  )
`);
const stmtLogEvent = eventsDb.prepare(
  `INSERT INTO events (level, event, data) VALUES (?, ?, ?)`
);

function logEvent(level, event, data = null) {
  if (!DEBUG && level === 'debug') return;
  try {
    stmtLogEvent.run(level, event, data ? JSON.stringify(data) : null);
  } catch {}
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
  else if (args[i] === '--version' || args[i] === '-V') {
    console.log(`llmmsg-chat v${VERSION}`);
    process.exit(0);
  }
  else if (args[i] === '--help' || args[i] === '-h') {
    console.log(`llmmsg-chat v${VERSION} - TUI chat client for llmmsg-channel`);
    console.log('');
    console.log('Usage: llmmsg-chat [--agent NAME] [--host HOST] [--port PORT]');
    console.log('');
    console.log('Once running:');
    console.log('  F1   Help / menu       F9  Quit');
    console.log('  F2   /join <aro>       F3  /leave <aro>');
    console.log('  F4   /who              F5  /rooms');
    console.log('  F6   /msg <agent>      F7  /invite <agent> <aro>');
    console.log('  Tab / Shift-Tab        switch rooms in sidebar');
    console.log('  Esc                    focus input');
    console.log('');
    console.log(`Settings: ${SETTINGS_PATH}`);
    console.log(`Event log: ${EVENTS_DB_PATH}`);
    process.exit(0);
  }
}

const settings = loadSettings();
if (cliAgent) settings.agent = cliAgent;
if (cliHost) settings.hubHost = cliHost;
if (cliPort) settings.hubPort = cliPort;

const AGENT = settings.agent.toLowerCase();
const HUB_URL = `http://${settings.hubHost}:${settings.hubPort}`;

logEvent('info', 'startup', { version: VERSION, agent: AGENT, hub: HUB_URL, cwd: process.cwd() });

// ---------- HTTP helpers ----------

function httpRequest(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
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
  guide: () => httpRequest('GET', '/guide'),
  readUnread: (agent) => httpRequest('GET', `/read-unread?agent=${encodeURIComponent(agent)}`),
};

// ---------- State ----------

const state = {
  agent: AGENT,
  rooms: new Set(),
  currentTarget: null,
  history: { __all__: [] },
  unreadBuckets: new Map(),
  recentTags: new Map(),
};

function addMessage(bucket, entry) {
  if (!state.history[bucket]) state.history[bucket] = [];
  state.history[bucket].push(entry);
  if (state.history[bucket].length > 200) state.history[bucket].shift();
  if (bucket !== '__all__') {
    state.history.__all__.push({ ...entry, _bucket: bucket });
    if (state.history.__all__.length > 500) state.history.__all__.shift();
  }
}

// ---------- TUI ----------

const screen = blessed.screen({
  smartCSR: true,
  title: `llmmsg-chat v${VERSION} (${AGENT})`,
  // fullUnicode removed in v0.2.2: caused character-doubling on some terminals
});

const sidebar = blessed.list({
  parent: screen,
  top: 0,
  left: 0,
  width: settings.sidebarWidth,
  height: '100%-5',
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
  left: settings.sidebarWidth,
  right: 0,
  height: '100%-5',
  label: ` chat — ${AGENT} — llmmsg-chat v${VERSION} `,
  border: { type: 'line' },
  style: { border: { fg: 'grey' } },
  scrollable: true,
  scrollbar: { ch: '|', style: { inverse: true } },
  tags: true,
  mouse: true,
});

const statusBar = blessed.box({
  parent: screen,
  bottom: 4,
  left: 0,
  right: 0,
  height: 1,
  style: { fg: 'yellow' },
  content: ' SPEAKING IN: [none — pick a room (Tab), /msg, or menu (F1)]',
});

// Input MUST be height 3 minimum: top border + 1 content row + bottom border.
const input = blessed.textbox({
  parent: screen,
  bottom: 1,
  left: 0,
  right: 0,
  height: 3,
  label: ' input (Enter=send, Esc=focus input, F1=menu, F9=quit) ',
  border: { type: 'line' },
  style: {
    border: { fg: 'cyan' },
    fg: 'white',
    focus: { border: { fg: 'yellow' } },
  },
  inputOnFocus: false, // we drive readInput manually
  keys: true,
  mouse: true,
});

const menuBar = blessed.box({
  parent: screen,
  bottom: 0,
  left: 0,
  right: 0,
  height: 1,
  style: { bg: 'blue', fg: 'white' },
  content: ' F1 help · F2 join · F3 leave · F4 who · F5 rooms · F6 msg · F7 invite · F9 quit · Tab sidebar ',
});

function log(text, color = 'white') {
  const ts = new Date().toTimeString().slice(0, 8);
  chatPane.log(`{grey-fg}${ts}{/grey-fg} {${color}-fg}${text}{/${color}-fg}`);
}

function systemLog(text) {
  log(text, 'grey');
  logEvent('info', 'system_log', { text });
}

function updateStatus() {
  let target = state.currentTarget;
  if (!target) {
    statusBar.setContent(' SPEAKING IN: [none — pick a room (Tab), /msg, or menu (F1)]');
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

function printMessage(msg, showContext) {
  const { from, to, body, _bucket } = msg;
  const ts = new Date().toTimeString().slice(0, 8);
  let text = typeof body === 'object' ? (body.message || JSON.stringify(body)) : String(body);

  // Context prefix: show what kind of message this is
  let prefix = '';
  if (showContext) {
    if (_bucket && _bucket.startsWith('aro:')) prefix = `[${_bucket}] `;
    else if (from === state.agent) prefix = `[→${to}] `;
    else if (to === state.agent) prefix = `[DM] `;
    else prefix = `[→${to}] `;
  }

  let color = 'white';
  if (from === state.agent) color = 'cyan';
  else if (to === state.agent) color = 'yellow';

  chatPane.log(`{grey-fg}${ts}{/grey-fg} ${prefix}{${color}-fg}<${from}>{/${color}-fg} ${text}`);
}

// ---------- SSE ----------

let sseReq = null;
let sseReconnectTimer = null;
let sseConnected = false;

function scheduleReconnect(reason) {
  if (sseReconnectTimer) return; // already scheduled
  logEvent('warn', 'sse_schedule_reconnect', { reason });
  sseReconnectTimer = setTimeout(() => {
    sseReconnectTimer = null;
    connectSSE();
  }, 3000);
}

function connectSSE() {
  if (sseReq) {
    try { sseReq.destroy(); } catch {}
    sseReq = null;
  }
  const url = `${HUB_URL}/connect?agent=${encodeURIComponent(state.agent)}&cwd=${encodeURIComponent(process.cwd())}`;
  logEvent('debug', 'sse_connect_start', { url });
  sseConnected = false;
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      systemLog(`SSE connect failed: HTTP ${res.statusCode}`);
      logEvent('error', 'sse_connect_fail', { status: res.statusCode });
      scheduleReconnect(`http_${res.statusCode}`);
      return;
    }
    sseConnected = true;
    systemLog(`connected to hub as ${state.agent}`);
    logEvent('info', 'sse_connected', { agent: state.agent });
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
            } catch (err) {
              logEvent('error', 'sse_parse', { err: err.message, line });
            }
          }
        }
      }
    });
    res.on('end', () => {
      sseConnected = false;
      systemLog('SSE stream ended; reconnecting in 3s...');
      logEvent('warn', 'sse_end');
      scheduleReconnect('end');
    });
    res.on('error', (err) => {
      sseConnected = false;
      systemLog(`SSE stream error: ${err.message}`);
      logEvent('error', 'sse_stream_err', { err: err.message });
      scheduleReconnect('stream_err');
    });
  });
  sseReq = req;
  req.on('error', (err) => {
    sseConnected = false;
    systemLog(`SSE connect error: ${err.message}; retrying in 3s...`);
    logEvent('error', 'sse_connect_err', { err: err.message });
    scheduleReconnect('connect_err');
  });
}

function handleIncoming(event) {
  logEvent('debug', 'sse_event', { id: event.id, from: event.from, to: event.to, tag: event.tag });

  // Bucket attribution: best-effort, based on reply-to-recent-tag.
  // Without origin_aro on messages, we cannot reliably distinguish DMs from
  // ARO fanout rows (both have recipient=me). So we ALWAYS render incoming
  // messages in the current view regardless of bucket, to avoid losing visibility.
  let bucket = null;
  if (event.re && state.recentTags.has(event.re)) {
    bucket = state.recentTags.get(event.re);
  }
  const entry = { ...event };
  if (bucket) entry._bucket = bucket;
  addMessage(bucket || '__all__', entry);

  // Also store in DM bucket keyed by sender for history
  if (event.to === state.agent && event.from !== state.agent) {
    if (!state.history[event.from]) state.history[event.from] = [];
    state.history[event.from].push(entry);
    if (state.history[event.from].length > 200) state.history[event.from].shift();
  }

  // Unread tracking: count DMs against the sender bucket when we're not viewing it
  const viewing = state.currentTarget;
  if (event.to === state.agent && viewing !== event.from) {
    state.unreadBuckets.set(event.from, (state.unreadBuckets.get(event.from) || 0) + 1);
    updateSidebar();
  }

  // Always print incoming messages in the current chat pane. The user needs
  // to see replies regardless of which room or DM is currently selected.
  // Visual distinction: DMs to me = yellow, room messages = white, self = cyan.
  printMessage(entry, true); // true = show bucket/from-to context
  screen.render();

  if (settings.bell && event.to === state.agent && event.from !== state.agent) {
    process.stdout.write('\x07');
  }
}

// ---------- Input handling (canonical blessed readInput loop) ----------

let inputBusy = false;

function promptInput() {
  if (inputBusy) return;
  inputBusy = true;
  input.readInput(async (err, value) => {
    inputBusy = false;
    if (err) {
      logEvent('error', 'input_err', { err: err.message });
      setImmediate(promptInput);
      return;
    }
    if (value === null || value === undefined) {
      // Cancelled (Esc or similar) — just re-arm.
      setImmediate(promptInput);
      return;
    }
    logEvent('debug', 'input_submit', { value });
    try {
      await handleInput(value);
    } catch (e) {
      systemLog(`error: ${e.message}`);
      logEvent('error', 'handle_input', { err: e.message });
    }
    input.clearValue();
    screen.render();
    setImmediate(promptInput);
  });
}

async function handleInput(text) {
  if (!text || !text.trim()) return;
  if (text.startsWith('/')) {
    const parts = text.slice(1).split(' ');
    const cmd = parts[0].toLowerCase();
    const rest = parts.slice(1);
    return handleCommand(cmd, rest.join(' '), rest);
  }
  if (!state.currentTarget) {
    systemLog('No target. Pick a room (Tab) or use /msg <agent> <text>.');
    return;
  }
  await sendToTarget(state.currentTarget, text);
}

async function sendToTarget(target, text) {
  const msgBody = { message: text };
  logEvent('debug', 'send_attempt', { to: target, text });
  const result = await hub.send(state.agent, target, msgBody, null);
  if (result.status !== 200) {
    systemLog(`send failed: ${result.body?.error || result.status}`);
    logEvent('error', 'send_fail', { to: target, status: result.status, body: result.body });
    return;
  }
  const tag = result.body?.tag;
  logEvent('info', 'sent', { to: target, tag });
  if (tag && target.startsWith('aro:')) {
    state.recentTags.set(tag, target);
    if (state.recentTags.size > 200) {
      const first = state.recentTags.keys().next().value;
      state.recentTags.delete(first);
    }
  }
  const entry = { from: state.agent, to: target, tag, body: msgBody };
  if (target.startsWith('aro:')) entry._bucket = target;
  addMessage(target, entry);
  printMessage(entry, true);
  screen.render();
}

// ---------- Commands ----------

async function handleCommand(cmd, arg, rest) {
  logEvent('debug', 'command', { cmd, arg });
  switch (cmd) {
    case 'help':
      systemLog('F1 help · F2 join · F3 leave · F4 who · F5 rooms · F6 msg · F7 invite · F9 quit · Tab sidebar');
      systemLog('Commands: /join /leave /rooms /room /who /msg /invite /guide /settings /quit');
      break;
    case 'join': {
      if (!arg) return systemLog('Usage: /join <aro-name>');
      const aro = normalizeAroName(arg);
      const r = await hub.aroJoin(aro, state.agent);
      if (r.status === 200) {
        const room = `aro:${aro}`;
        state.rooms.add(room);
        persistJoinedRooms();
        state.currentTarget = room;
        state.unreadBuckets.delete(room);
        updateSidebar();
        renderView(room);
        updateStatus();
        systemLog(`joined aro:${aro}`);
      } else {
        systemLog(`join failed: ${r.body?.error || r.status}`);
      }
      break;
    }
    case 'leave': {
      if (!arg) return systemLog('Usage: /leave <aro-name>');
      const aro = normalizeAroName(arg);
      const r = await hub.aroLeave(aro, state.agent);
      if (r.status === 200) {
        state.rooms.delete(`aro:${aro}`);
        persistJoinedRooms();
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
      if (!arg) return systemLog('Usage: /room <aro-name> or "all"');
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
        printMessage(entry, true);
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
      systemLog(`agent=${settings.agent} hub=${HUB_URL} bell=${settings.bell} version=${VERSION}`);
      systemLog(`settings: ${SETTINGS_PATH}`);
      systemLog(`events db: ${EVENTS_DB_PATH}`);
      break;
    case 'quit':
    case 'exit':
      await shutdown();
      break;
    default:
      systemLog(`unknown command: /${cmd} (F1 for help)`);
  }
}

// ---------- Prompts (popup for menu actions) ----------

function showPrompt(label, callback) {
  const box = blessed.prompt({
    parent: screen,
    border: 'line',
    height: 'shrink',
    width: '50%',
    top: 'center',
    left: 'center',
    label: ` ${label} `,
    tags: true,
    keys: true,
    mouse: true,
    style: { border: { fg: 'yellow' } },
  });
  box.input('', '', async (err, value) => {
    box.destroy();
    screen.render();
    if (!err && value) {
      try {
        await callback(value);
      } catch (e) {
        systemLog(`prompt error: ${e.message}`);
        logEvent('error', 'prompt_callback', { err: e.message });
      }
    }
    input.focus();
    setImmediate(promptInput);
  });
}

// ---------- Key bindings ----------

const keyActions = {
  f1: () => {
    logEvent('info', 'key_action', { key: 'f1', action: 'show_help' });
    systemLog('F1 help · F2 join · F3 leave · F4 who · F5 rooms · F6 msg · F7 invite · F9 quit · Tab sidebar · Esc focus input');
  },
  f2: () => {
    logEvent('info', 'key_action', { key: 'f2', action: 'prompt_join_aro' });
    showPrompt('Join ARO (name)', (v) => handleCommand('join', v, v.split(' ')));
  },
  f3: () => {
    logEvent('info', 'key_action', { key: 'f3', action: 'prompt_leave_aro' });
    showPrompt('Leave ARO (name)', (v) => handleCommand('leave', v, v.split(' ')));
  },
  f4: async () => {
    logEvent('info', 'key_action', { key: 'f4', action: 'run_who' });
    await handleCommand('who', '', []);
  },
  f5: async () => {
    logEvent('info', 'key_action', { key: 'f5', action: 'list_rooms' });
    await handleCommand('rooms', '', []);
  },
  f6: () => {
    logEvent('info', 'key_action', { key: 'f6', action: 'prompt_dm' });
    showPrompt('DM (agent text...)', (v) => {
      const parts = v.split(' ');
      handleCommand('msg', v, parts);
    });
  },
  f7: () => {
    logEvent('info', 'key_action', { key: 'f7', action: 'prompt_invite' });
    showPrompt('Invite (agent aro)', (v) => {
      const parts = v.split(' ');
      handleCommand('invite', v, parts);
    });
  },
  f9: () => {
    logEvent('info', 'key_action', { key: 'f9', action: 'quit' });
    shutdown();
  },
  tab: () => {
    logEvent('info', 'key_action', { key: 'tab', action: 'focus_sidebar' });
    sidebar.focus();
    screen.render();
  },
  escape: () => {
    logEvent('info', 'key_action', { key: 'escape', action: 'focus_input_rearm' });
    input.focus();
    promptInput();
    screen.render();
  },
};

screen.key(['C-c', 'C-q'], () => { shutdown(); });
// Bind only on screen (not on input) — input.key would stack listeners and
// cause character doubling when the textbox is in readInput mode.
for (const [key, action] of Object.entries(keyActions)) {
  screen.key([key], action);
}

screen.program.on('keypress', (ch, key) => {
  const keyName = key?.name || null;
  logEvent('debug', 'raw_keypress', {
    name: keyName,
    full: key?.full || null,
    sequence: key?.sequence || null,
    ch: ch || null,
    ctrl: !!key?.ctrl,
    meta: !!key?.meta,
    shift: !!key?.shift,
  });
  if (keyName && keyActions[keyName]) {
    keyActions[keyName]();
  }
});

sidebar.on('select', (_item, index) => {
  const rawItem = sidebar.getItem(index)?.content || '';
  if (index === 0) {
    state.currentTarget = null;
    renderView('__all__');
    logEvent('info', 'sidebar_action', { index, item: rawItem, action: 'select_all' });
  } else {
    const roomName = [...state.rooms][index - 1];
    if (roomName) {
      state.currentTarget = roomName;
      state.unreadBuckets.delete(roomName);
      updateSidebar();
      renderView(roomName);
      logEvent('info', 'sidebar_action', { index, item: rawItem, action: 'select_room', room: roomName });
    }
  }
  updateStatus();
  input.focus();
  promptInput();
});

// ---------- Lifecycle ----------

async function startup() {
  systemLog(`llmmsg-chat v${VERSION} starting as ${AGENT} against ${HUB_URL}`);
  systemLog(`event log: ${EVENTS_DB_PATH} (debug=${DEBUG})`);
  try {
    const reg = await hub.register(state.agent, process.cwd());
    if (reg.status !== 200) {
      systemLog(`register failed: ${reg.body?.error || reg.status}`);
      logEvent('error', 'register_fail', { status: reg.status, body: reg.body });
      return;
    }
    systemLog(`registered`);
    logEvent('info', 'registered');
  } catch (err) {
    systemLog(`register error: ${err.message}`);
    logEvent('error', 'register_err', { err: err.message });
    return;
  }

  try {
    const r = await hub.aroList(state.agent);
    if (r.status === 200 && Array.isArray(r.body?.aros)) {
      for (const aro of r.body.aros) state.rooms.add(`aro:${aro}`);
      updateSidebar();
      logEvent('info', 'loaded_aros', { aros: [...state.rooms] });
    }
  } catch {}

  const configuredRooms = settings.joinedRooms || settings.defaultRooms || [];
  for (const room of configuredRooms) {
    const aro = normalizeAroName(room);
    if (!aro) continue;
    await hub.aroJoin(aro, state.agent);
    state.rooms.add(`aro:${aro}`);
  }
  if (!Array.isArray(settings.joinedRooms)) persistJoinedRooms();
  updateSidebar();

  try {
    const r = await hub.readUnread(state.agent);
    if (r.status === 200 && Array.isArray(r.body)) {
      for (const msg of r.body) handleIncoming(msg);
      if (r.body.length) systemLog(`replayed ${r.body.length} unread`);
      logEvent('info', 'replayed_unread', { count: r.body.length });
    }
  } catch {}

  connectSSE();
}

async function shutdown() {
  logEvent('info', 'shutdown');
  try {
    await hub.unregister(state.agent);
  } catch {}
  try { eventsDb.close(); } catch {}
  screen.destroy();
  process.exit(0);
}

// Init UI
input.focus();
updateStatus();
updateSidebar();
screen.render();
promptInput();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startup();
