#!/bin/sh
# The swarm command shipped inside Swarm.app (C120): the same engine, version, settings and state as the app.
# ~/.local/bin/swarm (written by Install Command Line Tool) runs this file with SWARM_APP_STATE_HOME set to the state
# directory the app's server uses. Staged next to the CLI binary by scripts/stage-cli.ts.
self=$(/usr/bin/readlink -f "$0")
dir=$(/usr/bin/dirname "$self")
cli="$dir/swarm"

# The environment the app gives its server (server.ts preferAppEnv, sidecar.ts prepareSidecarEnv).
if [ -n "${SWARM_APP_STATE_HOME:-}" ]; then
  XDG_STATE_HOME=$SWARM_APP_STATE_HOME
  export XDG_STATE_HOME
fi
OPENCODE_EXPERIMENTAL_ICON_DISCOVERY=true
OPENCODE_EXPERIMENTAL_FILEWATCHER=true
export OPENCODE_EXPERIMENTAL_ICON_DISCOVERY OPENCODE_EXPERIMENTAL_FILEWATCHER
if [ -z "${SWARM_BUNDLED_PROVIDER:-}" ] && [ -f "$dir/bundled-provider.json" ]; then
  SWARM_BUNDLED_PROVIDER=$(/bin/cat "$dir/bundled-provider.json")
  export SWARM_BUNDLED_PROVIDER
fi

# While the app is open, `swarm run` goes through the app's own server (app-server-file.ts), so the run uses the
# app's autonomy rules and approvals and shows up in its Activity. --attach or a stale descriptor skips this.
server="${XDG_STATE_HOME:-}/swarm/app-server.env"
if [ "${1:-}" = run ] && [ -n "${XDG_STATE_HOME:-}" ] && [ -f "$server" ]; then
  attach=yes
  hasdir=no
  for arg in "$@"; do
    case "$arg" in
      --attach | --attach=*) attach=no ;;
      --dir | --dir=*) hasdir=yes ;;
    esac
  done
  url=
  user=
  pass=
  pid=
  if [ "$attach" = yes ]; then
    while IFS='=' read -r key value; do
      case "$key" in
        URL) url=$value ;;
        USERNAME) user=$value ;;
        PASSWORD) pass=$value ;;
        PID) pid=$value ;;
      esac
    done <"$server"
  fi
  case "$pid" in
    '' | *[!0-9]*) pid= ;;
  esac
  if [ -n "$url" ] && [ -n "$pass" ] && [ -n "$pid" ]; then
    case "$(/bin/ps -p "$pid" -o comm= 2>/dev/null)" in
      */Contents/MacOS/Swarm)
        shift
        # The password travels in the environment, never in argv where other processes could read it.
        SWARM_SERVER_USERNAME=$user
        SWARM_SERVER_PASSWORD=$pass
        export SWARM_SERVER_USERNAME SWARM_SERVER_PASSWORD
        if [ "$hasdir" = yes ]; then exec "$cli" run --attach "$url" "$@"; fi
        exec "$cli" run --attach "$url" --dir "$PWD" "$@"
        ;;
    esac
    # Linux (R4.10, DP-3): the PID counts when /proc/<pid>/exe is the app executable two levels above this launcher,
    # a full-path match (comm= is cut to 15 characters). Not reached on macOS, which has no /proc.
    if [ -e "/proc/$pid/exe" ] && [ "$(/usr/bin/readlink "/proc/$pid/exe" 2>/dev/null)" = "$(/usr/bin/readlink -f "$dir/../..")/id.co.gsp.swarm.desktop" ]; then
      shift
      SWARM_SERVER_USERNAME=$user
      SWARM_SERVER_PASSWORD=$pass
      export SWARM_SERVER_USERNAME SWARM_SERVER_PASSWORD
      if [ "$hasdir" = yes ]; then exec "$cli" run --attach "$url" "$@"; fi
      exec "$cli" run --attach "$url" --dir "$PWD" "$@"
    fi
  fi
fi
exec "$cli" "$@"
