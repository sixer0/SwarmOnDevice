#!/bin/zsh
# Spike S4 local smoke (no Office). Needs the sandbox bypass: it binds 55317, 55318 and 47317.
# Prints statuses, event types and grep counts only: never the password, never bodies.
set -u
S4_DIR=${0:A:h}
PROXY_PORT=${S4_PROXY_PORT:-47317}

echo "== 1. proxy without env"
env -u SWARM_S4_SIDECAR_URL -u SWARM_S4_SIDECAR_USERNAME -u SWARM_S4_SIDECAR_PASSWORD bun "$S4_DIR/proxy.ts"
echo "exit=$?"

echo "== 2. dev sidecar + scripted LLM"
source "$S4_DIR/dev-sidecar.sh"
cleanup() {
  for pid in $S4_PIDS; do kill "$pid" 2>/dev/null; done
  pkill -f "serve --hostname 127.0.0.1 --port ${S4_SIDECAR_PORT}" 2>/dev/null
  sleep 1
}
trap cleanup EXIT INT TERM
printf 'user = "opencode:%s"\n' "$S4_PASSWORD" | curl -s -o /dev/null -w 'sidecar health %{http_code}\n' -K - "$S4_SIDECAR_URL/global/health"

PLOG="$S4_HOME/logs/proxy.log"
SWARM_S4_SIDECAR_URL=$S4_SIDECAR_URL SWARM_S4_SIDECAR_USERNAME=opencode SWARM_S4_SIDECAR_PASSWORD=$S4_PASSWORD \
  SWARM_S4_PORT=$PROXY_PORT SWARM_S4_INSECURE_HTTP=1 SWARM_S4_LOG="$PLOG" SWARM_S4_WORKSPACE="$S4_HOME/workspace" \
  bun "$S4_DIR/proxy.ts" >"$S4_HOME/logs/proxy.stdout" 2>&1 &
S4_PIDS+=($!)
for _ in {1..60}; do curl -s -o /dev/null "http://127.0.0.1:$PROXY_PORT/pane/index.html" && break; sleep 0.5; done

P="http://127.0.0.1:$PROXY_PORT"
H=(-H "X-Swarm-Office: 1" -H "Content-Type: application/json")
echo "== 3. P2 create session (title only)"
CREATED=$(curl -s "${H[@]}" -d '{"title":"S4 smoke","host":"Word"}' "$P/swarm/session")
SID=$(print -r -- "$CREATED" | bun -e 'const t=await Bun.stdin.text(); console.log(JSON.parse(t).id ?? "")')
echo "session id present: $([[ -n $SID ]] && echo yes || echo no)"
echo "== 3b. P2 with tools -> expect 400"
curl -s -o /dev/null -w 'status %{http_code}\n' "${H[@]}" -d '{"title":"x","tools":{"bash":true}}' "$P/swarm/session"
echo "== 3c. P6 with tools -> expect 400"
curl -s -o /dev/null -w 'status %{http_code}\n' "${H[@]}" -d '{"parts":[{"type":"text","text":"x"}],"tools":{"bash":true}}' "$P/swarm/session/$SID/prompt_async"
echo "== 3d. no X-Swarm-Office -> expect 403; GET /swarm/session (P3, not in spike) -> expect 404; /swarm/global/event -> 404"
curl -s -o /dev/null -w 'status %{http_code}\n' -H "Content-Type: application/json" -d '{"title":"x"}' "$P/swarm/session"
curl -s -o /dev/null -w 'status %{http_code}\n' -H "X-Swarm-Office: 1" "$P/swarm/session"
curl -s -o /dev/null -w 'status %{http_code}\n' -H "X-Swarm-Office: 1" "$P/swarm/global/event"

echo "== 4. sidecar view of the created session (permission + metadata only)"
printf 'user = "opencode:%s"\n' "$S4_PASSWORD" | curl -s -K - "$S4_SIDECAR_URL/session/$SID?directory=$S4_HOME/workspace" |
  bun -e 'const s=JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({permission:s.permission, metadata:s.metadata, directory:s.directory}))'

echo "== 5. P8 event stream for 3s + P6 synthetic prompt"
curl -s -N --max-time 3 -H "X-Swarm-Office: 1" "$P/swarm/event" >"$S4_HOME/logs/events.sse" &
sleep 0.5
curl -s -o /dev/null -w 'prompt_async status %{http_code}\n' "${H[@]}" -d '{"parts":[{"type":"text","text":"Reply with the word PONG."}]}' "$P/swarm/session/$SID/prompt_async"
wait %curl 2>/dev/null
sleep 3
echo "event frames (type counts):"
grep '^data:' "$S4_HOME/logs/events.sse" | sed 's/^data: //' | bun -e '
const lines=(await Bun.stdin.text()).split("\n").filter(Boolean).map((l)=>JSON.parse(l))
const counts=new Map(); lines.forEach((e)=>counts.set(e.type,(counts.get(e.type)??0)+1))
console.log([...counts].map(([k,v])=>`  ${k} x${v}`).join("\n"))
const deltas=lines.filter((e)=>e.type==="message.part.delta").map((e)=>e.properties.field)
console.log("  delta fields:", [...new Set(deltas)].join(",") || "none")
const asst=lines.filter((e)=>e.type==="message.updated"&&e.properties.info.role==="assistant").map((e)=>e.properties.info)
console.log("  assistant providerID/modelID present:", asst.length? asst.every((i)=>!!i.providerID&&!!i.modelID):"no assistant message seen")
'
echo "== 6. P7 abort -> status"
curl -s -o /dev/null -w 'status %{http_code}\n' -H "X-Swarm-Office: 1" -X POST "$P/swarm/session/$SID/abort"

echo "== 6b. same flow through @opencode-ai/sdk/v2/client (pane library), complete + abort"
SWARM_S4_PROXY_URL=$P bun "$S4_DIR/sdk-smoke.ts" | grep -vE 'plugin.added|catalog.updated|reference.updated|integration.updated'

echo "== 7. proxy log"
cat "$PLOG"
echo "== 8. secret/body grep on proxy log + stdout (expect 0 each)"
for f in "$PLOG" "$S4_HOME/logs/proxy.stdout"; do
  echo "$(basename $f): password=$(grep -cF -- "$S4_PASSWORD" "$f") basic=$(grep -ciE 'authorization|basic ' "$f") body=$(grep -cE 'PONG|Reply with|tools|\"title\"|\"parts\"|S4 smoke' "$f")"
done
echo "scripted LLM hits: $(grep -c 'POST /v1/chat/completions' "$S4_HOME/logs/llm.log")"
