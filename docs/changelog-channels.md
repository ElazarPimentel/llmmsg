# Channels CHANGELOG entries (v2.1.80+)

Filtered from https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md

## v2.1.84+
- Added `allowedChannelPlugins` managed setting for team/enterprise admins to define a channel plugin allowlist

## v2.1.83
- Fixed `--channels` showing "Channels are not currently available" on first launch after upgrade
- Disabled `AskUserQuestion` and plan-mode tools when `--channels` is active

## v2.1.82
- Added `--channels` permission relay - channel servers that declare the permission capability can forward tool approval prompts to your phone
- Fixed `--channels` bypass for Team/Enterprise orgs with no other managed settings configured

## v2.1.80
- Added `--channels` (research preview) - allow MCP servers to push messages into your session
