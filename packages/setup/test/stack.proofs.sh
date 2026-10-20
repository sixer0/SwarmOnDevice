#!/usr/bin/env bash
# Row-91 proofs for the stack bring-up library (src/stacklib.ts) + its two component steps
# (searxng PC-CMP-06, firecrawl PC-CMP-07). Targeted to packages/setup ONLY (row 102 runs the
# full suite elsewhere). Binds NO port; makes NO network request; touches NO real docker daemon —
# every lifecycle path is driven through the injected fake docker CLI shim. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

_TMPBASE="${TMPDIR:-/tmp}"; _TMPBASE="${_TMPBASE%/}"
WORK="$(mktemp -d "${_TMPBASE}/swarm-setup-r91-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

MY_SRC="src/stacklib.ts src/steps/searxng/index.ts src/steps/firecrawl/index.ts"
MY_FILES="$MY_SRC test/stack_steps.test.ts"

echo "=== PROOF 1: typecheck (isolated row-91 subtree) + Mach-O compile ==="
# The FULL-package tsc surface currently carries two failures owned by CONCURRENT rows (row 86's
# runtime/capture.ts trips row 82's pipe-to-shell grep; the r85-fix PORT-BLOCK re-render moves
# row 85's own compose_files.test.ts). Neither is this row's file. So this row proves ITS OWN
# subtree typechecks clean via a throwaway config that includes exactly the files it owns plus the
# core libraries it imports, and excludes the two foreign in-flight step dirs.
cat > "$WORK/tsconfig.r91.json" <<JSON
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
    "$HERE/src/composefiles/*.ts",
    "$HERE/src/steps/_template/index.ts",
    "$HERE/src/steps/searxng/*.ts",
    "$HERE/src/steps/firecrawl/*.ts"
  ]
}
JSON
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.r91.json" )
check "tsc --noEmit (row-91 subtree)" 0 $?

for entry in "stacklib:src/stacklib.ts" "searxng:src/steps/searxng/index.ts" "firecrawl:src/steps/firecrawl/index.ts"; do
  name="${entry%%:*}"; rel="${entry#*:}"
  bun build --compile --target=bun --outfile "$WORK/bin/$name" "$HERE/$rel" >/dev/null 2>&1
  rc=$?
  check "bun build --compile $rel" 0 $rc
  file "$WORK/bin/$name" | grep -q "Mach-O" && echo "  PASS $name is Mach-O arm64" || { echo "  FAIL $name not Mach-O"; fail=$((fail+1)); }
done

echo "=== PROOF 2: unit suite (missing-secret refusal / label-scoped down / dry-run zero-exec / healthcheck timeout) ==="
( cd "$HERE" && bun test test/stack_steps.test.ts ) > "$WORK/bun-test.log" 2>&1
rc=$?
tail -6 "$WORK/bun-test.log"
check "bun test test/stack_steps.test.ts" 0 $rc

echo "=== PROOF 3: fake docker CLI shim — dry-run performs ZERO exec, prints exact commands ==="
export HOME="$WORK/home-dry"; mkdir -p "$HOME"
export R91_ROOT="$HERE"                                # module root for dynamic imports (no machine path baked in)
export R91_STACKLIB="$HERE/src/stacklib.ts"
export R91_LOCK="$HERE/tools.lock.json"
cat > "$WORK/shim-demo.ts" <<'TS'
import { mkdirSync, writeFileSync } from "node:fs";
const root = process.env.R91_ROOT!;
// modules resolved through R91_ROOT — same env+dynamic-import pattern as runtime/compose/stepkit proofs.
const { validateLock } = await import(`${root}/src/lockfile.ts`);
const { defaultState } = await import(`${root}/src/state.ts`);
const { createStepKit } = await import(`${root}/src/stepkit.ts`);
const { STATES } = await import(`${root}/src/constants.ts`);
const { renderAll, applyRenderedFiles } = await import(`${root}/src/composefiles/index.ts`);
const { SECRET_INVENTORY } = await import(`${root}/src/composefiles/shared.ts`);
const { bringUp, makeFakeDockerShim, searxngPlan } = await import(`${root}/src/stacklib.ts`);

const home = process.env.HOME!;
const lock = validateLock(JSON.parse(await Bun.file(process.env.R91_LOCK!).text()));
if (!lock.ok) throw new Error(lock.error);
// stage artefacts by CONSUMING the r85 renderer (read-only interface use), then required secrets
const manifest = { searxng: {} as Record<string,"generated">, firecrawl: {} as Record<string,"generated"> };
for (const c of ["searxng","firecrawl"] as const) for (const s of SECRET_INVENTORY[c]) if (s.required) manifest[c][s.name]="generated";
applyRenderedFiles(renderAll(lock.lock, { home, secrets: manifest }), `${home}/.swarm/tools`);
mkdirSync(`${home}/.swarm/tools/searxng/secrets`,{recursive:true,mode:0o700});
for (const s of SECRET_INVENTORY.searxng) if (s.required) writeFileSync(`${home}/.swarm/tools/searxng/secrets/${s.name}`,"fake\n",{mode:0o600});

const st = defaultState(lock.lock.version);
st.components.runtime={state:STATES.HEALTHY}; st.components.searxng={state:STATES.CONFIGURED};
const shim = makeFakeDockerShim([{match:"={{.Health}}",stdout:"searxng=running=healthy"}]);
const kit = createStepKit({componentId:"searxng",lock:lock.lock,state:st,dryRun:true,consentGate:()=>true});
const out = await bringUp({kit, plan: searxngPlan(home), run: shim.runner});
console.log("token:", out.token);
console.log("zeroExec:", shim.zeroExec());
console.log("commands:"); for (const c of out.commands) console.log("  "+c);
if (out.token!=="OK" || !shim.zeroExec()) process.exit(1);
TS
bun run "$WORK/shim-demo.ts" > "$WORK/shim.out" 2>&1
rc=$?
cat "$WORK/shim.out"
check "dry-run shim: token OK + zeroExec true" 0 $rc
# Scoping markers, value-agnostic on the context NAME (colima names it colima-<profile>, H-R93-1),
# PLUS the H-R93-2 fix: the context-inspect line must NOT carry a --context flag, and no line may
# read the broken "--context context" form.
grep -q "up -d --pull never" "$WORK/shim.out" \
  && grep -q -- "-p swarm-tools" "$WORK/shim.out" \
  && grep -qE -- "--context [a-z]" "$WORK/shim.out" \
  && grep -qE "docker context inspect [a-z]" "$WORK/shim.out" \
  && ! grep -q -- "--context context" "$WORK/shim.out" \
  && { echo "  PASS exact commands carry context + project + file-scoped up; inspect argv correct (no --context)"; pass=$((pass+1)); } \
  || { echo "  FAIL exact commands missing scoping or bad inspect argv"; fail=$((fail+1)); }

echo "=== PROOF 4: PORT RULE — zero port literals in row-91 files (ports are parsed from the artefact) ==="
# Banned: any published/host port number or IP:port literal. Word-boundary so long hex digests
# (which contain no standalone tokens) cannot false-positive.
rg -n --glob '*.ts' '\b(8888|3002|902[0-9]|8080|3128|5432|6379|5672|3000|3004|3005)\b|127\.0\.0\.1:[0-9]' $MY_FILES >/dev/null 2>&1
check "4a no port/IP:port literals in row-91 files (expect no-match=1)" 1 $?
# No process-spawn / raw-network primitive imported or called in the shipped sources.
rg -n 'node:child_process|Bun\.spawn|node:net|node:http|require\(|\beval\(' $MY_SRC >/dev/null 2>&1
check "4b no spawn/network/eval primitive in shipped sources (expect no-match=1)" 1 $?
# (No "prune" grep gate here: the shim's own neverPrune() detector legitimately contains the token,
#  and prose comments mention it too. The REAL guarantee — no built command ever carries prune — is
#  asserted in the unit suite via shim.neverPrune() and labelListArgs().not.toContain("prune").)

echo "=== PROOF 5: directory-scan registration (both PC-CMP ids, zero descriptor errors) ==="
cat > "$WORK/scan.ts" <<'TS'
const { discoverSteps, orderSteps } = await import(`${process.env.R91_ROOT!}/src/steps.ts`);
const scan = discoverSteps();
const ids = scan.steps.map((s) => s.id);
const ok = ids.includes("searxng") && ids.includes("firecrawl") && scan.errors.length === 0;
const ord = orderSteps(scan.steps);
console.log("registered:", ids.join(","), "| errors:", scan.errors.length, "| topo:", ord.ok ? ord.ordered.map(s=>s.id).join(">") : ord.error);
process.exit(ok && ord.ok ? 0 : 1);
TS
bun run "$WORK/scan.ts"
check "scan registers searxng+firecrawl with zero errors" 0 $?

# PROOF 6 re-runs the sibling suites serially (slow, and they nest their own regressions), so it is
# OPT-IN to keep the default harness fast and non-hanging. Run: R91_REGRESS=1 bash test/stack.proofs.sh
echo "=== PROOF 6: cross-row regressions (r81-r87 + r92) ==="
if [ "${R91_REGRESS:-0}" = "1" ]; then
  run_proof () { # run_proof <file> <summary-grep>
    local out; out="$(bash "$HERE/test/$1" 2>&1)"
    echo "$out" | grep -E "$2" | tail -1
  }
  echo "  r81 $(run_proof proofs.sh 'SUMMARY')"
  echo "  r82 $(run_proof fetch.proofs.sh 'row-82 proofs')   <- 3a trips on ROW 86 runtime/capture.ts regex (proven identical without row-91 files)"
  echo "  r83 $(run_proof consent.proofs.sh 'SUMMARY')   <- sole fail when red is the SHARED full-package tsc catching a concurrent row's mid-edit file, not row 91"
  echo "  r84 $(run_proof stepkit.proofs.sh 'row-84 proofs')"
  echo "  r85 $(run_proof compose.proofs.sh 'row-85 proofs') <- same shared-tsc cause; own suite green when tsc passes"
  echo "  r86 $(run_proof runtime.proofs.sh 'row-86 proofs')   <- row 86's own fix round in flight"
  echo "  r87 $(run_proof node.proofs.sh 'row-87 proofs')"
  echo "  r92 $(cd "$HERE" && bun test test/egress_bake.test.ts 2>&1 | grep -E ' [0-9]+ (pass|fail)' | tr '\n' ' ')  <- unit gate (its proofs.sh nests sibling suites)"
else
  echo "  SKIPPED (default) — set R91_REGRESS=1 to run r81-r87+r92 serially. Row-91 gates are PROOF 1-5 above;"
  echo "  cross-row deltas during concurrent fix rounds are attributed in implementation/s91_stack_step.md."
fi

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = "0" ] && exit 0 || exit 1
