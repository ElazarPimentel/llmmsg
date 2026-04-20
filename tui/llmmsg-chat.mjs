#!/usr/bin/env node
// llmmsg-ecosystem
// llmmsg-chat.mjs - TUI chat client for llmmsg-channel (human agent)
// See /opt/llmmsg/ECOSYSTEM.md

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import termkit from 'terminal-kit';

const VERSION = '0.3.1';
const term = termkit.terminal;

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
};

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    return { ...defaultSettings };
  }
}

function saveSettings(s) {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
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
    console.log('  Tab                    cycle rooms');
    console.log('  Esc                    focus input');
    console.log('  PgUp/PgDn             scroll chat');
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

// ---------- Layout ----------
//
// rooms: [all]  aro:one  aro:two
// ┌─ chat - agent - vX.Y ─────────────────────────────────────────┐
// │ 22:32 system message                                          │
// │ 22:33 <agent> hello                                           │
// └───────────────────────────────────────────────────────────────┘
// ┌─ input (Enter=send, Ctrl-C/Q=quit, Tab=rooms) ───────────────┐  <- inputBorderTop
// │ > text here_                                                  │  <- inputContentRow
// └───────────────────────────────────────────────────────────────┘  <- H

let W = Math.max(term.width || 80, 40);
let H = Math.max(term.height || 24, 10);

function roomsRow() { return 1; }
function mainTop() { return 2; }
function mainContentTop() { return 3; }
function mainBottom() { return H - 3; } // bottom border row (content rows: mainContentTop..mainBottom-1)
function mainContentH() { return Math.max(1, mainBottom() - mainContentTop()); }
function inputBorderTop() { return H - 2; }
function inputContentRow() { return H - 1; }
function inputBorderBottom() { return H; }

function chatContentLeft() { return 2; }
function chatContentW() { return Math.max(1, W - 2); }

// ---------- Box drawing ----------

function fitLabel(label, maxW) {
  if (maxW <= 0) return '';
  return label.length <= maxW ? label : label.slice(0, maxW);
}

function drawFrame() {
  const gray = '\x1b[90m';
  const rst = '\x1b[0m';

  // Top border: ┌─ chat - agent ─...─┐
  term.moveTo(1, mainTop());
  const target = state.currentTarget || 'no room';
  const chatLabel = fitLabel(` chat - ${AGENT} - v${VERSION} - ${target} `, W - 2);
  const topLine = '┌' + chatLabel + '─'.repeat(Math.max(0, W - 2 - chatLabel.length)) + '┐';
  term.noFormat(gray + topLine + rst);

  // Side borders for content rows
  const contentH = mainContentH();
  for (let r = 0; r < contentH; r++) {
    const row = mainContentTop() + r;
    term.moveTo(1, row);
    term.noFormat(gray + '│' + rst);
    term.moveTo(W, row);
    term.noFormat(gray + '│' + rst);
  }

  // Bottom border of chat box: └─...─┘
  term.moveTo(1, mainBottom());
  const botLine = '└' + '─'.repeat(Math.max(0, W - 2)) + '┘';
  term.noFormat(gray + botLine.slice(0, W) + rst);

  // Input box top border: ┌─ input ─...─┐
  const inputLabel = fitLabel(' input (Enter=send, Ctrl-C/Q=quit, Tab=rooms) ', W - 2);
  term.moveTo(1, inputBorderTop());
  const inTop = '┌' + inputLabel + '─'.repeat(Math.max(0, W - 2 - inputLabel.length)) + '┐';
  term.noFormat(gray + inTop + rst);

  // Input side borders
  term.moveTo(1, inputContentRow());
  term.noFormat(gray + '│' + rst);
  term.moveTo(W, inputContentRow());
  term.noFormat(gray + '│' + rst);

  // Input bottom border: └─...─┘
  term.moveTo(1, inputBorderBottom());
  let inBot = '└';
  inBot += '─'.repeat(Math.max(0, W - 2));
  inBot += '┘';
  term.noFormat(gray + inBot.slice(0, W) + rst);
}

// ---------- Chat pane (scrollback buffer) ----------

let chatLines = [];
let chatScroll = 0;

function chatPush(line) {
  chatLines.push(line);
  if (chatLines.length > 2000) chatLines = chatLines.slice(-1500);
  if (chatScroll === 0) renderChat();
}

function renderChat() {
  const h = mainContentH();
  const w = chatContentW();
  const x = chatContentLeft();
  const y = mainContentTop();

  const wrapped = [];
  for (const line of chatLines) {
    const plain = stripAnsi(line);
    if (plain.length <= w) {
      wrapped.push(line);
    } else {
      const chunks = wrapText(line, w);
      for (const c of chunks) wrapped.push(c);
    }
  }

  let startIdx;
  if (chatScroll === 0) {
    startIdx = Math.max(0, wrapped.length - h);
  } else {
    startIdx = Math.max(0, wrapped.length - h - chatScroll);
  }

  for (let row = 0; row < h; row++) {
    term.moveTo(x, y + row);
    const lineIdx = startIdx + row;
    if (lineIdx >= 0 && lineIdx < wrapped.length) {
      const rawLine = wrapped[lineIdx];
      const plainLine = stripAnsi(rawLine);
      const visibleLine = plainLine.length <= w ? rawLine : plainLine.slice(0, w);
      process.stdout.write(visibleLine + '\x1b[0m');
      const remaining = w - Math.min(plainLine.length, w);
      if (remaining > 0) term(' '.repeat(remaining));
    } else {
      term(' '.repeat(Math.max(0, w)));
    }
  }
}

function wrapText(line, maxW) {
  const plain = stripAnsi(line);
  if (plain.length <= maxW) return [line];
  const result = [];
  let pos = 0;
  while (pos < plain.length) {
    result.push(plain.slice(pos, pos + maxW));
    pos += maxW;
  }
  return result;
}

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

// ---------- Rooms bar ----------

let roomItems = ['[all]'];
let roomSelected = 0;

function syncRoomSelection() {
  if (!state.currentTarget) {
    roomSelected = 0;
    return;
  }
  const rooms = [...state.rooms];
  const idx = rooms.indexOf(state.currentTarget);
  roomSelected = idx >= 0 ? idx + 1 : 0;
}

function renderRoomsBar() {
  term.moveTo(1, roomsRow());
  term.styleReset();
  term(' '.repeat(W));
  term.moveTo(1, roomsRow());
  term.gray('rooms ');

  let used = 6;
  for (let i = 0; i < roomItems.length; i++) {
    const raw = roomItems[i];
    const label = ` ${raw} `;
    if (used + label.length > W) {
      term.gray(' ...');
      break;
    }
    if (i === roomSelected) {
      term.bgBlue.white(label);
    } else {
      term.styleReset();
      term.gray(label);
    }
    used += label.length;
  }
  term.styleReset();
}

function updateRoomsBar() {
  syncRoomSelection();
  roomItems = ['[all]', ...[...state.rooms].map((r) => {
    const unread = state.unreadBuckets.get(r) || 0;
    return unread > 0 ? `${r} (${unread})` : r;
  })];
  renderRoomsBar();
}

// ---------- Input box ----------

let inputBuffer = '';
let inputCursor = 0;
let inputScrollX = 0;

function renderInput() {
  const row = inputContentRow();
  const w = Math.max(1, W - 2); // inside borders
  const x = 2; // after left border

  if (inputCursor < inputScrollX) inputScrollX = inputCursor;
  if (inputCursor >= inputScrollX + w - 2) inputScrollX = inputCursor - w + 3;

  const promptW = w - 2; // after "> "
  const visible = inputBuffer.slice(inputScrollX, inputScrollX + promptW);
  const cursorPos = inputCursor - inputScrollX;

  term.moveTo(x, row);
  term.styleReset();
  term.cyan('> ');

  for (let i = 0; i < promptW; i++) {
    const ch = i < visible.length ? visible[i] : ' ';
    if (i === cursorPos) {
      term.bgWhite.black(ch);
    } else {
      term.styleReset();
      term(ch);
    }
  }
  term.styleReset();
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

function clearInput() {
  inputBuffer = '';
  inputCursor = 0;
  inputScrollX = 0;
  renderInput();
}

// ---------- Chat formatting ----------

function senderColor(name) {
  if (name === state.agent) return 'cyan';
  let hash = 0;
  for (const ch of String(name || '')) hash = ((hash * 31) + ch.charCodeAt(0)) >>> 0;
  return SENDER_COLORS[hash % SENDER_COLORS.length];
}

function colorize(text, color) {
  const codes = { cyan: '36', green: '32', yellow: '33', magenta: '35', blue: '34', red: '31', grey: '90', white: '37' };
  const code = codes[color] || '37';
  return `\x1b[${code}m${text}\x1b[0m`;
}

function formatMessage(msg, showContext) {
  const { from, to, body, _bucket, origin_aro } = msg;
  const ts = new Date().toTimeString().slice(0, 8);
  let text = typeof body === 'object' ? (body.message || JSON.stringify(body)) : String(body);
  text = text.replace(/\r?\n/g, ' ');

  let prefix = '';
  if (showContext) {
    const room = origin_aro || _bucket;
    if (room && room.startsWith('aro:')) prefix = `[${room}] `;
    else if (from === state.agent) prefix = `[→${to}] `;
    else if (to === state.agent) prefix = `[DM] `;
    else prefix = `[→${to}] `;
  }

  const color = senderColor(from);
  const divider = colorize('─'.repeat(Math.max(24, chatContentW() - 2)), 'grey');
  const line = `${colorize(ts, 'grey')} ${prefix}${colorize('<' + from + '>', color)} ${text}`;
  return [divider, line];
}

function logSystem(text) {
  const ts = new Date().toTimeString().slice(0, 8);
  const safe = String(text).replace(/\r?\n/g, ' ');
  chatPush(`${colorize(ts, 'grey')} ${colorize(safe, 'grey')}`);
}

function printMessage(msg, showContext) {
  const lines = formatMessage(msg, showContext);
  for (const l of lines) chatPush(l);
}

// ---------- SSE ----------

let sseReq = null;
let sseReconnectTimer = null;
let sseConnected = false;

function scheduleReconnect() {
  if (sseReconnectTimer) return;
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
      logSystem(`SSE connect failed: HTTP ${res.statusCode}`);
      scheduleReconnect();
      return;
    }
    sseConnected = true;
    logSystem(`connected to hub as ${state.agent}`);
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
      sseConnected = false;
      logSystem('SSE stream ended; reconnecting in 3s...');
      scheduleReconnect();
    });
    res.on('error', (err) => {
      sseConnected = false;
      logSystem(`SSE stream error: ${err.message}`);
      scheduleReconnect();
    });
  });
  sseReq = req;
  req.on('error', (err) => {
    sseConnected = false;
    logSystem(`SSE connect error: ${err.message}; retrying in 3s...`);
    scheduleReconnect();
  });
}

function handleIncoming(event) {
  let bucket = event.origin_aro || null;
  if (event.re && state.recentTags.has(event.re)) {
    bucket ||= state.recentTags.get(event.re);
  }
  const entry = { ...event };
  if (bucket) entry._bucket = bucket;
  addMessage(bucket || '__all__', entry);

  if (!event.origin_aro && event.to === state.agent && event.from !== state.agent) {
    if (!state.history[event.from]) state.history[event.from] = [];
    state.history[event.from].push(entry);
    if (state.history[event.from].length > 200) state.history[event.from].shift();
  }

  const viewing = state.currentTarget;
  const unreadBucket = event.origin_aro || (event.to === state.agent ? event.from : null);
  if (unreadBucket && viewing !== unreadBucket) {
    state.unreadBuckets.set(unreadBucket, (state.unreadBuckets.get(unreadBucket) || 0) + 1);
    updateRoomsBar();
  }

  printMessage(entry, true);

  if (settings.bell && !event.origin_aro && event.to === state.agent && event.from !== state.agent) {
    term.bell();
  }
}

// ---------- Submit / Commands ----------

async function submitInput() {
  const value = inputBuffer;
  clearInput();
  try {
    await handleInput(value);
  } catch (e) {
    logSystem(`error: ${e.message}`);
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
    logSystem('No target. Pick a room (Tab) or use /msg <agent> <text>.');
    return;
  }
  await sendToTarget(state.currentTarget, text);
}

async function sendToTarget(target, text) {
  const msgBody = { message: text };
  const result = await hub.send(state.agent, target, msgBody, null);
  if (result.status !== 200) {
    logSystem(`send failed: ${result.body?.error || result.status}`);
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
}

async function handleCommand(cmd, arg, rest) {
  switch (cmd) {
    case 'help':
      logSystem('Ctrl-C/Ctrl-Q quit | Tab rooms | Esc input | PgUp/PgDn scroll | Home/End line');
      logSystem('Ctrl-Left/Right word jump | Ctrl-W delete word | Ctrl-U clear left | Ctrl-K clear right');
      logSystem('Commands: /join /leave /rooms /room /who /msg /invite /guide /settings /quit');
      break;
    case 'join': {
      if (!arg) return logSystem('Usage: /join <aro-name>');
      const aro = normalizeAroName(arg);
      const r = await hub.aroJoin(aro, state.agent);
      if (r.status === 200) {
        const room = `aro:${aro}`;
        state.rooms.add(room);
        persistJoinedRooms();
        state.currentTarget = room;
        state.unreadBuckets.delete(room);
        updateRoomsBar();
        renderViewForBucket(room);
        drawFrame();
        logSystem(`joined aro:${aro}`);
      } else {
        logSystem(`join failed: ${r.body?.error || r.status}`);
      }
      break;
    }
    case 'leave': {
      if (!arg) return logSystem('Usage: /leave <aro-name>');
      const aro = normalizeAroName(arg);
      const r = await hub.aroLeave(aro, state.agent);
      if (r.status === 200) {
        state.rooms.delete(`aro:${aro}`);
        persistJoinedRooms();
        if (state.currentTarget === `aro:${aro}`) state.currentTarget = null;
        updateRoomsBar();
        drawFrame();
        logSystem(`left aro:${aro}`);
      } else {
        logSystem(`leave failed: ${r.body?.error || r.status}`);
      }
      break;
    }
    case 'rooms':
      logSystem(`joined: ${[...state.rooms].join(', ') || '(none)'}`);
      break;
    case 'room': {
      if (!arg) return logSystem('Usage: /room <aro-name> or "all"');
      if (arg === 'all') {
        state.currentTarget = null;
        renderViewForBucket('__all__');
        drawFrame();
        renderRoomsBar();
        return;
      }
      const aro = arg.startsWith('aro:') ? arg : `aro:${arg.toLowerCase()}`;
      state.currentTarget = aro;
      state.unreadBuckets.delete(aro);
      updateRoomsBar();
      renderViewForBucket(aro);
      drawFrame();
      break;
    }
    case 'who': {
      const aro = arg ? arg.replace(/^aro:/, '').toLowerCase() : null;
      const r = await hub.online(state.agent, aro);
      if (r.status === 200) {
        logSystem(`online (${r.body.count}): ${r.body.online.join(', ') || '(none)'}`);
      } else {
        logSystem(`who failed: ${r.body?.error || r.status}`);
      }
      break;
    }
    case 'msg': {
      const to = rest[0];
      const text = rest.slice(1).join(' ');
      if (!to || !text) return logSystem('Usage: /msg <agent-name> <text>');
      const r = await hub.send(state.agent, to.toLowerCase(), { message: text }, null);
      if (r.status !== 200) {
        logSystem(`msg failed: ${r.body?.error || r.status}`);
        if (r.body?.online) logSystem(`online: ${r.body.online.join(', ')}`);
      } else {
        const entry = { from: state.agent, to: to.toLowerCase(), tag: r.body?.tag, body: { message: text } };
        addMessage(to.toLowerCase(), entry);
        printMessage(entry, true);
      }
      break;
    }
    case 'invite': {
      const target = rest[0];
      const aro = rest[1]?.replace(/^aro:/, '').toLowerCase();
      if (!target || !aro) return logSystem('Usage: /invite <agent-name> <aro-name>');
      const msg = { message: `Elazar asks you to join the chat room by calling: aro_join("${aro}"). This is a live chat, not a task broadcast.` };
      const r = await hub.send(state.agent, target.toLowerCase(), msg, null);
      if (r.status === 200) logSystem(`invite sent to ${target} for aro:${aro}`);
      else logSystem(`invite failed: ${r.body?.error || r.status}`);
      break;
    }
    case 'guide': {
      const r = await hub.guide();
      if (r.status === 200 && r.body?.guide) {
        for (const line of r.body.guide.split('\n')) logSystem(line);
      } else {
        logSystem('guide fetch failed');
      }
      break;
    }
    case 'settings':
      logSystem(`agent=${settings.agent} hub=${HUB_URL} bell=${settings.bell} version=${VERSION}`);
      logSystem(`settings: ${SETTINGS_PATH}`);
      break;
    case 'quit':
    case 'exit':
      await shutdown();
      break;
    default:
      logSystem(`unknown command: /${cmd} (/help for commands)`);
  }
}

// ---------- View switching ----------

function renderViewForBucket(bucket) {
  chatLines = [];
  chatScroll = 0;
  const messages = state.history[bucket] || [];
  for (const msg of messages) {
    const lines = formatMessage(msg, bucket === '__all__');
    for (const l of lines) chatLines.push(l);
  }
  renderChat();
}

// ---------- Key handling ----------

let lastCharTime = 0;
const PASTE_THRESHOLD_MS = 30;

function isPasting() {
  return (Date.now() - lastCharTime) < PASTE_THRESHOLD_MS;
}

function handleKey(name, matches, data) {
  if (name === 'CTRL_C' || name === 'CTRL_Q') {
    shutdown();
    return;
  }

  if (name === 'TAB') {
    const count = Math.max(1, roomItems.length);
    roomSelected = (roomSelected + 1) % count;
    selectRoomItem(roomSelected);
    return;
  }

  if (name === 'PAGE_UP') {
    chatScroll += mainContentH();
    renderChat();
    return;
  }

  if (name === 'PAGE_DOWN') {
    chatScroll = Math.max(0, chatScroll - mainContentH());
    renderChat();
    return;
  }

  // Input mode
  if (name === 'ENTER') {
    if (isPasting()) {
      insertInput(' ');
    } else {
      submitInput();
    }
    return;
  }
  if (name === 'BACKSPACE') { deleteBack(); return; }
  if (name === 'DELETE') { deleteForward(); return; }
  if (name === 'HOME' || name === 'CTRL_A') { inputCursor = 0; renderInput(); return; }
  if (name === 'END' || name === 'CTRL_E') { inputCursor = inputBuffer.length; renderInput(); return; }
  if (name === 'LEFT') { inputCursor = Math.max(0, inputCursor - 1); renderInput(); return; }
  if (name === 'RIGHT') { inputCursor = Math.min(inputBuffer.length, inputCursor + 1); renderInput(); return; }
  if (name === 'CTRL_LEFT') { wordLeft(); return; }
  if (name === 'CTRL_RIGHT') { wordRight(); return; }
  if (name === 'CTRL_W') { deleteWordBack(); return; }
  if (name === 'CTRL_U') { inputBuffer = inputBuffer.slice(inputCursor); inputCursor = 0; inputScrollX = 0; renderInput(); return; }
  if (name === 'CTRL_K') { inputBuffer = inputBuffer.slice(0, inputCursor); renderInput(); return; }

  if (data && data.isCharacter) {
    lastCharTime = Date.now();
    insertInput(matches[0]);
  }
}

function selectRoomItem(index) {
  if (index === 0) {
    state.currentTarget = null;
    renderViewForBucket('__all__');
  } else {
    const roomName = [...state.rooms][index - 1];
    if (roomName) {
      state.currentTarget = roomName;
      state.unreadBuckets.delete(roomName);
      updateRoomsBar();
      renderViewForBucket(roomName);
    }
  }
  drawFrame();
  renderRoomsBar();
  renderInput();
}

// ---------- Full screen render ----------

function fullRender() {
  term.clear();
  drawFrame();
  renderChat();
  renderRoomsBar();
  renderInput();
}

// ---------- Lifecycle ----------

async function startup() {
  logSystem(`llmmsg-chat v${VERSION} starting as ${AGENT} against ${HUB_URL}`);
  fullRender();

  try {
    const reg = await hub.register(state.agent, process.cwd());
    if (reg.status !== 200) {
      logSystem(`register failed: ${reg.body?.error || reg.status}`);
      return;
    }
    logSystem('registered');
  } catch (err) {
    logSystem(`register error: ${err.message}`);
    return;
  }

  try {
    const r = await hub.aroList(state.agent);
    if (r.status === 200 && Array.isArray(r.body?.aros)) {
      for (const aro of r.body.aros) state.rooms.add(`aro:${aro}`);
      updateRoomsBar();
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
  updateRoomsBar();

  try {
    const r = await hub.readUnread(state.agent);
    if (r.status === 200 && Array.isArray(r.body)) {
      for (const msg of r.body) handleIncoming(msg);
      if (r.body.length) logSystem(`replayed ${r.body.length} unread`);
    }
  } catch {}

  connectSSE();
}

async function shutdown() {
  try {
    await hub.unregister(state.agent);
  } catch {}
  term.grabInput(false);
  term.hideCursor(false);
  term.styleReset();
  term.fullscreen(false);
  term.moveTo(1, 1);
  term(`llmmsg-chat v${VERSION} exited.\n`);
  process.exit(0);
}

// ---------- Init ----------

term.fullscreen(true);
term.grabInput({ mouse: false });
term.hideCursor(true);

process.title = `llmmsg-chat v${VERSION} (${AGENT})`;

term.on('key', handleKey);

term.on('resize', (w, h) => {
  W = Math.max(w || 40, 40);
  H = Math.max(h || 10, 10);
  fullRender();
});

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

fullRender();
startup();
