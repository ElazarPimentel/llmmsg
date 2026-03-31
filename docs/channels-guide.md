# Push events into a running session with channels

> Use channels to push messages, alerts, and webhooks into your Claude Code session from an MCP server. Forward CI results, chat messages, and monitoring events so Claude can react while you're away.

**Note:** Channels are in research preview and require Claude Code v2.1.80 or later. They require claude.ai login. Console and API key authentication is not supported. Team and Enterprise organizations must explicitly enable them.

A channel is an MCP server that pushes events into your running Claude Code session, so Claude can react to things that happen while you're not at the terminal. Channels can be two-way: Claude reads the event and replies back through the same channel, like a chat bridge. Events only arrive while the session is open, so for an always-on setup you run Claude in a background process or persistent terminal.

Unlike integrations that spawn a fresh cloud session or wait to be polled, the event arrives in the session you already have open.

You install a channel as a plugin and configure it with your own credentials. Telegram, Discord, and iMessage are included in the research preview.

When Claude replies through a channel, you see the inbound message in your terminal but not the reply text. The terminal shows the tool call and a confirmation (like "sent"), and the actual reply appears on the other platform.

This page covers:

* Supported channels: Telegram, Discord, and iMessage setup
* Install and run a channel with fakechat, a localhost demo
* Who can push messages: sender allowlists and how you pair
* Enable channels for your organization on Team and Enterprise
* How channels compare to web sessions, Slack, MCP, and Remote Control

To build your own channel, see the Channels reference.

## Supported channels

Each supported channel is a plugin that requires [Bun](https://bun.sh). For a hands-on demo of the plugin flow before connecting a real platform, try the fakechat quickstart.

### Telegram

View the full [Telegram plugin source](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram).

1. **Create a Telegram bot**: Open [BotFather](https://t.me/BotFather) in Telegram and send `/newbot`. Give it a display name and a unique username ending in `bot`. Copy the token BotFather returns.

2. **Install the plugin**: In Claude Code, run:
   ```
   /plugin install telegram@claude-plugins-official
   ```
   If not found, run `/plugin marketplace update claude-plugins-official` to refresh, or `/plugin marketplace add anthropics/claude-plugins-official` if you haven't added it before. Then retry. After installing, run `/reload-plugins` to activate the configure command.

3. **Configure your token**:
   ```
   /telegram:configure <token>
   ```
   This saves it to `~/.claude/channels/telegram/.env`. You can also set `TELEGRAM_BOT_TOKEN` in your shell environment before launching Claude Code.

4. **Restart with channels enabled**:
   ```bash
   claude --channels plugin:telegram@claude-plugins-official
   ```

5. **Pair your account**: Open Telegram and send any message to your bot. The bot replies with a pairing code. (If your bot doesn't respond, make sure Claude Code is running with `--channels` from the previous step.)

   Back in Claude Code, run:
   ```
   /telegram:access pair <code>
   ```
   Then lock down access:
   ```
   /telegram:access policy allowlist
   ```

### Discord

View the full [Discord plugin source](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord).

1. **Create a Discord bot**: Go to the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**, and name it. In the **Bot** section, create a username, then click **Reset Token** and copy the token.

2. **Enable Message Content Intent**: In your bot's settings, scroll to **Privileged Gateway Intents** and enable **Message Content Intent**.

3. **Invite the bot to your server**: Go to **OAuth2 > URL Generator**. Select the `bot` scope and enable these permissions:
   * View Channels
   * Send Messages
   * Send Messages in Threads
   * Read Message History
   * Attach Files
   * Add Reactions

   Open the generated URL to add the bot to your server.

4. **Install the plugin**:
   ```
   /plugin install discord@claude-plugins-official
   ```
   If not found, refresh marketplace as above. After installing, run `/reload-plugins`.

5. **Configure your token**:
   ```
   /discord:configure <token>
   ```
   Saves to `~/.claude/channels/discord/.env`. You can also set `DISCORD_BOT_TOKEN` in your shell environment.

6. **Restart with channels enabled**:
   ```bash
   claude --channels plugin:discord@claude-plugins-official
   ```

7. **Pair your account**: DM your bot on Discord. The bot replies with a pairing code. Back in Claude Code:
   ```
   /discord:access pair <code>
   ```
   Then lock down access:
   ```
   /discord:access policy allowlist
   ```

### iMessage

View the full [iMessage plugin source](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/imessage).

The iMessage channel reads your Messages database directly and sends replies through AppleScript. It requires macOS and needs no bot token or external service.

1. **Grant Full Disk Access**: The Messages database at `~/Library/Messages/chat.db` is protected by macOS. The first time the server reads it, macOS prompts for access: click **Allow**. Grant access manually under **System Settings > Privacy & Security > Full Disk Access** if needed.

2. **Install the plugin**:
   ```
   /plugin install imessage@claude-plugins-official
   ```
   If not found, refresh marketplace as above.

3. **Restart with channels enabled**:
   ```bash
   claude --channels plugin:imessage@claude-plugins-official
   ```

4. **Text yourself**: Open Messages on any device signed into your Apple ID and send a message to yourself. Self-chat bypasses access control with no setup. (The first reply triggers a macOS Automation prompt - click **OK**.)

5. **Allow other senders**:
   ```
   /imessage:access allow +15551234567
   ```
   Handles are phone numbers in `+country` format or Apple ID emails.

You can also build your own channel for systems that don't have a plugin yet.

## Quickstart (fakechat)

Fakechat is an officially supported demo channel that runs a chat UI on localhost, with nothing to authenticate and no external service to configure.

Requirements:
* Claude Code installed and authenticated with a claude.ai account
* [Bun](https://bun.sh) installed
* **Team/Enterprise users**: your organization admin must enable channels in managed settings

1. **Install the fakechat channel plugin**:
   ```
   /plugin install fakechat@claude-plugins-official
   ```
   If not found, refresh marketplace as above.

2. **Restart with the channel enabled**:
   ```bash
   claude --channels plugin:fakechat@claude-plugins-official
   ```
   You can pass several plugins to `--channels`, space-separated.

3. **Push a message in**: Open the fakechat UI at http://localhost:8787 and type a message:
   ```
   hey, what's in my working directory?
   ```
   The message arrives as a `<channel source="fakechat">` event. Claude reads it, does the work, and calls fakechat's `reply` tool.

If Claude hits a permission prompt while you're away, the session pauses. Channel servers that declare the permission relay capability can forward these prompts to you so you can approve or deny remotely. For unattended use, `--dangerously-skip-permissions` bypasses prompts entirely, but only use it in environments you trust.

## Security

Every approved channel plugin maintains a sender allowlist: only IDs you've added can push messages, and everyone else is silently dropped.

Telegram and Discord bootstrap the list by pairing:
1. Find your bot in Telegram or Discord and send it any message
2. The bot replies with a pairing code
3. In your Claude Code session, approve the code when prompted
4. Your sender ID is added to the allowlist

iMessage works differently: texting yourself bypasses the gate automatically, and you add other contacts by handle.

Being in `.mcp.json` isn't enough to push messages: a server also has to be named in `--channels`.

The allowlist also gates permission relay. Anyone who can reply through the channel can approve or deny tool use in your session, so only allowlist senders you trust with that authority.

## Enterprise controls

On Team and Enterprise plans, channels are off by default. Admins control availability through two managed settings that users cannot override:

| Setting | Purpose | When not configured |
|---------|---------|---------------------|
| `channelsEnabled` | Master switch. Must be `true` for any channel to deliver messages. | Channels blocked |
| `allowedChannelPlugins` | Which plugins can register once channels are enabled. Replaces the Anthropic-maintained list when set. | Anthropic default list applies |

Pro and Max users without an organization skip these checks: channels are available and users opt in per session with `--channels`.

### Enable channels for your organization

Admins can enable from **claude.ai > Admin settings > Claude Code > Channels**, or by setting `channelsEnabled` to `true` in managed settings.

### Restrict which channel plugins can run

Admins can replace the default allowlist with their own by setting `allowedChannelPlugins`:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "claude-plugins-official", "plugin": "telegram" },
    { "marketplace": "claude-plugins-official", "plugin": "discord" },
    { "marketplace": "acme-corp-plugins", "plugin": "internal-alerts" }
  ]
}
```

When set, it replaces the Anthropic allowlist entirely. Leave unset to fall back to the default. An empty array blocks all channel plugins from the allowlist, but `--dangerously-load-development-channels` can still bypass it for local testing.

## Research preview

Channels are a research preview feature. Availability is rolling out gradually, and the `--channels` flag syntax and protocol contract may change.

During the preview, `--channels` only accepts plugins from an Anthropic-maintained allowlist, or from your organization's allowlist. The channel plugins in [claude-plugins-official](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins) are the default approved set.

To test a channel you're building, use `--dangerously-load-development-channels`.

## How channels compare

| Feature | What it does | Good for |
|---------|-------------|----------|
| Claude Code on the web | Runs tasks in a fresh cloud sandbox, cloned from GitHub | Delegating self-contained async work |
| Claude in Slack | Spawns a web session from an `@Claude` mention | Starting tasks from team conversation context |
| Standard MCP server | Claude queries it during a task; nothing is pushed | Giving Claude on-demand access to read/query a system |
| Remote Control | You drive your local session from claude.ai or mobile app | Steering an in-progress session while away |

Channels fill the gap by pushing events from non-Claude sources into your already-running local session:
* **Chat bridge**: ask Claude from your phone via Telegram/Discord/iMessage
* **Webhook receiver**: CI, error tracker, deploy pipeline events arrive where Claude already has your files open

## Next steps

* Build your own channel (see channels-reference.md)
* Remote Control to drive a local session from your phone
* Scheduled tasks to poll on a timer instead of reacting to pushed events
