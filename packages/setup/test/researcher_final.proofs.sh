#!/usr/bin/env bash
# Row-98 proof battery — researcher sub-agent FINAL assembly (single-source skills + prompt).
#
# What is proven here, in order:
#   1  typecheck (scoped row-98 subtree, then the full shared package)
#   2  unit suite green (the prose==facts byte-compare lives there)
#   3  generator determinism: --check passes AND writing nothing changes the goldens
#   4  the comparator BITES: a one-byte tamper of a golden copy is reported as drift
#   5  REAL ENGINE: the generated agent/researcher.md installed into a throwaway HOME resolves through
#      the shipped config loader; its prompt byte-equals the generated body; its ruleset keeps the
#      deny-all-first order; the RESOLVED block passes r94's validateResearcherDefinition with zero
#      violations; denied tools are hidden and the unconnected proxy tools are simply absent (§5.2)
#   6  REAL ENGINE: the four generated SKILL.md files are discovered by the shipped skill scanner, with
#      name/description/content byte-equal to the generated texts, and the built-in customize-swarm
#      skill still registers (no regression to the registry)
#   7  REAL ENGINE: `debug config` still carries row 96's baseline with the two MCP gates last, i.e.
#      shipping these files does not disturb the permission plane the researcher relies on
#   8  negative-surface greps (no spawn/exec, no network, no port literals, ASCII-only goldens)
#   9  brand scan over row-98 files with the keep-class filter driver_rules_e1 rule 4 requires
#   10 sandbox hygiene: throwaway HOME deleted, nothing written outside repo + $TMPDIR
#
# SANDBOX + COLLISION POLICY (decisions.md 08:44): binds NO port at all (nothing here listens; no pool
# probe needed - stated honestly), starts NO process this row does not own (only its own bun children),
# touches NO colima profile, writes ONLY inside packages/setup/** (source goldens) and a throwaway HOME
# under $TMPDIR. Disk precheck printed in PROOF 0. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                 # .../swarm
OC="$REPO/packages/opencode"
TOOLS_BIN="$REPO/../tools/node_modules/.bin"      # project-local bun ONLY (never global)
export PATH="$TOOLS_BIN:$PATH"

_TMPBASE="${TMPDIR:-/tmp}"; _TMPBASE="${_TMPBASE%/}"
WORK="$_TMPBASE/swarm-setup-r98-proofs"
rm -rf "$WORK"; mkdir -p "$WORK"

pass=0; fail=0
check () { if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi; }
ok ()   { echo "  PASS $1"; pass=$((pass+1)); }
bad ()  { echo "  FAIL $1 — $2"; fail=$((fail+1)); }

echo "=== PROOF 0: runtime identity + disk precheck (sandbox policy: >= 20 GiB free) ==="
echo "  bun: $(bun --version 2>/dev/null || echo MISSING)"
AVAIL_GIB=$(df -g "$REPO" | awk 'NR==2{print $4}')
if [ "${AVAIL_GIB:-0}" -ge 20 ]; then ok "disk free ${AVAIL_GIB} GiB >= 20 GiB"; else bad "disk precheck" "only ${AVAIL_GIB} GiB free"; fi

echo "=== PROOF 1: typecheck ==="
cat > "$WORK/tsconfig.r98.json" <<JSON
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
    "$HERE/src/steps/node/index.ts",
    "$HERE/src/steps/graft/index.ts",
    "$HERE/src/steps/rtk/index.ts",
    "$HERE/src/steps/obsidian/index.ts",
    "$HERE/src/mcpproxy/*.ts",
    "$HERE/src/mcpproxy/researcher.json",
    "$HERE/src/vault/*.ts",
    "$HERE/src/wiring/*.ts",
    "$HERE/src/skills/*.ts"
  ]
}
JSON
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.r98.json" ) > "$WORK/tsc-scoped.log" 2>&1
check "tsc --noEmit (scoped: skills + imported surface)" 0 $?
[ -s "$WORK/tsc-scoped.log" ] && sed 's/^/    /' "$WORK/tsc-scoped.log" | head -20
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json ) > "$WORK/tsc-full.log" 2>&1
check "tsc --noEmit (full packages/setup package)" 0 $?
[ -s "$WORK/tsc-full.log" ] && sed 's/^/    /' "$WORK/tsc-full.log" | head -20

echo "=== PROOF 2: unit suite (prose==facts byte-compare + content gates) ==="
( cd "$HERE" && bun test test/researcher_text.test.ts ) > "$WORK/units.log" 2>&1
UP=$(awk '/^ *[0-9]+ pass$/{print $1; exit}' "$WORK/units.log")
UF=$(awk '/^ *[0-9]+ fail$/{print $1; exit}' "$WORK/units.log")
if [ "${UP:-0}" -ge 29 ] && [ "${UF:-1}" -eq 0 ]; then ok "units ${UP} pass / 0 fail"; else bad "units" "${UP:-?} pass / ${UF:-?} fail (tail: $(tail -3 "$WORK/units.log" | tr '\n' ' '))"; fi

echo "=== PROOF 3: generator determinism (--check writes nothing, goldens stay byte-identical) ==="
SHA_BEFORE=$(cd "$HERE/src/skills/text" && find . -type f | sort | xargs shasum -a 256 | shasum -a 256 | awk '{print $1}')
( cd "$HERE" && bun run src/skills/gen_cli.ts --check ) > "$WORK/check.log" 2>&1
RC=$?
SHA_AFTER=$(cd "$HERE/src/skills/text" && find . -type f | sort | xargs shasum -a 256 | shasum -a 256 | awk '{print $1}')
if [ $RC -eq 0 ] && [ "$SHA_BEFORE" = "$SHA_AFTER" ]; then ok "--check exit 0 and goldens untouched (tree sha $SHA_BEFORE)"
else bad "--check" "rc=$RC sha $SHA_BEFORE -> $SHA_AFTER"; fi
# rendering twice in-process must be byte-identical (no clock, no host state)
DUP=$(cd "$HERE" && bun -e 'const {renderSkillTexts} = await import("./src/skills/researcher_text.ts"); const a=renderSkillTexts(), b=renderSkillTexts(); console.log(JSON.stringify(a)===JSON.stringify(b))' 2>&1)
if [ "$DUP" = "true" ]; then ok "renderSkillTexts() is deterministic across calls"; else bad "determinism" "$DUP"; fi

echo "=== PROOF 4: the byte-compare bites (tamper a COPY, never a shipped file) ==="
cp -R "$HERE/src/skills/text" "$WORK/tamper"
printf 'tampered\n' >> "$WORK/tamper/agent/researcher.md"
rm -f "$WORK/tamper/skills/rtk/SKILL.md"
TAMPER=$(cd "$HERE" && bun -e 'const {checkGoldens} = await import("./src/skills/gen_cli.ts"); const d = checkGoldens(process.argv[1]); console.log(d.length + "|" + d.join("; "))' "$WORK/tamper" 2>&1)
case "$TAMPER" in
  2\|*) ok "tampered copy reported 2 drifts (modified + missing): ${TAMPER#2|}" ;;
  *) bad "drift detection" "expected 2 drift lines, got: $TAMPER" ;;
esac
CLEAN=$(cd "$HERE" && bun -e 'const {checkGoldens} = await import("./src/skills/gen_cli.ts"); console.log(checkGoldens().length)' 2>&1)
if [ "$CLEAN" = "0" ]; then ok "real tree reports zero drift"; else bad "real tree clean" "reported $CLEAN drifts"; fi

# --- shared fixture for the real-engine legs: throwaway HOME with the generated texts installed ----
T="$WORK/home"; mkdir -p "$T/.config/swarm/agent" "$T/.config/swarm/skills/swarm-research" \
  "$T/.config/swarm/skills/graft" "$T/.config/swarm/skills/rtk" "$T/.config/swarm/skills/obsidian-inbox"
cp "$HERE/src/skills/text/agent/researcher.md"            "$T/.config/swarm/agent/researcher.md"
cp "$HERE/src/skills/text/skills/swarm-research/SKILL.md" "$T/.config/swarm/skills/swarm-research/SKILL.md"
cp "$HERE/src/skills/text/skills/graft/SKILL.md"          "$T/.config/swarm/skills/graft/SKILL.md"
cp "$HERE/src/skills/text/skills/rtk/SKILL.md"            "$T/.config/swarm/skills/rtk/SKILL.md"
cp "$HERE/src/skills/text/skills/obsidian-inbox/SKILL.md" "$T/.config/swarm/skills/obsidian-inbox/SKILL.md"
BASE_ENV=(HOME="$T" XDG_CONFIG_HOME="$T/.config" XDG_DATA_HOME="$T/.local/share" XDG_CACHE_HOME="$T/.cache" XDG_STATE_HOME="$T/.local/state" TMPDIR="$T/tmp")
mkdir -p "$T/tmp"
# Fake provider satisfies debug agent's defaultModel() requirement (agent.handler.ts:68-81) without any
# network: the api host is .invalid and is never contacted by these checks (same fixture r96 PROOF used).
FAKECFG='{"provider":{"fakeprov":{"name":"fakeprov","api":"https://example.invalid/v1","models":{"m1":{"name":"m1"}}}},"model":"fakeprov/m1"}'

echo "=== PROOF 5: REAL ENGINE — resolved researcher == generated facts ==="
( cd "$OC" && env "${BASE_ENV[@]}" OPENCODE_CONFIG_CONTENT="$FAKECFG" bun run ./src/index.ts debug agent researcher ) > "$WORK/res.json" 2>"$WORK/res.err"
RC=$?
if [ $RC -ne 0 ]; then bad "debug agent researcher" "exit $RC: $(head -c 300 "$WORK/res.err")"; else
  RES=$(cd "$HERE" && bun -e '
const {readFileSync} = await import("node:fs");
const {researcherAssemblyInputs} = await import("./src/wiring/handoff_98.ts");
const {renderSkillTexts} = await import("./src/skills/researcher_text.ts");
const {validateResearcherDefinition} = await import("./src/mcpproxy/wiring.ts");
const j = JSON.parse(readFileSync(process.argv[1], "utf8"));
const inputs = researcherAssemblyInputs();
const def = inputs.researcher.agent.researcher;
const generatedBody = renderSkillTexts().agentResearcherMd.split("\n---\n")[1].trim();
const f = [];
if (j.description !== def.description) f.push("description drifted from the shipped definition");
if (j.mode !== "subagent") f.push("mode is not subagent, got " + j.mode);
if (typeof j.prompt !== "string" || j.prompt !== generatedBody) f.push("resolved prompt != generated body (len " + String(j.prompt?.length) + " vs " + generatedBody.length + ")");
const p = j.permission ?? [];
const denyAll = p.findIndex((r) => r.permission === "*" && r.action === "deny");
const gSearch = p.findIndex((r) => r.permission === "swarm-web_search" && r.action === "allow");
const gFetch  = p.findIndex((r) => r.permission === "swarm-web_fetch"  && r.action === "allow");
const gVault  = p.findIndex((r) => r.permission === "swarm-web_vault_inbox" && r.action === "allow");
const tDeny = p.findIndex((r) => r.permission === "task" && r.action === "deny");
const wDeny = p.findIndex((r) => r.permission === "todowrite" && r.action === "deny");
if (denyAll < 0) f.push("no researcher deny-all");
for (const [name, idx] of [["search",gSearch],["fetch",gFetch],["vault",gVault],["task-deny",tDeny],["todowrite-deny",wDeny]]) if (!(idx > denyAll)) f.push(name + " not after deny-all");
// assertion G: the truncation-glob allow stays the FINAL rule even under deny-all
const last = p[p.length - 1];
if (!(last && last.permission === "external_directory" && last.action === "allow")) f.push("Truncate.GLOB allow is not the final rule");
// §5.2 posture: unconnected proxy tools are absent from the listing, and denied tools are hidden
for (const t of ["bash","edit","write","task","todowrite","webfetch"]) if (j.tools[t] !== false) f.push(t + " not hidden");
if ("swarm-web_search" in j.tools) f.push("unexpected live swarm-web tool without a server");
// rebuild the RESOLVED block and run r94 validator over it (T-W7-6 counterpart on THIS artifact)
const perm = {};
for (const r of p.slice(denyAll)) if (!(r.permission in perm)) perm[r.permission] = r.action;
const violations = validateResearcherDefinition({ agent: { researcher: { description: j.description, mode: j.mode, permission: perm } } });
if (violations.length) f.push("r94 validator on resolved researcher: " + violations.join("; "));
console.log(f.length ? "FAIL|" + f.join(" | ") : "OK|denyAll@" + denyAll + " grants@" + [gSearch,gFetch,gVault].join(",") + " promptBytes=" + generatedBody.length + " validator=0violations");
' "$WORK/res.json" 2>&1)
  case "$RES" in
    OK\|*) ok "resolved researcher matches generated facts (${RES#OK|})" ;;
    *) bad "resolved researcher" "$RES" ;;
  esac
fi

echo "=== PROOF 6: REAL ENGINE — generated skills discovered, byte-equal, registry intact ==="
( cd "$OC" && env "${BASE_ENV[@]}" bun run ./src/index.ts debug skill ) > "$WORK/skills.json" 2>"$WORK/skills.err"
RC=$?
if [ $RC -ne 0 ]; then bad "debug skill" "exit $RC: $(head -c 300 "$WORK/skills.err")"; else
  SK=$(cd "$HERE" && bun -e '
const {readFileSync} = await import("node:fs");
const {renderSkillTexts} = await import("./src/skills/researcher_text.ts");
const list = JSON.parse(readFileSync(process.argv[1], "utf8"));
const texts = renderSkillTexts();
const byName = Object.fromEntries(list.map((s) => [s.name, s]));
const want = {
  "swarm-research": texts.skillSwarmResearchMd,
  "graft": texts.skillGraftMd,
  "rtk": texts.skillRtkMd,
  "obsidian-inbox": texts.skillObsidianInboxMd,
};
const f = [];
const shapes = [];
for (const [name, md] of Object.entries(want)) {
  const s = byName[name];
  if (!s) { f.push(name + " not discovered by the real scanner"); continue; }
  const body = md.split("\n---\n")[1].trim();
  // Byte-equality of CONTENT, with the whitespace form named explicitly rather than absorbed: gray-matter
  // hands the skill loader the raw body (the skill scan keeps md.content untrimmed), so a single leading or
  // trailing newline is reported BY NAME and anything else is a real delta. The agent-prompt leg (PROOF 5)
  // compares UNtrimmed because the agent loader trims itself (config/agent.ts:27).
  const shape = s.content === body ? "exact"
    : s.content === "\n" + body ? "leading-newline-only"
    : s.content === body + "\n" ? "trailing-newline-only"
    : (s.content ?? "").trim() === body ? "whitespace-only-but-unexpected"
    : "REAL-DELTA";
  if (shape === "REAL-DELTA" || shape === "whitespace-only-but-unexpected") f.push(name + " content != generated body (" + shape + ", engine " + String(s.content?.length) + " vs generated " + body.length + ")");
  else shapes.push(name + ":" + shape);
  const fmDesc = JSON.parse(/^description: (.*)$/m.exec(md)[1]);
  if (s.description !== fmDesc) f.push(name + " description != frontmatter");
  if (!/\/.config\/swarm\/skills\//.test(s.location)) f.push(name + " loaded from an unexpected location: " + s.location);
}
if (!byName["customize-swarm"]) f.push("built-in customize-swarm skill disappeared");
console.log(f.length ? "FAIL|" + f.join(" | ") : "OK|content-shape=" + shapes.join(",") + " | registry=" + Object.keys(byName).length + " skills incl. built-in customize-swarm");
' "$WORK/skills.json" 2>&1)
  case "$SK" in
    OK\|*) ok "all four generated skills resolve through the shipped loader (${SK#OK|})" ;;
    *) bad "skill discovery" "$SK" ;;
  esac
fi

echo "=== PROOF 7: REAL ENGINE — row 96 baseline plane undisturbed by these files ==="
( cd "$OC" && env "${BASE_ENV[@]}" bun run ./src/index.ts debug config ) > "$WORK/cfg.json" 2>"$WORK/cfg.err"
RC=$?
if [ $RC -ne 0 ]; then bad "debug config" "exit $RC: $(head -c 200 "$WORK/cfg.err")"; else
  CFG=$(cd "$HERE" && bun -e '
const {readFileSync} = await import("node:fs");
const {mcpPermissionGates} = await import("./src/mcpproxy/wiring.ts");
const j = JSON.parse(readFileSync(process.argv[1], "utf8"));
const p = j.permission ?? {};
const keys = Object.keys(p);
const tail = keys.slice(-2).map((k) => [k, p[k]]);
const f = [];
if (JSON.stringify(tail) !== JSON.stringify(mcpPermissionGates().map((x) => [...x]))) f.push("baseline gate pair moved: " + JSON.stringify(tail));
if (p["*"] !== "ask") f.push("baseline catch-all ask lost");
if (p.webfetch !== "deny") f.push("baseline webfetch deny lost");
if (j.agent?.researcher?.mode !== "subagent") f.push("agent.researcher missing from resolved config");
if (j.experimental?.mcp_timeout !== 30000) f.push("experimental.mcp_timeout lost");
console.log(f.length ? "FAIL|" + f.join(" | ") : "OK|gates-last intact, researcher present");
' "$WORK/cfg.json" 2>&1)
  case "$CFG" in
    OK\|*) ok "permission plane unchanged (${CFG#OK|})" ;;
    *) bad "baseline plane" "$CFG" ;;
  esac
fi

echo "=== PROOF 8: negative-surface greps over row-98 sources and goldens ==="
g () { # g <label> <pattern> <path...>: PASS when NOTHING matches
  local label="$1" pat="$2"; shift 2
  local hits; hits=$(rg -n --pcre2 "$pat" "$@" 2>/dev/null | wc -l | tr -d ' ')
  if [ "$hits" = "0" ]; then ok "$label (0 matches)"; else bad "$label" "$hits matches"; rg -n --pcre2 "$pat" "$@" | head -3 | sed 's/^/    /'; fi
}
g "no exec/spawn primitive in src/skills" "child_process|Bun\.spawn|execSync|\bexec\(|spawnSync" "$HERE/src/skills"
g "no network in src/skills"              "\bfetch\(|https?:.*request|node:http|node:net|node:tls" "$HERE/src/skills"
g "no port literal in shipped row-98 files" "\b(3000|3002|5432|6379|8080|8888|9021|9022|27124|47[0-9]{3}|55[0-9]{3})\b" "$HERE/src/skills"
g "goldens are pure ASCII"                "[^\x00-\x7F]" "$HERE/src/skills/text"
g "no shell-metacharacter argv builder in the generator" "curl.*\|.*(sh|bash)|rm -rf" "$HERE/src/skills"

echo "=== PROOF 9: brand scan over row-98 files (keep-class = cited paths / specifiers / env names) ==="
# Keep-class: cited source paths (packages/opencode), @opencode-ai specifiers, OPENCODE_* env names, and
# the brand-scanner pattern LITERAL inside row-98's own test (/opencode/i is inert code, not a mention).
BRAND=$(rg -in opencode "$HERE/src/skills" "$HERE/types/skills-text.d.ts" "$HERE/test/researcher_text.test.ts" "$HERE/test/researcher_final.proofs.sh" 2>/dev/null | rg -v '@opencode-ai/|packages/opencode|OPENCODE_[A-Z_]+|opencode-test-|/opencode/i' | wc -l | tr -d ' ')
if [ "$BRAND" = "0" ]; then ok "zero non-keep brand mentions in row-98 files"; else bad "brand scan" "$BRAND non-keep matches"; rg -in opencode "$HERE/src/skills" "$HERE/test/researcher_text.test.ts" 2>/dev/null | rg -v '@opencode-ai/|packages/opencode|OPENCODE_[A-Z_]+|/opencode/i' | head -5 | sed 's/^/    /'; fi

echo "=== PROOF 10: sandbox hygiene — throwaway HOME destroyed, footprint confined ==="
rm -rf "$T"
if [ ! -e "$T" ]; then ok "throwaway HOME removed at teardown"; else bad "cleanup" "$T still exists"; fi
FOOTPRINT=$(cd "$REPO" && git status --porcelain -- packages/setup | rg -v '^\?\? packages/setup/$' | wc -l | tr -d ' ')
if [ "$FOOTPRINT" = "0" ]; then ok "git footprint is still only the untracked packages/setup tree (no tracked file touched)"; else bad "footprint" "$FOOTPRINT unexpected status lines"; fi

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = 0 ]
