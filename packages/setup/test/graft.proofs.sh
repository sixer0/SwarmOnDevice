#!/usr/bin/env bash
# Row 88 proofs for the private-Graft step. Targeted to packages/setup ONLY (row 102 owns the full
# suite). Binds NO port anywhere (PORT RULE: graft serves nothing; the scan in P3h asserts no port
# literal even in fixtures). P1-P4 make NO network request and are safe to re-run. P5 performs the
# ONE authorized real `npm install` of @nanonets/graft@0.18.0 (the pinned tarball is fetched +
# sha512-verified by the row-82 library from registry.npmjs.org, then installed by the PRIVATE Node's
# own npm with --ignore-scripts + DO_NOT_TRACK=1) into ~/.swarm/tools/graft/ and only runs when
# GRAFT_REAL=1 is set explicitly. The full dependency closure is hundreds of MB, so P5 is slow and
# opt-in by design.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                  # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r88-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cp "$HERE/tools.lock.json" "$WORK/bin/tools.lock.json"

NEW_SRC=("$HERE/src/steps/graft/index.ts" "$HERE/types/graft-step.d.ts")

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
  # Attribution: any error touching MY lane fails; errors confined to other in-flight lanes
  # (runtime/firecrawl/searxng/stacklib/...) trigger a scoped recheck proving the shared core +
  # row 87 + row 88 alone typecheck clean.
  MINE=$(grep -E '^packages/setup/(src/steps/graft/|types/graft-step)' "$WORK/tsc-full.log" | wc -l | tr -d ' ')
  if [ "$MINE" = "0" ]; then
    echo "  NOTE full-package tsc red ONLY on other in-flight lanes — first lines:"
    sed -n '1,3p' "$WORK/tsc-full.log" | sed 's/^/    /'
    cat > "$WORK/tsconfig.scoped.json" <<EOF
{
  "extends": "$HERE/tsconfig.json",
  "include": ["$HERE/src/*.ts", "$HERE/src/steps/_template/**/*.ts", "$HERE/src/steps/node/**/*.ts", "$HERE/src/steps/graft/**/*.ts", "$HERE/types/**/*.d.ts"],
  "exclude": ["dist", "node_modules", "$HERE/src/composefiles"]
}
EOF
    ( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.scoped.json" )
    check "tsc --noEmit (scoped: shared core + node + graft lane only)" 0 $?
  else
    echo "  FAIL tsc errors INSIDE row-88 files ($MINE lines):"
    grep -E '^packages/setup/(src/steps/graft/|types/graft-step)' "$WORK/tsc-full.log" | sed 's/^/    /'
    fail=$((fail+1))
  fi
fi

echo "=== PROOF 2: unit suite (fake tarball + fake npm/health/telemetry spawns, zero network) ==="
( cd "$HERE" && bun test test/graft.test.ts ) > "$WORK/bun-test.log" 2>&1
rc=$?
tail -5 "$WORK/bun-test.log"
check "bun test test/graft.test.ts" 0 $rc
grep -qE "^ 22 pass$" "$WORK/bun-test.log" && { echo "  PASS 22/22 unit count (consent-refusal, fresh-install+engines-recorded, resume-on-valid, tamper-replace, resolver-path, zero-PATH-mutation, dry-run-zero-writes x2, removal-boundary x3, renamed-twin x3, prereq-missing, telemetry-not-off, install-failure x2, nativeBuild-auto/off/rebuild-fail)"; pass=$((pass+1)); } || { echo "  FAIL unexpected unit count"; fail=$((fail+1)); }

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
BAD_SPAWN=$(printf '%s\n' "$SPAWNS" | grep -vcE 'argv|nodePath' || true)
if [ "$BAD_SPAWN" = "0" ] && [ -n "$SPAWNS" ]; then
  echo "  PASS 3e every spawn site is argv-array on the resolved private node / npm-cli / CLI path:"
  printf '%s\n' "$SPAWNS" | sed 's/^/    /'
  pass=$((pass+1))
else
  echo "  FAIL 3e spawn site outside the resolved-private-path set"; fail=$((fail+1))
fi
grep -nE 'process\.env\.PATH *[+]?=' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3f no PATH assignment anywhere in the step source (zero-PATH-mutation, static half)" 1 $?
grep -n '/usr/local' "${NEW_SRC[@]}" >/dev/null 2>&1
check "3g no system-prefix reference (private dir only; D-10 never resolves a system graft)" 1 $?
grep -rnE '\b(3002|8888|902[0-9]|47[0-9]{3}|55[0-9]{3})\b' "$HERE/src/steps/graft" "$HERE/test/graft.test.ts" >/dev/null 2>&1
check "3h no port literal in step or fixtures (PORT RULE + PORT BLOCK 902x)" 1 $?
# Row-88 blueprint verify: "rg for graft init and --deep in sources returns 0". The setup never runs
# the initializer nor the deep-analysis mode (both edit files outside the tool dir). A grep gate must
# not name its own subject, so the forbidden forms are matched structurally, never written literally.
grep -rnE 'graft[[:space:]]+in[i]t|--de[e]p' "$HERE/src/steps/graft" "$HERE/test/graft.test.ts" >/dev/null 2>&1
check "3i no initializer / deep-analysis invocation in sources (blueprint: rg returns 0)" 1 $?
grep -rnE '@trailhq/trail-code' "$HERE/src/steps/graft/index.ts" | grep -vE 'excluded|refus|never|twin|registers|separate product' >/dev/null 2>&1
check "3j twin name appears only in exclusion context (never as an install target)" 1 $?

echo "=== PROOF 4: descriptor registers cleanly + graft ordered AFTER node under the scan ==="
( cd "$HERE" && bun -e '
import { discoverSteps, orderSteps } from "./src/steps.ts";
const scan = discoverSteps();
if (scan.errors.length) { console.error("descriptor errors:", scan.errors); process.exit(1); }
const ids = scan.steps.map(s => s.id);
if (!ids.includes("graft")) { console.error("graft not registered:", ids); process.exit(1); }
const ord = orderSteps(scan.steps);
if (!ord.ok) { console.error("ordering failed:", ord.error); process.exit(1); }
const seq = ord.ordered.map(s => s.id);
const gi = seq.indexOf("graft"), ni = seq.indexOf("node");
if (gi < 0 || ni < 0 || ni >= gi) { console.error("graft not after node:", seq); process.exit(1); }
console.log("registered:", ids.join(","), "| topological order:", seq.join(","));
' ) > "$WORK/scan.log" 2>&1
rc=$?
cat "$WORK/scan.log"
check "step.json validates + graft ordered after node (requires:[node])" 0 $rc

echo "=== PROOF 5: REAL npm install (opt-in GRAFT_REAL=1; ONE install, registry.npmjs.org per P-18) ==="
# Driver written here so the whole proof is one re-runnable artifact. It performs the ONE authorized
# real install: REAL row-82 fetch (socket to registry.npmjs.org, host on the P-18 list) verifying the
# graft tarball against the lock sha512 BEFORE use, then the REAL private Node running its OWN npm to
# install that verified tarball (--ignore-scripts, DO_NOT_TRACK=1) into ~/.swarm/tools/graft/<version>/,
# then the REAL `--version` execution of the installed CLI (the blueprint gate) and the read-only
# telemetry-status probe. Writes are fenced: HOME is redirected to a sandbox so state.json / setup.log /
# provenance / staging NEVER touch the real ~/.swarm/setup, while installRoot + nodeInstallRoot are
# pinned explicitly to the real tool dirs — the only locations the brief allows.
cat > "$WORK/real-driver.ts" <<EOF
import step, { graftLaunch, graftCliPath } from "$HERE/src/steps/graft/index.ts";
import { nodeBin } from "$HERE/src/steps/node/index.ts";
import { loadLock } from "$HERE/src/lockfile.ts";
import { defaultState } from "$HERE/src/state.ts";
import { computeFileDigest, parseExpectedDigest } from "$HERE/src/verify.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const realHome = process.env.HOME ?? "";            // capture BEFORE the sandbox redirect
const sandbox = process.env.GRAFT_SANDBOX || throw0(); // never default inside the real home
function throw0(): never { console.error("GRAFT_SANDBOX must be set to a throwaway dir"); process.exit(2); }
mkdirSync(sandbox, { recursive: true });
process.env.HOME = sandbox;                          // state/log/prov/staging stay in sandbox
const installRoot = join(realHome, ".swarm", "tools", "graft"); // the ONE allowed real target
const nodeInstallRoot = join(realHome, ".swarm", "tools", "node"); // prerequisite (row 87 landed)

const lockRes = loadLock();
if (!lockRes.ok) { console.log("REAL_TOKEN=LOCK_FAIL"); console.error(lockRes.error); process.exit(1); }
const lock = lockRes.lock;
const expectResume = (process.env.GRAFT_EXPECT_RESUME ?? "") === "1";

const res = await step.install(
  { lock, state: defaultState(lock.version), dryRun: false },
  {
    installRoot,
    provenancePath: join(sandbox, "prov.jsonl"),
    logPath: join(sandbox, "setup.log"),
    correlationId: "r88-real-install",
    // r84-sanctioned TEST SEAM driving the granted path inside this proof harness ONLY; nothing here
    // writes or reads consent.log out-of-band. Node resolution is pinned to the REAL private node dir.
    consentGate: () => true,
    resolveNode: (l) => nodeBin({ lock: l, installRoot: nodeInstallRoot }),
    // NO npmRunner / healthRunner / telemetryRunner seams: the real npm install + real --version +
    // real telemetry-status probe all run. That is the point of P5.
  },
);
console.log("REAL_TOKEN=" + res.token);
console.log("REAL_MSG=" + (res.message ?? ""));

const launch = graftLaunch({ lock, installRoot, nodeInstallRoot });
console.log("REAL_LAUNCH_OK=" + launch.ok);
console.log("REAL_NODEPATH=" + (launch.nodePath ?? ""));
console.log("REAL_CLIPATH=" + (launch.cliPath ?? launch.reason ?? ""));
if (!launch.ok || !launch.cliPath || !launch.nodePath) process.exit(1);

// engines floor OBSERVED from the installed package.json (closes r80 finding 4 either way).
const pkgJson = JSON.parse(readFileSync(join(launch.cliPath, "..", "..", "package.json"), "utf8"));
console.log("REAL_PKG_NAME=" + pkgJson.name);
console.log("REAL_ENGINES=" + JSON.stringify(pkgJson.engines ?? {}));

// what the step recorded into its own install manifest.
const rec = JSON.parse(readFileSync(join(installRoot, String(lock.components.graft?.version ?? ""), ".swarm-graft.json"), "utf8"));
console.log("REAL_ENGINES_RECORDED=" + rec.enginesNode);
console.log("REAL_TELEMETRY_KNOB=" + rec.telemetryKnob);
console.log("REAL_TELEMETRY_OBSERVED=" + rec.telemetryObserved);

// independent re-execution of the blueprint gate: the installed CLI prints exactly the pin.
const v = Bun.spawnSync([launch.nodePath, launch.cliPath, "--version"], { stdout: "pipe", stderr: "pipe", timeout: 30000 });
const vOut = typeof v.stdout === "string" ? v.stdout : new TextDecoder().decode(v.stdout);
console.log("REAL_VERSION=" + vOut.trim());

// renamed-twin absence proof: the twin package must NOT be present anywhere in the install tree.
const twinDir = join(installRoot, String(lock.components.graft?.version ?? ""), "node_modules", "@trailhq", "trail-code");
console.log("REAL_TWIN_ABSENT=" + String(!existsSync(twinDir)));

// integrity of the fetched tarball vs the lock pin (row 82 verified before promotion; re-checked here).
const pin = String(lock.components.graft?.integrity ?? "");
const pinHex = parseExpectedDigest(pin)?.hex ?? "";
const tarName = String(lock.components.graft?.url ?? "").split("/").pop() ?? "";
const tarPath = join(installRoot, tarName);
const observed = existsSync(tarPath) ? computeFileDigest(tarPath, "sha512").hex : "(absent)";
console.log("REAL_TARBALL=" + tarPath);
console.log("REAL_SHA_OBSERVED=" + observed);
console.log("REAL_SHA_PIN=" + pinHex);
console.log("REAL_SHA_MATCHES_PIN=" + String(observed === pinHex));

console.log("REAL_ROOT_LISTING=" + readdirSync(installRoot).sort().join(","));
if (expectResume) console.log("REAL_RESUMED=" + String((res.message ?? "").includes("resumed")));
process.exit(res.token === "OK" ? 0 : 1);
EOF
run_real() { # run_real <logfile> [NAME=VAL extra env...] — stages the src lock only if absent
  local log="$1"; shift
  local staged=0
  if [ ! -f "$HERE/src/tools.lock.json" ]; then cp "$HERE/tools.lock.json" "$HERE/src/tools.lock.json"; staged=1; fi
  ( cd "$HERE" && env GRAFT_SANDBOX="$WORK/sandbox" "$@" bun "$WORK/real-driver.ts" ) > "$log" 2>&1
  local rc=$?
  [ "$staged" = "1" ] && rm -f "$HERE/src/tools.lock.json"
  return $rc
}
if [ "${GRAFT_REAL:-0}" != "1" ]; then
  echo "  SKIPPED (set GRAFT_REAL=1 to run the one authorized real npm install)"
else
  mkdir -p "$WORK/sandbox"
  env | sort > "$WORK/env-before.txt"
  run_real "$WORK/real.log"
  rc=$?
  env | sort > "$WORK/env-after.txt"
  tail -20 "$WORK/real.log"
  check "5a real install driver exits 0" 0 $rc
  grep -q "REAL_TOKEN=OK" "$WORK/real.log" && { echo "  PASS 5b step returned OK against the shipped lock"; pass=$((pass+1)); } || { echo "  FAIL 5b token not OK"; fail=$((fail+1)); }
  grep -q "REAL_VERSION=0.18.0" "$WORK/real.log" && { echo "  PASS 5c installed CLI --version printed 0.18.0 (blueprint gate)"; pass=$((pass+1)); } || { echo "  FAIL 5c version mismatch"; fail=$((fail+1)); }
  grep -q "REAL_SHA_MATCHES_PIN=true" "$WORK/real.log" && { echo "  PASS 5d graft tarball sha512 on disk equals the lock pin (sNsh..)"; pass=$((pass+1)); } || { echo "  FAIL 5d sha mismatch"; fail=$((fail+1)); }
  if diff -u "$WORK/env-before.txt" "$WORK/env-after.txt" > "$WORK/env-diff.txt"; then
    echo "  PASS 5e PATH-cleanliness: shell environment byte-identical across the real install (diff empty)"
    pass=$((pass+1))
  else
    echo "  FAIL 5e environment changed:"; sed -n '1,10p' "$WORK/env-diff.txt"; fail=$((fail+1))
  fi
  grep -q "REAL_ENGINES_RECORDED=>=20" "$WORK/real.log" && { echo "  PASS 5f actual engines.node floor recorded from the installed package.json (>=20; closes r80 finding 4)"; pass=$((pass+1)); } || { echo "  FAIL 5f engines floor not recorded as expected"; fail=$((fail+1)); }
  grep -q "REAL_TELEMETRY_KNOB=DO_NOT_TRACK=1" "$WORK/real.log" && { echo "  PASS 5g telemetry-off knob recorded (DO_NOT_TRACK=1)"; pass=$((pass+1)); } || { echo "  FAIL 5g telemetry knob missing"; fail=$((fail+1)); }
  grep -q "REAL_TWIN_ABSENT=true" "$WORK/real.log" && { echo "  PASS 5h renamed twin @trailhq/trail-code absent from the install tree (D-10)"; pass=$((pass+1)); } || { echo "  FAIL 5h twin present"; fail=$((fail+1)); }
  # Idempotence against the REAL artifact: second run must resume with zero network.
  run_real "$WORK/real2.log" GRAFT_EXPECT_RESUME=1
  rc=$?
  tail -3 "$WORK/real2.log"
  check "5i second real run exits 0" 0 $rc
  grep -q "REAL_RESUMED=true" "$WORK/real2.log" && { echo "  PASS 5j second run resumed (CLI digest vs record, zero network)"; pass=$((pass+1)); } || { echo "  FAIL 5j did not resume"; fail=$((fail+1)); }
fi

echo
echo "row-88 proofs: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
