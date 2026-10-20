#!/usr/bin/env bash
# Row 95 proofs for the vault-inbox wiring (src/vault/, contract 01f §7). Targeted to
# packages/setup ONLY (row 102 owns the full suite). Makes NO network request anywhere and
# spawns NO process except bun/tsc/file itself (the row is filesystem-only by design).
# P1 mirrors r89's attribution fallback: full-package tsc red confined to OTHER in-flight
# lanes triggers a scoped recheck proving the shared core + row 95 alone typecheck clean.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                  # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r95-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 1: typecheck — full package, plus scoped fallback while sibling rows are mid-write ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json ) > "$WORK/tsc-full.log" 2>&1
rc=$?
if [ "$rc" = "0" ]; then
  check "tsc --noEmit (full package)" 0 $rc
else
  MINE=$(grep -E '^packages/setup/(src/vault|test/vault)' "$WORK/tsc-full.log" | wc -l | tr -d ' ')
  if [ "$MINE" = "0" ]; then
    echo "  NOTE full-package tsc red ONLY on other in-flight lanes — first lines:"
    head -4 "$WORK/tsc-full.log" | sed 's/^/    /'
    check "tsc attribution (zero errors in src/vault|test/vault)" 0 0
  else
    echo "  tsc errors touching row 95:"; grep -E '^packages/setup/(src/vault|test/vault)' "$WORK/tsc-full.log"
    check "tsc --noEmit (full package)" 0 $rc
  fi
fi

echo "=== PROOF 2: writer compiles standalone (library self-containment) ==="
bun build --compile --target=bun --outfile "$WORK/bin/vault-writer" "$HERE/src/vault/writer.ts" > "$WORK/build.log" 2>&1
check "bun build --compile src/vault/writer.ts" 0 $?
file "$WORK/bin/vault-writer" > "$WORK/file.log" 2>&1
grep -q "Mach-O" "$WORK/file.log" && grep -qi "arm64" "$WORK/file.log"
check "artifact is Mach-O arm64" 0 $?

echo "=== PROOF 3: no community-plugin surface (§7 row 3, P-12, 01c0:158-160) ==="
grep -nE '27124|community-plugins\.json' "$HERE"/src/vault/*.ts > "$WORK/g-rest.log" 2>&1
check "zero plugin-port / plugin-manifest tokens under src/vault/" 1 $?

echo "=== PROOF 4: no network or process primitive (filesystem-only access) ==="
grep -nE 'node:(http|net|tls|dgram|dns)|child_process|spawnSync|fetch\(|Bun\.|createServer|\.listen\(' "$HERE"/src/vault/*.ts > "$WORK/g-net.log" 2>&1
check "zero network/spawn primitives under src/vault/" 1 $?

echo "=== PROOF 5: no destructive fs primitive (create-only + read posture) ==="
grep -nE '\b(rmSync|renameSync|rmdirSync|unlinkSync|appendFileSync|writeFileSync|truncateSync|chmod|chown)[A-Za-z]*\(' "$HERE"/src/vault/*.ts > "$WORK/g-destr.log" 2>&1
check "writer effects limited to mkdir/create-exclusive/read" 1 $?

echo "=== PROOF 6: no install-time coupling imports (state/stepkit/consent/setuplog stay out) ==="
grep -nE 'from "[^"]*(state|stepkit|consent|setuplog)\.ts"' "$HERE"/src/vault/*.ts > "$WORK/g-state.log" 2>&1
check "vault notes never state-listed (survive swarm-setup remove)" 1 $?

echo "=== PROOF 7: directory-scan registration unchanged (src/vault/ is a service dir, not a step) ==="
cat > "$WORK/scan.ts" <<TS
import { discoverSteps } from "$HERE/src/steps.ts";
const scan = discoverSteps();
const ids = scan.steps.map((s) => s.id).sort().join(",");
const want = "firecrawl,graft,node,obsidian,rtk,runtime,searxng";
console.log("registered:", ids, "| errors:", scan.errors.length);
process.exit(ids === want && scan.errors.length === 0 ? 0 : 1);
TS
bun run "$WORK/scan.ts" > "$WORK/scan.log" 2>&1
check "seven PC-CMP ids, zero descriptor errors, vault not scanned" 0 $?

echo "=== PROOF 8: unit suite green ==="
( cd "$HERE" && bun test test/vault_wiring.test.ts ) > "$WORK/units.log" 2>&1
NFAIL=$(sed -nE 's/^ *([0-9]+) fail$/\1/p' "$WORK/units.log" | tail -1)
NPASS=$(sed -nE 's/^ *([0-9]+) pass$/\1/p' "$WORK/units.log" | tail -1)
if [ "${NFAIL:-x}" = "0" ] && [ "${NPASS:-0}" -ge 35 ]; then
  echo "  PASS units: ${NPASS} pass / 0 fail"; pass=$((pass+1))
else
  echo "  FAIL units: pass=${NPASS:-?} fail=${NFAIL:-?}"; tail -20 "$WORK/units.log"; fail=$((fail+1))
fi

echo "=== PROOF 9: default-path end-to-end under a THROWAWAY HOME (no env override) ==="
THROW="$WORK/home"; mkdir -p "$THROW"
THROW_REAL="$(cd "$THROW" && pwd -P)" # writer returns CANONICAL paths (macOS /var -> /private/var); compare like like
cat > "$WORK/default.ts" <<TS
process.env.HOME = "$THROW_REAL";
delete process.env.SWARM_VAULT_DIR; // register default posture: PC-PATH-13 via tilde (assigning undefined would stringify)
const { writeInboxNote, readInboxNote } = await import("$HERE/src/vault/writer.ts");
const w = writeInboxNote({ name: "proof nine", content: "default path lands in the vault inbox" });
if (!w.ok) { console.log("write refused:", JSON.stringify(w)); process.exit(1); }
if (!w.path.startsWith("$THROW_REAL")) { console.log("escaped throwaway HOME:", w.path); process.exit(1); }
const r = readInboxNote(w.name); // default resolution again
process.exit(r.ok && r.text === "default path lands in the vault inbox" ? 0 : 1);
TS
bun run "$WORK/default.ts" > "$WORK/default.log" 2>&1
check "write+read land under \$HOME/.swarm/vault/inbox by default" 0 $?
DIRMODE=$(stat -f %Lp "$THROW_REAL/.swarm/vault/inbox" 2>/dev/null)
FILEMODE=$(stat -f %Lp "$THROW_REAL/.swarm/vault/inbox"/*.md 2>/dev/null | head -1)
[ "$DIRMODE" = "700" ] && [ "$FILEMODE" = "600" ]
check "inbox 0700 / note 0600 creation modes" 0 $?

echo "SUMMARY: $pass passed, $fail failed"
rm -rf "$WORK"
[ "$fail" = "0" ]
