// Swarm 1.2.6 row 71 (T-17 retention, U5; register N-056 BACKUP_KEEP = 5, N-057 backupResidue).
// After each overwrite backup only the newest BACKUP_KEEP backups of THAT file stay in `<dir>/.bak/`; older ones of the
// same file are deleted (never another file's, never a link), and the guarded write result reports `backupRemoved`
// alongside `backupResidue`. Red at 7a59918e26 (row 70): no retention, BACKUP_KEEP undefined, backupRemoved undefined.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import * as safety from "../../vendor/scripts/studio/mcp/safety"

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function tmpRoot(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "row71-t17-")))
  tmpDirs.push(d)
  return d
}

const opts = (root: string, now: () => number) => ({ roots: [root], purpose: "write-report" as const, overwrite: true, nfs: safety.REAL_NODE_FS, now })

describe("T-17 retention: BACKUP_KEEP newest backups per file", () => {
  it("BACKUP_KEEP is 5", () => {
    expect(safety.BACKUP_KEEP).toBe(5)
  })

  it("7 overwrites (distinct stamps) leave the 5 newest backups, removed counted, other files untouched", () => {
    const root = tmpRoot()
    const a = path.join(root, "a.md")
    const b = path.join(root, "b.md")
    const ab = path.join(root, "a.md.md") // name that shares the prefix of a.md must not be pruned
    let t = Date.UTC(2026, 10, 12, 1, 0, 0)
    const o = opts(root, () => (t += 1000))
    safety.writeFileGuarded(b, Buffer.from("b0"), o)
    safety.writeFileGuarded(ab, Buffer.from("x0"), o)
    for (let i = 1; i <= 6; i++) safety.writeFileGuarded(b, Buffer.from(`b${i}`), o) // 6 backups of b -> 5 kept
    safety.writeFileGuarded(ab, Buffer.from("x1"), o)
    const bakDir = path.join(root, ".bak")
    const bBefore = fs.readdirSync(bakDir).filter((n) => n.startsWith("b.md.bak-")).sort()
    expect(bBefore).toHaveLength(5)

    safety.writeFileGuarded(a, Buffer.from("v0"), o)
    const results = []
    for (let i = 1; i <= 7; i++) results.push(safety.writeFileGuarded(a, Buffer.from(`v${i}`), o))
    expect(results.map((r) => r.backupResidue)).toEqual([1, 2, 3, 4, 5, 5, 5])
    expect(results.map((r) => r.backupRemoved)).toEqual([0, 0, 0, 0, 0, 1, 1])
    const aBaks = fs.readdirSync(bakDir).filter((n) => n.startsWith("a.md.bak-")).sort()
    expect(aBaks).toHaveLength(5)
    // newest five: contents v2..v6 (backup of v0 and v1 deleted)
    expect(aBaks.map((n) => fs.readFileSync(path.join(bakDir, n), "utf8"))).toEqual(["v2", "v3", "v4", "v5", "v6"])
    expect(fs.existsSync(results[6].backup as string)).toBe(true)
    expect(fs.readFileSync(a, "utf8")).toBe("v7")
    // other files' backups untouched
    expect(fs.readdirSync(bakDir).filter((n) => n.startsWith("b.md.bak-")).sort()).toEqual(bBefore)
    expect(fs.readdirSync(bakDir).filter((n) => n.startsWith("a.md.md.bak-"))).toHaveLength(1)
  })

  it("same-second stamps (-n suffix, numeric order incl. -10) keep the 5 newest", () => {
    const root = tmpRoot()
    const a = path.join(root, "a.md")
    const o = opts(root, () => Date.UTC(2026, 10, 12, 2, 0, 0))
    let removed = 0
    let last = safety.writeFileGuarded(a, Buffer.from("v0"), o)
    for (let i = 1; i <= 11; i++) {
      last = safety.writeFileGuarded(a, Buffer.from(`v${i}`), o)
      removed += last.backupRemoved
    }
    expect(removed).toBe(6)
    expect(last.backupResidue).toBe(5)
    const bakDir = path.join(root, ".bak")
    const kept = fs.readdirSync(bakDir).map((n) => fs.readFileSync(path.join(bakDir, n), "utf8")).sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)))
    expect(kept).toEqual(["v6", "v7", "v8", "v9", "v10"])
  })

  it("never follows or deletes links; fresh write and unchanged write report removed 0", () => {
    const root = tmpRoot()
    const outside = tmpRoot()
    const a = path.join(root, "a.md")
    const bakDir = path.join(root, ".bak")
    fs.mkdirSync(bakDir, { mode: 0o700 })
    const precious = path.join(outside, "precious.txt")
    fs.writeFileSync(precious, "keep")
    // an old-stamped link named like a backup of a.md: older than everything, but must survive
    const link = path.join(bakDir, "a.md.bak-20000101T000000Z")
    fs.symlinkSync(precious, link)
    let t = Date.UTC(2026, 10, 12, 3, 0, 0)
    const o = opts(root, () => (t += 1000))
    const fresh = safety.writeFileGuarded(a, Buffer.from("v0"), o)
    expect(fresh.backupRemoved).toBe(0)
    for (let i = 1; i <= 7; i++) safety.writeFileGuarded(a, Buffer.from(`v${i}`), o)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(fs.readFileSync(precious, "utf8")).toBe("keep")
    const regular = fs.readdirSync(bakDir).filter((n) => !fs.lstatSync(path.join(bakDir, n)).isSymbolicLink())
    expect(regular).toHaveLength(5)
    const same = safety.writeFileGuarded(a, Buffer.from("v7"), { ...o, isSame: () => true })
    expect(same.backupRemoved).toBe(0)
  })
})
