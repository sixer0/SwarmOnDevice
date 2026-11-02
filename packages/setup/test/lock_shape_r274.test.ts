// Row 274 - shape and self-consistency guard for the reviewed tools lock.
//
// Why this exists: the runtime step compares `brew list --versions` to the lock pin exactly
// (src/steps/runtime/index.ts ensureFormulas), so the lock is refreshed whenever Homebrew moves.
// Nothing guarded the refresh itself: a hand edit could change a version without its url, drop an
// OS bottle tag (which silently moves the preflight OS floor, src/steps/runtime/preflight.ts
// reviewedCodenames), or let the repo copy drift from the authoritative masterplan source that
// script/gen-lock.ts copies. These checks read the lock and assert relations between its own
// fields; they hold no pin literal, so the next refresh does not need a test edit. Every check is
// also run against a deliberately broken copy, so a check that can never fail is caught here.
//
// Pure: reads files only, no network, no ports, no spawns, no HOME access.

import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { validateLock } from "../src/lockfile.ts"
import { bottleFloor } from "../src/steps/runtime/preflight.ts"

const PKG_DIR = join(import.meta.dir, "..")
const LOCK_PATH = join(PKG_DIR, "tools.lock.json")
const LOCK_BYTES = readFileSync(LOCK_PATH)
const LOCK_JSON = JSON.parse(LOCK_BYTES.toString("utf8")) as Record<string, unknown>

const VERSION_RE = /^swarm-tools-\d+\.\d+\.\d+-r\d+$/
const SHA256_RE = /^[0-9a-f]{64}$/
// Artifacts whose bottles the setup lets Homebrew pour; colima carries one extra older tag (sonoma).
const BOTTLE_FIELDS = ["colima", "lima", "docker_cli", "docker_compose", "qemu"] as const
// Artifacts that also pin a GitHub release asset whose url embeds the version.
const URL_FIELDS = ["colima", "lima", "docker_compose"] as const
// Homebrew-only artifacts whose top-level sha256 is, by the lock's convention, the golden_gate bottle.
const BOTTLE_SHA_FIELDS = ["docker_cli", "qemu"] as const

type Obj = Record<string, unknown>

function runtimeOf(lock: Obj): Obj {
  const comps = (lock.components ?? {}) as Obj
  return (comps.runtime ?? {}) as Obj
}

function bottleMap(entry: Obj): Record<string, string> {
  return ((entry.brew_bottles ?? entry.bottle_sha256 ?? {}) as Record<string, string>) ?? {}
}

/** Every relation the lock must satisfy; returns human-readable findings (empty = consistent). */
function lockShapeFindings(lock: Obj): string[] {
  const out: string[] = []
  const v = lock.version
  if (typeof v !== "string" || !VERSION_RE.test(v)) out.push(`version ${JSON.stringify(v)} is not swarm-tools-X.Y.Z-rN`)
  const lbl = ((lock._labels ?? {}) as Obj)["PC-LBL-03"]
  if (typeof lbl !== "string" || typeof v !== "string" || !lbl.includes(v))
    out.push("_labels.PC-LBL-03 does not name the current version")

  const rt = runtimeOf(lock)
  const tagSets: Record<string, string[]> = {}
  for (const f of BOTTLE_FIELDS) {
    const e = (rt[f] ?? {}) as Obj
    if (typeof e.version !== "string" || e.version.trim() === "") out.push(`${f}: missing version`)
    const map = bottleMap(e)
    tagSets[f] = Object.keys(map).sort()
    if (tagSets[f].length === 0) out.push(`${f}: no bottle map`)
    for (const [tag, sha] of Object.entries(map)) {
      if (!tag.startsWith("arm64_")) out.push(`${f}: bottle tag ${tag} is not arm64_*`)
      if (typeof sha !== "string" || !SHA256_RE.test(sha)) out.push(`${f}.${tag}: not a lowercase sha256`)
    }
    if (!("arm64_golden_gate" in map)) out.push(`${f}: no arm64_golden_gate bottle`)
  }
  // Same tag set for every artifact except colima, which may carry extra (older) tags but none fewer.
  const ref = JSON.stringify(tagSets.lima)
  for (const f of ["docker_cli", "docker_compose", "qemu"] as const)
    if (JSON.stringify(tagSets[f]) !== ref) out.push(`${f}: bottle tags ${tagSets[f]} differ from lima ${ref}`)
  for (const t of tagSets.lima ?? []) if (!tagSets.colima?.includes(t)) out.push(`colima: missing bottle tag ${t}`)

  for (const f of URL_FIELDS) {
    const e = (rt[f] ?? {}) as Obj
    const ver = typeof e.version === "string" ? e.version : ""
    if (typeof e.url !== "string" || !e.url.includes(`/${ver}/`)) out.push(`${f}: url does not embed /${ver}/`)
    if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256)) out.push(`${f}: release sha256 malformed`)
    if (typeof e.size !== "number" || !Number.isInteger(e.size) || e.size <= 0) out.push(`${f}: size not a positive integer`)
  }
  for (const f of BOTTLE_SHA_FIELDS) {
    const e = (rt[f] ?? {}) as Obj
    if (e.sha256 !== bottleMap(e).arm64_golden_gate) out.push(`${f}: sha256 is not the arm64_golden_gate bottle`)
  }
  return out
}

function clone(): Obj {
  return JSON.parse(LOCK_BYTES.toString("utf8")) as Obj
}

/** Same resolution rule as script/gen-lock.ts resolveSource() without the env override. */
function masterplanSource(): string | null {
  const docsRoot = join(PKG_DIR, "..", "..", "..", "docs")
  if (!existsSync(docsRoot)) return null
  const names = readdirSync(docsRoot)
    .filter((n) => /^\d{4}-\d{2}-\d{2}_/.test(n))
    .sort()
    .reverse()
  for (const n of names) {
    const p = join(docsRoot, n, "masterplan", "01c1_tools_lock.json")
    if (existsSync(p)) return p
  }
  return null
}

describe("r274 lock shape: the shipped tools.lock.json is self-consistent", () => {
  test("r274 passes the shipped validator", () => {
    const r = validateLock(LOCK_JSON)
    expect(r.ok).toBe(true)
  })

  test("r274 no shape findings on the shipped lock", () => {
    expect(lockShapeFindings(LOCK_JSON)).toEqual([])
  })

  test("r274 preflight OS floor still resolves (a dropped bottle tag would move it)", () => {
    const r = validateLock(LOCK_JSON)
    if (!r.ok) throw new Error(r.error)
    const floor = bottleFloor(r.lock)
    expect(floor).not.toBeNull()
    expect(floor?.lockVersion).toBe(r.lock.version)
  })

  const src = masterplanSource()
  test.skipIf(src === null)("r274 repo copy is byte-identical to the authoritative masterplan lock (gen-lock contract)", () => {
    expect(readFileSync(src as string).equals(LOCK_BYTES)).toBe(true)
  })
})

describe("r274 lock shape: every check can fail (mutated copies)", () => {
  const cases: [string, (l: Obj) => void, string][] = [
    ["version format", (l) => (l.version = "swarm-tools-1.19.3"), "is not swarm-tools-X.Y.Z-rN"],
    ["label drift", (l) => (l.version = "swarm-tools-1.19.3-r99"), "PC-LBL-03 does not name"],
    ["compose url/version desync", (l) => ((runtimeOf(l).docker_compose as Obj).version = "v0.0.1"), "docker_compose: url does not embed"],
    ["docker sha256 not the golden_gate bottle", (l) => ((runtimeOf(l).docker_cli as Obj).sha256 = "0".repeat(64)), "docker_cli: sha256 is not"],
    [
      "dropped OS tag on one artifact",
      (l) => delete ((runtimeOf(l).docker_compose as Obj).brew_bottles as Obj).arm64_sequoia,
      "docker_compose: bottle tags",
    ],
    [
      "malformed bottle hash",
      (l) => (((runtimeOf(l).docker_cli as Obj).bottle_sha256 as Obj).arm64_tahoe = "ABC"),
      "docker_cli.arm64_tahoe: not a lowercase sha256",
    ],
    ["empty version", (l) => ((runtimeOf(l).docker_cli as Obj).version = ""), "docker_cli: missing version"],
    ["bad size", (l) => ((runtimeOf(l).docker_compose as Obj).size = null), "docker_compose: size not a positive integer"],
  ]
  for (const [name, mutate, expectText] of cases) {
    test(`r274 refuses: ${name}`, () => {
      const l = clone()
      mutate(l)
      const findings = lockShapeFindings(l)
      expect(findings.some((f) => f.includes(expectText))).toBe(true)
    })
  }
})
