#!/bin/sh
# The datum-studio MCP command shipped inside Swarm.app (row 34; Studio spec §9.3; U13: Studio runs only inside Swarm).
# Staged as <Res>/datum-studio/datum-studio-launcher (row 36). Two callers run it:
#   ~/.local/bin/datum-studio (Install DATUM Studio for Claude): SWARM_APP_STATE_HOME set, STUDIO_AGENT_ID=claude;
#   Swarm's built-in MCP entry (row 33): XDG_STATE_HOME from the sidecar env, STUDIO_AGENT_ID=swarm.
# It starts <Res>/datum-studio/server/datum-studio-bridge.js on the bundled Bun (<Res>/swarm-cli/swarm, BUN_BE_BUN=1),
# a stdio <-> streamable-HTTP pipe to the endpoint the running app hosts on 127.0.0.1. The token is never read, echoed
# or exported here: the bridge reads it from the app's 0600 descriptor <state>/swarm/datum-studio.env.
# Exit 3: Swarm is not running (spec §9.5), or it is running but its Studio did not come up within 15 s (row 34b).
# Exit 4: this bundle is incomplete.
self=$(/usr/bin/readlink -f "$0")
dir=$(/usr/bin/dirname "$self")
runtime="$dir/../swarm-cli/swarm"
bridge="$dir/server/datum-studio-bridge.js"
not_running='DATUM Studio runs inside the Swarm app. Start Swarm, then reconnect this MCP server (Claude Code: /mcp).'

if [ ! -x "$runtime" ] || [ ! -f "$bridge" ]; then
  printf '%s\n' 'DATUM Studio is not bundled with this app. Reinstall Swarm.' >&2
  exit 4
fi

state=${SWARM_APP_STATE_HOME:-${XDG_STATE_HOME:-}}
descriptor="$state/swarm/datum-studio.env"

# The same check as swarm-launcher.sh: a PID counts only while it is a running Swarm app.
is_swarm() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
  case "$(/bin/ps -p "$1" -o comm= 2>/dev/null)" in
    */Contents/MacOS/Swarm) return 0 ;;
  esac
  return 1
}

# PID= of a descriptor file. Only that line is extracted: the TOKEN (datum-studio.env) and PASSWORD (app-server.env)
# lines never enter this shell.
pid_of() {
  [ -n "$state" ] && [ -f "$1" ] && [ -r "$1" ] && /usr/bin/sed -n 's/^PID=//p' "$1" 2>/dev/null
}

# Row 34b (C64): Swarm is up but its Studio host has not written datum-studio.env yet. That is the normal case when
# Swarm's own sidecar starts this built-in MCP entry while the app is still starting. Evidence that Swarm is alive:
# the app-server.env PID of the same state directory, or a running Swarm among this launcher's nearest ancestors
# (sidecar -> Swarm). Without that evidence nothing waits: exit 3 at once, as before.
swarm_alive() {
  [ -n "$state" ] || return 1
  is_swarm "$(pid_of "$state/swarm/app-server.env")" && return 0
  p=$PPID
  for i in 1 2 3 4; do
    case "$p" in
      '' | *[!0-9]* | 0 | 1) return 1 ;;
    esac
    is_swarm "$p" && return 0
    p=$(/bin/ps -p "$p" -o ppid= 2>/dev/null | /usr/bin/tr -d ' ')
  done
  return 1
}

# Bounded wait: polls every 0.2 s for at most 15 s (wall clock) while Swarm stays alive, then exit 3, same message.
deadline=$(($(/bin/date +%s) + 15))
until is_swarm "$(pid_of "$descriptor")"; do
  if [ "$(/bin/date +%s)" -ge "$deadline" ] || ! swarm_alive; then
    printf '%s\n' "$not_running" >&2
    exit 3
  fi
  /bin/sleep 0.2
done

# The caller's directory travels as data (X-Studio-Caller-Cwd, the session's file root, spec §9.4); the bridge itself
# runs from the signed server folder so plain Bun finds no bunfig.toml or .env of the caller (spec §9.2 note for row 48).
caller=$(/bin/pwd -P 2>/dev/null) || caller=$PWD
DATUM_STUDIO_STATE=$state
DATUM_STUDIO_CALLER_CWD=$caller
STUDIO_AGENT_ID=${STUDIO_AGENT_ID:-claude}
BUN_BE_BUN=1
export DATUM_STUDIO_STATE DATUM_STUDIO_CALLER_CWD STUDIO_AGENT_ID BUN_BE_BUN
# The endpoint is loopback only: a proxy from the caller's environment must never see the Bearer token.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy
cd "$dir/server" || exit 4
exec "$runtime" ./datum-studio-bridge.js
