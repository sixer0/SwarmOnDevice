#!/usr/bin/env bash
# Row-97 proofs — managed policy enforcement + tool wiring completion (src/wiring/**).
#
# src/wiring/ is a SERVICE directory, NOT a scanned step (`wiring` is not a PC-CMP id; same
# resolution rows 84/85/91/94/95 documented). These modules are pure argv/env/schema builders plus
# one append-only audit-chain writer: they spawn NOTHING and open NO socket. Binds NO port; makes NO
# public network request; touches only a throwaway HOME. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # project-local bun ONLY (never global)
export PATH="$TOOLS_BIN:$PATH"

_TMPBASE="${TMPDIR:-/tmp}"; _TMPBASE="${_TMPBASE%/}"
WORK="$(mktemp -d "$_TMPBASE/swarm-setup-r97-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 0: runtime identity (honesty: project-local bun version) ==="
echo "  bun: $(bun --version 2>/dev/null || echo MISSING)"

echo "=== PROOF 1: typecheck (scoped row-97 subtree + imported surface) + full package ==="
cat > "$WORK/tsconfig.r97.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022"], "module": "ESNext", "moduleResolution": "bundler",
    "types": [], "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "verbatimModuleSyntax": false, "allowImportingTsExtensions": true,
    "resolveJsonModule": true, "esModuleInterop": true, "forceConsistentCasingInFileNames": true
  },
  "include": [
    "$HERE/types/**/*.d.ts",
    "$HERE/src/*.ts",
    "$HERE/src/stacklib.ts",
    "$HERE/src/composefiles/*.ts",
    "$HERE/src/steps/node/index.ts",
    "$HERE/src/steps/graft/index.ts",
    "$HERE/src/steps/rtk/index.ts",
    "$HERE/src/mcpproxy/*.ts",
    "$HERE/src/mcpproxy/researcher.json",
    "$HERE/src/vault/*.ts",
    "$HERE/src/wiring/*.ts"
  ]
}
JSON
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.r97.json" ) > "$WORK/tsc-scoped.log" 2>&1
check "tsc --noEmit (scoped: wiring + imported surface)" 0 $?
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json ) > "$WORK/tsc-full.log" 2>&1
check "tsc --noEmit (full package)" 0 $?
[ -s "$WORK/tsc-scoped.log" ] && sed 's/^/    /' "$WORK/tsc-scoped.log" | head -20
[ -s "$WORK/tsc-full.log" ] && sed 's/^/    /' "$WORK/tsc-full.log" | head -20

echo "=== PROOF 2: unit suites ==="
( cd "$HERE" && bun test test/audit_chain.test.ts )   > "$WORK/u1.log" 2>&1; check "audit_chain.test.ts (golden lines x3 kinds + durability + rotation + proxy conversion)" 0 $?
( cd "$HERE" && bun test test/wiring_policy.test.ts ) > "$WORK/u2.log" 2>&1; check "wiring_policy.test.ts (strict policy + graft guard + rtk wrapper)" 0 $?
( cd "$HERE" && bun test test/wiring_handoff.test.ts ) > "$WORK/u3.log" 2>&1; check "wiring_handoff.test.ts (row-98 assembly inputs)" 0 $?
for f in u1 u2 u3; do tail -4 "$WORK/$f.log" | sed 's/^/    /'; done

echo "=== PROOF 3: end-to-end against a throwaway HOME (policy active -> audit line; malformed -> fail-closed) ==="
HOME_DIR="$WORK/home"; rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR/.swarm/setup"
AUDIT="$WORK/audit.jsonl"
printf '{"forbidden":["graft"]}' > "$HOME_DIR/.swarm/setup/policy.json"
cat > "$WORK/driver.ts" <<TS
import { enforcePolicy } from "$HERE/src/wiring/policy_enforce.ts";
import { graftLaunchGuard } from "$HERE/src/wiring/graft_guard.ts";
import { buildRtkSkillArgv } from "$HERE/src/wiring/rtk_invocation.ts";

const res = enforcePolicy({ correlationId: "proof-3", now: () => "2026-10-20T00:00:00.000Z" });
if (!res.ok) { console.log("POLICY_FAILCLOSED"); process.exit(0); }
console.log("POLICY_ACTIVE=" + res.active + " count=" + res.forbidden.length);

// unknown-key variant must fail closed
import { writeFileSync } from "node:fs";
writeFileSync(process.env.HOME + "/.swarm/setup/policy.json", JSON.stringify({ forbidden: ["graft"], allowAll: true }));
const bad = enforcePolicy({});
console.log(bad.ok ? "UNKNOWN_KEY_ACCEPTED" : "UNKNOWN_KEY_REJECTED");

// graft launch guard records a tool_launch line
writeFileSync(process.env.HOME + "/.swarm/setup/policy.json", JSON.stringify({ forbidden: [] }));
const g = graftLaunchGuard({ launch: () => ({ ok: true as const, nodePath: "/home/u/.swarm/tools/node/v24/bin/node", cliPath: "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js" }), env: {}, now: () => "2026-10-20T00:00:00.001Z" });
console.log("GRAFT_GUARD=" + (g.ok ? "ok" : "refused:" + (!g.ok ? g.reason : "")));

// rtk wrapper refuses the deferred recall control
console.log("RTK_RECALL=" + (buildRtkSkillArgv("/abs/rtk", ["config", "recall", "disabled"]).ok ? "accepted" : "refused"));
TS
HOME="$HOME_DIR" SWARM_SETUP_AUDIT_LOG="$AUDIT" bun run "$WORK/driver.ts" > "$WORK/driver.out" 2>"$WORK/driver.err"
rc=$?
check "driver runs clean (exit 0)" 0 $rc
grep -q "POLICY_ACTIVE=true count=1" "$WORK/driver.out" && check "valid policy activates" 0 0 || check "valid policy activates" 0 1
grep -q "UNKNOWN_KEY_REJECTED" "$WORK/driver.out" && check "unknown top-level key fails closed" 0 0 || check "unknown top-level key fails closed" 0 1
grep -q "GRAFT_GUARD=ok" "$WORK/driver.out" && check "graft launch guard passes a clean entry" 0 0 || check "graft launch guard passes a clean entry" 0 1
grep -q "RTK_RECALL=refused" "$WORK/driver.out" && check "rtk wrapper refuses config recall (deferred to row 98)" 0 0 || check "rtk wrapper refuses config recall (deferred to row 98)" 0 1
grep -q '"kind":"policy_active"' "$AUDIT" && check "policy_active line landed in the unified chain" 0 0 || check "policy_active line landed in the unified chain" 0 1
grep -q '"kind":"tool_launch"' "$AUDIT" && check "tool_launch line landed in the unified chain" 0 0 || check "tool_launch line landed in the unified chain" 0 1
sed 's/^/    /' "$WORK/driver.out"

echo "=== PROOF 4: negative-surface grep gates ==="
rg -n 'node:child_process|Bun\.spawn|\.exec\(|execSync|spawnSync' "$HERE/src/wiring" > /dev/null 2>&1
check "no process-execution primitive in src/wiring (argv builders ONLY, nothing spawns)" 1 $?
rg -n '\b(90[0-9][0-9]|8888|3002|8080|27124|127\.0\.0\.1:[0-9]+)\b' "$HERE/src/wiring" > /dev/null 2>&1
check "zero port / IP:port literals under src/wiring (PORT RULE)" 1 $?
rg -n 'createServer|listen\(|net\.|http\.serve' "$HERE/src/wiring" > /dev/null 2>&1
check "no socket/listen anywhere in src/wiring" 1 $?
rg -n 'DO_NOT_TRACK' "$HERE/src/wiring/graft_guard.ts" > /dev/null 2>&1
check "DO_NOT_TRACK assertion present at the graft launch site (task b)" 0 $?
rg -n 'GRAFT_PROVIDER|GRAFT_API_KEY' "$HERE/src/wiring/graft_guard.ts" > /dev/null 2>&1
check "must-be-unset list asserted by name in graft_guard (01c0:194-198)" 0 $?
# the forbidden verbs must live ONLY as deny-data, never as a built command word after a binary path
rg -n '"init"|"telemetry"|"config"' "$HERE/src/wiring/rtk_invocation.ts" > /dev/null 2>&1
check "forbidden rtk verbs appear only as deny-list data (guard rejects them)" 0 $?

echo "=== SUMMARY ==="
echo "SUMMARY: $pass passed, $fail failed"
rm -rf "$WORK"
[ "$fail" = "0" ]
