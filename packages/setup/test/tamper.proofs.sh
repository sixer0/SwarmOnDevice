#!/usr/bin/env bash
# Row 108 — tamper matrix vs ONE local mock release server (bun.serve, real TLS).
# Targeted to packages/setup ONLY (row 102 owns the full suite). Network posture:
# ZERO public network — the fixture binds 127.0.0.1 on a probed pool port (PORT
# RULE: 47xxx CLI pool, lsof availability probe before bind). A throwaway CA is
# generated fresh per run (1-day validity, never committed); NODE_EXTRA_CA_CERTS
# trusts it for these test processes ONLY — verification is never weakened in code.
# Writes land ONLY under $TMPDIR/swarm-setup-r108-tamper (throwaway HOMEs). The
# one sanctioned read of the real home is the teamid-real probe running the real
# /usr/bin/codesign over the Obsidian.app staged by row 90's authorized real run.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"              # .../packages/setup/test
PKG="$(cd "$HERE/.." && pwd)"                       # .../packages/setup
REPO="$(cd "$PKG/../.." && pwd)"                     # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="${TMPDIR:-/tmp}/swarm-setup-r108-tamper"
rm -rf "$WORK"; mkdir -p "$WORK/ca" "$WORK/homes" "$WORK/logs"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

REAL_APP="$HOME/.swarm/tools/obsidian/v1.14.4/Obsidian.app"   # captured BEFORE any HOME redirect

echo "=== PROOF 1: typecheck unchanged (tsc --noEmit -p packages/setup/tsconfig.json) ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
check "tsc --noEmit" 0 $?

echo "=== PROOF 2: throwaway CA + server cert (same recipe as fetch.proofs.sh) ==="
OPENSSL="$(command -v openssl || true)"
if [ -z "$OPENSSL" ]; then echo "  FAIL openssl not found"; fail=$((fail+1));
else
  export R108_CA_DIR="$WORK/ca"
  ( cd "$R108_CA_DIR" &&
    "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ca.key -out ca.pem -subj "/CN=R108-TAMPER-CA" -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 &&
    "$OPENSSL" req -new -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr -subj "/CN=127.0.0.1" >/dev/null 2>&1 &&
    printf "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > ext.cnf &&
    "$OPENSSL" x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -sha256 -extfile ext.cnf -out server.pem >/dev/null 2>&1 &&
    cat server.pem ca.pem > chain.pem )
  check "fixture CA + cert generated" 0 $?
  export NODE_EXTRA_CA_CERTS="$R108_CA_DIR/ca.pem"
fi

echo "=== PROOF 3: pool-port probe (lsof, PORT RULE 47xxx) ==="
PORT=""
for p in $(seq 47100 47999); do
  if ! lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then PORT=$p; break; fi
done
if [ -z "$PORT" ]; then echo "  FAIL no free pool port"; fail=$((fail+1));
else
  echo "  probed free: $PORT (lsof LISTEN empty)"; check "pool port probed" 0 0
fi

# run_cell <component> <case> <expected-exit> <expected-token> [extra args...]
run_cell () {
  local comp="$1" cse="$2" xexit="$3" xtoken="$4"; shift 4
  local home="$WORK/homes/$comp"
  local log="$WORK/logs/$comp-$cse.log"
  local rc=0
  ( cd "$PKG" && bun test/tamper_matrix.driver.ts --case "$cse" --component "$comp" \
      --home "$home" --port "$PORT" "$@" ) > "$log" 2>&1 || rc=$?
  check "$comp/$cse exit" "$xexit" "$rc"
  local tokn
  tokn="$(grep -m1 '^TOKEN=' "$log" | cut -d= -f2)"
  if [ "$tokn" = "$xtoken" ]; then echo "  PASS $comp/$cse token=$tokn"; pass=$((pass+1));
  else echo "  FAIL $comp/$cse token (expected $xtoken got '${tokn:-<none>}')"; fail=$((fail+1)); fi
  # EXTERNAL staging-cleanliness proof (independent of the driver's own asserts):
  # after a refusal, NOTHING may exist under the throwaway HOME except the audit
  # trail (setup.log / provenance.jsonl / state.json / lock dir) and graft's mock
  # private-node placeholder (outside .swarm by construction).
  case "$cse" in
    hash|downgrade-pin|downgrade-redirect|midstream|offline)
      local stray
      stray="$(find "$home/.swarm" -type f 2>/dev/null | grep -vE '/setup/(setup\.log|provenance\.jsonl|state\.json)$' | grep -v '/setup/lock/' || true)"
      if [ -z "$stray" ]; then echo "  PASS $comp/$cse staging-clean (external find: zero stray files)"; pass=$((pass+1));
      else echo "  FAIL $comp/$cse staging-clean — stray files:"; echo "$stray"; fail=$((fail+1)); fi
      ;;
  esac
  echo "  ---- $comp/$cse evidence ----"
  sed 's/^/  | /' "$log"
}

if [ -n "$PORT" ] && [ -n "${R108_CA_DIR:-}" ]; then

echo "=== PROOF 4: the matrix — runtime (library level: brew-channel step has no fetch path) ==="
mkdir -p "$WORK/homes/runtime"
run_cell runtime hash               1 FAILED
run_cell runtime downgrade-pin      1 FAILED
run_cell runtime downgrade-redirect 1 FAILED
run_cell runtime midstream          1 BLOCKED_BY_NETWORK
run_cell runtime offline            1 BLOCKED_BY_NETWORK
run_cell runtime fetch              0 OK
run_cell runtime resumed            0 OK
run_cell runtime guest-image        0 SKIPPED_WITH_INSTRUCTIONS

echo "=== PROOF 5: the matrix — node (step level, real downloader) ==="
mkdir -p "$WORK/homes/node"
run_cell node hash                  1 FAILED
run_cell node downgrade-pin         1 FAILED
run_cell node downgrade-redirect    1 FAILED
run_cell node midstream             1 BLOCKED_BY_NETWORK
run_cell node offline               1 BLOCKED_BY_NETWORK
run_cell node fetch                 0 OK
run_cell node resumed               0 OK

echo "=== PROOF 6: the matrix — graft (step level, real downloader) ==="
mkdir -p "$WORK/homes/graft"
run_cell graft hash                 1 FAILED
run_cell graft downgrade-pin        1 FAILED
run_cell graft downgrade-redirect   1 FAILED
run_cell graft midstream            1 BLOCKED_BY_NETWORK
run_cell graft offline              1 BLOCKED_BY_NETWORK
run_cell graft fetch                0 OK
run_cell graft resumed              0 OK

echo "=== PROOF 7: the matrix — rtk (step level, real downloader) ==="
mkdir -p "$WORK/homes/rtk"
run_cell rtk hash                   1 FAILED
run_cell rtk downgrade-pin          1 FAILED
run_cell rtk downgrade-redirect     1 FAILED
run_cell rtk midstream              1 BLOCKED_BY_NETWORK
run_cell rtk offline                1 BLOCKED_BY_NETWORK
run_cell rtk fetch                  0 OK
run_cell rtk resumed                0 OK

echo "=== PROOF 8: the matrix — obsidian (step level; TeamID cell gets its own fresh HOME) ==="
mkdir -p "$WORK/homes/obsidian"
run_cell obsidian hash              1 FAILED
run_cell obsidian downgrade-pin     1 FAILED
run_cell obsidian downgrade-redirect 1 FAILED
run_cell obsidian midstream         1 BLOCKED_BY_NETWORK
run_cell obsidian offline           1 BLOCKED_BY_NETWORK
run_cell obsidian fetch             0 OK
run_cell obsidian resumed           0 OK
mkdir -p "$WORK/homes/obsidian-teamid"
# teamid refusal leaves the PASSED-digest dmg on disk (state-listed artifact, not
# staging debris) — the external stray-file scan therefore allows *.dmg in this home.
rc=0
( cd "$PKG" && bun test/tamper_matrix.driver.ts --case teamid --component obsidian \
    --home "$WORK/homes/obsidian-teamid" --port "$PORT" ) > "$WORK/logs/obsidian-teamid.log" 2>&1 || rc=$?
check "obsidian/teamid exit" 1 "$rc"
tokn="$(grep -m1 '^TOKEN=' "$WORK/logs/obsidian-teamid.log" | cut -d= -f2)"
if [ "$tokn" = "FAILED" ]; then echo "  PASS obsidian/teamid token=FAILED"; pass=$((pass+1));
else echo "  FAIL obsidian/teamid token (expected FAILED got '${tokn:-<none>}')"; fail=$((fail+1)); fi
stray="$(find "$WORK/homes/obsidian-teamid/.swarm" -type f 2>/dev/null | grep -vE '/setup/(setup\.log|provenance\.jsonl|state\.json)$' | grep -v '/setup/lock/' | grep -v '\.dmg$' || true)"
if [ -z "$stray" ]; then echo "  PASS obsidian/teamid staging-clean (no .stage-*/mount debris; only the verified dmg remains)"; pass=$((pass+1));
else echo "  FAIL obsidian/teamid staging-clean — stray:"; echo "$stray"; fail=$((fail+1)); fi
echo "  ---- obsidian/teamid evidence ----"
sed 's/^/  | /' "$WORK/logs/obsidian-teamid.log"

echo "=== PROOF 9: wrong-TeamID at the REAL verify gate (codesign+spctl over the staged app) ==="
if [ -d "$REAL_APP" ]; then
  rc=0
  ( cd "$PKG" && bun test/tamper_matrix.driver.ts --case teamid-real --component obsidian \
      --home "$WORK/homes/obsidian-teamid-real" --port "$PORT" --app "$REAL_APP" ) \
      > "$WORK/logs/teamid-real.log" 2>&1 || rc=$?
  check "obsidian/teamid-real probe exit" 0 "$rc"
  echo "  ---- teamid-real evidence ----"
  sed 's/^/  | /' "$WORK/logs/teamid-real.log"
else
  echo "  SKIP teamid-real — no staged Obsidian.app at $REAL_APP (honest skip, reason named)"
fi

echo "=== PROOF 10: provenance-ledger integrity across each component's whole block ==="
for comp in runtime node graft rtk obsidian; do
  rc=0
  ( cd "$PKG" && bun test/tamper_matrix.driver.ts --case audit --component "$comp" \
      --home "$WORK/homes/$comp" --port "$PORT" ) > "$WORK/logs/audit-$comp.log" 2>&1 || rc=$?
  check "audit/$comp ledger integrity" 0 "$rc"
  grep -c '^PROVENANCE ' "$WORK/logs/audit-$comp.log" > /dev/null && \
    echo "  INFO $comp ledger lines: $(grep -c '^PROVENANCE ' "$WORK/logs/audit-$comp.log")"
done

echo "=== PROOF 11: regression — row-82 proofs still green (this row is additive-only) ==="
( cd "$PKG" && bash test/fetch.proofs.sh ) > "$WORK/logs/r82-regression.log" 2>&1
rc=$?
tail -3 "$WORK/logs/r82-regression.log"
check "fetch.proofs.sh regression" 0 $rc

fi # PORT + CA

echo
echo "row-108 proofs: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
