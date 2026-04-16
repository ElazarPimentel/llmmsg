#!/usr/bin/env node
// llmmsg-ecosystem
// llmmsg-chat.mjs - TUI chat client for llmmsg-channel (human agent)
// See /opt/llmmsg/ECOSYSTEM.md

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import blessed from 'blessed';

const VERSION = '0.2.6';

// ---------- Settings ----------

const CONFIG_DIR = path.join(os.homedir(), '.config', 'llmmsg-chat');
const SETTINGS_PATH = path.join(CONFIG_DIR, 'settings.json');
const SENDER_COLORS = ['cyan', 'green', 'yellow', 'magenta', 'blue', 'red'];

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
    console.log('  Ctrl-C / Ctrl-Q        Quit');
    console.log('  Tab / Shift-Tab        switch rooms in sidebar');
    console.log('  Esc                    focus input');
    console.log('  /help                  show commands');
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
  height: '100%-6',
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
  height: '100%-6',
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
  bottom: 5,
  left: 0,
  right: 0,
  height: 1,
  style: { fg: 'yellow' },
  content: ' SPEAKING IN: [none — pick a room (Tab), /msg, or /join]',
});

// Input height 5: top border + 3 content rows + bottom border.
const input = blessed.textbox({
  parent: screen,
  bottom: 0,
  left: 0,
  right: 0,
  height: 5,
  label: ' input (Enter=send, Ctrl-C/Ctrl-Q=quit, Tab=rooms) ',
  border: { type: 'line' },
  style: {
    border: { fg: 'cyan' },
    fg: 'white',
    focus: { border: { fg: 'yellow' } },
  },
  inputOnFocus: false, // we drive input from screen.program keypress
  keys: true,
  mouse: true,
});

function log(text, color = 'white') {
  const ts = new Date().toTimeString().slice(0, 8);
  chatPane.log(`{grey-fg}${ts}{/grey-fg} {${color}-fg}${text}{/${color}-fg}`);
}

function systemLog(text) {
  log(text, 'grey');
}

function updateStatus() {
  let target = state.currentTarget;
  if (!target) {
    statusBar.setContent(' SPEAKING IN: [none — pick a room (Tab), /msg, or /join]');
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

function senderColor(name) {
  if (name === state.agent) return 'cyan';
  let hash = 0;
  for (const ch of String(name || '')) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  return SENDER_COLORS[hash % SENDER_COLORS.length];
}

function dividerLine() {
  const width = Math.max(24, (chatPane.width || screen.width || 80) - 4);
  return '─'.repeat(width);
}

function printMessage(msg, showContext) {
  const { from, to, body, _bucket, origin_aro } = msg;
  const ts = new Date().toTimeString().slice(0, 8);
  let text = typeof body === 'object' ? (body.message || JSON.stringify(body)) : String(body);

  // Context prefix: show what kind of message this is
  let prefix = '';
  if (showContext) {
    const room = origin_aro || _bucket;
    if (room && room.startsWith('aro:')) prefix = `[${room}] `;
    else if (from === state.agent) prefix = `[→${to}] `;
    else if (to === state.agent) prefix = `[DM] `;
    else prefix = `[→${to}] `;
  }

  const color = senderColor(from);

  chatPane.log(`{grey-fg}${dividerLine()}{/grey-fg}`);
  chatPane.log(`{grey-fg}${ts}{/grey-fg} ${prefix}{${color}-fg}<${from}>{/${color}-fg} ${text}`);
}

// ---------- SSE ----------

let sseReq = null;
let sseReconnectTimer = null;
let sseConnected = false;

function scheduleReconnect(reason) {
  if (sseReconnectTimer) return; // already scheduled
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
  sseConnected = false;
  const req = http.get(url, (res) => {
    if (res.statusCode !== 200) {
      systemLog(`SSE connect failed: HTTP ${res.statusCode}`);
      scheduleReconnect(`http_${res.statusCode}`);
      return;
    }
    sseConnected = true;
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
            } catch (err) {
            }
          }
        }
      }
    });
    res.on('end', () => {
      sseConnected = false;
      systemLog('SSE stream ended; reconnecting in 3s...');
      scheduleReconnect('end');
    });
    res.on('error', (err) => {
      sseConnected = false;
      systemLog(`SSE stream error: ${err.message}`);
      scheduleReconnect('stream_err');
    });
  });
  sseReq = req;
  req.on('error', (err) => {
    sseConnected = false;
    systemLog(`SSE connect error: ${err.message}; retrying in 3s...`);
    scheduleReconnect('connect_err');
  });
}

function handleIncoming(event) {

  // Bucket attribution: origin_aro is authoritative for ARO fanout rows.
  // Fallback to reply-to-recent-tag only for older messages sent before origin_aro.
  let bucket = event.origin_aro || null;
  if (event.re && state.recentTags.has(event.re)) {
    bucket ||= state.recentTags.get(event.re);
  }
  const entry = { ...event };
  if (bucket) entry._bucket = bucket;
  addMessage(bucket || '__all__', entry);

  // Also store true DMs in sender bucket for history.
  if (!event.origin_aro && event.to === state.agent && event.from !== state.agent) {
    if (!state.history[event.from]) state.history[event.from] = [];
    state.history[event.from].push(entry);
    if (state.history[event.from].length > 200) state.history[event.from].shift();
  }

  // Unread tracking: ARO fanout counts against its room; true DMs against sender.
  const viewing = state.currentTarget;
  const unreadBucket = event.origin_aro || (event.to === state.agent ? event.from : null);
  if (unreadBucket && viewing !== unreadBucket) {
    state.unreadBuckets.set(unreadBucket, (state.unreadBuckets.get(unreadBucket) || 0) + 1);
    updateSidebar();
  }

  // Always print incoming messages in the current chat pane. The user needs
  // to see replies regardless of which room or DM is currently selected.
  // Visual distinction: DMs to me = yellow, room messages = white, self = cyan.
  printMessage(entry, true); // true = show bucket/from-to context
  screen.render();

  if (settings.bell && !event.origin_aro && event.to === state.agent && event.from !== state.agent) {
    process.stdout.write('\x07');
  }
}

// ---------- Input handling ----------

let inputBuffer = '';
let inputCursor = 0;

function escapeTags(text) {
  return String(text).replace(/[{}]/g, (ch) => (ch === '{' ? '{open}' : '{close}'));
}

function renderInput() {
  const before = escapeTags(inputBuffer.slice(0, inputCursor));
  const current = inputCursor < inputBuffer.length ? escapeTags(inputBuffer[inputCursor]) : ' ';
  const after = escapeTags(inputBuffer.slice(inputCursor + 1));
  input.setContent(`${before}{inverse}${current}{/inverse}${after}`);
  input.value = inputBuffer;
  screen.render();
}

function insertInput(text) {
  inputBuffer = inputBuffer.slice(0, inputCursor) + text + inputBuffer.slice(inputCursor);
  inputCursor += text.length;
  renderInput();
}

function deleteBack() {
  if (inputCursor <= 0) return;
  inputBuffer = inputBuffer.slice(0, inputCursor - 1) + inputBuffer.slice(inputCursor);
  inputCursor -= 1;
  renderInput();
}

function deleteForward() {
  if (inputCursor >= inputBuffer.length) return;
  inputBuffer = inputBuffer.slice(0, inputCursor) + inputBuffer.slice(inputCursor + 1);
  renderInput();
}

function wordLeft() {
  while (inputCursor > 0 && /\s/.test(inputBuffer[inputCursor - 1])) inputCursor--;
  while (inputCursor > 0 && !/\s/.test(inputBuffer[inputCursor - 1])) inputCursor--;
  renderInput();
}

function wordRight() {
  while (inputCursor < inputBuffer.length && !/\s/.test(inputBuffer[inputCursor])) inputCursor++;
  while (inputCursor < inputBuffer.length && /\s/.test(inputBuffer[inputCursor])) inputCursor++;
  renderInput();
}

function deleteWordBack() {
  const end = inputCursor;
  wordLeft();
  inputBuffer = inputBuffer.slice(0, inputCursor) + inputBuffer.slice(end);
  renderInput();
}

async function submitInput() {
  const value = inputBuffer;
  inputBuffer = '';
  inputCursor = 0;
  renderInput();
  try {
    await handleInput(value);
  } catch (e) {
    systemLog(`error: ${e.message}`);
  }
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
  const result = await hub.send(state.agent, target, msgBody, null);
  if (result.status !== 200) {
    systemLog(`send failed: ${result.body?.error || result.status}`);
    return;
  }
  const tag = result.body?.tag;
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
  switch (cmd) {
    case 'help':
      systemLog('Ctrl-C/Ctrl-Q quit · Tab rooms · Esc input · Ctrl-Left/Right word jump · Home/End line start/end');
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
      break;
    case 'quit':
    case 'exit':
      await shutdown();
      break;
    default:
      systemLog(`unknown command: /${cmd} (/help for commands)`);
  }
}

// ---------- Key bindings ----------

screen.key(['C-c', 'C-q'], () => { shutdown(); });

screen.program.on('keypress', (ch, key) => {
  const keyName = key?.name || null;
  if (key?.ctrl && ['c', 'q'].includes(keyName)) return shutdown();
  if (keyName === 'tab') {
    if (screen.focused === sidebar) input.focus();
    else sidebar.focus();
    screen.render();
    return;
  }
  if (keyName === 'escape') {
    input.focus();
    screen.render();
    return;
  }
  if (screen.focused !== input) return;
  if (keyName === 'enter' || keyName === 'return') return submitInput();
  if (keyName === 'backspace') return deleteBack();
  if (keyName === 'delete') return deleteForward();
  if (keyName === 'home' || (key?.ctrl && keyName === 'a')) { inputCursor = 0; return renderInput(); }
  if (keyName === 'end' || (key?.ctrl && keyName === 'e')) { inputCursor = inputBuffer.length; return renderInput(); }
  if (keyName === 'left') { key.ctrl || key.meta ? wordLeft() : (inputCursor = Math.max(0, inputCursor - 1), renderInput()); return; }
  if (keyName === 'right') { key.ctrl || key.meta ? wordRight() : (inputCursor = Math.min(inputBuffer.length, inputCursor + 1), renderInput()); return; }
  if (key?.ctrl && keyName === 'w') return deleteWordBack();
  if (ch && !key?.ctrl && !key?.meta && !/^[\x00-\x1f\x7f]$/.test(ch)) insertInput(ch);
});

sidebar.on('select', (_item, index) => {
  const rawItem = sidebar.getItem(index)?.content || '';
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
  renderInput();
});

// ---------- Lifecycle ----------

async function startup() {
  systemLog(`llmmsg-chat v${VERSION} starting as ${AGENT} against ${HUB_URL}`);
  try {
    const reg = await hub.register(state.agent, process.cwd());
    if (reg.status !== 200) {
      systemLog(`register failed: ${reg.body?.error || reg.status}`);
      return;
    }
    systemLog(`registered`);
  } catch (err) {
    systemLog(`register error: ${err.message}`);
    return;
  }

  try {
    const r = await hub.aroList(state.agent);
    if (r.status === 200 && Array.isArray(r.body?.aros)) {
      for (const aro of r.body.aros) state.rooms.add(`aro:${aro}`);
      updateSidebar();
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

// Init UI
input.focus();
updateStatus();
updateSidebar();
screen.render();
renderInput();

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

startup();
