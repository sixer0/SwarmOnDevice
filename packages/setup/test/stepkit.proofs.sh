#!/usr/bin/env bash
# Row 84 proofs for the step-engine helpers (stepkit.ts) + redacting setup.log writer
# (setuplog.ts). Targeted to packages/setup ONLY (row 102 runs the full suite elsewhere).
# Binds NO port; makes NO network request (the fetch path is exercised through an
# instrumented spy in the unit tests). Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r84-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 1: typecheck + Mach-O compile (toolchain: TypeScript via Bun) ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
check "tsc --noEmit" 0 $?
bun build --compile --target=bun --outfile "$WORK/bin/swarm-setup" "$HERE/src/index.ts" >/dev/null 2>&1
check "bun build --compile index.ts (whole program)" 0 $?
file "$WORK/bin/swarm-setup"
bun build --compile --target=bun --outfile "$WORK/bin/stepkit" "$HERE/src/stepkit.ts" >/dev/null 2>&1
check "bun build --compile stepkit.ts (standalone)" 0 $?
bun build --compile --target=bun --outfile "$WORK/bin/setuplog" "$HERE/src/setuplog.ts" >/dev/null 2>&1
check "bun build --compile setuplog.ts (standalone)" 0 $?
file "$WORK/bin/stepkit" | grep -q "Mach-O" && echo "  PASS stepkit is Mach-O" || { echo "  FAIL stepkit not Mach-O"; fail=$((fail+1)); }

echo "=== PROOF 2: unit suite (consent gate / dry-run / redaction / transition guard) ==="
( cd "$HERE" && bun test test/stepkit.test.ts ) > "$WORK/bun-test.log" 2>&1
rc=$?
cat "$WORK/bun-test.log"
check "bun test test/stepkit.test.ts" 0 $rc

echo "=== PROOF 3: redaction before/after — a bearer + term-token line lands REDACTED ==="
export HOME="$WORK/home-redact"; mkdir -p "$HOME"
export R84_SETUPLOG="$HERE/src/setuplog.ts"
export R84_LOGPATH="$WORK/setup.log"
cat > "$WORK/redact-demo.ts" <<'TS'
const { registerSecretValue, writeSetupLog } = await import(process.env.R84_SETUPLOG);
const FAKE_BEARER = "sk_live_FAKEBEARERabc123XYZ";
const FAKE_TERM = "node@deadbeefcafe";
const FAKE_GEN = "GEN_postgres_pw_9f3a7c";
registerSecretValue(FAKE_GEN);
const msg = `installing node: Authorization: Bearer ${FAKE_BEARER}; admin token ${FAKE_TERM}; pw=${FAKE_GEN}`;
console.log("BEFORE (raw, what a naive logger would write):");
console.log("  " + msg);
writeSetupLog(
  { level: "info", source: "swarm-setup.node.install", component: "node", message: msg,
    context: { SEARXNG_SECRET: "leakme123", POSTGRES_PASSWORD: FAKE_GEN, engines: ["wikipedia"] },
    correlationId: "proof-3", ts: "2026-10-20T00:00:00.000Z" },
  { path: process.env.R84_LOGPATH },
);
TS
bun run "$WORK/redact-demo.ts" > "$WORK/redact.out" 2>&1
rc=$?
cat "$WORK/redact.out"
echo "AFTER (line actually written to setup.log):"
sed 's/^/  /' "$WORK/setup.log"
check "redaction demo ran" 0 $rc
# The written line must carry NONE of the secrets and MUST carry the redaction marker.
if grep -qE 'sk_live_FAKEBEARERabc123XYZ|deadbeefcafe|GEN_postgres_pw_9f3a7c|leakme123' "$WORK/setup.log"; then
  echo "  FAIL: a secret value survived into setup.log"; fail=$((fail+1))
else
  echo "  PASS: no bearer / term-token / generated secret present in setup.log"; pass=$((pass+1))
fi
grep -q '\[REDACTED\]' "$WORK/setup.log" && { echo "  PASS: [REDACTED] marker present"; pass=$((pass+1)); } || { echo "  FAIL: no redaction marker"; fail=$((fail+1)); }
# Mode discipline: setup.log created 0600.
MODE=$(stat -f '%Lp' "$WORK/setup.log" 2>/dev/null || stat -c '%a' "$WORK/setup.log")
[ "$MODE" = "600" ] && { echo "  PASS: setup.log mode 0600"; pass=$((pass+1)); } || { echo "  FAIL: setup.log mode $MODE (want 600)"; fail=$((fail+1)); }

echo "=== PROOF 4: security grep gates over the two NEW sources ==="
NEW=( "$HERE/src/stepkit.ts" "$HERE/src/setuplog.ts" )
# 4a. no bind/listen primitive added by row 84 (PORT RULE).
grep -nE '\.(listen|bind)\(|createServer|Bun\.serve|Deno\.listen|startTls|createConnection|net\.connect|http\.Server' "${NEW[@]}" >/dev/null 2>&1
check "4a no bind/listen primitive in stepkit.ts / setuplog.ts" 1 $?
# 4b. row 84 adds NO process-spawning or raw-network IMPORT (it CALLS row 82's library
#     through an injected seam; its own method literally named fetch() never hits a socket).
grep -nE 'from "node:child_process"|Bun\.spawn|spawnSync\(|execFile\(|execSync\(|from "node:(https?|net|dgram|tls)"|require\(["'\'']node:(https?|net|dgram|tls)' "${NEW[@]}" >/dev/null 2>&1
check "4b no spawn/raw-network import in the new sources" 1 $?
# 4c. forbidden TLS-weakening tokens (P-17) absent.
grep -nE 'rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|GIT_SSL_NO_VERIFY|ignore_ssl|--insecure' "${NEW[@]}" >/dev/null 2>&1
check "4c insecure-TLS tokens return nothing" 1 $?
# 4d. pipe-to-shell (P-3) absent.
grep -nE '\| *(ba|z)?sh|bash -c "\$\(|eval ' "${NEW[@]}" >/dev/null 2>&1
check "4d pipe-to-shell returns nothing" 1 $?

echo
echo "row-84 proofs: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
