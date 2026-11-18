/**
 * Swarm 1.3.3 row 71 (MC-8 items 4-6): the deliverables projection carries the project copies row 68 recorded.
 * Real SqliteStudioStore over a temp folder; documents, revisions and outputs are inserted as raw rows in a write
 * transaction (the projection reads only), the row's `deliverables` through the real setter. Files are real files in
 * a temp project folder. Temp folder: ROW71_TEST_DIR, else the OS temp folder.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "bun:test"
import { SqliteStudioStore } from "../../store/index.ts"
import type { MissionRowInput, NewMission, RowDeliverable } from "../../store/mission/index.ts"
import { readDeliverables, readProjectCopies } from "./deliverables.ts"

const BASE = process.env.ROW71_TEST_DIR ?? join(tmpdir(), "row71-deliverables-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, "run-"))
const PROJECT = join(RUN, "project")
const MID = "2026-11-17_row71"
const D1 = "docone00000000000000000"
const D2 = "doctwo00000000000000000"
const SHA = "ab".repeat(32)
const SHA2 = "cd".repeat(32)
let tick = 1_800_000_000_000
const store = new SqliteStudioStore()
afterAll(async () => {
  await store.close()
  rmSync(RUN, { recursive: true, force: true })
})

const row = (id: string): MissionRowInput => ({ id, phase: "implementation", kind: "implementation", title: `Row ${id}`, agent: "coder-execution", model: { tier: "thinker" }, deps: [], size: "S", status: "pending", output: `implementation/${id}.md`, verification: "tests pass" })
const mission: NewMission = { id: MID, title: "Row 71", type: "feature-release", owner: "master-controller", project: { dir: PROJECT }, rows: [row("1"), row("2")], decisions: [{ id: "U1", by: "user", date: "2026-11-17", text: "ok" }] }

const ITEMS: RowDeliverable[] = [
  { path: `deliverables/${MID}/001-GSP-KT-XI-2026 RevB rev2.pdf`, format: "PDF", docRev: "B", revisionNo: 2, sha256: SHA2, latest: true, documentId: D1 },
  { path: `deliverables/${MID}/001-GSP-KT-XI-2026 RevB rev2.docx`, format: "DOCX", docRev: "B", revisionNo: 2, sha256: SHA2, latest: true, documentId: D1 },
  { path: `deliverables/${MID}/001-GSP-KT-XI-2026 RevA rev1.pdf`, format: "PDF", docRev: "A", revisionNo: 1, sha256: SHA, latest: false, documentId: D1 },
]

async function setup() {
  await store.open(join(RUN, "store"), { release: "1.3.3", log: () => {}, agentClock: () => ++tick })
  await store.transaction(async (t) => {
    store.missions.create(t, mission, { attested: true })
    const now = t.now
    t.run("INSERT INTO template (id, slug, origin, name, kind, created_by, time_created, time_updated) VALUES ('tpl-1', 'nota-test', 'builtin', 'Nota', 'DOCUMENT', 'test', ?, ?)", [now, now])
    t.run(
      "INSERT INTO template_version (id, template_id, version_no, definition, definition_sha256, overrides, resolved_params, params_sha256, role_formats, section_plan, assets, provenance, change_note, created_by, time_created) VALUES ('tv-1', 'tpl-1', 1, '{}', ?, '{}', '{}', ?, '{}', '{}', '[]', '{}', 'n', 'test', ?)",
      [SHA, SHA, now],
    )
    const tv = { id: "tv-1", template_id: "tpl-1" }
    for (const [id, num, key] of [[D1, "001-GSP-KT-XI-2026", "row-1-nota"], [D2, "002-GSP-KT-XI-2026", "row-2-nota"]] as const) {
      t.run(
        "INSERT INTO document (id, doc_number, doc_number_safe, number_source, title, type_code, classification, tier, template_id, current_revision_no, mission_folder, mission_doc_key, created_by, time_created, time_updated) VALUES (?, ?, ?, 'AGENT', ?, 'KT', 'TERBATAS', 'NOTA', ?, 2, ?, ?, 'test', ?, ?)",
        [id, num, num, `Doc ${id}`, tv.template_id, MID, key, now, now],
      )
      t.run(
        "INSERT INTO revision (id, document_id, revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256, doc_rev, change_what, change_why, change_impact, created_by, time_created) VALUES (?, ?, 2, ?, '{}', ?, ?, 'B', 'w', 'y', 'i', 'test', ?)",
        [`${id}-r2`, id, tv.id, SHA, SHA, now],
      )
      t.run("INSERT INTO output_file (id, kind, document_id, revision_id, format, role, rel_path, file_name, bytes, sha256, mime, time_created) VALUES (?, 'document', ?, ?, 'PDF', 'PRIMARY', ?, ?, 10, ?, 'application/pdf', ?)", [`${id}-o1`, id, `${id}-r2`, `rel/${id}.pdf`, `${id}.pdf`, SHA2, now])
    }
  })
}

const readAll = (): Promise<ReturnType<typeof readDeliverables>> => store.transaction(async (q) => readDeliverables(q, MID, new Set(["1", "2"]), store.missions))

describe("row 71: project copies in the deliverables projection", () => {
  test("a document without a project copy keeps its shape and says it has none", async () => {
    await setup()
    const list = await readAll()
    expect(list.map((d) => d.documentId).sort()).toEqual([D1, D2])
    for (const d of list) {
      expect(d.hasProjectCopy).toBe(false)
      expect("projectFiles" in d).toBe(false)
      expect(Object.keys(d).sort()).toEqual(["docKey", "docNumber", "docRev", "documentId", "final", "hasProjectCopy", "mayClose", "outputs", "revisionNo", "rowId", "title", "updatedAt", "verified"])
    }
  })

  test("after a copy the projection carries path, absolute path, format, revision, sha256, latest and presence", async () => {
    mkdirSync(join(PROJECT, "deliverables", MID), { recursive: true })
    for (const it of ITEMS.slice(0, 2)) writeFileSync(join(PROJECT, it.path), "x") // the older PDF is not on disk
    await store.transaction(async (t) => store.missions.setRowDeliverables(t, MID, "1", ITEMS))
    const list = await readAll()
    const d1 = list.find((d) => d.documentId === D1)!
    expect(d1.hasProjectCopy).toBe(true)
    expect(d1.projectFiles).toEqual([
      { path: ITEMS[0]!.path, absolutePath: join(PROJECT, ITEMS[0]!.path), format: "PDF", docRev: "B", revisionNo: 2, sha256: SHA2, latest: true, present: true },
      { path: ITEMS[1]!.path, absolutePath: join(PROJECT, ITEMS[1]!.path), format: "DOCX", docRev: "B", revisionNo: 2, sha256: SHA2, latest: true, present: true },
      { path: ITEMS[2]!.path, absolutePath: join(PROJECT, ITEMS[2]!.path), format: "PDF", docRev: "A", revisionNo: 1, sha256: SHA, latest: false, present: false }, // older revision stays listed
    ])
    // the other document of the mission is unchanged
    const d2 = list.find((d) => d.documentId === D2)!
    expect(d2.hasProjectCopy).toBe(false)
    expect("projectFiles" in d2).toBe(false)
    // the existing fields are as before
    expect(d1.outputs.map((o) => [o.format, o.sha256, o.verified])).toEqual([["PDF", SHA2, false]])
    expect(d1.rowId).toBe("1")
  })

  test("removing the file flips the presence flag; nothing is hashed on read", async () => {
    rmSync(join(PROJECT, ITEMS[0]!.path))
    let d1 = (await readAll()).find((d) => d.documentId === D1)!
    expect(d1.projectFiles!.map((f) => f.present)).toEqual([false, true, false])
    // changed bytes: still present, stored sha256 unchanged (the read does not hash)
    writeFileSync(join(PROJECT, ITEMS[1]!.path), "changed by hand")
    d1 = (await readAll()).find((d) => d.documentId === D1)!
    expect(d1.projectFiles![1]).toMatchObject({ present: true, sha256: SHA2 })
    // a directory with the file's name is not a file
    mkdirSync(join(PROJECT, ITEMS[0]!.path))
    d1 = (await readAll()).find((d) => d.documentId === D1)!
    expect(d1.projectFiles![0]!.present).toBe(false)
  })

  test("readProjectCopies: unknown mission is empty; a stored path that leaves the folder is never present and has no absolute path", async () => {
    expect(await store.transaction(async (q) => readProjectCopies(q, "2026-11-17_nope")).then((m) => m.size)).toBe(0)
    const seen: string[] = []
    const got = await store.transaction(async (q) => readProjectCopies(q, MID, (p) => (seen.push(p), true)))
    expect(seen.length).toBe(3) // every stored item is checked, nothing else
    expect(got.get(D1)!.every((f) => f.present && f.absolutePath?.startsWith(PROJECT))).toBe(true)
    const bad = (await store.transaction(async (t) => {
      t.run("UPDATE mission_row SET deliverables = ? WHERE mission_id = ? AND row_id = '2'", [JSON.stringify([{ path: "../../etc/passwd", format: "PDF", sha256: SHA, latest: true, documentId: D2 }]), MID])
    }), await store.transaction(async (q) => readProjectCopies(q, MID, () => true))).get(D2)!
    expect(bad).toEqual([{ path: "../../etc/passwd", format: "PDF", sha256: SHA, latest: true, present: false }])
  })
})
