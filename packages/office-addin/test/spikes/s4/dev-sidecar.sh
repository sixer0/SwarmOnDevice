#!/bin/zsh
# Spike S4: start the scripted LLM and a Swarm dev sidecar with HOME/XDG pinned under $TMPDIR.
# Sourced by smoke.sh; can also be sourced by hand (see README). Never prints the password.
#
# After sourcing, these are set in the calling shell:
#   S4_HOME            pinned home (throwaway)
#   S4_SIDECAR_URL     http://127.0.0.1:55317
#   S4_PASSWORD        throwaway password (do not echo it)
#   S4_PIDS            pids of the processes started here
set -u
S4_DIR=${0:A:h}
S4_REPO=${S4_DIR:h:h:h:h:h}
S4_SIDECAR_PORT=${S4_SIDECAR_PORT:-55317}
S4_LLM_PORT=${S4_LLM_PORT:-55318}
S4_HOME=$(mktemp -d "${TMPDIR:-/tmp}/swarm-s4-home.XXXXXX")
S4_SIDECAR_URL="http://127.0.0.1:${S4_SIDECAR_PORT}"
S4_PASSWORD=${S4_PASSWORD:-$(openssl rand -hex 24)}
S4_PIDS=()
mkdir -p "$S4_HOME/.config" "$S4_HOME/.local/share" "$S4_HOME/.local/state" "$S4_HOME/.cache" "$S4_HOME/logs"

SWARM_S4_LLM_PORT=$S4_LLM_PORT bun "$S4_DIR/fake-llm.ts" >"$S4_HOME/logs/llm.log" 2>&1 &
S4_PIDS+=($!)

S4_CONFIG=$(cat <<EOF
{"formatter":false,"lsp":false,"model":"s4/scripted","small_model":"s4/scripted",
 "provider":{"s4":{"name":"S4 scripted","id":"s4","env":[],"npm":"@ai-sdk/openai-compatible",
  "models":{"scripted":{"id":"scripted","name":"S4 scripted","attachment":false,"reasoning":false,"temperature":false,
   "tool_call":true,"release_date":"2025-01-01","limit":{"context":100000,"output":10000},"cost":{"input":0,"output":0},"options":{}}},
  "options":{"apiKey":"s4-not-a-key","baseURL":"http://127.0.0.1:${S4_LLM_PORT}/v1"}}}}
EOF
)

(
  cd "$S4_REPO/packages/opencode" &&
    exec env HOME="$S4_HOME" OPENCODE_TEST_HOME="$S4_HOME" \
      XDG_CONFIG_HOME="$S4_HOME/.config" XDG_DATA_HOME="$S4_HOME/.local/share" \
      XDG_STATE_HOME="$S4_HOME/.local/state" XDG_CACHE_HOME="$S4_HOME/.cache" \
      OPENCODE_CONFIG_CONTENT="$S4_CONFIG" OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_PURE=1 \
      OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_DISABLE_AUTOCOMPACT=1 OPENCODE_DISABLE_MODELS_FETCH=1 \
      OPENCODE_AUTH_CONTENT='{}' OPENCODE_SERVER_PASSWORD="$S4_PASSWORD" \
      bun run ./src/index.ts serve --hostname 127.0.0.1 --port "$S4_SIDECAR_PORT"
) >"$S4_HOME/logs/sidecar.log" 2>&1 &
S4_PIDS+=($!)

# Wait up to 60 s for the sidecar health endpoint (credentials via a curl config on stdin, not argv).
for _ in {1..120}; do
  printf 'user = "opencode:%s"\n' "$S4_PASSWORD" |
    curl -s -o /dev/null -w '%{http_code}' -K - "$S4_SIDECAR_URL/global/health" 2>/dev/null | grep -q 200 && break
  sleep 0.5
done
