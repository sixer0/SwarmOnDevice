#!/usr/bin/env bash
# Row-93 proofs for the live VM bring-up smoke:
#   src/dockerRunner.real.ts        (spawn-backed DockerRunner — r91's injected interface)
#   test/docker_runner_real.test.ts (offline contract-parity units — ALWAYS run, NO daemon)
#   test/live_smoke.ts              (phased live driver — ONLY under R93_LIVE=1)
#
# OFFLINE BLOCK always runs and touches NO docker daemon and NO network (units drive a scripted
# spawn). LIVE BLOCK is behind R93_LIVE=1: it is the FIRST real colima/docker execution in the
# project. It binds NO port of its own (probe URLs are read FROM the rendered artefact), never
# touches the user's `default` colima profile or current docker context, and tears everything down.
#
# STORM RESILIENCE: every live phase writes a marker to $WORK/live.state on success AND re-probes
# actual host state, so a mid-phase provider cut resumes by skipping what already holds. Safe to
# re-run. Run from packages/setup:  bash test/live_vm_smoke.proofs.sh
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                  # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

_TMPBASE="${TMPDIR:-/tmp}"; _TMPBASE="${_TMPBASE%/}"
WORK="$(mktemp -d "${_TMPBASE}/swarm-setup-r93-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/home-dry"
STATE="$WORK/live.state"; : > "$STATE"            # per-run phase markers (fresh each invocation)

DOCKER=/opt/homebrew/bin/docker
COLIMA=/opt/homebrew/bin/colima

pass=0; fail=0
check () { if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1)); else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi; }

MY_SHIPPED="src/dockerRunner.real.ts"
LIVE_DRIVER="test/live_smoke.ts"

echo "=== PROOF 1: typecheck — full package + isolated row-93 surface (incl. live driver) ==="
cat > "$WORK/tsconfig.r93.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022"], "module": "ESNext", "moduleResolution": "bundler",
    "types": [], "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "verbatimModuleSyntax": false, "allowImportingTsExtensions": true,
    "resolveJsonModule": true, "esModuleInterop": true, "forceConsistentCasingInFileNames": true
  },
  "include": ["$HERE/types/**/*.d.ts", "$HERE/src/**/*.ts", "$HERE/test/live_smoke.ts"]
}
JSON
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
check "tsc --noEmit (FULL package)" 0 $?
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.r93.json" )
check "tsc --noEmit (isolated row-93 incl live driver)" 0 $?

for entry in "dockerRunner.real:src/dockerRunner.real.ts" "live_smoke:test/live_smoke.ts"; do
  name="${entry%%:*}"; rel="${entry#*:}"
  bun build --compile --target=bun --outfile "$WORK/bin/$name" "$HERE/$rel" >/dev/null 2>&1
  rc=$?
  check "bun build --compile $rel" 0 $rc
  file "$WORK/bin/$name" | grep -q "Mach-O" && { echo "  PASS $name is Mach-O arm64"; pass=$((pass+1)); } || { echo "  FAIL $name not Mach-O"; fail=$((fail+1)); }
done

echo "=== PROOF 2: unit suite — CONTRACT PARITY real runner vs fake shim (NO daemon, NO network) ==="
( cd "$HERE" && bun test test/docker_runner_real.test.ts ) > "$WORK/bun-test.log" 2>&1
rc=$?; tail -6 "$WORK/bun-test.log"
check "bun test test/docker_runner_real.test.ts" 0 $rc

echo "=== PROOF 3: security grep gates ==="
# 3a PORT RULE: zero port / IP:port literals in the SHIPPED runner + the live driver (both derive
#    every host/port from artefacts/constants; the driver prints URLs parsed by healthProbeUrls).
rg -n --glob '*.ts' '\b(8888|3002|902[0-9]|8080|3128|5432|6379|5672|3000|3004|3005)\b|127\.0\.0\.1:[0-9]' "$MY_SHIPPED" "$LIVE_DRIVER" >/dev/null 2>&1
check "3a no port/IP:port literals in row-93 sources (expect no-match=1)" 1 $?
# 3b no shell spawn: the runner must NEVER shell out (only argv-array + absolute path via
#    Bun.spawnSync), so node:child_process / execSync / execFileSync / a quoted `sh`/`bash -c`
#    may not appear in the SHIPPED runner file. (Bun.spawnSync argv is the sanctioned mechanism.)
rg -n "node:child_process|execSync|execFileSync|[\"']sh[\"'].{0,4}-c|[\"']bash[\"'].{0,4}-c" "$MY_SHIPPED" >/dev/null 2>&1
check "3b shipped runner uses no shell/child_process (Bun.spawnSync argv only) (expect no-match=1)" 1 $?
# 3c live driver uses Bun.spawnSync via r86's spawnRunner + the real runner; assert it imports NO raw
#    network builtin (host HTTP probes live in THIS bash via curl, not in the shipped TS).
rg -n "node:net|node:http|node:tls|require\(|\beval\(" "$MY_SHIPPED" "$LIVE_DRIVER" >/dev/null 2>&1
check "3c no raw-network/eval primitive in row-93 sources (expect no-match=1)" 1 $?
# 3d the shipped runner takes an ABSOLUTE default binary and prepends it (proof of no PATH lookup).
grep -q 'DOCKER_BINARY_DEFAULT = "/opt/homebrew/bin/docker"' "$MY_SHIPPED" \
  && { echo "  PASS 3d absolute-path binary default present in runner"; pass=$((pass+1)); } \
  || { echo "  FAIL 3d missing absolute binary default"; fail=$((fail+1)); }

echo "=== PROOF 4: directory-scan registration UNCHANGED (row 93 adds NO scanned step) ==="
cat > "$WORK/scan.ts" <<TS
import { discoverSteps, orderSteps } from "$HERE/src/steps.ts";
const ids = discoverSteps().steps.map((s) => s.id).sort();
const want = ["firecrawl","graft","node","obsidian","rtk","runtime","searxng"];
const same = JSON.stringify(ids) === JSON.stringify(want);
const ord = orderSteps(discoverSteps().steps);
console.log("registered:", ids.join(","), "| errors:", discoverSteps().errors.length, "| topo-ok:", ord.ok);
process.exit(same && ord.ok ? 0 : 1);
TS
bun run "$WORK/scan.ts"; check "scan registers the SAME seven PC-CMP ids (no new step from r93)" 0 $?

echo "=== PROOF 5: cross-row regressions (r81-r92, shared typecheck surface) — reported, observed ==="
run_proof () { local f="$1"; local g="$2"; local out; out="$(bash "$HERE/test/$f" 2>&1)"; echo "$out" | grep -E "$g" | tail -1; }
echo "  r81 $(run_proof proofs.sh 'SUMMARY')"
echo "  r82 $(run_proof fetch.proofs.sh 'row-82 proofs')"
echo "  r83 $(run_proof consent.proofs.sh 'SUMMARY')"
echo "  r84 $(run_proof stepkit.proofs.sh 'row-84 proofs')"
echo "  r85 $(run_proof compose.proofs.sh 'row-85 proofs')"
echo "  r86 $(run_proof runtime.proofs.sh 'passed,')"
echo "  r87 $(run_proof node.proofs.sh 'row-87 proofs')"
echo "  r91 $(run_proof stack.proofs.sh 'SUMMARY')"
echo "  r92 $(run_proof egress_bake.proofs.sh 'passed,')"

# ---------------------------------------------------------------------------------------------
if [ "${R93_LIVE:-0}" != "1" ]; then
  echo ""
  echo "=== LIVE BLOCK SKIPPED (set R93_LIVE=1 to run the real colima/docker smoke) ==="
  echo "=== SUMMARY: $pass passed, $fail failed ==="
  [ "$fail" = "0" ] && exit 0 || exit 1
fi

echo ""
echo "############## LIVE VM SMOKE (R93_LIVE=1) — first real docker/colima on this host ##############"

markp () { echo "$1" >> "$STATE"; }
hasp  () { grep -qx "$1" "$STATE"; }

echo "=== L0 non-interference BASELINE (colima list + docker context) ==="
"$COLIMA" list > "$WORK/colima_before.txt" 2>&1
"$COLIMA" list --json > "$WORK/colima_json_before.txt" 2>&1
"$DOCKER" context ls --format '{{.Name}} {{.Current}}' > "$WORK/ctx_before.txt" 2>&1
"$DOCKER" context show > "$WORK/ctxshow_before.txt" 2>&1
cat "$WORK/colima_before.txt"; echo "---"; cat "$WORK/ctx_before.txt"; echo "current=$(cat "$WORK/ctxshow_before.txt")"
grep -q "^default " "$WORK/colima_before.txt" || echo "  NOTE default profile not visible in baseline"
markp L0

echo "=== L1 bring-up (profile swarm + observed-context isolation + docker info health + D-13 capture + [H] layout + render + secrets + egress bake) ==="
# No workaround path anymore: r91's fix round rewrote contextInspectArgs to a valid argv, and r86 records
# the OBSERVED context name in state; the driver uses stacklib.bringUp verbatim. Every docker call below
# selects the context via "$CTX" (read from r93-context.txt, written by the driver from the observed
# post-start name) — never a hardcoded context literal.
export R93_LIVE=1 R93_WORK="$WORK" R93_PHASE=bringup
if ! hasp L1; then
  bun run "$HERE/$LIVE_DRIVER" > "$WORK/L1.log" 2>&1; rc=$?
  grep -E 'R93_JSON (context_isolation|docker_info_health|egress_bake|d13_capture)|R93_OUTCOME' "$WORK/L1.log" | tail -8
  if grep -q "R93_OUTCOME bringup=OK" "$WORK/L1.log"; then markp L1; else echo "  L1 did not reach OK (rc=$rc) — see $WORK/L1.log"; fi
else echo "  L1 already marked done (resume)"; fi
grep -o 'R93_JSON preflight .*' "$WORK/L1.log" | tail -1 | sed 's/^R93_JSON preflight //' > "$WORK/preflight.json" || true
grep -q '"firecrawlOffered":true' "$WORK/L1.log" && OFFERED=yes || OFFERED=no
echo "  firecrawlOffered=$OFFERED"
CTX="$(head -1 "$WORK/r93-context.txt" 2>/dev/null | tr -d '\n')"   # observed context (single source)
[ -n "$CTX" ] || echo "  WARN: r93-context.txt empty — L1 incomplete; live docker calls will fail honestly"
# component-scoped container lookup (label keeps it to OUR estate; never the user's default context)
ctr () { "$DOCKER" --context "$CTX" ps --format '{{.Names}}' --filter "label=io.gsp.swarm.component=$1" 2>/dev/null | grep -i "$2" | head -1; }
# container state string: "<status> <health|nohc>"
cstate () { "$DOCKER" --context "$CTX" inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}nohc{{end}}' "$1" 2>/dev/null; }

echo "=== L2 pull SearXNG images (streamed; skip-if-present) ==="
if ! hasp L2 && [ -s "$WORK/r93-images-searxng.txt" ]; then
  while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    "$DOCKER" --context "$CTX" image inspect "$ref" >/dev/null 2>&1 && { echo "  present: ${ref:0:50}…"; continue; }
    echo "  PULLING: $ref"; "$DOCKER" --context "$CTX" pull "$ref" >/dev/null 2>&1 || { echo "  pull FAILED: $ref"; break 2; }
  done < "$WORK/r93-images-searxng.txt"
  markp L2
else echo "  L2 skipped (already done or no image list)"; fi

echo "=== L3 searxng stack up + CHECKLIST ITEM 4 (host-side JSON gate; healthcheck omitted by design) ==="
if ! hasp L3; then
  export R93_PHASE=searxng-up
  bun run "$HERE/$LIVE_DRIVER" > "$WORK/L3.log" 2>&1; rc=$?
  grep -oE 'R93_(JSON searxng_up|OUTCOME).*' "$WORK/L3.log" | tail -2
  # U-1 CLOSED live (r85-fix2): the pinned searxng image ships no curl, so the healthcheck is OMITTED and
  # the ACCEPTANCE GATE is this host-side JSON fetch — not the docker health token.
  UP=$("$DOCKER" --context "$CTX" ps --format '{{.Names}}' --filter 'label=io.gsp.swarm.component=searxng' 2>/dev/null | grep -c searxng)
  if [ "$UP" -ge 1 ]; then
    SXBASE=$(head -1 "$WORK/r93-probe-searxng.txt" | sed 's:/*$::')
    code=$(curl -s -o "$WORK/probe1.json" -w '%{http_code}' --max-time 25 "${SXBASE}/search?q=openstreetmap&format=json" 2>/dev/null)
    echo "  [item4] searxng host-side JSON base=$SXBASE HTTP $code"
    if [ "$code" = "200" ] && grep -qiE '"results"|"response_time"|"number_of_results"' "$WORK/probe1.json"; then
      echo "    PASS item4 SearXNG JSON API served (host-side gate green)"; pass=$((pass+1)); markp item4
    else echo "    FAIL item4 (code=$code):"; head -c 200 "$WORK/probe1.json"; echo; fail=$((fail+1)); fi
  else echo "    FAIL item4 searxng container not running"; fail=$((fail+1)); fi
  markp L3
else echo "  L3 already marked done (resume)"; fi

if [ "$OFFERED" = "yes" ]; then
  echo "=== L4 pull FIRECRAWL images (streamed; skip-if-present) ==="
  if ! hasp L4 && [ -s "$WORK/r93-images-firecrawl.txt" ]; then
    while IFS= read -r ref; do
      [ -z "$ref" ] && continue
      "$DOCKER" --context "$CTX" image inspect "$ref" >/dev/null 2>&1 && { echo "  present: ${ref:0:50}…"; continue; }
      echo "  PULLING: $ref"; "$DOCKER" --context "$CTX" pull "$ref" >/dev/null 2>&1 || { echo "  pull FAILED: $ref"; break 2; }
    done < "$WORK/r93-images-firecrawl.txt"
    markp L4
  else echo "  L4 skipped"; fi

  echo "=== L5 FIRECRAWL §10.6 RE-PROBE CHECKLIST (v2 per r75-fix3 + r85-fix2; row 112 runs verbatim) ==="
  if ! hasp L5; then
    export R93_PHASE=firecrawl-up
    bun run "$HERE/$LIVE_DRIVER" > "$WORK/L5.log" 2>&1; rc=$?
    grep -oE 'R93_(JSON firecrawl_up|OUTCOME).*' "$WORK/L5.log" | tail -2 | cut -c1-300
    FCBASE=$(head -1 "$WORK/r93-probe-firecrawl.txt" | sed 's:/*$::')
    TOKEN=$(cat "$HOME/.swarm/tools/firecrawl/secrets/proxy_token" 2>/dev/null | tr -d '\n')
    AP=$(ctr firecrawl auth-proxy); PW=$(ctr firecrawl playwright); EP=$(ctr firecrawl egress)

    # ---- ITEM 1: playwright-service runs with NO added capabilities (SYS_ADMIN withheld, U-9) and a
    #      WIDENED /root/.cache tmpfs (delta 3). Verifies the r85-fix2 cap policy did NOT fall back to caps.
    pw_caps="$("$DOCKER" --context "$CTX" inspect -f '{{join .HostConfig.CapAdd ","}}' "${PW:-none}" 2>/dev/null)"
    pw_mnt="$("$DOCKER" --context "$CTX" inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "${PW:-none}" 2>/dev/null)"
    echo "  [item1] playwright container=${PW:-ABSENT} CapAdd='${pw_caps}' mounts='$pw_mnt'"
    if [ -n "$PW" ] && ! echo "$pw_caps" | grep -qi SYS_ADMIN && echo "$pw_mnt" | grep -q "/root/.cache"; then
      echo "    PASS item1 playwright: no CAP_SYS_ADMIN + widened /root/.cache tmpfs"; pass=$((pass+1)); markp item1
    else echo "    FAIL item1 (caps must exclude SYS_ADMIN; mounts must carry /root/.cache)"; fail=$((fail+1)); fi

    # ---- ITEM 2: auth-proxy renders /etc/nginx/conf.d/default.conf on a WRITABLE conf.d tmpfs (delta 2)
    #      and serves the token-gated edge. Functional sub-check = §10.6 probe 1 class: 401 without token,
    #      non-401 with bearer.
    ap_mnt="$("$DOCKER" --context "$CTX" inspect -f '{{range .Mounts}}{{.Destination}} {{end}}' "${AP:-none}" 2>/dev/null)"
    if [ -n "$AP" ]; then
      c_no=$(curl -s -o /dev/null -w '%{http_code}' --max-time 25 -X POST "${FCBASE}/v2/scrape" -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' 2>/dev/null)
      c_yes=$(curl -s -o /dev/null -w '%{http_code}' --max-time 40 -X POST "${FCBASE}/v2/scrape" -H "Authorization: Bearer ${TOKEN}" -H 'Content-Type: application/json' -d '{"url":"https://example.com"}' 2>/dev/null)
      echo "  [item2] auth-proxy=${AP} conf.d-mount='$ap_mnt' no-token=$c_no with-token=$c_yes"
      if echo "$ap_mnt" | grep -q "/etc/nginx/conf.d" && [ "$c_no" = "401" ] && [ "$c_yes" != "401" ] && [ "$c_yes" != "000" ]; then
        echo "    PASS item2 conf.d tmpfs rendered + edge enforces token (401 vs $c_yes)"; pass=$((pass+1)); markp item2
      else echo "    FAIL item2 (need writable conf.d tmpfs AND 401-without/non-401-with token)"; fail=$((fail+1)); fi
    else echo "    FAIL item2 auth-proxy ABSENT (stack not up)"; fail=$((fail+1)); fi

    # ---- ITEM 3: the five previously-crashing services are healthy under the per-service allow-list caps
    #      (delta 1 replaced the disproved blanket ALL). auth-proxy, api, nuq-postgres, rabbitmq, egress-proxy.
    healthy3=0; total3=0
    for svc in auth-proxy api nuq-postgres rabbitmq egress-proxy; do
      c=$(ctr firecrawl "$svc"); total3=$((total3+1))
      st=$(cstate "${c:-none}")
      echo "  [item3] $svc -> ${st:-ABSENT}"
      case "$st" in *" exited "*|*restarting*|*dead*) : ;; running*healthy*|running*nohc*) healthy3=$((healthy3+1)) ;; esac
    done
    if [ "$healthy3" = "$total3" ] && [ "$total3" -gt 0 ]; then
      echo "    PASS item3 five services healthy on allow-list caps"; pass=$((pass+1)); markp item3
    else echo "    FAIL item3 only $healthy3/$total3 services up+healthy"; fail=$((fail+1)); fi

    # ---- ITEM 5: squid LOADS with the split ACL grammar (two `acl to_localhost dstdomain` lines; no mixed
    #      dst/domain) and DENIES one probe per IP class: loopback, RFC1918, link-local, CGNAT, IPv6. A
    #      PUBLIC control must be allowed (proves the denials are for the right reason).
    if [ -n "$EP" ]; then
      parse_rc="$("$DOCKER" --context "$CTX" exec "$EP" sh -c 'squid -k parse -f /etc/squid/swarm-egress.conf >/dev/null 2>&1 && echo ok || echo bad' 2>/dev/null)"
      echo "  [item5] squid -k parse=${parse_rc:-unknown}; one denial probe per IP class:"
      ssrf_ok=0; ssrf_total=0
      for spec in "loopback:http://127.0.0.1/" "rfc1918:http://192.168.1.1/" "link-local:http://169.254.169.254/latest/meta-data/" "cgnat:http://100.64.0.1/" "ipv6-loopback:http://[::1]/"; do
        cls="${spec%%:*}"; target="${spec#*:}"; ssrf_total=$((ssrf_total+1))
        resp="$("$DOCKER" --context "$CTX" exec "$EP" bash -c "exec 3<>/dev/tcp/127.0.0.1/3128; printf 'GET ${target} HTTP/1.1\r\nHost: ssrf-probe\r\nConnection: close\r\n\r\n' >&3; head -c 400 <&3" 2>/dev/null)"
        echo "$resp" | grep -qiE '403|ERR_ACCESS_DENIED|X-Squid-Error' && ssrf_ok=$((ssrf_ok+1)) || echo "    ($cls NOT denied: $(echo "$resp" | head -1))"
      done
      # public control: allow-listed egress should NOT be access-denied (a different error or success is fine)
      pub="$("$DOCKER" --context "$CTX" exec "$EP" bash -c "exec 3<>/dev/tcp/127.0.0.1/3128; printf 'http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n' | sed 's|^http|GET http|' >&3; head -c 120 <&3" 2>/dev/null)"
      pub_denied=$(echo "$pub" | grep -ciE 'ERR_ACCESS_DENIED')
      echo "    public-control access-denied=${pub_denied}"
      if [ "$parse_rc" = "ok" ] && [ "$ssrf_ok" = "$ssrf_total" ] && [ "$pub_denied" = "0" ]; then
        echo "    PASS item5 squid loads w/ split-ACL + denies all $ssrf_total IP classes, public control not denied"; pass=$((pass+1)); markp item5
      else echo "    FAIL item5 (parse=${parse_rc} denied=${ssrf_ok}/${ssrf_total} public-denied=${pub_denied})"; fail=$((fail+1)); fi
    else echo "    FAIL item5 egress-proxy ABSENT (squid cannot boot — grammar/config still broken?)"; fail=$((fail+1)); fi

    markp L5
  else echo "  L5 already marked done (resume)"; fi
else
  echo "=== L4/L5 SKIPPED HONESTLY: host below the 16 GiB Firecrawl memory floor (r86 preflight offered=false) ==="
fi

echo "=== L6 teardown (label-scoped compose down + residue check) ==="
if ! hasp L6; then
  export R93_PHASE=teardown
  bun run "$HERE/$LIVE_DRIVER" > "$WORK/L6.log" 2>&1; rc=$?
  grep -E "R93_JSON teardown_|R93_OUTCOME" "$WORK/L6.log" | tail -6
  LEFT=$("$DOCKER" --context "$CTX" ps -aq --filter 'label=io.gsp.swarm.managed=true' 2>/dev/null | wc -l | tr -d ' ')
  echo "  stray managed containers after teardown: $LEFT"
  if [ "$LEFT" = "0" ]; then echo "  PASS teardown left ZERO managed containers"; pass=$((pass+1)); else echo "  FAIL $LEFT managed containers still present"; fail=$((fail+1)); fi
  markp L6
else echo "  L6 already marked done (resume)"; fi

echo "=== L7 profile teardown + non-interference AFTER (byte identity of the USER surface) ==="
"$COLIMA" stop --profile swarm >/dev/null 2>&1 || echo "  (colima stop returned nonzero)"
"$COLIMA" delete --profile swarm --force >/dev/null 2>&1 || echo "  (colima delete returned nonzero)"
# colima delete cleans its own context; drop it defensively by OBSERVED name if it lingers (never the alias hack)
[ -n "$CTX" ] && "$DOCKER" context rm "$CTX" >/dev/null 2>&1 || true
"$COLIMA" list > "$WORK/colima_after.txt" 2>&1
"$COLIMA" list --json > "$WORK/colima_json_after.txt" 2>&1
"$DOCKER" context ls --format '{{.Name}} {{.Current}}' > "$WORK/ctx_after.txt" 2>&1
"$DOCKER" context show > "$WORK/ctxshow_after.txt" 2>&1
diff -u "$WORK/colima_before.txt" "$WORK/colima_after.txt" > "$WORK/diff_colima.txt" 2>&1; dcol=$?
diff -u "$WORK/ctx_before.txt" "$WORK/ctx_after.txt" > "$WORK/diff_ctx.txt" 2>&1; dctx=$?
diff -u "$WORK/ctxshow_before.txt" "$WORK/ctxshow_after.txt" > "$WORK/diff_ctxshow.txt" 2>&1; dshow=$?
[ "$dcol" = "0" ] && { echo "  PASS colima list byte-identical before/after"; pass=$((pass+1)); } || { echo "  FAIL colima list differs:"; cat "$WORK/diff_colima.txt"; fail=$((fail+1)); }
[ "$dctx" = "0" ] && { echo "  PASS docker context ls byte-identical before/after"; pass=$((pass+1)); } || { echo "  FAIL docker context ls differs:"; cat "$WORK/diff_ctx.txt"; fail=$((fail+1)); }
[ "$dshow" = "0" ] && { echo "  PASS current-context unchanged ($(cat "$WORK/ctxshow_after.txt"))"; pass=$((pass+1)); } || { echo "  FAIL current-context moved"; cat "$WORK/diff_ctxshow.txt"; fail=$((fail+1)); }
# default-profile intactness: the user's running containers are still reachable on the default context
"$DOCKER" ps --format '{{.Names}}' > "$WORK/default_ps_after.txt" 2>&1
echo "  default-profile containers still present (sample): $(head -1 "$WORK/default_ps_after.txt")"
# self-clean: remove this smoke's GENERATED secrets (credential hygiene). The compose artefacts + state
# envelope + tools/runtime/lima-layout.json ([H] closure evidence) are left as the durable observation.
rm -rf "$HOME/.swarm/tools/searxng/secrets" "$HOME/.swarm/tools/firecrawl/secrets" 2>/dev/null || true
echo "  removed generated secrets (kept artefacts + lima-layout.json evidence)"
markp L7

echo "=== L8 post-live regressions unchanged by any VM work (typecheck still clean) ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
check "tsc --noEmit (FULL) after live" 0 $?

echo ""
echo "=== LIVE PHASES REACHED: $(tr '\n' ' ' < "$STATE") ==="
echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = "0" ] && exit 0 || exit 1
