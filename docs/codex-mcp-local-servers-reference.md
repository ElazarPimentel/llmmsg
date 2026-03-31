# Codex MCP Local Servers Reference

Compiled on 2026-03-30 from official OpenAI Codex documentation, with one supplemental check against the local `codex mcp --help` output on this machine.

## Primary takeaways

- Codex supports two MCP connection modes: local `stdio` servers started by a command, and streamable HTTP servers addressed by URL.
- For local development tools, `stdio` is the clean default. This is an inference from the Codex docs plus current CLI shape: local servers map directly to `command` + `args` + `env`, avoid extra networking, and work in both the Codex CLI and IDE extension.
- Codex MCP config is shared between the CLI and IDE extension through `~/.codex/config.toml`, or a project-scoped `.codex/config.toml` in trusted projects.
- Codex can be guided to use a server more reliably through `AGENTS.md`; OpenAI explicitly recommends that pattern for Docs MCP.

## Official Codex MCP configuration

CLI form for a local server:

```bash
codex mcp add <server-name> --env KEY=VALUE -- <server-command> ...
```

`config.toml` form:

```toml
[mcp_servers.my_server]
command = "node"
args = ["/absolute/path/to/server.mjs"]
cwd = "/absolute/path/to/project"

[mcp_servers.my_server.env]
MY_ENV_VAR = "value"
```

Useful per-server options from the Codex docs:

- `env_vars`: forward selected host env vars
- `startup_timeout_sec`: default `10`
- `tool_timeout_sec`: default `60`
- `enabled_tools` / `disabled_tools`: narrow the tool surface
- `enabled = false`: disable without deleting config
- `required = true`: fail startup if the server is mandatory

## What makes a local MCP server work well with Codex

- Keep the server name short and descriptive. OpenAI calls this out directly for MCP server selection.
- Expose only the tools the model should actually see. Use `enabled_tools` or split broad servers into smaller ones if selection quality suffers.
- Make startup cheap. If the server needs a slow warmup, raise `startup_timeout_sec` explicitly.
- Keep individual tool calls predictable. If a tool may exceed one minute, raise `tool_timeout_sec` and document why.
- Set `cwd`, `env`, and `env_vars` deliberately instead of relying on ambient shell state.
- Put usage guidance in `AGENTS.md`. Codex auto-loads `AGENTS.md` from the repo root downward; files closer to the working directory override broader rules.

## Repo-specific example

This repository already contains a local MCP server entrypoint at `llmmsg-channel/channel.mjs`. An adapted Codex config would look like:

```toml
[mcp_servers.llmmsg]
command = "node"
args = ["/opt/llmmsg/llmmsg-channel/channel.mjs"]
cwd = "/opt/llmmsg"
startup_timeout_sec = 10
tool_timeout_sec = 60

[mcp_servers.llmmsg.env]
LLMMSG_HUB_PORT = "9701"
LLMMSG_CWD = "/opt/llmmsg"
```

That example is adapted from the official Codex MCP config pattern. In this repo, the server also depends on the SQLite-backed hub being available, typically via:

```bash
node /opt/llmmsg/llmmsg-channel/hub.mjs
```

## AGENTS.md note

Docs in `docs/` are useful reference material, but Codex does not automatically load them as instructions. Codex does automatically load `AGENTS.md`. If you want the model to consult this reference when working on MCP code, add a short rule in the repo root `AGENTS.md` pointing here.

## Official sources

- Codex MCP: https://developers.openai.com/codex/mcp
- Codex config reference: https://developers.openai.com/codex/config-reference
- Codex AGENTS.md guide: https://developers.openai.com/codex/guides/agents-md
- OpenAI Docs MCP: https://developers.openai.com/learn/docs-mcp
