#!/usr/bin/env bash
# Row 83 proofs for the swarm-setup consent UI + first-run gate.
# Targeted to packages/setup ONLY (row 102 runs the full suite concurrently elsewhere).
# Binds NO port; makes NO network request (the consent path is zero-network by construction:
# resolveArtifact pre-flights pins from the local lock only). Safe to re-run.
set -u

HERE="$(cd "$(dirname "$0")/.." && pwd)"          # .../packages/setup
REPO="$(cd "$HERE/../.." && pwd)"                  # .../swarm
TOOLS_BIN="$REPO/../tools/node_modules/.bin"       # local bun only (never global)
export PATH="$TOOLS_BIN:$PATH"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/swarm-setup-r83-proofs-XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin"
cp "$HERE/tools.lock.json" "$WORK/bin/tools.lock.json"
BIN="$WORK/bin/swarm-setup"

pass=0; fail=0
check () { # check <label> <expected-exit> <actual-exit>
  if [ "$2" = "$3" ]; then echo "  PASS $1 (exit $3)"; pass=$((pass+1));
  else echo "  FAIL $1 (expected $2 got $3)"; fail=$((fail+1)); fi
}
expect_grep () { # expect_grep <label> <pattern> <file>
  if grep -q "$2" "$3"; then echo "  PASS $1"; pass=$((pass+1));
  else echo "  FAIL $1 (pattern '$2' not in $3)"; fail=$((fail+1)); fi
}
expect_absent () { # expect_absent <label> <path>
  if [ ! -e "$2" ]; then echo "  PASS $1"; pass=$((pass+1));
  else echo "  FAIL $1 ($2 exists)"; fail=$((fail+1)); fi
}

echo "=== PROOF A: typecheck + compile (Mach-O still builds after row 83) ==="
( cd "$REPO" && node_modules/typescript/bin/tsc --noEmit -p packages/setup/tsconfig.json )
check "tsc --noEmit" 0 $?
bun build --compile --target=bun --outfile "$BIN" "$HERE/src/index.ts" >/dev/null 2>&1
check "bun build --compile" 0 $?
file "$BIN"
if file "$BIN" | grep -q "Mach-O.*arm64"; then echo "  PASS binary is Mach-O arm64"; pass=$((pass+1)); else echo "  FAIL not Mach-O arm64"; fail=$((fail+1)); fi

echo "=== PROOF B: unit/integration counts (bun test test/consent.test.ts) ==="
( cd "$HERE" && bun test test/consent.test.ts ) >"$WORK/unit.out" 2>&1; rc=$?
tail -4 "$WORK/unit.out"
check "bun test consent" 0 $rc

# Independent token value: first 12 hex of sha256 of the shipped lock (01d §6.1).
LOCK_SHA12=$(shasum -a 256 "$HERE/tools.lock.json" | cut -c1-12)
echo "  (independent lock_sha256_12 = $LOCK_SHA12)"

echo "=== PROOF C: scripted refusals leave NOTHING on disk, zero network ==="
export HOME="$WORK/home-refuse"; mkdir -p "$HOME"
# C1: non-interactive without any token -> REFUSED_NON_INTERACTIVE, exit 1
"$BIN" install --non-interactive >"$WORK/c1.out" 2>"$WORK/c1.err" </dev/null; rc=$?
check "C1 install --non-interactive (no tokens) exit 1" 1 $rc
expect_grep "C1 RESULT token" "RESULT REFUSED_NON_INTERACTIVE" "$WORK/c1.out"
# Nothing FILE is written by a refused run (row-81 lock-dir scaffolding may exist empty;
# the lock dir itself must be released). consent.log / state.json / provenance are the load-bearing absences.
NFILES=$(find "$HOME/.swarm" -type f 2>/dev/null | wc -l | tr -d ' ')
if [ "$NFILES" = "0" ]; then echo "  PASS C1 refused run wrote ZERO files under \$HOME/.swarm"; pass=$((pass+1)); else echo "  FAIL C1 ($NFILES files): $(find "$HOME/.swarm" -type f)"; fail=$((fail+1)); fi
expect_absent "C1 lock dir released after refusal" "$HOME/.swarm/setup/lock"
# C2: dry-run shows EXACTLY what would be asked, then refuses (row-81 PROOF 3 contract kept)
"$BIN" install --dry-run >"$WORK/c2.out" 2>"$WORK/c2.err" </dev/null; rc=$?
check "C2 install --dry-run exit 1 (never consents)" 1 $rc
expect_grep "C2 RESULT REFUSED_NO_CONSENT kept" "RESULT REFUSED_NO_CONSENT" "$WORK/c2.out"
expect_grep "C2 screen shows nine-field blocks (Egress statement label)" "Egress statement:" "$WORK/c2.out"
expect_grep "C2 screen shows decision-12 unticked posture" "unticked by default" "$WORK/c2.out"
expect_grep "C2 screen shows admin token for node under THIS lock" "node@${LOCK_SHA12}" "$WORK/c2.out"
expect_grep "C2 SearXNG disclosure EN" "Search text leaves this machine." "$WORK/c2.out"
expect_grep "C2 SearXNG disclosure ID sentence" "Teks pencarian yang Anda ketik" "$WORK/c2.out"
expect_grep "C2 Firecrawl disclosure ID sentence" "Permintaan crawl dan isi halaman" "$WORK/c2.out"
expect_grep "C2 Obsidian terms LINKED not auto-accepted" "LINKED, never auto-accepted" "$WORK/c2.out"
expect_grep "C2 third-party sentence (§6.3)" "PT GSP does not accept them for you" "$WORK/c2.out"
expect_absent "C2 dry-run wrote no consent.log" "$HOME/.swarm/setup/consent.log"
expect_absent "C2 dry-run wrote no state.json" "$HOME/.swarm/setup/state.json"
# C3: token MISMATCH -> REFUSED_NON_INTERACTIVE-style refusal, nothing written
"$BIN" install node --non-interactive --terms-token "node=node@000000000000" >"$WORK/c3.out" 2>"$WORK/c3.err" </dev/null; rc=$?
check "C3 mismatched token exit 1" 1 $rc
expect_grep "C3 RESULT REFUSED_NON_INTERACTIVE" "RESULT REFUSED_NON_INTERACTIVE" "$WORK/c3.out"
expect_absent "C3 no consent.log on mismatch" "$HOME/.swarm/setup/consent.log"

echo "=== PROOF D: grant path — consent durable BEFORE any fetch is permitted ==="
export HOME="$WORK/home-grant"; mkdir -p "$HOME"
"$BIN" install node --non-interactive --terms-token "node=node@${LOCK_SHA12}" >"$WORK/d.out" 2>"$WORK/d.err" </dev/null; rc=$?
# seam8-fix1 (controller authority over row 83's file; rationale in 90c_seam_pass_8.md FIX ROUND):
# the old expectation "granted run exits 1 (no step modules yet)" encoded exactly the placeholder
# state R113-1 was filed to delete (a run that records consent and installs nothing). A CONSENTED
# run now dispatches, so exit 1 became a fact about the defect, not about consent. Replaced by a
# check that is stronger in both worlds and deterministic on networked and offline hosts alike:
# whatever a granted run prints, its token must name real step execution having been attempted, and
# REFUSED_NO_CONSENT after a durably-recorded grant means the gate opened without consent — fatal.
# Consent-first itself is NOT relaxed anywhere in this file: C1/C2/C3 still prove zero writes and
# zero fetches BEFORE consent, and the two converted checks below still police everything the run
# touched afterwards.
if grep -qE '^step [a-z]+: ' "$WORK/d.out"; then echo "  PASS D1 granted run dispatched registered steps (RESULT $(grep -m1 '^RESULT ' "$WORK/d.out" | cut -d' ' -f2))"; pass=$((pass+1)); else echo "  FAIL D1 no 'step <id>:' execution line — run terminated without dispatch (the R113-1 placeholder state)"; fail=$((fail+1)); fi
if [ -f "$HOME/.swarm/setup/consent.log" ]; then echo "  PASS D1 consent.log written on grant (PC-PATH-03)"; pass=$((pass+1)); else echo "  FAIL D1 consent.log missing"; fail=$((fail+1)); fi
MODE=$(stat -f '%Lp' "$HOME/.swarm/setup/consent.log" 2>/dev/null || echo "?")
if [ "$MODE" = "600" ]; then echo "  PASS D1 consent.log mode 0600"; pass=$((pass+1)); else echo "  FAIL D1 mode $MODE != 600"; fail=$((fail+1)); fi
node -e '
const fs = require("fs");
const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse);
const l = lines[0];
const ok =
  lines.length === 1 &&
  l.component === "node" &&
  l.mode === "non-interactive" &&
  l.token === "node@" + process.argv[2] &&
  typeof l.time === "string" &&
  typeof l.user === "string" &&
  l.version === "v24.22.0" &&
  l.hash === "6a9724d9b50a5f22b4816cded441b5a8d9ddae546191a5e5b7efa5a5e2ee26d5" &&
  l.hash_scope === "artifact" &&
  ["time", "user", "component", "version", "hash"].every((k) => k in l);
if (ok) { console.log("  PASS D1 record holds time,user,component,version,hash (+ §6.5 fields, artifact scope)"); process.exit(0); }
console.log("  FAIL D1 record schema: " + JSON.stringify(l));
process.exit(1)' "$HOME/.swarm/setup/consent.log" "$LOCK_SHA12" && pass=$((pass+1)) || fail=$((fail+1))
# Converted from "provenance.jsonl absent" (true only while steps could not run) into a POSITIVE
# audit-ledger integrity check: every settled fetch must have written its line, no line may claim a
# fetch the state file does not corroborate, and every contacted URL must sit on THIS lock's own
# host allow-list. The old absence assertion is preserved where it still guards the real invariant:
# C1/C2/C3 keep demanding zero ledger/state files from any unconsented or refused run.
{
  if [ -f "$HOME/.swarm/setup/provenance.jsonl" ]; then
    node -e '
      const fs = require("fs");
      const lines = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter((x) => x !== "").map(JSON.parse);
      const hosts = new Set(JSON.parse(fs.readFileSync(process.argv[2], "utf8")).hosts);
      const bad = lines.filter((r) => typeof r.url !== "string" || !hosts.has(new URL(r.url).hostname));
      console.log(lines.length > 0 && bad.length === 0
        ? "  PASS D1 provenance.jsonl holds >=1 settled line, every url on the lock allow-list (P-18)"
        : "  FAIL D1 ledger breach: lines=" + lines.length + " off-list=" + JSON.stringify(bad.map((b) => b.url)));
      process.exit(lines.length > 0 && bad.length === 0 ? 0 : 1)
    ' "$HOME/.swarm/setup/provenance.jsonl" "$WORK/bin/tools.lock.json" && pass=$((pass+1)) || fail=$((fail+1))
  else
    echo "  FAIL D1 consented run settled ZERO fetches — provenance.jsonl missing means nothing was verified"; fail=$((fail+1))
  fi
}
# Converted from "no state.json (no component state advanced without steps)" — an absence that was
# only true while dispatch was the R113-1 placeholder. The replacement enforces the STATE TRUTH of
# the consented run in BOTH worlds (networked: the step may complete; offline: it must stop at its
# network-blocked state) and adds the invariant the old check could never express: a component may
# only read `healthy` when this very run printed RESULT OK — a fake green is now a hard red.
{
  node -e '
    const fs = require("fs");
    const home = process.argv[1];
    const resultLine = fs.readFileSync(process.argv[2], "utf8").split("\n").find((l) => l.startsWith("RESULT ")) || "RESULT <none>";
    const token = resultLine.split(" ")[1] || "";
    let st = null;
    try { st = JSON.parse(fs.readFileSync(home + "/.swarm/setup/state.json", "utf8")); } catch {}
    const entry = st && st.components && st.components.node;
    const s = entry ? entry.state : "<absent>";
    let ok;
    if (token === "OK") {
      ok = !!entry && s === "healthy" && entry.installedBySwarm === true && typeof entry.integrity === "string" && Array.isArray(entry.paths) && entry.paths.length > 0;
    } else {
      ok = !entry || (s !== "healthy" && s !== "verified" && s !== "installed" && s !== "configured");
    }
    console.log(ok ? "  PASS D1 state.json coherence: RESULT " + token + " <-> node=" + s + " (healthy requires an OK run; a fake green is a red)"
                  : "  FAIL D1 state incoherent: RESULT " + token + " but node=" + JSON.stringify(entry));
    process.exit(ok ? 0 : 1)
  ' "$HOME" "$WORK/d.out" && pass=$((pass+1)) || fail=$((fail+1))
}

echo "=== PROOF E: F-79-A policy hook (enforcement half; switch DEFERRED per decisions.md) ==="
export HOME="$WORK/home-policy"; mkdir -p "$HOME/.swarm/setup"
printf '%s\n' '{"forbidden": ["searxng"]}' > "$HOME/.swarm/setup/policy.json"
"$BIN" install searxng --non-interactive --terms-token "searxng=searxng@${LOCK_SHA12}" >"$WORK/e1.out" 2>"$WORK/e1.err" </dev/null; rc=$?
check "E1 forbidden component refuses EVEN WITH a valid token (exit 1)" 1 $rc
expect_grep "E1 refusal names the policy" "admin policy forbids" "$WORK/e1.err"
expect_absent "E1 forbidden acceptance NOT recorded" "$HOME/.swarm/setup/consent.log"
printf '%s\n' '{"forbidden": ["not-a-component"]}' > "$HOME/.swarm/setup/policy.json"
"$BIN" status >"$WORK/e2.out" 2>"$WORK/e2.err" </dev/null; rc=$?
check "E2 malformed policy fails CLOSED on install too (status unaffected: gate reads policy only on install)" 0 $rc
"$BIN" install node --non-interactive --terms-token "node=node@${LOCK_SHA12}" >"$WORK/e3.out" 2>"$WORK/e3.err" </dev/null; rc=$?
check "E3 install with malformed policy refuses (exit 1, fail-closed)" 1 $rc
expect_grep "E3 error names the policy path + register ids" "not a register component id" "$WORK/e3.err"

echo "=== PROOF F: security grep gates (row 83 surface) ==="
PAT='\.(listen|bind)\(|createServer|Bun\.serve|Deno\.listen|startTls|createConnection|net\.connect|http\.Server'
rg -n "$PAT" "$HERE/src" >/dev/null 2>&1; rc=$?
if [ "$rc" = 1 ]; then echo "  PASS F1: 0 bind/listen primitives in src/ (PORT RULE)"; pass=$((pass+1)); else echo "  FAIL F1 (rc $rc)"; fail=$((fail+1)); fi
# The three row-83 files must contain NO network call and NO exec primitive: fetch.ts stays the sole owner.
rg -n "fetch\(|child_process|spawnSync|execSync" "$HERE/src/consent.ts" "$HERE/src/consentText.ts" "$HERE/src/policy.ts" >/dev/null 2>&1; rc=$?
if [ "$rc" = 1 ]; then echo "  PASS F2: consent modules are network-free and exec-free (resolveArtifact only)"; pass=$((pass+1)); else echo "  FAIL F2 (rc $rc)"; fail=$((fail+1)); fi
# Terms are never auto-accepted: no vendor accept flag, no canned acceptance string anywhere.
rg -n -- "-accept-license|I_ACCEPT|--yes|--terms-all" "$HERE/src" >/dev/null 2>&1; rc=$?
if [ "$rc" = 1 ]; then echo "  PASS F3: no auto-accept channel exists (§6.2 rules 4-5, C-2)"; pass=$((pass+1)); else echo "  FAIL F3 (rc $rc): $(rg -n -- '-accept-license|I_ACCEPT|--yes|--terms-all' "$HERE/src" | head -3)"; fail=$((fail+1)); fi
# The declined terms-display verb (gate R-3) must appear NOWHERE in shipped sources.
rg -n -- "show-terms" "$HERE/src" >/dev/null 2>&1; rc=$?
if [ "$rc" = 1 ]; then echo "  PASS F4: --show-terms absent from the frozen verb/flag surface"; pass=$((pass+1)); else echo "  FAIL F4"; fail=$((fail+1)); fi

echo "=== SUMMARY: $pass passed, $fail failed ==="
[ "$fail" = 0 ]
