#!/usr/bin/env bash
# Row 83 FIX2 — combined-run isolation proofs for the packages/setup test lane.
#
# Why this file exists: r95 routed a defect — running TEN sibling suites in ONE `bun test`
# process failed 4-5 consent-gate cases that pass individually. Root cause (diagnosed here):
# src/consent.ts kept its grant ledger in process memory, so grants leaked across suites;
# stepkit.test's "hasConsent() is false in a fresh process" case is only true if the ledger
# lives where the invariant actually lives — the durable consent.log of the CURRENT HOME.
# The fix made consentWasGranted() read the record; this script PROVES both matrices stay green:
#   MATRIX 1  every suite alone            (the historical posture)
#   MATRIX 2  every suite in ONE bun process (the shape that regressed)
#
# Preconditions handled here, not worked around: test/fetch.test.ts documents that its real-TLS
# fixture trusts a throwaway CA via NODE_EXTRA_CA_CERTS set BEFORE process launch (row 82 §4).
# A bare `bun test` without that env SELF-SKIPS those 23 cases with a reason naming R82_CA_DIR
# (row 82 FIX3) — honest skips, never silent passes; this runner generates the CA with the SAME
# recipe fetch.proofs.sh uses and exports both variables, so the combined run exercises the
# shipped code path unchanged (fetch.test.ts must show skip=0 here; any skip>0 means the env
# seam broke). fetch.proofs.sh reuses an inherited R82_CA_DIR instead of regenerating (no
# double CA when run under this script).
#
# Binds NO port (the fetch fixture binds port 0, OS-assigned — PORT RULE); makes NO public network
# request. Targeted to packages/setup ONLY. Safe to re-run.
set -u

PKG="$(cd "$(dirname "$0")/.." && pwd)"           # .../packages/setup
REPO="$(cd "$PKG/../.." && pwd)"                   # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="${TMPDIR:-/tmp}/swarm-setup-r83-combined"
rm -rf "$WORK"; mkdir -p "$WORK/ca"

pass=0; fail=0
check () { if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1)); else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi; }

# ---- throwaway CA (identical recipe to row 82's harness; 1-day validity, never committed) ----
OPENSSL="${OPENSSL:-}"; if [ -z "$OPENSSL" ]; then OPENSSL="$(command -v openssl || true)"; fi
if [ -z "$OPENSSL" ]; then echo "FAIL: openssl not found"; exit 1; fi
( cd "$WORK/ca" &&
  "$OPENSSL" req -x509 -newkey rsa:2048 -sha256 -days 1 -nodes -keyout ca.key -out ca.pem -subj "/CN=R83-COMBINED-CA" -addext "basicConstraints=critical,CA:TRUE" >/dev/null 2>&1 &&
  "$OPENSSL" req -new -newkey rsa:2048 -sha256 -nodes -keyout server.key -out server.csr -subj "/CN=127.0.0.1" >/dev/null 2>&1 &&
  printf "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n" > ext.cnf &&
  "$OPENSSL" x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -sha256 -extfile ext.cnf -out server.pem >/dev/null 2>&1 &&
  cat server.pem ca.pem > chain.pem )
check "throwaway CA generated" 0 $?
export R82_CA_DIR="$WORK/ca"
export NODE_EXTRA_CA_CERTS="$WORK/ca/ca.pem"

counts () { # counts <log> -> "<pass> <fail> <skip>" from bun's summary lines (" 450 pass" / " 28 fail" / " 23 skip")
  # FIX3: skip column added so row 82's self-skips (bare posture) stay visible in the
  # per-suite table instead of silently vanishing; this runner exports R82_CA_DIR so its
  # own runs must show skip=0 for fetch.test.ts (env posture = full execution).
  awk '$2=="pass"{p=$1+0} $2=="fail"{f=$1+0} $2=="skip"{s=$1+0} END{print p+0, f+0, s+0}' "$1"
}

echo "=== MATRIX 1: per-suite individual runs (each file alone) ==="
for f in "$PKG"/test/*.test.ts; do
  name="$(basename "$f")"
  ( cd "$PKG" && bun test "test/$name" ) >"$WORK/one-$name.log" 2>&1; rc=$?
  read -r p fl sk < <(counts "$WORK/one-$name.log")
  printf "  %-34s %3s pass / %3s fail / %3s skip  exit %s\n" "$name" "$p" "$fl" "$sk" "$rc"
  if [ "$rc" = "0" ] && [ "$fl" = "0" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "    --- tail:"; tail -5 "$WORK/one-$name.log" | sed 's/^/    /'; fi
done

echo "=== MATRIX 2: ALL suites in ONE bun process (the shape r95 routed) ==="
( cd "$PKG" && bun test test/ ) >"$WORK/combined.log" 2>&1; rc=$?
read -r p fl sk < <(counts "$WORK/combined.log")
echo "  combined: $p pass / $fl fail / $sk skip  exit $rc"
if [ "$rc" = "0" ] && [ "$fl" = "0" ]; then echo "  PASS combined single-process run green"; pass=$((pass+1)); else echo "  FAIL combined run red — failing cases:"; rg "^\(fail\)" "$WORK/combined.log" | head -10 | sed 's/^/    /'; fail=$((fail+1)); fi

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = 0 ]
