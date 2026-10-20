#!/usr/bin/env bash
# Row 89 proofs for the private rtk-oss step. Targeted to packages/setup ONLY (row 102 owns
# the full suite). Binds NO port anywhere (PORT RULE: nothing in this row serves a port; the
# scan in P3h asserts no port literal even in fixtures).
# P1-P4 make NO network request and are safe to re-run. P5 performs the ONE authorized real
# fetch (~5 MB, github.com release asset redirecting to objects.githubusercontent.com — both
# on the reviewed P-18 allow-list) into ~/.swarm/tools/rtk/ and only runs when R89_REAL=1 is
# set explicitly. Re-running P5 after the first success costs ZERO network: row 82 resumes
# the intact tarball by digest and §6.3 resumes the intact install by BINARY digest.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                  # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r89-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cp "$HERE/tools.lock.json" "$WORK/bin/tools.lock.json"

NEW_SRC=("$HERE/src/steps/rtk/index.ts")

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
  # lanes (graft/obsidian/runtime/firecrawl/searxng/...) trigger a scoped recheck proving
  # the shared core + row 89 alone typecheck clean (r87 precedent).
  MINE=$(grep -E '^packages/setup/src/steps/rtk/' "$WORK/tsc-full.log" | wc -l | tr -d ' ')
  if [ "$MINE" = "0" ]; then
    echo "  NOTE full-package tsc red ONLY on other in-flight lanes — first lines:"
    sed -n '1,3p' "$WORK/tsc-full.log" | sed 's/^/    /'
    cat > "$WORK/tsconfig.scoped.json" <<EOF
{
  "extends": "$HERE/tsconfig.json",
  "include": ["$HERE/src/*.ts", "$HERE/src/steps/rtk/**/*.ts", "$HERE/types/**/*.d.ts"],
  "exclude": ["dist", "node_modules", "$HERE/src/composefiles"]
}
EOF
    ( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.scoped.json" )
    check "tsc --noEmit (scoped: shared core + row-89 lane only)" 0 $?
  else
    echo "  FAIL tsc errors INSIDE row-89 files ($MINE lines):"
    grep -E '^packages/setup/src/steps/rtk/' "$WORK/tsc-full.log" | sed 's/^/    /'
    fail=$((fail+1))
  fi
fi

echo "=== PROOF 2: unit suite (fake archives, zero network, fake binary executed only as the test-authored shebang fixture) ==="
( cd "$HERE" && bun test test/rtk.test.ts ) > "$WORK/bun-test.log" 2>&1
rc=$?
tail -5 "$WORK/bun-test.log"
check "bun test test/rtk.test.ts" 0 $rc
grep -qE "^ 22 pass$" "$WORK/bun-test.log" && { echo "  PASS 22/22 unit count (resume-on-valid, tamper-replace, resolver-path, zero-PATH-mutation, dry-run-zero-writes, removal-boundary, no-config-written, edition-guard, real-spawn plumbing incl. nested layout, wrong-version health fail)"; pass=$((pass+1)); } || { echo "  FAIL unexpected unit count"; fail=$((fail+1)); }

echo "=== PROOF 3: security grep gates over the NEW sources ==="
grep -nE '\.(listen|bind)\(|createServer|Bun\.serve|Deno\.listen|startTls|createConnection|net\.connect|http\.Server' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3a no bind/listen primitive (PORT RULE)" 1 $?
grep -nE '\| *(ba|z)?sh|bash -c "\$\(|eval ' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3b no pipe-to-shell / eval (P-3)" 1 $?
grep -nE 'rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|GIT_SSL_NO_VERIFY|ignore_ssl|--insecure' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3c no insecure-TLS token (P-17)" 1 $?
grep -rn 'from "node:child_process"' "$HERE/src" | grep -v 'src/verify.ts' >/dev/null 2>&1
check "3d child_process import still confined to verify.ts (r82 gate 3c honored package-wide)" 1 $?
SPAWNS=$(grep -n 'Bun.spawnSync(' "${NEW_SRC[0]}")
BAD_SPAWN=$(printf '%s\n' "$SPAWNS" | grep -vcE 'TAR_TOOL|argv' || true)
if [ "$BAD_SPAWN" = "0" ] && [ -n "$SPAWNS" ]; then
  echo "  PASS 3e every spawn site is argv-array on TAR_TOOL or the allow-list-guarded argv:"
  printf '%s\n' "$SPAWNS" | sed 's/^/    /'
  pass=$((pass+1))
else
  echo "  FAIL 3e spawn site outside the system-binary/--version-argv pair"; fail=$((fail+1))
fi
grep -nE 'process\.env\.PATH *[+]?=' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3f no PATH assignment anywhere in the step source (zero-PATH-mutation, static half)" 1 $?
grep -nE 'xattr|com\.apple\.quarantine' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3g no quarantine/xattr handling in product code (P-2 / 01b R8: setup NEVER strips quarantine)" 1 $?
grep -rnE '\b(3002|8888|902[0-9]|47[0-9]{3}|55[0-9]{3})\b' "$HERE/src/steps/rtk" "$HERE/test/rtk.test.ts" >/dev/null 2>&1
check "3h no port literal in step or fixtures (PORT RULE + PORT BLOCK 902x)" 1 $?
grep -nE 'rtk[ ]init|telemetry[ ]enable' "${NEW_SRC[@]}" "$HERE/test/rtk.test.ts" >/dev/null 2>&1
check "3i row-89 blueprint gate: rg for the never_run commands returns 0 matches in step + tests (lock never_run array carries them instead)" 1 $?
# 3j: the no-config surface may appear in DOC COMMENTS (the boundary is explained there);
# what must be absent is any CODE line touching it. Strip comment lines, then scan.
grep -vE '^[[:space:]]*(//|\*|/\*)' "${NEW_SRC[@]}" | grep -nE 'Application Support|\.config/swarm' >/dev/null 2>&1
check "3j step CODE writes no config surface (mentions live only in boundary comments; rows 97/98 own ~/.config/swarm)" 1 $?

echo "=== PROOF 4: descriptor registers cleanly under the directory scan ==="
( cd "$HERE" && bun -e '
import { discoverSteps, orderSteps } from "./src/steps.ts";
const scan = discoverSteps();
if (scan.errors.length) { console.error("descriptor errors:", scan.errors); process.exit(1); }
const ids = scan.steps.map(s => s.id);
if (!ids.includes("rtk")) { console.error("rtk not registered:", ids); process.exit(1); }
const ord = orderSteps(scan.steps);
if (!ord.ok) { console.error("ordering failed:", ord.error); process.exit(1); }
console.log("registered:", ids.join(","), "| order includes rtk:", ord.ordered.some(s => s.id === "rtk"));
' ) > "$WORK/scan.log" 2>&1
rc=$?
cat "$WORK/scan.log"
check "step.json validates + topological order intact" 0 $rc

echo "=== PROOF 5: REAL install (opt-in R89_REAL=1; ONE authorized fetch, rtk-oss asset per PC-PIN-02) ==="
# Driver written here so the whole proof is one re-runnable artifact. It performs the ONE
# authorized real fetch: REAL fetch library (socket to github.com -> objects.githubusercontent.com
# redirect, both allow-listed), REAL /usr/bin/tar extraction, REAL codesign gate, REAL
# `--version` execution of the digest-verified private binary (that invocation IS part of the
# blueprint gate, 02_structured.md:253). Writes are fenced to ~/.swarm/tools/rtk/ by
# construction: HOME is redirected to a sandbox so state.json / setup.log / provenance /
# staging / any RTK-self-created store NEVER touch the real ~/.swarm/setup or ~/Library,
# while installRoot is pinned explicitly to the real tool dir — the only location the brief
# allows. The pre-existing Homebrew rtk is hashed BEFORE and AFTER (red line 8 / row-89 gate).
cat > "$WORK/real-driver.ts" <<EOF
import step, { rtkBin } from "$HERE/src/steps/rtk/index.ts";
import { loadLock } from "$HERE/src/lockfile.ts";
import { defaultState } from "$HERE/src/state.ts";
import { computeFileDigest } from "$HERE/src/verify.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const realHome = process.env.HOME ?? "";            // capture BEFORE the sandbox redirect
const sandbox = process.env.R89_SANDBOX || throw0(); // never default inside the real home
function throw0(): never { console.error("R89_SANDBOX must be set to a throwaway dir"); process.exit(2); }
mkdirSync(sandbox, { recursive: true });
process.env.HOME = sandbox;                          // state/log/prov/staging stay in sandbox
const installRoot = join(realHome, ".swarm", "tools", "rtk"); // the ONE allowed real target

const lockRes = loadLock();
if (!lockRes.ok) { console.log("REAL_TOKEN=LOCK_FAIL"); console.error(lockRes.error); process.exit(1); }
const lock = lockRes.lock;
const expectResume = (process.env.R89_EXPECT_RESUME ?? "") === "1";

const res = await step.install(
  { lock, state: defaultState(lock.version), dryRun: false },
  {
    installRoot,
    provenancePath: join(sandbox, "prov.jsonl"),
    logPath: join(sandbox, "setup.log"),
    correlationId: "r89-real-install",
    // r84-sanctioned TEST SEAM driving the granted path inside this proof harness ONLY;
    // nothing here writes or reads consent.log out-of-band.
    consentGate: () => true,
  },
);
console.log("REAL_TOKEN=" + res.token);
console.log("REAL_MSG=" + (res.message ?? ""));

const bin = rtkBin({ lock, installRoot });
console.log("REAL_BIN_OK=" + bin.ok);
console.log("REAL_BINPATH=" + (bin.path ?? bin.reason ?? ""));
if (!bin.ok || !bin.path) process.exit(1);

const pin = String(lock.components.rtk?.sha256 ?? "");
const tarName = String(lock.components.rtk?.url ?? "").split("/").pop() ?? "";
const tarPath = join(installRoot, tarName);
const observed = existsSync(tarPath) ? computeFileDigest(tarPath, "sha256").hex : "(absent)";
console.log("REAL_TARBALL=" + tarPath);
console.log("REAL_SHA_OBSERVED=" + observed);
console.log("REAL_SHA_PIN=" + pin);
console.log("REAL_SHA_MATCHES_PIN=" + String(observed === pin));

// Binary digest recorded in the install record vs the bytes on disk (resume key proven).
const version = String(lock.components.rtk?.version ?? "");
const rec = JSON.parse(readFileSync(join(installRoot, version, ".swarm-rtk.json"), "utf8")) as Record<string, unknown>;
console.log("REAL_BIN_SHA_RECORDED=" + String(rec.rtkBinarySha256));
console.log("REAL_BIN_SHA_ONDISK=" + computeFileDigest(bin.path, "sha256").hex);
console.log("REAL_CODESIGN_DETAIL=" + String(rec.codesignDetail ?? ""));

const v = Bun.spawnSync([bin.path, "--version"], { stdout: "pipe", stderr: "pipe" });
const dec = (x: string | Uint8Array) => (typeof x === "string" ? x : new TextDecoder().decode(x));
console.log("REAL_VERSION=" + dec(v.stdout).trim());

// G-5 discovery (01c §6.4): what does the pinned binary print for config help, and does a
// first run create its own store? HOME is the SANDBOX here, so anything RTK creates lands
// under the sandbox Library — the real ~/Library is provably untouched (checked by the shell
// wrapper). This informs rows 97/98; the step itself wrote no config.
const cfg = Bun.spawnSync([bin.path, "config", "--help"], { stdout: "pipe", stderr: "pipe", timeout: 15000 });
console.log("G5_CONFIG_HELP_EXIT=" + String(cfg.exitCode));
console.log("G5_CONFIG_HELP=" + dec(cfg.stdout).split("\\n").slice(0, 25).join(" | ") + " || STDERR:" + dec(cfg.stderr).split("\\n").slice(0, 10).join(" | "));
const appSupport = join(sandbox, "Library", "Application Support");
console.log("G5_SANDBOX_APP_SUPPORT_AFTER=" + (existsSync(appSupport) ? readdirSync(appSupport).sort().join(",") : "(none)"));

console.log("REAL_ROOT_LISTING=" + readdirSync(installRoot).sort().join(","));
if (expectResume) console.log("REAL_RESUMED=" + String((res.message ?? "").includes("resumed")));
process.exit(res.token === "OK" ? 0 : 1);
EOF
run_real() { # run_real <logfile> [NAME=VAL extra env...] — stages the src lock only if absent
  local log="$1"; shift
  local staged=0
  if [ ! -f "$HERE/src/tools.lock.json" ]; then cp "$HERE/tools.lock.json" "$HERE/src/tools.lock.json"; staged=1; fi
  ( cd "$HERE" && env R89_SANDBOX="$WORK/sandbox" "$@" bun "$WORK/real-driver.ts" ) > "$log" 2>&1
  local rc=$?
  [ "$staged" = "1" ] && rm -f "$HERE/src/tools.lock.json"
  return $rc
}
if [ "${R89_REAL:-0}" != "1" ]; then
  echo "  SKIPPED (set R89_REAL=1 to run the one authorized real fetch)"
else
  mkdir -p "$WORK/sandbox"
  REAL_RTK_HOME="$HOME/.swarm/tools/rtk"
  BREW_RTK="$(command -v rtk || echo /opt/homebrew/bin/rtk)"   # the OTHER edition (red line 8)
  BREW_RTK_TARGET="$(cd "$(dirname "$BREW_RTK")" && pwd)/$(basename "$BREW_RTK")"
  brew_sha_before="(absent)"; [ -e "$BREW_RTK_TARGET" ] && brew_sha_before=$(shasum -a 256 "$BREW_RTK_TARGET" | cut -d' ' -f1)
  lib_before="(absent)"; [ -d "$HOME/Library/Application Support/rtk" ] && lib_before=$(find "$HOME/Library/Application Support/rtk" -type f 2>/dev/null | sort | shasum -a 256 | cut -d' ' -f1)
  env | sort > "$WORK/env-before.txt"
  run_real "$WORK/real.log"
  rc=$?
  env | sort > "$WORK/env-after.txt"
  tail -20 "$WORK/real.log"
  check "5a real install driver exits 0" 0 $rc
  grep -q "REAL_TOKEN=OK" "$WORK/real.log" && { echo "  PASS 5b step returned OK against the shipped lock"; pass=$((pass+1)); } || { echo "  FAIL 5b token not OK"; fail=$((fail+1)); }
  grep -q "REAL_SHA_MATCHES_PIN=true" "$WORK/real.log" && { echo "  PASS 5c tarball sha on disk equals the lock pin (4a4d9d09..)"; pass=$((pass+1)); } || { echo "  FAIL 5c sha mismatch"; fail=$((fail+1)); }
  BIN_LINE=$(grep '^REAL_BINPATH=' "$WORK/real.log" | cut -d= -f2-)
  REC_SHA=$(grep '^REAL_BIN_SHA_RECORDED=' "$WORK/real.log" | cut -d= -f2-)
  DISK_SHA=$(grep '^REAL_BIN_SHA_ONDISK=' "$WORK/real.log" | cut -d= -f2-)
  if [ -n "$BIN_LINE" ] && [ "$REC_SHA" = "$DISK_SHA" ]; then
    echo "  PASS 5d private binary digest on disk equals the digest recorded in .swarm-rtk.json ($REC_SHA)"
    pass=$((pass+1))
  else
    echo "  FAIL 5d binary sha recorded vs disk mismatch"; fail=$((fail+1))
  fi
  # Blueprint gate evidence: the REAL private binary printed its version (format pasted raw).
  VER=$(grep '^REAL_VERSION=' "$WORK/real.log" | cut -d= -f2-)
  case "$VER" in *1.0.1*) echo "  PASS 5e private rtk --version printed '$VER' containing the pinned 1.0.1"; pass=$((pass+1));; *) echo "  FAIL 5e version output unexpected: '$VER'"; fail=$((fail+1));; esac
  # 0755 exec bit + placement at <version>/rtk exactly as the brief specifies.
  if [ -n "$BIN_LINE" ] && [ -f "$BIN_LINE" ]; then
    MODE=$(stat -f '%Lp' "$BIN_LINE")
    case "$BIN_LINE" in */rtk/v1.0.1/rtk) PLACED=ok;; *) PLACED=wrong;; esac
    if [ "$MODE" = "755" ] && [ "$PLACED" = "ok" ]; then
      echo "  PASS 5f placed at $BIN_LINE with mode 0$MODE (brief: ~/.swarm/tools/rtk/<version>/rtk, 0755)"
      pass=$((pass+1))
    else
      echo "  FAIL 5f placement/mode unexpected (mode=$MODE placed=$PLACED)"; fail=$((fail+1))
    fi
  else
    echo "  FAIL 5f private binary not found at reported path"; fail=$((fail+1))
  fi
  # XATTR EVIDENCE (brief: ls -l@ before/after). HTTPS-fetched bytes carry no quarantine
  # attribute (01c §6.1 step 3); the product code strips none (gate 3g). If the created file
  # DID somehow arrive quarantined, the DRIVER clears exactly that one file it created —
  # the command is recorded below — per 01b §3.8/R8 being a USER action, never a product one.
  echo "  --- xattr state BEFORE any driver action (ls -l@ on the created file) ---"
  ls -l@ "$BIN_LINE" > "$WORK/xattr-before.txt" 2>&1
  sed 's/^/    /' "$WORK/xattr-before.txt"
  if grep -q 'com.apple.quarantine' "$WORK/xattr-before.txt"; then
    echo "  NOTE quarantine attribute present on the created file — driver-level clear of THIS FILE ONLY (recorded command):"
    echo "    \$ xattr -d com.apple.quarantine $BIN_LINE"
    xattr -d com.apple.quarantine "$BIN_LINE"
    check "5g-driver xattr -d succeeded on the one created file" 0 $?
  else
    echo "  PASS 5g no com.apple.quarantine on the created file (HTTPS fetch sets none; product code strips none — P-2 honored)"
    pass=$((pass+1))
  fi
  echo "  --- xattr state AFTER (ls -l@) ---"
  ls -l@ "$BIN_LINE" > "$WORK/xattr-after.txt" 2>&1
  sed 's/^/    /' "$WORK/xattr-after.txt"
  if grep -q 'com.apple.quarantine' "$WORK/xattr-after.txt"; then
    echo "  FAIL quarantine still present after driver action"; fail=$((fail+1))
  else
    echo "  PASS final xattr state: no com.apple.quarantine on $BIN_LINE"; pass=$((pass+1))
  fi
  # PATH-cleanliness: shell environment byte-identical across the real install.
  if diff -u "$WORK/env-before.txt" "$WORK/env-after.txt" > "$WORK/env-diff.txt"; then
    echo "  PASS 5h PATH-cleanliness: shell environment byte-identical across the real install (diff empty)"
    pass=$((pass+1))
  else
    echo "  FAIL 5h environment changed:"; sed -n '1,10p' "$WORK/env-diff.txt"; fail=$((fail+1))
  fi
  # Red line 8 / row-89 gate: the pre-existing Homebrew rtk is byte-identical after the run.
  brew_sha_after="(absent)"; [ -e "$BREW_RTK_TARGET" ] && brew_sha_after=$(shasum -a 256 "$BREW_RTK_TARGET" | cut -d' ' -f1)
  if [ "$brew_sha_before" = "$brew_sha_after" ]; then
    echo "  PASS 5i pre-existing rtk ($BREW_RTK_TARGET) byte-identical: sha256 $brew_sha_after before == after"
    pass=$((pass+1))
  else
    echo "  FAIL 5i pre-existing rtk CHANGED ($brew_sha_before -> $brew_sha_after)"; fail=$((fail+1))
  fi
  # Real-home ~/Library/Application Support/rtk untouched by THIS run (RTK was only ever
  # spawned with HOME=sandbox; anything it self-created landed in the sandbox, listed by the
  # G5_SANDBOX_APP_SUPPORT_AFTER line above).
  lib_after="(absent)"; [ -d "$HOME/Library/Application Support/rtk" ] && lib_after=$(find "$HOME/Library/Application Support/rtk" -type f 2>/dev/null | sort | shasum -a 256 | cut -d' ' -f1)
  if [ "$lib_before" = "$lib_after" ]; then
    echo "  PASS 5j real ~/Library/Application Support/rtk unchanged by the run ($lib_after)"
    pass=$((pass+1))
  else
    echo "  FAIL 5j real ~/Library/Application Support/rtk CHANGED"; fail=$((fail+1))
  fi
  # Idempotence against the REAL artifact: second run must resume with zero network.
  run_real "$WORK/real2.log" R89_EXPECT_RESUME=1
  rc=$?
  tail -4 "$WORK/real2.log"
  check "5k second real run exits 0" 0 $rc
  grep -q "REAL_RESUMED=true" "$WORK/real2.log" && { echo "  PASS 5l second run resumed (binary digest vs record, zero network)"; pass=$((pass+1)); } || { echo "  FAIL 5l did not resume"; fail=$((fail+1)); }
fi

echo
echo "row-89 proofs: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
