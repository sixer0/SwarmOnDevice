/**
 * Swarm 1.3.3 row 83 (ST-11, decision C6): space reclaim (VACUUM) of the Studio store, on operator request only.
 * Fixture stores only, under ROW83_TEST_DIR or the OS temp folder; the live store is never opened.
 *
 * - the store file shrinks and keeps its content (fixture with a dropped filler table, and a real purge);
 * - the reclaim refuses while a write transaction is queued or running, while a session (mission row) lock is
 *   held, inside a transaction, and when the free disk space is short (with the numbers);
 * - nothing calls it outside src/store/ and nothing schedules it.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { openSqlite } from "#sqlite"
import { isStoreError, type StoreErrorCode } from "./errors.ts"
import { canonicalJson, newId, sha256Hex } from "./ids.ts"
import { STORE_VACUUM_LOG_KEY } from "./store-vacuum.ts"
import { SqliteStudioStore } from "./studio-store.ts"
import type { BuiltinTemplateFile, RevisionRowsInput } from "./types.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect, afterAll } = T

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = join(HERE, "..", "..")
const BASE = process.env.ROW83_TEST_DIR ?? join(tmpdir(), "row83-store-vacuum-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
const RELEASE = "1.3.3"
let now = 1_800_000_000_000
const clock = () => ++now
const opened: SqliteStudioStore[] = []
afterAll(async () => {
  for (const s of opened) await s.close()
})

async function openStore(name: string, opts: { busyTimeoutMs?: number } = {}) {
  const s = new SqliteStudioStore()
  await s.open(join(RUN, name), { release: RELEASE, agentClock: clock, ...opts })
  opened.push(s)
  return s
}
async function closeStore(s: SqliteStudioStore) {
  await s.close()
  opened.splice(opened.indexOf(s), 1)
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
const DEF = { schema: "studio.template/v2", slug: "nota-dinas", slots: [{ slotKey: "isi" }] }
const BUILTIN: BuiltinTemplateFile = { slug: "nota-dinas", name: "Nota Dinas", kind: "DOCUMENT", versionNo: 1, definition: DEF, definitionSha256: sha256Hex(canonicalJson(DEF)), file: "nota-dinas.json", fileSha256: "a".repeat(64), release: RELEASE }

/** One document of `revisions` revisions with a snapshot of about `bytes` bytes each and three blocks per revision. */
async function seedDocument(store: SqliteStudioStore, revisions: number, bytes: number): Promise<string> {
  const tv = (await store.transaction((tx) => store.pinBuiltinVersion(tx, BUILTIN))).id as string
  const ids = { ch: newId(), sub: newId(), blocks: [newId(), newId(), newId()] }
  const rows = (tag: string, first: boolean): RevisionRowsInput => {
    const sectionId = newId()
    const chapterId = newId()
    const subId = newId()
    const texts = [1, 2, 3].map((i) => `${tag} paragraf ${i} ${"isi ".repeat(200)}`)
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
  const content = (tag: string, first: boolean) => ({ snapshot: { what: tag, body: `${tag} `.repeat(Math.ceil(bytes / (tag.length + 1))) }, inputSha256: sha256Hex(tag), docRev: "A", change: { what: tag, why: "fixture", impact: "none" }, createdBy: "swarm", rows: rows(tag, first) })
  const doc = await store.transaction((tx) =>
    store.createDocument(tx, { docNumber: "001/GSP/KT/X/2026", numberSource: "AGENT", title: "Dokumen 1", typeCode: "KT", classification: "TERBATAS", tier: "NOTA", templateVersionId: tv, createdBy: "swarm", missionFolder: null, revision: content("rev1", true) }),
  )
  for (let n = 2; n <= revisions; n++) await store.transaction((tx) => store.appendRevision(tx, { documentId: doc.id, baseRevisionNo: "latest", ...content(`rev${n}`, false) }))
  return doc.id
}

const dbFile = (name: string) => join(RUN, name, "datum-studio.sqlite")

/** A store whose file holds about `mb` MB of free pages: a filler table written and dropped while the store was closed. */
async function bloatedStore(name: string, mb: number): Promise<void> {
  const s = await openStore(name)
  await closeStore(s)
  const db = openSqlite(dbFile(name))
  db.exec("CREATE TABLE row83_filler (b BLOB)")
  for (let i = 0; i < mb; i++) db.run("INSERT INTO row83_filler (b) VALUES (randomblob(1048576))")
  db.exec("DROP TABLE row83_filler")
  db.get("PRAGMA wal_checkpoint(TRUNCATE)")
  db.close()
}

describe("row 83: reclaimSpace", () => {
  test("the store file shrinks, content and schema unchanged, numbers and durations reported, log appended", async () => {
    await bloatedStore("shrink", 8)
    const sizeBefore = statSync(dbFile("shrink")).size
    expect(sizeBefore).toBeGreaterThan(8 * 1024 * 1024)
    const s = await openStore("shrink")
    const schema = () => JSON.stringify(openSqlite(dbFile("shrink"), { readonly: true }).all("SELECT type, name, sql FROM sqlite_master ORDER BY type, name"))
    const schemaBefore = schema()
    const r = await s.reclaimSpace({ requestedBy: "row83-test" })
    expect(r.before.fileBytes).toBe(sizeBefore)
    expect(r.before.freelistCount).toBeGreaterThan(2000)
    expect(r.after.freelistCount).toBe(0)
    expect(r.after.fileBytes).toBeLessThan(sizeBefore / 4)
    expect(statSync(dbFile("shrink")).size).toBe(r.after.fileBytes)
    expect(r.after.walBytes).toBe(0)
    expect(r.reclaimedBytes).toBe(r.before.fileBytes + r.before.walBytes - r.after.fileBytes - r.after.walBytes)
    expect(r.quickCheck).toBe("ok")
    for (const k of ["checkpointMs", "ftsOptimizeMs", "vacuumMs", "finalCheckpointMs", "quickCheckMs"] as const) expect(typeof r.steps[k]).toBe("number")
    expect(r.durationMs).toBeGreaterThanOrEqual(r.steps.vacuumMs)
    expect(r.space.needTempBytes).toBeGreaterThan(0)
    expect(r.space.freeTempBytes).toBeGreaterThan(r.space.needTempBytes)
    expect(schema()).toBe(schemaBefore)
    // the record of the request
    await closeStore(s)
    const db = openSqlite(dbFile("shrink"), { readonly: true })
    const log = JSON.parse(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = ?", [STORE_VACUUM_LOG_KEY])!.value) as Array<Record<string, unknown>>
    db.close()
    expect(log.length).toBe(1)
    expect(log[0]!.requestedBy).toBe("row83-test")
    expect((log[0]!.before as { fileBytes: number }).fileBytes).toBe(sizeBefore)
    // the store reopens and works
    const s2 = await openStore("shrink")
    await s2.transaction(async (tx) => {
      tx.run("INSERT INTO store_meta (key, value) VALUES ('row83_probe', '1')")
    })
    await closeStore(s2)
  })

  test("refused while a write transaction is running, and while one is queued", async () => {
    await bloatedStore("busy", 2)
    const s = await openStore("busy")
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const running = s.transaction(async (tx) => {
      tx.run("INSERT INTO store_meta (key, value) VALUES ('row83_busy', '1')")
      await gate
    })
    const queued = s.transaction(async () => undefined)
    const d = await refused(s.reclaimSpace({ requestedBy: "row83-test" }), "STORE_BUSY")
    expect(d.reason).toBe("write-in-progress")
    expect(d.pendingJobs).toBe(2)
    release()
    await running
    await queued
    // nothing was vacuumed: the free pages are still there; with the queue idle it runs
    const r = await s.reclaimSpace({ requestedBy: "row83-test" })
    expect(r.before.freelistCount).toBeGreaterThan(400)
    expect(r.after.freelistCount).toBe(0)
    await closeStore(s)
  })

  test("refused inside a transaction (the caller would deadlock its own queue)", async () => {
    const s = await openStore("nested")
    await s.transaction(async () => {
      await refused(s.reclaimSpace({ requestedBy: "row83-test" }), "STORE_NESTED_TX")
    })
    await closeStore(s)
  })

  test("refused while a session lock (mission_lock row not released) is held; runs once it is released", async () => {
    await bloatedStore("locked", 2)
    // fixture: a held row lock, written raw with foreign keys off (no mission row is needed to hold the resource)
    const db = openSqlite(dbFile("locked"))
    db.exec("PRAGMA foreign_keys = OFF")
    db.run("INSERT INTO mission_lock (resource, mission_id, row_id, holder, time_acquired) VALUES ('lock:studio-db-migration', 'm-1', '83', 'driver', 1)")
    db.close()
    const s = await openStore("locked")
    const d = await refused(s.reclaimSpace({ requestedBy: "row83-test" }), "STORE_BUSY")
    expect(d.reason).toBe("session-lock-held")
    expect(d.locks).toEqual([{ resource: "lock:studio-db-migration", missionId: "m-1", rowId: "83", holder: "driver", timeAcquired: 1 }])
    expect(statSync(dbFile("locked")).size).toBeGreaterThan(2 * 1024 * 1024)
    await closeStore(s)
    const db2 = openSqlite(dbFile("locked"))
    db2.run("UPDATE mission_lock SET time_released = 2")
    db2.close()
    const s2 = await openStore("locked")
    const r = await s2.reclaimSpace({ requestedBy: "row83-test" })
    expect(r.after.freelistCount).toBe(0)
    await closeStore(s2)
  })

  test("refused with the numbers when free disk space is short; nothing written", async () => {
    await bloatedStore("disk", 2)
    const s = await openStore("disk")
    const before = statSync(dbFile("disk")).size
    const d = await refused(s.reclaimSpace({ requestedBy: "row83-test", diskFree: () => 1024 * 1024 }), "CONSTRAINT")
    expect(d.reason).toBe("insufficient-disk-space")
    for (const k of ["usedBytes", "needTempBytes", "needStoreBytes", "freeTempBytes", "freeStoreBytes", "tempDir", "storeDir", "sameDevice"]) expect(k in d).toBe(true)
    expect(d.freeTempBytes).toBe(1024 * 1024)
    expect(statSync(dbFile("disk")).size).toBe(before)
    await closeStore(s)
  })

  test("refused without requestedBy, and on a closed store", async () => {
    const s = await openStore("args")
    await refused(s.reclaimSpace({ requestedBy: " " }), "SCHEMA_INVALID")
    await closeStore(s)
    await refused(s.reclaimSpace({ requestedBy: "row83-test" }), "STORE_CLOSED")
  })

  test("after a real purge the freed revision pages are returned and the remaining revisions read the same", async () => {
    // A document of 15 revisions with large snapshots, written through the store; 5 old ones marked and purged.
    const s = await openStore("purge")
    const docId = await seedDocument(s, 15, 64 * 1024)
    await s.markRevisionsForRetention()
    await closeStore(s)
    // the purge window (14 days) passes: reopen with the clock moved forward
    now += 15 * 86_400_000
    const s2 = await openStore("purge")
    const before = new Map<number, string>()
    for (let n = 6; n <= 15; n++) before.set(n, JSON.stringify(await s2.getRevision(docId, n)))
    const p = await s2.purgeMarkedRevisions({ backupFile: join(RUN, "purge-backup.sqlite"), requestedBy: "row83-test" })
    expect(p.purged).toBe(5)
    const r = await s2.reclaimSpace({ requestedBy: "row83-test" })
    expect(r.before.freelistCount).toBeGreaterThan(0)
    expect(r.after.fileBytes).toBeLessThan(r.before.fileBytes)
    for (let n = 6; n <= 15; n++) expect(JSON.stringify(await s2.getRevision(docId, n))).toBe(before.get(n)!)
    expect(await s2.getRevision(docId, 1)).toBeNull()
    await closeStore(s2)
  })
})

describe("row 83: operator-only", () => {
  test("no caller of reclaimSpace outside src/store/ under src/ or vendor/scripts/; no timer in the vacuum module", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (e.name !== "node_modules") walk(p)
        } else if (/\.(ts|tsx|js|mjs)$/.test(e.name) && /reclaimSpace|reclaimStoreSpace/.test(readFileSync(p, "utf8"))) hits.push(relative(PKG, p))
      }
    }
    walk(join(PKG, "src"))
    walk(join(PKG, "vendor", "scripts"))
    expect(hits.filter((h) => !h.startsWith("src/store/")).sort()).toEqual([])
    const code = readFileSync(join(HERE, "store-vacuum.ts"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
    expect(/setTimeout|setInterval/.test(code)).toBe(false)
    const studio = readFileSync(join(HERE, "studio-store.ts"), "utf8")
    const openBody = studio.slice(studio.indexOf("async open("), studio.indexOf("async close("))
    expect(/reclaim|VACUUM(?! INTO)/.test(openBody)).toBe(false)
  })
})
