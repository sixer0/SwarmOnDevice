#!/usr/bin/env bash
# Row-92 proofs for the egress-proxy (squid) config-BAKE verifier
# (src/steps/firecrawl/egress_bake.ts — a firecrawl-step extension file, NOT a scanned step / NOT a StepModule).
# Targeted to packages/setup ONLY (row 102 runs the full suite). Binds NO port; makes NO network request;
# touches NO real docker daemon; SPAWNS NO process — every claim is proven offline over artefacts staged by
# CONSUMING the row-85 renderer interface. Safe to re-run.
# WHAT OFFLINE CAN AND CANNOT PROVE (R112b-1's lesson, encoded in bakeProofLayers()): the layers here cover
# artefact facts + directive SHAPES (the R112b-1 inline-comment class included); "squid binds PC-PORT-06 and answers
# a CONNECT" is live-only and stays with rows 93/112. PROOF 7 (sibling rows) is opt-in via R92_REGRESS=1 per
# driver_rules_s3 rule 6.
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

echo "=== PROOF 2: unit suite (twelve-class deny-rule parse-and-assert / cross-enforcer equality / BOOT-CLASS R112b-1 / pin fail-closed / config correctness / contract / consent+dry-run) ==="
( cd "$HERE" && bun test "$MY_TEST" ) > "$WORK/bun-test.log" 2>&1
rc=$?
tail -5 "$WORK/bun-test.log"
check "bun test $MY_TEST" 0 $rc
grep -qE " 79 pass" "$WORK/bun-test.log" && { echo "  PASS 79 unit tests reported"; pass=$((pass+1)); } || { echo "  FAIL expected 79 passes"; fail=$((fail+1)); }

echo "=== PROOF 3: OFFLINE bake demo — no docker, no spawn, no network; artefacts via the r85 render interface ==="
echo "    (honesty: this proves ARTEFACT + DIRECTIVE-SHAPE facts. It cannot boot squid, so 'binds PC-PORT-06' is"
echo "     declared live-only by bakeProofLayers() below and stays row 93/112 territory.)"
export HOME="$WORK/home-bake"; mkdir -p "$HOME"
export R92_ROOT="$HERE"
cat > "$WORK/bake-demo.ts" <<'TS'
import { chmodSync, rmSync } from "node:fs";
const root = process.env.R92_ROOT!;
const home = process.env.HOME!;
// modules resolved through R92_ROOT (exported by this harness) — no machine path baked in;
// same env+dynamic-import pattern as runtime/compose/stepkit proofs. stepsRoot() is module-relative.
const { validateLock } = await import(`${root}/src/lockfile.ts`);
const { SECRET_INVENTORY, pathsFor, PC_PORTS } = await import(`${root}/src/composefiles/shared.ts`);
const { renderAll, applyRenderedFiles } = await import(`${root}/src/composefiles/index.ts`);
const { verifyEgressBake, auditSquidConf, crossEnforcerAgreement, assertNoReservedAclNames, auditFileModes, auditBootClass, bakeProofLayers, REQUIRED_DENY_RANGES } = await import(`${root}/src/steps/firecrawl/egress_bake.ts`);
// Fixture builders for the R112b-1 shape and its correction (twins of the ones in test/egress_bake.test.ts; in-memory
// only — this demo writes nothing into the staged estate). r112b1Shape re-attaches a trailing comment to a BARE
// http_port line; if the renderer still carries one, its text already IS the shape and passes through unchanged.
const r112b1Shape = (t: string): string => t.replace(/^(\s*https?_port[^\n#]*?)\s*$/m, (_a, head: string) => `${head}   # PC-PORT-06 (unpublished; fc-ctl only)`);
const portCommentsFixed = (t: string): string => t.split("\n").flatMap((l: string) => {
  const m = l.match(/^(\s*(?:https?_port)\b[^#]*)#\s*(.*)$/);
  return m ? [(m[1] ?? "").trimEnd(), `  # ${m[2] ?? ""}`] : [l];
}).join("\n");
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
// green bake against the TARGET shape (rename + comment off the port directive; works whether or not r85-fix5/fix6 have landed):
const targetConf = portCommentsFixed(confNow.replace(/\bto_localhost\b/g,"swarm_hostnames"));
const vg = verifyEgressBake({ lock: lock.lock, home, composeText: composeNow, confText: targetConf });
ok("green bake against the target-shape conf (r85-fix5 rename + r85-fix6 comment move)", vg.ok && vg.findings.length === 0);

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

// (f) BOOT-CLASS audit (R112b-1 -> R112b-5): refuse the shape that PARSES but registers no forward-proxy port, and prove
//     the three older layers cannot see it. Fixtures are derived from the target-shape artefact, so they bite in both
//     worlds — renderer fixed or not.
const b1Bad = r112b1Shape(targetConf);
const b1Codes = auditBootClass(b1Bad).map((f)=>f.code);
ok("NEGATIVE CONTROL: R112b-1 shape -> SQUID_INLINE_COMMENT_ON_DIRECTIVE", b1Codes.includes("SQUID_INLINE_COMMENT_ON_DIRECTIVE"));
ok("NEGATIVE CONTROL: R112b-1 shape -> SQUID_FORWARD_PORT_UNREGISTERED", b1Codes.includes("SQUID_FORWARD_PORT_UNREGISTERED"));
ok("BLIND SPOT CONFIRMED: auditSquidConf + reserved-lint + cross-enforcer all silent on that text",
   auditSquidConf(b1Bad).length===0 && assertNoReservedAclNames(b1Bad).length===0 && crossEnforcerAgreement(b1Bad).length===0);
ok("POSITIVE CONTROL: comment on its own line -> boot-class audit CLEAN", auditBootClass(targetConf).length===0);
const vb = verifyEgressBake({ lock: lock.lock, home, composeText: composeNow, confText: b1Bad });
ok("end-to-end: verifyEgressBake REFUSES the R112b-1 config (fail-closed onto F-3)", !vb.ok && vb.findings.map((f)=>f.code).includes("SQUID_INLINE_COMMENT_ON_DIRECTIVE"));
const wrongPort = targetConf.replace(/^(\s*https?_port)\s*\d+.*$/m, (_m, d: string) => `${d} ${PC_PORTS.squidContainer + 1}`);
ok("conf port other than PC-PORT-06 -> SQUID_FORWARD_PORT_MISMATCH", auditBootClass(wrongPort).some((f)=>f.code==="SQUID_FORWARD_PORT_MISMATCH"));

// (g) PROOF-LAYER DECLARATION + soft calibration against row 112's live A/B logs (read-only; absent => UNKNOWN, never a pass)
const layers = bakeProofLayers();
console.log(`  INFO  bakeProofLayers(): offlineProven=${layers.offlineProven.length} offlineInferred=${layers.offlineInferred.length} liveOnly=${layers.liveOnly.length}`);
for (const l of layers.liveOnly) console.log(`        LIVE-ONLY (only a real boot/pull proves this): ${l}`);
ok("declaration keeps a non-empty live-only set (offline green never claims a bound port)", layers.liveOnly.length > 0 && layers.offlineInferred.length > 0);
{ const base = (process.env.TMPDIR ?? "").replace(/\/$/,""); const dir = base ? `${base}/swarm-setup-r112b-proofs` : "";
  const badLog = dir ? `${dir}/squid-cache.log` : ""; const p1Log = dir ? `${dir}/squid-cache-p1.log` : "";
  if (badLog && p1Log && await Bun.file(badLog).exists() && await Bun.file(p1Log).exists()) {
    const needle = "No forward-proxy ports configured.";
    const badHits = (await Bun.file(badLog).text()).split("\n").filter((l)=>l.includes(needle)).length;
    const p1Hits = (await Bun.file(p1Log).text()).split("\n").filter((l)=>l.includes(needle)).length;
    console.log(`  INFO  live A/B calibration (verifier scratch, read-only): bad-shape log ${badHits}x / corrected-shape log ${p1Hits}x '${needle}'`);
    ok("offline rule agrees with the live A/B direction (bad>0, corrected==0)", badHits>0 && p1Hits===0);
  } else {
    console.log("  UNKNOWN  live A/B logs absent — the offline rule rests on the shipped fixture only (not reported as passed)");
  } }

process.exit(bad===0 ? 0 : 1);
TS
bun run "$WORK/bake-demo.ts"
check "offline bake demo (green + pin/drift/deny + R112b-1 boot-class controls + proof layers)" 0 $?

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

echo "=== PROOF 7: cross-row regressions (same package, shared typecheck surface) — OPT-IN ==="
# driver_rules_s3 rule 6: run ONLY this row's targeted suite + the workspace typecheck. Sibling proof scripts are
# other rows' suites, so they are opt-in here (same pattern as r91's R91_REGRESS gate) instead of running by default.
if [ "${R92_REGRESS:-0}" = "1" ]; then
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
else
  echo "  SKIPPED (default) — rule 6 targeted-only. Set R92_REGRESS=1 to run r81-r87+r91 serially; sibling deltas"
  echo "  during concurrent fix rounds are attributed in implementation/s92_egress_bake.md."
fi

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = "0" ] && exit 0 || exit 1
