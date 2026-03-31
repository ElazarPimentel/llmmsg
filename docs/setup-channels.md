# Setup - Channels-related settings

Extracted from https://code.claude.com/docs/en/setup

## Auto-update channel

Control which release channel Claude Code follows with the `autoUpdatesChannel` setting:

* `"latest"` (default): receive new features as soon as released
* `"stable"`: use a version ~one week old, skipping releases with major regressions

Configure via `/config` > **Auto-update channel**, or in settings.json:

```json
{
  "autoUpdatesChannel": "stable"
}
```

For enterprise deployments, enforce a consistent release channel via managed settings.

## Disable auto-updates

Set in settings.json:

```json
{
  "env": {
    "DISABLE_AUTOUPDATER": "1"
  }
}
```

## Manual update

```bash
claude update
```

## Install a specific version

The native installer accepts a specific version number or a release channel (`latest` or `stable`):

```bash
# Latest (default)
curl -fsSL https://claude.ai/install.sh | bash

# Stable
curl -fsSL https://claude.ai/install.sh | bash -s stable

# Specific version
curl -fsSL https://claude.ai/install.sh | bash -s 1.0.58
```

**Note:** The channel you choose at install time becomes your default for auto-updates.
