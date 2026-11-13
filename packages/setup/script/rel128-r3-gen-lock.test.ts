// N8-320 (AC-R3, 1.2.8 row 29): gen-lock.ts must work from a checkout that has no sibling
// docs/ tree (e.g. a build copy under /opt) by falling back to the tracked
// packages/setup/tools.lock.json, while an explicit override and a present docs/ candidate
// still win and an invalid tracked lock still fails closed.
//
// Each case copies script/, src/ and tools.lock.json into a short mkdtemp root laid out as
// <root>/w/packages/setup, so the generator's docs root resolves to <root>/docs.

import { afterEach, describe, expect, test } from "bun:test"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PKG = join(import.meta.dir, "..")
const roots: string[] = []

function sha(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
}

function stage(): { root: string; pkg: string; lock: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "r3-")))
  roots.push(root)
  const pkg = join(root, "w", "packages", "setup")
  mkdirSync(pkg, { recursive: true })
  cpSync(join(PKG, "script", "gen-lock.ts"), join(pkg, "script", "gen-lock.ts"))
  cpSync(join(PKG, "src"), join(pkg, "src"), { recursive: true })
  cpSync(join(PKG, "tools.lock.json"), join(pkg, "tools.lock.json"))
  return { root, pkg, lock: join(pkg, "tools.lock.json") }
}

function run(pkg: string, env: Record<string, string> = {}) {
  const base: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k === "SWARM_TOOLS_LOCK_SOURCE" || k === "SWARM_DOCS_ROOT") continue
    base[k] = v
  }
  const res = Bun.spawnSync([process.execPath, "run", "script/gen-lock.ts"], {
    cwd: pkg,
    env: { ...base, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() }
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe("N8-320 gen-lock tracked-lock fallback", () => {
  test("no docs/ and no override: exits 0 from the tracked lock, byte-identical", () => {
    const { pkg, lock } = stage()
    const before = readFileSync(lock)
    const r = run(pkg)
    expect(r.err).not.toContain("LOCK_GEN_FAIL")
    expect(r.code).toBe(0)
    const after = readFileSync(lock)
    expect(sha(after)).toBe(sha(before))
    const srcLines = r.out.split("\n").filter((l) => l.startsWith("LOCK_GEN_SOURCE "))
    expect(srcLines).toEqual([`LOCK_GEN_SOURCE ${lock}`])
    expect(r.out).toContain(`LOCK_GEN_SHA256_SOURCE ${sha(before)}`)
    expect(r.out).toContain("LOCK_GEN_OK")
  })

  test("a present docs/ candidate still wins over the tracked lock", () => {
    const { root, pkg, lock } = stage()
    const cand = join(root, "docs", "2026-01-01_t", "masterplan", "01c1_tools_lock.json")
    mkdirSync(join(cand, ".."), { recursive: true })
    const parsed = JSON.parse(readFileSync(lock, "utf8"))
    const bytes = JSON.stringify(parsed, null, 1) + "\n" // valid, different bytes
    writeFileSync(cand, bytes)
    const r = run(pkg)
    expect(r.code).toBe(0)
    expect(r.out).toContain(`LOCK_GEN_SOURCE ${cand}`)
    expect(sha(readFileSync(lock))).toBe(sha(bytes))
  })

  test("an explicit override still wins, and a missing override still fails closed", () => {
    const { root, pkg, lock } = stage()
    const src = join(root, "01c1_tools_lock.json")
    const bytes = JSON.stringify(JSON.parse(readFileSync(lock, "utf8")), null, 3) + "\n"
    writeFileSync(src, bytes)
    const ok = run(pkg, { SWARM_TOOLS_LOCK_SOURCE: src })
    expect(ok.code).toBe(0)
    expect(ok.out).toContain(`LOCK_GEN_SOURCE ${src}`)
    expect(sha(readFileSync(lock))).toBe(sha(bytes))

    const missing = run(pkg, { SWARM_TOOLS_LOCK_SOURCE: join(root, "nope.json") })
    expect(missing.code).toBe(1)
    expect(missing.err).toContain("LOCK_GEN_FAIL")
  })

  test("an invalid tracked lock still exits 1 with LOCK_GEN_FAIL", () => {
    const { pkg, lock } = stage()
    writeFileSync(lock, JSON.stringify({ version: "x" }))
    const r = run(pkg)
    expect(r.code).toBe(1)
    expect(r.err).toContain("LOCK_GEN_FAIL")
  })
})
