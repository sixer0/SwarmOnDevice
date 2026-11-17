/**
 * Swarm 1.3.3 row 82 (ST-11, decision C6): revision retention and migration 0010.
 * Fixture stores only, under ROW82_133_TEST_DIR or the OS temp folder; the live store is never opened.
 *
 * The proof test: every revision a mission, a row deliverable, an event, a snapshot, a citation, an output, a
 * verification record or mission prose refers to, plus the latest and the newest N of every document, is still
 * present and byte-identical (whole `getRevision` read) after mark and purge; unreferenced old revisions leave only
 * through a purge after the window; the backup puts them back.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { openSqlite } from "#sqlite"
import type { SqliteDb } from "./driver-types.ts"
import { isStoreError, type StoreErrorCode } from "./errors.ts"
import { canonicalJson, newId, sha256Hex } from "./ids.ts"
import { applyMigrations, MIGRATIONS, revertMigrations } from "./migrations/index.ts"
import { MIGRATION_0008_ID } from "./migrations/0008_datum_decision_provenance.ts"
import { MIGRATION_0009_ID } from "./migrations/0009_datum_mission_row_contract.ts"
import { MIGRATION_0010_ID } from "./migrations/0010_datum_revision_retention.ts"
import { MIGRATION_0010_DOWN_SQL } from "./migrations/0010_datum_revision_retention.down.ts"
import { KEEP_CLAUSES, readRevisionBackup, revisionKeepSet, revisionNumbersIn, RETENTION_KEEP_RECENT, RETENTION_SOFT_WINDOW_DAYS, type KeepClause } from "./revision-retention.ts"
import { SqliteStudioStore } from "./studio-store.ts"
import type { BuiltinTemplateFile, RevisionRowsInput } from "./types.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, "..", "..")
const BASE = process.env.ROW82_133_TEST_DIR ?? join(tmpdir(), "row82-133-revision-retention-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const DAY = 86_400_000
const RELEASE = "1.3.3"
let now = 1_800_000_000_000
const clock = () => ++now
const opened: SqliteStudioStore[] = []
afterAll(async () => {
  for (const s of opened) await s.close()
})

async function openStore(name: string) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: RELEASE, agentClock: clock })
  opened.push(s)
  return s
}
async function closeStore(s: SqliteStudioStore) {
  await s.close()
  opened.splice(opened.indexOf(s), 1)
}
function rawDb(name: string): SqliteDb {
  const db = openSqlite(join(RUN, name, "datum-studio.sqlite"))
  db.exec("PRAGMA foreign_keys = ON")
  return db
}
async function refused(p: Promise<unknown> | (() => unknown), code: StoreErrorCode): Promise<Record<string, unknown>> {
  try {
    await (typeof p === "function" ? p() : p)
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    return e.details ?? {}
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

// ── fixture ─────────────────────────────────────────────────────────────────

const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
const BUILTIN: BuiltinTemplateFile = { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: "a".repeat(64), release: RELEASE }

/** One revision's rows: a section, a chapter, a subsection, three doc_block rows, and (old shape) three legacy `block` rows. */
function rowsFor(ids: { ch: string; sub: string; blocks: string[] }, tag: string, first: boolean, legacy: boolean, refs?: Array<Record<string, unknown>>): RevisionRowsInput {
  const sectionId = newId()
  const chapterId = newId()
  const subId = newId()
  const texts = [1, 2, 3].map((i) => `${tag} paragraf ${i} ${"isi ".repeat(40)}`)
  return {
    identities: first ? [{ id: ids.ch, pid: "p-ch1", kind: "CHAPTER" }, { id: ids.sub, pid: "p-s1", kind: "SUBSECTION" }, ...ids.blocks.map((id, i) => ({ id, pid: `p-b${i + 1}`, kind: "BLOCK" }))] : [],
    sections: [{ id: sectionId, slot_key: "isi", section_type_key: "chapter", position: 1, filled: 1, payload: null, payload_sha256: "0".repeat(64) }],
    chapters: [{ id: chapterId, doc_section_id: sectionId, identity_id: ids.ch, chapter_key: "bab-1", position: 1, title: { text: "Bab 1" }, content_sha256: "1".repeat(64) }],
    subsections: [{ id: subId, chapter_id: chapterId, identity_id: ids.sub, section_no: 1, title: null, content_sha256: "2".repeat(64) }],
    blocks: texts.map((t, i) => ({ doc_section_id: sectionId, chapter_id: chapterId, subsection_id: subId, identity_id: ids.blocks[i], pid: `p-b${i + 1}`, address: `1.1.${i + 1}`, ordinal: i + 1, para_no: i + 1, type: "paragraph", content: { text: t }, text_plain: t, content_sha256: sha256Hex(t) })),
    legacyBlocks: legacy ? texts.map((t, i) => ({ block_id: `p-b${i + 1}`, address: `1.1.${i + 1}`, ordinal: i + 1, chapter_key: "bab-1", section_no: 1, para_no: i + 1, type: "paragraph", content: { text: t, internal: true }, text_plain: t, content_sha256: sha256Hex(`${t}!`) })) : [],
    contractRecord: refs ? { doc_section_id: sectionId, contract_kind: "agentWorkReport", status: "done", reported_at: 1, refs } : null,
  }
}
function content(tag: string, rows: RevisionRowsInput) {
  return { snapshot: { what: tag, body: `${tag} `.repeat(2500) }, inputSha256: sha256Hex(tag), docRev: "A", change: { what: tag, why: "fixture", impact: "none" }, createdBy: "swarm", rows }
}

let docSeq = 0
async function makeDoc(store: SqliteStudioStore, tv: string, revisions: number, over: { missionFolder?: string; legacy?: boolean; refs?: Array<Record<string, unknown>> } = {}) {
  const ids = { ch: newId(), sub: newId(), blocks: [newId(), newId(), newId()] }
  docSeq++
  const tag = (n: number) => `doc${docSeq} rev${n}`
  const doc = await store.transaction((tx) =>
    store.createDocument(tx, {
      docNumber: `${String(docSeq).padStart(3, "0")}/GSP/KT/X/2026`,
      numberSource: "AGENT",
      title: `Dokumen ${docSeq}`,
      typeCode: "KT",
      classification: "TERBATAS",
      tier: "NOTA",
      templateVersionId: tv,
      createdBy: "swarm",
      missionFolder: over.missionFolder ?? null,
      revision: content(tag(1), rowsFor(ids, tag(1), true, over.legacy === true, over.refs)),
    }),
  )
  for (let n = 2; n <= revisions; n++) {
    await store.transaction((tx) => store.appendRevision(tx, { documentId: doc.id, baseRevisionNo: "latest", ...content(tag(n), rowsFor(ids, tag(n), false, over.legacy === true)) }))
  }
  return doc.id
}

type Ref = { kind: KeepClause; documentId: string; revisionNo: number }

/**
 * A: 20 revisions, owned by mission M, old shape (legacy rows). Revisions 2-9 each carry one reference of a
 * different kind; 1 and 10 carry none; 11-20 are the newest N. B: M's work report (1 revision) citing A rev 6.
 * C: 15 revisions, no mission, no reference: 1-5 are outside the keep-set.
 */
async function fixture(name: string, opts: { deliverables?: boolean } = {}) {
  const store = await openStore(name)
  const tv = (await store.transaction((tx) => store.pinBuiltinVersion(tx, BUILTIN))).id as string
  const M = `2026-11-17_${name}`
  await store.transaction(async (tx) => {
    tx.run("INSERT INTO mission (id, title, type_id, type_version, owner, project_dir, time_created, time_updated) VALUES (?, 't', 'feature-release', 1, 'master-controller', '/p', 1, 1)", [M])
    for (const r of ["1", "2"]) tx.run("INSERT INTO mission_row (mission_id, row_id, phase_id, kind, title, agent, model_tier, size, output, verification, ord, time_created, time_updated) VALUES (?, ?, 'implementation', 'implementation', 'Row', 'coder-execution', 'thinker', 'S', 'o', 'v', ?, 1, 1)", [M, r, Number(r)])
  })
  const A = await makeDoc(store, tv, 20, { missionFolder: M, legacy: true })
  const B = await makeDoc(store, tv, 1, { missionFolder: M, refs: [{ position: 1, rel: "source", target_document_id: A, target_revision_no: 6 }] })
  const C = await makeDoc(store, tv, 15)
  const revId = (doc: string, n: number) => store.transaction(async (tx) => tx.get<{ id: string }>("SELECT id FROM revision WHERE document_id = ? AND revision_no = ?", [doc, n])!.id)
  const r7 = await revId(A, 7)
  const r8 = await revId(A, 8)
  await store.transaction(async (tx) => {
    tx.run("INSERT INTO mission_report (document_id, mission_id, kind, row_id, time_created) VALUES (?, ?, 'row', '1', 1)", [B, M])
    tx.run("INSERT INTO mission_document (mission_id, document_id, revision_no, row_id, time_linked) VALUES (?, ?, 2, '1', 1)", [M, A])
    if (opts.deliverables !== false) {
      tx.run("UPDATE mission_row SET deliverables = ? WHERE mission_id = ? AND row_id = '2'", [JSON.stringify([{ path: `deliverables/${M}/a rev3.pdf`, format: "PDF", docRev: "A", revisionNo: 3, sha256: "d".repeat(64), latest: false, documentId: A }]), M])
    }
    tx.run("INSERT INTO mission_event (mission_id, row_id, actor, verb, detail, time_created) VALUES (?, '1', 'a', 'report', ?, 1)", [M, JSON.stringify({ documentId: A, revisionNo: 4, status: "done" })])
    tx.run("INSERT INTO mission_snapshot (id, mission_id, reason, body, time_created) VALUES (?, ?, 'manual', ?, 1)", [newId(), M, JSON.stringify({ rows: [{ id: "1", reports: [{ documentId: A, revisionNo: 5, kind: "row" }] }] })])
    for (const [rid, ok] of [[r7, false], [r8, true]] as const) {
      const out = newId()
      tx.run("INSERT INTO output_file (id, kind, document_id, revision_id, format, role, rel_path, file_name, bytes, sha256, mime, time_created) VALUES (?, 'document', ?, ?, 'PDF', 'PRIMARY', ?, 'a.pdf', 1, ?, 'application/pdf', 1)", [out, A, rid, `outputs/${out}/a.pdf`, "e".repeat(64)])
      if (ok) tx.run("INSERT INTO output_verification (output_file_id, output_sha256, revision_id, state, checks_version, fail_count, unknown_count, report, report_sha256, verified_by, time_verified) VALUES (?, ?, ?, 'verified', 1, 0, 0, '{}', ?, 'host', 1)", [out, "e".repeat(64), rid, "f".repeat(64)])
    }
    tx.run("INSERT INTO mission_decision (mission_id, decision_id, by, date, text, time_created) VALUES (?, 'C1', 'controller', '2026-11-17', 'Hasil diterima pada revisi 9; Rev A tetap.', 1)", [M])
  })
  const refs: Ref[] = [
    { kind: "mission-document", documentId: A, revisionNo: 2 },
    ...(opts.deliverables !== false ? [{ kind: "row-deliverable" as const, documentId: A, revisionNo: 3 }] : []),
    { kind: "mission-event", documentId: A, revisionNo: 4 },
    { kind: "mission-snapshot", documentId: A, revisionNo: 5 },
    { kind: "doc-ref", documentId: A, revisionNo: 6 },
    { kind: "output", documentId: A, revisionNo: 7 },
    { kind: "verification", documentId: A, revisionNo: 8 },
    { kind: "mission-text", documentId: A, revisionNo: 9 },
    { kind: "latest", documentId: A, revisionNo: 20 },
    { kind: "latest", documentId: B, revisionNo: 1 },
    { kind: "latest", documentId: C, revisionNo: 15 },
    ...Array.from({ length: RETENTION_KEEP_RECENT }, (_, i) => ({ kind: "recent" as const, documentId: A, revisionNo: 11 + i })),
    ...Array.from({ length: RETENTION_KEEP_RECENT }, (_, i) => ({ kind: "recent" as const, documentId: C, revisionNo: 6 + i })),
  ]
  const outside = [
    { documentId: A, revisionNo: 1 },
    ...(opts.deliverables === false ? [{ documentId: A, revisionNo: 3 }] : []),
    { documentId: A, revisionNo: 10 },
    ...[1, 2, 3, 4, 5].map((n) => ({ documentId: C, revisionNo: n })),
  ]
  return { store, M, A, B, C, refs, outside }
}

/** Q-REF of design 04 section 4, extended: per referenced revision the sha of its whole `getRevision` read. */
async function qref(store: SqliteStudioStore, refs: readonly Ref[]) {
  const out: string[] = []
  for (const r of refs) {
    const rev = await store.getRevision(r.documentId, r.revisionNo)
    out.push(`${r.kind}|${r.documentId}|${r.revisionNo}|${rev ? rev.revision.snapshot_sha256 : "MISSING"}|${rev ? rev.blocks.length : -1}|${rev ? rev.legacyBlocks.length : -1}|${rev ? sha256Hex(JSON.stringify(rev)) : "-"}`)
  }
  return out
}
/** The check of the proof: every referenced revision is in the keep-set with the clause of its reference. */
function missingFromKeep(keep: ReturnType<typeof revisionKeepSet>, refs: readonly Ref[]): Ref[] {
  const at = new Map([...keep.values()].map((k) => [`${k.documentId}|${k.revisionNo}`, k]))
  return refs.filter((r) => !at.get(`${r.documentId}|${r.revisionNo}`)?.clauses.includes(r.kind))
}
const reader = (s: SqliteStudioStore) => (s as unknown as { q: () => Parameters<typeof revisionKeepSet>[0] }).q()
const revCount = (db: SqliteDb) => Number(db.get<{ n: number }>("SELECT count(*) AS n FROM revision")!.n)
function schemaDump(db: SqliteDb): string {
  return db
    .all<{ type: string; name: string; sql: string | null }>("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .map((r) => `${r.type}|${r.name}|${r.sql ?? ""}`)
    .join("\n")
}
function familyCounts(db: SqliteDb) {
  return Object.fromEntries(["revision", "doc_section", "doc_chapter", "doc_subsection", "doc_block", "block", "contract_record", "doc_ref", "output_file", "output_verification", "revision_prune"].map((t) => [t, Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n)]))
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("row 82: migration 0010", () => {
  test("0010 follows 0009 (0011, row 144, follows it), has a reverse step, adds one table and three triggers, keeps revision_immutable", async () => {
    // 1.3.3 row 144: 0011 landed after 0010, so the "last migration" pin moved by one
    expect([MIGRATIONS.at(-2)!.seq, MIGRATIONS.at(-2)!.id]).toEqual([10, MIGRATION_0010_ID])
    expect(MIGRATION_0010_ID > MIGRATION_0009_ID).toBe(true)
    expect(MIGRATIONS.at(-2)!.down).toBe(MIGRATION_0010_DOWN_SQL)
    expect(MIGRATIONS.at(-2)!.downLossSql).toBe(undefined)
    const s = await openStore("schema")
    await closeStore(s)
    const db = rawDb("schema")
    try {
      expect(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('revision', 'revision_prune', 'mission_document') ORDER BY name").map((r) => r.name)).toEqual(["revision_delete_guard", "revision_immutable", "revision_prune_referenced", "revision_prune_unmark"])
      expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'revision_immutable'")!.sql).toContain("BEFORE UPDATE OF id, document_id, revision_no")
      expect(db.all<{ name: string }>("PRAGMA table_info(revision_prune)").map((c) => c.name)).toEqual(["revision_id", "document_id", "revision_no", "rule_version", "time_marked"])
    } finally {
      db.close()
    }
  })

  test("forward, reverse, forward through row 81's runner on a marked store: schema of 0009, revisions untouched, marks recomputed", async () => {
    const f = await fixture("round-trip")
    const mark1 = await f.store.markRevisionsForRetention()
    expect(mark1.marked).toBe(f.outside.length)
    const before = await qref(f.store, f.refs)
    await closeStore(f.store)
    const db = rawDb("round-trip")
    const fresh = openSqlite(":memory:")
    try {
      applyMigrations(fresh, { release: RELEASE, now: clock }, MIGRATIONS.filter((m) => m.seq <= 9))
      const revs = revCount(db)
      const out = revertMigrations(db, { release: RELEASE, now: clock }, MIGRATION_0009_ID)
      expect(out.map((o) => [o.id, o.schemaVersion, o.dataLossRows])).toEqual([["20261117180000_datum_purge_fk_indexes", MIGRATION_0010_ID, 0], [MIGRATION_0010_ID, MIGRATION_0009_ID, 0]]) // 1.3.3 row 144: 0011 is reverted first
      expect(schemaDump(db)).toBe(schemaDump(fresh))
      expect(revCount(db)).toBe(revs)
      expect(db.all<{ id: string }>("SELECT id FROM migration").map((r) => r.id)).not.toContain(MIGRATION_0010_ID)
      expect(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(MIGRATION_0009_ID)
      // without 0010 nothing refuses a delete any more (the state before it); not exercised on data, only on schema
      expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'revision_delete_guard'")).toBe(undefined)
    } finally {
      fresh.close()
      db.close()
    }
    const again = await openStore("round-trip")
    expect(await qref(again, f.refs)).toEqual(before)
    const mark2 = await again.markRevisionsForRetention()
    expect([mark2.marked, mark2.newlyMarked, mark2.unmarked]).toEqual([f.outside.length, f.outside.length, 0])
    await closeStore(again)
  })

  test("a 1.3.2-shaped store (journal at 0008) migrates to 0010 and reads as before; nothing is marked by the migration", async () => {
    const f = await fixture("shape132", { deliverables: false })
    const all = [...f.refs, ...f.outside.map((o) => ({ ...o, kind: "recent" as const }))]
    const before = await qref(f.store, all)
    await closeStore(f.store)
    const db = rawDb("shape132")
    const fresh = openSqlite(":memory:")
    try {
      revertMigrations(db, { release: RELEASE, now: clock }, MIGRATION_0008_ID)
      applyMigrations(fresh, { release: "1.3.2", now: clock }, MIGRATIONS.filter((m) => m.seq <= 8))
      expect(schemaDump(db)).toBe(schemaDump(fresh))
      expect(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(MIGRATION_0008_ID)
    } finally {
      fresh.close()
      db.close()
    }
    const s = await openStore("shape132")
    expect(await qref(s, all)).toEqual(before)
    expect(await s.listMarkedRevisions()).toEqual([])
    await closeStore(s)
    const after = rawDb("shape132")
    try {
      expect(after.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id).slice(-3)).toEqual([MIGRATION_0009_ID, MIGRATION_0010_ID, "20261117180000_datum_purge_fk_indexes"]) // 1.3.3 row 144: + 0011
      expect(familyCounts(after).revision_prune).toBe(0)
    } finally {
      after.close()
    }
  })
})

describe("row 82: keep-set", () => {
  test("every referenced revision is in the keep-set with the clause of its reference; exactly the others are outside", async () => {
    const f = await fixture("keep")
    const keep = revisionKeepSet(reader(f.store))
    expect(missingFromKeep(keep, f.refs)).toEqual([])
    expect(new Set(f.refs.map((r) => r.kind))).toEqual(new Set(KEEP_CLAUSES))
    const all = (await f.store.transaction(async (tx) => tx.all<{ document_id: string; revision_no: number }>("SELECT document_id, revision_no FROM revision ORDER BY document_id, revision_no"))).map((r) => `${r.document_id}|${r.revision_no}`)
    const kept = new Set([...keep.values()].map((k) => `${k.documentId}|${k.revisionNo}`))
    expect(all.filter((x) => !kept.has(x)).sort()).toEqual(f.outside.map((o) => `${o.documentId}|${o.revisionNo}`).sort())
    await closeStore(f.store)
  })

  test("negative control: with one reference source removed the proof check names exactly that revision", async () => {
    const f = await fixture("negative")
    await f.store.transaction(async (tx) => tx.run("DELETE FROM mission_event WHERE mission_id = ?", [f.M]))
    const lost = missingFromKeep(revisionKeepSet(reader(f.store)), f.refs)
    expect(lost).toEqual([{ kind: "mission-event", documentId: f.A, revisionNo: 4 }])
    await closeStore(f.store)
  })

  test("mission prose: revision numbers after rev / revisi / revision / revisionNo, lists and ranges; a revision letter names none", () => {
    expect(revisionNumbersIn("lihat rev 12 dan revisi ke-3")).toEqual([3, 12])
    expect(revisionNumbersIn("Rev A dikirim; revisions 4, 6 dan 8")).toEqual([4, 6, 8])
    expect(revisionNumbersIn("revisi 3-5 serta rev 7 s.d. 9")).toEqual([3, 4, 5, 7, 8, 9])
    expect(revisionNumbersIn('{"revisionNo": 21} review 5 previous 6')).toEqual([21])
    expect(revisionNumbersIn("tanpa nomor")).toEqual([])
  })

  test("N and the window can only be made stricter than C6", async () => {
    const f = await fixture("floor")
    await refused(f.store.markRevisionsForRetention({ keepRecent: RETENTION_KEEP_RECENT - 1 }), "SCHEMA_INVALID")
    await refused(f.store.purgeMarkedRevisions({ backupFile: join(RUN, "floor.bak"), requestedBy: "owner", windowDays: RETENTION_SOFT_WINDOW_DAYS - 1 }), "SCHEMA_INVALID")
    await closeStore(f.store)
  })
})

describe("row 82: mark, purge, restore (the proof test)", () => {
  test("mark is idempotent, keeps marked revisions readable, and un-marks a revision that became referenced", async () => {
    const f = await fixture("mark")
    const before = await qref(f.store, f.refs)
    const oldReads = await qref(f.store, f.outside.map((o) => ({ ...o, kind: "recent" as const })))
    const m1 = await f.store.markRevisionsForRetention()
    expect([m1.revisions, m1.kept, m1.marked, m1.newlyMarked, m1.unmarked]).toEqual([36, 36 - f.outside.length, f.outside.length, f.outside.length, 0])
    const list1 = await f.store.listMarkedRevisions()
    expect(list1.every((m) => !m.purgeable && m.purgeableFrom === m.timeMarked + RETENTION_SOFT_WINDOW_DAYS * DAY)).toBe(true)
    now += DAY
    const m2 = await f.store.markRevisionsForRetention()
    expect([m2.marked, m2.newlyMarked, m2.unmarked]).toEqual([f.outside.length, 0, 0])
    expect(await f.store.listMarkedRevisions()).toEqual(list1) // a second run does not restart a window
    expect(await qref(f.store, f.refs)).toEqual(before)
    expect(await qref(f.store, f.outside.map((o) => ({ ...o, kind: "recent" as const })))).toEqual(oldReads) // marked = still readable
    // a mission link arriving later removes the mark at once (trigger); an event reference on the next mark run
    await f.store.transaction(async (tx) => tx.run("INSERT INTO mission_document (mission_id, document_id, revision_no, row_id, time_linked) VALUES (?, ?, 10, '1', 1)", [f.M, f.A]))
    expect((await f.store.listMarkedRevisions()).some((m) => m.documentId === f.A && m.revisionNo === 10)).toBe(false)
    await f.store.transaction(async (tx) => tx.run("INSERT INTO mission_event (mission_id, actor, verb, detail, time_created) VALUES (?, 'a', 'report', ?, 1)", [f.M, JSON.stringify({ documentId: f.C, revisionNo: 1 })]))
    const m3 = await f.store.markRevisionsForRetention()
    expect([m3.marked, m3.newlyMarked, m3.unmarked]).toEqual([f.outside.length - 2, 0, 1])
    await closeStore(f.store)
  })

  test("database guards: an unmarked or referenced revision cannot be deleted or marked; updates stay refused", async () => {
    const f = await fixture("guards")
    await f.store.markRevisionsForRetention()
    await refused(f.store.transaction(async (tx) => tx.run("DELETE FROM revision WHERE document_id = ? AND revision_no = 12", [f.A])), "REVISION_IMMUTABLE")
    await refused(f.store.transaction(async (tx) => tx.run("INSERT INTO revision_prune (revision_id, document_id, revision_no, rule_version, time_marked) SELECT id, document_id, revision_no, 1, 1 FROM revision WHERE document_id = ? AND revision_no = 2", [f.A])), "REVISION_IMMUTABLE")
    await refused(f.store.transaction(async (tx) => tx.run("INSERT INTO revision_prune (revision_id, document_id, revision_no, rule_version, time_marked) SELECT id, document_id, revision_no, 1, 1 FROM revision WHERE document_id = ? AND revision_no = 3", [f.A])), "REVISION_IMMUTABLE")
    await refused(f.store.transaction(async (tx) => tx.run("UPDATE revision SET snapshot = '{}' WHERE document_id = ? AND revision_no = 1", [f.A])), "REVISION_IMMUTABLE")
    // a marked revision whose reference arrives without the mark being removed (an event) is still refused by the purge
    await f.store.transaction(async (tx) => tx.run("INSERT INTO mission_event (mission_id, actor, verb, detail, time_created) VALUES (?, 'a', 'report', ?, 1)", [f.M, JSON.stringify({ documentId: f.A, revisionNo: 1 })]))
    now += (RETENTION_SOFT_WINDOW_DAYS + 1) * DAY
    const file = join(RUN, "guards-backup.sqlite")
    const d = await refused(f.store.purgeMarkedRevisions({ backupFile: file, requestedBy: "owner" }), "REVISION_IMMUTABLE")
    expect([d.reason, d.total]).toEqual(["marked-revision-referenced", 1])
    expect(existsSync(file)).toBe(false)
    await closeStore(f.store)
  })

  test("proof: after mark and purge every referenced revision is present and identical; the others leave only after the window, through purge, and the backup restores them", async () => {
    const f = await fixture("proof")
    const refsBefore = await qref(f.store, f.refs)
    const outsideRefs = f.outside.map((o) => ({ ...o, kind: "recent" as const }))
    const outsideBefore = await qref(f.store, outsideRefs)
    await f.store.markRevisionsForRetention()
    expect(await qref(f.store, f.refs)).toEqual(refsBefore)

    // inside the window: nothing is due, no file is written, nothing leaves
    const early = join(RUN, "proof-early.sqlite")
    const r0 = await f.store.purgeMarkedRevisions({ backupFile: early, requestedBy: "owner" })
    expect([r0.purged, r0.remainingMarked, existsSync(early)]).toEqual([0, f.outside.length, false])
    expect(await qref(f.store, outsideRefs)).toEqual(outsideBefore)

    // backup target guards
    await refused(f.store.purgeMarkedRevisions({ backupFile: join(f.store.rootDir, "in-store.sqlite"), requestedBy: "owner" }), "PATH_OUTSIDE_ROOT")
    await refused(f.store.purgeMarkedRevisions({ backupFile: "relative.sqlite", requestedBy: "owner" }), "PATH_OUTSIDE_ROOT")
    await refused(f.store.purgeMarkedRevisions({ backupFile: join(RUN, "proof-early.sqlite"), requestedBy: "" }), "SCHEMA_INVALID")

    now += (RETENTION_SOFT_WINDOW_DAYS + 1) * DAY
    const raw = () => rawDb("proof")
    const db0 = raw()
    const countsBefore = familyCounts(db0)
    const pagesBefore = { page_count: Number(db0.get<{ page_count: number }>("PRAGMA page_count")!.page_count), freelist_count: Number(db0.get<{ freelist_count: number }>("PRAGMA freelist_count")!.freelist_count) }
    db0.close()
    const file = join(RUN, "proof-backup.sqlite")
    const res = await f.store.purgeMarkedRevisions({ backupFile: file, requestedBy: "owner (row 82 test)" })
    expect(res.purged).toBe(f.outside.length)
    expect(res.revisions.map((r) => `${r.documentId}|${r.revisionNo}`).sort()).toEqual(f.outside.map((o) => `${o.documentId}|${o.revisionNo}`).sort())
    expect(res.remainingMarked).toBe(0)
    expect(statSync(file).size).toBe(res.backup!.bytes)
    expect(sha256Hex(readFileSync(file))).toBe(res.backup!.sha256)

    // (a) the referenced revisions are identical, (b) none is missing, (c) each still opens with its block counts
    const refsAfter = await qref(f.store, f.refs)
    expect(refsAfter).toEqual(refsBefore)
    expect(refsAfter.filter((x) => x.includes("MISSING"))).toEqual([])
    for (const o of f.outside) expect(await f.store.getRevision(o.documentId, o.revisionNo)).toBeNull()

    const db1 = raw()
    const countsAfter = familyCounts(db1)
    const pagesAfter = { page_count: Number(db1.get<{ page_count: number }>("PRAGMA page_count")!.page_count), freelist_count: Number(db1.get<{ freelist_count: number }>("PRAGMA freelist_count")!.freelist_count) }
    expect(db1.all("PRAGMA foreign_key_check")).toEqual([])
    expect(db1.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok")
    db1.close()
    expect(countsAfter.revision).toBe(countsBefore.revision! - f.outside.length)
    for (const t of ["doc_section", "doc_chapter", "doc_subsection", "doc_block", "block"] as const) expect(countsBefore[t]! - countsAfter[t]!).toBe(res.rows[t])
    expect([countsAfter.output_file, countsAfter.output_verification, countsAfter.doc_ref]).toEqual([countsBefore.output_file, countsBefore.output_verification, countsBefore.doc_ref])
    console.log(`[row82] purge rows ${JSON.stringify(res.rows)} snapshotBytes=${res.snapshotBytes} backupBytes=${res.backup!.bytes}`)
    console.log(`[row82] counts before ${JSON.stringify(countsBefore)} after ${JSON.stringify(countsAfter)}`)
    console.log(`[row82] pages before ${JSON.stringify(pagesBefore)} after ${JSON.stringify(pagesAfter)} (no VACUUM in row 82)`)
    expect((await f.store.revisionRetentionLog()).map((e) => [e.action, e.revisions, e.backupSha256])).toEqual([["purge", f.outside.length, res.backup!.sha256]])

    // the backup reads back on its own
    const back = readRevisionBackup(file)
    expect(back.revisions.length).toBe(f.outside.length)
    expect(back.rows).toEqual(res.rows)

    // a second purge has nothing left to do
    expect((await f.store.purgeMarkedRevisions({ backupFile: join(RUN, "proof-second.sqlite"), requestedBy: "owner" })).purged).toBe(0)

    // restore: the purged revisions come back identical, the referenced ones are unchanged, a repeat restores nothing
    const restored = await f.store.restorePurgedRevisions({ backupFile: file, requestedBy: "owner (row 82 test)" })
    expect([restored.restored, restored.alreadyPresent, restored.renumberedBlocks]).toEqual([f.outside.length, 0, 0])
    expect(await qref(f.store, outsideRefs)).toEqual(outsideBefore)
    expect(await qref(f.store, f.refs)).toEqual(refsBefore)
    // the search index follows the restore (doc_block_fts triggers): old text of a restored revision is found by revision
    expect((await f.store.searchParagraphs({ q: "paragraf", documentId: f.C, revisionNo: 1 })).hits.length).toBeGreaterThan(0)
    const again = await f.store.restorePurgedRevisions({ backupFile: file, requestedBy: "owner" })
    expect([again.restored, again.alreadyPresent]).toEqual([0, f.outside.length])
    const db2 = raw()
    expect(familyCounts(db2)).toEqual({ ...countsBefore, revision_prune: 0 })
    expect(db2.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok")
    db2.close()
    await closeStore(f.store)
  })

  test("a damaged backup is refused on read; a backup of another store is refused on restore", async () => {
    const f = await fixture("damaged")
    await f.store.markRevisionsForRetention()
    now += (RETENTION_SOFT_WINDOW_DAYS + 1) * DAY
    const file = join(RUN, "damaged-backup.sqlite")
    await f.store.purgeMarkedRevisions({ backupFile: file, requestedBy: "owner", limit: 2 })
    expect((await f.store.listMarkedRevisions()).length).toBe(f.outside.length - 2)
    const w = openSqlite(file)
    w.run("UPDATE doc_block SET text_plain = 'changed' WHERE rowid = (SELECT min(rowid) FROM doc_block)")
    w.close()
    await refused(() => readRevisionBackup(file), "INTEGRITY_MISMATCH")
    await refused(f.store.restorePurgedRevisions({ backupFile: file, requestedBy: "owner" }), "INTEGRITY_MISMATCH")
    const other = await fixture("other-store")
    await other.store.markRevisionsForRetention()
    now += (RETENTION_SOFT_WINDOW_DAYS + 1) * DAY
    const file2 = join(RUN, "other-backup.sqlite")
    await other.store.purgeMarkedRevisions({ backupFile: file2, requestedBy: "owner", limit: 1 })
    await refused(f.store.restorePurgedRevisions({ backupFile: file2, requestedBy: "owner" }), "INTEGRITY_MISMATCH")
    await closeStore(other.store)
    await closeStore(f.store)
  })
})

describe("row 82: operator-only", () => {
  test("no caller outside src/store/ under src/ or vendor/scripts/; no VACUUM, no timer in the retention module", () => {
    const names = /\b(markRevisionsForRetention|purgeMarkedRevisions|restorePurgedRevisions|restoreRevisionBackup|markRevisions)\s*\(/
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p)
          continue
        }
        if (!/\.(ts|tsx|js|mjs)$/.test(e.name) || /\.test\.ts$/.test(e.name)) continue
        const rel = relative(PKG, p)
        if (rel.startsWith(join("src", "store") + "/")) continue
        if (names.test(readFileSync(p, "utf8"))) hits.push(rel)
      }
    }
    walk(join(PKG, "src"))
    walk(join(PKG, "vendor", "scripts"))
    expect(hits).toEqual([])
    const code = readFileSync(join(HERE, "revision-retention.ts"), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join("\n")
    expect(/VACUUM|setInterval|setTimeout/.test(code)).toBe(false)
  })
})
