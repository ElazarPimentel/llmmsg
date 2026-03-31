# GITPUSH_INFO_VERSION=3.4
#!/bin/bash
# Pre-push checks for llmmsg
# Syntax-check the main Node.js files
node --check llmmsg-channel/hub.mjs && node --check llmmsg-channel/channel.mjs && node --check codex-llmmsg-app/bridge.mjs && node --check codex-llmmsg-app/rpc-client.mjs
