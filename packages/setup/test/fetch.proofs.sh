#!/usr/bin/env bash
# Row 82 proofs for the fetch/verify/provenance library.
# Targeted to packages/setup ONLY (row 102 runs the full suite concurrently elsewhere).
# Network posture: NO public network. The test fixture binds bun.serve on port 0
# (OS-assigned ephemeral, per the PORT RULE in decisions.md 2026-10-20) over a
# throwaway self-signed CA generated fresh per run; NODE_EXTRA_CA_CERTS trusts
# that CA for THIS TEST PROCESS ONLY — verification is never weakened in code.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"              # .../packages/setup/test
PKG="$(cd "$HERE/.." && pwd)"                       # .../packages/setup
REPO="$(cd "$PKG/../.." && pwd)"                     # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r82-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/ca"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 1: typecheck (tsc --noEmit -p packages/setup/tsconfig.json) ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
check "tsc --noEmit" 0 $?

echo "=== PROOF 2: unit suite against the local TLS fixture (port 0, zero public network) ==="
# FIX3: an outer runner (combined.proofs.sh) may already have generated a throwaway
# CA and exported R82_CA_DIR. Reuse it when usable — never double-generate. Only a
# standalone run with no inherited CA generates its own.
if [ -n "${R82_CA_DIR:-}" ] && [ -f "${R82_CA_DIR}/server.key" ] && [ -f "${R82_CA_DIR}/chain.pem" ]; then
  echo "  reusing inherited R82_CA_DIR=$R82_CA_DIR (no second CA generated)"
  [ -n "${NODE_EXTRA_CA_CERTS:-}" ] || export NODE_EXTRA_CA_CERTS="${R82_CA_DIR}/ca.pem"
else
  OPENSSL="${OPENSSL:-}"
  if [ -z "$OPENSSL" ]; then OPENSSL="$(command -v openssl || true)"; fi
  if [ -z "$OPENSSL" ]; then echo "  FAIL openssl not found (brew openssl expected at /opt/homebrew/bin/openssl)"; fail=$((fail+1));
  else
    export R82_CA_DIR="$WORK/ca"
    ( cd "$R82_CA_DIR" &&
      "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ca.key -out ca.pem -subj "/CN=R82-TEST-CA" -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 &&
      "$OPENSSL" req -new -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr -subj "/CN=127.0.0.1" >/dev/null 2>&1 &&
      printf "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > ext.cnf &&
      "$OPENSSL" x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -sha256 -extfile ext.cnf -out server.pem >/dev/null 2>&1 &&
      cat server.pem ca.pem > chain.pem )   # serve leaf+CA: bun's verifier needs the chain present
    rc=$?
    check "fixture CA + cert generated" 0 $rc
    export NODE_EXTRA_CA_CERTS="$R82_CA_DIR/ca.pem"
  fi
fi
if [ -n "${R82_CA_DIR:-}" ]; then
  # MATRIX env-run: R82_CA_DIR present => the real-TLS cases EXECUTE (bare runs
  # self-skip them with a named reason; see fetch.test.ts FIX3 header). Count is
  # read back from the log so the label never goes stale when tests are added.
  ( cd "$PKG" && bun test test/fetch.test.ts ) > "$WORK/bun-test.log" 2>&1
  rc=$?
  cat "$WORK/bun-test.log"
  n=$(awk '$2=="pass"{p=$1+0} END{print p+0}' "$WORK/bun-test.log")
  check "bun test test/fetch.test.ts (env posture: $n execute)" 0 $rc
fi

echo "=== PROOF 3: security grep gates (P-3 / P-17 / no-exec-of-downloaded-content) ==="
# FIX3 scan scope: row 82's OWN modules (fetch/verify/provenance), the row-81 core
# modules (top-level src/*.ts), and row 82's own test files. Deliberately NOT
# src/steps/** nor sibling rows' tests: those have their own owners and proof
# scripts, and a package-wide token grep repeatedly false-positives on their
# legitimate code (r86's /image|digest|sha/i regex hit 3a; r87 flagged child_process
# imports in future steps hitting 3c). The guarantees below are exactly what row 82
# owns; each step author carries the same gates in their own proofs.
ROW82_FILES=( "$PKG/src/fetch.ts" "$PKG/src/verify.ts" "$PKG/src/provenance.ts" "$PKG/test/fetch.test.ts" "$PKG/test/fetch.proofs.sh" )
CORE_FILES=( "$PKG"/src/*.ts )   # top-level only; excludes steps/ by glob depth
ts_grep () { # ts_grep <regex> <files...> — fixed-string -F per token would lose the ERE; keep -E over an explicit file list
  local re="$1"; shift
  grep -nE "$re" "$@" >/dev/null 2>&1
}
# 3a. pipe-to-shell in row-82-owned sources/tests (P-3): must be ZERO matches.
#     (.sh self-reference tolerated: a verifier must contain the pattern it forbids.)
ts_grep '\| *(ba|z)?sh|bash -c "\$\(|eval ' "$PKG/src/fetch.ts" "$PKG/src/verify.ts" "$PKG/src/provenance.ts" "$PKG/test/fetch.test.ts"
check "3a pipe-to-shell grep returns nothing (row-82 files)" 1 $?
# 3b. forbidden TLS-weakening tokens across ALL shipped core+row82 sources (P-17): ZERO.
ts_grep 'rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|GIT_SSL_NO_VERIFY|ignore_ssl|--insecure' "${CORE_FILES[@]}" "$PKG/test/fetch.test.ts"
check "3b insecure-TLS tokens return nothing" 1 $?
# 3c. within row 82's own surface, child_process is IMPORTED only in verify.ts.
grep -n 'from "node:child_process"' "$PKG/src/fetch.ts" "$PKG/src/provenance.ts" >/dev/null 2>&1
check "3c child_process absent from fetch.ts + provenance.ts" 1 $?
grep -n 'from "node:child_process"' "$PKG/src/verify.ts" >/dev/null 2>&1
check "3c companion: verify.ts DOES import it (signature gate present)" 0 $?
# 3d. every spawnSync CALL SITE passes a system-binary constant, never a staged path.
grep -n 'spawnSync(' "$PKG/src/verify.ts" | grep -vE 'CODESIGN_PATH|SPCTL_PATH' >/dev/null 2>&1
check "3d spawnSync only ever on system-binary constants" 1 $?

echo "=== PROOF 4: fetch.ts (the downloader) contains no import or call of any process-spawning API ==="
grep -nE 'from "node:child_process"|Bun\.spawn|spawnSync\(|execFile\(|child_process' "$PKG/src/fetch.ts" >/dev/null 2>&1
check "fetch.ts free of exec primitives" 1 $?

echo
echo "row-82 proofs: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
