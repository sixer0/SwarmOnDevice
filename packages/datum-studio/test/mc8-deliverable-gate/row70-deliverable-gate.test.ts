// Swarm 1.3.3 row 70 (MC-8 item 3, owner decision U16): DELIVERABLE_NOT_IN_PROJECT.
//
// A row whose outputs are Studio documents (docKey row-<R>-<name>) goes `needs-review` or `done` only when the project
// copy of each document's CURRENT revision is listed in the row's `deliverables`, is on disk in
// <project>/deliverables/<mission>/ and has the recorded sha256 (hashed at gate time). A decision request naming a
// document (document=<id> in its context line) is held to the same rule. A project folder that cannot be written is
// named (cause PROJECT_UNWRITABLE). Rows without documents are unaffected. OUTPUT_UNVERIFIED (row 66) wins when both apply.
// Real SqliteStudioStore with missionGuard: true (row 66's seeding helper, read-only); no port, no render engine.
import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isStoreError, sha256Hex, type StoreErrorCode } from "../../src/store/index.ts"
import type { NewMission, RowDeliverable } from "../../src/store/mission/index.ts"
import { deliverableFileName } from "../../src/store/mission/deliverable-path.ts"
import { projectFileName } from "../../src/mcp-host/verify/project-copy.ts"
import { nextCall } from "../../src/mcp-host/mission/next-call.ts"
import { readDeliverables } from "../../src/mcp-host/mission/deliverables.ts"
import { closeStores, openStore, PASS, RUN, row, seedDocument, seedOutput, seedRecord, U1, type Rec, type Tx } from "../mc5-row-close-gate/_seed.ts"

const store = await openStore("row70")
const ROOT = store.rootDir
afterAll(async () => {
  for (const d of chmodded) chmodSync(d, 0o755)
  await closeStores()
})
const chmodded: string[] = []

const tx = <R>(fn: (t: Tx) => R) => store.transaction(async (t) => fn(t))
let n = 0
/** A running `document` mission with rows 1..k and its own project folder (created unless `create: false`). */
async function mission(k = 4, o: { create?: boolean } = {}): Promise<{ id: string; dir: string }> {
  const id = `2026-11-17_row70-m${++n}`
  const dir = join(RUN, `project-row70-${n}`)
  if (o.create !== false) mkdirSync(dir, { recursive: true })
  const ids = Array.from({ length: k }, (_, i) => String(i + 1))
  const doc: NewMission = { id, title: `Mission ${id}`, type: "document", owner: "master-controller", project: { dir }, rows: ids.map((r) => row(r)), decisions: [U1] }
  await store.transaction(async (t) => store.missions.create(t, doc, { attested: true }))
  await store.transaction(async (t) => store.missions.approve(t, id, "U1"))
  await store.transaction(async (t) => store.missions.updateRows(t, id, ids.map((r) => ({ id: r, status: "running" as const }))))
  return { id, dir }
}

/** A deliverable of row `r`, `revs` revisions, its PRIMARY outputs verified (unless `verified: false`). */
async function deliverable(m: string, r: string, o: { revs?: number; verified?: boolean; formats?: string[] } = {}) {
  return tx((t) => {
    const d = seedDocument(t, { mission: m, docKey: `row-${r}-laporan`, revs: o.revs })
    const outs = (o.formats ?? ["PDF"]).map((format) => seedOutput(t, ROOT, d, { format }))
    for (const out of outs) seedRecord(t, out, d, o.verified === false ? [{ id: "LINT", status: "FAIL" }] : PASS)
    const doc = t.get<{ doc_number: string }>("SELECT doc_number FROM document WHERE id = ?", [d.documentId])!
    return { ...d, outs, docNumber: doc.doc_number }
  })
}

/** Row 68's copy as it lands: the file in the project folder plus the row item (latest on that revision). */
async function copy(m: { id: string; dir: string }, r: string, d: { documentId: string; docNumber: string }, revisionNo: number, o: { format?: "PDF" | "DOCX" | "HTML"; bytes?: string; file?: boolean } = {}): Promise<RowDeliverable & { abs: string }> {
  const format = o.format ?? "PDF"
  const name = projectFileName({ docNumber: d.docNumber, docRev: "A", revisionNo }, format)
  const bytes = o.bytes ?? `${d.documentId}-${revisionNo}-${format}`
  const folder = join(m.dir, "deliverables", m.id)
  mkdirSync(folder, { recursive: true })
  const abs = join(folder, name)
  if (o.file !== false) writeFileSync(abs, bytes)
  const item: RowDeliverable = { path: `deliverables/${m.id}/${name}`, format, docRev: "A", revisionNo, sha256: sha256Hex(bytes), latest: true, documentId: d.documentId }
  const cur = store.missions.rowContract(m.id, r).deliverables.map((x) => ({ ...x, latest: false }))
  await tx((t) => store.missions.setRowDeliverables(t, m.id, r, [...cur, item]))
  return { ...item, abs }
}

const move = (m: string, id: string, status: "done" | "needs-review", note = "checked: outputs rendered and verified") => tx((t) => store.missions.updateRows(t, m, [{ id, status, note }]))
const statusOf = (m: string, id: string) => store.missions.get(m)!.mission.rows.find((r) => r.id === id)!.status
async function refused(label: string, p: Promise<unknown>, code: StoreErrorCode): Promise<Rec> {
  try {
    await p
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`${label}: expected ${code}, got ${e instanceof Error ? `${(e as { code?: string }).code} ${e.message}` : String(e)}`)
    const details = ((e as { details?: Rec }).details ?? {}) as Rec
    console.log(`[row70] ${label}: ${code} ${(e as Error).message} ${JSON.stringify(details)}`)
    return { ...details, message: (e as Error).message }
  }
  throw new Error(`${label}: expected ${code}, nothing thrown`)
}
const expectedOf = (d: Rec) => d.expected as Rec[]
function request(id: string, context?: string) {
  return {
    id,
    question: "Do the figure labels of this document read right?",
    options: [
      { id: "approve", label: "Labels are right", consequence: "labels_verified is raised" },
      { id: "decline", label: "Labels need work", consequence: "the row stays open" },
    ],
    ...(context ? { context } : {}),
  }
}

describe("done: the project copy of the current revision", () => {
  test("current copy present, sha256 equal, outputs verified: closes (row 66's checks then pass)", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    await copy(m, "1", d, d.revisionNo)
    const r = await move(m.id, "1", "done")
    expect(r.changed).toEqual(["1"])
    expect(statusOf(m.id, "1")).toBe("done")
  })

  test("file deleted from the project folder: DELIVERABLE_NOT_IN_PROJECT, cause missing, names the path and studio_render", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const c = await copy(m, "1", d, d.revisionNo)
    rmSync(c.abs)
    const det = await refused("deleted", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.cause).toBe("missing")
    expect(det.mission).toBe(m.id)
    expect(det.row).toBe("1")
    expect(expectedOf(det)).toEqual([{ path: c.path, sha256: c.sha256, documentId: d.documentId, revisionNo: d.revisionNo, format: "PDF", cause: "missing" }])
    expect(String(det.message)).toContain(c.path)
    expect(String(det.message)).toContain("studio_render")
    expect(String(det.fix)).toBe("studio_render")
    expect(statusOf(m.id, "1")).toBe("running")
  })

  test("bytes changed by hand: refused, cause sha-mismatch (hashed at gate time)", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const c = await copy(m, "1", d, d.revisionNo)
    writeFileSync(c.abs, "edited by hand")
    const det = await refused("sha", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.cause).toBe("sha-mismatch")
    expect(expectedOf(det)[0]!.cause).toBe("sha-mismatch")
    expect(String(det.message)).toContain("person")
  })

  test("stale copy: a verified file of an OLDER revision does not satisfy the gate", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1", { revs: 3 })
    await copy(m, "1", d, d.revisionNo - 1)
    const det = await refused("stale", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.cause).toBe("missing")
    const e = expectedOf(det)[0]!
    expect(e.revisionNo).toBe(d.revisionNo)
    expect(e.olderRevisionNo).toBe(d.revisionNo - 1)
    expect(e.path).toBe(`deliverables/${m.id}/${projectFileName({ docNumber: d.docNumber, docRev: "A", revisionNo: d.revisionNo }, "PDF")}`)
    expect(e.sha256).toBe(d.outs[0]!.sha256)
  })

  test("nothing copied: the expected names are row 68's names of the current revision's outputs", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1", { formats: ["DOCX", "HTML", "PDF"] })
    const det = await refused("none", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(expectedOf(det).map((e) => e.path)).toEqual(
      (["PDF", "DOCX", "HTML"] as const).map((f) => `deliverables/${m.id}/${projectFileName({ docNumber: d.docNumber, docRev: "A", revisionNo: d.revisionNo }, f)}`),
    )
  })

  test("a link at the file's name is not a copy", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const c = await copy(m, "1", d, d.revisionNo, { file: false })
    const real = join(m.dir, "elsewhere.pdf")
    writeFileSync(real, `${d.documentId}-${d.revisionNo}-PDF`)
    symlinkSync(real, c.abs)
    const det = await refused("link", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.cause).toBe("missing")
  })

  test("only the row's own items count for a status move", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    await copy(m, "2", d, d.revisionNo)
    await refused("other row", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
  })
})

describe("needs-review", () => {
  test("refused without the file; passes with it", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const det = await refused("review", move(m.id, "1", "needs-review"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.to).toBe("needs-review")
    expect(statusOf(m.id, "1")).toBe("running")
    await copy(m, "1", d, d.revisionNo)
    await move(m.id, "1", "needs-review")
    expect(statusOf(m.id, "1")).toBe("needs-review")
  })

  test("needs-review -> done re-checks the file", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const c = await copy(m, "1", d, d.revisionNo)
    await move(m.id, "1", "needs-review")
    rmSync(c.abs)
    await refused("review then done", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
  })
})

describe("project folder", () => {
  test("missing project folder: refused with cause PROJECT_UNWRITABLE, never a pass", async () => {
    const m = await mission(4, { create: false })
    await deliverable(m.id, "1")
    const det = await refused("no folder", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.cause).toBe("PROJECT_UNWRITABLE")
    expect(String(det.unwritable)).toContain("does not exist")
    expect(String(det.fix)).toBe("studio_mission_request_decision")
  })

  test("read-only project folder with a file missing: cause PROJECT_UNWRITABLE", async () => {
    const m = await mission()
    await deliverable(m.id, "1")
    chmodSync(m.dir, 0o555)
    chmodded.push(m.dir)
    const det = await refused("read-only", move(m.id, "1", "done"), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.cause).toBe("PROJECT_UNWRITABLE")
    expect(String(det.unwritable)).toContain("cannot be written")
  })

  test("read-only folder with every copy present and equal: closes (nothing to write)", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    await copy(m, "1", d, d.revisionNo)
    chmodSync(join(m.dir, "deliverables", m.id), 0o555)
    chmodded.push(join(m.dir, "deliverables", m.id))
    await move(m.id, "1", "done")
    expect(statusOf(m.id, "1")).toBe("done")
  })
})

describe("decision request naming a document", () => {
  test("refused without the file; opened with it", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    const ctx = `labels_verified row=1 document=${d.documentId} revision=${d.revisionNo} figures=p1`
    const det = await refused("request", tx((t) => store.missions.requestDecision(t, m.id, request("D-1", ctx) as never)), "DELIVERABLE_NOT_IN_PROJECT")
    expect(det.request).toBe("D-1")
    expect(expectedOf(det)[0]!.documentId).toBe(d.documentId)
    expect(store.missions.listDecisionRequests(m.id)).toEqual([])
    await copy(m, "1", d, d.revisionNo)
    const r = await tx((t) => store.missions.requestDecision(t, m.id, request("D-1", ctx) as never))
    expect(r.status).toBe("open")
  })

  test("a copy listed on another row of the mission counts for a request", async () => {
    const m = await mission()
    const d = await deliverable(m.id, "1")
    await copy(m, "2", d, d.revisionNo)
    const r = await tx((t) => store.missions.requestDecision(t, m.id, request("D-2", `review document=${d.documentId}`) as never))
    expect(r.status).toBe("open")
  })

  test("a request that names no document is unchanged", async () => {
    const m = await mission()
    await deliverable(m.id, "1")
    const r = await tx((t) => store.missions.requestDecision(t, m.id, { ...request("D-3", "pick the cover colour"), blockingRows: ["1"] } as never))
    expect(r.status).toBe("open")
  })
})

describe("unaffected and precedence", () => {
  test("a row without documents: done and needs-review as before", async () => {
    const m = await mission()
    await move(m.id, "3", "needs-review")
    await move(m.id, "4", "done")
    expect(statusOf(m.id, "3")).toBe("needs-review")
    expect(statusOf(m.id, "4")).toBe("done")
  })

  test("outputs not verified and no copy: OUTPUT_UNVERIFIED wins (row 66's check runs first)", async () => {
    const m = await mission()
    await deliverable(m.id, "1", { verified: false })
    await refused("both", move(m.id, "1", "done"), "OUTPUT_UNVERIFIED")
  })

  test("gate off (store without missionGuard): no project check", async () => {
    const off = await openStore("row70-off", false)
    const id = "2026-11-17_row70-off"
    const doc: NewMission = { id, title: "off", type: "document", owner: "master-controller", project: { dir: join(RUN, "project-off") }, rows: [row("1")], decisions: [U1] }
    await off.transaction(async (t) => off.missions.create(t, doc, { attested: true }))
    await off.transaction(async (t) => off.missions.approve(t, id, "U1"))
    await off.transaction(async (t) => off.missions.updateRows(t, id, [{ id: "1", status: "running" }]))
    await off.transaction(async (t) => seedDocument(t, { mission: id, docKey: "row-1-laporan" }))
    await off.transaction(async (t) => off.missions.updateRows(t, id, [{ id: "1", status: "needs-review" }]))
    expect(off.missions.get(id)!.mission.rows[0]!.status).toBe("needs-review")
  })
})

describe("projection: the gate's verdict beside the strict Final (row 66 request)", () => {
  // Row 147 (S6): mayClose is the row's whole done verdict (store closeChecks, read-only), so the verified DOCX needs its
  // project copy too; without it see row147-deliverable-path.test.ts.
  test("a verified DOCX alone: final false (strict), mayClose true; a failing one: mayClose false; a row-less document has no field", async () => {
    const m = await mission()
    const ok = await deliverable(m.id, "1", { formats: ["DOCX"] })
    await copy(m, "1", ok, ok.revisionNo, { format: "DOCX" })
    const bad = await deliverable(m.id, "2", { verified: false })
    const loose = await tx((t) => seedDocument(t, { mission: m.id, docKey: "lampiran" }))
    const list = await tx((t) => readDeliverables(t, m.id, new Set(["1", "2", "3", "4"]), store.missions))
    const by = (id: string) => list.find((x) => x.documentId === id)!
    expect(by(ok.documentId).final).toBe(false)
    expect(by(ok.documentId).mayClose).toBe(true)
    expect(by(bad.documentId).mayClose).toBe(false)
    expect("mayClose" in by(loose.documentId)).toBe(false)
  })
})

describe("names and hints", () => {
  test("the store's deliverableFileName (row 147: the one name) equals row 68's projectFileName", () => {
    for (const [num, rev, no] of [["1/GSP/KT/XI/2026-abc", "A", 3], ["012-GSP-KT-XI-2026", "B", 104], ["7/GSP/NT/I/2027", "A1", 0]] as const) {
      for (const f of ["PDF", "DOCX", "HTML"] as const) expect(deliverableFileName(num, rev, no, f)).toBe(projectFileName({ docNumber: num, docRev: rev, revisionNo: no }, f))
    }
  })

  test("hints: DELIVERABLE_NOT_IN_PROJECT names studio_render and the person's causes; OUTPUT_UNVERIFIED no longer offers a row note", () => {
    const h = nextCall("DELIVERABLE_NOT_IN_PROJECT")
    expect(h).toContain("studio_render")
    expect(h).toContain("PROJECT_UNWRITABLE")
    expect(h).toContain("sha-mismatch")
    const o = nextCall("OUTPUT_UNVERIFIED")
    expect(o).not.toContain("row note")
    expect(o).toContain("rincian.fix")
  })
})
