/**
 * Row 30 store tests. Runs under `bun test` (bun:sqlite) and unchanged under Electron's Node
 * (node:sqlite, via test-harness.node.ts) per spec §2.3 item 3.
 * Temp folders: ROW30_TEST_DIR, else the OS temp folder. Nothing outside it is written.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { openSqlite } from "#sqlite"
import {
  assertFts5,
  canonicalJson,
  docNumberSafe,
  isStoreError,
  latestSchemaId,
  MIGRATIONS,
  newId,
  RESERVED_MIGRATIONS,
  sha256Hex,
  SqliteStudioStore,
  translateFtsQuery,
  verifySnapshot,
  type BuiltinTemplateFile,
  type RevisionRowsInput,
  type StoreErrorCode,
  type StoreLogEntry,
} from "./index.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.ROW30_TEST_DIR ?? join(tmpdir(), "row30-store-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const RELEASE = "1.2.0"
const logs: StoreLogEntry[] = []
const opened: SqliteStudioStore[] = []
/** Monotonic test clock: every transaction gets its own ms, so (time_updated, id) order is deterministic. */
let tick = 1_800_000_000_000
const clock = () => ++tick

async function openStore(name: string, extra: Partial<Parameters<SqliteStudioStore["open"]>[1]> = {}) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: RELEASE, log: (e) => logs.push(e), agentClock: clock, ...extra })
  opened.push(s)
  return s
}

async function expectCode(p: Promise<unknown> | (() => unknown), code: StoreErrorCode) {
  try {
    await (typeof p === "function" ? p() : p)
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    return e
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

// ── fixtures ────────────────────────────────────────────────────────────────

const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
function builtinFile(over: Partial<BuiltinTemplateFile> = {}): BuiltinTemplateFile {
  return {
    slug: "nota-dinas",
    name: "Nota Dinas",
    kind: "DOCUMENT",
    versionNo: 1,
    definition: DEF,
    definitionSha256: sha256Hex(canonicalJson(DEF)),
    file: "nota-dinas.json",
    fileSha256: "a".repeat(64),
    release: RELEASE,
    ...over,
  }
}

interface Ids {
  ch: string
  sub: string
  blocks: string[]
}
function idsFor(n: number): Ids {
  return { ch: newId(), sub: newId(), blocks: Array.from({ length: n }, () => newId()) }
}
function rows(ids: Ids, texts: string[], first: boolean, slot = "isi"): RevisionRowsInput {
  const sectionId = newId()
  const chapterId = newId()
  const subId = newId()
  return {
    identities: first
      ? [
          { id: ids.ch, pid: "p-ch1", kind: "CHAPTER" },
          { id: ids.sub, pid: "p-s1", kind: "SUBSECTION" },
          ...ids.blocks.map((id, i) => ({ id, pid: `p-b${i + 1}`, kind: "BLOCK" })),
        ]
      : [],
    sections: [{ id: sectionId, slot_key: slot, section_type_key: "chapter", position: 1, filled: 1, payload: null, payload_sha256: "0".repeat(64) }],
    chapters: [{ id: chapterId, doc_section_id: sectionId, identity_id: ids.ch, chapter_key: "bab-1", position: 1, title: { text: "Bab 1" }, content_sha256: "1".repeat(64) }],
    subsections: [{ id: subId, chapter_id: chapterId, identity_id: ids.sub, section_no: 1, title: null, content_sha256: "2".repeat(64) }],
    blocks: texts.map((t, i) => ({
      doc_section_id: sectionId,
      chapter_id: chapterId,
      subsection_id: subId,
      identity_id: ids.blocks[i],
      pid: `p-b${i + 1}`,
      address: `1.1.${i + 1}`,
      ordinal: i + 1,
      para_no: i + 1,
      type: "paragraph",
      content: { text: t },
      text_plain: t,
      content_sha256: sha256Hex(t),
    })),
  }
}
function content(r: RevisionRowsInput, what: string) {
  return { snapshot: { what }, inputSha256: sha256Hex(what), docRev: "A", change: { what, why: "test", impact: "none" }, createdBy: "swarm", rows: r }
}

let seq = 0
async function makeDoc(store: SqliteStudioStore, tvId: string, texts: string[], over: Record<string, unknown> = {}) {
  const ids = idsFor(Math.max(texts.length, 8))
  seq++
  const doc = await store.transaction((tx) =>
    store.createDocument(tx, {
      docNumber: `${String(seq).padStart(3, "0")}/GSP/KT/X/2026`,
      numberSource: "AGENT",
      title: `Dokumen ${seq}`,
      typeCode: "KT",
      classification: "TERBATAS",
      tier: "NOTA",
      templateVersionId: tvId,
      createdBy: "swarm",
      revision: content(rows(ids, texts, true), `create ${seq}`),
      ...over,
    }),
  )
  return { doc, ids }
}

// ── the shared store ──────────────────────────────────────────────────────────

const store = await openStore("main")
const pinned = await store.transaction((tx) => store.pinBuiltinVersion(tx, builtinFile()))

afterAll(async () => {
  for (const s of opened) await s.close()
})

describe("schema and open", () => {
  test("migrations 0001 + 0002 + 0003 + 0004 apply: 19 tables (incl. FTS5) + journal, triggers, store_meta, pragmas", () => {
    const db = openSqlite(join(RUN, "main", "datum-studio.sqlite"), { readonly: true })
    try {
      const tables = db
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'doc_block_fts_%' AND name NOT LIKE 'mission%' AND name <> 'output_verification' ORDER BY name")
        .map((r) => r.name)
      expect(tables.length).toBe(20)
      expect(tables).toContain("migration")
      expect(tables).toContain("doc_block_fts")
      const triggers = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'mission%' ORDER BY name").map((r) => r.name)
      expect(triggers).toEqual(["doc_block_fts_ad", "doc_block_fts_ai", "doc_block_immutable", "revision_immutable", "template_version_immutable", "template_version_no_delete"])
      // row 64: 0002 adds columns + an index only, so the table and trigger lists above are unchanged
      // row 119a: 0003 adds only mission_* tables and triggers (asserted in mission-store.test.ts), filtered out above
      // row 149: 0004 adds only output_verification + 2 indexes, no trigger (asserted in output-verification.test.ts), filtered out above
      expect(db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id)).toEqual(["20261106000000_datum_studio_init", "20261106120000_datum_template_guard", "20261107000000_datum_mission", "20261107120000_datum_output_verification", "20261108000000_datum_mission_gsp_tiers", "20261108120000_datum_mission_autonomous_decision"])
      const meta = Object.fromEntries(db.all<{ key: string; value: string }>("SELECT key, value FROM store_meta").map((r) => [r.key, r.value]))
      expect(meta.schema_version).toBe(latestSchemaId())
      expect(meta.created_by_release).toBe(RELEASE)
      expect(String(meta.store_id)).toMatch(/^c[a-z0-9]{24}$/)
      expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode).toBe("wal")
      const opts = db.all<{ compile_options: string }>("PRAGMA compile_options").map((r) => r.compile_options)
      expect(opts).toContain("ENABLE_FTS5")
      console.log(`[row30] runtime=${isBun ? "bun" : "node " + process.versions.node + " electron " + (process.versions.electron ?? "-")} driver=${db.driver} sqlite=${db.get<{ v: string }>("select sqlite_version() v")!.v}`)
    } finally {
      db.close()
    }
  })

  test("reopen applies nothing; 0002 is row 64's, 0003 is row 119a's, 0004 is row 149's, nothing stays reserved", async () => {
    await store.close()
    const again = new SqliteStudioStore()
    await again.open(join(RUN, "main"), { release: RELEASE })
    const db = openSqlite(join(RUN, "main", "datum-studio.sqlite"), { readonly: true })
    expect(Number(db.get<{ n: number }>("SELECT count(*) AS n FROM migration")!.n)).toBe(6)
    db.close()
    await again.close()
    await store.open(join(RUN, "main"), { release: RELEASE, log: (e) => logs.push(e), agentClock: clock })
    expect(MIGRATIONS.map((m) => m.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(Object.keys(RESERVED_MIGRATIONS)).toEqual([])
  })

  test("FTS5 is required: a build without ENABLE_FTS5 is refused", async () => {
    await expectCode(() => assertFts5(["ENABLE_RTREE", "THREADSAFE=1"]), "STORE_FTS5_MISSING")
    assertFts5(["ENABLE_FTS5"])
  })

  test("store root comes only from the argument and is guarded", async () => {
    const s = new SqliteStudioStore()
    await expectCode(s.open("relative/store", { release: RELEASE }), "STORE_ROOT_INVALID")
    await expectCode(s.open("/", { release: RELEASE }), "STORE_ROOT_INVALID")
    await expectCode(s.open(homedir(), { release: RELEASE }), "STORE_ROOT_INVALID")
    await expectCode(s.open("/Applications/Swarm.app/Contents/Resources/datum-studio", { release: RELEASE }), "STORE_ROOT_INVALID")
    const sources = readdirSync(HERE).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.startsWith("test-harness"))
    for (const f of sources) {
      const src = readFileSync(join(HERE, f), "utf8")
      expect(/process\.env|process\.cwd\(/.test(src)).toBe(false)
    }
  })
})

describe("documents, D-06 revisions, search", () => {
  test("create -> revise -> search: latest revision only, old text by explicit revision", async () => {
    const { doc, ids } = await makeDoc(store, pinned.id, ["Tekanan pompa utama turun pada uji awal"])
    expect(doc.current_revision_no).toBe(1)
    expect(doc.doc_number_safe).toBe(docNumberSafe(doc.doc_number))
    const rev2 = await store.transaction((tx) =>
      store.appendRevision(tx, { documentId: doc.id, baseRevisionNo: 1, ...content(rows(ids, ["Tekanan pompa utama stabil setelah kalibrasi katup"], false), "revise") }),
    )
    expect(rev2.revision_no).toBe(2)
    expect(rev2.parent_revision_no).toBe(1)
    expect(rev2.template_version_id).toBe(pinned.id)
    const latest = await store.searchParagraphs({ q: "tekanan", documentId: doc.id })
    expect(latest.hits.length).toBe(1)
    expect(latest.hits[0]!.revisionNo).toBe(2)
    expect(latest.hits[0]!.snippet).toBe("[[Tekanan]] pompa utama stabil setelah kalibrasi katup")
    expect(latest.hits[0]!.rank).toBeGreaterThan(0)
    expect((await store.searchParagraphs({ q: "turun", documentId: doc.id })).hits.length).toBe(0)
    const old = await store.searchParagraphs({ q: "turun", documentId: doc.id, revisionNo: 1 })
    expect(old.hits.map((h) => h.snippet)).toEqual(["Tekanan pompa utama [[turun]] pada uji awal"])
    const r1 = await store.getRevision(doc.id, 1)
    expect(r1!.blocks.length).toBe(1)
    expect((r1!.blocks[0]!.content as { text: string }).text).toBe("Tekanan pompa utama turun pada uji awal")
    expect(r1!.chapters[0]!.pid).toBe("p-ch1")
    const detail = await store.getDocument(doc.id)
    expect(detail!.revisions.map((r) => r.revision_no)).toEqual([2, 1])
    expect(detail!.template).toEqual({ slug: "nota-dinas", origin: "builtin", version_no: 1 })
    await expectCode(
      store.transaction((tx) => store.appendRevision(tx, { documentId: doc.id, baseRevisionNo: 1, ...content(rows(ids, ["x"], false), "stale") })),
      "BASE_CONFLICT",
    )
    expect((await store.getDocument(doc.id))!.document.current_revision_no).toBe(2)
  })

  test("search paging: opaque cursor, no duplicates, stable order", async () => {
    const texts = Array.from({ length: 7 }, (_, i) => `Laporan halaman ${i} memuat kata kunci paging${i % 2 ? " paging" : ""}`)
    await makeDoc(store, pinned.id, texts, { missionFolder: "misi-paging" })
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 10; i++) {
      const page = await store.searchParagraphs({ q: "paging", mission: "misi-paging", take: 3, ...(cursor ? { cursor } : {}) })
      for (const h of page.hits) seen.push(`${h.pid}`)
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }
    expect(seen.length).toBe(7)
    expect(new Set(seen).size).toBe(7)
    await expectCode(store.searchParagraphs({ q: "paging", cursor: "not-a-cursor!" }), "SCHEMA_INVALID")
  })

  test("query translator: raw text that would crash FTS5 is safe; websearch semantics hold", async () => {
    await makeDoc(store, pinned.id, ["Verifikasi pompa utama dan katup pengaman", "Kalibrasi sensor tekanan tinggi", "Catatan: AND OR NOT NEAR adalah kata biasa"], { missionFolder: "misi-fts" })
    const hostile = [
      '"', '""', '" "', '"unterminated phrase', "AND", "OR", "NOT", "NEAR", "a AND", "AND b", "NOT pompa", "pompa NOT", "NEAR(pompa katup)", "NEAR(pompa katup, 2)",
      "*", "pompa*", "*pompa", "text_plain:pompa", "doc_block_fts:pompa", "^pompa", "(", ")", "((pompa", "pompa))", "pompa) OR (katup", "-", "--", "- -pompa", "-pompa",
      "'", "''", "\\", "\\\"", "pompa\u0000katup", "\u0000\u0000", "{pompa katup}", "pompa + katup", "pompa | katup", "pompa & katup", "or or", "or pompa", "pompa or", "pompa or or katup",
      "-\"pompa utama\"", "\"pompa\" \"", "😀 pompa", "😀😀", "pompa:katup", "x".repeat(200), "AND OR NOT NEAR", "\"AND\"", "pompa -", ":", "^", "​​",
    ]
    for (const q of hostile) {
      const m = translateFtsQuery(q)
      if (m !== null) {
        const db = openSqlite(join(RUN, "main", "datum-studio.sqlite"), { readonly: true })
        try {
          db.all("SELECT rowid FROM doc_block_fts WHERE doc_block_fts MATCH ?", [m])
        } finally {
          db.close()
        }
      }
      if (q.trim().length >= 2 && q.trim().length <= 200) await store.searchParagraphs({ q, mission: "misi-fts" })
    }
    // control: the same raw text straight into MATCH does crash
    const db = openSqlite(join(RUN, "main", "datum-studio.sqlite"), { readonly: true })
    let raw = "no error"
    try {
      db.all("SELECT rowid FROM doc_block_fts WHERE doc_block_fts MATCH ?", ['"unterminated phrase'])
    } catch (e) {
      raw = e instanceof Error ? e.message : String(e)
    } finally {
      db.close()
    }
    expect(raw).toMatch(/fts5: syntax error|unterminated/)
    const snippets = async (q: string) => (await store.searchParagraphs({ q, mission: "misi-fts" })).hits.map((h) => h.pid).sort()
    expect(await snippets('"pompa utama"')).toEqual(["p-b1"])
    expect(await snippets('"utama pompa"')).toEqual([])
    expect(await snippets("pompa or sensor")).toEqual(["p-b1", "p-b2"])
    expect(await snippets("pompa OR sensor -tinggi")).toEqual(["p-b1"])
    expect(await snippets("AND NEAR")).toEqual(["p-b3"])
    expect(await snippets("-pompa")).toEqual([])
    expect(translateFtsQuery('a "b c" -d or e')).toBe('(("a" AND "b c") NOT "d") OR "e"')
    expect(translateFtsQuery('say "x""y"')).toBe('("say" AND "x" AND "y")')
    expect(translateFtsQuery("pompa NEAR(katup)")).toBe('("pompa" AND "NEAR(katup)")')
    expect(translateFtsQuery("-a -b")).toBeNull()
    expect(translateFtsQuery("or or")).toBeNull()
  })

  test("revisions, template versions and doc blocks are immutable (triggers)", async () => {
    const { doc } = await makeDoc(store, pinned.id, ["Isi tetap"])
    await store.transaction(async (tx) => {
      tx.run("UPDATE revision SET release_status = 'PASS', lint_report = ? WHERE document_id = ?", ['{"ok":true}', doc.id])
    })
    await expectCode(store.transaction(async (tx) => tx.run("UPDATE revision SET snapshot = '{}' WHERE document_id = ?", [doc.id])), "REVISION_IMMUTABLE")
    await expectCode(store.transaction(async (tx) => tx.run("UPDATE revision SET change_what = 'x' WHERE document_id = ?", [doc.id])), "REVISION_IMMUTABLE")
    await expectCode(store.transaction(async (tx) => tx.run("UPDATE template_version SET change_note = 'x' WHERE id = ?", [pinned.id])), "TEMPLATE_VERSION_IMMUTABLE")
    await expectCode(store.transaction(async (tx) => tx.run("DELETE FROM template_version WHERE id = ?", [pinned.id])), "TEMPLATE_VERSION_IMMUTABLE")
    await expectCode(store.transaction(async (tx) => tx.run("UPDATE doc_block SET text_plain = 'x' WHERE revision_id IN (SELECT id FROM revision WHERE document_id = ?)", [doc.id])), "DOC_BLOCK_IMMUTABLE")
    const r = await store.getRevision(doc.id, "latest")
    expect(r!.revision.release_status).toBe("PASS")
    expect(r!.revision.lint_report).toEqual({ ok: true })
  })

  test("templates: builtin pin reuse/conflict, user versions, read-only builtin, archive", async () => {
    const again = await store.transaction((tx) => store.pinBuiltinVersion(tx, builtinFile()))
    expect(again.id).toBe(pinned.id)
    await expectCode(store.transaction((tx) => store.pinBuiltinVersion(tx, builtinFile({ definitionSha256: "b".repeat(64) }))), "TEMPLATE_VERSION_CONFLICT")
    await expectCode(store.transaction((tx) => store.pinBuiltinVersion(tx, builtinFile({ slug: "user-x" }))), "SCHEMA_INVALID")
    const v1 = await store.transaction((tx) =>
      store.createUserTemplate(tx, { slug: "user-laporan", name: "Laporan saya", kind: "DOCUMENT", createdBy: "swarm", baseVersionId: pinned.id, version: { definition: { a: 1 }, changeNote: "copy", createdBy: "swarm" } }),
    )
    expect(v1.version_no).toBe(1)
    expect(v1.base_version_id).toBe(pinned.id)
    const v2 = await store.transaction((tx) => store.addTemplateVersion(tx, { slug: "user-laporan", baseVersionNo: 1, definition: { a: 2 }, changeNote: "edit", createdBy: "claude" }))
    expect(v2.version_no).toBe(2)
    expect(v2.base_version_id).toBe(v1.id)
    await expectCode(store.transaction((tx) => store.addTemplateVersion(tx, { slug: "user-laporan", baseVersionNo: 1, definition: { a: 3 }, changeNote: "stale", createdBy: "swarm" })), "BASE_CONFLICT")
    await expectCode(store.transaction((tx) => store.addTemplateVersion(tx, { slug: "nota-dinas", baseVersionNo: 1, definition: {}, changeNote: "x", createdBy: "swarm" })), "TEMPLATE_READ_ONLY")
    await expectCode(store.transaction((tx) => store.setTemplateArchived(tx, "nota-dinas", true)), "TEMPLATE_READ_ONLY")
    await expectCode(store.transaction((tx) => store.createUserTemplate(tx, { slug: "laporan", name: "x", kind: "DOCUMENT", createdBy: "swarm", version: { definition: {}, changeNote: "x", createdBy: "swarm" } })), "SCHEMA_INVALID")
    expect(((await store.getTemplateVersion("user-laporan"))!.definition as { a: number }).a).toBe(2)
    expect(((await store.getTemplateVersion("user-laporan", 1))!.definition as { a: number }).a).toBe(1)
    await store.transaction((tx) => store.setTemplateArchived(tx, "user-laporan", true))
    expect((await store.listUserTemplates({})).length).toBe(0)
    expect((await store.listUserTemplates({ archived: true })).map((t) => t.slug)).toEqual(["user-laporan"])
    expect((await store.getTemplateVersion("user-laporan"))!.version_no).toBe(2)
  })

  test("contracts query: kind/status/card/owner/due/docNumber-safe/cursor/archived/matchedItems", async () => {
    const mk = async (n: number, status: string, owner: string, due: string, cards: string[]) => {
      const ids = idsFor(2)
      const r = rows(ids, [`Laporan kerja ${n}`], true, "record")
      r.contractRecord = {
        contract_kind: "AGENT_WORK_REPORT",
        status,
        owner,
        reported_at: 1_800_000_000_000 + n,
        due_on: due,
        card_ids: cards,
        doc_section_id: r.sections![0]!.id,
        items: cards.map((c, i) => ({ item_key: c, position: i + 1, pid: `p-it${i}`, status: "DONE", title_plain: `Butir ${c}` })),
      }
      return makeDoc(store, pinned.id, [`Laporan kerja ${n}`], {
        docNumber: `${100 + n}/GSP/LK/XI/2026`,
        missionFolder: "misi-kontrak",
        missionDocKey: `lk-${n}`,
        contract: { kind: "AGENT_WORK_REPORT", status, owner, taskRef: `T-${n}`, dueOn: due, cardIds: cards },
        revision: content(r, `kontrak ${n}`),
      })
    }
    const a = await mk(1, "DONE", "swarm", "2026-11-10", ["t_0000abcd", "t_0000beef"])
    const b = await mk(2, "IN_PROGRESS", "claude", "2026-11-20", ["t_0000abcd"])
    const c = await mk(3, "DONE", "claude", "2026-12-01", [])
    const ids = async (f: Parameters<SqliteStudioStore["queryContracts"]>[0]) => (await store.queryContracts(f)).contracts.map((x) => x.documentId)
    expect((await ids({ mission: "misi-kontrak" })).sort()).toEqual([a.doc.id, b.doc.id, c.doc.id].sort())
    expect(await ids({ mission: "misi-kontrak", status: ["DONE"] })).toEqual([c.doc.id, a.doc.id])
    expect((await ids({ cardId: "t_0000abcd" })).sort()).toEqual([a.doc.id, b.doc.id].sort())
    expect(await ids({ owner: "claude", dueBefore: "2026-11-30" })).toEqual([b.doc.id])
    expect(await ids({ dueAfter: "2026-11-15", mission: "misi-kontrak" })).toEqual([c.doc.id, b.doc.id])
    expect(await ids({ docNumber: "101-GSP-LK-XI-2026" })).toEqual([a.doc.id])
    expect(await ids({ docNumber: "101/GSP/LK/XI/2026" })).toEqual([a.doc.id])
    expect(await ids({ taskRef: "T-2" })).toEqual([b.doc.id])
    expect(await ids({ kind: "OTHER_KIND" })).toEqual([])
    const p1 = await store.queryContracts({ mission: "misi-kontrak", take: 2 })
    expect(p1.contracts.length).toBe(2)
    const p2 = await store.queryContracts({ mission: "misi-kontrak", take: 2, cursor: p1.nextCursor! })
    expect(p2.contracts.length).toBe(1)
    expect(p2.nextCursor).toBeNull()
    expect((await store.queryContracts({ cursor: "c" + "0".repeat(24) })).contracts.length).toBe(0)
    const withItems = await store.queryContracts({ cardId: "t_0000beef" })
    expect(withItems.contracts[0]!.matchedItems).toEqual([{ key: "t_0000beef", status: "DONE", pid: "p-it1", title: "Butir t_0000beef" }])
    expect(withItems.contracts[0]!.cardIds).toEqual(["t_0000abcd", "t_0000beef"])
    expect(withItems.contracts[0]!.dueOn).toBe("2026-11-10")
    await store.transaction((tx) => store.setDocumentArchived(tx, c.doc.id, true))
    expect(await ids({ mission: "misi-kontrak", status: ["DONE"] })).toEqual([a.doc.id])
    expect(await ids({ mission: "misi-kontrak", status: ["DONE"], includeArchived: true })).toEqual([c.doc.id, a.doc.id])
    expect((await store.getRevision(a.doc.id, "latest"))!.contractItems.length).toBe(2)
    await expectCode(makeDoc(store, pinned.id, ["dup"], { missionFolder: "misi-kontrak", missionDocKey: "lk-1" }), "DOC_KEY_TAKEN")
  })
})

describe("content-addressed files", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5])
  test("asset: write by sha, read back verified, dedupe, tamper detected, type sniffed", async () => {
    const a = await store.putAsset(PNG, { mime: "image/png", widthPx: 1, heightPx: 1, createdBy: "swarm" })
    const sha = sha256Hex(PNG)
    expect(a.sha256).toBe(sha)
    expect(a.rel_path).toBe(`assets/${sha.slice(0, 2)}/${sha}.png`)
    expect(existsSync(join(store.rootDir, a.rel_path))).toBe(true)
    expect(sha256Hex(await store.readAssetBytes(sha))).toBe(sha)
    const b = await store.putAsset(PNG, { mime: "image/png", widthPx: 1, heightPx: 1, createdBy: "claude" })
    expect(b.id).toBe(a.id)
    await expectCode(store.putAsset(new Uint8Array([1, 2, 3, 4]), { mime: "image/png", widthPx: 1, heightPx: 1, createdBy: "swarm" }), "SCHEMA_INVALID")
    writeFileSync(join(store.rootDir, a.rel_path), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))
    await expectCode(store.readAssetBytes(sha), "INTEGRITY_MISMATCH")
  })

  test("output: files first then row, write-once path, sha checked, path guard", async () => {
    const { doc } = await makeDoc(store, pinned.id, ["Isi keluaran"], { missionFolder: "misi-out" })
    const rev = (await store.getRevision(doc.id, "latest"))!.revision
    const bytes = new TextEncoder().encode("%PDF-1.7 row30")
    const sha = sha256Hex(bytes)
    const rel = `docs/misi-out/studio/001/rev-1/${docNumberSafe(doc.doc_number)}_rev1_20261107T000000Z_${sha.slice(0, 8)}.pdf`
    const base = { kind: "document" as const, documentId: doc.id, revisionId: rev.id, format: "PDF" as const, role: "PRIMARY" as const, relPath: rel, fileName: rel.split("/").pop()!, bytes: bytes.byteLength, sha256: sha, mime: "application/pdf" }
    await expectCode(store.transaction((tx) => store.putOutput(tx, base)), "NOT_FOUND")
    const w = store.writeOutputBytes(rel, bytes)
    expect(w.created).toBe(true)
    expect(store.writeOutputBytes(rel, bytes).created).toBe(false)
    await expectCode(() => store.writeOutputBytes(rel, new TextEncoder().encode("other")), "OUTPUT_EXISTS")
    await expectCode(store.transaction((tx) => store.putOutput(tx, { ...base, sha256: "f".repeat(64) })), "INTEGRITY_MISMATCH")
    const row = await store.transaction((tx) => store.putOutput(tx, base))
    expect(row.rel_path).toBe(rel)
    expect(sha256Hex(await store.readOutputVerified(row.id))).toBe(sha)
    expect((await store.getDocument(doc.id))!.outputs.map((o) => o.id)).toEqual([row.id])
    await expectCode(() => store.writeOutputBytes("../escape.pdf", bytes), "PATH_OUTSIDE_ROOT")
    await expectCode(() => store.writeOutputBytes("docs/../datum-studio.sqlite", bytes), "PATH_OUTSIDE_ROOT")
    await expectCode(() => store.writeOutputBytes("/etc/x", bytes), "PATH_OUTSIDE_ROOT")
    await expectCode(() => store.writeOutputBytes("assets/x.png", bytes), "PATH_OUTSIDE_ROOT")
    await store.transaction((tx) =>
      store.recordRender(tx, { id: "c" + "1".repeat(24), documentId: doc.id, revisionId: rev.id, formats: ["pdf"], status: "SUCCEEDED", requestedBy: "swarm", timeFinished: tx.now, durationMs: 5 }, { releaseStatus: "PASS", lintReport: { verdict: "PASS" } }),
    )
    expect((await store.getRevision(doc.id, 1))!.revision.release_status).toBe("PASS")
  })
})

describe("write queue, transactions, lock, busy_timeout", () => {
  test("rollback on throw, tx cannot escape, nested refused, timeout rolls back, reader sees committed only", async () => {
    let boom = ""
    try {
      await store.transaction(async (tx) => {
        tx.run("INSERT INTO store_meta (key, value) VALUES ('rb', '1')")
        throw new Error("boom")
      })
    } catch (e) {
      boom = (e as Error).message
    }
    expect(boom).toBe("boom")
    const db = openSqlite(join(store.rootDir, "datum-studio.sqlite"), { readonly: true })
    expect(db.get("SELECT value FROM store_meta WHERE key = 'rb'") ?? null).toBeNull()
    db.close()
    let leaked: Parameters<Parameters<SqliteStudioStore["transaction"]>[0]>[0] | null = null
    await store.transaction(async (tx) => {
      leaked = tx
    })
    await expectCode(() => leaked!.run("SELECT 1"), "STORE_TX_CLOSED")
    await expectCode(store.transaction(async () => store.transaction(async () => 1)), "STORE_NESTED_TX")
    await expectCode(
      store.transaction(
        async (tx) => {
          tx.run("INSERT INTO store_meta (key, value) VALUES ('slow', '1')")
          await new Promise((r) => setTimeout(r, 300))
        },
        { timeoutMs: 50 },
      ),
      "STORE_TX_TIMEOUT",
    )
    let during: unknown = "unset"
    const { doc } = await makeDoc(store, pinned.id, ["sebelum"])
    await store.transaction(async (tx) => {
      tx.run("UPDATE document SET title = 'baru' WHERE id = ?", [doc.id])
      await new Promise((r) => setTimeout(r, 10))
      during = (await store.getDocument(doc.id))!.document.title
      expect((await store.getDocument(doc.id, tx))!.document.title).toBe("baru")
    })
    expect(during).toBe(doc.title)
    expect((await store.getDocument(doc.id))!.document.title).toBe("baru")
    const db2 = openSqlite(join(store.rootDir, "datum-studio.sqlite"), { readonly: true })
    expect(db2.get("SELECT value FROM store_meta WHERE key = 'slow'") ?? null).toBeNull()
    db2.close()
    expect(logs.some((l) => l.level === "error" && l.source === "StudioStore.transaction" && l.context?.code === "STORE_TX_TIMEOUT")).toBe(true)
  })

  test("lock: second host refused (STORE_LOCKED); stale lock (dead pid, non-host pid) renamed and taken", async () => {
    await expectCode(new SqliteStudioStore().open(store.rootDir, { release: RELEASE }), "STORE_LOCKED")
    const dead = spawnSync("/usr/bin/true").pid!
    const root = join(RUN, "stale")
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, "datum-studio.lock"), JSON.stringify({ pid: dead, startedAt: 1, release: "1.1.0" }))
    const s = await openStore("stale")
    const names = readdirSync(root)
    expect(names.some((n) => n.startsWith("datum-studio.lock.stale-"))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, "datum-studio.lock"), "utf8")).pid).toBe(process.pid)
    await s.close()
    expect(existsSync(join(root, "datum-studio.lock"))).toBe(false)
    // a live PID that is not a Swarm/Electron host (`/bin/sleep`) is stale too
    const sleeper = spawn("/bin/sleep", ["30"], { stdio: "ignore" })
    try {
      writeFileSync(join(root, "datum-studio.lock"), JSON.stringify({ pid: sleeper.pid, startedAt: 2, release: "1.1.0" }))
      const s2 = await openStore("stale")
      expect(readdirSync(root).filter((n) => n.startsWith("datum-studio.lock.stale-")).length).toBe(2)
      await s2.close()
    } finally {
      sleeper.kill()
    }
    // in an Electron utility process the parent is Electron main: a live host, so its lock holds
    if ((process as { type?: string }).type === "utility") {
      writeFileSync(join(root, "datum-studio.lock"), JSON.stringify({ pid: process.ppid, startedAt: 3, release: "1.2.0" }))
      await expectCode(new SqliteStudioStore().open(root, { release: RELEASE }), "STORE_LOCKED")
      console.log(`[row30] utility: lock held by Electron main pid ${process.ppid} -> STORE_LOCKED`)
    }
  })

  test("a write under a held BEGIN IMMEDIATE (other process) waits, then succeeds within busy_timeout 5000", async () => {
    const holdMs = 1500
    const run = async (s: SqliteStudioStore) => {
      const exec = process.env.ROW30_HOLDER_EXEC ?? process.execPath
      const child = spawn(exec, [join(HERE, "test-fixtures", "hold-writer.mjs"), join(s.rootDir, "datum-studio.sqlite"), String(holdMs)], {
        env: { ...process.env, ...(isBun ? {} : { ELECTRON_RUN_AS_NODE: "1" }) },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let out = ""
      let err = ""
      child.stderr.on("data", (d) => (err += String(d)))
      const exited = new Promise<number>((r) => child.on("exit", (c) => r(c ?? -1)))
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (d) => {
          out += String(d)
          if (out.includes("held")) resolve()
        })
        child.on("exit", () => reject(new Error(`holder exited early: ${out} ${err}`)))
      })
      const t0 = Date.now()
      let result: unknown
      try {
        result = await s.transaction(async (tx) => tx.run("INSERT INTO store_meta (key, value) VALUES ('after-holder', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [String(t0)]))
      } catch (e) {
        result = e
      }
      const waited = Date.now() - t0
      const code = await exited
      return { waited, result, code, out }
    }
    const ok = await run(store)
    console.log(`[row30] busy wait: waited ${ok.waited}ms for an outside BEGIN IMMEDIATE held ${holdMs}ms; holder exit ${ok.code}`)
    expect(isStoreError(ok.result)).toBe(false)
    expect(ok.waited).toBeGreaterThan(holdMs - 700)
    expect(ok.waited).toBeLessThan(5000)
    expect(ok.code).toBe(0)
    const db = openSqlite(join(store.rootDir, "datum-studio.sqlite"), { readonly: true })
    expect(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'holder'")!.value).toBe("held")
    expect(db.get("SELECT value FROM store_meta WHERE key = 'after-holder'") !== undefined).toBe(true)
    db.close()
    // negative control: the wait is the busy_timeout (200 ms < hold) -> STORE_BUSY, nothing written
    const short = await openStore("busy-short", { busyTimeoutMs: 200 })
    const bad = await run(short)
    console.log(`[row30] busy control: busy_timeout 200ms -> ${isStoreError(bad.result) ? bad.result.code : "no error"} after ${bad.waited}ms`)
    expect(isStoreError(bad.result, "STORE_BUSY")).toBe(true)
    expect(bad.waited).toBeLessThan(holdMs)
  })
})

describe("backup", () => {
  test("VACUUM INTO snapshot, restore check, restored store opens in WAL and searches", async () => {
    const target = join(RUN, `snapshot-${Date.now()}.sqlite`)
    const rep = await store.snapshotTo(target)
    expect(rep.integrity).toBe("ok")
    expect(rep.ftsIntegrity).toBe("ok")
    expect(rep.journalMode).toBe("delete")
    expect(rep.schemaVersion).toBe(latestSchemaId())
    expect(rep.counts.document).toBeGreaterThan(5)
    await expectCode(store.snapshotTo(target), "OUTPUT_EXISTS")
    await expectCode(store.snapshotTo(join(store.rootDir, "inside.sqlite")), "PATH_OUTSIDE_ROOT")
    const again = verifySnapshot(target)
    expect(again.counts).toEqual(rep.counts)
    const restoreRoot = join(RUN, "restored")
    mkdirSync(restoreRoot, { recursive: true })
    copyFileSync(target, join(restoreRoot, "datum-studio.sqlite"))
    const r = await openStore("restored")
    const hits = await r.searchParagraphs({ q: "kalibrasi", includeArchived: true })
    expect(hits.hits.length).toBeGreaterThan(0)
    const db = openSqlite(join(restoreRoot, "datum-studio.sqlite"), { readonly: true })
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")!.journal_mode).toBe("wal")
    expect(Number(db.get<{ n: number }>("SELECT count(*) AS n FROM document")!.n)).toBe(rep.counts.document)
    db.close()
  })

  test("docNumberSafe matches the vendored final-name.ts (bun only: vendor path alias)", async () => {
    if (!isBun) return
    const vendor = (await import("../../vendor/src/lib/studio/services/render/final-name.ts")) as { docNumberSafe: (s: string) => string }
    for (const s of ["001/GSP/KT/X/2026", "--a..b--", "", "ÄÖ ü", "x".repeat(120) + "-", ". - .", "a//b\\c"]) expect(docNumberSafe(s)).toBe(vendor.docNumberSafe(s))
  })
})
