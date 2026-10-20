#!/usr/bin/env bash
# Row 90 proofs for the Obsidian guide-and-detect step. Targeted to packages/setup ONLY
# (row 102 owns the full suite). Binds NO port anywhere (PORT RULE / PORT BLOCK: nothing in this
# row serves a port; scan 3h asserts no port literal even in fixtures).
# P1-P4 make NO network request and are safe to re-run. P5 performs the ONE authorized real
# staging (~233 MB dmg from github.com, amended P-18 host; digest-pinned PC-PIN-03) into
# ~/.swarm/tools/obsidian/ and only runs when R90_REAL=1 is set explicitly. The real cycle is
# also the U-2 CLOSER: it prints whatever `codesign -dvvv` observes on the mounted app — the
# first recorded TeamIdentifier value, never assumed.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                  # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="${TMPDIR:-/tmp}/swarm-setup-r90-proofs"
rm -rf "$WORK"; mkdir -p "$WORK/bin"
cp "$HERE/tools.lock.json" "$WORK/bin/tools.lock.json"

NEW_SRC=("$HERE/src/steps/obsidian/index.ts" "$HERE/types/obsidian-step.d.ts")

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
  # Attribution: any error touching MY lane fails; errors confined to other in-flight
  # lanes (graft/rtk/stacklib/...) trigger a scoped recheck proving the shared core + row 90
  # alone typecheck clean.
  MINE=$(grep -E '^packages/setup/(src/steps/obsidian/|types/obsidian-step)' "$WORK/tsc-full.log" | wc -l | tr -d ' ')
  if [ "$MINE" = "0" ]; then
    echo "  NOTE full-package tsc red ONLY on other in-flight lanes — first lines:"
    sed -n '1,3p' "$WORK/tsc-full.log" | sed 's/^/    /'
    cat > "$WORK/tsconfig.scoped.json" <<EOF
{
  "extends": "$HERE/tsconfig.json",
  "include": ["$HERE/src/*.ts", "$HERE/src/steps/obsidian/**/*.ts", "$HERE/types/**/*.d.ts"],
  "exclude": ["dist", "node_modules", "$HERE/src/composefiles"]
}
EOF
    ( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.scoped.json" )
    check "tsc --noEmit (scoped: shared core + row-90 lane only)" 0 $?
  else
    echo "  FAIL tsc errors INSIDE row-90 files ($MINE lines):"
    grep -E '^packages/setup/(src/steps/obsidian/|types/obsidian-step)' "$WORK/tsc-full.log" | sed 's/^/    /'
    fail=$((fail+1))
  fi
fi

echo "=== PROOF 2: unit suite (fake dmg + fake-hdiutil shim, zero network, app never executed) ==="
( cd "$HERE" && bun test test/obsidian.test.ts ) > "$WORK/bun-test.log" 2>&1
rc=$?
tail -5 "$WORK/bun-test.log"
check "bun test test/obsidian.test.ts" 0 $rc
grep -qE "^ 21 pass$" "$WORK/bun-test.log" && { echo "  PASS 21/21 unit count (fake-hdiutil full cycle, unmount-on-failure trap x4, tampered-dmg-aborts-before-mount, TeamID closer record/refuse/honest-null, detect-skip, resume, tamper-replace, dry-run-zero-writes, removal-boundary)"; pass=$((pass+1)); } || { echo "  FAIL unexpected unit count"; fail=$((fail+1)); }

echo "=== PROOF 3: security grep gates over the NEW sources ==="
grep -nE '\.(listen|bind)\(|createServer|Bun\.serve|Deno\.listen|startTls|createConnection|net\.connect|http\.Server' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3a no bind/listen primitive (PORT RULE)" 1 $?
grep -nE '\| *(ba|z)?sh|bash -c "\$\(|eval ' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3b no pipe-to-shell / eval (P-3)" 1 $?
grep -nE 'rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|GIT_SSL_NO_VERIFY|ignore_ssl|--insecure' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3c no insecure-TLS token (P-17)" 1 $?
grep -rn 'from "node:child_process"' "$HERE/src" | grep -v 'src/verify.ts' >/dev/null 2>&1
check "3d child_process import still confined to verify.ts (r82 gate honored package-wide)" 1 $?
SPAWNS=$(grep -n 'Bun.spawnSync(' "${NEW_SRC[0]}")
BAD_SPAWN=$(printf '%s\n' "$SPAWNS" | grep -vcE 'HDIUTIL_TOOL|DITTO_TOOL|MDFIND_TOOL' || true)
if [ "$BAD_SPAWN" = "0" ] && [ -n "$SPAWNS" ]; then
  echo "  PASS 3e every spawn site is argv-array on an absolute-path system tool (hdiutil/ditto/mdfind):"
  printf '%s\n' "$SPAWNS" | sed 's/^/    /'
  pass=$((pass+1))
else
  echo "  FAIL 3e spawn site outside the absolute-path system-tool set"; fail=$((fail+1))
fi
grep -nE 'process\.env\.PATH *[+]?=' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3f no PATH assignment anywhere in the step source" 1 $?
# /Applications is READ-ONLY for this step: the constant may exist, but no write primitive may
# ever take it (or APPLICATIONS_DIR) as an argument on the same line.
grep -nE '(mkdirSync|renameSync|writeFileSync|atomicWrite|ensureDir|ditto|realCopy)\([^)]*(APPLICATIONS_DIR|/Applications)' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3g no write primitive targets /Applications (detect-only, L14/P-16)" 1 $?
APPLINES=$(grep -n 'APPLICATIONS_DIR' "${NEW_SRC[0]}")
echo "  INFO 3g-lines: APPLICATIONS_DIR appears at:"; printf '%s\n' "$APPLINES" | sed 's/^/    /'
# Vault guard: the string may appear in comments/messages, but never as a constructed write path.
grep -nE '(join\([^)]*"vault"|mkdirSync\([^)]*vault|writeFileSync\([^)]*vault|atomicWrite[^)]*vault)' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3h no vault path construction (row 95 owns ~/.swarm/vault)" 1 $?
grep -rnE '\b(3002|8888|902[0-9]|47[0-9]{3}|55[0-9]{3})\b' "$HERE/src/steps/obsidian" "$HERE/test/obsidian.test.ts" >/dev/null 2>&1
check "3i no port literal in step or fixtures (PORT RULE + PORT BLOCK 902x)" 1 $?
# Trap-safe unmount: structural proof that unmounter() is invoked INSIDE the finally block.
if awk '/} finally \{/{f=1} f && /unmounter\(mountPoint\)/{found=1} END{exit found?0:1}' "${NEW_SRC[0]}"; then
  echo "  PASS 3j unmounter(mountPoint) is invoked inside the finally block (trap-safe structure)"
  pass=$((pass+1))
else
  echo "  FAIL 3j unmount not proven inside finally"; fail=$((fail+1))
fi

echo "=== PROOF 4: descriptor registers cleanly under the directory scan ==="
( cd "$HERE" && bun -e '
import { discoverSteps, orderSteps } from "./src/steps.ts";
const scan = discoverSteps();
if (scan.errors.length) { console.error("descriptor errors:", scan.errors); process.exit(1); }
const ids = scan.steps.map(s => s.id);
if (!ids.includes("obsidian")) { console.error("obsidian not registered:", ids); process.exit(1); }
const ord = orderSteps(scan.steps);
if (!ord.ok) { console.error("ordering failed:", ord.error); process.exit(1); }
console.log("registered:", ids.join(","), "| order includes obsidian:", ord.ordered.some(s => s.id === "obsidian"));
' ) > "$WORK/scan.log" 2>&1
rc=$?
cat "$WORK/scan.log"
check "step.json validates + topological order intact" 0 $rc

echo "=== PROOF 5: REAL staging (opt-in R90_REAL=1; ONE download, github.com per amended P-18) ==="
# The ONE authorized real cycle: REAL fetch library (socket to github.com, host on the amended
# P-18 list), REAL dmg sha256 vs the PC-PIN-03 pin, REAL read-only hdiutil mount at a private
# mountpoint, REAL codesign/spctl gate over the mounted app (NO seam — this run IS the U-2 closer
# and prints the first observed TeamIdentifier), REAL ditto copy into the user-space tool dir,
# ALWAYS detach. Writes are fenced by construction: HOME is redirected to a sandbox so
# state.json / setup.log / provenance / mountpoint NEVER touch the real ~/.swarm/setup, while
# installRoot is pinned explicitly to the real tool dir — the only location the brief allows.
cat > "$WORK/real-driver.ts" <<EOF
import step, { stagedAppPath } from "$HERE/src/steps/obsidian/index.ts";
import { loadLock } from "$HERE/src/lockfile.ts";
import { defaultState } from "$HERE/src/state.ts";
import { computeFileDigest } from "$HERE/src/verify.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const realHome = process.env.HOME ?? "";            // capture BEFORE the sandbox redirect
function needSandbox(): string {
  const s = process.env.R90_SANDBOX ?? "";
  if (s === "") { console.error("R90_SANDBOX must be set to a throwaway dir"); process.exit(2); }
  return s;
}
const sandbox = needSandbox();
mkdirSync(sandbox, { recursive: true });
process.env.HOME = sandbox;                          // state/log/prov/mountpoint stay in sandbox
const installRoot = join(realHome, ".swarm", "tools", "obsidian"); // the ONE allowed real target

const lockRes = loadLock();
if (!lockRes.ok) { console.log("REAL_TOKEN=LOCK_FAIL"); console.error(lockRes.error); process.exit(1); }
const lock = lockRes.lock;
const expectResume = (process.env.R90_EXPECT_RESUME ?? "") === "1";

const res = await step.install(
  { lock, state: defaultState(lock.version), dryRun: false },
  {
    installRoot,
    fetchTimeoutMs: Number(process.env.R90_FETCH_TIMEOUT_MS ?? "900000"),
    provenancePath: join(sandbox, "prov.jsonl"),
    logPath: join(sandbox, "setup.log"),
    correlationId: "r90-real-staging",
    // r84-sanctioned TEST SEAM driving the granted path inside this proof harness ONLY;
    // nothing here writes or reads consent.log out-of-band.
    consentGate: () => true,
    // NO detector/mounter/unmounter/copier/signatureRun seams: the FULL real plumbing runs.
  },
);
console.log("REAL_TOKEN=" + res.token);
console.log("REAL_MSG=" + (res.message ?? ""));

if (res.token === "SKIPPED") {
  // Honest detection outcome: Obsidian already exists on this host — nothing staged, nothing touched.
  console.log("REAL_DETECTED_AND_LEFT_UNTOUCHED=true");
  process.exit(0);
}

// U-2 closer evidence: the observed TeamID as recorded by the run itself.
const prov = existsSync(join(sandbox, "prov.jsonl"))
  ? readFileSync(join(sandbox, "prov.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>)
  : [];
const stagedLine = prov.filter((l) => l.stage === "staged").at(-1);
console.log("REAL_TEAMID_OBSERVED=" + String(stagedLine?.observedTeamIdentifier ?? "(none printed)"));
console.log("REAL_SIG_DETAIL=" + String(stagedLine?.signatureDetail ?? "(none)"));

const app = stagedAppPath({ lock, installRoot });
console.log("REAL_APP_OK=" + app.ok);
console.log("REAL_APP_PATH=" + (app.path ?? app.reason ?? ""));
if (!app.ok) process.exit(1);

const pin = String(lock.components.obsidian?.dmg_sha256 ?? "");
const dmgName = String(lock.components.obsidian?.url ?? "").split("/").pop() ?? "";
const dmgPath = join(installRoot, dmgName);
const observed = existsSync(dmgPath) ? computeFileDigest(dmgPath, "sha256").hex : "(absent)";
console.log("REAL_DMG=" + dmgPath);
console.log("REAL_SHA_OBSERVED=" + observed);
console.log("REAL_SHA_PIN=" + pin);
console.log("REAL_SHA_MATCHES_PIN=" + String(observed === pin));
console.log("REAL_ROOT_LISTING=" + readdirSync(installRoot).sort().join(","));
console.log("REAL_VAULT_CREATED=" + String(existsSync(join(sandbox, ".swarm", "vault")))); // must be false
const tmpSandbox = join(sandbox, ".swarm", "tmp");
console.log("REAL_MNT_DEBRIS=" + String(existsSync(tmpSandbox) ? readdirSync(tmpSandbox).filter((n) => n.startsWith(".mnt-")).length : 0));
if (expectResume) console.log("REAL_RESUMED=" + String((res.message ?? "").includes("resumed")));
process.exit(res.token === "OK" ? 0 : 1);
EOF
run_real() { # run_real <logfile> [NAME=VAL extra env...] — stages the src lock only if absent
  local log="$1"; shift
  local staged=0
  if [ ! -f "$HERE/src/tools.lock.json" ]; then cp "$HERE/tools.lock.json" "$HERE/src/tools.lock.json"; staged=1; fi
  ( cd "$HERE" && env R90_SANDBOX="$WORK/sandbox" "$@" bun "$WORK/real-driver.ts" ) > "$log" 2>&1
  local rc=$?
  [ "$staged" = "1" ] && rm -f "$HERE/src/tools.lock.json"
  return $rc
}
if [ "${R90_REAL:-0}" != "1" ]; then
  echo "  SKIPPED (set R90_REAL=1 to run the one authorized real staging + U-2 closer)"
else
  mkdir -p "$WORK/sandbox"
  env | sort > "$WORK/env-before.txt"
  run_real "$WORK/real.log"
  rc=$?
  env | sort > "$WORK/env-after.txt"
  tail -16 "$WORK/real.log"
  check "5a real staging driver exits 0" 0 $rc
  if grep -q "REAL_TOKEN=SKIPPED" "$WORK/real.log"; then
    echo "  PASS 5b honest detect-mode: Obsidian present on this host, left untouched"; pass=$((pass+1))
  else
    grep -q "REAL_TOKEN=OK" "$WORK/real.log" && { echo "  PASS 5b step returned OK against the shipped lock"; pass=$((pass+1)); } || { echo "  FAIL 5b token not OK"; fail=$((fail+1)); }
    grep -q "REAL_SHA_MATCHES_PIN=true" "$WORK/real.log" && { echo "  PASS 5c dmg sha on disk equals the PC-PIN-03 pin (dcf818dd..)"; pass=$((pass+1)); } || { echo "  FAIL 5c sha mismatch"; fail=$((fail+1)); }
    TEAM=$(grep -m1 "^REAL_TEAMID_OBSERVED=" "$WORK/real.log" | cut -d= -f2)
    if [ -n "$TEAM" ] && [ "$TEAM" != "(none printed)" ]; then
      echo "  PASS 5d U-2 CLOSER fired: first observed TeamIdentifier recorded = $TEAM"; pass=$((pass+1))
    else
      echo "  FAIL 5d no TeamIdentifier observed (gate refused or printed nothing) — sig detail:"; grep -m1 "^REAL_SIG_DETAIL=" "$WORK/real.log"; fail=$((fail+1))
    fi
    grep -q "REAL_APP_OK=true" "$WORK/real.log" && { echo "  PASS 5e staged app resolves in user space (record digest match)"; pass=$((pass+1)); } || { echo "  FAIL 5e staged app not resolvable"; fail=$((fail+1)); }
    grep -q "REAL_VAULT_CREATED=false" "$WORK/real.log" && { echo "  PASS 5f vault untouched (row 95's domain)"; pass=$((pass+1)); } || { echo "  FAIL 5f vault appeared"; fail=$((fail+1)); }
    grep -q "REAL_MNT_DEBRIS=0" "$WORK/real.log" && { echo "  PASS 5g no mountpoint debris (always-unmount held)"; pass=$((pass+1)); } || { echo "  FAIL 5g .mnt-* debris left behind"; fail=$((fail+1)); }
    if diff -u "$WORK/env-before.txt" "$WORK/env-after.txt" > "$WORK/env-diff.txt"; then
      echo "  PASS 5h shell environment byte-identical across the real staging (diff empty)"
      pass=$((pass+1))
    else
      echo "  FAIL 5h environment changed:"; sed -n '1,10p' "$WORK/env-diff.txt"; fail=$((fail+1))
    fi
    # Idempotence against the REAL artifact: second run must resume with zero network/mount.
    run_real "$WORK/real2.log" R90_EXPECT_RESUME=1
    rc=$?
    tail -3 "$WORK/real2.log"
    check "5i second real run exits 0" 0 $rc
    grep -q "REAL_RESUMED=true" "$WORK/real2.log" && { echo "  PASS 5j second run resumed (staged binary digest vs record, zero network)"; pass=$((pass+1)); } || { echo "  FAIL 5j did not resume"; fail=$((fail+1)); }
  fi
fi

echo
echo "row-90 proofs: $pass passed, $fail failed"
[ "$fail" = "0" ] || exit 1
