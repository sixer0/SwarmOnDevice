// Row-106 lock generator — the V-1 structural fix (r80c FIX-C note 2, s97b/r80c ruling):
// packages/setup/tools.lock.json is GENERATED from the authoritative
// docs/<task>/masterplan/01c1_tools_lock.json at build time, never hand-edited, so the
// two-file drift (§6.9 of verification/04_residual_scan.md) cannot recur.
//
//   cd packages/setup && bun run script/gen-lock.ts    # regenerate the local copy
//
// Deterministic: no clock, no network, no ports, no spawns. Writes exactly ONE file —
// packages/setup/tools.lock.json (repo tree, mode 0644; the ARCHIVE mode is row 48's
// packager decision at script/swarm/package-cli.ts:82 = 0o644, so the tracked copy must
// not be chmod-ed here). The copy is validated through the SHIPPED loader validator
// (src/lockfile.ts validateLock) before success is reported, and both sha256 hashes are
// printed for the build report (hash record = stdout lines consumed by row 106's build).
//
// Fail-closed: a missing/unreadable/unparsable/invalid source, or any byte that differs
// after the write, exits 1 with a LOCK_GEN_FAIL line.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { validateLock } from "../src/lockfile.ts"

const PKG_DIR = join(import.meta.dir, "..") // .../packages/setup
const REPO_DIR = join(PKG_DIR, "..", "..") // .../swarm
const LOCK_BASENAME = "01c1_tools_lock.json"
const DEST = join(PKG_DIR, "tools.lock.json")

/** Resolve the authoritative masterplan lock: explicit env override wins; otherwise scan
 *  docs/ for task folders (same workspace layout as this checkout's docs root) and take the
 *  newest date-prefixed folder that actually carries the file. */
function resolveSource(): string | null {
  const override = process.env.SWARM_TOOLS_LOCK_SOURCE ?? process.env.SWARM_DOCS_ROOT
  if (override && override.trim() !== "") {
    const dir = override.endsWith(LOCK_BASENAME) ? override : join(override, "masterplan", LOCK_BASENAME)
    return existsSync(dir) ? dir : null
  }
  const docsRoot = join(REPO_DIR, "..", "docs")
  if (!existsSync(docsRoot)) return null
  const candidates = readdirSync(docsRoot)
    .filter((name) => /^\d{4}-\d{2}-\d{2}_/.test(name))
    .sort()
    .reverse()
  for (const name of candidates) {
    const p = join(docsRoot, name, "masterplan", LOCK_BASENAME)
    if (existsSync(p)) return p
  }
  return null
}

function sha256Hex(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function parseSource(raw: Uint8Array): { ok: true; parsed: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, parsed: JSON.parse(raw.toString("utf8")) }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

const source = resolveSource()
if (source === null) {
  console.error(
    `LOCK_GEN_FAIL: authoritative ${LOCK_BASENAME} not found (looked in ../docs/<task>/masterplan; set SWARM_TOOLS_LOCK_SOURCE or SWARM_DOCS_ROOT to override)`,
  )
  process.exit(1)
}

const raw = readFileSync(source) // unreadable source throws -> non-zero exit by crash, never a silent pass
const parsedRes = parseSource(raw)
if (!parsedRes.ok) {
  console.error(`LOCK_GEN_FAIL: source is not valid JSON: ${parsedRes.error}`)
  process.exit(1)
}

const validated = validateLock(parsedRes.parsed)
if (!validated.ok) {
  console.error(`LOCK_GEN_FAIL: source fails the shipped validator: ${validated.error}`)
  process.exit(1)
}

writeFileSync(DEST, raw, { mode: 0o644 })

// Byte-equality is asserted AFTER the write (a pre-existing read-only dest could make
// writeFileSync silently no-op on some filesystems; the re-read catches that).
const written = readFileSync(DEST)
const srcHash = sha256Hex(raw)
const dstHash = sha256Hex(written)
if (srcHash !== dstHash) {
  console.error(`LOCK_GEN_FAIL: copy drifted during write: src=${srcHash} dst=${dstHash}`)
  process.exit(1)
}

console.log(`LOCK_GEN_SOURCE ${source}`)
console.log(`LOCK_GEN_DEST ${DEST}`)
console.log(`LOCK_GEN_SHA256_SOURCE ${srcHash}`)
console.log(`LOCK_GEN_SHA256_DEST ${dstHash}`)
console.log(`LOCK_GEN_VERSION ${validated.lock.version}`)
console.log("LOCK_GEN_OK byte-identical + shipped-validator-green")
