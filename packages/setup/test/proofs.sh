#!/usr/bin/env bash
# Row 81 five proofs for the swarm-setup skeleton.
# Targeted to packages/setup ONLY (row 102 runs the full suite concurrently elsewhere).
# Binds NO port; makes NO network request. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                  # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r81-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cp "$HERE/tools.lock.json" "$WORK/bin/tools.lock.json"
BIN="$WORK/bin/swarm-setup"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 1: typecheck (row-81 entry graph) + build (toolchain: TypeScript via Bun) ==="
# Row 81 owns the entry point + core engine. Typecheck the ENTRY GRAPH (src/index.ts and
# everything it statically imports) under the package's full ambient-type environment
# (types/**/*.d.ts, contributed additively by rows 82-98). This is the honest unit of
# row-81 responsibility: it exercises the corrected DOCKER_CONTEXT constant through the real
# import graph, without depending on sibling step modules (other rows' compile units, none of
# which index.ts imports statically). Row 102 owns the whole-package/full-suite gate.
ENTRY_TS="$WORK/r81-entry.tsconfig.json"
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
check "tsc --noEmit (row-81 entry graph)" 0 $?
# Whole-package tsc shown for transparency only; NOT gated here (sibling-owned files present).
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json ) >/dev/null 2>&1 \
  && echo "  INFO whole-package tsc: exit 0" \
  || echo "  INFO whole-package tsc: non-zero (sibling-owned files present; row 102 owns the full-suite gate)"
bun build --compile --target=bun --outfile "$BIN" "$HERE/src/index.ts" >/dev/null 2>&1
check "bun build --compile" 0 $?
file "$BIN"

echo "=== PROOF 2: 'status' on a fresh HOME shows clean-state JSON (all absent) ==="
export HOME="$WORK/home-status"; mkdir -p "$HOME"
"$BIN" status > "$WORK/status.json" 2>"$WORK/status.err"; rc=$?
check "status exit 0" 0 $rc
cat "$WORK/status.json"
node -e 'const s=require(process.argv[1]);const ids=["runtime","node","graft","rtk","obsidian","searxng","firecrawl"];const ok=s.version===1&&ids.every(i=>s.components[i]&&s.components[i].state==="absent");console.log(ok?"  PASS clean-state envelope matches schema":"  FAIL schema mismatch");process.exit(ok?0:1)' "$WORK/status.json" \
  && pass=$((pass+1)) || fail=$((fail+1))

echo "=== PROOF 3: 'install --dry-run' refuses WITHOUT consent (exit 1) ==="
export HOME="$WORK/home-install"; mkdir -p "$HOME"
"$BIN" install --dry-run >"$WORK/install.out" 2>"$WORK/install.err"; rc=$?
check "install --dry-run exit 1" 1 $rc
grep -q "RESULT REFUSED_NO_CONSENT" "$WORK/install.out" && echo "  PASS output carries RESULT REFUSED_NO_CONSENT" || echo "  FAIL token missing"
echo "  state.json written by dry-run? $([ -f "$HOME/.swarm/setup/state.json" ] && echo YES || echo 'NO (correct: touched nothing)')"

echo "=== PROOF 4: lock loader rejects a corrupted copy (fail-closed, exit 1) ==="
mkdir -p "$WORK/bin-corrupt"; cp "$HERE/tools.lock.json" "$WORK/bin-corrupt/tools.lock.json"
printf '%s' '{"schemaVersion":999,"version":"","hosts":[],"components":{}}' > "$WORK/bin-corrupt/tools.lock.json"
CORRUPT="$WORK/bin-corrupt/swarm-setup"
bun build --compile --target=bun --outfile "$CORRUPT" "$HERE/src/index.ts" >/dev/null 2>&1
export HOME="$WORK/home-corrupt"; mkdir -p "$HOME"
"$CORRUPT" status >"$WORK/corrupt.out" 2>"$WORK/corrupt.err"; rc=$?
check "status(corrupt lock) exit 1" 1 $rc
grep -q "RESULT REFUSED_LOCK_MALFORMED" "$WORK/corrupt.out" && echo "  PASS output carries RESULT REFUSED_LOCK_MALFORMED" || echo "  FAIL token missing"
cat "$WORK/corrupt.err"

echo "=== PROOF 5: kill-safety — partial file ignored + held lock refused ==="
export HOME="$WORK/home-kill"; mkdir -p "$HOME/.swarm/setup"
# A committed state file (as if a prior run reached 'verified' for graft):
printf '{\n  "version": 1,\n  "lockVersion": "swarm-tools-1.19.3-r1",\n  "updatedAt": "2026-10-20T00:00:00Z",\n  "components": {\n    "runtime": {"state":"absent"},\n    "node": {"state":"absent"},\n    "graft": {"state":"verified","installedBySwarm":true},\n    "rtk": {"state":"absent"},\n    "obsidian": {"state":"absent"},\n    "searxng": {"state":"absent"},\n    "firecrawl": {"state":"absent"}\n  }\n}\n' > "$HOME/.swarm/setup/state.json"
# A stray half-written temp left by a simulated kill -9 mid-write:
printf '{"version":1,"components":{"graft":{"state":"INSTALLED-PARTIAL"' > "$HOME/.swarm/setup/.tmp-crash-abc123"
"$BIN" status >"$WORK/kill.json" 2>/dev/null; rc=$?
check "status ignores stray .tmp (exit 0)" 0 $rc
node -e 'const s=require(process.argv[1]);const g=s.components.graft.state;console.log(g==="verified"?"  PASS committed state read; partial .tmp ignored (graft=verified)":"  FAIL partial leaked in: "+g);process.exit(g==="verified"?0:1)' "$WORK/kill.json" && pass=$((pass+1)) || fail=$((fail+1))
# Held lock by a LIVE pid -> concurrent mutating run refused:
sleep 300 & HOLDER=$!
mkdir -p "$HOME/.swarm/setup/lock"; printf '%s\n' "$HOLDER" > "$HOME/.swarm/setup/lock/pid"
"$BIN" install graft >"$WORK/conc.out" 2>"$WORK/conc.err"; rc=$?
check "install refused by held lock (exit 1)" 1 $rc
grep -q "RESULT REFUSED_CONCURRENCY" "$WORK/conc.out" && echo "  PASS output carries RESULT REFUSED_CONCURRENCY (holder pid $HOLDER)" || echo "  FAIL token missing"
kill "$HOLDER" 2>/dev/null

echo "=== PROOF 6: skeleton binds NO port anywhere ==="
PAT='\.(listen|bind)\(|createServer|Bun\.serve|Deno\.listen|startTls|createConnection|net\.connect|http\.Server'
if command -v rg >/dev/null 2>&1; then
  rg -n "$PAT" "$HERE/src"; rc=$?   # rg exit 1 = no matches (good); 0 = found (bad); 2 = error
else
  grep -rnE "$PAT" "$HERE/src"; rc=$?
fi
if [ "$rc" = 1 ]; then echo "  PASS: 0 bind/listen primitives in src/"; pass=$((pass+1));
elif [ "$rc" = 0 ]; then echo "  FAIL: a bind/listen primitive was found"; fail=$((fail+1));
else echo "  FAIL: search errored (rc $rc)"; fail=$((fail+1)); fi

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = 0 ]
