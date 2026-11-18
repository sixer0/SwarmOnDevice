/**
 * Swarm 1.3.3 row 83 (ST-11): rehearsal of the whole retention sequence on a COPY of a Studio store.
 * Run by hand, never by the test suite (the file name has no `.test.`):
 *
 *   bun test/st11-rehearsal/row83-rehearsal.ts <rehearsal root>
 *
 * `<rehearsal root>/store/datum-studio.sqlite` must already be a consistent copy (sqlite3 `.backup` from a read-only
 * source). The script refuses any path under ~/.local/share/swarm. It writes purge backups to `<root>/backups/`
 * and prints one JSON report on stdout (progress on stderr).
 *
 * Steps: forward migrations to 0009 (schema hash H9) and 0010 (store open); proof BEFORE; mark; purge with backup
 * with the clock moved 15 days forward (the code floor of the window is 14 days; this is the rehearsal's stand-in
 * for a zero-day window and is used nowhere else); proof AFTER purge; reclaim (VACUUM; first attempt shows the
 * session-lock refusal when the copy holds a lock, then that lock is released ON THE COPY); proof AFTER vacuum;
 * reversal: restore every purge backup, revert 0010 with row 81's runner, check the schema equals H9 and that the
 * 0009-level migration list finds nothing to apply; proof AFTER reversal.
 */
import { createHash } from "node:crypto"
import { mkdirSync, realpathSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import type { SqliteDb } from "../../src/store/driver-types.ts"
import { isStoreError } from "../../src/store/errors.ts"
import { applyMigrations, MIGRATIONS, revertMigrations } from "../../src/store/migrations/index.ts"
import { MIGRATION_0009_ID } from "../../src/store/migrations/0009_datum_mission_row_contract.ts"
import { MIGRATION_0010_ID } from "../../src/store/migrations/0010_datum_revision_retention.ts"
import { SqliteStudioStore } from "../../src/store/studio-store.ts"

const ROOT = process.argv[2]
if (!ROOT || !ROOT.startsWith("/")) throw new Error("usage: row83-rehearsal.ts <absolute rehearsal root>")
const STORE = join(ROOT, "store")
const FILE = join(STORE, "datum-studio.sqlite")
const BACKUPS = join(ROOT, "backups")
// Refuse the live store wherever HOME points (tests pin HOME elsewhere): any path through a `.local/share/swarm` folder.
if (realpathSync(FILE).includes("/.local/share/swarm/") || realpathSync(FILE).startsWith(join(homedir(), ".local", "share", "swarm"))) throw new Error(`refused: ${FILE} is under a live Swarm data folder`)
mkdirSync(BACKUPS, { recursive: true })

const RELEASE = "1.3.3-rehearsal"
const DAY = 86_400_000
const report: Record<string, unknown> = { root: ROOT }
const log = (m: string) => process.stderr.write(`[row83] ${m}\n`)
const ms = (t: number) => Math.round(performance.now() - t)
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

function raw(readonly = false): SqliteDb {
  const db = openSqlite(FILE, { readonly })
  if (!readonly) db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000")
  return db
}
function measure(db: SqliteDb) {
  const n = (sql: string) => Number(Object.values(db.get<Record<string, unknown>>(sql) ?? {})[0] ?? 0)
  const size = (p: string) => {
    try {
      return statSync(p).size
    } catch {
      return 0
    }
  }
  return {
    fileBytes: size(FILE),
    walBytes: size(`${FILE}-wal`),
    pageCount: n("PRAGMA page_count"),
    freelistCount: n("PRAGMA freelist_count"),
    revisions: n("SELECT count(*) FROM revision"),
    docBlocks: n("SELECT count(*) FROM doc_block"),
    legacyBlocks: n("SELECT count(*) FROM block"),
    documents: n("SELECT count(*) FROM document"),
    outputFiles: n("SELECT count(*) FROM output_file"),
  }
}
function schemaHash(db: SqliteDb): string {
  return sha(db.all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").map((r) => r.sql).join("\n"))
}
function journal(db: SqliteDb): string[] {
  return db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id)
}

/**
 * The proof: every mission-referenced revision. Q-REF of design 04 section 4 (mission_document, the current revision
 * of every work report and of every mission-owned document, every {documentId, revisionNo} in mission_event.detail)
 * plus M5 (mission_row.deliverables with a documentId and revisionNo). For each: present?, snapshot_sha256 column,
 * sha256 of the snapshot text read back, doc_block count.
 */
function proof(): { rows: number; missing: number; digest: string; list: Array<{ documentId: string; revisionNo: number; revisionId: string | null; snapshotSha256: string | null; snapshotHash: string | null; blocks: number }> } {
  const db = raw(true)
  const hasDeliverables = db.all<{ name: string }>("PRAGMA table_info(mission_row)").some((c) => c.name === "deliverables")
  const refs = db.all<{ document_id: string; revision_no: number }>(
    `WITH mref(document_id, revision_no) AS (
       SELECT document_id, revision_no FROM mission_document
       UNION SELECT r.document_id, d.current_revision_no FROM mission_report r JOIN document d ON d.id = r.document_id
       UNION SELECT json_extract(e.detail,'$.documentId'), json_extract(e.detail,'$.revisionNo')
               FROM mission_event e WHERE json_valid(e.detail) AND json_extract(e.detail,'$.revisionNo') IS NOT NULL
       UNION SELECT d.id, d.current_revision_no FROM document d JOIN mission m ON m.id = d.mission_folder
       ${hasDeliverables ? `UNION SELECT json_extract(j.value,'$.documentId'), json_extract(j.value,'$.revisionNo')
               FROM mission_row r, json_each(r.deliverables) j
              WHERE json_valid(r.deliverables) AND json_extract(j.value,'$.documentId') IS NOT NULL AND json_extract(j.value,'$.revisionNo') IS NOT NULL` : ""})
     SELECT document_id, revision_no FROM mref WHERE document_id IS NOT NULL ORDER BY 1, 2`,
  )
  const list = refs.map((k) => {
    const v = db.get<{ id: string; snapshot_sha256: string; snapshot: string }>("SELECT id, snapshot_sha256, snapshot FROM revision WHERE document_id = ? AND revision_no = ?", [k.document_id, k.revision_no])
    const blocks = v ? Number(db.get<{ n: number }>("SELECT count(*) AS n FROM doc_block WHERE revision_id = ?", [v.id])!.n) : 0
    return { documentId: k.document_id, revisionNo: Number(k.revision_no), revisionId: v?.id ?? null, snapshotSha256: v?.snapshot_sha256 ?? null, snapshotHash: v ? sha(v.snapshot) : null, blocks }
  })
  db.close()
  return { rows: list.length, missing: list.filter((r) => r.revisionId === null).length, digest: sha(JSON.stringify(list)), list }
}
function sameProof(a: ReturnType<typeof proof>, b: ReturnType<typeof proof>) {
  return { rowsBefore: a.rows, rowsAfter: b.rows, missingAfter: b.missing, digestEqual: a.digest === b.digest }
}

// ── A. copy as found, forward to 0009 ───────────────────────────────────────
let t = performance.now()
let db = raw()
report.copy = { ...measure(db), journal: journal(db).length, heldSessionLocks: Number(db.get<{ n: number }>("SELECT count(*) AS n FROM mission_lock WHERE time_released IS NULL")!.n) }
log(`copy ${JSON.stringify(report.copy)}`)
t = performance.now()
const to9 = applyMigrations(db, { release: RELEASE, now: Date.now }, MIGRATIONS.filter((m) => m.seq <= 9))
const H9 = schemaHash(db)
report.forward0009 = { applied: to9, ms: ms(t), schemaHash: H9 }
db.close()

// ── B. open the store with the 1.3.3 code: 0010 applies ─────────────────────
t = performance.now()
let store = new SqliteStudioStore()
await store.open(STORE, { release: RELEASE })
db = raw(true)
report.forward0010 = { ms: ms(t), journalHas0010: journal(db).includes(MIGRATION_0010_ID), ...measure(db) }
db.close()
log(`forward ${JSON.stringify(report.forward0010)}`)

const P0 = proof()
report.proofBefore = { rows: P0.rows, missing: P0.missing, digest: P0.digest }
log(`proof before rows=${P0.rows} missing=${P0.missing}`)

// keep-set by clause
const keep = await store.retentionKeepSet()
const byClause: Record<string, number> = {}
for (const k of keep) for (const c of k.clauses) byClause[c] = (byClause[c] ?? 0) + 1
report.keepSet = { kept: keep.length, byClause }

// ── C. mark ─────────────────────────────────────────────────────────────────
t = performance.now()
const mark = await store.markRevisionsForRetention()
report.mark = { ...mark, ms: ms(t) }
const marked = await store.listMarkedRevisions({ withBytes: true })
report.markedSnapshotBytes = marked.reduce((s, m) => s + (m.snapshotBytes ?? 0), 0)
log(`mark ${JSON.stringify(report.mark)}`)
await store.close()

// ── D. purge with backup; clock +15 days (stand-in for a zero-day window, rehearsal only) ─────────────
const shifted = () => Date.now() + 15 * DAY
store = new SqliteStudioStore()
await store.open(STORE, { release: RELEASE, agentClock: shifted })
const batches: Array<Record<string, unknown>> = []
const backupFiles: string[] = []
const rowsTotal: Record<string, number> = {}
let purged = 0
let snapshotBytes = 0
const tPurge = performance.now()
for (let i = 1; ; i++) {
  const file = join(BACKUPS, `purge-${String(i).padStart(2, "0")}.sqlite`)
  t = performance.now()
  const p = await store.purgeMarkedRevisions({ backupFile: file, requestedBy: "row83-rehearsal", limit: 100 })
  if (p.purged === 0) break
  backupFiles.push(file)
  purged += p.purged
  snapshotBytes += p.snapshotBytes
  for (const [k, v] of Object.entries(p.rows)) rowsTotal[k] = (rowsTotal[k] ?? 0) + v
  batches.push({ batch: i, purged: p.purged, ms: ms(t), backupBytes: p.backup?.bytes, remainingMarked: p.remainingMarked })
  log(`purge batch ${i}: ${p.purged} in ${ms(t)} ms, remaining ${p.remainingMarked}`)
  if (p.remainingMarked === 0) break
}
db = raw(true)
report.purge = { purged, snapshotBytes, rows: rowsTotal, batches, totalMs: ms(tPurge), backupBytesTotal: backupFiles.reduce((s, f) => s + statSync(f).size, 0), ...measure(db) }
db.close()

const P1 = proof()
report.proofAfterPurge = sameProof(P0, P1)
log(`proof after purge ${JSON.stringify(report.proofAfterPurge)}`)

// ── E. reclaim (VACUUM) ─────────────────────────────────────────────────────
try {
  await store.reclaimSpace({ requestedBy: "row83-rehearsal" })
  report.reclaimFirstAttempt = "ran"
} catch (e) {
  if (!isStoreError(e, "STORE_BUSY")) throw e
  report.reclaimFirstAttempt = { refused: e.code, ...e.details }
  log(`reclaim refused: ${JSON.stringify(e.details)}`)
  await store.close()
  // ON THE COPY ONLY: release the held session lock(s) so the rehearsal can measure the vacuum.
  db = raw()
  const released = db.run("UPDATE mission_lock SET time_released = ? WHERE time_released IS NULL", [shifted()]).changes
  db.close()
  report.copyLocksReleased = released
  store = new SqliteStudioStore()
  await store.open(STORE, { release: RELEASE, agentClock: shifted })
}
const sizeBeforeVacuum = statSync(FILE).size
t = performance.now()
const vac = await store.reclaimSpace({ requestedBy: "row83-rehearsal" })
report.vacuum = { ...vac, wallMs: ms(t), fileBytesBefore: sizeBeforeVacuum }
log(`vacuum ${vac.before.fileBytes} -> ${vac.after.fileBytes} in ${vac.durationMs} ms`)
await store.close()

db = raw(true)
t = performance.now()
const integrity = db.all<{ integrity_check: string }>("PRAGMA integrity_check").map((r) => r.integrity_check)
const integrityMs = ms(t)
const fk = db.all("PRAGMA foreign_key_check").length
db.close()
db = raw()
let fts = "ok"
try {
  db.run("INSERT INTO doc_block_fts(doc_block_fts) VALUES('integrity-check')")
} catch (e) {
  fts = String(e)
}
report.afterVacuum = { ...measure(db), integrityCheck: integrity.join(";"), integrityMs, foreignKeyViolations: fk, ftsIntegrity: fts }
db.close()
const P2 = proof()
report.proofAfterVacuum = sameProof(P0, P2)
log(`proof after vacuum ${JSON.stringify(report.proofAfterVacuum)}`)

// ── F. reversal: restore the purge backups, then revert 0010 with row 81's runner ─────────────────
store = new SqliteStudioStore()
await store.open(STORE, { release: RELEASE, agentClock: shifted })
t = performance.now()
let restored = 0
for (const f of backupFiles) restored += (await store.restorePurgedRevisions({ backupFile: f, requestedBy: "row83-rehearsal" })).restored
await store.close()
db = raw()
report.restore = { files: backupFiles.length, restored, ms: ms(t), ...measure(db) }
log(`restore ${JSON.stringify(report.restore)}`)
const P3 = proof()
report.proofAfterRestore = sameProof(P0, P3)
t = performance.now()
const reverted = revertMigrations(db, { release: RELEASE, now: Date.now }, MIGRATION_0009_ID)
const revertMs = ms(t)
const reapply = applyMigrations(db, { release: RELEASE, now: Date.now }, MIGRATIONS.filter((m) => m.seq <= 9))
const sv = db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")?.value
report.revert0010 = {
  reverted: reverted.map((r) => r.id),
  ms: revertMs,
  journalHas0010: journal(db).includes(MIGRATION_0010_ID),
  schemaVersion: sv,
  schemaHashEqualsH9: schemaHash(db) === H9,
  appliedByPrevious0009Code: reapply,
  quickCheck: db.get<{ quick_check: string }>("PRAGMA quick_check")?.quick_check,
  ...measure(db),
}
db.close()
const P4 = proof()
report.proofAfterRevert = sameProof(P0, P4)
log(`revert ${JSON.stringify(report.revert0010)}`)
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
