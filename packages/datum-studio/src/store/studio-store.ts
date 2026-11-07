/**
 * SQLite StudioStore (row 30; spec masterplan/01_specs_studio_store.md).
 *
 * - One process writes (U13): the lock file is taken before the database opens (§6.2).
 * - Two connections (§6.3): a writer used only by the serial write queue, and a query_only reader
 *   that sees committed data only. Each queue job is exactly one BEGIN IMMEDIATE ... COMMIT/ROLLBACK
 *   with a job timeout (§6.4). Pragmas as core's database.ts (§6.6).
 * - FTS5 is required (§5.3): open refuses with STORE_FTS5_MISSING.
 * - D-06 (§4): revisions are append-only; triggers in migration 0001 refuse updates.
 * - Files first, then rows (§6.5): putOutput checks the bytes on disk against the row's sha256.
 * The store path comes only from `open(root)`; nothing here reads env or cwd.
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from "node:fs"
import { dirname, join, sep } from "node:path"
import { openSqlite } from "#sqlite"
import { verifySnapshot } from "./backup.ts"
import type { SqliteDb, SqlParam } from "./driver-types.ts"
import { mapSqliteError, StoreError } from "./errors.ts"
import { assetRelPath, assertFileMatches, readVerified, sniffImage, writeOnce, type WrittenFile } from "./files.ts"
import { exportStoreTo } from "./export.ts"
import { translateFtsQuery } from "./fts-query.ts"
import { canonicalJson, docNumberSafe, newId, sha256Hex } from "./ids.ts"
import { acquireStoreLock, type StoreLock } from "./lock.ts"
import { applyMigrations } from "./migrations/index.ts"
import { MissionStore, pinBuiltinMissionTypes } from "./mission/mission-store.ts"
import { assertStoreRoot, isInside, resolveStoreRel, STORE_DB_FILE } from "./paths.ts"
import { TEMPLATE_GUARD_REPORT_MAX_BYTES } from "./types.ts"
import type {
  AssetMeta,
  AssetRow,
  BuiltinTemplateFile,
  ContractQueryFilter,
  ContractSummaryV2,
  DocumentDetail,
  DocumentPatch,
  DocumentRow,
  ExportManifest,
  NewDocument,
  NewOutputFile,
  NewRevision,
  NewTemplateVersion,
  NewUserTemplate,
  OutputFileRow,
  QueryContractsResult,
  RenderJobUpdate,
  RevisionContent,
  RevisionRow,
  RevisionSummary,
  RevisionWithRows,
  Row,
  SearchBlocksResult,
  SearchHitV2,
  SearchQueryFilter,
  SnapshotReport,
  StoreLogger,
  StoreOpenOptions,
  StoreTx,
  StudioStore,
  TemplateGuardRecord,
  TemplateRow,
  TemplateVersionContent,
  TemplateVersionRow,
  TemplateVersionSummary,
} from "./types.ts"

/** C28 STUDIO_SUBMIT_TX_TIMEOUT_MS (clone contract/env.ts:133). */
export const STORE_TX_TIMEOUT_MS = 60_000
export const STORE_BUSY_TIMEOUT_MS = 5_000
/** C43 (clone contract/env.ts:166) */
export const SEARCH_LIMITS = { qMin: 2, qMax: 200, takeDefault: 20, takeMax: 100 } as const
/** C45 (clone contract/env.ts:170) */
export const CONTRACT_QUERY_LIMITS = { takeDefault: 50, takeMax: 200 } as const
const DOCUMENT_ID_RE = /^[a-z0-9]{20,40}$/
/** Row 70a: a template preview file, `tmp/preview/<preview id>/<file name>` (preview.ts keepFiles). */
const PREVIEW_REL_RE = /^tmp\/preview\/([0-9A-Za-z-]{1,64})\/[^/]+$/
const CARD_ID_RE = /^t_[0-9a-f]{8}$/
const SEARCH_CURSOR_MAX = 200

/** JSON columns per table (DDL migration 0001). Values are JSON.stringify'd on insert and parsed on read. */
const JSON_COLUMNS: Record<string, readonly string[]> = {
  // guard_report: migration 0002 (row 64)
  template_version: ["definition", "overrides", "resolved_params", "role_formats", "section_plan", "assets", "provenance", "skeleton", "guard_report"],
  revision: ["snapshot", "changed_addresses", "lint_report", "completeness_report"],
  block: ["content"],
  doc_section: ["payload"],
  doc_chapter: ["title"],
  doc_subsection: ["title"],
  doc_block: ["content"],
  contract_record: ["card_ids"],
  contract_item: ["depends_on"],
  render_job: ["formats", "engine"],
}

function parseRow<T>(table: string, row: Row | undefined): T | null {
  if (!row) return null
  const cols = JSON_COLUMNS[table]
  if (cols) for (const c of cols) if (typeof row[c] === "string") row[c] = JSON.parse(row[c] as string)
  return row as T
}

function parseRows<T>(table: string, rows: Row[]): T[] {
  return rows.map((r) => parseRow<T>(table, r)!)
}

function jsonOrNull(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v)
}

/** Studio cursor `{r, id}` base64url (clone services/query/filters.ts encodeSearchCursor). */
export function encodeSearchCursor(c: { r: number; id: string }): string {
  return Buffer.from(JSON.stringify({ r: c.r, id: c.id }), "utf8").toString("base64url")
}

export function decodeSearchCursor(raw: string): { r: number; id: string } | null {
  if (raw.length < 1 || raw.length > SEARCH_CURSOR_MAX || !/^[A-Za-z0-9_-]+$/.test(raw)) return null
  let v: unknown
  try {
    v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
  } catch {
    return null
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).length !== 2) return null
  if (typeof o.r !== "number" || !Number.isFinite(o.r) || o.r < 0) return null
  if (typeof o.id !== "string" || !DOCUMENT_ID_RE.test(o.id)) return null
  return { r: o.r, id: o.id }
}

function missingRequiredOf(report: unknown): string[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) return []
  const m = (report as { missingRequired?: unknown }).missingRequired
  return Array.isArray(m) && m.every((x) => typeof x === "string") ? (m as string[]) : []
}

/** One serial async queue: each job runs after the previous one settled. */
class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve()
  run<T>(job: () => Promise<T>): Promise<T> {
    const p = this.tail.then(job, job)
    this.tail = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }
  idle(): Promise<void> {
    return this.tail.then(() => undefined)
  }
}

interface TxState {
  id: string
  alive: boolean
}

export class SqliteStudioStore implements StudioStore {
  private root: string | null = null
  private writer: SqliteDb | null = null
  private reader: SqliteDb | null = null
  private lock: StoreLock | null = null
  private release = ""
  private clock: () => number = Date.now
  private txTimeoutMs = STORE_TX_TIMEOUT_MS
  private log: StoreLogger = () => {}
  private readonly queue = new SerialQueue()
  private readonly txContext = new AsyncLocalStorage<TxState>()
  private readonly columns = new Map<string, Set<string>>()
  private missionGuard = false
  private missionStore: MissionStore | null = null

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async open(root: string, opts: StoreOpenOptions): Promise<void> {
    if (this.writer) throw new StoreError("ALREADY_EXISTS", "store already open")
    const dir = assertStoreRoot(root)
    this.release = opts.release
    this.clock = opts.agentClock ?? Date.now
    this.txTimeoutMs = opts.txTimeoutMs ?? STORE_TX_TIMEOUT_MS
    this.log = opts.log ?? (() => {})
    this.missionGuard = opts.missionGuard === true
    const busy = opts.busyTimeoutMs ?? STORE_BUSY_TIMEOUT_MS
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const lock = acquireStoreLock(dir, { release: opts.release, now: this.clock, isLiveHost: opts.isLiveHost })
    let writer: SqliteDb | null = null
    let reader: SqliteDb | null = null
    try {
      const file = join(dir, STORE_DB_FILE)
      writer = openSqlite(file)
      const mode = writer.get<{ journal_mode: string }>("PRAGMA journal_mode = WAL")?.journal_mode
      if (mode !== "wal") throw new StoreError("STORE_MIGRATION_FAILED", `journal_mode is ${mode}, expected wal`)
      writer.exec(`PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = ${Math.trunc(busy)}; PRAGMA foreign_keys = ON;`)
      writer.get("PRAGMA wal_checkpoint(PASSIVE)")
      assertFts5(writer.all<{ compile_options: string }>("PRAGMA compile_options").map((r) => r.compile_options))
      applyMigrations(writer, { release: opts.release, now: this.clock })
      // row 119a: pin the builtin mission types (mission contract §3.1 rule 4)
      pinBuiltinMissionTypes(writer, this.clock(), (level, source, err, context) => this.emit(level, source, err, context))
      reader = openSqlite(file)
      reader.exec(`PRAGMA busy_timeout = ${Math.trunc(busy)}; PRAGMA foreign_keys = ON; PRAGMA query_only = ON;`)
      sweepTmp(dir)
    } catch (e) {
      try {
        reader?.close()
        writer?.close()
      } finally {
        lock.release()
      }
      this.emit("error", "StudioStore.open", e, { root: dir })
      throw mapSqliteError(e)
    }
    this.root = dir
    this.writer = writer
    this.reader = reader
    this.lock = lock
    this.emit("info", "StudioStore.open", null, { root: dir, release: opts.release, driver: writer.driver })
  }

  async close(): Promise<void> {
    if (!this.writer) return
    await this.queue.idle()
    const writer = this.writer
    const reader = this.reader
    this.writer = null
    this.reader = null
    try {
      try {
        writer.get("PRAGMA wal_checkpoint(TRUNCATE)")
      } catch (e) {
        this.emit("warn", "StudioStore.close", e, {})
      }
      reader?.close()
      writer.close()
    } finally {
      this.lock?.release()
      this.lock = null
      this.root = null
    }
  }

  /** Row 119a: the mission contract API over this store (writes take a tx of `transaction()`). */
  get missions(): MissionStore {
    if (!this.missionStore) {
      this.missionStore = new MissionStore({ reader: () => this.q(), log: (level, source, err, context) => this.emit(level, source, err, context) })
    }
    return this.missionStore
  }

  /** Row 119d (C85): whether the store was opened with `missionGuard: true` (read-only; the host's write wrappers key on it). */
  get missionGuardEnabled(): boolean {
    return this.missionGuard
  }

  /** The store root (absolute), for twins that build file paths. */
  get rootDir(): string {
    return this.requireRoot()
  }

  // ── write queue ───────────────────────────────────────────────────────────

  transaction<T>(fn: (tx: StoreTx) => Promise<T>, opts: { timeoutMs?: number; correlationId?: string } = {}): Promise<T> {
    if (this.txContext.getStore()) return Promise.reject(new StoreError("STORE_NESTED_TX", "transaction() called inside a transaction; pass the tx instead"))
    const timeoutMs = opts.timeoutMs ?? this.txTimeoutMs
    return this.queue.run(async () => {
      const writer = this.requireWriter()
      const state: TxState = { id: newId(), alive: false }
      try {
        writer.exec("BEGIN IMMEDIATE")
      } catch (e) {
        const err = mapSqliteError(e)
        this.emit("error", "StudioStore.transaction.begin", e, { txId: state.id }, opts.correlationId)
        throw err
      }
      state.alive = true
      const tx = this.makeTx(writer, state)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await this.txContext.run(state, () =>
          Promise.race([
            fn(tx),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new StoreError("STORE_TX_TIMEOUT", `transaction exceeded ${timeoutMs} ms`, { timeoutMs })), timeoutMs)
            }),
          ]),
        )
        state.alive = false
        writer.exec("COMMIT")
        return result
      } catch (e) {
        state.alive = false
        try {
          writer.exec("ROLLBACK")
        } catch {
          // SQLite may already have rolled back (e.g. after SQLITE_FULL)
        }
        const err = mapSqliteError(e)
        this.emit(err instanceof StoreError && err.code !== "STORE_TX_TIMEOUT" ? "warn" : "error", "StudioStore.transaction", e, { txId: state.id }, opts.correlationId)
        throw err
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
  }

  private makeTx(writer: SqliteDb, state: TxState): StoreTx {
    const now = this.clock()
    const check = () => {
      if (!state.alive) throw new StoreError("STORE_TX_CLOSED", "transaction already finished; tx objects must not escape their job")
    }
    const wrap = <R>(f: () => R): R => {
      check()
      try {
        return f()
      } catch (e) {
        throw mapSqliteError(e)
      }
    }
    return {
      id: state.id,
      now,
      get alive() {
        return state.alive
      },
      run: (sql, params) => wrap(() => writer.run(sql, params)),
      get: (sql, params) => wrap(() => writer.get(sql, params)),
      all: (sql, params) => wrap(() => writer.all(sql, params)),
    }
  }

  /** Reads run on the reader (committed data) unless a tx is passed (then they see the tx's own writes). */
  private q(tx?: StoreTx) {
    if (tx) return tx
    const reader = this.requireReader()
    return {
      get: <T = Row>(sql: string, params?: readonly SqlParam[]) => reader.get<T>(sql, params),
      all: <T = Row>(sql: string, params?: readonly SqlParam[]) => reader.all<T>(sql, params),
    }
  }

  // ── generic row insert (column rows) ─────────────────────────────────────

  private columnsOf(table: string): Set<string> {
    let cols = this.columns.get(table)
    if (!cols) {
      const rows = this.requireWriter().all<{ name: string }>(`PRAGMA table_info(${JSON.stringify(table)})`)
      if (rows.length === 0) throw new StoreError("SCHEMA_INVALID", `unknown table ${table}`)
      cols = new Set(rows.map((r) => r.name))
      this.columns.set(table, cols)
    }
    return cols
  }

  private insertRow(tx: StoreTx, table: string, row: Row, inject: Row = {}): Row {
    const cols = this.columnsOf(table)
    const obj: Row = { ...row, ...inject }
    if (cols.has("id") && table !== "store_meta" && (obj.id === undefined || obj.id === null)) obj.id = newId()
    if (cols.has("time_created") && obj.time_created === undefined) obj.time_created = tx.now
    const json = new Set(JSON_COLUMNS[table] ?? [])
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined)
    for (const k of keys) if (!cols.has(k)) throw new StoreError("SCHEMA_INVALID", `unknown column ${table}.${k}`, { table, column: k })
    const values = keys.map((k) => {
      const v = obj[k]
      if (json.has(k)) return jsonOrNull(v)
      if (typeof v === "boolean") return v ? 1 : 0
      if (v !== null && typeof v === "object" && !(v instanceof Uint8Array)) {
        throw new StoreError("SCHEMA_INVALID", `column ${table}.${k} is not a JSON column`, { table, column: k })
      }
      return v as SqlParam
    })
    tx.run(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`, values)
    return obj
  }

  // ── documents ─────────────────────────────────────────────────────────────

  async createDocument(tx: StoreTx, input: NewDocument): Promise<DocumentRow> {
    const tv = tx.get<{ template_id: string }>("SELECT template_id FROM template_version WHERE id = ?", [input.templateVersionId])
    if (!tv) throw new StoreError("NOT_FOUND", "template version not found", { templateVersionId: input.templateVersionId })
    const id = input.id ?? newId()
    if (!DOCUMENT_ID_RE.test(id)) throw new StoreError("SCHEMA_INVALID", "document id must match ^[a-z0-9]{20,40}$")
    const c = input.contract
    const reportLink = this.missionGuard ? this.missions.guardCreateDocument(tx, input) : null
    this.insertRow(tx, "document", {
      id,
      doc_number: input.docNumber,
      doc_number_safe: input.docNumberSafe ?? docNumberSafe(input.docNumber),
      number_source: input.numberSource,
      title: input.title,
      type_code: input.typeCode,
      language: input.language ?? "ID",
      classification: input.classification,
      tier: input.tier,
      template_id: tv.template_id,
      current_revision_no: 1,
      mission_folder: input.missionFolder ?? null,
      mission_doc_key: input.missionDocKey ?? null,
      agent_request_id: input.agentRequestId ?? null,
      hermes_task_id: input.hermesTaskId ?? null,
      created_by: input.createdBy,
      archived: 0,
      completeness: input.completeness ?? input.revision.completeness ?? "COMPLETE",
      contract_kind: c?.kind ?? null,
      contract_status: c?.status ?? null,
      contract_owner: c?.owner ?? null,
      contract_task_ref: c?.taskRef ?? null,
      contract_due_on: c?.dueOn ?? null,
      time_created: tx.now,
      time_updated: tx.now,
    })
    if (c) this.replaceCards(tx, id, c.cardIds ?? [])
    this.insertRevision(tx, id, 1, null, input.templateVersionId, input.revision)
    if (reportLink) this.missions.linkReport(tx, { documentId: id, ...reportLink }, { actor: /^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.createdBy) ? input.createdBy : undefined })
    return parseRow<DocumentRow>("document", tx.get("SELECT * FROM document WHERE id = ?", [id]))!
  }

  async appendRevision(tx: StoreTx, input: NewRevision & { baseRevisionNo: number | "latest" }): Promise<RevisionRow> {
    const doc = tx.get<{ id: string; current_revision_no: number }>("SELECT id, current_revision_no FROM document WHERE id = ?", [input.documentId])
    if (!doc) throw new StoreError("NOT_FOUND", "document not found", { documentId: input.documentId })
    if (this.missionGuard) this.missions.guardAppendRevision(tx, doc.id)
    const cur = Number(doc.current_revision_no)
    const base = input.baseRevisionNo === "latest" ? cur : input.baseRevisionNo
    if (base !== cur) throw new StoreError("BASE_CONFLICT", `base revision ${base} is not the current revision ${cur}`, { baseRevisionNo: base, currentRevisionNo: cur })
    const prev = tx.get<{ template_version_id: string }>("SELECT template_version_id FROM revision WHERE document_id = ? AND revision_no = ?", [doc.id, cur])
    if (!prev) throw new StoreError("NOT_FOUND", "current revision row missing", { documentId: doc.id, revisionNo: cur })
    const n = cur + 1
    const rev = this.insertRevision(tx, doc.id, n, cur, input.templateVersionId ?? prev.template_version_id, input)
    this.patchDocument(tx, doc.id, n, input.document, input.completeness)
    return rev
  }

  private insertRevision(tx: StoreTx, documentId: string, n: number, parent: number | null, templateVersionId: string, c: RevisionContent): RevisionRow {
    const snapshotJson = JSON.stringify(c.snapshot ?? null)
    const rev = this.insertRow(tx, "revision", {
      document_id: documentId,
      revision_no: n,
      parent_revision_no: parent,
      template_version_id: templateVersionId,
      snapshot: c.snapshot ?? null,
      snapshot_sha256: c.snapshotSha256 ?? sha256Hex(snapshotJson),
      input_sha256: c.inputSha256,
      doc_rev: c.docRev,
      change_what: c.change.what,
      change_why: c.change.why,
      change_impact: c.change.impact,
      changed_addresses: c.change.addresses ?? [],
      change_scope: c.change.scope ?? null,
      release_status: "PENDING",
      created_by: c.createdBy,
      schema_id: c.schemaId ?? "studio.doc/v2",
      structure_sha256: c.structureSha256 ?? null,
      completeness: c.completeness ?? "COMPLETE",
      completeness_report: c.completenessReport ?? null,
    })
    const revisionId = rev.id as string
    const r = c.rows ?? {}
    for (const row of r.identities ?? []) this.insertRow(tx, "doc_identity", row, { document_id: documentId, created_revision_no: row.created_revision_no ?? n, created_by: row.created_by ?? c.createdBy })
    for (const pid of r.retirePids ?? []) {
      tx.run("UPDATE doc_identity SET retired_revision_no = ? WHERE document_id = ? AND pid = ? AND retired_revision_no IS NULL", [n, documentId, pid])
    }
    for (const row of r.sections ?? []) this.insertRow(tx, "doc_section", row, { revision_id: revisionId })
    for (const row of r.chapters ?? []) this.insertRow(tx, "doc_chapter", row, { revision_id: revisionId })
    for (const row of r.subsections ?? []) this.insertRow(tx, "doc_subsection", row, { revision_id: revisionId })
    for (const row of r.blocks ?? []) this.insertRow(tx, "doc_block", row, { revision_id: revisionId })
    for (const row of r.legacyBlocks ?? []) this.insertRow(tx, "block", row, { revision_id: revisionId })
    if (r.contractRecord) {
      const { items, refs, ...record } = r.contractRecord
      const rec = this.insertRow(tx, "contract_record", record, { revision_id: revisionId, document_id: documentId, revision_no: n, item_count: record.item_count ?? (items ?? []).length })
      for (const it of items ?? []) this.insertRow(tx, "contract_item", it, { record_id: rec.id, document_id: documentId, revision_no: n })
      for (const ref of refs ?? []) this.insertRow(tx, "doc_ref", ref, { record_id: rec.id, from_document_id: documentId, revision_no: n })
    }
    return parseRow<RevisionRow>("revision", tx.get("SELECT * FROM revision WHERE id = ?", [revisionId]))!
  }

  private patchDocument(tx: StoreTx, id: string, n: number, patch: DocumentPatch | undefined, revCompleteness: string | undefined): void {
    const sets = ["current_revision_no = ?", "time_updated = ?"]
    const vals: SqlParam[] = [n, tx.now]
    if (patch?.title !== undefined) {
      sets.push("title = ?")
      vals.push(patch.title)
    }
    const comp = patch?.completeness ?? revCompleteness
    if (comp !== undefined) {
      sets.push("completeness = ?")
      vals.push(comp)
    }
    const c = patch?.contract
    if (c) {
      sets.push("contract_kind = ?", "contract_status = ?", "contract_owner = ?", "contract_task_ref = ?", "contract_due_on = ?")
      vals.push(c.kind, c.status ?? null, c.owner ?? null, c.taskRef ?? null, c.dueOn ?? null)
    }
    tx.run(`UPDATE document SET ${sets.join(", ")} WHERE id = ?`, [...vals, id])
    if (c) this.replaceCards(tx, id, c.cardIds ?? [])
  }

  private replaceCards(tx: StoreTx, documentId: string, cardIds: string[]): void {
    for (const card of cardIds) if (!CARD_ID_RE.test(card)) throw new StoreError("SCHEMA_INVALID", "card id must match ^t_[0-9a-f]{8}$")
    tx.run("DELETE FROM document_card WHERE document_id = ?", [documentId])
    for (const card of new Set(cardIds)) tx.run("INSERT INTO document_card (document_id, card_id) VALUES (?, ?)", [documentId, card])
  }

  /** Archive hides from lists and search, never deletes (Studio rule). */
  async setDocumentArchived(tx: StoreTx, id: string, archived: boolean): Promise<void> {
    const r = tx.run("UPDATE document SET archived = ?, time_updated = ? WHERE id = ?", [archived ? 1 : 0, tx.now, id])
    if (r.changes === 0) throw new StoreError("NOT_FOUND", "document not found", { documentId: id })
  }

  async getDocument(id: string, tx?: StoreTx): Promise<DocumentDetail | null> {
    const q = this.q(tx)
    const document = parseRow<DocumentRow>("document", q.get("SELECT * FROM document WHERE id = ?", [id]))
    if (!document) return null
    const revisions = q.all<RevisionSummary>(
      `SELECT revision_no, doc_rev, change_what, change_why, change_impact, created_by, time_created,
              release_status, completeness, template_version_id
         FROM revision WHERE document_id = ? ORDER BY revision_no DESC`,
      [id],
    )
    const template =
      q.get<{ slug: string; origin: string; version_no: number }>(
        `SELECT t.slug, t.origin, v.version_no FROM revision r
           JOIN template_version v ON v.id = r.template_version_id JOIN template t ON t.id = v.template_id
          WHERE r.document_id = ? AND r.revision_no = ?`,
        [id, document.current_revision_no],
      ) ?? null
    const cur = q.get<{ id: string }>("SELECT id FROM revision WHERE document_id = ? AND revision_no = ?", [id, document.current_revision_no])
    const outputs = cur
      ? q.all<OutputFileRow>("SELECT * FROM output_file WHERE document_id = ? AND revision_id = ? ORDER BY role, format, figure_label, time_created DESC, rowid DESC", [id, cur.id])
      : []
    const cardIds = q.all<{ card_id: string }>("SELECT card_id FROM document_card WHERE document_id = ? ORDER BY card_id", [id]).map((r) => r.card_id)
    return { document, cardIds, revisions, template, outputs }
  }

  async getRevision(documentId: string, n: number | "latest", tx?: StoreTx): Promise<RevisionWithRows | null> {
    const q = this.q(tx)
    const revision = parseRow<RevisionRow>(
      "revision",
      q.get(
        `SELECT r.* FROM revision r JOIN document d ON d.id = r.document_id
          WHERE r.document_id = ? AND r.revision_no = coalesce(?, d.current_revision_no)`,
        [documentId, n === "latest" ? null : n],
      ),
    )
    if (!revision) return null
    const rid = revision.id
    const template = q.get<{ slug: string; origin: string; version_no: number }>(
      "SELECT t.slug, t.origin, v.version_no FROM template_version v JOIN template t ON t.id = v.template_id WHERE v.id = ?",
      [revision.template_version_id],
    )!
    const contractRecord = parseRow<Row>("contract_record", q.get("SELECT * FROM contract_record WHERE revision_id = ?", [rid]))
    return {
      revision,
      template,
      sections: parseRows("doc_section", q.all("SELECT * FROM doc_section WHERE revision_id = ? ORDER BY position", [rid])),
      chapters: parseRows("doc_chapter", q.all("SELECT c.*, i.pid FROM doc_chapter c JOIN doc_identity i ON i.id = c.identity_id WHERE c.revision_id = ? ORDER BY c.doc_section_id, c.position", [rid])),
      subsections: parseRows("doc_subsection", q.all("SELECT s.*, i.pid FROM doc_subsection s JOIN doc_identity i ON i.id = s.identity_id WHERE s.revision_id = ? ORDER BY s.chapter_id, s.section_no", [rid])),
      blocks: parseRows("doc_block", q.all("SELECT b.*, a.sha256 AS asset_sha256 FROM doc_block b LEFT JOIN asset a ON a.id = b.asset_id WHERE b.revision_id = ? ORDER BY b.ordinal", [rid])),
      legacyBlocks: parseRows("block", q.all("SELECT * FROM block WHERE revision_id = ? ORDER BY ordinal", [rid])),
      contractRecord,
      contractItems: contractRecord ? parseRows("contract_item", q.all("SELECT * FROM contract_item WHERE record_id = ? ORDER BY position", [contractRecord.id as string])) : [],
      docRefs: contractRecord ? q.all("SELECT * FROM doc_ref WHERE record_id = ? ORDER BY position", [contractRecord.id as string]) : [],
    }
  }

  // ── retrieval (§9.2, §9.3) ────────────────────────────────────────────────

  async searchParagraphs(f: SearchQueryFilter): Promise<SearchBlocksResult> {
    const q = typeof f.q === "string" ? f.q.trim() : ""
    if (q.length < SEARCH_LIMITS.qMin || q.length > SEARCH_LIMITS.qMax) throw new StoreError("SCHEMA_INVALID", `q must be ${SEARCH_LIMITS.qMin}..${SEARCH_LIMITS.qMax} characters`)
    const take = f.take ?? SEARCH_LIMITS.takeDefault
    if (!Number.isInteger(take) || take < 1 || take > SEARCH_LIMITS.takeMax) throw new StoreError("SCHEMA_INVALID", `take must be 1..${SEARCH_LIMITS.takeMax}`)
    if (f.revisionNo !== undefined && f.documentId === undefined) throw new StoreError("SCHEMA_INVALID", "revisionNo only with documentId")
    const cursor = f.cursor === undefined ? null : decodeSearchCursor(f.cursor)
    if (f.cursor !== undefined && !cursor) throw new StoreError("SCHEMA_INVALID", "cursor is not valid")
    const match = translateFtsQuery(q)
    if (match === null) return { hits: [], nextCursor: null }
    const reader = this.requireReader()
    // ?1 match, ?2 revisionNo, ?3 documentId, ?4 includeArchived, ?5 mission, ?6 kind, ?7 slotKey,
    // ?8 types JSON, ?9 cursor r, ?10 cursor id, ?11 take+1. score = -bm25 (higher is better).
    const sql = `
      WITH page AS (
        SELECT b.seq, b.id, b.pid, b.address, b.type, s.slot_key, c.chapter_key, rv.revision_no,
               d.id AS document_id, d.doc_number, d.title, d.contract_kind AS kind, -bm25(doc_block_fts) AS score
          FROM doc_block_fts
          JOIN doc_block b   ON b.seq = doc_block_fts.rowid
          JOIN revision rv   ON rv.id = b.revision_id
          JOIN document d    ON d.id = rv.document_id
          JOIN doc_section s ON s.id = b.doc_section_id
          LEFT JOIN doc_chapter c ON c.id = b.chapter_id
         WHERE doc_block_fts MATCH ?1
           AND rv.revision_no = coalesce(?2, d.current_revision_no)
           AND (?3 IS NULL OR d.id = ?3)
           AND (?4 = 1 OR d.archived = 0)
           AND (?5 IS NULL OR d.mission_folder = ?5)
           AND (?6 IS NULL OR d.contract_kind = ?6)
           AND (?7 IS NULL OR s.slot_key = ?7)
           AND (?8 IS NULL OR b.type IN (SELECT value FROM json_each(?8)))
           AND (?9 IS NULL OR -bm25(doc_block_fts) < ?9 OR (-bm25(doc_block_fts) = ?9 AND b.id < ?10))
         ORDER BY score DESC, b.id DESC
         LIMIT ?11
      )
      SELECT p.*, snippet(doc_block_fts, 0, '[[', ']]', '…', 30) AS snippet
        FROM page p JOIN doc_block_fts ON doc_block_fts.rowid = p.seq
       WHERE doc_block_fts MATCH ?1
       ORDER BY p.score DESC, p.id DESC`
    let rows: Row[]
    try {
      rows = reader.all(sql, [
        match,
        f.revisionNo ?? null,
        f.documentId ?? null,
        f.includeArchived === true ? 1 : 0,
        f.mission ?? null,
        f.kind ?? null,
        f.slotKey ?? null,
        f.type && f.type.length > 0 ? JSON.stringify(f.type) : null,
        cursor ? cursor.r : null,
        cursor ? cursor.id : null,
        take + 1,
      ])
    } catch (e) {
      this.emit("error", "StudioStore.searchParagraphs", e, { qLength: q.length, take })
      throw mapSqliteError(e)
    }
    const page = rows.slice(0, take)
    const hits: SearchHitV2[] = page.map((r) => ({
      documentId: r.document_id as string,
      docNumber: r.doc_number as string,
      title: r.title as string,
      kind: (r.kind as string | null) ?? null,
      revisionNo: Number(r.revision_no),
      pid: r.pid as string,
      address: (r.address as string | null) ?? "",
      slotKey: r.slot_key as string,
      chapterKey: (r.chapter_key as string | null) ?? null,
      type: r.type as string,
      snippet: (r.snippet as string | null) ?? "",
      rank: Number(r.score),
    }))
    const last = page[page.length - 1]
    const nextCursor = rows.length > take && last ? encodeSearchCursor({ r: Math.max(0, Number(last.score)), id: last.id as string }) : null
    return { hits, nextCursor }
  }

  async queryContracts(f: ContractQueryFilter): Promise<QueryContractsResult> {
    const take = f.take ?? CONTRACT_QUERY_LIMITS.takeDefault
    if (!Number.isInteger(take) || take < 1 || take > CONTRACT_QUERY_LIMITS.takeMax) throw new StoreError("SCHEMA_INVALID", `take must be 1..${CONTRACT_QUERY_LIMITS.takeMax}`)
    const reader = this.requireReader()
    const sql = `
      SELECT d.id, d.doc_number, d.title, d.current_revision_no, d.mission_folder, d.mission_doc_key, d.time_updated,
             d.completeness, d.contract_kind, d.contract_status, d.contract_owner, d.contract_task_ref, d.contract_due_on,
             (SELECT json_group_array(card_id) FROM (SELECT card_id FROM document_card k WHERE k.document_id = d.id ORDER BY card_id)) AS card_ids,
             (SELECT r.completeness_report FROM revision r WHERE r.document_id = d.id ORDER BY r.revision_no DESC LIMIT 1) AS completeness_report
        FROM document d
       WHERE coalesce(d.contract_kind = ?1, d.contract_kind IS NOT NULL)
         AND (?2 = 1 OR d.archived = 0)
         AND (?3 IS NULL OR d.mission_folder = ?3)
         AND (?4 IS NULL OR d.mission_doc_key = ?4)
         AND (?5 IS NULL OR d.doc_number = ?5 OR d.doc_number_safe = ?5)
         AND (?6 IS NULL OR d.contract_status IN (SELECT value FROM json_each(?6)))
         AND (?7 IS NULL OR EXISTS (SELECT 1 FROM document_card k WHERE k.document_id = d.id AND k.card_id = ?7))
         AND (?8 IS NULL OR d.contract_owner = ?8)
         AND (?9 IS NULL OR d.contract_task_ref = ?9)
         AND (?10 IS NULL OR d.contract_due_on >= ?10)
         AND (?11 IS NULL OR d.contract_due_on <= ?11)
         AND (?12 IS NULL OR (d.time_updated, d.id) < (SELECT time_updated, id FROM document WHERE id = ?12))
       ORDER BY d.time_updated DESC, d.id DESC
       LIMIT ?13`
    let rows: Row[]
    try {
      rows = reader.all(sql, [
        f.kind ?? null,
        f.includeArchived === true ? 1 : 0,
        f.mission ?? null,
        f.docKey ?? null,
        f.docNumber ?? null,
        f.status && f.status.length > 0 ? JSON.stringify(f.status) : null,
        f.cardId ?? null,
        f.owner ?? null,
        f.taskRef ?? null,
        f.dueAfter ?? null,
        f.dueBefore ?? null,
        f.cursor ?? null,
        take + 1,
      ])
    } catch (e) {
      this.emit("error", "StudioStore.queryContracts", e, { take })
      throw mapSqliteError(e)
    }
    const page = rows.slice(0, take)
    const matched = new Map<string, NonNullable<ContractSummaryV2["matchedItems"]>>()
    if (f.cardId && page.length > 0) {
      const items = reader.all<{ document_id: string; item_key: string; status: string; pid: string; title_plain: string }>(
        `SELECT i.document_id, i.item_key, i.status, i.pid, i.title_plain FROM contract_item i
           JOIN document d ON d.id = i.document_id AND i.revision_no = d.current_revision_no
          WHERE i.item_key = ? AND i.document_id IN (SELECT value FROM json_each(?))
          ORDER BY i.document_id, i.position`,
        [f.cardId, JSON.stringify(page.map((d) => d.id))],
      )
      for (const it of items) {
        const list = matched.get(it.document_id) ?? []
        list.push({ key: it.item_key, status: it.status, pid: it.pid, title: it.title_plain })
        matched.set(it.document_id, list)
      }
    }
    const contracts = page.map(
      (d): ContractSummaryV2 => ({
        documentId: d.id as string,
        docNumber: d.doc_number as string,
        title: d.title as string,
        kind: d.contract_kind as string,
        status: (d.contract_status as string | null) ?? null,
        owner: (d.contract_owner as string | null) ?? null,
        taskRef: (d.contract_task_ref as string | null) ?? null,
        cardIds: JSON.parse((d.card_ids as string) ?? "[]") as string[],
        dueOn: (d.contract_due_on as string | null) ?? null,
        revisionNo: Number(d.current_revision_no),
        completeness: {
          status: d.completeness as "INCOMPLETE" | "COMPLETE",
          missingRequired: missingRequiredOf(typeof d.completeness_report === "string" ? JSON.parse(d.completeness_report) : null),
        },
        missionFolder: (d.mission_folder as string | null) ?? null,
        docKey: (d.mission_doc_key as string | null) ?? null,
        updatedAt: new Date(Number(d.time_updated)).toISOString(),
        ...(f.cardId ? { matchedItems: matched.get(d.id as string) ?? [] } : {}),
      }),
    )
    const nextCursor = rows.length > take ? ((page[page.length - 1]?.id as string | undefined) ?? null) : null
    return { contracts, nextCursor }
  }

  // ── outputs and assets ────────────────────────────────────────────────────

  /** Write output bytes write-once under `docs/` or `tmp/preview/` (before putOutput). */
  writeOutputBytes(relPath: string, bytes: Uint8Array): WrittenFile {
    const root = this.requireRoot()
    const abs = resolveStoreRel(root, relPath, ["docs/", "tmp/preview/"])
    return writeOnce(root, abs, relPath, bytes)
  }

  async putOutput(tx: StoreTx, row: NewOutputFile): Promise<OutputFileRow> {
    const root = this.requireRoot()
    const prefixes = row.kind === "preview" ? ["tmp/preview/"] : ["docs/"]
    const abs = resolveStoreRel(root, row.relPath, prefixes)
    if (!/^[0-9a-f]{64}$/.test(row.sha256)) throw new StoreError("SCHEMA_INVALID", "sha256 must be 64 lowercase hex")
    assertFileMatches(abs, row.relPath, row.sha256, row.bytes)
    const ins = this.insertRow(tx, "output_file", {
      id: row.id,
      kind: row.kind,
      document_id: row.documentId ?? null,
      revision_id: row.revisionId ?? null,
      template_version_id: row.templateVersionId ?? null,
      render_job_id: row.renderJobId ?? null,
      format: row.format,
      role: row.role,
      figure_label: row.figureLabel ?? null,
      rel_path: row.relPath,
      file_name: row.fileName,
      bytes: row.bytes,
      sha256: row.sha256,
      mime: row.mime,
      lint_verdict: row.lintVerdict ?? "PENDING",
      scope_kind: row.scopeKind ?? "DOCUMENT",
      scope_key: row.scopeKey ?? null,
      draft: row.draft ? 1 : 0,
    })
    return tx.get<OutputFileRow>("SELECT * FROM output_file WHERE id = ?", [ins.id as string])!
  }

  async getOutput(id: string): Promise<OutputFileRow | null> {
    return this.q().get<OutputFileRow>("SELECT * FROM output_file WHERE id = ?", [id]) ?? null
  }

  /** Read an output's bytes, verified against its recorded sha256 and size. */
  async readOutputVerified(id: string): Promise<Uint8Array> {
    const row = await this.getOutput(id)
    if (!row) throw new StoreError("NOT_FOUND", "output not found", { id })
    const abs = resolveStoreRel(this.requireRoot(), row.rel_path, ["docs/", "tmp/preview/"])
    return readVerified(abs, { sha256: row.sha256, bytes: Number(row.bytes), relPath: row.rel_path })
  }

  /**
   * Row 70a (security M1): keep at most `keep` template previews. One preview = the `kind = 'preview'` rows of one
   * `tmp/preview/<id>/` folder; newest first by time_created, then insertion order. Older previews lose their rows
   * (one transaction), then their files and their folder (if empty). Only `kind = 'preview'` rows whose path is
   * `tmp/preview/<id>/<file>` are touched. Each path goes through resolveStoreRel (no `..`, real parent inside the
   * root) and its real folder must lie inside the real `tmp/preview/`; a link is removed as a link, never followed.
   * Document outputs (`docs/`) are never selected.
   */
  async prunePreviewOutputs(keep: number, opts: { correlationId?: string } = {}): Promise<{ keptPreviews: number; removedPreviews: number; removedRows: number; removedFiles: number }> {
    if (!Number.isInteger(keep) || keep < 0) throw new StoreError("SCHEMA_INVALID", "keep must be a non-negative integer", { keep })
    const root = this.requireRoot()
    const old = await this.transaction(async (tx) => {
      const rows = tx.all<{ id: string; rel_path: string }>("SELECT id, rel_path FROM output_file WHERE kind = 'preview' ORDER BY time_created DESC, rowid DESC")
      const order: string[] = []
      const byFolder = new Map<string, Array<{ id: string; rel_path: string }>>()
      for (const r of rows) {
        const folder = PREVIEW_REL_RE.exec(r.rel_path)?.[1]
        if (!folder) continue
        let list = byFolder.get(folder)
        if (!list) {
          list = []
          byFolder.set(folder, list)
          order.push(folder)
        }
        list.push(r)
      }
      const folders = order.slice(keep)
      const doomed = folders.flatMap((f) => byFolder.get(f)!)
      for (const r of doomed) tx.run("DELETE FROM output_file WHERE id = ? AND kind = 'preview'", [r.id])
      return { kept: order.length - folders.length, folders, rows: doomed }
    }, opts)
    let removedFiles = 0
    const previewDir = join(root, "tmp", "preview")
    const realPreview = existsSync(previewDir) ? realpathSync(previewDir) : null
    for (const r of old.rows) {
      try {
        const abs = resolveStoreRel(root, r.rel_path, ["tmp/preview/"])
        if (!realPreview || !existsSync(dirname(abs))) continue
        const realDir = realpathSync(dirname(abs))
        if (!realDir.startsWith(realPreview + sep)) continue
        if (lstatSync(abs, { throwIfNoEntry: false })) {
          rmSync(abs, { force: true })
          removedFiles += 1
        }
      } catch (e) {
        this.emit("warn", "StudioStore.prunePreviewOutputs", e, { relPath: r.rel_path }, opts.correlationId)
      }
    }
    for (const f of old.folders) {
      const dir = join(previewDir, f)
      try {
        if (realPreview && existsSync(dir) && lstatSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir)
      } catch (e) {
        this.emit("warn", "StudioStore.prunePreviewOutputs", e, { folder: f }, opts.correlationId)
      }
    }
    if (old.rows.length > 0) this.emit("info", "StudioStore.prunePreviewOutputs", null, { keep, removedPreviews: old.folders.length, removedRows: old.rows.length, removedFiles }, opts.correlationId)
    return { keptPreviews: old.kept, removedPreviews: old.folders.length, removedRows: old.rows.length, removedFiles }
  }

  async putAsset(bytes: Uint8Array, meta: AssetMeta, tx?: StoreTx): Promise<AssetRow> {
    const sniff = sniffImage(bytes)
    if (sniff === null || sniff !== meta.mime) throw new StoreError("SCHEMA_INVALID", "asset bytes are not the declared PNG/JPEG", { mime: meta.mime })
    const root = this.requireRoot()
    const sha = sha256Hex(bytes)
    const rel = assetRelPath(sha, meta.mime)
    writeOnce(root, resolveStoreRel(root, rel, ["assets/"]), rel, bytes)
    const insert = async (t: StoreTx) => {
      t.run(
        `INSERT INTO asset (id, sha256, mime, bytes, width_px, height_px, rel_path, mission_folder, created_by, time_created)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
        [newId(), sha, meta.mime, bytes.byteLength, meta.widthPx, meta.heightPx, rel, meta.missionFolder ?? null, meta.createdBy, t.now],
      )
      return t.get<AssetRow>("SELECT * FROM asset WHERE sha256 = ?", [sha])!
    }
    return tx ? insert(tx) : this.transaction(insert)
  }

  async getAsset(sha256: string): Promise<AssetRow | null> {
    return this.q().get<AssetRow>("SELECT * FROM asset WHERE sha256 = ?", [sha256]) ?? null
  }

  /** Read an asset's bytes by sha256, verified (content addressing). */
  async readAssetBytes(sha256: string): Promise<Uint8Array> {
    const row = await this.getAsset(sha256)
    if (!row) throw new StoreError("NOT_FOUND", "asset not found", { sha256 })
    const abs = resolveStoreRel(this.requireRoot(), row.rel_path, ["assets/"])
    return readVerified(abs, { sha256: row.sha256, bytes: Number(row.bytes), relPath: row.rel_path })
  }

  async recordRender(tx: StoreTx, job: RenderJobUpdate, revisionLint?: { releaseStatus: string; lintReport: unknown }): Promise<void> {
    const id = job.id ?? newId()
    const exists = tx.get("SELECT id FROM render_job WHERE id = ?", [id])
    if (!exists) {
      this.insertRow(tx, "render_job", {
        id,
        document_id: job.documentId ?? null,
        revision_id: job.revisionId ?? null,
        formats: job.formats,
        status: job.status,
        error_code: job.errorCode ?? null,
        error_message: job.errorMessage ?? null,
        engine: job.engine ?? null,
        requested_by: job.requestedBy,
        scope_kind: job.scopeKind ?? "DOCUMENT",
        scope_key: job.scopeKey ?? null,
        time_queued: job.timeQueued ?? tx.now,
        time_started: job.timeStarted ?? null,
        time_finished: job.timeFinished ?? null,
        duration_ms: job.durationMs ?? null,
      })
    } else {
      tx.run(
        `UPDATE render_job SET status = ?, error_code = ?, error_message = ?, engine = coalesce(?, engine),
                time_started = coalesce(?, time_started), time_finished = ?, duration_ms = ? WHERE id = ?`,
        [job.status, job.errorCode ?? null, job.errorMessage ?? null, jsonOrNull(job.engine), job.timeStarted ?? null, job.timeFinished ?? null, job.durationMs ?? null, id],
      )
    }
    if (revisionLint) {
      if (!job.revisionId) throw new StoreError("SCHEMA_INVALID", "revision lint needs job.revisionId")
      tx.run("UPDATE revision SET release_status = ?, lint_report = ? WHERE id = ?", [revisionLint.releaseStatus, jsonOrNull(revisionLint.lintReport), job.revisionId])
    }
  }

  // ── templates (§7) ────────────────────────────────────────────────────────

  private versionColumns(v: Omit<TemplateVersionContent, "changeNote" | "createdBy">) {
    const resolved = v.resolvedParams ?? {}
    return {
      definition: v.definition,
      definition_sha256: v.definitionSha256 ?? sha256Hex(canonicalJson(v.definition)),
      overrides: v.overrides ?? {},
      resolved_params: resolved,
      params_sha256: v.paramsSha256 ?? sha256Hex(canonicalJson(resolved)),
      role_formats: v.roleFormats ?? {},
      section_plan: v.sectionPlan ?? [],
      assets: v.assets ?? [],
      skeleton: v.skeleton ?? null,
      skeleton_sha256: v.skeletonSha256 ?? (v.skeleton === undefined || v.skeleton === null ? null : sha256Hex(canonicalJson(v.skeleton))),
    }
  }

  /**
   * Guard columns of migration 0002 for a user version (templates spec §5.5). Written only here, at
   * INSERT; the 0001 trigger refuses any later UPDATE. No guard → all three NULL (allowed: row 66
   * decides when a user version must carry one; `studio_template_check` reports GUARD_MISSING).
   * A guard is all three parts or none, so a stored verdict always has its report and lint sha.
   */
  private guardColumns(guard: TemplateGuardRecord | null | undefined): { guard_verdict: string | null; guard_report: unknown; guard_skill_sha: string | null } {
    if (guard === undefined || guard === null) return { guard_verdict: null, guard_report: null, guard_skill_sha: null }
    if (typeof guard !== "object" || Array.isArray(guard)) throw new StoreError("SCHEMA_INVALID", "guard must be an object")
    if (guard.verdict !== "pass" && guard.verdict !== "warn") throw new StoreError("SCHEMA_INVALID", "guard.verdict must be pass or warn", { verdict: String(guard.verdict).slice(0, 32) })
    if (typeof guard.skillSha !== "string" || !/^[0-9a-f]{64}$/.test(guard.skillSha)) throw new StoreError("SCHEMA_INVALID", "guard.skillSha must be a sha256 hex")
    if (guard.report === undefined || guard.report === null || typeof guard.report !== "object") throw new StoreError("SCHEMA_INVALID", "guard.report must be a JSON object or array")
    let text: string
    try {
      text = JSON.stringify(guard.report)
    } catch (e) {
      throw new StoreError("SCHEMA_INVALID", "guard.report is not serialisable JSON", undefined, e)
    }
    const bytes = Buffer.byteLength(text, "utf8")
    if (bytes > TEMPLATE_GUARD_REPORT_MAX_BYTES) throw new StoreError("SCHEMA_INVALID", "guard.report is over 64 KiB", { bytes, max: TEMPLATE_GUARD_REPORT_MAX_BYTES })
    return { guard_verdict: guard.verdict, guard_report: guard.report, guard_skill_sha: guard.skillSha }
  }

  private versionById(tx: StoreTx, id: string): TemplateVersionRow {
    return parseRow<TemplateVersionRow>(
      "template_version",
      tx.get("SELECT v.*, t.slug, t.origin FROM template_version v JOIN template t ON t.id = v.template_id WHERE v.id = ?", [id]),
    )!
  }

  async pinBuiltinVersion(tx: StoreTx, file: BuiltinTemplateFile): Promise<TemplateVersionRow> {
    if (file.slug.startsWith("user-")) throw new StoreError("SCHEMA_INVALID", "a builtin slug cannot start with user-")
    if (!Number.isInteger(file.versionNo) || file.versionNo < 1) throw new StoreError("SCHEMA_INVALID", "versionNo must be >= 1")
    let t = tx.get<TemplateRow>("SELECT * FROM template WHERE slug = ?", [file.slug])
    if (t && t.origin !== "builtin") throw new StoreError("TEMPLATE_VERSION_CONFLICT", "slug belongs to a user template", { slug: file.slug })
    if (!t) {
      this.insertRow(tx, "template", {
        slug: file.slug,
        origin: "builtin",
        name: file.name,
        kind: file.kind,
        description: file.description ?? null,
        is_canonical: file.isCanonical ? 1 : 0,
        is_preset: file.isPreset ? 1 : 0,
        contract_kind: file.contractKind ?? null,
        latest_version_no: file.versionNo,
        created_by: file.createdBy ?? "builtin",
        time_updated: tx.now,
      })
      t = tx.get<TemplateRow>("SELECT * FROM template WHERE slug = ?", [file.slug])!
    } else if (file.versionNo >= Number(t.latest_version_no)) {
      tx.run("UPDATE template SET name = ?, description = ?, latest_version_no = ?, time_updated = ? WHERE id = ?", [file.name, file.description ?? null, file.versionNo, tx.now, t.id])
    }
    const have = tx.get<{ id: string; definition_sha256: string }>("SELECT id, definition_sha256 FROM template_version WHERE template_id = ? AND version_no = ?", [t.id, file.versionNo])
    if (have) {
      if (have.definition_sha256 !== file.definitionSha256) {
        throw new StoreError("TEMPLATE_VERSION_CONFLICT", "builtin version changed without a version bump", { slug: file.slug, versionNo: file.versionNo })
      }
      return this.versionById(tx, have.id)
    }
    const v = this.insertRow(tx, "template_version", {
      template_id: t.id,
      version_no: file.versionNo,
      base_version_id: null,
      ...this.versionColumns(file),
      provenance: { origin: "builtin", release: file.release, file: file.file, fileSha256: file.fileSha256 },
      change_note: file.changeNote ?? `builtin ${file.slug} v${file.versionNo} (${file.release})`,
      created_by: file.createdBy ?? "builtin",
    })
    return this.versionById(tx, v.id as string)
  }

  async createUserTemplate(tx: StoreTx, input: NewUserTemplate): Promise<TemplateVersionRow> {
    if (!input.slug.startsWith("user-")) throw new StoreError("SCHEMA_INVALID", "a user template slug must start with user-")
    const t = this.insertRow(tx, "template", {
      slug: input.slug,
      origin: "user",
      name: input.name,
      kind: input.kind,
      description: input.description ?? null,
      contract_kind: input.contractKind ?? null,
      latest_version_no: 1,
      created_by: input.createdBy,
      time_updated: tx.now,
    })
    const v = this.insertRow(tx, "template_version", {
      template_id: t.id,
      version_no: 1,
      base_version_id: input.baseVersionId ?? null,
      ...this.versionColumns(input.version),
      ...this.guardColumns(input.version.guard),
      provenance: input.version.provenance ?? { origin: "user" },
      change_note: input.version.changeNote,
      created_by: input.version.createdBy,
    })
    return this.versionById(tx, v.id as string)
  }

  async addTemplateVersion(tx: StoreTx, input: NewTemplateVersion & { baseVersionNo: number }): Promise<TemplateVersionRow> {
    const t = tx.get<TemplateRow>("SELECT * FROM template WHERE slug = ?", [input.slug])
    if (!t) throw new StoreError("NOT_FOUND", "template not found", { slug: input.slug })
    if (t.origin !== "user") throw new StoreError("TEMPLATE_READ_ONLY", "builtin templates are read-only", { slug: input.slug })
    const latest = Number(t.latest_version_no)
    if (input.baseVersionNo !== latest) throw new StoreError("BASE_CONFLICT", `base version ${input.baseVersionNo} is not the latest ${latest}`, { baseVersionNo: input.baseVersionNo, latestVersionNo: latest })
    const base = tx.get<{ id: string }>("SELECT id FROM template_version WHERE template_id = ? AND version_no = ?", [t.id, latest])
    const v = this.insertRow(tx, "template_version", {
      template_id: t.id,
      version_no: latest + 1,
      base_version_id: base?.id ?? null,
      ...this.versionColumns(input),
      ...this.guardColumns(input.guard),
      provenance: input.provenance ?? { origin: "user" },
      change_note: input.changeNote,
      created_by: input.createdBy,
    })
    tx.run("UPDATE template SET latest_version_no = ?, time_updated = ? WHERE id = ?", [latest + 1, tx.now, t.id])
    return this.versionById(tx, v.id as string)
  }

  async setTemplateArchived(tx: StoreTx, slug: string, archived: boolean): Promise<void> {
    const t = tx.get<TemplateRow>("SELECT origin FROM template WHERE slug = ?", [slug])
    if (!t) throw new StoreError("NOT_FOUND", "template not found", { slug })
    if (t.origin !== "user") throw new StoreError("TEMPLATE_READ_ONLY", "builtin templates are read-only", { slug })
    tx.run("UPDATE template SET archived = ?, time_updated = ? WHERE slug = ? AND origin = 'user'", [archived ? 1 : 0, tx.now, slug])
  }

  async listUserTemplates(opts: { archived?: boolean } = {}): Promise<TemplateRow[]> {
    return this.q().all<TemplateRow>("SELECT * FROM template WHERE origin = 'user' AND (? = 1 OR archived = 0) ORDER BY slug", [opts.archived ? 1 : 0])
  }

  async getTemplateVersion(slug: string, versionNo?: number): Promise<TemplateVersionRow | null> {
    return parseRow<TemplateVersionRow>(
      "template_version",
      this.q().get(
        `SELECT v.*, t.slug, t.origin FROM template_version v JOIN template t ON t.id = v.template_id
          WHERE t.slug = ? AND v.version_no = coalesce(?, t.latest_version_no)`,
        [slug, versionNo ?? null],
      ),
    )
  }

  /**
   * Row 64: all versions of one template (builtin or user, archived included), oldest first. Old
   * versions are never edited or deleted, so this is the full history. The counts follow the
   * document-to-version link `revision.template_version_id` (index `revision_template_version_idx`).
   * Unknown slug → `[]`.
   */
  async listTemplateVersions(slug: string, tx?: StoreTx): Promise<TemplateVersionSummary[]> {
    const rows = this.q(tx).all<TemplateVersionSummary>(
      `SELECT v.id, v.version_no, v.base_version_id, v.definition_sha256, v.params_sha256, v.skeleton_sha256,
              v.change_note, v.created_by, v.time_created, v.guard_verdict, v.guard_skill_sha,
              (SELECT count(*) FROM revision r WHERE r.template_version_id = v.id) AS revision_count,
              (SELECT count(DISTINCT r.document_id) FROM revision r WHERE r.template_version_id = v.id) AS document_count
         FROM template_version v JOIN template t ON t.id = v.template_id
        WHERE t.slug = ?
        ORDER BY v.version_no ASC`,
      [slug],
    )
    return rows.map((r) => ({ ...r, version_no: Number(r.version_no), time_created: Number(r.time_created), revision_count: Number(r.revision_count), document_count: Number(r.document_count) }))
  }

  // ── backup (§8.3 steps 1-2, 5); the export folder (row 37) builds on these ──

  /**
   * Consistent single-file snapshot: one exclusive queue job (no write runs meanwhile) doing
   * wal_checkpoint(TRUNCATE) then `VACUUM INTO ?` (bound parameter). The target must be absolute,
   * outside the store root, not yet existing, with an existing parent folder.
   */
  async snapshotTo(targetFile: string): Promise<SnapshotReport> {
    const root = this.requireRoot()
    if (typeof targetFile !== "string" || !targetFile.startsWith("/") || targetFile.includes("\u0000")) throw new StoreError("PATH_OUTSIDE_ROOT", "snapshot target must be absolute")
    if (isInside(root, targetFile)) throw new StoreError("PATH_OUTSIDE_ROOT", "snapshot target must be outside the store", { targetFile })
    if (existsSync(targetFile)) throw new StoreError("OUTPUT_EXISTS", "snapshot target exists", { targetFile })
    if (!existsSync(dirname(targetFile)) || !statSync(dirname(targetFile)).isDirectory()) throw new StoreError("NOT_FOUND", "snapshot target folder missing", { targetFile })
    if (this.txContext.getStore()) throw new StoreError("STORE_NESTED_TX", "snapshotTo inside a transaction")
    await this.queue.run(async () => {
      const writer = this.requireWriter()
      try {
        writer.get("PRAGMA wal_checkpoint(TRUNCATE)")
        writer.run("VACUUM INTO ?", [targetFile])
      } catch (e) {
        this.emit("error", "StudioStore.snapshotTo", e, {})
        throw mapSqliteError(e)
      }
    })
    return verifySnapshot(targetFile)
  }

  /** Row 37 owns the export folder (target guard, assets/docs copy, export.json, reopen counts). */
  async exportTo(target: string): Promise<ExportManifest> {
    return exportStoreTo({ root: this.requireRoot(), release: this.release, now: this.clock, snapshotTo: (f) => this.snapshotTo(f) }, target)
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private requireWriter(): SqliteDb {
    if (!this.writer) throw new StoreError("STORE_CLOSED", "store is not open")
    return this.writer
  }
  private requireReader(): SqliteDb {
    if (!this.reader) throw new StoreError("STORE_CLOSED", "store is not open")
    return this.reader
  }
  private requireRoot(): string {
    if (!this.root) throw new StoreError("STORE_CLOSED", "store is not open")
    return this.root
  }

  private emit(level: "error" | "warn" | "info", source: string, err: unknown, context: Record<string, unknown>, correlationId?: string): void {
    try {
      this.log({
        level,
        source,
        message: err instanceof Error ? err.message : err === null || err === undefined ? source : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        context: { ...context, code: err instanceof StoreError ? err.code : undefined },
        correlationId,
        timestamp: Date.now(),
      })
    } catch {
      // a failing log sink must never break a store call
    }
  }
}

/** Refuse to run without FTS5 (spec §5.3; R2). Pure, so the refusal itself is unit-tested. */
export function assertFts5(compileOptions: readonly string[]): void {
  if (!compileOptions.includes("ENABLE_FTS5")) throw new StoreError("STORE_FTS5_MISSING", "this SQLite build has no FTS5; DATUM Studio search cannot run")
}

/** Sweep `<root>/tmp/` at start (spec §6.5, §8.2): work folders and unfinished writes are discarded. */
function sweepTmp(root: string): void {
  const tmp = join(root, "tmp")
  if (!existsSync(tmp)) {
    mkdirSync(tmp, { recursive: true, mode: 0o700 })
    return
  }
  for (const name of readdirSync(tmp)) rmSync(join(tmp, name), { recursive: true, force: true })
}

