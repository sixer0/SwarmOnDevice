/**
 * Swarm 1.3.3 row 144 (ST-11, finding of row 83 section 5.4): migration 0011, four indexes on the child columns of
 * the foreign keys that cascade from a deleted revision.
 * Fixture stores only, under ROW144_133_TEST_DIR or the OS temp folder; the live store is never opened.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import type { SqliteDb } from "./driver-types.ts"
import { canonicalJson, newId, sha256Hex } from "./ids.ts"
import { applyMigrations, MIGRATION_REVERSALS_KEY, MIGRATIONS, latestSchemaId, RESERVED_MIGRATIONS, revertMigration, revertMigrations } from "./migrations/index.ts"
import { MIGRATION_0008_ID } from "./migrations/0008_datum_decision_provenance.ts"
import { MIGRATION_0010_ID } from "./migrations/0010_datum_revision_retention.ts"
import { MIGRATION_0011_ID, MIGRATION_0011_INDEXES, MIGRATION_0011_SQL } from "./migrations/0011_datum_purge_fk_indexes.ts"
import { MIGRATION_0011_DOWN_SQL } from "./migrations/0011_datum_purge_fk_indexes.down.ts"
import { pinBuiltinMissionTypes } from "./mission/index.ts"
import { SqliteStudioStore } from "./studio-store.ts"
import type { BuiltinTemplateFile, RevisionRowsInput } from "./types.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const BASE = process.env.ROW144_133_TEST_DIR ?? join(tmpdir(), "row144-133-purge-fk-indexes-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const RELEASE = "1.3.3"
let now = 1_800_000_000_000
const clock = () => ++now
const UP_TO_8 = MIGRATIONS.filter((m) => m.seq <= 8)
const UP_TO_10 = MIGRATIONS.filter((m) => m.seq <= 10)
const opened: SqliteStudioStore[] = []
afterAll(async () => {
  for (const s of opened) await s.close()
})

/** Index name -> [table, column]: what row 83 named (section 5.4) and the lookup each serves. */
const EXPECTED: Record<(typeof MIGRATION_0011_INDEXES)[number], [string, string]> = {
  doc_block_chapter_idx: ["doc_block", "chapter_id"],
  doc_block_doc_section_idx: ["doc_block", "doc_section_id"],
  doc_subsection_revision_idx: ["doc_subsection", "revision_id"],
  render_job_revision_idx: ["render_job", "revision_id"],
}

function rawDb(name: string): SqliteDb {
  const dir = join(RUN, name)
  mkdirSync(dir, { recursive: true })
  const db = openSqlite(join(dir, "datum-studio.sqlite"))
  db.exec("PRAGMA foreign_keys = ON")
  return db
}
function schema(db: SqliteDb): string {
  return db
    .all<{ type: string; name: string; tbl_name: string; sql: string | null }>("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .map((r) => `${r.type}|${r.name}|${r.tbl_name}|${r.sql ?? ""}`)
    .join("\n")
}
const journal = (db: SqliteDb) => db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id)
const meta = (db: SqliteDb) => Object.fromEntries(db.all<{ key: string; value: string }>("SELECT key, value FROM store_meta ORDER BY key").map((r) => [r.key, r.value]))
const healthy = (db: SqliteDb) => [db.all("PRAGMA foreign_key_check").length, db.all<{ integrity_check: string }>("PRAGMA integrity_check").map((x) => x.integrity_check).join()]
const TABLES = ["revision", "doc_section", "doc_chapter", "doc_subsection", "doc_block", "block", "render_job", "mission_row"]
const counts = (db: SqliteDb) => Object.fromEntries(TABLES.map((t) => [t, Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n)]))
/** The four indexes as found: name -> "table(columns)". */
function found(db: SqliteDb): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of MIGRATION_0011_INDEXES) {
    const row = db.get<{ tbl_name: string }>("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ?", [name])
    if (!row) continue
    out[name] = `${row.tbl_name}(${db.all<{ name: string }>(`PRAGMA index_info(${name})`).map((c) => c.name).join(",")})`
  }
  return out
}
/** The query plan of the child lookup SQLite runs per deleted parent row, as one string. */
const plan = (db: SqliteDb, table: string, column: string) =>
  db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = ?`, ["x"]).map((r) => r.detail).join(" / ")

// ── fixture with rows in every table the indexes cover ─────────────────────

const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
const BUILTIN: BuiltinTemplateFile = { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: "a".repeat(64), release: RELEASE }

function rowsFor(ids: { ch: string; sub: string; blocks: string[] }, tag: string, first: boolean): RevisionRowsInput {
  const sectionId = newId()
  const chapterId = newId()
  const subId = newId()
  const texts = [1, 2, 3].map((i) => `${tag} paragraf ${i}`)
  return {
    identities: first ? [{ id: ids.ch, pid: "p-ch1", kind: "CHAPTER" }, { id: ids.sub, pid: "p-s1", kind: "SUBSECTION" }, ...ids.blocks.map((id, i) => ({ id, pid: `p-b${i + 1}`, kind: "BLOCK" }))] : [],
    sections: [{ id: sectionId, slot_key: "isi", section_type_key: "chapter", position: 1, filled: 1, payload: null, payload_sha256: "0".repeat(64) }],
    chapters: [{ id: chapterId, doc_section_id: sectionId, identity_id: ids.ch, chapter_key: "bab-1", position: 1, title: { text: "Bab 1" }, content_sha256: "1".repeat(64) }],
    subsections: [{ id: subId, chapter_id: chapterId, identity_id: ids.sub, section_no: 1, title: null, content_sha256: "2".repeat(64) }],
    blocks: texts.map((t, i) => ({ doc_section_id: sectionId, chapter_id: chapterId, subsection_id: subId, identity_id: ids.blocks[i], pid: `p-b${i + 1}`, address: `1.1.${i + 1}`, ordinal: i + 1, para_no: i + 1, type: "paragraph", content: { text: t }, text_plain: t, content_sha256: sha256Hex(t) })),
    legacyBlocks: [],
    contractRecord: null,
  }
}
const content = (tag: string, rows: RevisionRowsInput) => ({ snapshot: { what: tag }, inputSha256: sha256Hex(tag), docRev: "A", change: { what: tag, why: "fixture", impact: "none" }, createdBy: "swarm", rows })

/** A store opened by the 1.3.3 code with one document of three revisions and a render job on revision 2. */
async function dataStore(name: string): Promise<void> {
  const store = new SqliteStudioStore()
  await store.open(join(RUN, name), { release: RELEASE, agentClock: clock })
  opened.push(store)
  const tv = (await store.transaction((tx) => store.pinBuiltinVersion(tx, BUILTIN))).id as string
  const ids = { ch: newId(), sub: newId(), blocks: [newId(), newId(), newId()] }
  const doc = await store.transaction((tx) =>
    store.createDocument(tx, { docNumber: "001/GSP/KT/X/2026", numberSource: "AGENT", title: "Dokumen", typeCode: "KT", classification: "TERBATAS", tier: "NOTA", templateVersionId: tv, createdBy: "swarm", missionFolder: null, revision: content("rev1", rowsFor(ids, "rev1", true)) }),
  )
  for (const n of [2, 3]) await store.transaction((tx) => store.appendRevision(tx, { documentId: doc.id, baseRevisionNo: "latest", ...content(`rev${n}`, rowsFor(ids, `rev${n}`, false)) }))
  await store.transaction(async (tx) => {
    const rid = tx.get<{ id: string }>("SELECT id FROM revision WHERE document_id = ? AND revision_no = 2", [doc.id])!.id
    tx.run("INSERT INTO render_job (id, document_id, revision_id, formats, requested_by, time_queued) VALUES (?, ?, ?, '[\"PDF\"]', 'swarm', 1)", [newId(), doc.id, rid])
  })
  await store.close()
  opened.splice(opened.indexOf(store), 1)
}

/** A store as 1.3.2 leaves it: migrations 0001-0008, one mission with two rows. */
function store132(name: string): SqliteDb {
  const db = rawDb(name)
  applyMigrations(db, { release: "1.3.2", now: clock }, UP_TO_8)
  pinBuiltinMissionTypes(db, clock(), () => {})
  db.run("INSERT INTO mission (id, title, type_id, type_version, owner, project_dir, time_created, time_updated) VALUES ('2026-11-16_m', 't', 'feature-release', 1, 'master-controller', '/p', 1, 1)")
  for (const r of ["1", "2"]) {
    db.run("INSERT INTO mission_row (mission_id, row_id, phase_id, kind, title, agent, model_tier, size, output, verification, ord, time_created, time_updated) VALUES ('2026-11-16_m', ?, 'implementation', 'implementation', 'Row', 'coder-execution', 'thinker', 'S', 'o', 'v', ?, 1, 1)", [r, Number(r)])
  }
  return db
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("row 144: migration 0011 (purge foreign-key indexes)", () => {
  test("0011 is registered last with a reverse step that declares no data loss and needs no foreign keys off", () => {
    const m = MIGRATIONS.at(-1)!
    expect([m.seq, m.id, latestSchemaId()]).toEqual([11, MIGRATION_0011_ID, MIGRATION_0011_ID])
    expect(MIGRATION_0011_ID > MIGRATION_0010_ID).toBe(true)
    expect(m.sql).toBe(MIGRATION_0011_SQL)
    expect(m.down).toBe(MIGRATION_0011_DOWN_SQL)
    expect([m.downLossSql, m.foreignKeysOff]).toEqual([undefined, undefined])
    expect(Object.keys(RESERVED_MIGRATIONS)).toEqual([])
    // exactly the four statements, each IF NOT EXISTS / IF EXISTS
    expect(MIGRATION_0011_SQL.match(/CREATE INDEX IF NOT EXISTS/g)!.length).toBe(4)
    expect(MIGRATION_0011_SQL.match(/CREATE /g)!.length).toBe(4)
    expect(MIGRATION_0011_DOWN_SQL.match(/DROP INDEX IF EXISTS/g)!.length).toBe(4)
    expect(MIGRATION_0011_DOWN_SQL.match(/DROP /g)!.length).toBe(4)
  })

  test("the four indexes cover the columns row 83 named, and the child lookups move from a full scan to an index search", () => {
    const db = rawDb("plans")
    try {
      applyMigrations(db, { release: RELEASE, now: clock }, UP_TO_10)
      expect(found(db)).toEqual({})
      for (const [table, column] of Object.values(EXPECTED)) expect(plan(db, table, column)).toMatch(/^SCAN /)
      expect(applyMigrations(db, { release: RELEASE, now: clock })).toEqual([MIGRATION_0011_ID])
      expect(found(db)).toEqual(Object.fromEntries(Object.entries(EXPECTED).map(([n, [t, c]]) => [n, `${t}(${c})`])))
      for (const [name, [table, column]] of Object.entries(EXPECTED)) expect(plan(db, table, column)).toBe(`SEARCH ${table} USING COVERING INDEX ${name} (${column}=?)`)
      // each indexed column is the child side of a foreign key with ON DELETE CASCADE
      for (const [table, column] of Object.values(EXPECTED)) {
        const fk = db.all<{ from: string; on_delete: string }>(`PRAGMA foreign_key_list(${table})`).find((f) => f.from === column)
        expect(fk?.on_delete).toBe("CASCADE")
      }
    } finally {
      db.close()
    }
  })

  test("forward, reverse, forward through the runner on a store with data: schema returns each time, no row changes", async () => {
    await dataStore("round-trip")
    const db = rawDb("round-trip")
    try {
      expect(journal(db).at(-1)).toBe(MIGRATION_0011_ID)
      const schema11 = schema(db)
      const rows = counts(db)
      expect(rows.doc_block).toBe(9)
      expect(rows.render_job).toBe(1)
      // a fresh store at 0010 gives the schema the reverse step must return to
      const ref = rawDb("round-trip-ref10")
      applyMigrations(ref, { release: RELEASE, now: clock }, UP_TO_10)
      const schema10 = schema(ref)
      ref.close()

      const out = revertMigration(db, { release: RELEASE, now: clock, id: MIGRATION_0011_ID })
      expect([out.id, out.seq, out.schemaVersion, out.dataLossRows]).toEqual([MIGRATION_0011_ID, 11, MIGRATION_0010_ID, 0])
      expect(schema(db)).toBe(schema10)
      expect(found(db)).toEqual({})
      expect(counts(db)).toEqual(rows)
      expect(meta(db).schema_version).toBe(MIGRATION_0010_ID)
      expect(journal(db)).not.toContain(MIGRATION_0011_ID)
      expect(JSON.parse(meta(db)[MIGRATION_REVERSALS_KEY]!)).toEqual([{ id: MIGRATION_0011_ID, seq: 11, timeReverted: out.timeReverted, release: RELEASE, dataLossRows: 0 }])
      expect(healthy(db)).toEqual([0, "ok"])

      expect(applyMigrations(db, { release: RELEASE, now: clock })).toEqual([MIGRATION_0011_ID])
      expect(schema(db)).toBe(schema11)
      expect(counts(db)).toEqual(rows)
      expect(meta(db).schema_version).toBe(MIGRATION_0011_ID)
      expect(healthy(db)).toEqual([0, "ok"])
      expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1)
    } finally {
      db.close()
    }
  })

  test("a 1.3.2-shaped store migrates forward to 0011 and reverts back to 0008 with the 1.3.3 runner", () => {
    const db = store132("from-132")
    try {
      const schema8 = schema(db)
      const rows = counts(db)
      expect(meta(db).schema_version).toBe(MIGRATION_0008_ID)
      expect(applyMigrations(db, { release: RELEASE, now: clock })).toEqual(MIGRATIONS.filter((m) => m.seq > 8).map((m) => m.id))
      expect(applyMigrations(db, { release: RELEASE, now: clock })).toEqual([])
      expect(meta(db).schema_version).toBe(MIGRATION_0011_ID)
      expect(Object.keys(found(db)).sort()).toEqual([...MIGRATION_0011_INDEXES].sort())
      expect(Object.keys(meta(db))).toEqual(["created_by_release", "schema_version", "store_id"])
      expect(counts(db)).toEqual(rows)
      expect(healthy(db)).toEqual([0, "ok"])

      // the downgrade path of row 81: newest first, 0011, 0010, 0009; no 0009 column carries data
      const steps = revertMigrations(db, { release: RELEASE, now: clock }, MIGRATION_0008_ID)
      expect(steps.map((s) => s.seq)).toEqual([11, 10, 9])
      expect(schema(db)).toBe(schema8)
      expect(journal(db)).toEqual(UP_TO_8.map((m) => m.id).sort())
      // the 1.3.2 runner (0001-0008 only) finds nothing to apply and no unknown id
      expect(applyMigrations(db, { release: "1.3.2", now: clock }, UP_TO_8)).toEqual([])
      expect(healthy(db)).toEqual([0, "ok"])
    } finally {
      db.close()
    }
  })

  test("IF NOT EXISTS: a store where an index of the same name was made by hand migrates without error", () => {
    const db = rawDb("hand-made")
    try {
      applyMigrations(db, { release: RELEASE, now: clock }, UP_TO_10)
      db.exec("CREATE INDEX doc_block_chapter_idx ON doc_block(chapter_id)")
      expect(applyMigrations(db, { release: RELEASE, now: clock })).toEqual([MIGRATION_0011_ID])
      expect(Object.keys(found(db)).length).toBe(4)
    } finally {
      db.close()
    }
  })

  test("a purge-shaped cascade on the fixture deletes the whole family of a revision with the indexes in place", async () => {
    await dataStore("cascade")
    const db = rawDb("cascade")
    try {
      const rid = db.get<{ id: string }>("SELECT id FROM revision WHERE revision_no = 2")!.id
      const before = counts(db)
      // the 0010 delete guard is bypassed here the way a document delete bypasses it: remove the guard on this
      // fixture only, so the cascade itself (what the indexes speed up) is what the test exercises
      db.exec("DROP TRIGGER revision_delete_guard")
      db.run("DELETE FROM revision WHERE id = ?", [rid])
      const after = counts(db)
      expect([before.revision - after.revision, before.doc_section - after.doc_section, before.doc_chapter - after.doc_chapter, before.doc_subsection - after.doc_subsection, before.doc_block - after.doc_block, before.render_job - after.render_job]).toEqual([1, 1, 1, 1, 3, 1])
      expect(healthy(db)).toEqual([0, "ok"])
    } finally {
      db.close()
    }
  })
})
