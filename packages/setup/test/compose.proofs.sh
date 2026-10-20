#!/usr/bin/env bash
# Row 85 proofs — compose-file writer step (src/composefiles/ service tree).
# Targeted to packages/setup ONLY (row 102 owns the full suite). Binds NO port; makes NO
# network request (the renderer is pure; docker-extraction path is delegated to row 92's
# tooling by interface, never invoked here). Dry-run renders land in $WORK (temp) only.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="${TMPDIR:-/tmp}/swarm-setup-r85-proofs"
rm -rf "$WORK"; mkdir -p "$WORK/bin"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}

echo "=== PROOF 1: typecheck + Mach-O compile (toolchain: TypeScript via Bun) ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
TSC_RC=$?
check "tsc --noEmit" 0 $TSC_RC
if [ "$TSC_RC" != 0 ]; then
  # Attribution aid (r87 precedent): re-run scoped to this row's surface when the shared package
  # typecheck is red from ACTIVE siblings' in-flight files; informational, not a counted check.
  cat > "$WORK/scoped-tsconfig.json" <<JSON2
{
  "extends": "$HERE/tsconfig.json",
  "include": ["$HERE/src/**/*.ts", "$HERE/types/**/*.d.ts"],
  "exclude": ["dist", "node_modules"]
}
JSON2
  ( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/scoped-tsconfig.json" > "$WORK/tsc-scoped.log" 2>&1; echo "scoped exit $?" )
  echo "  INFO full-package tsc red; scoped log:"; sed 's/^/      /' "$WORK/tsc-scoped.log" | head -6
fi
bun build --compile --target=bun --outfile "$WORK/bin/swarm-setup" "$HERE/src/index.ts" >/dev/null 2>&1
check "bun build --compile index.ts (whole program)" 0 $?
bun build --compile --target=bun --outfile "$WORK/bin/compose-files" "$HERE/src/composefiles/index.ts" >/dev/null 2>&1
check "bun build --compile composefiles/index.ts (standalone renderer CLI)" 0 $?
file "$WORK/bin/compose-files" | grep -q "Mach-O" && echo "  PASS renderer CLI is Mach-O arm64" || { echo "  FAIL renderer CLI not Mach-O"; fail=$((fail+1)); }

echo "=== PROOF 2: registration visible in status output (service posture, 01c §9) ==="
cp "$HERE/tools.lock.json" "$WORK/bin/tools.lock.json"   # compiled posture: lock beside the binary (r81 precedent)
mkdir -p "$WORK/home-status"
HOME="$WORK/home-status" "$WORK/bin/compose-files" status > "$WORK/status.out" 2>&1
check "renderer CLI status exits 0" 0 $?
grep -q "renderer: compose-files" "$WORK/status.out" && grep -q "lock version: swarm-tools-1.19.3-r1" "$WORK/status.out" \
  && echo "  PASS status names the renderer + live lock version" || { echo "  FAIL status missing registration"; cat "$WORK/status.out"; fail=$((fail+1)); }
grep -q "RESULT OK" "$WORK/status.out" && echo "  PASS RESULT OK token (D-23)" || { echo "  FAIL no RESULT OK"; fail=$((fail+1)); }
# The directory scan stays intact: the main program's dry-run shows NO descriptor errors.
mkdir -p "$WORK/home-scan"
HOME="$WORK/home-scan" "$WORK/bin/swarm-setup" install --dry-run > "$WORK/dryrun.out" 2> "$WORK/dryrun.err"
grep -q "step descriptor error" "$WORK/dryrun.err" \
  && { echo "  FAIL scan broke (descriptor error emitted)"; fail=$((fail+1)); } \
  || echo "  PASS directory scan clean: compose-files registered as service, not as a bogus component step"

echo "=== PROOF 3: render dry-run is byte-stable (two runs, sha256-equal trees) ==="
HOME="$WORK/home-render" "$WORK/bin/compose-files" render --out "$WORK/render-a" --home /Users/tester > "$WORK/render-a.out" 2>&1
check "render run A" 0 $?
HOME="$WORK/home-render" "$WORK/bin/compose-files" render --out "$WORK/render-b" --home /Users/tester > "$WORK/render-b.out" 2>&1
check "render run B" 0 $?
( cd "$WORK/render-a" && find . -type f | sort | xargs shasum -a 256 ) > "$WORK/sha-a.txt"
( cd "$WORK/render-b" && find . -type f | sort | xargs shasum -a 256 ) > "$WORK/sha-b.txt"
if diff -q "$WORK/sha-a.txt" "$WORK/sha-b.txt" >/dev/null; then
  echo "  PASS two renders byte-identical ($(wc -l < "$WORK/sha-a.txt" | tr -d ' ') artefacts):"; sed 's/^/      /' "$WORK/sha-a.txt"
  pass=$((pass+1))
else
  echo "  FAIL renders differ"; diff "$WORK/sha-a.txt" "$WORK/sha-b.txt"; fail=$((fail+1))
fi

echo "=== PROOF 4: every image line matches an @sha256 digest from tools.lock.json ==="
LOCK="$HERE/tools.lock.json"
grep -hE '^\s*image: ' "$WORK/render-a/searxng/compose/searxng.yml" "$WORK/render-a/firecrawl/compose/firecrawl.yml" \
  | sed -E 's/.*@sha256:([0-9a-f]{64}).*/\1/' | sort -u > "$WORK/digests.txt"
NDIG=$(wc -l < "$WORK/digests.txt" | tr -d ' ')
BAD=0
while IFS= read -r d; do
  grep -q "$d" "$LOCK" || { echo "  digest NOT in lock: $d"; BAD=1; }
done < "$WORK/digests.txt"
if [ "$BAD" = 0 ] && [ "$NDIG" = 9 ]; then
  echo "  PASS all $NDIG unique image digests ⊂ tools.lock.json (2 searxng-stack + 7 firecrawl-stack)"; pass=$((pass+1))
else
  echo "  FAIL digest proof (unique=$NDIG badref=$BAD)"; fail=$((fail+1))
fi
# No image line may lack a digest:
NIMG=$(grep -hE '^\s*image: ' "$WORK/render-a"/*/compose/*.yml | wc -l | tr -d ' ')
NWITH=$(grep -hE '^\s*image: \S+@sha256:[0-9a-f]{64}' "$WORK/render-a"/*/compose/*.yml | wc -l | tr -d ' ')
[ "$NIMG" = "$NWITH" ] && [ "$NIMG" = 9 ] && echo "  PASS 9/9 image refs carry @sha256 (tag-without-digest impossible)" || { echo "  FAIL image lines=$NIMG with-digest=$NWITH"; fail=$((fail+1)); }

echo "=== PROOF 5: published ports — exactly 2 per estate at PORT-BLOCK values 9021/9022, 1 per file ==="
NP_SEX=$(grep -c '^      - "127\.' "$WORK/render-a/searxng/compose/searxng.yml")
NP_FC=$(grep -c '^      - "127\.' "$WORK/render-a/firecrawl/compose/firecrawl.yml")
NP_ALL=$(grep -hE '^\s+- "' "$WORK/render-a"/*/compose/*.yml | wc -l | tr -d ' ')
NONLOOP=$(grep -hE '^\s+- "' "$WORK/render-a"/*/compose/*.yml | grep -vc '"127\.0\.0\.1:' || true)
V_9021=$(grep -c '"127\.0\.0\.1:9021:' "$WORK/render-a/searxng/compose/searxng.yml")
V_9022=$(grep -c '"127\.0\.0\.1:9022:' "$WORK/render-a/firecrawl/compose/firecrawl.yml")
V_OLD=$(grep -rhE '[:"]8888\b' "$WORK/render-a" | wc -l | tr -d ' ')  # binding-form only; marked history prose is allowed
V_X9021=$(grep -c '"127\.0\.0\.1:9021:' "$WORK/render-a/firecrawl/compose/firecrawl.yml" || true)
V_X9022=$(grep -c '"127\.0\.0\.1:9022:' "$WORK/render-a/searxng/compose/searxng.yml" || true)
if [ "$NP_SEX" = 1 ] && [ "$NP_FC" = 1 ] && [ "$NP_ALL" = 2 ] && [ "$NONLOOP" = 0 ] \
   && [ "$V_9021" = 1 ] && [ "$V_9022" = 1 ] && [ "$V_OLD" = 0 ] && [ "$V_X9021" = 0 ] && [ "$V_X9022" = 0 ]; then
  echo "  PASS '- \"127.' = 1+1 = 2 per estate; values exactly 9021(searxng)/9022(firecrawl);";
  echo "        zero 8888 anywhere in the render tree; no cross-file port leakage (PORT BLOCK r72-fix2)"; pass=$((pass+1))
else
  echo "  FAIL ports (sex=$NP_SEX fc=$NP_FC total=$NP_ALL nonloop=$NONLOOP 9021=$V_9021 9022=$V_9022 old8888=$V_OLD x9021=$V_X9021 x9022=$V_X9022)"; fail=$((fail+1))
fi

echo "=== PROOF 5b: TWELVE deny classes rendered + deny-before-allow ordering (review-107 M2 / r75-fix4) ==="
SQ="$WORK/render-a/firecrawl/squid/squid.conf"
NC=$(sed 's/#.*//' "$SQ" | grep -E '^acl to_localnet dst ' | tr ' ' '\n' | grep -cE '^(127\.0\.0\.0/8|::1/128|10\.0\.0\.0/8|172\.16\.0\.0/12|192\.168\.0\.0/16|169\.254\.0\.0/16|100\.64\.0\.0/10|fe80::/10|fc00::/7|0\.0\.0\.0/8|::/128|64:ff9b::/96)$')
NEW3=$(grep -c -e '0\.0\.0\.0/8' -e '::/128' -e '64:ff9b::/96' <(sed 's/#.*//' "$SQ" | grep '^acl to_localnet dst ') || true)
LAST_DENY=$(grep -nE 'http_access deny (to_localnet|swarm_hostnames)$' "$SQ" | tail -1 | cut -d: -f1)
FIRST_ALLOW=$(grep -n 'http_access allow' "$SQ" | head -1 | cut -d: -f1)
DENY_ALL=$(grep -n 'http_access deny all' "$SQ" | tail -1 | cut -d: -f1)
if [ "$NC" = 12 ] && [ "$FIRST_ALLOW" -gt "$LAST_DENY" ] && [ "$DENY_ALL" -gt "$FIRST_ALLOW" ]; then
  echo "  PASS 12 unique deny-class literals on the dst lines; every destination deny (last line $LAST_DENY) above the first allow (line $FIRST_ALLOW); deny all last ($DENY_ALL)"; pass=$((pass+1))
else
  echo "  FAIL deny-set/ordering (classes=$NC lastDestDeny=$LAST_DENY firstAllow=$FIRST_ALLOW denyAll=$DENY_ALL)"; fail=$((fail+1))
fi

echo "=== PROOF 6: F-79-E version-label lint rejects a tampered-version fixture ==="
export R85_ENTRY="$HERE/src/composefiles/index.ts"
export R85_LOCKMOD="$HERE/src/lockfile.ts"
export R85_LOCK="$HERE/tools.lock.json"
cat > "$WORK/f79e-demo.ts" <<'TS'
// (1) label tampered against the real lock -> lint refuses; (2) lock tampered -> labels follow
// the lock (values come from lock/state, never re-hardcoded); stale-version lint still refuses.
import { readFileSync } from "node:fs";
const { lintComposeText, lintOk, renderAll } = await import(process.env.R85_ENTRY!);
const { validateLock } = await import(process.env.R85_LOCKMOD!);
const lockJson = JSON.parse(readFileSync(process.env.R85_LOCK!, "utf8"));
const lock = validateLock(lockJson).lock;
const manifest = {
  home: "/Users/tester",
  secrets: {
    searxng: { secret_key: "generated", valkey_auth: "absent" },
    firecrawl: { proxy_token: "generated", postgres_password: "generated", bull_auth_key: "generated", redis_auth: "generated", rabbitmq_password: "absent" },
  },
};
const clean = renderAll(lock, manifest);
if (!clean.ok) { console.error("baseline render failed"); process.exit(2); }
const sx = clean.files.find((f) => f.relPath === "searxng/compose/searxng.yml").content;

// (1) tampered LABEL fixture
const tamperedLabel = sx.replace("swarm-tools-1.19.3-r1", "swarm-tools-9.9.9-r9");
const f1 = lintComposeText(tamperedLabel, { lockVersion: lock.version });
console.log("tampered-LABEL  -> lintOk =", lintOk(f1), "| version-label findings =", f1.filter((x) => x.rule === "version-label").length);

// (2) tampered LOCK fixture: labels must FOLLOW the lock, and the equality gate catches desync
const bad = JSON.parse(JSON.stringify(lockJson)); bad.version = "swarm-tools-2.0.0-r9";
const lock2 = validateLock(bad).lock;
const r2 = renderAll(lock2, manifest);
if (!r2.ok) { console.error("lock-driven render failed"); process.exit(2); }
const sx2 = r2.files.find((f) => f.relPath === "searxng/compose/searxng.yml").content;
console.log("tampered-LOCK   -> labels followed lock:", sx2.includes('io.gsp.swarm.version: "swarm-tools-2.0.0-r9"'));
const f2 = lintComposeText(sx2, { lockVersion: "swarm-tools-1.19.3-r1" });
console.log("tampered-LOCK   -> stale-version lintOk =", lintOk(f2), "| version-label findings =", f2.filter((x) => x.rule === "version-label").length);

const refusedByRender = !renderAll(lock, { ...manifest, _tamperVersionLabel: "swarm-tools-9.9.9-r9" }).ok;
console.log("renderAll seam-tamper refused:", refusedByRender);
process.exit(!lintOk(f1) && !lintOk(f2) && refusedByRender ? 0 : 1);
TS
bun run "$WORK/f79e-demo.ts" | tee "$WORK/f79e.out"
check "F-79-E lint refuses tampered-version fixtures" 0 $?

echo "=== PROOF 7: security grep gates over the NEW sources ==="
NEW=( "$HERE"/src/composefiles/*.ts )
grep -nE '\.(listen|bind)\(|createServer|Bun\.serve|Deno\.listen|startTls|createConnection|net\.connect|http\.Server' "${NEW[@]}" >/dev/null 2>&1
check "7a no bind/listen primitive (PORT RULE)" 1 $?
grep -nE 'from "node:child_process"|Bun\.spawn|spawnSync\(|execFile\(|execSync\(|from "node:(https?|net|dgram|tls)"|fetch\(|XMLHttpRequest' "${NEW[@]}" >/dev/null 2>&1
check "7b no process-spawn / network primitive (renderer is pure; extraction delegated by interface)" 1 $?
grep -nE 'rejectUnauthorized|NODE_TLS_REJECT_UNAUTHORIZED|GIT_SSL_NO_VERIFY|ignore_ssl|--insecure' "${NEW[@]}" >/dev/null 2>&1
check "7c insecure-TLS tokens return nothing (P-17)" 1 $?
grep -nE '\| *(ba|z)?sh|bash -c "\$\(|eval ' "${NEW[@]}" >/dev/null 2>&1
check "7d pipe-to-shell returns nothing (P-3)" 1 $?
# 7e REVIEW-107 MAJOR-1 argv-leak gate over the RENDERED TREE (code portions; mirrors lint.ts SECRET_ARGV_PATTERNS):
# a generated secret must never sit in an exec'd argument (docker top//proc/cmdline exposure).
LEAK=$(sed 's/#.*//' "$WORK"/render-a/*/*.yml "$WORK"/render-a/*/*.conf "$WORK"/render-a/*/*.template "$WORK"/render-a/*/*.env "$WORK"/render-a/*/compose/bin/* 2>/dev/null \
  | grep -cE -- '--requirepass[[:space:]]+["'"'"']?\$|[[:space:]]-a[[:space:]]+["'"'"']?\$\(|\bexec[[:space:]][^$]*\$\([[:space:]]*cat[[:space:]]+/run/secrets' || true)
if [ "$LEAK" = 0 ]; then echo "  PASS 7e zero secret-in-argv shapes across all 10 rendered artefacts (REVIEW-107 M1 gate)"; pass=$((pass+1));
else echo "  FAIL 7e argv-leak matches=$LEAK"; grep -nE -- '--requirepass[[:space:]]+["'"'"']?\$|[[:space:]]-a[[:space:]]+["'"'"']?\$\(|\bexec[[:space:]][^$]*\$\([[:space:]]*cat[[:space:]]+/run/secrets' "$WORK"/render-a/*/*.yml "$WORK"/render-a/*/compose/bin/* 2>/dev/null | head -5; fail=$((fail+1)); fi

echo "=== PROOF 7f: R112-1 reserved ACL names absent + R112-5 wrap modes land clean ==="
grep -qE '^acl\s+(all|manager|localhost|to_localhost|to_linklocal|CONNECT)\s' "$SQ" \
  && { echo "  FAIL 7f rendered squid.conf declares a PREDEFINED ACL name (boot-FATAL class)"; fail=$((fail+1)); } \
  || { echo "  PASS 7f no reserved-ACL declaration in rendered squid.conf (swarm_hostnames rename live)"; pass=$((pass+1)); }
MODES_OK=1
stat -f '%Lp %N' "$WORK/render-a/firecrawl/compose/bin/"* | while read -r m f; do case "$m" in 600|700) ;; *) echo "  bad mode $m $f"; exit 1;; esac; done || MODES_OK=0
[ "$(stat -f '%Lp' "$WORK/render-a/firecrawl/compose/bin/fc-nginx-env.envsh")" = 700 ] || MODES_OK=0
if [ "$MODES_OK" = 1 ]; then echo "  PASS 7f applied wrap modes: fc-nginx-env.envsh=700 (entrypoint-mounted, R112b-2 sourced channel), all others 600, zero group/world bits"; pass=$((pass+1)); else echo "  FAIL 7f wrap modes wrong"; fail=$((fail+1)); fi

echo "=== PROOF 8: unit suite (88 tests incl. one failing + one passing fixture per lint rule) ==="
( cd "$HERE" && bun test test/compose_files.test.ts ) > "$WORK/bun-test.log" 2>&1
rc=$?
tail -5 "$WORK/bun-test.log"
check "bun test test/compose_files.test.ts" 0 $rc

echo "=== PROOF 9: R112b fix-round 6 — inline-comment directive class / .envsh token channel / healthcheck tool absence ==="
# 9a (independent grep side): the rendered http_port carries NO trailing comment and its value is
# artefact-derived (equals PC_PORTS.squidContainer in shared.ts — no new port literal introduced here).
HP_VAL=$(awk '/^http_port/{print $2}' "$SQ")
HP_HAS_COMMENT=$(awk '/^http_port/{print}' "$SQ" | grep -c '#' || true)
NOTE_ABOVE=$(awk '/^# PC-PORT-06 squid listen/{n=NR} /^http_port/{print (n && n < NR) ? "yes" : "no"}' "$SQ")
OPT_IC=$(grep -E '^(http_port|https_port|ftp_port|visible_hostname|cache(_dir|mem)?|max_object_size|access_log|pid_filename|coredump_dir|dns_v4_first)([[:space:]]|$)' <(sed -n '1,200p' "$SQ") | grep -c '#' || true)
if [ "$HP_HAS_COMMENT" = 0 ] && [ "$NOTE_ABOVE" = "yes" ] && [ "$OPT_IC" = 0 ] \
   && grep -q "squidContainer: $HP_VAL" "$HERE/src/composefiles/shared.ts"; then
  echo "  PASS 9a-grep http_port=$HP_VAL renders bare with own-line note; zero inline comments on option-parsed directives; value matches the register mirror"; pass=$((pass+1))
else
  echo "  FAIL 9a-grep (val=$HP_VAL comment=$HP_HAS_COMMENT note=$NOTE_ABOVE optInline=$OPT_IC)"; fail=$((fail+1));
fi
# 9b/9c + 9a-lint side (mechanical golden/negative proof incl. the shipped-bad reconstructions):
export R85_ENTRY="$HERE/src/composefiles/index.ts"
export R85_LINT="$HERE/src/composefiles/lint.ts"
export R85_SHARED="$HERE/src/composefiles/shared.ts"
export R85_LOCK="$HERE/tools.lock.json"
export R85_WORK="$WORK"
cat > "$WORK/r85f6-demo.ts" <<'TS'
// FIX ROUND 6 mechanical proofs. Each prints one line; exit 0 only when ALL hold:
//  9a  rendered squid.conf is inline-comment-clean AND the reconstructed shipped-bad http_port
//      form (13b_live_firecrawl_rerun.md:133) is refused by findDirectiveInlineComments
//  9b  compose mounts /docker-entrypoint.d/05-swarm-env.envsh (never .sh); the wrap survives
//      findWrapChannelViolations; sourcing simulation: exports persist through `. wrap` under
//      set -eu AND an empty secret kills the boot before export (fail-closed); with a token set,
//      whitelist envsubst lands it in the compare line (no empty-bearer form, nginx vars intact)
//  9c  api + playwright-service render NO healthcheck; every wget/curl test line belongs to
//      auth-proxy only (alpine busybox ships it); findHealthcheckToolAbsent refuses the
//      reconstructed wget-on-api form
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
const { renderAll } = await import(process.env.R85_ENTRY!);
const L = await import(process.env.R85_LINT!);
const { PC_PORTS } = await import(process.env.R85_SHARED!);
const lock = JSON.parse(readFileSync(process.env.R85_LOCK!, "utf8"));
const WORK = process.env.R85_WORK!;
const manifest = {
  home: "/Users/tester",
  secrets: {
    searxng: { secret_key: "generated", valkey_auth: "absent" },
    firecrawl: { proxy_token: "generated", postgres_password: "generated", bull_auth_key: "generated", redis_auth: "generated", rabbitmq_password: "absent" },
  },
};
const r = renderAll(lock, manifest);
if (!r.ok) { console.error("baseline render failed:", JSON.stringify(r.findings)); process.exit(2); }
const file = (rel: string) => r.files.find((f: any) => f.relPath === rel);
const sq = file("firecrawl/squid/squid.conf").content;
const fc = file("firecrawl/compose/firecrawl.yml").content;
const sx = file("searxng/compose/searxng.yml").content;
let bad = 0;
const say = (ok: boolean, line: string) => { console.log((ok ? "OK   " : "BAD  ") + line); if (!ok) bad++; };

// --- 9a ---
say(sq.split("\n").find((l) => l.startsWith("http_port")) === `http_port ${PC_PORTS.squidContainer}`, "9a http_port renders as bare directive (value from PC_PORTS)");
say(L.findDirectiveInlineComments(sq).length === 0, "9a golden: rendered conf carries zero inline comments on option-parsed directives");
const shippedBad = sq.replace(`http_port ${PC_PORTS.squidContainer}\n`, `http_port ${PC_PORTS.squidContainer}               # PC-PORT-06 (unpublished)\n`);
say(shippedBad !== sq && L.findDirectiveInlineComments(shippedBad).length === 1, "9a negative: shipped-bad inline-comment form refused by the new lint");

// --- 9b ---
say(fc.includes("target: /docker-entrypoint.d/05-swarm-env.envsh") && !fc.includes("/docker-entrypoint.d/05-swarm-env.sh"), "9b compose mounts the wrap as SOURCED .envsh (subshell .sh form gone)");
const wrap = file("firecrawl/compose/bin/fc-nginx-env.envsh");
say(L.findWrapChannelViolations(r.files).length === 0, "9b golden: shipped wrap satisfies the channel gate (.envsh, no-exec, no RO write, export + empty-guard)");
const dir = `${WORK}/chan-sim`; writeFileSync(`${dir}.token`, "tok-abc-123");
const wrapSim = wrap.content.replaceAll("/run/secrets/proxy_token", `${dir}.token`);
writeFileSync(`${dir}.envsh`, wrapSim);
writeFileSync(`${dir}-runner.sh`, `set -eu\n. '${dir}.envsh'\nprintf 'GOT=[%s]' "$SWARM_FIRECRAWL_TOKEN"\n`);
const simOk = spawnSync("/bin/sh", [`${dir}-runner.sh`], { encoding: "utf8" });
say(simOk.stdout.includes("GOT=[tok-abc-123]"), "9b sourcing proof: export persists through dot-source (the .sh subshell could never do this)");
writeFileSync(`${dir}.token`, "");
const simDead = spawnSync("/bin/sh", [`${dir}-runner.sh`], { encoding: "utf8" });
say(simDead.status !== 0 && !simDead.stdout.includes("GOT="), "9b fail-closed proof: empty secret aborts the sourced wrap BEFORE any export");
if (Bun.which("envsubst")) {
  const tpl = file("firecrawl/nginx/default.conf.template").content;
  const out = execFileSync("envsubst", ["${SWARM_FIRECRAWL_TOKEN}"], { input: tpl, encoding: "utf8", env: { ...process.env, SWARM_FIRECRAWL_TOKEN: "tok-abc-123" } });
  say(out.includes("Bearer tok-abc-123") && !out.includes("${SWARM_FIRECRAWL_TOKEN}") && out.includes("$http_authorization") && !out.includes('"Bearer "'), "9b envsubst proof: token lands in the compare line; nginx vars untouched; no empty-bearer form");
} else {
  console.log("SKIP 9b envsubst proof (host lacks GNU envsubst — UNKNOWN here, container-side proven live)");
}

// --- 9c ---
const svcOf = (text: string, want: string) => {
  let name = ""; let body: string[] = [];
  for (const l of text.split("\n")) {
    const m = l.match(/^  ([a-z][a-z0-9-]*):/);
    if (m) { if (name === want) break; name = m[1]; body = []; continue; }
    if (name === want) body.push(l);
  }
  return body;
};
for (const svcName of ["api", "playwright-service"]) {
  const body = svcOf(fc, svcName);
  say(!body.some((l) => /^\s+healthcheck:/.test(l) && !l.trimStart().startsWith("#")), `9c ${svcName}: renders NO healthcheck (R112b-3 ruling; host gate owns readiness)`);
}
let wgetOutsideProxy = 0; let svc = "";
for (const text of [fc, sx]) for (const l of text.split("\n")) {
  const m = l.match(/^  ([a-z][a-z0-9-]*):/); if (m) svc = m[1];
  if (/^\s+test:\s*\[/.test(l) && !l.trimStart().startsWith("#") && /"(wget|curl)\b/.test(l.replace(/#.*/, "")) && svc !== "auth-proxy") wgetOutsideProxy++;
}
say(wgetOutsideProxy === 0, "9c every wget/curl healthcheck test line belongs to auth-proxy only (alpine busybox ships it; digests lacking it use none)");
for (const svcName of ["redis", "rabbitmq", "nuq-postgres"]) {
  const body = svcOf(fc, svcName);
  say(body.some((l) => /^\s+healthcheck:/.test(l)), `9c ${svcName}: vendor-independent healthcheck KEPT per ruling`);
}
const badApi = fc.replace("    # NO healthcheck — R112b-3 (r112b live VM): the pinned api digest ships NO wget", `    healthcheck:\n      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:${PC_PORTS.apiContainer}/v0/health/readiness || exit 1"]\n    # NO healthcheck — R112b-3 (r112b live VM): the pinned api digest ships NO wget`);
say(badApi !== fc && L.findHealthcheckToolAbsent(badApi).length === 1, "9c negative: reconstructed wget-on-api form refused by HEALTHCHECK_TOOL_ABSENT");

console.log(bad === 0 ? "RESULT OK" : `RESULT FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
TS
bun run "$WORK/r85f6-demo.ts" | tee "$WORK/r85f6.out"
check "R112b mechanical proofs (9a lint-pair, 9b channel+sourcing+envsubst, 9c render+negative)" 0 $?

echo "=== PROOF 10: R112b-4 topology (r75-fix6 ruling §5) — internal browser segment on the RENDERED artefact ==="
# Same five facts as the unit-suite block, re-checked against the file ON DISK (render-a), so a
# future edit cannot restore the leak without tripping BOTH suites. NO gateway-absence assertion:
# moby assigns 172.30.40.1 regardless (ruling §4/§5) — asserting its absence would be invalid.
FCY="$WORK/render-a/firecrawl/compose/firecrawl.yml"
NIT=$(sed -n '/^networks:/,/^services:/p' "$FCY" | grep -c '^    internal: true' || true)
NOFALSE=$(sed -n '/^networks:/,/^services:/p' "$FCY" | grep -c 'internal: false' || true)
HDR_NEW=$(grep -c '# fc-iso is the internal browser segment' "$FCY" || true)
HDR_OLD=$(grep -c 'gateway-less' "$FCY" || true)
if [ "$NIT" = 3 ] && [ "$NOFALSE" = 0 ] && [ "$HDR_NEW" = 1 ] && [ "$HDR_OLD" = 0 ]; then
  echo "  PASS 10a networks block renders exactly 3 internal:true (fc-ctl/fc-data/fc-iso), zero internal:false; header comment carries the r75-fix6 wording, disproven premise gone"; pass=$((pass+1))
else
  echo "  FAIL 10a (internalTrue=$NIT want 3, internalFalse=$NOFALSE want 0, newHeader=$HDR_NEW want 1, oldWording=$HDR_OLD want 0)"; fail=$((fail+1))
fi
export R85_FCY="$FCY"
cat > "$WORK/r85f6b-demo.ts" <<'TS'
// Parsed-structure half of PROOF 10 over the rendered artefact on disk: five ruling §5 facts.
import { readFileSync } from "node:fs";
const text = readFileSync(process.env.R85_FCY!, "utf8");
const lines = text.split("\n");
const start = lines.indexOf("networks:");
const rest = lines.slice(start + 1);
const end = rest.findIndex((l) => /^[a-z]/.test(l));
const nets = Bun.YAML.parse(rest.slice(0, end === -1 ? rest.length : end).join("\n"));
const doc = Bun.YAML.parse(text);
let bad = 0;
const say = (ok: boolean, line: string) => { console.log((ok ? "OK   " : "BAD  ") + line); if (!ok) bad++; };
say(Object.keys(nets).sort().join(",") === "fc-ctl,fc-data,fc-edge,fc-iso,fc-web", "10b networks block parses standalone (5 tiers)");
say(nets["fc-iso"].internal === true && nets["fc-ctl"].internal === true && nets["fc-data"].internal === true, "10b fc-iso/fc-ctl/fc-data internal=true");
say(nets["fc-web"].internal === undefined && nets["fc-edge"].internal === undefined, "10b fc-web/fc-edge stay non-internal");
const pw = doc.services["playwright-service"].networks;
say(JSON.stringify(pw) === JSON.stringify(["fc-ctl", "fc-iso"]) && pw.every((n: string) => doc.networks[n].internal === true), "10b playwright-service: only internal attachments (no default route)");
const fcWeb = Object.entries(doc.services).filter(([, s]: [string, any]) => Array.isArray(s.networks) && s.networks.includes("fc-web")).map(([n]) => n);
const ports = Object.entries(doc.services).filter(([, s]: [string, any]) => s.ports !== undefined).map(([n]) => n);
say(JSON.stringify(fcWeb) === JSON.stringify(["egress-proxy"]) && JSON.stringify(ports) === JSON.stringify(["auth-proxy"]), "10b fc-web member = egress-proxy only; ports carrier = auth-proxy only");
console.log(bad === 0 ? "RESULT OK" : `RESULT FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
TS
bun run "$WORK/r85f6b-demo.ts" | tee "$WORK/r85f6b.out"
check "R112b-4 parsed topology proofs (block parses; internal flags; playwright containment; single fc-web member + single ports carrier)" 0 $?

echo
echo "row-85 proofs: $pass passed, $fail failed"
[ "$fail" = 0 ] || exit 1
