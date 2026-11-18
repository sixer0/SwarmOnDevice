// 1.3.3 row 68 (MC-8 items 1-2, 4, 6-7; U16): the project copier, alone, over a temp project folder (no host, no
// port). The path rule, the sha256 check, the no-overwrite rule, the symlink refusals and the `latest` merge are
// checked here; the render hook is checked through the real host in row68-render-project-copy.test.ts.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { DATUM_FILENAME_PATTERN } from "../../vendor/src/lib/studio/contract/env"
import { copyToProject, mergeRowDeliverables, projectCopyLines, projectFileName, PROJECT_DELIVERABLES_DIR, ROW_DELIVERABLES_MAX, type ProjectCopyInput } from "../../src/mcp-host/verify/project-copy"

const WORK = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "row68-copy-")))
const M = "2026-11-17_m68-copy"
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex")
const bytesOf = (s: string) => new Uint8Array(Buffer.from(s))
let n = 0
function project(): string {
  const dir = path.join(WORK, `project-${++n}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
function input(projectDir: string, over: Partial<ProjectCopyInput> = {}, tag = "a"): ProjectCopyInput {
  const outputs = (["DOCX", "PDF", "HTML"] as const).map((format) => {
    const bytes = bytesOf(`${format}-${tag}`)
    return { format, sha256: sha(bytes), bytes }
  })
  return { projectDir, mission: M, document: { documentId: "d".repeat(24), docNumber: "012-GSP-KT-XI-2026", docRev: "D", revisionNo: 256 }, outputs, ...over }
}

describe("row 68: file name and folder (register section 5)", () => {
  test("name = number, revision letter, Studio revision number, extension; no title, timestamp or hash", () => {
    expect(PROJECT_DELIVERABLES_DIR).toBe("deliverables")
    expect(projectFileName({ docNumber: "012-GSP-KT-XI-2026", docRev: "D", revisionNo: 256 }, "PDF")).toBe("012-GSP-KT-XI-2026 RevD rev256.pdf")
    expect(projectFileName({ docNumber: "012/GSP/KT/XI/2026", docRev: "A", revisionNo: 3 }, "DOCX")).toBe("012-GSP-KT-XI-2026 RevA rev3.docx")
    expect(new RegExp(DATUM_FILENAME_PATTERN).test(projectFileName({ docNumber: "012-GSP-KT-XI-2026", docRev: "D", revisionNo: 256 }, "HTML"))).toBe(true)
  })

  test("the three files land in <project>/deliverables/<mission>/ with the store's sha256", () => {
    const dir = project()
    const r = copyToProject(input(dir))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dir).toBe(path.join(dir, "deliverables", M))
    expect(r.files.map((f) => f.path).sort()).toEqual(["docx", "html", "pdf"].map((e) => `deliverables/${M}/012-GSP-KT-XI-2026 RevD rev256.${e}`))
    for (const f of r.files) {
      expect(sha(readFileSync(path.join(dir, f.path)))).toBe(f.sha256)
      expect(f).toMatchObject({ docRev: "D", revisionNo: 256, latest: true, documentId: "d".repeat(24) })
    }
    expect(r.written).toBe(3)
    expect(r.kept).toBe(0)
  })

  test("a second render of the same revision leaves the equal files alone", () => {
    const dir = project()
    expect(copyToProject(input(dir)).ok).toBe(true)
    const r = copyToProject(input(dir))
    expect(r).toMatchObject({ ok: true, written: 0, kept: 3 })
  })

  test("only the formats that exist are copied", () => {
    const dir = project()
    const one = input(dir)
    const r = copyToProject({ ...one, outputs: one.outputs.filter((o) => o.format === "PDF") })
    expect(r.ok && r.files.map((f) => f.format)).toEqual(["PDF"])
    expect(readdirSync(path.join(dir, "deliverables", M))).toEqual(["012-GSP-KT-XI-2026 RevD rev256.pdf"])
  })
})

describe("row 68: refusals", () => {
  test("a file of the same name with other content is never overwritten (OUTPUT_EXISTS)", () => {
    const dir = project()
    expect(copyToProject(input(dir)).ok).toBe(true)
    const target = path.join(dir, "deliverables", M, "012-GSP-KT-XI-2026 RevD rev256.pdf")
    const before = readFileSync(target)
    const r = copyToProject(input(dir, {}, "other"))
    expect(r).toMatchObject({ ok: false, code: "OUTPUT_EXISTS" })
    expect(Buffer.compare(readFileSync(target), before)).toBe(0)
  })

  test("bytes that do not match the store's sha256 are an error and write nothing (INTEGRITY_MISMATCH)", () => {
    const dir = project()
    const good = input(dir)
    const r = copyToProject({ ...good, outputs: good.outputs.map((o, i) => (i === 1 ? { ...o, sha256: "0".repeat(64) } : o)) })
    expect(r).toMatchObject({ ok: false, code: "INTEGRITY_MISMATCH" })
    expect(existsSync(path.join(dir, "deliverables"))).toBe(false)
  })

  test("missing bytes of a listed output are an error, not a silent skip", () => {
    const dir = project()
    const good = input(dir)
    expect(copyToProject({ ...good, outputs: good.outputs.map((o, i) => (i === 0 ? { ...o, bytes: null } : o)) })).toMatchObject({ ok: false, code: "INTEGRITY_MISMATCH" })
  })

  test("path escape through document metadata is refused before any write", () => {
    const dir = project()
    for (const document of [
      { documentId: "d".repeat(24), docNumber: "../../evil", docRev: "A", revisionNo: 1 },
      { documentId: "d".repeat(24), docNumber: "012-GSP", docRev: "../x", revisionNo: 1 },
      { documentId: "d".repeat(24), docNumber: "/etc/passwd", docRev: "A", revisionNo: 1 },
      { documentId: "d".repeat(24), docNumber: "012-GSP", docRev: "A", revisionNo: -1 },
      { documentId: "d".repeat(24), docNumber: "..", docRev: "A", revisionNo: 1 },
    ]) {
      const r = copyToProject(input(dir, { document }))
      expect(r).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
    }
    expect(existsSync(path.join(dir, "deliverables"))).toBe(false)
    expect(readdirSync(WORK).filter((x) => x.includes("evil"))).toEqual([])
  })

  test("a mission id that is not a mission id is refused", () => {
    const dir = project()
    for (const mission of ["../outside", "2026-11-17_x/../../y", "", "2026-11-17_UPPER"]) expect(copyToProject(input(dir, { mission }))).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
    expect(existsSync(path.join(dir, "deliverables"))).toBe(false)
  })

  test("a deliverables folder that is a symlink out of the project is refused, nothing lands outside", () => {
    const dir = project()
    const outside = path.join(WORK, `outside-${n}`)
    mkdirSync(outside)
    symlinkSync(outside, path.join(dir, "deliverables"))
    const r = copyToProject(input(dir))
    expect(r).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
    expect(readdirSync(outside)).toEqual([])
  })

  test("a mission folder that is a symlink out of the project is refused", () => {
    const dir = project()
    const outside = path.join(WORK, `outside-m-${n}`)
    mkdirSync(outside)
    mkdirSync(path.join(dir, "deliverables"))
    symlinkSync(outside, path.join(dir, "deliverables", M))
    expect(copyToProject(input(dir))).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
    expect(readdirSync(outside)).toEqual([])
  })

  test("a target name that is a symlink is refused, the link target is untouched", () => {
    const dir = project()
    const dest = path.join(dir, "deliverables", M)
    mkdirSync(dest, { recursive: true })
    const victim = path.join(WORK, `victim-${n}.txt`)
    writeFileSync(victim, "keep")
    symlinkSync(victim, path.join(dest, "012-GSP-KT-XI-2026 RevD rev256.pdf"))
    expect(copyToProject(input(dir))).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
    expect(readFileSync(victim, "utf8")).toBe("keep")
  })

  test("a project folder inside the Studio store is refused", () => {
    const storeRoot = path.join(WORK, `store-${++n}`)
    const dir = path.join(storeRoot, "docs", "p")
    mkdirSync(dir, { recursive: true })
    expect(copyToProject(input(dir, { storeRoot }))).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
    expect(existsSync(path.join(dir, "deliverables"))).toBe(false)
  })

  test("PROJECT_UNWRITABLE: missing project folder, relative path, read-only folder; the path is named", () => {
    const missing = path.join(WORK, "no-such-project")
    expect(copyToProject(input(missing))).toMatchObject({ ok: false, code: "PROJECT_UNWRITABLE", dir: missing })
    expect(existsSync(missing)).toBe(false) // the project folder itself is never created
    expect(copyToProject(input("relative/project"))).toMatchObject({ ok: false, code: "PROJECT_UNWRITABLE" })
    const ro = project()
    chmodSync(ro, 0o555)
    const r = copyToProject(input(ro))
    chmodSync(ro, 0o755)
    expect(r).toMatchObject({ ok: false, code: "PROJECT_UNWRITABLE", dir: ro })
    expect(!r.ok && r.message.length > 0).toBe(true)
  })
})

describe("row 68: the row's deliverables list", () => {
  const item = (rev: number, format: "DOCX" | "PDF" | "HTML", documentId = "d".repeat(24)) => ({
    path: `deliverables/${M}/012 RevA rev${rev}.${format.toLowerCase()}`,
    format,
    docRev: "A",
    revisionNo: rev,
    sha256: sha(bytesOf(`${format}${rev}${documentId}`)),
    latest: true,
    documentId,
  })

  test("a new Studio revision adds items and moves `latest`; older items stay listed", () => {
    const first = mergeRowDeliverables([], [item(1, "DOCX"), item(1, "PDF"), item(1, "HTML")])
    expect(first.list.every((d) => d.latest)).toBe(true)
    const second = mergeRowDeliverables(first.list, [item(2, "DOCX"), item(2, "PDF"), item(2, "HTML")])
    expect(second.list).toHaveLength(6)
    expect(second.list.filter((d) => d.latest).map((d) => d.revisionNo)).toEqual([2, 2, 2])
    expect(second.list.filter((d) => !d.latest).map((d) => d.revisionNo)).toEqual([1, 1, 1])
    expect(second.dropped).toBe(0)
  })

  test("the same revision again replaces by path (no duplicate); another document keeps its own latest", () => {
    const a = mergeRowDeliverables([], [item(1, "PDF")])
    const again = mergeRowDeliverables(a.list, [item(1, "PDF"), item(1, "HTML")])
    expect(again.list.map((d) => d.format).sort()).toEqual(["HTML", "PDF"])
    const other = { ...item(5, "PDF", "e".repeat(24)), path: `deliverables/${M}/099 RevA rev5.pdf` }
    const both = mergeRowDeliverables(again.list, [other])
    expect(both.list.filter((d) => d.latest)).toHaveLength(3)
  })

  test("an older revision rendered after a newer one is listed but is not latest", () => {
    const newer = mergeRowDeliverables([], [item(3, "PDF")])
    const r = mergeRowDeliverables(newer.list, [item(2, "PDF")])
    expect(r.list.find((d) => d.revisionNo === 3)!.latest).toBe(true)
    expect(r.list.find((d) => d.revisionNo === 2)!.latest).toBe(false)
  })

  test("the list stays within the row cap: the oldest non-latest items leave the list, and the count is said", () => {
    let list = mergeRowDeliverables([], []).list
    for (let rev = 1; rev <= 40; rev++) list = mergeRowDeliverables(list, [item(rev, "DOCX"), item(rev, "PDF"), item(rev, "HTML")]).list
    expect(list.length).toBeLessThanOrEqual(ROW_DELIVERABLES_MAX)
    expect(list.filter((d) => d.latest).map((d) => d.revisionNo)).toEqual([40, 40, 40])
    expect(list.some((d) => d.revisionNo === 1)).toBe(false)
    expect(mergeRowDeliverables(list, [item(41, "DOCX"), item(41, "PDF"), item(41, "HTML")]).dropped).toBeGreaterThan(0)
  })
})

describe("row 68: reply lines (safe tokens only)", () => {
  test("ok, skipped and refused each give a `project copy:` line", () => {
    const dir = project()
    const ok = copyToProject(input(dir))
    expect(ok.ok).toBe(true)
    if (!ok.ok) return
    const lines = projectCopyLines({ ok: true, dir: ok.dir, files: ok.files, row: "4", recorded: true })
    expect(lines[0]).toBe(`project copy: OK 3 files in deliverables/${M}/ (row 4 deliverables updated)`)
    expect(lines.filter((l) => l.includes("sha256="))).toHaveLength(3)
    expect(projectCopyLines({ ok: false, skipped: true, reason: "no-mission", message: "the document belongs to no mission" })[0]).toBe("project copy: none (no-mission: the document belongs to no mission)")
    const bad = projectCopyLines({ ok: false, code: "PROJECT_UNWRITABLE", dir: "/tmp/p <x>", message: "EACCES: <b>" })
    expect(bad[0]).toStartWith("project copy: FAILED PROJECT_UNWRITABLE")
    expect(bad.join("\n")).not.toContain("<")
  })
})
