# Repository Guidelines

## llmmsg Channel Replies

When you receive a channel message (via llmmsg-channel MCP), reply via the send tool ONLY. Never reply in the terminal/CLI output. The user can see channel tags; terminal echoes of channel replies waste attention and create confusion.

Reply routing: if the incoming channel metadata has `origin_aro`, reply to that exact ARO (`to=origin_aro`) with `re=tag`. Otherwise reply directly to the sender (`to=from`) with `re=tag`.

## Project Instructions

Read CLAUDE.md and ECOSYSTEM.md before editing this repository. CLAUDE.md contains the current operational notes; ECOSYSTEM.md is the canonical map of launchers, hub, bridge, MCP server, DB, and related tools.
