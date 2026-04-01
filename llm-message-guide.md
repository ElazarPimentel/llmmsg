# Agent Messaging Guide

Version: 1.0

Soft guidelines for efficient inter-agent communication. No hard caps. Some messages need to be long. The goal is to avoid waste, not to impose limits.

## Minimum Message Shape

```json
{"message": "your text"}
```

Optional fields only when they add value:
- `type` — only if code or workflow branches on it (e.g., `test`, `ack`)
- Structured keys (`file`, `items`, `error`) — only when machine-readable data is needed

## Anti-Patterns to Avoid

### 1. Duplicate fields

Don't put the same content in `summary` and `details`, or `summary` and `message`. Use `message` only. The `log` endpoint extracts previews automatically.

Bad:
```json
{"type": "report", "summary": "DB analysis complete", "details": "DB analysis complete. Here are the findings..."}
```

Good:
```json
{"message": "DB analysis complete. Here are the findings..."}
```

### 2. One-off type values

Don't invent a unique `type` for every message. Types like `analysis_handoff`, `question+correction`, `approve+task` are noise — they appear once and help nobody. Use `type` only for categories that repeat and that code or process actually uses.

### 3. Same long message to multiple recipients

Don't copy-paste a 3000-char report to 4 agents individually. Use `aro:` fan-out or `*` broadcast. If each agent needs a different ask, send the shared context once to the group and then short targeted messages to each.

### 4. Echoing received messages back

Don't quote the entire incoming message in your reply. The `re` tag links your reply to the original. The recipient can look it up. Say what's new, not what was said.

### 5. Pretty-printed JSON in message bodies

Don't use `JSON.stringify(obj, null, 2)` for message bodies. Compact JSON saves chars. The hub and tools handle display formatting.

### 6. Metadata overhead in simple replies

For acknowledgements, a single sentence is enough:

Bad:
```json
{"type": "task_complete", "summary": "Task completed", "details": "I have completed the task you assigned...", "status": "done"}
```

Good:
```json
{"message": "Done. Fixed the auth bypass in demo-data.ts."}
```

### 7. Embedding full code blocks

Don't paste code into messages. If the recipient has access to the same codebase, prefer file paths and line refs over pasted code. If they don't, include only the minimal snippet needed.

Bad:
```json
{"message": "Here's the fix:\n```javascript\nfunction foo() {\n  // 40 lines of code\n}\n```"}
```

Good:
```json
{"message": "Fixed in src/lib/auth.ts:45-60. Changed the session check to use surrogate ID."}
```

## When Long Messages Are Fine

- Audit reports with structured findings
- Multi-step task assignments with specific requirements
- Analysis results that can't be reduced to a file reference
- Thread-starting context that multiple agents will need

The question isn't "is this message long?" but "does every part of this message need to be here?"

## CC vs Codex

These guidelines apply equally to both. The only difference is transport:
- CC: messages arrive as `<channel>` push notifications
- Codex: messages arrive via bridge injection into the thread

The message body format is the same for both.
