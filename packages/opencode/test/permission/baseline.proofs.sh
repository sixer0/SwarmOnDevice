#!/usr/bin/env bash
# Row 96 proof battery (masterplan/01f_tool_wiring_spec.md §4.2/§5.1, T-W7-6/7/8 legs
# that need the REAL CLI, not just the unit engine). Run from packages/opencode:
#   bash test/permission/baseline.proofs.sh
# Every check drives the shipped code paths: real config load + merge, real agent
# construction, real r94 validator. Nothing here re-implements the matcher.
set -u
cd "$(dirname "$0")/../.." || exit 1 # -> packages/opencode
export PATH="/Users/gsp-budi/Swarm_OnDevice/tools/node_modules/.bin:$PATH"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
pass=0; fail=0
ok()  { echo "PROOF $1: PASS"; pass=$((pass+1)); }
bad() { echo "PROOF $1: FAIL — $2"; fail=$((fail+1)); }

BASE_ENV=(HOME="$T" XDG_CONFIG_HOME="$T/.config" XDG_DATA_HOME="$T/.local/share" XDG_CACHE_HOME="$T/.cache" XDG_STATE_HOME="$T/.local/state" TMPDIR="$T/tmp")
# Fake provider satisfies debug agent's defaultModel() requirement (agent.handler.ts:68-81)
# without any network: api host is .invalid and never contacted by these checks.
FAKECFG='{"provider":{"fakeprov":{"name":"fakeprov","api":"https://example.invalid/v1","models":{"m1":{"name":"m1"}}}},"model":"fakeprov/m1"}'

# PROOF 1 — unit suite green (real Permission engine over the shipped objects)
u=$(bun test test/permission/baseline.test.ts 2>&1)
up=$(echo "$u" | awk '/^ *[0-9]+ pass$/{print $1; exit}')
uf=$(echo "$u" | awk '/^ *[0-9]+ fail$/{print $1; exit}')
if [ "${up:-0}" -ge 15 ] && [ "${uf:-1}" -eq 0 ]; then ok 1 "unit ${up}pass/0fail"; else bad 1 "unit ${up:-?}pass/${uf:-?}fail"; fi

# PROOF 2 — T-W7-6a: fresh-HOME `debug config` shows the baseline through the real
# merge + schema decode (lowest-precedence slot, key order intact)
env "${BASE_ENV[@]}" bun run ./src/index.ts debug config > "$T/cfg.json" 2>"$T/cfg.err" \
  && c=$(bun -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const p = j.permission ?? {}
const f = []
if (Object.keys(p)[0] !== "*") f.push("permission first key not *")
if (p["*"] !== "ask") f.push("* not ask")
if (p.webfetch !== "deny" || p.websearch !== "deny") f.push("web tools not denied")
if (p.bash?.["curl*"] !== "ask" || p.bash?.["sudo*"] !== "deny") f.push("bash classes wrong")
if (Object.keys(p).slice(-2).join(",") !== "graft_*,swarm-web_*") f.push("gate keys not last")
if (j.agent?.researcher?.mode !== "subagent") f.push("researcher mode")
if (j.agent?.researcher?.permission?.["*"] !== "deny") f.push("researcher deny-all")
if (j.experimental?.mcp_timeout !== 30000) f.push("mcp_timeout missing (schema-validity: core v1/config/config.ts:182)")
if (f.length) { console.log(f.join("; ")); process.exit(1) }
' "$T/cfg.json") && ok 2 || bad 2 "${c:-debug config exited nonzero: $(head -c 200 "$T/cfg.err")}"

# PROOF 3 — T-W7-6b: `debug agent build` — baseline "*" ask sits AFTER built-in "*"
# allow (findLast position proof on the real construction), web tools hidden, granted
# set visible, unnamed tools NOT hidden (ask != hide).
env "${BASE_ENV[@]}" OPENCODE_CONFIG_CONTENT="$FAKECFG" bun run ./src/index.ts debug agent build > "$T/build.json" 2>"$T/build.err" \
  && c=$(bun -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const p = j.permission
const firstAllow = p.findIndex((r) => r.permission === "*" && r.action === "allow")
const firstAsk = p.findIndex((r) => r.permission === "*" && r.action === "ask")
const f = []
if (!(firstAllow >= 0 && firstAsk > firstAllow)) f.push("baseline ask not after built-in allow")
if (j.tools.webfetch !== false) f.push("webfetch not hidden")
if ("websearch" in j.tools && j.tools.websearch !== false) f.push("websearch not hidden")
for (const t of ["glob", "grep", "read", "bash", "edit"]) if (j.tools[t] !== true) f.push(t + " wrongly hidden")
// list/websearch/apply_patch have no key in this map (debug registers a subset; absent = invisible to the model)
if ("list" in j.tools && j.tools.list !== true) f.push("list wrongly hidden")
if (f.length) { console.log(f.join("; ")); process.exit(1) }
' "$T/build.json") && ok 3 || bad 3 "${c:-$(head -c 200 "$T/build.err")}"

# PROOF 4 — T-W7-6c + r94 hookup: `debug agent researcher` merged tail is exactly
# deny-all -> three grants -> task/todowrite denies -> Truncate.GLOB allow appended
# last (assertion G end-to-end), and the RESOLVED researcher block passes r94's
# validateResearcherDefinition() with zero violations.
env "${BASE_ENV[@]}" OPENCODE_CONFIG_CONTENT="$FAKECFG" bun run ./src/index.ts debug agent researcher > "$T/res.json" 2>"$T/res.err" \
  && c=$(bun -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const p = j.permission
const denyAll = p.findIndex((r) => r.permission === "*" && r.action === "deny")
const g1 = p.findIndex((r) => r.permission === "swarm-web_search" && r.action === "allow")
const taskDeny = p.findIndex((r) => r.permission === "task" && r.action === "deny")
// the tool-output glob also sits in the built-in defaults whitelist (agent.ts:105-113); assertion G is about the APPENDED copy being last
const last = p[p.length - 1]
const trunc = last && last.permission === "external_directory" && last.action === "allow" && /tool-output\/\*$/.test(last.pattern) ? p.length - 1 : -1
const f = []
if (!(denyAll >= 0)) f.push("no researcher deny-all")
if (!(g1 > denyAll && taskDeny > denyAll)) f.push("grants/denies not after deny-all")
if (trunc !== p.length - 1) f.push("Truncate.GLOB allow is not the final rule (assertion G e2e)")
for (const t of ["bash", "edit", "write", "task", "todowrite", "webfetch"]) { if (j.tools[t] !== false) f.push(t + " not hidden") }
if ("apply_patch" in j.tools && j.tools.apply_patch !== false) f.push("apply_patch not hidden")
// swarm-web_* tools are absent from the listing while the proxy is not connected
// (MCP.tools() lists only connected clients, mcp/index.ts:666-687) — the §5.2
// silent dead end, asserted here as their ABSENCE, not as enabled:true.
if ("swarm-web_search" in j.tools) f.push("unexpected live swarm-web tool without server")
const perm = {}
for (const r of p.slice(denyAll)) { if (!(r.permission in perm)) perm[r.permission] = r.action }
const resolvedBlock = { agent: { researcher: { description: j.description, mode: j.mode, permission: perm } } }
require("fs").writeFileSync(process.argv[3], JSON.stringify(resolvedBlock))
if (f.length) { console.log(f.join("; ")); process.exit(1) }
' "$T/res.json" unused "$T/resolved-researcher.json") \
  && c=$(bun -e '
const w = await import("../setup/src/mcpproxy/wiring.ts")
const resolved = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))
const v = w.validateResearcherDefinition(resolved)
if (v.length) { console.log(v.join("; ")); process.exit(1) }
' "$T/resolved-researcher.json") && ok 4 || bad 4 "${c:-$(head -c 300 "$T/res.err")}"

# PROOF 5 — T-W7-7-D (deny leg): webfetch is hidden/denied -> non-zero exit, no fetch.
out=$(env "${BASE_ENV[@]}" OPENCODE_CONFIG_CONTENT="$FAKECFG" bun run ./src/index.ts debug agent build --tool webfetch --params '{"url":"http://127.0.0.1:1/x"}' 2>&1); rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -qi "disabled\|denied" && ! echo "$out" | grep -qi "ECONNREFUSED\|connection refused"; then ok 5 "exit=$rc, permission error, no connect attempt"; else bad 5 "rc=$rc out=$(echo "$out" | head -c 200)"; fi

# PROOF 6 — F-R96-4 MEASURED FINDING (recorded, not enforced-behavior): the debug
# context throws only on deny (agent.handler.ts:183-190) — an ASK-resolved bash
# command EXECUTES under `debug agent` without prompting. Production enforcement is
# unaffected (unit T-W7-7-C proves the service prompts), but 01f §2.10's claim that
# debug mode never silently allows is FALSE for ask rules. Row 110 must not lean on
# `debug agent` for prompt behaviour. This proof asserts the MEASURED behaviour so a
# future fix flips it loudly.
out=$(env "${BASE_ENV[@]}" OPENCODE_CONFIG_CONTENT="$FAKECFG" bun run ./src/index.ts debug agent build --tool bash --params "{\"command\":\"touch $T/executed-marker\"}" 2>&1); rc=$?
if [ $rc -eq 0 ] && [ -f "$T/executed-marker" ]; then ok 6 "F-R96-4 recorded: ask-path executed under debug (defect lives in cli/cmd/debug/agent.handler.ts, upstream file, reported not edited)"; else bad 6 "expected measured defect, got rc=$rc out=$(echo "$out" | head -c 200)"; fi

# PROOF 7 — user override above the baseline through the REAL file chain: a user
# swarm.json naming specific rules beats the shipped baseline; unnamed baseline
# entries keep enforcing.
mkdir -p "$T/.config/swarm"
echo '{"permission":{"webfetch":"ask","bash":{"curl*":"allow"}}}' > "$T/.config/swarm/swarm.json"
env "${BASE_ENV[@]}" bun run ./src/index.ts debug config > "$T/cfg2.json" 2>/dev/null \
  && c=$(bun -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).permission
const f = []
if (p.webfetch !== "ask") f.push("user webfetch ask did not win")
if (p.bash?.["curl*"] !== "allow") f.push("user bash curl* did not win")
if (p.bash?.["sudo*"] !== "deny") f.push("untouched baseline sudo lost")
if (p["*"] !== "ask") f.push("baseline catch-all lost unexpectedly")
if (f.length) { console.log(f.join("; ")); process.exit(1) }
' "$T/cfg2.json") && ok 7 || bad 7 "${c:-}"

# PROOF 8 — r94 pair contract: mcpPermissionGates() equals the baseline's last two
# keys/values in order (the ordered-pair consumption the handoff demands).
c=$(bun -e '
const w = await import("../setup/src/mcpproxy/wiring.ts")
const { PERMISSION_BASELINE } = await import("@opencode-ai/core/swarm-permission-baseline")
const pairs = w.mcpPermissionGates()
const tail = Object.entries(PERMISSION_BASELINE).slice(-2).map(([k, v]) => [k, v])
const same = JSON.stringify(pairs.map(String)) === JSON.stringify(tail.map(String))
if (!same) { console.log("gates", JSON.stringify(pairs), "vs tail", JSON.stringify(tail)); process.exit(1) }
' 2>&1) && ok 8 || bad 8 "$c"

# PROOF 9 — brand scan over row-96 NEW files: allowed mentions are the keep-class
# @opencode-ai/* import specifiers and packages/opencode/ source-citation paths
# (driver_rules_e1 rule 4 requires file:line citations; they are inert comments).
m=$(rg -in opencode ../core/src/swarm-permission-baseline.ts test/permission/baseline.test.ts test/permission/baseline.proofs.sh 2>/dev/null | rg -v '@opencode-ai/|packages/opencode|OPENCODE_[A-Z_]+' | wc -l | tr -d " ")
if [ "${m:-1}" = "0" ] || [ -z "$m" ]; then ok 9 "zero non-keep brand mentions"; else bad 9 "$m non-keep matches"; fi

echo "SUMMARY: $pass passed, $fail failed"
[ $fail -eq 0 ]
