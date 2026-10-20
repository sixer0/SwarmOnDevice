#!/usr/bin/env bash
# Row-97 FIX round b proofs — the setup config writer (src/wiring/config_writer.ts).
# Writes ONLY into a throwaway HOME base (explicit `base`, never process.env.HOME), spawns nothing,
# binds no socket, makes no network request. Proves: health gating, the two register MCP entries,
# hash+timestamp backups on BOTH paths, atomic replace, idempotence, reversible removal, symlinked-
# target refusal, unrelated-key preservation, and the blueprint byte-manifest guarantee. Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"            # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                    # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"         # project-local bun ONLY
export PATH="$TOOLS_BIN:$PATH"

_TMPBASE="${TMPDIR:-/tmp}"; _TMPBASE="${_TMPBASE%/}"
WORK="$(mktemp -d "$_TMPBASE/swarm-setup-r97b-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK"

pass=0; fail=0
check () { if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1)); else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi; }

echo "=== PROOF 0: runtime identity ==="
echo "  bun: $(bun --version 2>/dev/null || echo MISSING)"

echo "=== PROOF 1: typecheck (scoped row-97b subtree + full package) ==="
cat > "$WORK/tsconfig.r97b.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022", "lib": ["ES2022"], "module": "ESNext", "moduleResolution": "bundler",
    "types": [], "strict": true, "noUncheckedIndexedAccess": true, "noEmit": true,
    "skipLibCheck": true, "verbatimModuleSyntax": false, "allowImportingTsExtensions": true,
    "resolveJsonModule": true, "esModuleInterop": true, "forceConsistentCasingInFileNames": true
  },
  "include": [
    "$HERE/types/**/*.d.ts",
    "$HERE/src/*.ts", "$HERE/src/stacklib.ts", "$HERE/src/composefiles/*.ts",
    "$HERE/src/steps/node/index.ts", "$HERE/src/steps/graft/index.ts", "$HERE/src/steps/rtk/index.ts",
    "$HERE/src/mcpproxy/*.ts", "$HERE/src/mcpproxy/researcher.json",
    "$HERE/src/vault/*.ts", "$HERE/src/wiring/*.ts"
  ]
}
JSON
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p "$WORK/tsconfig.r97b.json" ) > "$WORK/tsc-scoped.log" 2>&1
check "tsc --noEmit (scoped)" 0 $?
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json ) > "$WORK/tsc-full.log" 2>&1
check "tsc --noEmit (full package)" 0 $?
[ -s "$WORK/tsc-scoped.log" ] && sed 's/^/    /' "$WORK/tsc-scoped.log" | head -20
[ -s "$WORK/tsc-full.log" ] && sed 's/^/    /' "$WORK/tsc-full.log" | head -20

echo "=== PROOF 2: unit suite ==="
( cd "$HERE" && bun test test/config_writer.test.ts ) > "$WORK/u.log" 2>&1; check "config_writer.test.ts (health/backup/idempotence/reversal/symlink/manifest)" 0 $?
tail -4 "$WORK/u.log" | sed 's/^/    /'

echo "=== PROOF 3: end-to-end matrix against a throwaway HOME base ==="
cat > "$WORK/driver.ts" <<TS
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { defaultState } from "$HERE/src/state.ts";
import { STATES } from "$HERE/src/constants.ts";
import { writeConfigEntries, removeConfigEntries, configFilePath } from "$HERE/src/wiring/config_writer.ts";

const B = process.env.R97_BASE as string;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const launch = () => ({ ok: true as const, nodePath: "/h/.swarm/tools/node/v24/bin/node", cliPath: "/h/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js" });
const st = (ids: string[]) => { const s = defaultState("t"); for (const id of ids) (s.components as any)[id].state = STATES.HEALTHY; return s; };
const O = (b: string, state: any, estate?: any) => ({ base: b, chain: { path: join(b, ".swarm", "setup", "audit.jsonl") }, launch, env: {}, now: () => "2026-10-20T09:00:00.000Z", state, ...(estate ? { estate } : {}) });

// (a) health fails -> no file
let b = join(B, "a"); mkdirSync(b, { recursive: true });
let r = writeConfigEntries(O(b, st([])));
console.log("HEALTHFAIL=" + (r.ok && !r.changed && !r.wrote.graft && !r.wrote.swarmWeb ? "ok" : "bad"));

// (b) graft healthy -> graft entry only
b = join(B, "b"); mkdirSync(b, { recursive: true });
r = writeConfigEntries(O(b, st(["graft"])));
const cfgB = JSON.parse(readFileSync(configFilePath({ base: b }), "utf8"));
console.log("GRAFT_ONLY=" + (r.ok && r.wrote.graft && !r.wrote.swarmWeb && cfgB.mcp.graft.command[2] === "mcp" && cfgB.mcp.graft.env.DO_NOT_TRACK === "1" ? "ok" : "bad"));

// (c) searxng healthy + binary staged -> swarm-web entry, NO token
b = join(B, "c"); mkdirSync(join(b, ".swarm", "setup", "bin"), { recursive: true });
writeFileSync(join(b, ".swarm", "setup", "bin", "swarm-web-proxy"), "#!/bin/sh");
r = writeConfigEntries(O(b, st(["searxng"]), { searxngUrl: "http://127.0.0.1:9021" }));
const sw = JSON.parse(readFileSync(configFilePath({ base: b }), "utf8")).mcp["swarm-web"];
console.log("SWARMWEB=" + (r.ok && sw.timeout === 30000 && sw.env.SWARM_SEARXNG_URL === "http://127.0.0.1:9021" && sw.env.SWARM_FIRECRAWL_TOKEN === undefined ? "ok" : "bad"));

// (d) backup-on-modify + idempotence
b = join(B, "d"); mkdirSync(join(b, ".config", "swarm"), { recursive: true });
const orig = '{"theme":"swarm"}\n'; writeFileSync(configFilePath({ base: b }), orig);
r = writeConfigEntries(O(b, st(["graft"])));
const bakOk = r.ok && r.backupPath !== null && readFileSync(r.backupPath, "utf8") === orig;
const bytesAfter = readFileSync(configFilePath({ base: b }), "utf8");
const r2 = writeConfigEntries(O(b, st(["graft"])));
console.log("BACKUP_MODIFY=" + (bakOk ? "ok" : "bad"));
console.log("IDEMPOTENT=" + (r2.ok && !r2.changed && readFileSync(configFilePath({ base: b }), "utf8") === bytesAfter ? "ok" : "bad"));

// (e) reversal restores original
const rem = removeConfigEntries(O(b, st(["graft"])));
console.log("RESTORE=" + (rem.ok && rem.action === "restored" && readFileSync(configFilePath({ base: b }), "utf8") === orig ? "ok" : "bad"));

// (f) reversal deletes created-from-nothing
b = join(B, "f"); mkdirSync(b, { recursive: true });
writeConfigEntries(O(b, st(["graft"])));
const remF = removeConfigEntries(O(b, st(["graft"])));
let fExists = true; try { statSync(configFilePath({ base: b })); } catch { fExists = false; }
console.log("DELETE_CREATED=" + (remF.ok && remF.action === "deleted" && !fExists ? "ok" : "bad"));

// (g) symlink refusal (write)
b = join(B, "g"); mkdirSync(join(b, ".config", "swarm"), { recursive: true });
writeFileSync(join(b, "v.txt"), "keep"); symlinkSync(join(b, "v.txt"), configFilePath({ base: b }));
const rg = writeConfigEntries(O(b, st(["graft"])));
console.log("SYMLINK_REFUSE=" + (!rg.ok && readFileSync(join(b, "v.txt"), "utf8") === "keep" ? "ok" : "bad"));

// (h) byte manifest of foreign config trees identical before/after
b = join(B, "h"); mkdirSync(join(b, ".swarm", "setup", "bin"), { recursive: true });
writeFileSync(join(b, ".swarm", "setup", "bin", "swarm-web-proxy"), "#!/bin/sh");
const watch: Record<string,string> = {};
for (const [rel, body] of Object.entries({ ".claude/settings.json":"{}", ".codex/config.toml":"x", ".config/opencode/opencode.json":"{}", ".zshrc":"p" })) {
  const p = join(b, rel); mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true }); writeFileSync(p, body); watch[p] = sha(body);
}
writeConfigEntries(O(b, st(["graft","searxng"]), { searxngUrl: "http://127.0.0.1:9021" }));
let manifestOk = true; for (const [p,d] of Object.entries(watch)) if (sha(readFileSync(p,"utf8")) !== d) manifestOk = false;
console.log("MANIFEST_IDENTICAL=" + (manifestOk ? "ok" : "bad"));
TS
R97_BASE="$WORK/home" bun run "$WORK/driver.ts" > "$WORK/driver.out" 2>"$WORK/driver.err"
rc=$?
check "driver runs clean (exit 0)" 0 $rc
for tok in HEALTHFAIL GRAFT_ONLY SWARMWEB BACKUP_MODIFY IDEMPOTENT RESTORE DELETE_CREATED SYMLINK_REFUSE MANIFEST_IDENTICAL; do
  grep -q "${tok}=ok" "$WORK/driver.out" && check "$tok" 0 0 || check "$tok" 0 1
done
sed 's/^/    /' "$WORK/driver.out"
[ -s "$WORK/driver.err" ] && sed 's/^/    ERR /' "$WORK/driver.err" | head -10

echo "=== PROOF 4: negative-surface grep gates ==="
rg -n 'node:child_process|Bun\.spawn|\.exec\(|execSync|spawnSync' "$HERE/src/wiring/config_writer.ts" > /dev/null 2>&1
check "no process-execution primitive in config_writer" 1 $?
rg -n '\b(90[0-9][0-9]|8888|3002|8080|27124)\b' "$HERE/src/wiring/config_writer.ts" > /dev/null 2>&1
check "zero port literals in config_writer (PORT RULE)" 1 $?
rg -n 'FIRECRAWL_TOKEN' "$HERE/src/wiring/config_writer.ts" > /dev/null 2>&1
check "the bearer-token env NAME never appears in config_writer (P-8: secret never written)" 1 $?

echo "=== PROOF 5: --check CI gate (render-vs-written byte compare; fails loudly on drift) ==="
CHK="$WORK/checkhome"; rm -rf "$CHK"; mkdir -p "$CHK/.swarm/setup/bin"
printf '#!/bin/sh\n' > "$CHK/.swarm/setup/bin/swarm-web-proxy"
cat > "$WORK/install.ts" <<TS
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeConfigEntries } from "$HERE/src/wiring/config_writer.ts";
const B = process.env.R97_CHK as string;
// persist an all-healthy state.json under the base so the gate resolves eligibility from the base alone
mkdirSync(join(B, ".swarm", "setup"), { recursive: true });
const comps: Record<string, { state: string }> = {};
for (const id of ["runtime","node","graft","rtk","obsidian","searxng","firecrawl"]) comps[id] = { state: "absent" };
for (const id of ["graft","searxng","rtk","obsidian"]) comps[id] = { state: "healthy" };
writeFileSync(join(B, ".swarm", "setup", "state.json"), JSON.stringify({ version: 1, lockVersion: "t", updatedAt: "2026-10-20T09:30:00.000Z", components: comps }));
const r = writeConfigEntries({ base: B, chain: { path: join(B, ".swarm", "setup", "audit.jsonl") }, launch: () => ({ ok: true as const, nodePath: "/n", cliPath: "/c" }), env: {}, now: () => "2026-10-20T09:30:00.000Z" });
console.log("INSTALL=" + (r.ok && r.wrote.skills.length === 5 ? "ok" : "bad"));
TS
R97_CHK="$CHK" bun run "$WORK/install.ts" > "$WORK/install.out" 2>&1
grep -q "INSTALL=ok" "$WORK/install.out" && check "all-healthy install wrote 5 texts" 0 0 || check "all-healthy install wrote 5 texts" 0 1
( cd "$HERE" && bun run src/wiring/config_check.ts --check --base "$CHK" ) > "$WORK/check.out" 2>&1
check "config_check --check exits 0 on a fresh install" 0 $?
# comparator bites: tamper one installed text -> --check must exit 1 and name it
printf 'tampered\n' >> "$CHK/.config/swarm/skills/graft/SKILL.md"
( cd "$HERE" && bun run src/wiring/config_check.ts --check --base "$CHK" ) > "$WORK/check2.out" 2>&1
rc2=$?
[ "$rc2" = "1" ] && check "config_check --check exits 1 on drift" 0 0 || check "config_check --check exits 1 on drift" 0 1
grep -q "skills/graft/SKILL.md" "$WORK/check2.out" && check "--check names the drifted file" 0 0 || check "--check names the drifted file" 0 1
sed 's/^/    /' "$WORK/check.out"; sed 's/^/    /' "$WORK/check2.out"

echo "=== SUMMARY ==="
echo "SUMMARY: $pass passed, $fail failed"
rm -rf "$WORK"
[ "$fail" = "0" ]
