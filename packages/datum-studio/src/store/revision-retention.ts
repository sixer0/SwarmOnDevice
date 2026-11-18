/**
 * Revision retention (Swarm 1.3.3 row 82, ST-11; design masterplan/04_st11_migration_design.md F3-F5, decision C6).
 *
 * Three steps, each a plain function over a store transaction:
 *   keep   `revisionKeepSet`      the ONE rule that says which revisions may never leave the store
 *   mark   `markRevisions`        soft-delete mark (table `revision_prune`, migration 0010) for everything else;
 *                                 a marked revision stays fully readable; the run is idempotent and un-marks a
 *                                 revision that has since become referenced
 *   purge  `purgeMarkedRevisions` operator request only: deletes marked revisions whose mark is older than the
 *                                 window, after a backup file of exactly those rows was written and read back
 *   undo   `restoreRevisionBackup` puts the rows of a backup file back
 *
 * Nothing here runs by itself: no timer, no call from `open`, no tool. The callers are the methods of
 * `SqliteStudioStore` with the same purpose; a test pins that nothing under `src/` or `vendor/scripts/` outside
 * `src/store/` calls them. Nothing here runs VACUUM (row 83) and nothing rewrites a kept revision: the mark lives
 * in a side table, so `revision_immutable` (0001) is neither dropped nor altered, and the snapshot of a kept
 * revision, which the derived block read of row 80 depends on, is never touched.
 */
import { closeSync, existsSync, openSync, readSync, rmSync, statSync } from "node:fs"
import { createHash } from "node:crypto"
import { dirname } from "node:path"
import { openSqlite } from "#sqlite"
import type { SqliteDb, SqlParam } from "./driver-types.ts"
import { StoreError } from "./errors.ts"
import { isInside } from "./paths.ts"
import type { StoreTx } from "./types.ts"

/** N of decision C6: the newest revisions of each document that are kept whatever refers to them. */
/** @internal test seam */
export const RETENTION_KEEP_RECENT = 10
/** Soft-delete window of decision C6: days a revision stays marked before a purge may remove it. */
/** @internal test seam */
export const RETENTION_SOFT_WINDOW_DAYS = 14
/** Version of the keep rule, stored with every mark. Raise it when a clause of `revisionKeepSet` changes. */
const RETENTION_RULE_VERSION = 1
/** `store_meta` key of the retention record: a JSON array, one entry per purge or restore, oldest first. */
const RETENTION_LOG_KEY = "revision_retention_log"
const RETENTION_BACKUP_FORMAT = "datum-studio.revision-backup/v1"

const DAY_MS = 86_400_000

interface RetentionReader {
  get<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T | undefined
  all<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): T[]
}

/** The clauses of the keep rule, in the order of `revisionKeepSet`. */
/** @internal test seam */
export const KEEP_CLAUSES = ["latest", "recent", "mission-document", "row-deliverable", "mission-event", "mission-snapshot", "doc-ref", "output", "verification", "mission-text"] as const
/** @internal test seam */
export type KeepClause = (typeof KEEP_CLAUSES)[number]

export interface KeptRevision {
  revisionId: string
  documentId: string
  revisionNo: number
  /** Every clause that protects the revision, in rule order. */
  clauses: KeepClause[]
}

/**
 * THE keep rule. A revision in the returned map (key = revision id) is never marked and never purged; the mark
 * run and the purge both call this function and nothing else decides. Each clause names the reference it protects.
 * Clauses 1-9 are one SQL statement; clause 10 reads free text and is resolved in code below it.
 *
 * A reference to a revision that does not exist protects nothing (the join drops it). Every clause can only add
 * revisions to the set; none removes one.
 */
export function revisionKeepSet(q: RetentionReader, keepRecent: number = RETENTION_KEEP_RECENT): Map<string, KeptRevision> {
  const n = atLeast("keepRecent", keepRecent, RETENTION_KEEP_RECENT)
  const keep = new Map<string, KeptRevision>()
  const add = (r: { id: string; document_id: string; revision_no: number | bigint }, clause: KeepClause) => {
    const k = keep.get(r.id) ?? { revisionId: r.id, documentId: r.document_id, revisionNo: Number(r.revision_no), clauses: [] }
    if (!k.clauses.includes(clause)) k.clauses.push(clause)
    keep.set(r.id, k)
  }

  const structured = q.all<{ id: string; document_id: string; revision_no: number; clause: KeepClause }>(
    `WITH ref(clause, document_id, revision_no) AS (
       -- 1 latest: the current revision of every document. Protects every read "at the current revision": a
       --   mission-owned document (document.mission_folder), a work report (mission_report), the row done gate.
       SELECT 'latest', d.id, d.current_revision_no FROM document d
       UNION ALL
       -- 2 recent: the N newest revision numbers of every document, referenced or not (C6: N = 10).
       SELECT 'recent', document_id, revision_no
         FROM (SELECT document_id, revision_no, row_number() OVER (PARTITION BY document_id ORDER BY revision_no DESC) AS rn FROM revision)
        WHERE rn <= ?1
       UNION ALL
       -- 3 mission-document: the exact revision a mission produced or revised (mission_document, 0007), i.e. the
       --   output a work report of the mission names in its references.
       SELECT 'mission-document', m.document_id, m.revision_no FROM mission_document m
       UNION ALL
       -- 4 row-deliverable: a mission row's deliverables entry {documentId, revisionNo} (0009; written after a
       --   verified render by the project copy, read by the project gate). Older entries (latest: false) count too.
       SELECT 'row-deliverable', json_extract(j.value, '$.documentId'), json_extract(j.value, '$.revisionNo')
         FROM mission_row r, json_each(r.deliverables) j
        WHERE r.deliverables <> '[]' AND json_type(j.value) = 'object'
       UNION ALL
       -- 5 mission-event: every mission event whose detail names {documentId, revisionNo}, at any depth. This is
       --   the revision of a work report at each submit and update (verb 'report').
       SELECT 'mission-event', json_extract(e.detail, t.path || '.documentId'), t.atom
         FROM mission_event e, json_tree(e.detail) t
        WHERE e.detail IS NOT NULL AND t.key = 'revisionNo' AND t.type = 'integer'
       UNION ALL
       -- 6 mission-snapshot: {documentId, revisionNo} pairs frozen in a mission snapshot body (approve, status,
       --   export): the report revisions the mission showed at that moment.
       SELECT 'mission-snapshot', json_extract(s.body, t.path || '.documentId'), t.atom
         FROM mission_snapshot s, json_tree(s.body) t
        WHERE t.key = 'revisionNo' AND t.type = 'integer'
       UNION ALL
       -- 7 doc-ref: a revision another document cites by number (doc_ref.target_revision_no; the references table
       --   of a work report or any contract document). A citation without a number means "current": clause 1.
       SELECT 'doc-ref', f.target_document_id, f.target_revision_no FROM doc_ref f WHERE f.target_revision_no IS NOT NULL
     )
     SELECT v.id, v.document_id, v.revision_no, ref.clause
       FROM ref JOIN revision v ON v.document_id = ref.document_id AND v.revision_no = ref.revision_no
     UNION ALL
     -- 8 output: a revision that has any rendered output row. Protects every render record a gate, a download or a
     --   project copy (its sha256 is output_file.sha256) may still read, and means a purge never orphans a file.
     SELECT v.id, v.document_id, v.revision_no, 'output' FROM revision v
      WHERE EXISTS (SELECT 1 FROM output_file o WHERE o.revision_id = v.id)
     UNION ALL
     -- 9 verification: a revision that has a verification record (output_verification, 0004).
     SELECT v.id, v.document_id, v.revision_no, 'verification' FROM revision v
      WHERE EXISTS (SELECT 1 FROM output_verification x WHERE x.revision_id = v.id)`,
    [n],
  )
  for (const clause of KEEP_CLAUSES) for (const r of structured) if (r.clause === clause) add(r, clause)

  // 10 mission-text: a revision number written in mission prose ("rev 12", "revisi 3-5", "revisionNo: 7") in a
  //   decision, a row's output / verification / checks / note, a finding, a message or a decision request. The text
  //   carries no document id, so the number protects that revision number of every document the mission owns
  //   (document.mission_folder), links (mission_document), reports through (mission_report), or names in the same
  //   text by id or document number. A text whose number can be tied to no document protects that number in every
  //   document of the store. A heuristic on purpose: it only ever keeps more.
  const texts = q.all<{ mission_id: string; text: string }>(
    `SELECT mission_id, text FROM mission_decision WHERE text LIKE '%rev%'
     UNION ALL SELECT mission_id, output || ' ' || verification || ' ' || coalesce(checks, '') || ' ' || coalesce(note, '') FROM mission_row
                WHERE output LIKE '%rev%' OR verification LIKE '%rev%' OR checks LIKE '%rev%' OR note LIKE '%rev%'
     UNION ALL SELECT mission_id, title || ' ' || coalesce(evidence, '') FROM mission_finding WHERE title LIKE '%rev%' OR evidence LIKE '%rev%'
     UNION ALL SELECT mission_id, text FROM mission_message WHERE text LIKE '%rev%'
     UNION ALL SELECT mission_id, question || ' ' || coalesce(context, '') FROM mission_decision_request WHERE question LIKE '%rev%' OR context LIKE '%rev%'`,
  )
  const mentions = texts.map((t) => ({ mission: t.mission_id, text: t.text, numbers: revisionNumbersIn(t.text) })).filter((t) => t.numbers.length > 0)
  if (mentions.length === 0) return keep
  const documents = q.all<{ id: string; doc_number: string; mission_folder: string | null }>("SELECT id, doc_number, mission_folder FROM document")
  const scope = new Map<string, Set<string>>()
  const inScope = (mission: string | null, doc: string) => {
    if (mission !== null) scope.set(mission, (scope.get(mission) ?? new Set()).add(doc))
  }
  for (const d of documents) inScope(d.mission_folder, d.id)
  for (const r of q.all<{ mission_id: string; document_id: string }>("SELECT mission_id, document_id FROM mission_document UNION SELECT mission_id, document_id FROM mission_report")) inScope(r.mission_id, r.document_id)
  const byNumber = new Map<string, { id: string; document_id: string; revision_no: number }>()
  for (const r of q.all<{ id: string; document_id: string; revision_no: number }>("SELECT id, document_id, revision_no FROM revision")) byNumber.set(`${r.document_id}\u0000${Number(r.revision_no)}`, r)
  for (const m of mentions) {
    const tied = new Set(scope.get(m.mission) ?? [])
    for (const d of documents) if (m.text.includes(d.id) || m.text.includes(d.doc_number)) tied.add(d.id)
    const docs = tied.size > 0 ? [...tied] : documents.map((d) => d.id)
    for (const doc of docs) {
      for (const no of m.numbers) {
        const r = byNumber.get(`${doc}\u0000${no}`)
        if (r) add(r, "mission-text")
      }
    }
  }
  return keep
}

const REV_WORD = /(?<![A-Za-z])rev(?:isi|ision)?(?:s|[_\s]*no(?:mor)?\.?)?["']?\s*[.:=#]?\s*(?:ke[-\s])?(?=\d)/gi
const REV_LIST = /^(\d{1,6})((?:\s*(?:,|\/|&|\+|-|–|—|dan|and|to|sampai|hingga|s\.?\s?d\.?)\s*(?:rev(?:isi|ision)?\.?\s*)?\d{1,6})*)/i
const REV_NEXT = /\s*(,|\/|&|\+|-|–|—|dan|and|to|sampai|hingga|s\.?\s?d\.?)\s*(?:rev(?:isi|ision)?\.?\s*)?(\d{1,6})/gi
/** Widest range "rev a-b" that is expanded; a wider one protects its two ends only. */
const REV_RANGE_MAX = 1000

/**
 * The revision numbers a text names after the word rev / revisi / revision / revisionNo: single numbers, lists
 * ("rev 3, 4 dan 7") and ranges ("revisi 3-5", "rev 3 s.d. 5"). A revision letter ("Rev A") names no number.
 */
/** @internal test seam */
export function revisionNumbersIn(text: string): number[] {
  const found = new Set<number>()
  for (const word of text.matchAll(REV_WORD)) {
    const list = REV_LIST.exec(text.slice(word.index + word[0].length, word.index + word[0].length + 200))
    if (!list) continue
    let last = Number(list[1])
    found.add(last)
    for (const next of list[2]!.matchAll(REV_NEXT)) {
      const value = Number(next[2])
      const range = /^(-|–|—|to|sampai|hingga|s\.?\s?d\.?)$/i.test(next[1]!)
      if (range && value > last && value - last <= REV_RANGE_MAX) for (let i = last + 1; i < value; i++) found.add(i)
      found.add(value)
      last = value
    }
  }
  return [...found].filter((x) => x >= 1).sort((a, b) => a - b)
}

export interface MarkResult {
  /** Revisions in the store. */
  revisions: number
  /** Revisions in the keep-set. */
  kept: number
  /** Marks after the run (= revisions - kept). */
  marked: number
  /** Marks written by this run. */
  newlyMarked: number
  /** Marks removed by this run: the revision has become referenced since it was marked. */
  unmarked: number
  keepRecent: number
  ruleVersion: number
  /** Time written on the new marks. An existing mark keeps its own time, so a second run never restarts or shortens a window. */
  timeMarked: number
}

/**
 * Mark every revision outside the keep-set, and remove the mark of every revision inside it. Deletes no revision
 * and changes no revision row. Idempotent: a second run with nothing changed writes nothing.
 */
export function markRevisions(tx: StoreTx, opts: { keepRecent?: number } = {}): MarkResult {
  const keepRecent = atLeast("keepRecent", opts.keepRecent ?? RETENTION_KEEP_RECENT, RETENTION_KEEP_RECENT)
  const keep = revisionKeepSet(tx, keepRecent)
  const marks = new Set(tx.all<{ revision_id: string }>("SELECT revision_id FROM revision_prune").map((r) => r.revision_id))
  const unmark = [...marks].filter((id) => keep.has(id))
  for (const id of unmark) tx.run("DELETE FROM revision_prune WHERE revision_id = ?", [id])
  const revisions = tx.all<{ id: string; document_id: string; revision_no: number }>("SELECT id, document_id, revision_no FROM revision ORDER BY document_id, revision_no")
  const fresh = revisions.filter((r) => !keep.has(r.id) && !marks.has(r.id))
  for (const r of fresh) {
    tx.run("INSERT INTO revision_prune (revision_id, document_id, revision_no, rule_version, time_marked) VALUES (?, ?, ?, ?, ?)", [r.id, r.document_id, Number(r.revision_no), RETENTION_RULE_VERSION, tx.now])
  }
  return {
    revisions: revisions.length,
    kept: keep.size,
    marked: marks.size - unmark.length + fresh.length,
    newlyMarked: fresh.length,
    unmarked: unmark.length,
    keepRecent,
    ruleVersion: RETENTION_RULE_VERSION,
    timeMarked: tx.now,
  }
}

export interface MarkedRevision {
  revisionId: string
  documentId: string
  revisionNo: number
  ruleVersion: number
  timeMarked: number
  /** First moment a purge may remove it: timeMarked + window. */
  purgeableFrom: number
  purgeable: boolean
  /** Bytes of the revision's snapshot; present only when asked for (it reads the column). */
  snapshotBytes?: number
}

/** The marked revisions, oldest mark first. Read only. */
export function listMarkedRevisions(q: RetentionReader, opts: { now: number; windowDays?: number; withBytes?: boolean }): MarkedRevision[] {
  const window = atLeast("windowDays", opts.windowDays ?? RETENTION_SOFT_WINDOW_DAYS, RETENTION_SOFT_WINDOW_DAYS) * DAY_MS
  return q
    .all<{ revision_id: string; document_id: string; revision_no: number; rule_version: number; time_marked: number; bytes: number | null }>(
      `SELECT p.revision_id, p.document_id, p.revision_no, p.rule_version, p.time_marked,
              ${opts.withBytes ? "(SELECT length(CAST(v.snapshot AS BLOB)) FROM revision v WHERE v.id = p.revision_id)" : "NULL"} AS bytes
         FROM revision_prune p ORDER BY p.time_marked, p.document_id, p.revision_no`,
    )
    .map((r) => ({
      revisionId: r.revision_id,
      documentId: r.document_id,
      revisionNo: Number(r.revision_no),
      ruleVersion: Number(r.rule_version),
      timeMarked: Number(r.time_marked),
      purgeableFrom: Number(r.time_marked) + window,
      purgeable: Number(r.time_marked) + window <= opts.now,
      ...(r.bytes === null ? {} : { snapshotBytes: Number(r.bytes) }),
    }))
}

/**
 * The rows that leave with a revision: the revision row and every row the foreign-key cascade removes with it, in
 * parent-first order (the order a restore inserts them). `output_file` and `output_verification` are not listed:
 * keep clauses 8 and 9 mean a purged revision has none, and the purge refuses if it finds one.
 */
const FAMILY: ReadonlyArray<{ table: string; where: string; order: string }> = [
  { table: "revision", where: "id = ?", order: "id" },
  { table: "doc_section", where: "revision_id = ?", order: "id" },
  { table: "doc_chapter", where: "revision_id = ?", order: "id" },
  { table: "doc_subsection", where: "revision_id = ?", order: "id" },
  { table: "doc_block", where: "revision_id = ?", order: "seq" },
  { table: "block", where: "revision_id = ?", order: "id" },
  { table: "contract_record", where: "revision_id = ?", order: "id" },
  { table: "contract_item", where: "record_id IN (SELECT id FROM contract_record WHERE revision_id = ?)", order: "id" },
  { table: "doc_ref", where: "record_id IN (SELECT id FROM contract_record WHERE revision_id = ?)", order: "id" },
  { table: "render_job", where: "revision_id = ?", order: "id" },
]
/** Tables with a foreign key to `revision` that must hold no row of a purged revision. */
const NEVER_PURGED = ["output_file", "output_verification"] as const

interface PurgeOptions {
  /** Absolute path of the backup file to write: outside the store root, not existing, its folder existing. */
  backupFile: string
  /** Who asked for the purge (a person or an operator command). Recorded in `store_meta`. Required: a purge is never implicit. */
  requestedBy: string
  /** The store root, so the backup cannot be written inside the store. */
  storeRoot: string
  release: string
  /** Days a mark must be old. Only values at or above RETENTION_SOFT_WINDOW_DAYS are accepted. */
  windowDays?: number
  /** N of the keep-set check. Only values at or above RETENTION_KEEP_RECENT are accepted. */
  keepRecent?: number
  /** At most this many revisions in this call, oldest mark first (one backup file per call). */
  limit?: number
}

interface PurgedRevision {
  revisionId: string
  documentId: string
  revisionNo: number
  timeMarked: number
  snapshotSha256: string
  snapshotBytes: number
}

export interface PurgeResult {
  purged: number
  revisions: PurgedRevision[]
  /** Rows removed per table (the revision rows and their cascade). */
  rows: Record<string, number>
  snapshotBytes: number
  /** Absent when nothing was due: no file is written for an empty purge. */
  backup?: { file: string; bytes: number; sha256: string }
  /** Marks left after the purge (not yet due, or beyond `limit`). */
  remainingMarked: number
  windowDays: number
  keepRecent: number
}

/**
 * Remove the marked revisions whose mark is older than the window. Runs inside the caller's write transaction and
 * is synchronous, so the whole purge commits or nothing does:
 *
 *  1. recompute the keep-set; refuse (REVISION_IMMUTABLE, reason `marked-revision-referenced`) when ANY marked
 *     revision is in it. The operator runs the mark step again, which removes those marks, and then purges.
 *  2. select the due marks (oldest first, at most `limit`). None due: return, no file written.
 *  3. write the backup file: the rows of FAMILY for exactly those revisions, with a digest per revision.
 *  4. read the backup back through a new read-only handle: integrity_check, row counts, and the digest of every
 *     revision recomputed from the file must equal the digest of the live rows. A mismatch removes the file this
 *     call wrote and refuses (INTEGRITY_MISMATCH); nothing was deleted.
 *  5. delete the revisions. The database itself re-checks each one (`revision_delete_guard`, 0010): a revision
 *     without a mark, or one a structured reference points at, aborts the transaction.
 *  6. check the result: every purged id is gone, every keep-set revision is still there, the revision count fell
 *     by exactly the purged number, and the output tables lost no row.
 *
 * `revision_immutable` (0001) fires on UPDATE only and is left as it is: the purge updates no revision, and the
 * kept revisions keep both protections (no update by 0001, no delete by 0010).
 * The backup file is left in place whatever happens after step 4; if the transaction later rolls back, the file
 * simply describes rows that are still in the store.
 */
export function purgeMarkedRevisions(tx: StoreTx, opts: PurgeOptions): PurgeResult {
  const windowDays = atLeast("windowDays", opts.windowDays ?? RETENTION_SOFT_WINDOW_DAYS, RETENTION_SOFT_WINDOW_DAYS)
  const keepRecent = atLeast("keepRecent", opts.keepRecent ?? RETENTION_KEEP_RECENT, RETENTION_KEEP_RECENT)
  if (typeof opts.requestedBy !== "string" || opts.requestedBy.trim() === "" || opts.requestedBy.length > 200) throw new StoreError("SCHEMA_INVALID", "purge needs requestedBy: who asked for it")
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new StoreError("SCHEMA_INVALID", "purge limit must be a positive integer")
  assertBackupTarget(opts.storeRoot, opts.backupFile)

  // 1. no marked revision may be in the keep-set
  const keep = revisionKeepSet(tx, keepRecent)
  const marks = tx.all<{ revision_id: string; document_id: string; revision_no: number; time_marked: number }>("SELECT revision_id, document_id, revision_no, time_marked FROM revision_prune ORDER BY time_marked, document_id, revision_no")
  const referenced = marks.filter((m) => keep.has(m.revision_id))
  if (referenced.length > 0) {
    throw new StoreError("REVISION_IMMUTABLE", `${referenced.length} marked revision(s) are referenced again; run the mark step first, nothing was purged`, {
      reason: "marked-revision-referenced",
      total: referenced.length,
      revisions: referenced.slice(0, 20).map((m) => ({ documentId: m.document_id, revisionNo: Number(m.revision_no), clauses: keep.get(m.revision_id)!.clauses })),
    })
  }

  // 2. the due marks
  const due = marks.filter((m) => Number(m.time_marked) + windowDays * DAY_MS <= tx.now).slice(0, opts.limit)
  if (due.length === 0) return { purged: 0, revisions: [], rows: {}, snapshotBytes: 0, remainingMarked: marks.length, windowDays, keepRecent }
  for (const table of NEVER_PURGED) {
    const hit = due.find((m) => tx.get(`SELECT 1 FROM ${table} WHERE revision_id = ?`, [m.revision_id]))
    if (hit) throw new StoreError("REVISION_IMMUTABLE", `marked revision has ${table} rows; nothing was purged`, { reason: "marked-revision-has-output", documentId: hit.document_id, revisionNo: Number(hit.revision_no) })
  }

  // 3. + 4. backup, then read it back
  const before = { revision: count(tx, "revision"), ...Object.fromEntries(NEVER_PURGED.map((t) => [t, count(tx, t)])) }
  const storeId = tx.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'store_id'")?.value ?? ""
  const schemaVersion = tx.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'schema_version'")?.value ?? ""
  const columns = Object.fromEntries(FAMILY.map((f) => [f.table, tx.all<{ name: string }>(`PRAGMA table_info(${f.table})`).map((c) => c.name)]))
  const rows: Record<string, number> = Object.fromEntries(FAMILY.map((f) => [f.table, 0]))
  const revisions: PurgedRevision[] = []
  const digests = new Map<string, string>()
  const out = openSqlite(opts.backupFile)
  try {
    out.exec("BEGIN")
    out.exec("CREATE TABLE backup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
    out.exec("CREATE TABLE backup_revision (revision_id TEXT PRIMARY KEY, document_id TEXT NOT NULL, revision_no INTEGER NOT NULL, time_marked INTEGER NOT NULL, digest TEXT NOT NULL, ord INTEGER NOT NULL)")
    // untyped columns: every value keeps the storage class it has in the store
    for (const f of FAMILY) out.exec(`CREATE TABLE ${f.table} (${columns[f.table]!.map((c) => JSON.stringify(c)).join(", ")})`)
    for (const [i, m] of due.entries()) {
      const hash = createHash("sha256")
      for (const f of FAMILY) {
        const cols = columns[f.table]!
        const insert = `INSERT INTO ${f.table} (${cols.map((c) => JSON.stringify(c)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
        for (const row of tx.all<Record<string, SqlParam>>(`SELECT * FROM ${f.table} WHERE ${f.where} ORDER BY ${f.order}`, [m.revision_id])) {
          digestRow(hash, f.table, cols, row)
          out.run(insert, cols.map((c) => row[c]))
          rows[f.table]! += 1
          if (f.table === "revision") revisions.push({ revisionId: m.revision_id, documentId: m.document_id, revisionNo: Number(m.revision_no), timeMarked: Number(m.time_marked), snapshotSha256: String(row.snapshot_sha256), snapshotBytes: Buffer.byteLength(String(row.snapshot), "utf8") })
        }
      }
      const digest = hash.digest("hex")
      digests.set(m.revision_id, digest)
      out.run("INSERT INTO backup_revision (revision_id, document_id, revision_no, time_marked, digest, ord) VALUES (?, ?, ?, ?, ?, ?)", [m.revision_id, m.document_id, Number(m.revision_no), Number(m.time_marked), digest, i])
    }
    const meta = { format: RETENTION_BACKUP_FORMAT, store_id: storeId, schema_version: schemaVersion, release: opts.release, time: String(tx.now), requested_by: opts.requestedBy, window_days: String(windowDays), keep_recent: String(keepRecent), rule_version: String(RETENTION_RULE_VERSION), rows: JSON.stringify(rows) }
    for (const [key, value] of Object.entries(meta)) out.run("INSERT INTO backup_meta (key, value) VALUES (?, ?)", [key, value])
    out.exec("COMMIT")
  } catch (e) {
    out.close()
    rmSync(opts.backupFile, { force: true })
    throw e
  }
  out.close()
  if (revisions.length !== due.length) {
    rmSync(opts.backupFile, { force: true })
    throw new StoreError("INTEGRITY_MISMATCH", "a marked revision has no revision row; nothing was purged", { marked: due.length, found: revisions.length })
  }
  try {
    const read = readRevisionBackup(opts.backupFile)
    const wrong = due.filter((m) => read.digests.get(m.revision_id) !== digests.get(m.revision_id))
    if (read.revisions.length !== due.length || wrong.length > 0 || JSON.stringify(read.rows) !== JSON.stringify(rows) || read.storeId !== storeId) {
      throw new StoreError("INTEGRITY_MISMATCH", "the backup read back differs from the rows to purge; nothing was purged", { file: opts.backupFile, expected: due.length, read: read.revisions.length, wrong: wrong.length })
    }
  } catch (e) {
    rmSync(opts.backupFile, { force: true })
    throw e
  }
  const backup = { file: opts.backupFile, bytes: statSync(opts.backupFile).size, sha256: fileSha256(opts.backupFile) }

  // 5. delete; the cascade removes the family, `revision_delete_guard` re-checks every row
  for (const m of due) tx.run("DELETE FROM revision WHERE id = ?", [m.revision_id])

  // 6. result check, still inside the transaction
  const gone = due.filter((m) => tx.get("SELECT 1 FROM revision WHERE id = ?", [m.revision_id])).length
  const present = new Set(tx.all<{ id: string }>("SELECT id FROM revision").map((r) => r.id))
  const lost = [...keep.keys()].filter((id) => !present.has(id))
  const after = { revision: count(tx, "revision"), ...Object.fromEntries(NEVER_PURGED.map((t) => [t, count(tx, t)])) }
  const expected = { ...before, revision: before.revision - due.length }
  if (gone > 0 || lost.length > 0 || JSON.stringify(after) !== JSON.stringify(expected)) {
    throw new StoreError("INTEGRITY_MISMATCH", "the purge result is not the expected one; rolled back", { notDeleted: gone, keptButMissing: lost.length, before, after })
  }
  const snapshotBytes = revisions.reduce((sum, r) => sum + r.snapshotBytes, 0)
  appendLog(tx, { action: "purge", time: tx.now, release: opts.release, requestedBy: opts.requestedBy, revisions: due.length, rows, snapshotBytes, windowDays, keepRecent, ruleVersion: RETENTION_RULE_VERSION, backupFile: backup.file, backupBytes: backup.bytes, backupSha256: backup.sha256 })
  return { purged: due.length, revisions, rows, snapshotBytes, backup, remainingMarked: marks.length - due.length, windowDays, keepRecent }
}

interface BackupContent {
  file: string
  storeId: string
  schemaVersion: string
  time: number
  rows: Record<string, number>
  revisions: Array<{ revisionId: string; documentId: string; revisionNo: number; timeMarked: number; digest: string }>
  /** Digest per revision id, recomputed from the rows in the file. */
  digests: Map<string, string>
}

/**
 * Open a backup file read-only and prove it can be read: format, integrity_check, the row counts of its meta, and
 * the digest of every revision recomputed from its rows against the digest stored beside it. Throws
 * INTEGRITY_MISMATCH on any difference. Writes nothing.
 */
/** @internal test seam */
export function readRevisionBackup(file: string): BackupContent {
  if (!existsSync(file)) throw new StoreError("NOT_FOUND", "backup file missing", { file })
  const db = openSqlite(file, { readonly: true })
  try {
    return readBackup(db, file)
  } finally {
    db.close()
  }
}

function readBackup(db: SqliteDb, file: string): BackupContent {
  const bad = (why: string, details: Record<string, unknown> = {}) => new StoreError("INTEGRITY_MISMATCH", `backup file unreadable: ${why}`, { file, ...details })
  const tables = new Set(db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name))
  if (!tables.has("backup_meta") || !tables.has("backup_revision") || FAMILY.some((f) => !tables.has(f.table))) throw bad("not a revision backup")
  const meta = Object.fromEntries(db.all<{ key: string; value: string }>("SELECT key, value FROM backup_meta").map((r) => [r.key, r.value]))
  if (meta.format !== RETENTION_BACKUP_FORMAT) throw bad("unknown format", { format: meta.format })
  const integrity = db.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check
  if (integrity !== "ok") throw bad("integrity_check failed", { integrity })
  const rows = Object.fromEntries(FAMILY.map((f) => [f.table, count(db, f.table)]))
  if (JSON.stringify(rows) !== meta.rows) throw bad("row counts differ from the recorded counts", { rows, recorded: meta.rows })
  const revisions = db
    .all<{ revision_id: string; document_id: string; revision_no: number; time_marked: number; digest: string }>("SELECT revision_id, document_id, revision_no, time_marked, digest FROM backup_revision ORDER BY ord")
    .map((r) => ({ revisionId: r.revision_id, documentId: r.document_id, revisionNo: Number(r.revision_no), timeMarked: Number(r.time_marked), digest: r.digest }))
  if (revisions.length !== rows.revision) throw bad("revision list and revision rows differ", { listed: revisions.length, rows: rows.revision })
  const columns = Object.fromEntries(FAMILY.map((f) => [f.table, db.all<{ name: string }>(`PRAGMA table_info(${f.table})`).map((c) => c.name)]))
  const digests = new Map<string, string>()
  for (const r of revisions) {
    const digest = familyDigest(db, columns, r.revisionId)
    if (digest !== r.digest) throw bad("a revision's rows differ from its recorded digest", { revisionId: r.revisionId })
    digests.set(r.revisionId, digest)
  }
  return { file, storeId: String(meta.store_id), schemaVersion: String(meta.schema_version), time: Number(meta.time), rows, revisions, digests }
}

export interface RestoreResult {
  /** Revisions put back. */
  restored: number
  /** Revisions of the file that are already in the store (same id): left as they are. */
  alreadyPresent: number
  rows: Record<string, number>
  revisions: Array<{ documentId: string; revisionNo: number }>
  /** `doc_block` rows that could not keep their row number (taken meanwhile) and got a new one. */
  renumberedBlocks: number
}

/**
 * Put the revisions of a backup file back, inside the caller's write transaction (all of them or none). The file
 * must come from this store (`store_id`). A revision that is already present is skipped, so a restore can be
 * repeated. Refused when a document of the file no longer exists (NOT_FOUND), when a revision number is taken by a
 * different revision (CONSTRAINT), or when the file names a column the store does not have (SCHEMA_INVALID).
 * A restored revision comes back unmarked; the next mark run marks it again with a new window.
 * Inserting the references of a restored revision fires `mission_document_from_ref` (0007), which could link "the
 * current revision" as of today; links that did not exist before the restore are removed again, so a restore adds
 * no mission fact.
 */
export function restoreRevisionBackup(tx: StoreTx, opts: { backupFile: string; requestedBy: string; release: string }): RestoreResult {
  if (typeof opts.requestedBy !== "string" || opts.requestedBy.trim() === "" || opts.requestedBy.length > 200) throw new StoreError("SCHEMA_INVALID", "restore needs requestedBy: who asked for it")
  if (!existsSync(opts.backupFile)) throw new StoreError("NOT_FOUND", "backup file missing", { file: opts.backupFile })
  const db = openSqlite(opts.backupFile, { readonly: true })
  try {
    const backup = readBackup(db, opts.backupFile)
    const storeId = tx.get<{ value: string }>("SELECT value FROM store_meta WHERE key = 'store_id'")?.value
    if (backup.storeId !== storeId) throw new StoreError("INTEGRITY_MISMATCH", "the backup belongs to another store", { file: opts.backupFile, backupStore: backup.storeId })
    const present = backup.revisions.filter((r) => tx.get("SELECT 1 FROM revision WHERE id = ?", [r.revisionId]))
    const missing = backup.revisions.filter((r) => !present.includes(r))
    const orphan = missing.filter((r) => !tx.get("SELECT 1 FROM document WHERE id = ?", [r.documentId]))
    if (orphan.length > 0) throw new StoreError("NOT_FOUND", "a document of the backup no longer exists; nothing was restored", { documents: [...new Set(orphan.map((r) => r.documentId))].slice(0, 20) })
    const taken = missing.filter((r) => tx.get("SELECT 1 FROM revision WHERE document_id = ? AND revision_no = ?", [r.documentId, r.revisionNo]))
    if (taken.length > 0) throw new StoreError("CONSTRAINT", "a revision number of the backup is taken by another revision; nothing was restored", { revisions: taken.slice(0, 20).map((r) => ({ documentId: r.documentId, revisionNo: r.revisionNo })) })
    const columns = Object.fromEntries(FAMILY.map((f) => [f.table, db.all<{ name: string }>(`PRAGMA table_info(${f.table})`).map((c) => c.name)]))
    for (const f of FAMILY) {
      const live = new Set(tx.all<{ name: string }>(`PRAGMA table_info(${f.table})`).map((c) => c.name))
      const unknown = columns[f.table]!.filter((c) => !live.has(c))
      if (unknown.length > 0) throw new StoreError("SCHEMA_INVALID", `the backup names columns the store does not have: ${f.table}.${unknown.join(", ")}`, { table: f.table, columns: unknown })
    }
    const links = new Set(tx.all<{ k: string }>("SELECT mission_id || char(0) || document_id || char(0) || revision_no AS k FROM mission_document").map((r) => r.k))
    const rows: Record<string, number> = Object.fromEntries(FAMILY.map((f) => [f.table, 0]))
    let renumberedBlocks = 0
    for (const r of missing) {
      for (const f of FAMILY) {
        for (const row of db.all<Record<string, SqlParam>>(`SELECT * FROM ${f.table} WHERE ${f.where} ORDER BY ${f.order}`, [r.revisionId])) {
          // doc_block.seq is the row number the search index uses; keep it when it is free, else let SQLite give a new one
          const renumber = f.table === "doc_block" && tx.get("SELECT 1 FROM doc_block WHERE seq = ?", [row.seq]) !== undefined
          const cols = columns[f.table]!.filter((c) => !(renumber && c === "seq"))
          tx.run(`INSERT INTO ${f.table} (${cols.map((c) => JSON.stringify(c)).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c]))
          rows[f.table]! += 1
          if (renumber) renumberedBlocks += 1
        }
      }
    }
    for (const l of tx.all<{ mission_id: string; document_id: string; revision_no: number; k: string }>("SELECT mission_id, document_id, revision_no, mission_id || char(0) || document_id || char(0) || revision_no AS k FROM mission_document")) {
      if (!links.has(l.k)) tx.run("DELETE FROM mission_document WHERE mission_id = ? AND document_id = ? AND revision_no = ?", [l.mission_id, l.document_id, Number(l.revision_no)])
    }
    if (renumberedBlocks === 0) {
      const live = Object.fromEntries(FAMILY.map((f) => [f.table, tx.all<{ name: string }>(`PRAGMA table_info(${f.table})`).map((c) => c.name)]))
      const sameColumns = FAMILY.every((f) => JSON.stringify(live[f.table]) === JSON.stringify(columns[f.table]))
      const wrong = sameColumns ? missing.filter((r) => familyDigest(tx, live, r.revisionId) !== r.digest) : []
      if (wrong.length > 0) throw new StoreError("INTEGRITY_MISMATCH", "a restored revision differs from the backup; rolled back", { revisions: wrong.slice(0, 20).map((r) => ({ documentId: r.documentId, revisionNo: r.revisionNo })) })
    }
    if (missing.length > 0) appendLog(tx, { action: "restore", time: tx.now, release: opts.release, requestedBy: opts.requestedBy, revisions: missing.length, rows, backupFile: opts.backupFile, backupSha256: fileSha256(opts.backupFile) })
    return { restored: missing.length, alreadyPresent: present.length, rows, revisions: missing.map((r) => ({ documentId: r.documentId, revisionNo: r.revisionNo })), renumberedBlocks }
  } finally {
    db.close()
  }
}

/** The retention record of `store_meta`: one entry per purge and per restore, oldest first. */
export function retentionLog(q: RetentionReader): Array<Record<string, unknown>> {
  return JSON.parse(q.get<{ value: string }>("SELECT value FROM store_meta WHERE key = ?", [RETENTION_LOG_KEY])?.value ?? "[]") as Array<Record<string, unknown>>
}

function appendLog(tx: StoreTx, entry: Record<string, unknown>): void {
  tx.run("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [RETENTION_LOG_KEY, JSON.stringify([...retentionLog(tx), entry])])
}

/** An option that may only be made stricter than the decided value (C6), never looser. */
function atLeast(name: string, value: number, floor: number): number {
  if (!Number.isInteger(value) || value < floor) throw new StoreError("SCHEMA_INVALID", `${name} must be an integer of at least ${floor} (decision C6)`, { [name]: value, floor })
  return value
}

function assertBackupTarget(root: string, file: string): void {
  if (typeof file !== "string" || !file.startsWith("/") || file.includes("\u0000")) throw new StoreError("PATH_OUTSIDE_ROOT", "backup target must be an absolute path")
  if (isInside(root, file)) throw new StoreError("PATH_OUTSIDE_ROOT", "backup target must be outside the store", { file })
  if (existsSync(file)) throw new StoreError("OUTPUT_EXISTS", "backup target exists", { file })
  if (!existsSync(dirname(file)) || !statSync(dirname(file)).isDirectory()) throw new StoreError("NOT_FOUND", "backup target folder missing", { file })
}

function count(q: RetentionReader, table: string): number {
  return Number(q.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0)
}

/** Digest of every family row of one revision, in FAMILY order: equal digests mean equal rows, column by column. */
function familyDigest(q: RetentionReader, columns: Record<string, string[]>, revisionId: string): string {
  const hash = createHash("sha256")
  for (const f of FAMILY) {
    for (const row of q.all<Record<string, SqlParam>>(`SELECT * FROM ${f.table} WHERE ${f.where} ORDER BY ${f.order}`, [revisionId])) digestRow(hash, f.table, columns[f.table]!, row)
  }
  return hash.digest("hex")
}

function digestRow(hash: ReturnType<typeof createHash>, table: string, columns: readonly string[], row: Record<string, SqlParam>): void {
  hash.update(`\u0001${table}\u0000`)
  for (const c of columns) {
    const v = row[c]
    hash.update(`${c}\u0000`)
    if (v === null || v === undefined) hash.update("n")
    else if (v instanceof Uint8Array) hash.update("b").update(v)
    else if (typeof v === "string") hash.update("s").update(v, "utf8")
    else hash.update("i").update(String(v))
    hash.update("\u0000")
  }
}

function fileSha256(file: string): string {
  const hash = createHash("sha256")
  const fd = openSync(file, "r")
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    for (let read = readSync(fd, chunk, 0, chunk.length, null); read > 0; read = readSync(fd, chunk, 0, chunk.length, null)) hash.update(chunk.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest("hex")
}
