#!/usr/bin/env node
// llmmsg-channel plugin — MCP channel server for Claude Code sessions
// Spawned by CC as subprocess. Connects to the hub via SSE for push delivery.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import http from 'node:http';
import { execFileSync } from 'node:child_process';

const VERSION = '1.8';
const HUB_PORT = parseInt(process.env.LLMMSG_HUB_PORT || '9701');
const HUB_URL = `http://127.0.0.1:${HUB_PORT}`;
const AGENT_CWD = process.env.LLMMSG_CWD || process.cwd();

// Mutable — updated after register() call
let currentAgent = (process.env.LLMMSG_AGENT || '').toLowerCase();
// The alias used for the current SSE connection (may be unregistered-xxxx)
let sseAlias = '';

// HTTP helpers
function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(`${HUB_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ raw: out }); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    http.get(`${HUB_URL}${path}`, res => {
      let out = '';
      res.on('data', c => out += c);
      res.on('end', () => {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ raw: out }); }
      });
    }).on('error', reject);
  });
}

// MCP server
const mcp = new Server(
  { name: 'llmmsg-channel', version: VERSION },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: [
      'Messages from other Claude Code agents arrive as <channel source="llmmsg-channel" from="sender" tag="tag" re="re_tag"> tags.',
      'You must be registered before sending. If send returns not_registered, ask the user: "What is my agent name for this session?" then call register.',
      'Use the send tool to message other agents. Default to aro:{group} for group-wide notices. If you believe a message should go to to:"*", ask user Elazar first. Otherwise send to aro:{group}.',
      'Use the register tool to set your agent name (required once per session, or after name changes).',
      'Use the roster tool to see registered agents. Use the online tool to see which agents in your ARO group are currently online (CC and Codex).',
      'Use the thread tool to view a conversation thread by tag.',
      'Use the search tool to search message bodies.',
      'Use the log tool to see recent messages.',
      'Never use sleep, backoff, polling loops, timers, or repeated read checks to wait for llmmsg replies. After sending, stop and wait for push.',
      'Use has_unread or read_unread only when the user asks, or when you have strong evidence a reply is missing and manual recovery is actually needed. No loops.',
      'Do not re-register defensively before sends. Register at session start, after a name change, or only after an actual not_registered error.',
      'Tags are auto-generated as sender-id. Use re parameter to reply to a tag.',
      'Message body should be a JSON object with at least a message key, e.g. {"message": "your text"}. Avoid type unless a specific tool or workflow explicitly requires it. Add other structured keys only when machine-readable data is truly needed. Keep payloads lean.',
    ].join(' '),
  },
);

// Tool definitions
const TOOLS = [
  {
    name: 'register',
    description: 'Register your agent name with the hub (required before sending). Call this once per session with the name the user assigned to this session.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Your agent name (e.g. sh-ccs, mars-db-ccs). Will be lowercased.' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'send',
    description: 'Send a message to another agent or broadcast to all (to: "*"). Must be registered first.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name, or "*" for broadcast' },
        message: { type: 'object', description: 'JSON message body. Minimum: {"message": "your text"}. Avoid type unless explicitly required. Add structured keys only when machine-readable data is truly needed.' },
        re: { type: 'string', description: 'Tag of message being replied to (optional)' },
      },
      required: ['to', 'message'],
    },
  },
  {
    name: 'roster',
    description: 'List all registered agents and their working directories',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'online',
    description: 'List agents currently online in your ARO group(s). Includes both CC (SSE) and Codex (bridge) agents. Pass aro param to check a specific group.',
    inputSchema: {
      type: 'object',
      properties: {
        aro: { type: 'string', description: 'Optional: specific ARO group to check (e.g. "mars"). Defaults to your own ARO group(s).' },
      },
    },
  },
  {
    name: 'thread',
    description: 'View a message thread by tag (original + all replies)',
    inputSchema: {
      type: 'object',
      properties: { tag: { type: 'string', description: 'Tag of the root message' } },
      required: ['tag'],
    },
  },
  {
    name: 'search',
    description: 'Search message bodies for text',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Text to search for' } },
      required: ['query'],
    },
  },
  {
    name: 'log',
    description: 'Show recent messages (default 20)',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Number of messages to show' } },
    },
  },
  {
    name: 'aro_list',
    description: 'List all aros (groups) and their members. Pass agent to see which aros you belong to.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string', description: 'Agent name to filter by (optional)' } },
    },
  },
  {
    name: 'aro_join',
    description: 'Join an aro (group). You will receive messages sent to aro:<name>.',
    inputSchema: {
      type: 'object',
      properties: { aro: { type: 'string', description: 'Aro name to join (e.g. "evolutiva")' } },
      required: ['aro'],
    },
  },
  {
    name: 'aro_leave',
    description: 'Leave an aro (group).',
    inputSchema: {
      type: 'object',
      properties: { aro: { type: 'string', description: 'Aro name to leave' } },
      required: ['aro'],
    },
  },
  {
    name: 'unregister',
    description: 'Remove one or more agents from the roster. Use to clean up stale or misnamed registrations.',
    inputSchema: {
      type: 'object',
      properties: {
        agents: { type: 'array', items: { type: 'string' }, description: 'List of agent names to remove from roster' },
      },
      required: ['agents'],
    },
  },
  {
    name: 'guide',
    description: 'Fetch the current messaging guide (anti-patterns for efficient agent communication).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'has_unread',
    description: 'Return the unread message count for your registered agent name.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_unread',
    description: 'Read unread messages for your registered agent name and mark them as read.',
    inputSchema: { type: 'object', properties: {} },
  },
];

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  try {
    switch (name) {
      case 'register': {
        const newAgent = args.agent.toLowerCase();
        // Send the exact SSE alias (which may be unregistered-xxxx) so the hub can deterministically migrate
        const result = await httpPost('/register', {
          agent: newAgent,
          cwd: AGENT_CWD,
          old_agent: (sseAlias && sseAlias !== newAgent) ? sseAlias : (currentAgent || null),
        });
        if (result.ok) {
          currentAgent = newAgent;
        }
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'send': {
        if (!currentAgent) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'not_registered',
            message: 'You are not registered. Ask the user: "What is my agent name for this session?" Then call the register tool with that name.',
          }) }] };
        }
        const result = await httpPost('/send', {
          from: currentAgent,
          to: args.to,
          re: args.re || null,
          message: args.message,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'unregister': {
        const result = await httpPost('/unregister', { agents: args.agents });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'aro_list': {
        const path = args.agent ? `/aro?agent=${encodeURIComponent(args.agent)}` : '/aro';
        const result = await httpGet(path);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'aro_join': {
        if (!currentAgent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not_registered' }) }] };
        const result = await httpPost('/aro/join', { aro: args.aro.toLowerCase(), agent: currentAgent });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'aro_leave': {
        if (!currentAgent) return { content: [{ type: 'text', text: JSON.stringify({ error: 'not_registered' }) }] };
        const result = await httpPost('/aro/leave', { aro: args.aro.toLowerCase(), agent: currentAgent });
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      case 'roster': {
        const result = await httpGet('/roster');
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'online': {
        const params = [`agent=${encodeURIComponent(currentAgent || '')}`];
        if (args.aro) params.push(`aro=${encodeURIComponent(args.aro)}`);
        const result = await httpGet(`/online?${params.join('&')}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'thread': {
        const result = await httpGet(`/thread?tag=${encodeURIComponent(args.tag)}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'search': {
        const result = await httpGet(`/search?q=${encodeURIComponent(args.query)}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'log': {
        const limit = args.limit || 20;
        const result = await httpGet(`/log?limit=${limit}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'guide': {
        const result = await httpGet('/guide');
        return { content: [{ type: 'text', text: result.guide || JSON.stringify(result) }] };
      }
      case 'has_unread': {
        if (!currentAgent) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'not_registered',
            message: 'You are not registered. Ask the user: "What is my agent name for this session?" Then call the register tool with that name.',
          }) }] };
        }
        const result = await httpGet(`/has-unread?agent=${encodeURIComponent(currentAgent)}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      case 'read_unread': {
        if (!currentAgent) {
          return { content: [{ type: 'text', text: JSON.stringify({
            error: 'not_registered',
            message: 'You are not registered. Ask the user: "What is my agent name for this session?" Then call the register tool with that name.',
          }) }] };
        }
        const result = await httpGet(`/read-unread?agent=${encodeURIComponent(currentAgent)}`);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  } catch (err) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: err.message }) }] };
  }
});

// Connect MCP to Claude Code via stdio
await mcp.connect(new StdioServerTransport());

// Auto-register if LLMMSG_AGENT is set (avoids gap between startup and manual register call)
if (currentAgent) {
  httpPost('/register', { agent: currentAgent, cwd: AGENT_CWD, old_agent: null })
    .then(async (result) => {
      if (result.ok) {
        console.error(`[llmmsg-channel] auto-registered as ${currentAgent}`);
        // Send guide on first register
        try {
          const guide = await httpGet('/guide');
          if (guide.guide) {
            mcp.notification({
              method: 'notifications/claude/channel',
              params: {
                content: `Messaging guide v${guide.version}:\n${guide.guide}`,
                meta: { from: 'system', to: currentAgent, tag: `guide-v${guide.version}` },
              },
            });
          }
        } catch {}
      } else {
        console.error(`[llmmsg-channel] auto-register failed:`, JSON.stringify(result));
      }
    })
    .catch(err => console.error(`[llmmsg-channel] auto-register error: ${err.message}`));
}

// Connect to hub via SSE for push delivery
function connectToHub() {
  const agentParam = currentAgent || `unregistered-${Math.random().toString(36).slice(2, 8)}`;
  sseAlias = agentParam; // remember the alias so manual register can pass it as old_agent
  const url = `${HUB_URL}/connect?agent=${encodeURIComponent(agentParam)}&cwd=${encodeURIComponent(AGENT_CWD)}`;

  http.get(url, (res) => {
    console.error(`[llmmsg-channel] connected to hub as ${agentParam}`);
    let buffer = '';

    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));
            console.error(`[llmmsg-channel] PUSH from=${event.from} tag=${event.tag} to=${event.to}`);
            mcp.notification({
              method: 'notifications/claude/channel',
              params: {
                content: typeof event.body === 'object' ? JSON.stringify(event.body) : String(event.body),
                meta: {
                  from: event.from,
                  to: event.to,
                  tag: event.tag,
                  ...(event.re ? { re: event.re } : {}),
                },
              },
            });
          } catch (e) {
            console.error('[llmmsg-channel] parse error:', e.message);
          }
        }
      }
    });

    res.on('end', () => {
      console.error('[llmmsg-channel] hub disconnected, reconnecting in 5s...');
      setTimeout(connectToHub, 5000);
    });

    res.on('error', (err) => {
      console.error('[llmmsg-channel] SSE error:', err.message);
      setTimeout(connectToHub, 5000);
    });
  }).on('error', (err) => {
    console.error(`[llmmsg-channel] hub connection failed: ${err.message}, retrying in 5s...`);
    setTimeout(connectToHub, 5000);
  });
}

// Auto-unregister on clean exit so the agent is removed from AROs and roster.
// This prevents dead agents from receiving ARO-fanned messages after a session ends.
function unregisterSync() {
  if (!currentAgent) return;
  try {
    execFileSync('curl', [
      '-s', '-m', '2',
      '-X', 'POST', `${HUB_URL}/unregister`,
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ agent: currentAgent }),
    ], { timeout: 3000, stdio: 'ignore' });
  } catch {}
}

process.on('SIGTERM', () => { unregisterSync(); process.exit(0); });
process.on('SIGINT', () => { unregisterSync(); process.exit(0); });

connectToHub();
