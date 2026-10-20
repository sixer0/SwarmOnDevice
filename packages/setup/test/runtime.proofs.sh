#!/usr/bin/env bash
# Row 86 proofs for the runtime step (src/steps/runtime/): Colima profile `swarm`,
# preflight floors, D-13 guest-image capture, context isolation, dry-run zero-exec.
# Targeted to packages/setup ONLY (row 102 runs the full suite elsewhere).
# Binds NO port; makes NO network request; starts NO VM (row 93 runs stacks, row 112
# verifies). The only host commands are READ-ONLY listings (`colima list`,
# `docker context ls`) captured before/after dry-runs to prove NON-INTERFERENCE with the
# live `default` profile. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r86-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cp "$HERE/tools.lock.json" "$WORK/bin/tools.lock.json"
BIN="$WORK/bin/swarm-setup"

LOCK_SHA_BEFORE="$(shasum -a 256 "$HERE/tools.lock.json" | cut -d' ' -f1)"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 1: typecheck + Mach-O compile (toolchain: TypeScript via Bun) ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
check "tsc --noEmit" 0 $?
bun build --compile --target=bun --outfile "$BIN" "$HERE/src/index.ts" >/dev/null 2>&1
check "bun build --compile index.ts (whole program)" 0 $?
file "$BIN" | grep -q "Mach-O" && { echo "  PASS whole program is Mach-O arm64"; pass=$((pass+1)); } || { echo "  FAIL not Mach-O"; fail=$((fail+1)); }
bun build --compile --target=bun --outfile "$WORK/bin/runtime-step" "$HERE/src/steps/runtime/index.ts" >/dev/null 2>&1
check "bun build --compile steps/runtime/index.ts (standalone)" 0 $?

echo "=== PROOF 2: unit suite (preflight refusals incl. fake-old-macOS / dry-run zero-exec / mocked cycle) ==="
( cd "$HERE" && bun test test/runtime.test.ts ) > "$WORK/bun-test.log" 2>&1
check "bun test test/runtime.test.ts" 0 $?
grep -qE "^[[:space:]]*[0-9]+ pass" "$WORK/bun-test.log" && tail -4 "$WORK/bun-test.log"

echo "=== PROOF 3: descriptor + scan registration + instrumented dry-run zero-exec ==="
cat > "$WORK/r86-harness.ts" <<'TS'
// Drives the landed modules directly: registration integrity + the zero-exec guarantee
// measured by the SAME counters a real run uses (print-only runner cannot execute).
import { mkdtempSync, existsSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const home = mkdtempSync(join(tmpdir(), "swarm-r86-proof-"));
process.env.HOME = home;
const { validateDescriptor, discoverSteps, orderSteps } = await import(process.env.R86_STEPSMOD!);
const { loadLock } = await import(process.env.R86_LOCKMOD!);
const { readFileSync } = await import("node:fs");
const raw = JSON.parse(readFileSync(join(process.env.R86_PKG!, "src/steps/runtime/step.json"), "utf8"));
const v = validateDescriptor(raw, "runtime");
if (!v.ok) { console.error("descriptor invalid:", v.error); process.exit(1); }
const scan = discoverSteps();
if (scan.errors.length > 0) { console.error("scan errors:", scan.errors); process.exit(1); }
if (!scan.steps.some((s: any) => s.id === "runtime")) { console.error("runtime not registered"); process.exit(1); }
const ordered = orderSteps(scan.steps);
if (!ordered.ok) { console.error("ordering failed"); process.exit(1); }
const pos = (id: string) => ordered.ordered.findIndex((s: any) => s.id === id);
for (const s of scan.steps) if (s.requires.includes("runtime") && pos("runtime") >= pos(s.id)) { console.error("order violates requires"); process.exit(1); }

const lockRes = await loadLock();
if (!lockRes.ok) { console.error("loadLock failed:", lockRes.error); process.exit(1); }
const { installWithDeps } = await import(process.env.R86_STEP!);
const { printOnlyRunner } = await import(process.env.R86_CMDS!);
const runner = printOnlyRunner();
const st = { version: 1, lockVersion: lockRes.lock.version, updatedAt: new Date().toISOString(), components: {} as any };
const res = await installWithDeps({ lock: lockRes.lock, state: st, dryRun: true }, { runner, consentGate: () => true, consentFirecrawl: true });
if (res.token !== "OK") { console.error("dry-run token:", res.token); process.exit(1); }
if (runner.executedCount !== 0) { console.error("EXECUTED during dry-run:", runner.executedCount); process.exit(1); }
if (runner.printed.length < 10) { console.error("printed too few commands:", runner.printed.length); process.exit(1); }
const all = runner.printed.join("\n");
for (const needle of ["--profile swarm", "--vm-type vz", "--activate=false", "<observed:", "context ls"]) {
  if (!all.includes(needle)) { console.error("plan missing:", needle); process.exit(1); }
}
if (all.includes("--accept-license")) { console.error("vendor license flag present"); process.exit(1); }
if (existsSync(join(home, ".swarm"))) { console.error("dry-run wrote into HOME"); process.exit(1); }
console.log(`harness ok: ${runner.printed.length} commands printed, ${runner.executedCount} executed, HOME untouched, descriptor+scan clean`);
TS
export R86_PKG="$HERE" R86_STEPSMOD="$HERE/src/steps.ts" R86_LOCKMOD="$HERE/src/lockfile.ts" R86_STEP="$HERE/src/steps/runtime/index.ts" R86_CMDS="$HERE/src/steps/runtime/commands.ts"
# source-run lock posture: stage the shipped lock next to src/ exactly as rows 82-85 do.
STAGED=""
[ -f "$HERE/src/tools.lock.json" ] || { cp "$HERE/tools.lock.json" "$HERE/src/tools.lock.json"; STAGED="yes"; }
bun "$WORK/r86-harness.ts"
hc=$?
[ -n "$STAGED" ] && rm -f "$HERE/src/tools.lock.json"
check "descriptor + scan + dry-run zero-exec harness" 0 $hc

echo "=== PROOF 4: compiled binary install --dry-run refuses without consent AND lists runtime in scan order ==="
export HOME="$WORK/home-dry"; mkdir -p "$HOME"
"$BIN" install --dry-run >"$WORK/dry.out" 2>"$WORK/dry.err"; rc=$?
check "exit 1 (REFUSED_NO_CONSENT contract, row-81 PROOF 3 preserved)" 1 $rc
grep -q "RESULT REFUSED_NO_CONSENT" "$WORK/dry.out" && { echo "  PASS RESULT token"; pass=$((pass+1)); } || { echo "  FAIL token"; fail=$((fail+1)); }
grep -q -- "- runtime" "$WORK/dry.out" && { echo "  PASS runtime appears in would-run order"; pass=$((pass+1)); } || { echo "  FAIL runtime not listed"; fail=$((fail+1)); }
grep -q "step descriptor error" "$WORK/dry.err" && { echo "  FAIL scan broke"; cat "$WORK/dry.err"; fail=$((fail+1)); } || { echo "  PASS scan intact (zero descriptor errors)"; pass=$((pass+1)); }

echo "=== PROOF 5: NON-INTERFERENCE with the live host (read-only listings byte-identical across dry-runs) ==="
if command -v colima >/dev/null 2>&1; then
  colima list > "$WORK/profiles.before" 2>&1; colima list --json > "$WORK/profiles-json.before" 2>&1
else
  : > "$WORK/profiles.before"; : > "$WORK/profiles-json.before"; echo "  (colima absent on this host — listing empty, still compared)"
fi
docker context ls > "$WORK/contexts.before" 2>&1 || true
# repeat the zero-touch postures: compiled dry-run x2 + harness already ran above
HOME="$WORK/home-dry" "$BIN" install --dry-run >/dev/null 2>&1 || true
HOME="$WORK/home-dry" "$BIN" remove --dry-run >/dev/null 2>&1 || true
if command -v colima >/dev/null 2>&1; then
  colima list > "$WORK/profiles.after" 2>&1; colima list --json > "$WORK/profiles-json.after" 2>&1
  # MEASURED: with ZERO profiles, colima prints a timestamped diagnostic line
  # (`time="..." level=warning msg="No instance found..."`) that differs by wall-clock
  # seconds between any two captures. It is log noise, not profile state: normalize ONLY
  # that line; the PROFILE table, its rows, and the JSON payload stay byte-compared.
  norm () { sed 's/^time="[^"]*" level=warning//' "$1"; }
  diff <(norm "$WORK/profiles.before") <(norm "$WORK/profiles.after") >/dev/null && diff -q "$WORK/profiles-json.before" "$WORK/profiles-json.after" >/dev/null
  check "colima profiles listing byte-identical before/after modulo timestamped diagnostic (default profile untouched)" 0 $?
else
  diff -q "$WORK/profiles.before" "$WORK/profiles.after" >/dev/null
  check "colima absent before AND after (no install happened)" 0 $?
fi
docker context ls > "$WORK/contexts.after" 2>&1 || true
diff -q "$WORK/contexts.before" "$WORK/contexts.after" >/dev/null
check "docker context table byte-identical before/after (current marker unmoved)" 0 $?

echo "=== PROOF 6: tools.lock.json stays byte-identical (READ-ONLY posture, D-13 records land elsewhere) ==="
LOCK_SHA_AFTER="$(shasum -a 256 "$HERE/tools.lock.json" | cut -d' ' -f1)"
[ "$LOCK_SHA_BEFORE" = "$LOCK_SHA_AFTER" ]
check "sha256 unchanged after every proof above ($LOCK_SHA_BEFORE)" 0 $?
node -e 'const l=require(process.argv[1]);const g=l.components.runtime.guest_image;process.exit(g.url===null&&g.version===null&&g.sha256===null?0:1)' "$HERE/tools.lock.json"
check "guest_image url/version/sha256 STILL null in the lock (capture writes state+ledgers, never the lock)" 0 $?

echo "=== PROOF 7: security grep gates over src/steps/runtime (all zero-match) ==="
grep -rnE 'sudo|osascript|administrator' "$HERE/src/steps/runtime" >/dev/null 2>&1
check "7a no sudo/osascript/administrator strings (blueprint row-86 gate)" 1 $?
grep -rn 'from "node:child_process"' "$HERE/src/steps/runtime" >/dev/null 2>&1
check "7b node:child_process import NOT widened beyond verify.ts (fetch.proofs 3c parity)" 1 $?
grep -rnE 'fetch\(|XMLHttpRequest|node:http|Bun\.serve|new WebSocket' "$HERE/src/steps/runtime" >/dev/null 2>&1
check "7c zero network primitives (this step performs none; brew channel per decision 13)" 1 $?
grep -rnE '\b(8888|3002|90[0-9][0-9]|4[0-9]{4}|5[0-9]{4})\b' "$HERE/src/steps/runtime" "$HERE/test/runtime.test.ts" >/dev/null 2>&1
check "7d ZERO port literals in sources+tests (PORT BLOCK decisions.md :30 — values derive from artefacts/lock, never hardcoded here)" 1 $?
grep -rnE 'docker system prune|--accept-license|bash -c|sh -c' "$HERE/src/steps/runtime" >/dev/null 2>&1
check "7e no prune / no vendor license flag / no shell-spawn (P-3/P-5/P-14)" 1 $?
NCTXUSE="$(grep -rc '"context", "use"' "$HERE/src/steps/runtime" | awk -F: '{s+=$2} END {print s+0}')"
[ "$NCTXUSE" = "1" ]
check "7f 'context use' appears EXACTLY once — the RESTORE-ONLY builder (call site guarded by unit test cycle2)" 0 $?

echo
echo "row-86 proofs: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
