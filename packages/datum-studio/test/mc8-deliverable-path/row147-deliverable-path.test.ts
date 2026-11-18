// Swarm 1.3.3 row 147 (senior review S9 and S6, security review M1 at copy time).
//
// S9: one deliverable path rule (src/store/mission/deliverable-path.ts) for the done gate, the copier and the panel. A
// symbolic link at `deliverables/` or `deliverables/<mission>/` whose target holds files with the right sha256 is
// refused by all three alike (before: the gate passed it, the panel showed the file as present).
// M1 (copy time): the render hook copies only into a project folder that is the calling session's folder or inside it.
// S6: `mayClose` on the deliverables projection is the store's whole done verdict (output, project copy, knowledge).
// Real SqliteStudioStore with missionGuard: true (row 66's seeding helper, read-only); no port, no render engine.
import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isStoreError, sha256Hex, type StoreErrorCode } from "../../src/store/index.ts"
import type { NewMission, RowDeliverable } from "../../src/store/mission/index.ts"
import { deliverablePath, deliverableFileName, parseRowDeliverables, PROJECT_DELIVERABLES_DIR, projectDirOutsideRoot } from "../../src/store/mission/deliverable-path.ts"
import { PROJECT_DELIVERABLES_DIR as COPY_DIR, copyToProject, projectCopyAfterRender, projectFileName } from "../../src/mcp-host/verify/project-copy.ts"
import { readDeliverables, readProjectCopies } from "../../src/mcp-host/mission/deliverables.ts"
import { closeStores, openStore, PASS, RUN, row, seedDocument, seedOutput, seedRecord, U1, type Rec, type Tx } from "../mc5-row-close-gate/_seed.ts"

const store = await openStore("row147")
const ROOT = store.rootDir
afterAll(() => closeStores())

const tx = <R>(fn: (t: Tx) => R) => store.transaction(async (t) => fn(t))
let n = 0
async function mission(k = 2): Promise<{ id: string; dir: string }> {
  const id = `2026-11-18_row147-m${++n}`
  const dir = join(RUN, `project-row147-${n}`)
  mkdirSync(dir, { recursive: true })
  const ids = Array.from({ length: k }, (_, i) => String(i + 1))
  const doc: NewMission = { id, title: `Mission ${id}`, type: "document", owner: "master-controller", project: { dir }, rows: ids.map((r) => row(r)), decisions: [U1] }
  await store.transaction(async (t) => store.missions.create(t, doc, { attested: true }))
  await store.transaction(async (t) => store.missions.approve(t, id, "U1"))
  await store.transaction(async (t) => store.missions.updateRows(t, id, ids.map((r) => ({ id: r, status: "running" as const }))))
  return { id, dir }
}
async function deliverable(m: string, r: string) {
  return tx((t) => {
    const d = seedDocument(t, { mission: m, docKey: `row-${r}-laporan` })
    const out = seedOutput(t, ROOT, d, { format: "PDF" })
    seedRecord(t, out, d, PASS)
    return { ...d, docNumber: t.get<{ doc_number: string }>("SELECT doc_number FROM document WHERE id = ?", [d.documentId])!.doc_number }
  })
}
/** The file written into `folder` (a real folder somewhere) and the row item that names it under deliverables/<m>/. */
async function record(m: { id: string }, r: string, d: { documentId: string; docNumber: string; revisionNo: number }, folder: string): Promise<RowDeliverable> {
  const name = projectFileName({ docNumber: d.docNumber, docRev: "A", revisionNo: d.revisionNo }, "PDF")
  const bytes = `${d.documentId}-${d.revisionNo}`
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, name), bytes)
  const item: RowDeliverable = { path: `deliverables/${m.id}/${name}`, format: "PDF", docRev: "A", revisionNo: d.revisionNo, sha256: sha256Hex(bytes), latest: true, documentId: d.documentId }
  await tx((t) => store.missions.setRowDeliverables(t, m.id, r, [item]))
  return item
}
const done = (m: string, id: string) => tx((t) => store.missions.updateRows(t, m, [{ id, status: "done", note: "checked: outputs rendered and verified" }]))
async function refused(p: Promise<unknown>, code: StoreErrorCode): Promise<Rec> {
  try {
    await p
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${(e as { code?: string }).code} ${(e as Error).message}`)
    console.log(`[row147] ${code} ${(e as Error).message}`)
    return { ...((e as { details?: Rec }).details ?? {}), message: (e as Error).message } as Rec
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

describe("S9: one rule, the same verdict in the gate, the copier and the panel", () => {
  test("one folder name and one file name: the copier's constant IS the store's, the copier's name IS the store's", () => {
    expect(COPY_DIR).toBe(PROJECT_DELIVERABLES_DIR)
    for (const [num, rev, no] of [["1/GSP/KT/XI/2026-abc", "A", 3], ["012-GSP-KT-XI-2026", "B", 104]] as const)
      for (const f of ["PDF", "DOCX", "HTML"] as const) expect(projectFileName({ docNumber: num, docRev: rev, revisionNo: no }, f)).toBe(deliverableFileName(num, rev, no, f))
    expect(parseRowDeliverables('[{"path":"deliverables/m/a.pdf"},{"nopath":1},null]')).toEqual([{ path: "deliverables/m/a.pdf" } as RowDeliverable])
    expect(parseRowDeliverables("not json")).toEqual([])
  })

  for (const linked of ["deliverables", "mission"] as const) {
    test(`a symbolic link at ${linked === "deliverables" ? "deliverables/" : "deliverables/<mission>/"} whose target holds the right bytes: gate refuses, panel shows nothing present, copier refuses`, async () => {
      const m = await mission()
      const d = await deliverable(m.id, "1")
      const elsewhere = join(RUN, `elsewhere-${n}`)
      const target = linked === "deliverables" ? join(elsewhere, m.id) : elsewhere
      const item = await record(m, "1", d, target)
      if (linked === "deliverables") symlinkSync(elsewhere, join(m.dir, "deliverables"))
      else {
        mkdirSync(join(m.dir, "deliverables"))
        symlinkSync(elsewhere, join(m.dir, "deliverables", m.id))
      }
      // the shared rule
      const at = deliverablePath(m.dir, m.id, item.path)
      expect(at).toMatchObject({ ok: false, reason: "link", at: linked === "deliverables" ? "deliverables" : `deliverables/${m.id}` })
      // gate (done): DELIVERABLE_NOT_IN_PROJECT, the row stays running
      const det = await refused(done(m.id, "1"), "DELIVERABLE_NOT_IN_PROJECT")
      expect((det.expected as Rec[])[0]).toMatchObject({ path: item.path })
      expect(store.missions.get(m.id)!.mission.rows.find((r) => r.id === "1")!.status).toBe("running")
      // panel: not present, no absolute path to open
      const copies = await tx((t) => readProjectCopies(t, m.id))
      expect(copies.get(d.documentId)).toEqual([{ path: item.path, format: "PDF", docRev: "A", revisionNo: d.revisionNo, sha256: item.sha256, latest: true, present: false }])
      // copier: refused, nothing written through the link
      const before = readdirSync(target).length
      const bytes = new TextEncoder().encode("fresh copy bytes")
      const r = copyToProject({ projectDir: m.dir, mission: m.id, document: { documentId: d.documentId, docNumber: d.docNumber, docRev: "A", revisionNo: d.revisionNo + 1 }, outputs: [{ format: "PDF", sha256: sha256Hex(bytes), bytes }] })
      expect(r).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT" })
      expect(readdirSync(target).length).toBe(before)
    })
  }

  test("a regular copy in real folders: gate passes, panel present with its absolute path", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const item = await record(m, "1", d, join(m.dir, "deliverables", m.id))
    expect(deliverablePath(m.dir, m.id, item.path)).toEqual({ ok: true, abs: join(m.dir, item.path), present: true })
    expect((await tx((t) => readProjectCopies(t, m.id))).get(d.documentId)![0]).toMatchObject({ present: true, absolutePath: join(m.dir, item.path) })
    await done(m.id, "1")
    expect(store.missions.get(m.id)!.mission.rows.find((r) => r.id === "1")!.status).toBe("done")
  })

  test("paths outside deliverables/<mission>/ are refused by the rule (the panel used to accept any relative path)", () => {
    for (const rel of ["deliverables/other-mission/a.pdf", "notes/a.pdf", "deliverables/m/../x.pdf", "deliverables/m", "deliverables\\m\\a.pdf", "/etc/passwd"]) expect(deliverablePath("/p", "m", rel)).toMatchObject({ ok: false, reason: "outside" })
    expect(deliverablePath("relative", "m", "deliverables/m/a.pdf")).toMatchObject({ ok: false, reason: "outside" })
  })
})

describe("M1 at copy time: the project folder must be the session folder or inside it", () => {
  test("projectDirOutsideRoot: same, inside, outside, a link inside the root that points out, a folder not made yet", () => {
    const root = join(RUN, "m1-root")
    const out = join(RUN, "m1-outside")
    mkdirSync(join(root, "sub"), { recursive: true })
    mkdirSync(out, { recursive: true })
    symlinkSync(out, join(root, "escape"))
    expect(projectDirOutsideRoot(root, root)).toBeNull()
    expect(projectDirOutsideRoot(join(root, "sub"), root)).toBeNull()
    expect(projectDirOutsideRoot(join(root, "not-yet", "deeper"), root)).toBeNull()
    expect(projectDirOutsideRoot(out, root)).toContain(out)
    expect(projectDirOutsideRoot(join(root, "escape"), root)).not.toBeNull()
    expect(projectDirOutsideRoot(join(root, "escape", "not-yet"), root)).not.toBeNull()
    expect(projectDirOutsideRoot(`${root}-sibling`, root)).not.toBeNull()
    expect(projectDirOutsideRoot(root, "")).not.toBeNull()
  })

  test("the render hook with a session folder that does not hold the mission's project folder: PATH_OUTSIDE_ROOT naming the folder, nothing written, row unchanged", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const bytes = new TextEncoder().encode("render bytes")
    const session = join(RUN, `other-session-${n}`)
    mkdirSync(session, { recursive: true })
    const logged: Rec[] = []
    const r = await projectCopyAfterRender(store, { documentId: d.documentId, revisionNo: d.revisionNo, outputs: [{ format: "PDF", role: "PRIMARY", sha256: sha256Hex(bytes), bytes }] }, (level, source, message, context) => void logged.push({ level, source, message, ...context }), session)
    console.log(`[row147] copy refused: ${JSON.stringify(r)}`)
    expect(r).toMatchObject({ ok: false, code: "PATH_OUTSIDE_ROOT", dir: m.dir })
    expect((r as { message: string }).message).toContain(m.dir)
    expect(existsSync(join(m.dir, "deliverables"))).toBe(false)
    expect(store.missions.rowContract(m.id, "1").deliverables).toEqual([])
    expect(logged[0]).toMatchObject({ level: "error", code: "PATH_OUTSIDE_ROOT" })
    // the same render from the session that holds the folder copies and records
    const ok = await projectCopyAfterRender(store, { documentId: d.documentId, revisionNo: d.revisionNo, outputs: [{ format: "PDF", role: "PRIMARY", sha256: sha256Hex(bytes), bytes }] }, () => undefined, m.dir)
    expect(ok).toMatchObject({ ok: true, recorded: true, row: "1" })
  })
})

describe("S6: mayClose is the whole done verdict", () => {
  const mayClose = async (m: string, documentId: string) => (await tx((t) => readDeliverables(t, m, new Set(["1", "2"]), store.missions))).find((x) => x.documentId === documentId)!.mayClose
  const closeCode = (m: string, r: string) => store.missions.closeRefusal(m, r)

  test("verified outputs but no project copy: mayClose false (done would refuse DELIVERABLE_NOT_IN_PROJECT)", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    expect(closeCode(m.id, "1")).toBe("DELIVERABLE_NOT_IN_PROJECT")
    expect(await mayClose(m.id, d.documentId)).toBe(false)
    const det = await refused(done(m.id, "1"), "DELIVERABLE_NOT_IN_PROJECT")
    // Decision C40: the refusal names the call in plain words, never in a call shape a model copies as text.
    expect(String(det.message)).toContain(`Call the tool datum-studio_studio_render with documentId "${d.documentId}" and formats ["pdf","docx","html"]`)
    expect(String(det.message)).not.toMatch(/[a-z_]+ \{/)
  })

  test("copy present but the row's library domain not read: mayClose false (KNOWLEDGE_NOT_CONSULTED); with knowledgeReason: true, and done passes", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    await record(m, "1", d, join(m.dir, "deliverables", m.id))
    await tx((t) => store.missions.setRowKnowledge(t, m.id, "1", { domains: [{ domain: "SYN-DOMAIN", firstFile: "syn/first.md", consulted: [] }] }))
    expect(closeCode(m.id, "1")).toBe("KNOWLEDGE_NOT_CONSULTED")
    expect(await mayClose(m.id, d.documentId)).toBe(false)
    await tx((t) => store.missions.updateRows(t, m.id, [{ id: "1", knowledgeReason: "synthetic: the library has no page for this row" } as never]))
    expect(closeCode(m.id, "1")).toBeNull()
    expect(await mayClose(m.id, d.documentId)).toBe(true)
    await done(m.id, "1")
    expect(store.missions.get(m.id)!.mission.rows.find((r) => r.id === "1")!.status).toBe("done")
  })

  test("the read changes nothing: status, events and deliverables stay as they were", async () => {
    const m = await mission()
    await deliverable(m.id, "1")
    const before = JSON.stringify(store.missions.get(m.id))
    const events = store.missions.listEvents(m.id, { afterSeq: 0, take: 1000 }).length
    expect(closeCode(m.id, "1")).toBe("DELIVERABLE_NOT_IN_PROJECT")
    expect(JSON.stringify(store.missions.get(m.id))).toBe(before)
    expect(store.missions.listEvents(m.id, { afterSeq: 0, take: 1000 }).length).toBe(events)
  })
})
