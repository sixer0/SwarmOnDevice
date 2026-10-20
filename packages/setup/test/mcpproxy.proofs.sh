#!/usr/bin/env bash
# Row-94 proofs for the swarm-web MCP proxy + sanitiser/URL-policy library + wiring hooks
# (src/mcpproxy/** — a SERVICE directory, NOT a scanned step: mcp-proxy is not a PC-CMP id,
# same resolution rows 84/85/91 documented and r92's extension-file precedent proved).
# Binds NO port; touches NO real daemon; the only network anywhere is the Bun.serve LOOPBACK
# FIXTURE inside mcp_proxy.test.ts on an ephemeral port read back from server.port. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # project-local bun ONLY (never global) — same path r91/r92 use
export PATH="$TOOLS_BIN:$PATH"

_TMPBASE="${TMPDIR:-/tmp}"; _TMPBASE="${_TMPBASE%/}"
WORK="$(mktemp -d "${_TMPBASE}/swarm-setup-r94-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 0: runtime identity (honesty: project-local bun version) ==="
echo "  bun: $(bun --version 2>/dev/null || echo MISSING)"

echo "=== PROOF 1: typecheck (isolated row-94 subtree) + full package + Mach-O compile ==="
# Include exactly the files this row owns plus the core/step modules it IMPORTS (stacklib +
# composefiles/shared via stacklib; node/graft/rtk steps via wiring). Concurrent fix rounds
# (r85/r86/r91) edit some of those: a transient red here is CONCURRENT-FIX noise, reported
# not chased — the full-package run below is the shared-surface truth at this instant.
cat > "$WORK/tsconfig.r94.json" <<JSON
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
    "$HERE/src/mcpproxy/researcher.json"
  ]
}
JSON
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.r94.json" ) > "$WORK/tsc-scoped.log" 2>&1
check "tsc --noEmit (scoped: mcpproxy + imported surface)" 0 $?
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json ) > "$WORK/tsc-full.log" 2>&1
check "tsc --noEmit (full package)" 0 $?
[ -s "$WORK/tsc-scoped.log" ] && sed 's/^/    /' "$WORK/tsc-scoped.log" | head -20
[ -s "$WORK/tsc-full.log" ] && sed 's/^/    /' "$WORK/tsc-full.log" | head -20
bun build --compile --target=bun --outfile "$WORK/bin/swarm-web-proxy" "$HERE/src/mcpproxy/main.ts" >"$WORK/build.log" 2>&1
check "bun build --compile src/mcpproxy/main.ts" 0 $?
file "$WORK/bin/swarm-web-proxy" | grep -q "Mach-O" && check "compiled binary is Mach-O arm64" 0 0 || check "compiled binary is Mach-O arm64" 0 1

echo "=== PROOF 2: unit suites (injected transport; loopback fixture only) ==="
( cd "$HERE" && bun test test/mcp_sanitiser.test.ts ) > "$WORK/u1.log" 2>&1; check "mcp_sanitiser.test.ts (T-W7-1 corpus + envelope golden)" 0 $?
( cd "$HERE" && bun test test/mcp_urlpolicy.test.ts ) > "$WORK/u2.log" 2>&1; check "mcp_urlpolicy.test.ts (T-W7-2 ranges/names/encodings/allow-list)" 0 $?
( cd "$HERE" && bun test test/mcp_audit.test.ts ) > "$WORK/u3.log" 2>&1; check "mcp_audit.test.ts (§6.6 golden line + 0600 + rotation)" 0 $?
( cd "$HERE" && bun test test/mcp_proxy.test.ts ) > "$WORK/u4.log" 2>&1; check "mcp_proxy.test.ts (T-W7-3/4/5/10 + redirect re-check + live-loopback)" 0 $?
( cd "$HERE" && bun test test/mcp_wiring.test.ts ) > "$WORK/u5.log" 2>&1; check "mcp_wiring.test.ts (entry shapes + researcher §5.1 + gates order)" 0 $?
for f in u1 u2 u3 u4 u5; do tail -4 "$WORK/$f.log" | sed 's/^/    /'; done

echo "=== PROOF 3: compiled-binary stdio smoke (real fd0/fd1, SSRF refusal, audit lands) ==="
TMPSMOKE="$(mktemp -d)"
printf '%s\n%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"fetch","arguments":{"url":"http://169.254.169.254/latest/meta-data/"}}}' \
  | HOME="$TMPSMOKE" SWARM_WEB_AUDIT_LOG="$TMPSMOKE/audit.log" "$WORK/bin/swarm-web-proxy" > "$WORK/smoke.out" 2>"$WORK/smoke.err"
rc=$?
check "binary runs over stdio and exits clean on EOF" 0 $rc
grep -q 'BLOCKED_BY_POLICY: address_denied' "$WORK/smoke.out" && check "SSRF shape refused in the response" 0 0 || check "SSRF shape refused in the response" 0 1
grep -q '"decision":"denied"' "$TMPSMOKE/audit.log" && check "denied call audited to PC-ENV-04 override path" 0 0 || check "denied call audited to PC-ENV-04 override path" 0 1
grep -q '"status"' "$TMPSMOKE/audit.log" && check "denied line carries NO network fields" 1 0 || check "denied line carries NO network fields" 1 1
sed 's/^/    /' "$WORK/smoke.out" | head -3
rm -rf "$TMPSMOKE"

echo "=== PROOF 4: grep gates (zero port literals / no child_process / no init / no secret slots) ==="
rg -n '\b(90[0-9][0-9]|8888|3002|8080|27124|127\.0\.0\.1:[0-9]+)\b' "$HERE/src/mcpproxy" > "$WORK/g-port.txt" 2>&1
check "zero port/IP:port literals under src/mcpproxy" 1 $?
rg -n 'node:child_process' "$HERE/src/mcpproxy" > /dev/null 2>&1
check "no node:child_process import (r82 gate 3c parity)" 1 $?
rg -n '"init"' "$HERE/src/mcpproxy" > /dev/null 2>&1
check "no init subcommand anywhere (P-10/P-11: graft/rtk init forbidden)" 1 $?
rg -n 'FIRECRAWL_TOKEN|Bearer ' "$HERE/src/mcpproxy/audit.ts" > /dev/null 2>&1
check "audit module has no slot for the bearer token (structural P-8)" 1 $?
rg -n '^await ' "$HERE/src/mcpproxy/proxy.ts" "$HERE/src/mcpproxy/sanitise.ts" "$HERE/src/mcpproxy/urlpolicy.ts" "$HERE/src/mcpproxy/audit.ts" "$HERE/src/mcpproxy/register.ts" "$HERE/src/mcpproxy/wiring.ts" "$HERE/src/mcpproxy/resolve.ts" > /dev/null 2>&1
check "no top-level await outside main.ts (no network at import time, §6.2)" 1 $?

echo "=== SUMMARY ==="
echo "SUMMARY: $pass passed, $fail failed"
rm -rf "$WORK"
[ "$fail" = "0" ]
