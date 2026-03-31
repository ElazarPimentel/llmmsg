# Channels reference

> Build an MCP server that pushes webhooks, alerts, and chat messages into a Claude Code session. Reference for the channel contract: capability declaration, notification events, reply tools, sender gating, and permission relay.

**Note:** Channels are in research preview and require Claude Code v2.1.80 or later. They require claude.ai login. Console and API key authentication is not supported. Team and Enterprise organizations must explicitly enable them.

A channel is an MCP server that pushes events into a Claude Code session so Claude can react to things happening outside the terminal.

You can build a one-way or two-way channel. One-way channels forward alerts, webhooks, or monitoring events. Two-way channels like chat bridges also expose a reply tool so Claude can send messages back. A channel with a trusted sender path can also opt in to relay permission prompts so you can approve or deny tool use remotely.

## Overview

A channel is an MCP server that runs on the same machine as Claude Code. Claude Code spawns it as a subprocess and communicates over stdio.

* **Chat platforms** (Telegram, Discord): your plugin runs locally and polls the platform's API for new messages. When someone DMs your bot, the plugin receives the message and forwards it to Claude. No URL to expose.
* **Webhooks** (CI, monitoring): your server listens on a local HTTP port. External systems POST to that port, and your server pushes the payload to Claude.

## What you need

The only hard requirement is the [`@modelcontextprotocol/sdk`](https://www.npmjs.com/package/@modelcontextprotocol/sdk) package and a Node.js-compatible runtime. Bun, Node, and Deno all work.

Your server needs to:
1. Declare the `claude/channel` capability so Claude Code registers a notification listener
2. Emit `notifications/claude/channel` events when something happens
3. Connect over stdio transport (Claude Code spawns your server as a subprocess)

During the research preview, custom channels aren't on the approved allowlist. Use `--dangerously-load-development-channels` to test locally.

## Example: build a webhook receiver

This walkthrough builds a single-file server that listens for HTTP requests and forwards them into your Claude Code session.

### Step 1: Create the project

```bash
mkdir webhook-channel && cd webhook-channel
bun add @modelcontextprotocol/sdk
```

### Step 2: Write the channel server

Create `webhook.ts`:

```ts
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

// Create the MCP server and declare it as a channel
const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: { experimental: { 'claude/channel': {} } },
    instructions: 'Events from the webhook channel arrive as <channel source="webhook" ...>. They are one-way: read them and act, no reply expected.',
  },
)

// Connect to Claude Code over stdio
await mcp.connect(new StdioServerTransport())

// Start an HTTP server that forwards every POST to Claude
Bun.serve({
  port: 8788,
  hostname: '127.0.0.1',
  async fetch(req) {
    const body = await req.text()
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: body,
        meta: { path: new URL(req.url).pathname, method: req.method },
      },
    })
    return new Response('ok')
  },
})
```

### Step 3: Register your server with Claude Code

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "webhook": { "command": "bun", "args": ["./webhook.ts"] }
  }
}
```

### Step 4: Test it

```bash
claude --dangerously-load-development-channels server:webhook
```

In a separate terminal:

```bash
curl -X POST localhost:8788 -d "build failed on main: https://ci.example.com/run/1234"
```

The payload arrives as:
```
<channel source="webhook" path="/" method="POST">build failed on main: https://ci.example.com/run/1234</channel>
```

**Troubleshooting:**
* **curl succeeds but nothing reaches Claude**: run `/mcp` to check server status. Check `~/.claude/debug/<session-id>.txt` for stderr.
* **curl fails with "connection refused"**: `lsof -i :<port>` to check what's listening.

## Test during the research preview

```bash
# Testing a plugin you're developing
claude --dangerously-load-development-channels plugin:yourplugin@yourmarketplace

# Testing a bare .mcp.json server
claude --dangerously-load-development-channels server:webhook
```

The bypass is per-entry. The `channelsEnabled` organization policy still applies.

## Server options

| Field | Type | Description |
|-------|------|-------------|
| `capabilities.experimental['claude/channel']` | `object` | Required. Always `{}`. Registers the notification listener. |
| `capabilities.experimental['claude/channel/permission']` | `object` | Optional. Always `{}`. Declares permission relay capability. |
| `capabilities.tools` | `object` | Two-way only. Always `{}`. Standard MCP tool capability. |
| `instructions` | `string` | Recommended. Added to Claude's system prompt. |

Example two-way setup:

```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'

const mcp = new Server(
  { name: 'your-channel', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: 'Messages arrive as <channel source="your-channel" ...>. Reply with the reply tool.',
  },
)
```

## Notification format

Your server emits `notifications/claude/channel` with two params:

| Field | Type | Description |
|-------|------|-------------|
| `content` | `string` | The event body. Delivered as the body of the `<channel>` tag. |
| `meta` | `Record<string, string>` | Optional. Each entry becomes a `<channel>` tag attribute. Keys must be identifiers (letters, digits, underscores only). |

Example:

```ts
await mcp.notification({
  method: 'notifications/claude/channel',
  params: {
    content: 'build failed on main: https://ci.example.com/run/1234',
    meta: { severity: 'high', run_id: '1234' },
  },
})
```

Arrives as:
```
<channel source="your-channel" severity="high" run_id="1234">
build failed on main: https://ci.example.com/run/1234
</channel>
```

## Expose a reply tool

For two-way channels, expose a standard MCP tool. Three components:

1. `tools: {}` in Server constructor capabilities
2. Tool handlers that define schema and implement send logic
3. `instructions` string telling Claude when/how to call the tool

### Register the reply tool

```ts
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back over this channel',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The conversation to reply in' },
        text: { type: 'string', description: 'The message to send' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    send(`Reply to ${chat_id}: ${text}`)
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})
```

### Full two-way webhook.ts with SSE outbound

```ts
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const listeners = new Set<(chunk: string) => void>()
function send(text: string) {
  const chunk = text.split('\n').map(l => `data: ${l}\n`).join('') + '\n'
  for (const emit of listeners) emit(chunk)
}

const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: 'Messages arrive as <channel source="webhook" chat_id="...">. Reply with the reply tool, passing the chat_id from the tag.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back over this channel',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The conversation to reply in' },
        text: { type: 'string', description: 'The message to send' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    send(`Reply to ${chat_id}: ${text}`)
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

await mcp.connect(new StdioServerTransport())

let nextId = 1
Bun.serve({
  port: 8788,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/events') {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(': connected\n\n')
          const emit = (chunk: string) => ctrl.enqueue(chunk)
          listeners.add(emit)
          req.signal.addEventListener('abort', () => listeners.delete(emit))
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      })
    }

    const body = await req.text()
    const chat_id = String(nextId++)
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: {
        content: body,
        meta: { chat_id, path: url.pathname, method: req.method },
      },
    })
    return new Response('ok')
  },
})
```

## Gate inbound messages

An ungated channel is a prompt injection vector. Check the sender against an allowlist before calling `mcp.notification()`:

```ts
const allowed = new Set(loadAllowlist())

if (!allowed.has(message.from.id)) {
  return  // drop silently
}
await mcp.notification({ ... })
```

Gate on the **sender's identity**, not the chat/room identity. In group chats, gating on the room would let anyone in an allowlisted group inject messages.

## Relay permission prompts

**Requires Claude Code v2.1.81+**

When Claude calls a tool that needs approval, a two-way channel can opt in to receive the same prompt in parallel. Both stay live: you can answer in the terminal or on your phone, whichever arrives first.

### How relay works

1. Claude Code generates a short request ID and notifies your server
2. Your server forwards the prompt and ID to your chat app
3. The remote user replies with yes or no and that ID
4. Your inbound handler parses the reply into a verdict; Claude Code applies it only if the ID matches

### Permission request fields

The outbound notification is `notifications/claude/channel/permission_request`:

| Field | Description |
|-------|-------------|
| `request_id` | Five lowercase letters (a-z without l). Include verbatim in your prompt. |
| `tool_name` | Name of the tool (e.g. `Bash`, `Write`). |
| `description` | Human-readable summary of the call. |
| `input_preview` | Tool args as JSON, truncated to 200 chars. |

The verdict is `notifications/claude/channel/permission` with `request_id` and `behavior` (`'allow'` or `'deny'`).

### Add relay to a chat bridge

1. **Declare the permission capability**:
   ```ts
   capabilities: {
     experimental: {
       'claude/channel': {},
       'claude/channel/permission': {},
     },
     tools: {},
   },
   ```

2. **Handle the incoming request**:
   ```ts
   import { z } from 'zod'

   const PermissionRequestSchema = z.object({
     method: z.literal('notifications/claude/channel/permission_request'),
     params: z.object({
       request_id: z.string(),
       tool_name: z.string(),
       description: z.string(),
       input_preview: z.string(),
     }),
   })

   mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
     send(
       `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
       `Reply "yes ${params.request_id}" or "no ${params.request_id}"`,
     )
   })
   ```

3. **Intercept the verdict in your inbound handler**:
   ```ts
   const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

   async function onInbound(message: PlatformMessage) {
     if (!allowed.has(message.from.id)) return

     const m = PERMISSION_REPLY_RE.exec(message.text)
     if (m) {
       await mcp.notification({
         method: 'notifications/claude/channel/permission',
         params: {
           request_id: m[2].toLowerCase(),
           behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
         },
       })
       return
     }

     await mcp.notification({
       method: 'notifications/claude/channel',
       params: { content: message.text, meta: { chat_id: String(message.chat.id) } },
     })
   }
   ```

### Full example with permission relay

```ts
#!/usr/bin/env bun
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const listeners = new Set<(chunk: string) => void>()
function send(text: string) {
  const chunk = text.split('\n').map(l => `data: ${l}\n`).join('') + '\n'
  for (const emit of listeners) emit(chunk)
}

const allowed = new Set(['dev'])

const mcp = new Server(
  { name: 'webhook', version: '0.0.1' },
  {
    capabilities: {
      experimental: {
        'claude/channel': {},
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="webhook" chat_id="...">. ' +
      'Reply with the reply tool, passing the chat_id from the tag.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: 'reply',
    description: 'Send a message back over this channel',
    inputSchema: {
      type: 'object',
      properties: {
        chat_id: { type: 'string', description: 'The conversation to reply in' },
        text: { type: 'string', description: 'The message to send' },
      },
      required: ['chat_id', 'text'],
    },
  }],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name === 'reply') {
    const { chat_id, text } = req.params.arguments as { chat_id: string; text: string }
    send(`Reply to ${chat_id}: ${text}`)
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  send(
    `Claude wants to run ${params.tool_name}: ${params.description}\n\n` +
    `Reply "yes ${params.request_id}" or "no ${params.request_id}"`,
  )
})

await mcp.connect(new StdioServerTransport())

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
let nextId = 1

Bun.serve({
  port: 8788,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)

    if (req.method === 'GET' && url.pathname === '/events') {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(': connected\n\n')
          const emit = (chunk: string) => ctrl.enqueue(chunk)
          listeners.add(emit)
          req.signal.addEventListener('abort', () => listeners.delete(emit))
        },
      })
      return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      })
    }

    const body = await req.text()
    const sender = req.headers.get('X-Sender') ?? ''
    if (!allowed.has(sender)) return new Response('forbidden', { status: 403 })

    const m = PERMISSION_REPLY_RE.exec(body)
    if (m) {
      await mcp.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: m[2].toLowerCase(),
          behavior: m[1].toLowerCase().startsWith('y') ? 'allow' : 'deny',
        },
      })
      return new Response('verdict recorded')
    }

    const chat_id = String(nextId++)
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: body, meta: { chat_id, path: url.pathname } },
    })
    return new Response('ok')
  },
})
```

## Package as a plugin

To make your channel installable, wrap it in a plugin and publish to a marketplace. Users install with `/plugin install`, then enable with `--channels plugin:<name>@<marketplace>`.

A channel in your own marketplace still needs `--dangerously-load-development-channels` unless it's on the approved allowlist. To get it added, submit to the official marketplace. On Team/Enterprise, admins can include your plugin in `allowedChannelPlugins`.

## See also

* Channels guide (channels-guide.md) for setup of Telegram, Discord, iMessage, and fakechat
* [Working channel implementations](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins)
* MCP for the underlying protocol
* Plugins to package your channel
