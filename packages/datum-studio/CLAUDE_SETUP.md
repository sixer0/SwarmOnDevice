# Connect Claude Code to DATUM Studio

## What this is

DATUM Studio runs inside the Swarm app. Claude Code does not run its own copy.
It reaches the Studio that Swarm hosts through a small command,
`$HOME/.local/bin/datum-studio`, which Swarm installs for you. Claude Code starts
that command as a local (stdio) MCP server named `datum-studio`, and the command
forwards each request to the running Swarm app on this Mac.

## Before you start

1. Swarm 1.2.0 is installed and running.
2. Install the command from the Swarm app menu:
   **Swarm > Install DATUM Studio for Claude...**
   Confirm the dialog. Swarm writes `$HOME/.local/bin/datum-studio` and changes
   no Claude settings.

## Add it to Claude Code

Run this one line in Terminal:

```sh
claude mcp add datum-studio -- "$HOME/.local/bin/datum-studio"
```

- Your shell replaces `$HOME` with your home folder, so Claude Code stores the
  full path. The done dialog in Swarm shows the same line with that path already
  filled in.
- Everything after `--` is the command Claude Code runs. The command takes no
  arguments.
- Without `--scope`, the server is added at local scope: only for the project
  folder you run the line in. Add `--scope user` before `datum-studio` to make it
  available in every project:
  `claude mcp add --scope user datum-studio -- "$HOME/.local/bin/datum-studio"`

## Check it

```sh
claude mcp list
```

`datum-studio` should be listed as connected while Swarm is open. Inside a
Claude Code session, `/mcp` shows the same status and lets you reconnect.

## When it does not connect

The command exits with a code and prints one line that says what to do.

| Exit code | Message | What it means |
|---|---|---|
| 3 | DATUM Studio runs inside the Swarm app. Start Swarm, then reconnect this MCP server (Claude Code: /mcp). | Swarm is not running, quit during the session, or did not get Studio ready within about 15 seconds after it started. Start Swarm, wait for it to open, then reconnect with `/mcp`. |
| 4 | DATUM Studio is not bundled with this app. Reinstall Swarm. | The Swarm app on this Mac is incomplete or was moved. Reinstall Swarm, then run the menu item again. |

## Nothing to configure

- You do not need a token, a port number, an API key or a config file.
- Each time Swarm starts it creates a new private access token on its own; the
  `datum-studio` command reads it at connect time. It never appears in Claude's
  settings, on the command line or in your shell history.
- Revisions Claude makes in the Studio are recorded with the agent id `claude`.

## Remove it

```sh
claude mcp remove datum-studio
```

This removes the Claude Code entry only. The `$HOME/.local/bin/datum-studio`
command stays until you delete it yourself.
