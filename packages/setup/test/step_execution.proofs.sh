#!/usr/bin/env bash
# Seam pass 8 — E2E proofs for the wired step-execution path (finding R113-1).
# Targeted to packages/setup ONLY (row 102 owns the full suite). Network posture: ZERO public
# network — the mock release server binds 127.0.0.1 on a probed pool port (PORT RULE: 47xxx,
# lsof probe before bind), exactly row 108's harness shape (tamper.proofs.sh). A throwaway CA is
# generated fresh per run (1-day validity, never committed); NODE_EXTRA_CA_CERTS trusts it for
# the spawned test processes ONLY — verification is never weakened in code. Writes land ONLY
# under $TMPDIR (sandbox HOMEs + private program dirs). No docker/VM work anywhere: stack steps
# are covered by their own fail-closed gates, this lane drives the CLI verb vs the mock server.
#
# WHAT THIS LANE PROVES (dispatch expectations b + c + d at shipped posture):
#   PROOF 4  binary-level regression pin: the compiled swarm-setup no longer carries the
#            "step execution is owned by" placeholder string that row 113 found in the SHIPPED
#            archive binary (verification/09_preinstall_security.md §8.1).
#   PROOF 6  (b) a NON-dry consented run installs node END-TO-END in a sandbox HOME: real TLS
#            fetch through the allow-listed loopback pin, real digest gate, real /usr/bin/tar
#            extraction, real private-binary health spawn, state.json outcome record per §4.2.
#   PROOF 7-9 (c) failure honesty: hash tamper, signature-gate refusal, and P-15 "one failed
#            optional component does not block the others" — all through the CLI verb.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"           # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                   # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"        # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-seam8-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/ca" "$WORK/homes" "$WORK/logs"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}
expect_line () { # expect_line <label> <file> <fixed-string>
  if grep -qF "$3" "$2"; then echo "  PASS $1"; pass=$((pass+1));
  else echo "  FAIL $1 (missing: $3)"; fail=$((fail+1)); fi
}
expect_absent () { # expect_absent <label> <file> <fixed-string>
  if grep -qF "$3" "$2"; then echo "  FAIL $1 (found: $3)"; fail=$((fail+1));
  else echo "  PASS $1"; pass=$((pass+1)); fi
}

echo "=== PROOF 1: entry-graph typecheck of the wired engine ==="
ENTRY_TS="$WORK/seam8-entry.tsconfig.json"
cat > "$ENTRY_TS" <<EOF
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022"], "module": "ESNext", "moduleResolution": "bundler",
    "types": [], "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "allowImportingTsExtensions": true, "resolveJsonModule": true,
    "esModuleInterop": true, "forceConsistentCasingInFileNames": true
  },
  "files": ["$HERE/src/index.ts"],
  "include": ["$HERE/types/**/*.d.ts"]
}
EOF
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$ENTRY_TS" )
check "tsc --noEmit (entry graph incl. dispatch)" 0 $?

echo "=== PROOF 2: compile the shipped-posture binary ==="
BIN="$WORK/bin/swarm-setup"
mkdir -p "$WORK/bin"
bun build --compile --target=bun --outfile "$BIN" "$HERE/src/index.ts" >/dev/null 2>&1
check "bun build --compile src/index.ts" 0 $?
file "$BIN"
file "$BIN" | grep -q "Mach-O 64-bit executable arm64" \
  && { echo "  PASS compiled subject is Mach-O arm64"; pass=$((pass+1)); } \
  || { echo "  FAIL compiled subject is not Mach-O arm64"; fail=$((fail+1)); }

echo "=== PROOF 3: throwaway CA + probed pool port (row-108 recipe) ==="
OPENSSL="$(command -v openssl || true)"
CA_OK=1
if [ -z "$OPENSSL" ]; then echo "  FAIL openssl not found"; fail=$((fail+1)); CA_OK=0
else
  ( cd "$WORK/ca" &&
    "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ca.key -out ca.pem -subj "/CN=SEAM8-MOCK-CA" -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 &&
    "$OPENSSL" req -new -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr -subj "/CN=127.0.0.1" >/dev/null 2>&1 &&
    printf "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > ext.cnf &&
    "$OPENSSL" x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -sha256 -extfile ext.cnf -out server.pem >/dev/null 2>&1 &&
    cat server.pem ca.pem > chain.pem )
  check "fixture CA + server cert generated" 0 $? || CA_OK=0
fi
PORT=""
for p in $(seq 47200 47999); do
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then PORT=$p; break; fi
done
if [ -z "$PORT" ]; then echo "  FAIL no free pool port"; fail=$((fail+1));
else echo "  probed free: $PORT (lsof LISTEN empty)"; check "pool port probed" 0 0; fi

echo "=== PROOF 4: REGRESSION PIN — placeholder string gone from the COMPILED binary ==="
# Row 113 proved the defect from the shipped archive binary with exactly this instrument:
#   rg -a -o 'consent recorded for .{0,90}' ./swarm-setup   ->  hit (09_preinstall_security.md §8.1)
# Post-fix the executable must NOT carry any fragment of that branch. (stderr is dropped: rg on a
# binary with a terminal stderr enters its interactive pager — that hang is a harness bug, not a result.)
rg -a -c 'step execution is owned by' "$BIN" >/dev/null 2>&1; rc=$?
if [ "$rc" = "1" ]; then echo "  PASS compiled binary carries NO 'step execution is owned by' string (rg exit 1)"; pass=$((pass+1));
else echo "  FAIL placeholder string present in compiled binary (rg exit $rc)"; fail=$((fail+1)); fi
rg -a -c 'which install nothing yet' "$BIN" >/dev/null 2>&1; rc=$?
if [ "$rc" = "1" ]; then echo "  PASS compiled binary carries NO 'which install nothing yet' string"; pass=$((pass+1));
else echo "  FAIL placeholder tail present (rg exit $rc)"; fail=$((fail+1)); fi

# run_scenario <name> <scenario> <expected-driver-exit> [extra token args handled by driver]
run_scenario () {
  local name="$1" scen="$2" xexit="$3"
  local home="$WORK/homes/$name"
  local scendir="$WORK/bin-$name"
  mkdir -p "$home" "$scendir"
  cp "$BIN" "$scendir/swarm-setup"
  local log="$WORK/logs/$name.log"
  local rc=0
  ( cd "$HERE" && bun test/step_execution.driver.ts --scenario "$scen" \
      --home "$home" --port "$PORT" --ca "$WORK/ca" --bin "$scendir/swarm-setup" ) > "$log" 2>&1 || rc=$?
  check "$name driver exit" "$xexit" "$rc"
  local fails
  fails=$(grep -c '^ASSERT FAIL' "$log" 2>/dev/null || true)
  if [ "${fails:-1}" = "0" ]; then echo "  PASS $name zero failed asserts"; pass=$((pass+1));
  else echo "  FAIL $name has ${fails:-?} failed asserts:"; grep '^ASSERT FAIL' "$log" | sed 's/^/    /'; fail=$((fail+1)); fi
  echo "  ---- $name evidence ----"
  sed 's/^/  | /' "$log"
  SCENARIO_HOME="$home"; SCENARIO_LOG="$log"
}

if [ -n "$PORT" ] && [ "$CA_OK" = "1" ]; then

echo "=== PROOF 5: (a) dry-run listing still holds, topological, zero-touch ==="
run_scenario dry-run dry-run 0

echo "=== PROOF 5b: consent gate still FIRST — bad token refuses with zero server hits ==="
run_scenario no-consent no-consent 0

echo "=== PROOF 6: (b) NON-dry consented run installs node end-to-end in the sandbox HOME ==="
run_scenario install-ok install-ok 0
NODE_BIN="$SCENARIO_HOME/.swarm/tools/node/v24.22.0/bin/node"
if [ -x "$NODE_BIN" ]; then echo "  PASS private node binary present + executable"; pass=$((pass+1))
else echo "  FAIL private node binary missing/not-executable at $NODE_BIN"; fail=$((fail+1)); fi
STATE_JSON="$SCENARIO_HOME/.swarm/setup/state.json"
# Small validator scripts run under the LOCAL bun (never the host node: this machine's node 26
# mis-parses inline -e scripts, and bun is the project toolchain anyway — rule 4).
cat > "$WORK/check-install.mjs" <<'EOF'
import { readFileSync } from "node:fs"
const s = JSON.parse(readFileSync(process.argv[2], "utf8"))
const n = (s.components && s.components.node) || {}
const ok = n.state === "healthy" && n.installedBySwarm === true && n.version === "v24.22.0" &&
  /^sha256:[0-9a-f]{64}$/.test(String(n.integrity)) && Array.isArray(n.paths) && n.paths.length >= 3
console.log(ok ? "  PASS state.json outcome record matches the 4.2 schema (healthy/installedBySwarm/version/integrity/paths)"
              : "  FAIL outcome record wrong: " + JSON.stringify(n))
process.exit(ok ? 0 : 1)
EOF
( cd "$HERE" && bun "$WORK/check-install.mjs" "$STATE_JSON" ) && pass=$((pass+1)) || fail=$((fail+1))
CONSENT_LOG="$SCENARIO_HOME/.swarm/setup/consent.log"
if [ -f "$CONSENT_LOG" ]; then
  CM=$(stat -f '%Lp' "$CONSENT_LOG"); SR=$(stat -f '%Lp' "$SCENARIO_HOME/.swarm/setup")
  [ "$CM" = "600" ] && { echo "  PASS consent.log mode 0600 (PC-PATH-03)"; pass=$((pass+1)); } || { echo "  FAIL consent.log mode $CM"; fail=$((fail+1)); }
  [ "$SR" = "700" ] && { echo "  PASS ~/.swarm/setup mode 0700 (PC-PATH-01)"; pass=$((pass+1)); } || { echo "  FAIL setup root mode $SR"; fail=$((fail+1)); }
else echo "  FAIL consent.log missing after granted run"; fail=$((fail+1)); fi
expect_line "consent line names non-interactive mode" "$CONSENT_LOG" '"mode":"non-interactive"'

echo "=== PROOF 7: (c) honest failure — pinned-hash tamper refuses and records failed ==="
run_scenario tamper tamper 0
[ ! -d "$SCENARIO_HOME/.swarm/tools/node/v24.22.0" ] \
  && { echo "  PASS tampered tarball promoted NOTHING under the version dir"; pass=$((pass+1)); } \
  || { echo "  FAIL tampered bytes produced a committed tree"; fail=$((fail+1)); }

echo "=== PROOF 8: (c) honest failure — step-internal signature-gate refusal propagates ==="
run_scenario sig-refusal sig-refusal 0
[ ! -d "$SCENARIO_HOME/.swarm/tools/rtk/v1.0.1" ] \
  && { echo "  PASS signature refusal left no committed rtk tree"; pass=$((pass+1)); } \
  || { echo "  FAIL refused artifact was committed anyway"; fail=$((fail+1)); }

echo "=== PROOF 9: (c) P-15 — a failed optional component does not block a later install ==="
run_scenario mixed mixed 0
cat > "$WORK/check-mixed.mjs" <<'EOF'
import { readFileSync } from "node:fs"
const s = JSON.parse(readFileSync(process.argv[2], "utf8"))
const ok = s.components.rtk.state === "failed" && s.components.node.state === "healthy"
console.log(ok ? "  PASS rtk stayed honestly failed while node reached healthy"
              : "  FAIL states wrong: rtk=" + s.components.rtk.state + " node=" + s.components.node.state)
process.exit(ok ? 0 : 1)
EOF
( cd "$HERE" && bun "$WORK/check-mixed.mjs" "$SCENARIO_HOME/.swarm/setup/state.json" ) && pass=$((pass+1)) || fail=$((fail+1))

echo "=== PROOF 10: registry parity + unit lane still green (the wiring did not drift the gate) ==="
( cd "$HERE" && bun run script/gen-steps.ts --check ) >/dev/null 2>&1
check "gen-steps --check parity OK" 0 $?
( cd "$HERE" && bun test test/step_execution.test.ts ) > "$WORK/unit.log" 2>&1
check "unit lane test/step_execution.test.ts" 0 $?
grep -E '^ [0-9]+ (pass|fail)' "$WORK/unit.log" | sed 's/^/  | /'

fi

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = 0 ]
