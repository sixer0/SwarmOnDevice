/**
 * Row 64 tests: versioned template tables (migration 0002) and the document-to-template-version link.
 * Runs under `bun test` and unchanged under Electron's Node (test-harness.node.ts), like store.test.ts.
 * Temp folders: ROW64_TEST_DIR, else ROW30_TEST_DIR, else the OS temp folder. Nothing outside it is written.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import { applyMigrations } from "./migrations/index.ts"
import {
  canonicalJson,
  isStoreError,
  latestSchemaId,
  MIGRATIONS,
  newId,
  sha256Hex,
  SqliteStudioStore,
  TEMPLATE_GUARD_REPORT_MAX_BYTES,
  type BuiltinTemplateFile,
  type RevisionRowsInput,
  type StoreErrorCode,
  type TemplateGuardRecord,
} from "./index.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const BASE = process.env.ROW64_TEST_DIR ?? process.env.ROW30_TEST_DIR ?? join(tmpdir(), "row64-template-store-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const RELEASE = "1.2.0"
const ID_0001 = "20261106000000_datum_studio_init"
const ID_0002 = "20261106120000_datum_template_guard"
/** row 119a: opening the store now also applies 0003 (mission tables only; filtered from `counts`). */
const ID_0003 = "20261107000000_datum_mission"
const ID_0004 = "20261107120000_datum_output_verification" // row 149
const ID_0006 = "20261108120000_datum_mission_autonomous_decision" // row 188: autonomous decision mark
const ID_0007 = "20261112000000_datum_mission_document_link" // 1.2.6 row 86: mission_document link
const ID_0005 = "20261108000000_datum_mission_gsp_tiers" // row 166
const opened: SqliteStudioStore[] = []
let tick = 1_800_000_000_000
const clock = () => ++tick

async function openStore(dir: string) {
  const s = new SqliteStudioStore()
  await s.open(dir, { release: RELEASE, agentClock: clock })
  opened.push(s)
  return s
}

afterAll(async () => {
  for (const s of opened) await s.close()
})

async function expectCode(p: Promise<unknown>, code: StoreErrorCode) {
  try {
    await p
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    return e
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

const SHA = (c: string) => c.repeat(64)
const LINT_SHA = sha256Hex("lint closure as shipped")
function guard(verdict: "pass" | "warn", over: Partial<TemplateGuardRecord> = {}): TemplateGuardRecord {
  return { verdict, skillSha: LINT_SHA, report: { sampleSha256: SHA("5"), checks: [{ id: "DATUM-01", outcome: verdict }], durationMs: 1200 }, ...over }
}

const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
function builtinFile(over: Partial<BuiltinTemplateFile> = {}): BuiltinTemplateFile {
  return { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: SHA("a"), release: RELEASE, ...over }
}

function oneBlockRows(text: string, first: boolean, ids: { ch: string; sub: string; b: string }): RevisionRowsInput {
  const sectionId = newId()
  const chapterId = newId()
  const subId = newId()
  return {
    identities: first
      ? [
          { id: ids.ch, pid: "p-ch1", kind: "CHAPTER" },
          { id: ids.sub, pid: "p-s1", kind: "SUBSECTION" },
          { id: ids.b, pid: "p-b1", kind: "BLOCK" },
        ]
      : [],
    sections: [{ id: sectionId, slot_key: "isi", section_type_key: "chapter", position: 1, filled: 1, payload: null, payload_sha256: SHA("0") }],
    chapters: [{ id: chapterId, doc_section_id: sectionId, identity_id: ids.ch, chapter_key: "bab-1", position: 1, title: { text: "Bab 1" }, content_sha256: SHA("1") }],
    subsections: [{ id: subId, chapter_id: chapterId, identity_id: ids.sub, section_no: 1, title: null, content_sha256: SHA("2") }],
    blocks: [
      {
        doc_section_id: sectionId,
        chapter_id: chapterId,
        subsection_id: subId,
        identity_id: ids.b,
        pid: "p-b1",
        address: "1.1.1",
        ordinal: 1,
        para_no: 1,
        type: "paragraph",
        content: { text },
        text_plain: text,
        content_sha256: sha256Hex(text),
      },
    ],
  }
}
function revContent(what: string, rows: RevisionRowsInput) {
  return { snapshot: { what }, inputSha256: sha256Hex(what), docRev: "A", change: { what, why: "row 64 test", impact: "none" }, createdBy: "swarm", rows }
}

// ── 1. old versions are kept after a new one ─────────────────────────────────

describe("template versions (row 64)", () => {
  test("a new version never changes an old one; documents keep their pinned version", async () => {
    const store = await openStore(join(RUN, "versions"))
    const pin = await store.transaction((tx) => store.pinBuiltinVersion(tx, builtinFile()))
    expect(pin.guard_verdict).toBeNull()
    expect(pin.guard_report).toBeNull()
    expect(pin.guard_skill_sha).toBeNull()

    const v1 = await store.transaction((tx) =>
      store.createUserTemplate(tx, {
        slug: "user-laporan",
        name: "Laporan saya",
        kind: "DOCUMENT",
        createdBy: "swarm",
        baseVersionId: pin.id,
        version: { definition: { cover: { titleSizePt: 24 } }, skeleton: { slots: [{ slotKey: "isi" }] }, changeNote: "copy of nota-dinas", createdBy: "swarm", guard: guard("pass") },
      }),
    )
    const v1Before = await store.getTemplateVersion("user-laporan", 1)
    const v1Json = JSON.stringify(v1Before)
    expect(v1.guard_verdict).toBe("pass")
    expect(v1.guard_skill_sha).toBe(LINT_SHA)
    expect((v1.guard_report as { checks: unknown[] }).checks.length).toBe(1)

    // a document on v1
    const ids = { ch: newId(), sub: newId(), b: newId() }
    const doc = await store.transaction((tx) =>
      store.createDocument(tx, {
        docNumber: "001/GSP/KT/XI/2026",
        numberSource: "AGENT",
        title: "Laporan pada v1",
        typeCode: "KT",
        classification: "TERBATAS",
        tier: "NOTA",
        templateVersionId: v1.id,
        createdBy: "swarm",
        revision: revContent("create", oneBlockRows("isi pertama", true, ids)),
      }),
    )

    const v2 = await store.transaction((tx) =>
      store.addTemplateVersion(tx, { slug: "user-laporan", baseVersionNo: 1, definition: { cover: { titleSizePt: 26 } }, changeNote: "cover title 26 pt", createdBy: "claude", guard: guard("warn") }),
    )
    const v3 = await store.transaction((tx) => store.addTemplateVersion(tx, { slug: "user-laporan", baseVersionNo: 2, definition: { cover: { titleSizePt: 28 } }, changeNote: "no guard", createdBy: "swarm" }))
    expect([v2.version_no, v3.version_no]).toEqual([2, 3])
    expect(v2.base_version_id).toBe(v1.id)
    expect(v3.base_version_id).toBe(v2.id)
    expect(v3.guard_verdict).toBeNull()

    // v1 is byte-for-byte what it was (definition, sha, guard columns)
    const v1After = await store.getTemplateVersion("user-laporan", 1)
    expect(JSON.stringify(v1After)).toBe(v1Json)
    expect(v1After!.definition_sha256).toBe(sha256Hex(canonicalJson({ cover: { titleSizePt: 24 } })))
    expect((v1After!.definition as { cover: { titleSizePt: number } }).cover.titleSizePt).toBe(24)
    expect((await store.getTemplateVersion("user-laporan"))!.version_no).toBe(3)

    // the document keeps v1 until it is moved; the move is a new revision, the old one keeps v1
    expect((await store.getRevision(doc.id, "latest"))!.revision.template_version_id).toBe(v1.id)
    await store.transaction((tx) => store.appendRevision(tx, { documentId: doc.id, baseRevisionNo: 1, templateVersionId: v2.id, ...revContent("move to v2", oneBlockRows("isi kedua", false, ids)) }))
    expect((await store.getRevision(doc.id, 1))!.revision.template_version_id).toBe(v1.id)
    expect((await store.getRevision(doc.id, 2))!.revision.template_version_id).toBe(v2.id)
    expect((await store.getDocument(doc.id))!.template).toEqual({ slug: "user-laporan", origin: "user", version_no: 2 })

    // full history with the link counts
    const list = await store.listTemplateVersions("user-laporan")
    expect(list.map((v) => [v.version_no, v.guard_verdict, v.revision_count, v.document_count])).toEqual([
      [1, "pass", 1, 1],
      [2, "warn", 1, 1],
      [3, null, 0, 0],
    ])
    expect(list.map((v) => v.change_note)).toEqual(["copy of nota-dinas", "cover title 26 pt", "no guard"])
    expect(list[0]!.skeleton_sha256).toBe(sha256Hex(canonicalJson({ slots: [{ slotKey: "isi" }] })))
    expect((await store.listTemplateVersions("nota-dinas")).map((v) => [v.version_no, v.guard_verdict])).toEqual([[1, null]])
    expect(await store.listTemplateVersions("user-nope")).toEqual([])
    // archive hides the template from the list, never its versions
    await store.transaction((tx) => store.setTemplateArchived(tx, "user-laporan", true))
    expect((await store.listTemplateVersions("user-laporan")).length).toBe(3)
  })

  test("guard columns are immutable and validated; builtin pins store NULL", async () => {
    const store = await openStore(join(RUN, "guard"))
    const pin = await store.transaction((tx) => store.pinBuiltinVersion(tx, { ...builtinFile(), guard: guard("pass") } as BuiltinTemplateFile))
    expect(pin.guard_verdict).toBeNull()
    const v1 = await store.transaction((tx) =>
      store.createUserTemplate(tx, { slug: "user-g", name: "g", kind: "DOCUMENT", createdBy: "swarm", version: { definition: { a: 1 }, changeNote: "v1", createdBy: "swarm", guard: guard("pass") } }),
    )
    // templates spec §8 row 64 check (2): an UPDATE of a guard column is refused by the 0001 trigger
    await expectCode(store.transaction(async (tx) => tx.run("UPDATE template_version SET guard_verdict = 'warn' WHERE id = ?", [v1.id])), "TEMPLATE_VERSION_IMMUTABLE")
    await expectCode(store.transaction(async (tx) => tx.run("UPDATE template_version SET guard_verdict = 'pass' WHERE id = ?", [pin.id])), "TEMPLATE_VERSION_IMMUTABLE")
    await expectCode(store.transaction(async (tx) => tx.run("UPDATE template_version SET guard_report = NULL WHERE id = ?", [v1.id])), "TEMPLATE_VERSION_IMMUTABLE")
    // TS validation: all three parts or none, verdict pass|warn, sha256 hex, report ≤64 KiB
    const add = (g: unknown) =>
      store.transaction((tx) => store.addTemplateVersion(tx, { slug: "user-g", baseVersionNo: 1, definition: { a: 2 }, changeNote: "x", createdBy: "swarm", guard: g as TemplateGuardRecord }))
    await expectCode(add(guard("reject" as "pass")), "SCHEMA_INVALID")
    await expectCode(add(guard("pass", { skillSha: "abc" })), "SCHEMA_INVALID")
    await expectCode(add(guard("pass", { skillSha: SHA("A") })), "SCHEMA_INVALID")
    await expectCode(add(guard("pass", { report: null })), "SCHEMA_INVALID")
    await expectCode(add(guard("pass", { report: "text" })), "SCHEMA_INVALID")
    await expectCode(add(guard("pass", { report: { pad: "x".repeat(TEMPLATE_GUARD_REPORT_MAX_BYTES) } })), "SCHEMA_INVALID")
    // the schema CHECKs hold even for a raw insert that skips the TS checks
    const raw = (verdict: string, sha: string) =>
      store.transaction(async (tx) =>
        tx.run(
          `INSERT INTO template_version (id, template_id, version_no, definition, definition_sha256, overrides, resolved_params, params_sha256,
             role_formats, section_plan, assets, provenance, change_note, created_by, time_created, guard_verdict, guard_skill_sha)
           SELECT ?, template_id, 99, '{}', ?, '{}', '{}', 'p', '{}', '[]', '[]', '{}', 'raw', 'test', 1, ?, ? FROM template_version WHERE id = ?`,
          [newId(), SHA("c"), verdict, sha, v1.id],
        ),
      )
    await expectCode(raw("reject", LINT_SHA), "SCHEMA_INVALID")
    await expectCode(raw("pass", "short"), "SCHEMA_INVALID")
    // nothing failed half-way: still exactly v1
    expect((await store.listTemplateVersions("user-g")).map((v) => v.version_no)).toEqual([1])
    const ok = await add(guard("warn"))
    expect([ok.version_no, ok.guard_verdict]).toEqual([2, "warn"])
  })
})

// ── 2. an existing 0001 store with documents migrates, counts unchanged ──────

/** All non-FTS-shadow tables and their row counts (row 119a: the 0003 mission_* tables are left out). */
function counts(file: string): Record<string, number> {
  const db = openSqlite(file, { readonly: true })
  try {
    const names = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'doc_block_fts_%' AND name NOT LIKE 'mission%' AND name <> 'output_verification' ORDER BY name").map((r) => r.name)
    return Object.fromEntries(names.map((n) => [n, Number(db.get<{ n: number }>(`SELECT count(*) AS n FROM "${n}"`)!.n)]))
  } finally {
    db.close()
  }
}

const V0001_COLS =
  "id, template_id, version_no, base_version_id, definition, definition_sha256, overrides, resolved_params, params_sha256, role_formats, section_plan, assets, provenance, skeleton, skeleton_sha256, change_note, created_by, time_created"
function contentSha(file: string): { template_version: string; revision: string; document: string } {
  const db = openSqlite(file, { readonly: true })
  try {
    const h = (sql: string) => sha256Hex(JSON.stringify(db.all(sql)))
    return {
      template_version: h(`SELECT ${V0001_COLS} FROM template_version ORDER BY id`),
      revision: h("SELECT * FROM revision ORDER BY id"),
      document: h("SELECT * FROM document ORDER BY id"),
    }
  } finally {
    db.close()
  }
}

/** A 0001-only store, written with the 0001 runner and plain SQL (no 0002 code involved). */
function build0001Store(dir: string): { file: string; docIds: string[] } {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, "datum-studio.sqlite")
  const db = openSqlite(file)
  const docIds: string[] = []
  try {
    db.get("PRAGMA journal_mode = WAL")
    db.exec("PRAGMA foreign_keys = ON")
    expect(applyMigrations(db, { release: "1.2.0-pre64", now: clock }, MIGRATIONS.filter((m) => m.seq === 1))).toEqual([ID_0001])
    const t0 = clock()
    const tpl = (id: string, slug: string, origin: string, latest: number) =>
      db.run("INSERT INTO template (id, slug, origin, name, kind, latest_version_no, created_by, time_created, time_updated) VALUES (?, ?, ?, ?, 'DOCUMENT', ?, 'swarm', ?, ?)", [id, slug, origin, slug, latest, t0, t0])
    const ver = (id: string, templateId: string, no: number, base: string | null, def: unknown) =>
      db.run(
        `INSERT INTO template_version (id, template_id, version_no, base_version_id, definition, definition_sha256, overrides, resolved_params, params_sha256,
           role_formats, section_plan, assets, provenance, change_note, created_by, time_created)
         VALUES (?, ?, ?, ?, ?, ?, '{}', '{}', ?, '{}', '[]', '[]', '{"origin":"test"}', ?, 'swarm', ?)`,
        [id, templateId, no, base, JSON.stringify(def), sha256Hex(canonicalJson(def)), sha256Hex("{}"), `v${no}`, t0],
      )
    const tB = newId()
    const tU = newId()
    const vB1 = newId()
    const vU1 = newId()
    const vU2 = newId()
    tpl(tB, "nota-dinas", "builtin", 1)
    tpl(tU, "user-lama", "user", 2)
    ver(vB1, tB, 1, null, DEF)
    ver(vU1, tU, 1, vB1, { a: 1 })
    ver(vU2, tU, 2, vU1, { a: 2 })
    const doc = (templateId: string, n: number, revs: string[]) => {
      const id = newId()
      docIds.push(id)
      db.run(
        "INSERT INTO document (id, doc_number, doc_number_safe, number_source, title, type_code, classification, tier, template_id, current_revision_no, created_by, time_created, time_updated) VALUES (?, ?, ?, 'AGENT', ?, 'KT', 'TERBATAS', 'NOTA', ?, ?, 'swarm', ?, ?)",
        [id, `00${n}/GSP/KT/XI/2026`, `00${n}-GSP-KT-XI-2026`, `Dokumen ${n}`, templateId, revs.length, t0, t0],
      )
      revs.forEach((tv, i) =>
        db.run(
          `INSERT INTO revision (id, document_id, revision_no, parent_revision_no, template_version_id, snapshot, snapshot_sha256, input_sha256, doc_rev,
             change_what, change_why, change_impact, created_by, time_created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'A', 'w', 'y', 'i', 'swarm', ?)`,
          [newId(), id, i + 1, i === 0 ? null : i, tv, JSON.stringify({ n, rev: i + 1 }), SHA("d"), SHA("e"), t0 + i],
        ),
      )
    }
    doc(tU, 1, [vU1, vU2])
    doc(tB, 2, [vB1])
    doc(tU, 3, [vU1])
  } finally {
    db.close()
  }
  return { file, docIds }
}

describe("migration 0002 on an existing 0001 store (row 64)", () => {
  test("0001 store with 3 documents / 4 revisions migrates; counts and 0001 contents unchanged; new columns NULL", async () => {
    const dir = join(RUN, "upgrade")
    const { file, docIds } = build0001Store(dir)
    const before = counts(file)
    const shaBefore = contentSha(file)
    {
      const db = openSqlite(file, { readonly: true })
      const cols = db.all<{ name: string }>("PRAGMA table_info(template_version)").map((r) => r.name)
      expect(cols.includes("guard_verdict")).toBe(false)
      expect(db.all<{ id: string }>("SELECT id FROM migration").map((r) => r.id)).toEqual([ID_0001])
      db.close()
    }
    expect([before.document, before.revision, before.template, before.template_version]).toEqual([3, 4, 2, 3])

    const store = await openStore(dir)
    await store.close()
    const after = counts(file)
    const shaAfter = contentSha(file)
    console.log(`[row64] 0001 -> 0002 counts before ${JSON.stringify(before)}`)
    console.log(`[row64] 0001 -> 0002 counts after  ${JSON.stringify(after)}`)
    expect({ ...after, migration: after.migration! - 6 }).toEqual(before) // row 149: + 0004, row 166: + 0005, row 188: + 0006, 1.2.6 row 86: + 0007
    expect(shaAfter).toEqual(shaBefore)

    const db = openSqlite(file, { readonly: true })
    try {
      expect(db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id)).toEqual([ID_0001, ID_0002, ID_0003, ID_0004, ID_0005, ID_0006, ID_0007])
      expect(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")!.value).toBe(latestSchemaId())
      expect(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'created_by_release'")!.value).toBe("1.2.0-pre64")
      expect(Number(db.get<{ n: number }>("SELECT count(*) AS n FROM template_version WHERE guard_verdict IS NOT NULL OR guard_report IS NOT NULL OR guard_skill_sha IS NOT NULL")!.n)).toBe(0)
      expect(db.get<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'template_version_guard_verdict'")!.name).toBe("template_version_guard_verdict")
      expect(db.get<{ integrity_check: string }>("PRAGMA integrity_check")!.integrity_check).toBe("ok")
      expect(db.all("PRAGMA foreign_key_check")).toEqual([])
    } finally {
      db.close()
    }

    // reopen: nothing applied again; the migrated store reads and writes through the API
    const again = await openStore(dir)
    expect((await again.listTemplateVersions("user-lama")).map((v) => [v.version_no, v.guard_verdict, v.revision_count, v.document_count])).toEqual([
      [1, null, 2, 2],
      [2, null, 1, 1],
    ])
    expect((await again.getDocument(docIds[0]!))!.template).toEqual({ slug: "user-lama", origin: "user", version_no: 2 })
    const v3 = await again.transaction((tx) => again.addTemplateVersion(tx, { slug: "user-lama", baseVersionNo: 2, definition: { a: 3 }, changeNote: "after 0002", createdBy: "swarm", guard: guard("pass") }))
    expect([v3.version_no, v3.guard_verdict]).toEqual([3, "pass"])
    await again.close()
    expect(counts(file).migration).toBe(7) // row 149: + 0004, row 166: + 0005, row 188: + 0006, 1.2.6 row 86: + 0007
  })
})
