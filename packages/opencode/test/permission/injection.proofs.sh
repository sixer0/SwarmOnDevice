#!/usr/bin/env bash
# Row 110 proof battery — injection harness (masterplan/01f_tool_wiring_spec.md §11).
# Run from packages/opencode:  bash test/permission/injection.proofs.sh
# Every leg drives shipped code; nothing here re-implements the engine or the proxy.
set -u
cd "$(dirname "$0")/../.." || exit 1 # -> packages/opencode
OC_DIR=$(pwd)
SETUP_DIR="$(cd ../setup && pwd)"
# project-local bun, derived from cwd (no machine-specific path carried)
export PATH="$(cd ../../.. && pwd)/tools/node_modules/.bin:$PATH"
pass=0; fail=0
ok()  { echo "PROOF $1: PASS${2:+ — $2}"; pass=$((pass+1)); }
bad() { echo "PROOF $1: FAIL — $2"; fail=$((fail+1)); }

# PROOF 1 — opencode-side harness suite (T-W7-9 loop, T-W7-7-E, T-W7-11, T-W7-12)
out=$(bun test test/permission/injection.test.ts 2>&1); rc=$?
p=$(echo "$out" | awk '/^ *[0-9]+ pass$/{print $1; exit}'); f=$(echo "$out" | awk '/^ *[0-9]+ fail$/{print $1; exit}')
if [ $rc -eq 0 ] && [ "${f:-1}" = "0" ] && [ "${p:-0}" -ge 21 ]; then ok 1 "injection.test.ts ${p}pass/0fail"; else bad 1 "rc=$rc ${p:-?}pass/${f:-?}fail :: $(echo "$out" | tail -3 | tr '\n' ' ')"; fi

# PROOF 2 — setup-side harness suite (T-W7-1 expanded corpus, T-W7-2 via proxy, T-W7-5 live, T-W7-10 both surfaces)
out=$(cd "$SETUP_DIR" && bun test test/injection_harness.test.ts 2>&1); rc=$?
p=$(echo "$out" | awk '/^ *[0-9]+ pass$/{print $1; exit}'); f=$(echo "$out" | awk '/^ *[0-9]+ fail$/{print $1; exit}')
if [ $rc -eq 0 ] && [ "${f:-1}" = "0" ] && [ "${p:-0}" -ge 50 ]; then ok 2 "injection_harness.test.ts ${p}pass/0fail"; else bad 2 "rc=$rc ${p:-?}pass/${f:-?}fail :: $(echo "$out" | tail -3 | tr '\n' ' ')"; fi

# PROOF 3 — T-W7-11 shipped default: NO rewriting plugin anywhere in row 97's sources
m=$(rg -ln 'tool\.execute\.before|rewriteCommand|rtk hook|hook check' "$OC_DIR/../setup/src" 2>/dev/null | wc -l | tr -d ' ')
if [ "${m:-1}" = "0" ]; then ok 3 "zero rewriting hooks under packages/setup/src (measurement pinned by suite)"; else bad 3 "rewriting references found: $(rg -ln 'tool\.execute\.before|rewriteCommand|rtk hook|hook check' "$OC_DIR/../setup/src" | tr '\n' ' ')"; fi

# PROOF 4 — sandbox rule: every LISTEN is ephemeral (`port: 0`) and the only literal ports in
# the files are DEAD targets the policy must refuse pre-connect (9999/9). No estate port is
# ever bound or trusted by this harness.
listen_bad=$(rg -n 'port:\s*[1-9]' "$OC_DIR/test/permission/injection.test.ts" "$SETUP_DIR/test/injection_harness.test.ts" 2>/dev/null | wc -l | tr -d ' ')
if [ "${listen_bad:-1}" = "0" ]; then ok 4 "all listeners bind port 0; literal ports appear only as dead refusal targets"; else bad 4 "$listen_bad non-zero port bindings"; fi

# PROOF 5 — regression: r96 baseline suite (the engine layer this harness rides on)
out=$(bun test test/permission/baseline.test.ts 2>&1); rc=$?
p=$(echo "$out" | awk '/^ *[0-9]+ pass$/{print $1; exit}'); f=$(echo "$out" | awk '/^ *[0-9]+ fail$/{print $1; exit}')
if [ $rc -eq 0 ] && [ "${f:-1}" = "0" ] && [ "${p:-0}" -ge 15 ]; then ok 5 "baseline.test.ts ${p}pass/0fail"; else bad 5 "rc=$rc ${p:-?}pass/${f:-?}fail"; fi

# PROOF 6 — regression: r94 five mcp suites (their own combo shape)
out=$(cd "$SETUP_DIR" && bun test test/mcp_sanitiser.test.ts test/mcp_urlpolicy.test.ts test/mcp_audit.test.ts test/mcp_proxy.test.ts test/mcp_wiring.test.ts 2>&1); rc=$?
p=$(echo "$out" | awk '/^ *[0-9]+ pass$/{print $1; exit}'); f=$(echo "$out" | awk '/^ *[0-9]+ fail$/{print $1; exit}')
if [ $rc -eq 0 ] && [ "${f:-1}" = "0" ] && [ "${p:-0}" -ge 101 ]; then ok 6 "r94 mcp suites ${p}pass/0fail"; else bad 6 "rc=$rc ${p:-?}pass/${f:-?}fail"; fi

# PROOF 7 — regression: r95 vault suite (targeted, per its §5 HOME-coupling note)
out=$(cd "$SETUP_DIR" && bun test test/vault_wiring.test.ts 2>&1); rc=$?
p=$(echo "$out" | awk '/^ *[0-9]+ pass$/{print $1; exit}'); f=$(echo "$out" | awk '/^ *[0-9]+ fail$/{print $1; exit}')
if [ $rc -eq 0 ] && [ "${f:-1}" = "0" ] && [ "${p:-0}" -ge 37 ]; then ok 7 "vault_wiring.test.ts ${p}pass/0fail"; else bad 7 "rc=$rc ${p:-?}pass/${f:-?}fail"; fi

# PROOF 8 — typecheck both packages (harness files included in the opencode program)
(cd "$OC_DIR" && bun typecheck >/dev/null 2>&1) && tc_oc=0 || tc_oc=$?
(cd "$SETUP_DIR" && bun run typecheck >/dev/null 2>&1) && tc_su=0 || tc_su=$?
if [ $tc_oc -eq 0 ] && [ $tc_su -eq 0 ]; then ok 8 "opencode+setup typecheck exit 0"; else bad 8 "oc=$tc_oc setup=$tc_su"; fi

echo "SUMMARY: $pass passed, $fail failed"
[ $fail -eq 0 ]
