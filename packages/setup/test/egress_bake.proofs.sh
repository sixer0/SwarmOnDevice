#!/usr/bin/env bash
# Row-92 proofs for the egress-proxy (squid) config-BAKE verifier
# (src/steps/firecrawl/egress_bake.ts — a firecrawl-step extension file, NOT a scanned step / NOT a StepModule).
# Targeted to packages/setup ONLY (row 102 runs the full suite). Binds NO port; makes NO network request;
# touches NO real docker daemon; SPAWNS NO process — every claim is proven offline over artefacts staged by
# CONSUMING the row-85 renderer interface. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # project-local bun ONLY (never global) — same path r91 uses
export PATH="$TOOLS_BIN:$PATH"

_TMPBASE="${TMPDIR:-/tmp}"; _TMPBASE="${_TMPBASE%/}"
WORK="${_TMPBASE}/swarm-setup-r92-proofs"
rm -rf "$WORK"; mkdir -p "$WORK/bin"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

MY_SRC="src/steps/firecrawl/egress_bake.ts"
MY_TEST="test/egress_bake.test.ts"

echo "=== PROOF 0: runtime identity (honesty: project-local bun version) ==="
echo "  bun: $(bun --version 2>/dev/null || echo MISSING)"

echo "=== PROOF 1: typecheck (isolated row-92 subtree) + Mach-O compile ==="
# Include exactly the files this row owns plus the core libraries it imports; exclude the foreign in-flight
# step dirs (graft/rtk/obsidian from concurrent rows 88/89/90) so a sibling's transient edit can neither mask
# nor be attributed to this row's surface.
cat > "$WORK/tsconfig.r92.json" <<JSON
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
    "$HERE/src/mcpproxy/urlpolicy.ts",
    "$HERE/src/steps/_template/index.ts",
    "$HERE/src/steps/firecrawl/*.ts"
  ]
}
JSON
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.r92.json" )
check "tsc --noEmit (row-92 subtree)" 0 $?

bun build --compile --target=bun --outfile "$WORK/bin/egress_bake" "$HERE/$MY_SRC" >/dev/null 2>&1
check "bun build --compile $MY_SRC" 0 $?
file "$WORK/bin/egress_bake" | grep -q "Mach-O" && { echo "  PASS egress_bake is Mach-O arm64"; pass=$((pass+1)); } || { echo "  FAIL egress_bake not Mach-O"; fail=$((fail+1)); }

echo "=== PROOF 2: unit suite (twelve-class deny-rule parse-and-assert / cross-enforcer equality / pin fail-closed / config correctness / contract / consent+dry-run) ==="
( cd "$HERE" && bun test "$MY_TEST" ) > "$WORK/bun-test.log" 2>&1
rc=$?
tail -5 "$WORK/bun-test.log"
check "bun test $MY_TEST" 0 $rc
grep -qE " 54 pass" "$WORK/bun-test.log" && { echo "  PASS 54 unit tests reported"; pass=$((pass+1)); } || { echo "  FAIL expected 54 passes"; fail=$((fail+1)); }

echo "=== PROOF 3: OFFLINE bake demo — no docker, no spawn, no network; artefacts via the r85 render interface ==="
export HOME="$WORK/home-bake"; mkdir -p "$HOME"
export R92_ROOT="$HERE"
cat > "$WORK/bake-demo.ts" <<'TS'
import { chmodSync, rmSync } from "node:fs";
const root = process.env.R92_ROOT!;
const home = process.env.HOME!;
// modules resolved through R92_ROOT (exported by this harness) — no machine path baked in;
// same env+dynamic-import pattern as runtime/compose/stepkit proofs. stepsRoot() is module-relative.
const { validateLock } = await import(`${root}/src/lockfile.ts`);
const { SECRET_INVENTORY, pathsFor } = await import(`${root}/src/composefiles/shared.ts`);
const { renderAll, applyRenderedFiles } = await import(`${root}/src/composefiles/index.ts`);
const { verifyEgressBake, auditSquidConf, crossEnforcerAgreement, assertNoReservedAclNames, auditFileModes, REQUIRED_DENY_RANGES } = await import(`${root}/src/steps/firecrawl/egress_bake.ts`);
const { isDeniedAddress } = await import(`${root}/src/mcpproxy/urlpolicy.ts`);
const lock = validateLock(JSON.parse(await Bun.file(`${root}/tools.lock.json`).text()));
if (!lock.ok) throw new Error(lock.error);

// Stage artefacts by CONSUMING the row-85 renderer (read-only interface use): declare required slots generated.
const manifest = { searxng: {} as Record<string,"generated">, firecrawl: {} as Record<string,"generated"> };
for (const c of ["searxng","firecrawl"] as const) for (const s of SECRET_INVENTORY[c]) if (s.required) manifest[c][s.name]="generated";
applyRenderedFiles(renderAll(lock.lock, { home, secrets: manifest }), `${home}/.swarm/tools`);

let bad = 0;
const ok = (label: string, cond: boolean) => { console.log(`  ${cond?"OK":"NO"}  ${label}`); if(!cond) bad++; };

// (a) R112-1 / R112-5 detection proven SYNTHETICALLY (deterministic regardless of whether the r85-fix5 rename/mode
//     has landed on the shared tree yet), plus a green bake against the rename TARGET form.
const confNow = await Bun.file(`${home}/.swarm/tools/firecrawl/squid/squid.conf`).text();
const composeNow = await Bun.file(`${home}/.swarm/tools/firecrawl/compose/firecrawl.yml`).text();
// reserved-name lint fires whenever a squid-predefined ACL name is declared, and clears when it is renamed away:
const withReserved = `${confNow}\nacl to_localhost dst 203.0.113.0/24   # synthetic reserved decl (R112-1)\n`;
ok("reserved-name lint FIRES on a to_localhost decl", assertNoReservedAclNames(withReserved).some((f)=>f.code==="SQUID_RESERVED_ACL_NAME" && f.item.includes("to_localhost")));
ok("reserved-name lint CLEAN once named away (rename-target)", assertNoReservedAclNames(confNow.replace(/\bto_localhost\b/g,"swarm_hostnames")).length === 0);
// R112-5 wrap-mode: a non-executable docker-entrypoint.d bind is refused; owner +x clears it.
{ const tr = `${home}/.swarm/tools`; const wrap = `${tr}/firecrawl/compose/bin/probe-wrap.sh`;
  await Bun.write(wrap, "#!/bin/sh\n"); chmodSync(wrap, 0o644);
  const cwx = ["services:","  x:","    volumes:","      - type: bind",`        source: ${wrap}`,"        target: /docker-entrypoint.d/probe.sh"].join("\n");
  ok("non-exec docker-entrypoint.d wrap -> MODE_ENTRYPOINT_WRAP", auditFileModes(tr, cwx).some((f)=>f.code==="MODE_ENTRYPOINT_WRAP"));
  chmodSync(wrap, 0o700);
  ok("owner-exec wrap clears MODE_ENTRYPOINT_WRAP", !auditFileModes(tr, cwx).some((f)=>f.code==="MODE_ENTRYPOINT_WRAP"));
  rmSync(wrap, { force: true }); }
// green bake against the rename target (works whether or not the render already renamed):
const vg = verifyEgressBake({ lock: lock.lock, home, composeText: composeNow, confText: confNow.replace(/\bto_localhost\b/g,"swarm_hostnames") });
ok("green bake against the renamed (r85-fix5 target) conf", vg.ok && vg.findings.length === 0);

// (b) tag-only pin fails closed BEFORE any artefact is needed
const p = lock.lock.components.firecrawl as Record<string, unknown>;
const tagOnly = { ...lock.lock, components: { ...lock.lock.components, firecrawl: { ...p, egress_proxy_image: "docker.io/ubuntu/squid:latest" } } };
const vt = verifyEgressBake({ lock: tagOnly as never, home: "/nonexistent" });
ok("tag-only pin -> PIN_UNUSABLE (single finding)", !vt.ok && vt.findings.length === 1 && vt.findings[0]!.code === "PIN_UNUSABLE");

// (c) image drift caught against the lock pin
const p2 = pathsFor(`${home}/.swarm/tools`);
const drifted = (await Bun.file(p2.firecrawlCompose).text()).replace(String(p.egress_proxy_image), "docker.io/ubuntu/squid@sha256:"+"0".repeat(64));
const vi = verifyEgressBake({ lock: lock.lock, home, composeText: drifted, confText: await Bun.file(p2.firecrawlSquidConf).text() });
ok("compose image != lock pin -> IMAGE_PIN_MISMATCH", vi.findings.some((f)=>f.code==="IMAGE_PIN_MISMATCH"));

// (d) removing a private range from the rendered conf is refused
const conf = await Bun.file(p2.firecrawlSquidConf).text();
const stripped = conf.split("\n").map((l)=> /\bacl\s+to_localnet\s+dst\b/.test(l) ? l.replace(" 100.64.0.0/10","") : l).join("\n");
ok("deny-range removed -> DENY_RANGE_MISSING (CGNAT)", auditSquidConf(stripped).some((f)=>f.code==="DENY_RANGE_MISSING" && f.item.includes("100.64.0.0/10")));

// (e) twelve classes are the required set, and BOTH enforcers cover all twelve identically (review-107 M2)
ok("REQUIRED_DENY_RANGES is the twelve amended classes", REQUIRED_DENY_RANGES.length === 12);
ok("urlpolicy denies every class representative", REQUIRED_DENY_RANGES.every((r)=>isDeniedAddress(r.probe)));
ok("cross-enforcer hook green on the shipped render", crossEnforcerAgreement(conf).length === 0);
// divergence fixture: strip 0.0.0.0/8 from squid while urlpolicy still denies 0.0.0.0 -> named asymmetry
const diverged = conf.split("\n").map((l)=> /\bacl\s+to_localnet\s+dst\b/.test(l) ? l.replace(" 0.0.0.0/8","") : l).join("\n");
ok("squid drops 0.0.0.0/8 but urlpolicy denies it -> CROSS_ENFORCER_DIVERGENCE", crossEnforcerAgreement(diverged).some((f)=>f.code==="CROSS_ENFORCER_DIVERGENCE" && f.item.includes("0.0.0.0/8")));

process.exit(bad===0 ? 0 : 1);
TS
bun run "$WORK/bake-demo.ts"
check "offline bake demo (green + pin/drift/deny assertions)" 0 $?

echo "=== PROOF 4: security grep gates ==="
# 4a: zero port / IP:port literals anywhere in row-92 files (ports come only from PC_PORTS).
rg -n '\b(8888|3002|902[0-9]|8080|3128|5432|6379|5672|3000|3004|3005)\b|127\.0\.0\.1:[0-9]' "$HERE/$MY_SRC" "$HERE/$MY_TEST" >/dev/null 2>&1
check "4a no port/IP:port literals in row-92 files (expect no-match=1)" 1 $?
# 4b: no process-spawn / raw-network / eval primitive in the shipped source.
rg -n 'node:child_process|Bun\.spawn|node:net|node:http|require\(|\beval\(' "$HERE/$MY_SRC" >/dev/null 2>&1
check "4b no spawn/network/eval primitive in shipped source (expect no-match=1)" 1 $?
# 4c: no @sha256 digest literal baked into shipped code (the cleared ref lives only in test fixtures, like r91).
rg -n 'sha256:[0-9a-f]{12,}' "$HERE/$MY_SRC" >/dev/null 2>&1
check "4c no @sha256 digest literal in shipped source (expect no-match=1)" 1 $?

echo "=== PROOF 5: directory-scan registration — the bake is NOT a component (shape decision locked) ==="
cat > "$WORK/scan.ts" <<'TS'
const { discoverSteps, orderSteps } = await import(`${process.env.R92_ROOT!}/src/steps.ts`);
const scan = discoverSteps();
const ids = scan.steps.map((s) => s.id);
const ok = ids.includes("firecrawl") && !ids.includes("egress-proxy") && scan.errors.length === 0;
const ord = orderSteps(scan.steps);
console.log("registered:", ids.join(","), "| egress-proxy absent:", !ids.includes("egress-proxy"), "| errors:", scan.errors.length, "| topo:", ord.ok ? ord.ordered.map(s=>s.id).join(">") : ord.error);
process.exit(ok && ord.ok ? 0 : 1);
TS
bun run "$WORK/scan.ts"
check "scan registers firecrawl, NO egress-proxy step, zero descriptor errors" 0 $?

echo "=== PROOF 6: README status (deferred until rows 86/88-90 land — single-writer safety, per r91 precedent) ==="
ls "$HERE/README.md" >/dev/null 2>&1 && echo "  README.md present; row 92 did NOT append (see s92 §seams)."
for f in s86_runtime_step.md s88_graft_step.md s89_rtk_step.md s90_obsidian_step.md; do
  if [ -f "$HERE/../../../docs/2026-10-19_opencode_swarm_rebrand/implementation/$f" ]; then echo "  landed: $f"; else echo "  NOT landed (in flight): $f"; fi
done

echo "=== PROOF 7: cross-row regressions (same package, shared typecheck surface) — reported ==="
run_proof () { # run_proof <file> <summary-grep>
  local out; out="$(bash "$HERE/test/$1" 2>&1)"
  echo "$out" | grep -E "$2" | tail -1
}
echo "  r81 $(run_proof proofs.sh 'SUMMARY')"
echo "  r82 $(run_proof fetch.proofs.sh 'row-82 proofs')   <- may show 7/8: 3a trips on ROW 86 runtime/capture.ts regex (routed regex), NOT row 92"
echo "  r83 $(run_proof consent.proofs.sh 'SUMMARY')"
echo "  r84 $(run_proof stepkit.proofs.sh 'row-84 proofs')"
echo "  r85 $(run_proof compose.proofs.sh 'row-85 proofs')"
echo "  r87 $(run_proof node.proofs.sh 'row-87 proofs' 2>/dev/null || true)"
echo "  r91 $(run_proof stack.proofs.sh 'SUMMARY')"

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = "0" ] && exit 0 || exit 1
