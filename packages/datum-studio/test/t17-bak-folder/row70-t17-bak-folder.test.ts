// @ts-nocheck row70: mcp-harness is a vitest-typed ported helper run under bun:test; checked at run time.
// Swarm 1.2.6 row 70 (T-17 vendor part, U5; register N-055 BACKUP_DIR_NAME, N-057 backupResidue, E-22 basename).
// `overwrite: true` keeps the old file as a backup in `<dir>/.bak/` (created 0700) instead of a `<name>.bak-<stamp>`
// sibling in the output folder; the basename stays `<name>.bak-<YYYYMMDDTHHMMSSZ>` (E-22). The guarded write result,
// studio_report_refresh and studio_file_verify carry `backupResidue` = backups of that file now in `.bak/`.
// Red at BASE e363918a69: the backup sits beside the target and no result carries backupResidue.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeEach, describe, expect, it } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { connect, logs, memNodeFs, ROOT, studioMock } from "../ported/mcp/mcp-harness"
import { DOC, MD } from "../ported/draft/r3-stateful-harness"
import * as safety from "../../vendor/scripts/studio/mcp/safety"

const STAMP = /\.bak-\d{8}T\d{6}Z(-\d+)?$/
const tmpDirs: string[] = []

beforeEach(() => {
  logs.length = 0
})

afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true })
})

function tmpRoot(): string {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "row70-t17-")))
  tmpDirs.push(d)
  return d
}

describe("T-17: overwrite backups go to <dir>/.bak/ with backupResidue", () => {
  it("studio_report_refresh overwrite x3: no .bak file at the output top level, backups in .bak/ with unchanged basename, residue 1-2-3", async () => {
    const m = studioMock()
    const victim = path.join(ROOT, "catatan.md")
    const mem = memNodeFs({ [victim]: "ISI-ASLI\n" })
    const { call } = await connect({ fetch: m.f, nfs: mem.nfs })
    const backups: string[] = []
    for (let i = 1; i <= 3; i++) {
      const r = await call("studio_report_refresh", { documentId: DOC, markdown: MD(), outPath: victim, overwrite: true })
      expect(r.isError).toBeFalsy()
      const bak = r.data.backup as string
      backups.push(bak)
      expect(path.dirname(bak)).toBe(path.join(ROOT, ".bak"))
      expect(path.basename(bak)).toMatch(/^catatan\.md\.bak-\d{8}T\d{6}Z(-\d+)?$/)
      expect(r.data.backupResidue).toBe(i)
      expect(r.text).toContain(`backupResidue ${i}`)
    }
    expect(mem.read(backups[0])).toBe("ISI-ASLI\n")
    const topLevelBak = [...mem.store.keys()].filter((k) => path.dirname(k) === ROOT && STAMP.test(k))
    expect(topLevelBak).toEqual([])
  })

  it("real fs: .bak created 0700, residue counts only this file's backups, fresh write reports 0", () => {
    const root = tmpRoot()
    const a = path.join(root, "a.md")
    const b = path.join(root, "b.md")
    const o = { roots: [root], purpose: "write-report" as const, overwrite: true, nfs: safety.REAL_NODE_FS, now: () => Date.UTC(2026, 10, 12, 1, 2, 3) }
    const fresh = safety.writeFileGuarded(a, Buffer.from("v1"), o)
    expect(fresh.backup).toBeNull()
    expect(fresh.backupResidue).toBe(0)
    safety.writeFileGuarded(b, Buffer.from("b1"), o)
    safety.writeFileGuarded(b, Buffer.from("b2"), o)
    const w2 = safety.writeFileGuarded(a, Buffer.from("v2"), o)
    const w3 = safety.writeFileGuarded(a, Buffer.from("v3"), o)
    const bakDir = path.join(root, ".bak")
    expect(path.dirname(w3.backup as string)).toBe(bakDir)
    expect(fs.statSync(bakDir).mode & 0o777).toBe(0o700)
    expect(w2.backupResidue).toBe(1)
    expect(w3.backupResidue).toBe(2)
    expect(fs.readFileSync(w2.backup as string, "utf8")).toBe("v1")
    expect(fs.readFileSync(w3.backup as string, "utf8")).toBe("v2")
    expect(fs.readFileSync(a, "utf8")).toBe("v3")
    expect(fs.readdirSync(root).filter((n) => STAMP.test(n))).toEqual([])
    expect(fs.readdirSync(bakDir).filter((n) => n.startsWith("b.md.bak-"))).toHaveLength(1)
  })

  it("a .bak that is a file or a link out of the roots is refused before the target is touched", () => {
    const root = tmpRoot()
    const outside = tmpRoot()
    const o = { roots: [root], purpose: "write-report" as const, overwrite: true, nfs: safety.REAL_NODE_FS, now: () => Date.now() }
    const sub1 = path.join(root, "s1")
    fs.mkdirSync(sub1)
    fs.writeFileSync(path.join(sub1, "x.md"), "lama")
    fs.writeFileSync(path.join(sub1, ".bak"), "bukan folder")
    expect(() => safety.writeFileGuarded(path.join(sub1, "x.md"), Buffer.from("baru"), o)).toThrow()
    expect(fs.readFileSync(path.join(sub1, "x.md"), "utf8")).toBe("lama")
    const sub2 = path.join(root, "s2")
    fs.mkdirSync(sub2)
    fs.writeFileSync(path.join(sub2, "y.md"), "lama")
    fs.symlinkSync(outside, path.join(sub2, ".bak"))
    let code = ""
    try {
      safety.writeFileGuarded(path.join(sub2, "y.md"), Buffer.from("baru"), o)
    } catch (e) {
      code = (e as { code?: string }).code ?? ""
    }
    expect(code).toBe("PATH_OUTSIDE_ROOTS")
    expect(fs.readFileSync(path.join(sub2, "y.md"), "utf8")).toBe("lama")
    expect(fs.readdirSync(outside)).toEqual([])
  })

  it("BACKUP_DIR_NAME is the registered '.bak'", () => {
    expect(safety.BACKUP_DIR_NAME).toBe(".bak")
  })
})
