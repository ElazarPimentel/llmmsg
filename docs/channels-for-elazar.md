# Channels vs llmmsg.sh - Migration Analysis

Reference for evaluating whether CC Channels can replace llmmsg.sh as the inter-agent messaging system.

## What llmmsg.sh does today

- **Centralized SQLite DB** at `~/Documents/work/llmmsg/llmmsg.sqlite`
- **Polling**: each session runs `/loop Nm llmmsg.sh read <agent>` to check for messages
- **Roster**: agents register with name + cwd, discoverable via `llmmsg.sh roster`
- **Addressing**: point-to-point (`to:agent`) or broadcast (`to:*`)
- **Threading**: `re:<tag>` replies, `llmmsg.sh thread <tag>` to view chains
- **History**: `llmmsg.sh log`, `llmmsg.sh search <text>` - messages persist forever
- **Cursor-based reads**: each agent tracks its last-read ID, never sees the same message twice
- **No dependencies beyond bash + python3 + sqlite3** (all pre-installed on Linux/macOS)

## What channels are

- An MCP server that **pushes** events into a running CC session (no polling)
- CC spawns the channel server as a subprocess, communicates over stdio
- Events arrive as `<channel source="name" key="val">body</channel>` tags in the session
- Two-way: channel can expose a `reply` tool so Claude can send messages back
- Each session gets its own channel server instance

## What channels solve that llmmsg.sh can't

1. **Push-based delivery** - no polling, no `/loop`, no terminal flooding, no wasted tokens on empty checks
2. **Native CC integration** - events arrive as first-class session events, not Bash tool output
3. **Permission relay** - forward tool approval prompts to your phone (v2.1.81+)
4. **No context cost for empty checks** - if nothing happens, nothing renders

## What channels DON'T provide (llmmsg.sh features with no channel equivalent)

1. **Persistent message store** - channel events are ephemeral. If the session isn't running, the message is lost. No history, no `log`, no `search`.
2. **Offline queue** - llmmsg.sh stores messages even if the recipient isn't running. Channels can't deliver to a closed session.
3. **Threading** - no `re:` tag system, no `thread` command. Each event is standalone.
4. **Broadcast** - no built-in `to:*`. Each channel server is per-session. To broadcast, a hub would need to know all connected sessions.
5. **Roster/discovery** - no equivalent to `llmmsg.sh roster`. No way for one session to discover what other sessions exist.
6. **Message search** - no `llmmsg.sh search`. Events disappear after the session processes them.
7. **Cursor-based reads** - not applicable (push model), but also means no way to re-read old messages.

## Architecture for a channels-based replacement

To replicate llmmsg.sh functionality, you'd build a **hub-and-spoke** system:

```
                    ┌─────────────┐
   session A ◄────►│             │◄────► session C
   (channel)       │  Hub Server  │      (channel)
   session B ◄────►│  (HTTP+SQLite)│◄────► session D
   (channel)       └─────────────┘
```

### The hub server (one process, always running)

- HTTP server on localhost (like the webhook example, but persistent)
- SQLite DB for message persistence, threading, roster, cursors
- Each CC session connects via its channel MCP server subprocess
- Channel server subprocess connects to the hub via HTTP/WebSocket
- Hub pushes messages to connected sessions, queues for disconnected ones
- Replaces: `llmmsg.sh init`, message storage, roster, cursors

### The channel plugin (one per CC session)

- MCP server spawned by CC as subprocess
- Connects to the hub on startup, registers agent name
- Receives pushed messages from hub, emits as `notifications/claude/channel`
- Exposes `send` tool so Claude can send messages back through the hub
- Replaces: `llmmsg.sh register`, `llmmsg.sh read`, `llmmsg.sh send`

### What the hub handles

| llmmsg.sh feature | Hub equivalent |
|---|---|
| `register <agent> <cwd>` | Channel plugin registers on connect |
| `send from:X to:Y body` | Claude calls `send` tool → hub routes to Y's channel |
| `read <agent>` | Hub pushes to agent's channel automatically |
| `to:*` broadcast | Hub iterates all connected channels |
| `roster` | Hub tracks connected agents |
| `thread <tag>` | Hub stores messages with tags, supports query |
| `search <text>` | Hub provides search via tool |
| `log [N]` | Hub provides log via tool |
| Offline queue | Hub stores messages, delivers when agent reconnects |

## Blockers and risks

### Hard blockers (as of 2026-03-29)

1. **Research preview** - the `--channels` flag syntax and protocol may change. Building on it now risks breaking changes.
2. **`--dangerously-load-development-channels`** required for custom channels. They're not on the approved allowlist. Every session must start with this flag.
3. **`--channels` must be specified at startup** - can't add a channel to a running session.
4. **AskUserQuestion disabled when `--channels` is active** (v2.1.83 changelog). This may break workflows that rely on Claude asking the user questions.
5. **Requires claude.ai login** - Console and API key auth not supported.

### Soft concerns

6. **Bun/Node dependency** - llmmsg.sh needs only bash+python3+sqlite3. The channel system adds Bun or Node + `@modelcontextprotocol/sdk` as dependencies.
7. **Hub server must run persistently** - llmmsg.sh needs no daemon. The hub is a new always-on process to manage.
8. **Complexity increase** - llmmsg.sh is a single 500-line bash script. The channel replacement is: hub server (TypeScript) + channel plugin (TypeScript) + SQLite DB + MCP SDK.
9. **Debugging** - llmmsg.sh errors are visible in stderr. Channel errors go to `~/.claude/debug/<session-id>.txt`.
10. **Port management** - hub needs a fixed localhost port. Multiple users or environments could collide.

## Minimum viable migration

If you wanted to start despite the blockers:

1. **Keep llmmsg.sh SQLite DB** as the persistent store (proven, works)
2. **Build a thin hub** in TypeScript/Bun that wraps the existing DB with HTTP endpoints
3. **Build a channel plugin** that connects to the hub and exposes `send`/`read` tools
4. **Start sessions with**: `claude --dangerously-load-development-channels server:llmmsg-channel`
5. **Fallback**: keep `llmmsg.sh` CLI working for sessions that don't use channels

## Recommendation

**Wait.** The biggest value of channels (push-based, no polling) is real, but:
- Research preview means the API will change
- `--dangerously-load-development-channels` on every session is ugly
- AskUserQuestion being disabled is a real functional loss
- The hub server adds operational complexity llmmsg.sh doesn't have
- llmmsg.sh works reliably today; the terminal flooding is the only pain point, and that's a CC `/loop` issue, not a messaging issue

**Revisit when:**
- Channels exit research preview
- Custom channels can run without `--dangerously-load-development-channels`
- AskUserQuestion works alongside channels
- Or if Anthropic ships a built-in inter-session messaging channel

## Quick reference: key technical details

### Starting a session with channels
```bash
claude --channels plugin:name@marketplace              # approved plugin
claude --dangerously-load-development-channels server:name  # custom channel
```

### Channel notification format (what arrives in session)
```xml
<channel source="server-name" key1="val1" key2="val2">message body</channel>
```

### Minimal channel server (TypeScript/Bun)
```ts
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const mcp = new Server(
  { name: 'llmmsg-channel', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions: 'Messages from other agents arrive as <channel source="llmmsg-channel" from="agent" tag="tag">. Reply with the send tool.',
  },
)
// + reply tool handlers, hub connection, stdio connect, etc.
```

### MCP config entry (.mcp.json)
```json
{
  "mcpServers": {
    "llmmsg-channel": { "command": "bun", "args": ["path/to/channel.ts"] }
  }
}
```

### Debug logs
```
~/.claude/debug/<session-id>.txt
```
