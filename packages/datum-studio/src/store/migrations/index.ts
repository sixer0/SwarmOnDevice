import type { SqliteDb } from "../driver-types.ts"
import { StoreError } from "../errors.ts"
import { newId } from "../ids.ts"
import { MIGRATION_0001_SQL } from "./0001_datum_studio_init.ts"
import { MIGRATION_0002_ID, MIGRATION_0002_SQL } from "./0002_datum_template_guard.ts"
import { MIGRATION_0003_ID, MIGRATION_0003_SQL } from "./0003_datum_mission.ts"
import { MIGRATION_0004_ID, MIGRATION_0004_SQL } from "./0004_datum_output_verification.ts"
import { MIGRATION_0005_ID, MIGRATION_0005_SQL } from "./0005_datum_mission_gsp_tiers.ts"
import { MIGRATION_0006_ID, MIGRATION_0006_SQL } from "./0006_datum_mission_autonomous_decision.ts"
import { MIGRATION_0007_ID, MIGRATION_0007_SQL } from "./0007_datum_mission_document_link.ts"
import { MIGRATION_0008_ID, MIGRATION_0008_SQL } from "./0008_datum_decision_provenance.ts"
import { MIGRATION_0009_ID, MIGRATION_0009_SQL } from "./0009_datum_mission_row_contract.ts"
import { MIGRATION_0009_DOWN_LOSS_SQL, MIGRATION_0009_DOWN_SQL } from "./0009_datum_mission_row_contract.down.ts"
import { MIGRATION_0010_ID, MIGRATION_0010_SQL } from "./0010_datum_revision_retention.ts"
import { MIGRATION_0010_DOWN_SQL } from "./0010_datum_revision_retention.down.ts"
import { MIGRATION_0011_ID, MIGRATION_0011_SQL } from "./0011_datum_purge_fk_indexes.ts"
import { MIGRATION_0011_DOWN_SQL } from "./0011_datum_purge_fk_indexes.down.ts"

/**
 * Store migrations (spec §3.1: own runner, journal table shaped like core's
 * `migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`; each migration in one BEGIN IMMEDIATE).
 */
export interface Migration {
  seq: number
  id: string
  sql: string
  /** Table rebuild: run with foreign keys off (set before BEGIN), `PRAGMA foreign_key_check` must be empty before COMMIT. */
  foreignKeysOff?: boolean
  /**
   * 1.3.3 row 81 (ST-11): the reverse step, run only by `revertMigration`. Absent = the migration cannot be reverted
   * (0001-0008: none was written with one, and none is invented afterwards). `foreignKeysOff` applies to it as well.
   */
  down?: string
  /**
   * A SELECT returning one row `n`: how many rows hold data the reverse step discards. Above zero, the reversal is
   * refused unless the operator passes `acceptDataLoss`. Absent = the reverse step discards nothing that the
   * forward step did not create empty.
   */
  downLossSql?: string
}

export const MIGRATIONS: readonly Migration[] = [
  { seq: 1, id: "20261106000000_datum_studio_init", sql: MIGRATION_0001_SQL },
  // row 64: template guard columns (templates spec §5.5), additive only
  { seq: 2, id: MIGRATION_0002_ID, sql: MIGRATION_0002_SQL },
  // row 119a: mission contract tables (U19, U20, C57; masterplan/01_specs_mission_contract.md §7), additive only
  { seq: 3, id: MIGRATION_0003_ID, sql: MIGRATION_0003_SQL },
  // row 149: output verification state (U24, C130; masterplan/01_specs_output_verification.md §5), additive only
  { seq: 4, id: MIGRATION_0004_ID, sql: MIGRATION_0004_SQL },
  // row 166: mission_row model tiers become the GSP AI tiers (thinker/worker/worker-fast/inherit); table rebuild
  { seq: 5, id: MIGRATION_0005_ID, sql: MIGRATION_0005_SQL, foreignKeysOff: true },
  // row 188 (L47): mission_decision.autonomous marks an autonomous self-approval by the controller (L19), additive only
  { seq: 6, id: MIGRATION_0006_ID, sql: MIGRATION_0006_SQL },
  // 1.2.6 row 86 (MC-08, N-065): mission_document links a revision to the mission that produced it (owner or not), additive only
  { seq: 7, id: MIGRATION_0007_ID, sql: MIGRATION_0007_SQL },
  // 1.2.8 row 45b (SR8-05, N8-461; C14): decision answer provenance (answered_via, answered_attested) and request topic/proposal columns, additive only
  { seq: 8, id: MIGRATION_0008_ID, sql: MIGRATION_0008_SQL },
  // 1.3.3 row 5 (register section 1, C6): mission_row columns deliverables, knowledge, awaiting_human_check, additive only
  // 1.3.3 row 81: first migration with a reverse step (drops the three columns; their values are discarded)
  { seq: 9, id: MIGRATION_0009_ID, sql: MIGRATION_0009_SQL, down: MIGRATION_0009_DOWN_SQL, downLossSql: MIGRATION_0009_DOWN_LOSS_SQL },
  // 1.3.3 row 82 (ST-11, C6): revision retention marks (revision_prune) and the delete guard on revision; additive, deletes nothing.
  // Reverse step drops the table and its three triggers; the marks are recomputable, so it declares no downLossSql.
  { seq: 10, id: MIGRATION_0010_ID, sql: MIGRATION_0010_SQL, down: MIGRATION_0010_DOWN_SQL },
  // 1.3.3 row 144 (ST-11, row 83 finding): four indexes on foreign-key child columns of the revision cascade, additive only.
  // Reverse step drops them; an index holds no data, so it declares no downLossSql.
  { seq: 11, id: MIGRATION_0011_ID, sql: MIGRATION_0011_SQL, down: MIGRATION_0011_DOWN_SQL },
]

/**
 * Numbers held for later rows. Only the owner row may use its number, and must remove it here.
 * 0002: taken by row 64 (`20261106120000_datum_template_guard`, see MIGRATIONS).
 * 0003: taken by row 119a (`20261107000000_datum_mission`, see MIGRATIONS).
 * 0004: taken by row 149 (`20261107120000_datum_output_verification`, see MIGRATIONS).
 * 0005: taken by row 166 (`20261108000000_datum_mission_gsp_tiers`, see MIGRATIONS).
 * 0006: taken by row 188 (`20261108120000_datum_mission_autonomous_decision`, see MIGRATIONS).
 * 0007: taken by 1.2.6 row 86 (`20261112000000_datum_mission_document_link`, see MIGRATIONS).
 * 0008: taken by 1.2.8 row 45b (`20261114000000_datum_decision_provenance`, see MIGRATIONS).
 * 0009: taken by 1.3.3 row 5 (`20261117000000_datum_mission_row_contract`, see MIGRATIONS).
 * 0010: taken by 1.3.3 row 82 (`20261117120000_datum_revision_retention`, see MIGRATIONS).
 * 0011: taken by 1.3.3 row 144 (`20261117180000_datum_purge_fk_indexes`, see MIGRATIONS).
 */
export const RESERVED_MIGRATIONS: Readonly<Record<number, string>> = {}

export function latestSchemaId(): string {
  return MIGRATIONS[MIGRATIONS.length - 1]!.id
}

/**
 * Apply every pending migration. Returns the ids applied now.
 * `list` defaults to MIGRATIONS; tests pass a prefix (e.g. only 0001) to build an older store.
 */
export function applyMigrations(db: SqliteDb, opts: { release: string; now: () => number }, list: readonly Migration[] = MIGRATIONS): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
  const done = new Set(db.all<{ id: string }>("SELECT id FROM migration").map((r) => r.id))
  const known = new Set(MIGRATIONS.map((m) => m.id))
  const unknown = [...done].filter((id) => !known.has(id))
  if (unknown.length > 0) {
    throw new StoreError("STORE_SCHEMA_NEWER", "store was migrated by a newer release", { unknown })
  }
  const applied: string[] = []
  for (const m of list) {
    if (done.has(m.id)) continue
    // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched before BEGIN and restored after.
    const fkWasOn = m.foreignKeysOff ? db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys === 1 : false
    if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF")
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(m.sql)
      if (m.foreignKeysOff) {
        const broken = db.all("PRAGMA foreign_key_check")
        if (broken.length > 0) throw new StoreError("STORE_MIGRATION_FAILED", `migration ${m.id} left broken foreign keys`, { id: m.id, broken: broken.slice(0, 20) })
      }
      const now = opts.now()
      db.run("INSERT INTO migration (id, time_completed) VALUES (?, ?)", [m.id, now])
      if (m.seq === 1) {
        db.run("INSERT INTO store_meta (key, value) VALUES ('store_id', ?)", [newId()])
        db.run("INSERT INTO store_meta (key, value) VALUES ('created_by_release', ?)", [opts.release])
      }
      db.run("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [m.id])
      db.exec("COMMIT")
      applied.push(m.id)
    } catch (e) {
      try {
        db.exec("ROLLBACK")
      } catch {
        // already rolled back by SQLite
      }
      throw new StoreError("STORE_MIGRATION_FAILED", `migration ${m.id} failed`, { id: m.id }, e)
    } finally {
      if (fkWasOn) db.exec("PRAGMA foreign_keys = ON")
    }
  }
  return applied
}

/** `store_meta` key holding the reversal record: a JSON array, one entry per reversal, oldest first. Written only by a reversal. */
export const MIGRATION_REVERSALS_KEY = "migration_reversals"

export interface RevertOptions {
  release: string
  now: () => number
  /** Allow a reverse step whose `downLossSql` counts rows above zero. */
  acceptDataLoss?: boolean
}

export interface RevertResult {
  id: string
  seq: number
  /** `store_meta.schema_version` after the step: the id of the migration below the reverted one. */
  schemaVersion: string
  timeReverted: number
  dataLossRows: number
}

/**
 * 1.3.3 row 81 (ST-11): step back exactly one migration. Never automatic: `open` and `applyMigrations` do not call it,
 * no tool and no store method reaches it. The caller is an operator path (tests now, a recovery command later) that
 * holds the only connection to the store file: the host lock taken, no reader open.
 *
 * `opts.id` names the migration to revert and must be the newest applied one. In one BEGIN IMMEDIATE: run `down`
 * one statement at a time (row 145: so that a failing statement raises under bun:sqlite too, before anything is recorded),
 * delete the migration's row from `migration`, set `store_meta.schema_version` to the id below, append
 * `{ id, seq, timeReverted, release, dataLossRows }` to `store_meta.migration_reversals`. The journal then looks as
 * if the migration had never been applied, so `applyMigrations` applies it again and a release that does not know
 * the id opens the store.
 *
 * Refusals, with nothing written: `STORE_SCHEMA_NEWER` when the journal holds an id this code does not know (same
 * rule as forward); `STORE_MIGRATION_IRREVERSIBLE` with `details.reason` = `no-reverse-step` (the migration declares
 * no `down`), `not-latest`, `nothing-applied`, `first-migration`, or `data-loss` (`details.rows`). A reverse step
 * that throws, or leaves broken foreign keys under `foreignKeysOff`, is rolled back: `STORE_MIGRATION_FAILED` with
 * `details.direction = "down"`.
 * `list` defaults to MIGRATIONS; tests pass a prefix or add synthetic migrations.
 */
export function revertMigration(db: SqliteDb, opts: RevertOptions & { id: string }, list: readonly Migration[] = MIGRATIONS): RevertResult {
  const applied = appliedInOrder(db, list)
  const m = applied.at(-1)
  if (!m) throw new StoreError("STORE_MIGRATION_IRREVERSIBLE", `no migration is applied, nothing to revert (asked: ${opts.id})`, { id: opts.id, reason: "nothing-applied" })
  if (m.id !== opts.id) {
    throw new StoreError("STORE_MIGRATION_IRREVERSIBLE", `migration ${opts.id} is not the newest applied migration (${m.id}); only the newest can be reverted`, { id: opts.id, reason: "not-latest", latest: m.id })
  }
  if (m.down === undefined) {
    throw new StoreError("STORE_MIGRATION_IRREVERSIBLE", `migration ${m.id} declares no reverse step`, { id: m.id, seq: m.seq, reason: "no-reverse-step" })
  }
  const below = applied.at(-2)
  if (!below) throw new StoreError("STORE_MIGRATION_IRREVERSIBLE", `migration ${m.id} is the first migration of the store`, { id: m.id, seq: m.seq, reason: "first-migration" })
  // PRAGMA foreign_keys is a no-op inside a transaction, so it is switched before BEGIN and restored after (as in applyMigrations).
  const fkWasOn = m.foreignKeysOff ? db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")?.foreign_keys === 1 : false
  if (m.foreignKeysOff) db.exec("PRAGMA foreign_keys = OFF")
  db.exec("BEGIN IMMEDIATE")
  try {
    const dataLossRows = m.downLossSql ? Number(db.get<{ n: number | bigint }>(m.downLossSql)?.n ?? 0) : 0
    if (dataLossRows > 0 && opts.acceptDataLoss !== true) {
      throw new StoreError("STORE_MIGRATION_IRREVERSIBLE", `reverting migration ${m.id} discards data in ${dataLossRows} row(s); pass acceptDataLoss to proceed`, { id: m.id, seq: m.seq, reason: "data-loss", rows: dataLossRows })
    }
    // 1.3.3 row 145: one statement per call. bun:sqlite's exec drops the error of a statement that fails while running
    // (SQLITE_LOCKED, a constraint) whenever the SQL holds more than one statement or text after the last `;`, and runs
    // the rest; the step would then be recorded below without having run. A single statement raises under both drivers.
    for (const statement of splitStatements(m.down)) db.exec(statement)
    if (m.foreignKeysOff) {
      const broken = db.all("PRAGMA foreign_key_check")
      if (broken.length > 0) throw new StoreError("STORE_MIGRATION_FAILED", `reverse of migration ${m.id} left broken foreign keys`, { id: m.id, direction: "down", broken: broken.slice(0, 20) })
    }
    const timeReverted = opts.now()
    db.run("DELETE FROM migration WHERE id = ?", [m.id])
    db.run("INSERT INTO store_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [below.id])
    const record = JSON.parse(db.get<{ value: string }>("SELECT value FROM store_meta WHERE key = ?", [MIGRATION_REVERSALS_KEY])?.value ?? "[]") as unknown[]
    db.run("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
      MIGRATION_REVERSALS_KEY,
      JSON.stringify([...record, { id: m.id, seq: m.seq, timeReverted, release: opts.release, dataLossRows }]),
    ])
    db.exec("COMMIT")
    return { id: m.id, seq: m.seq, schemaVersion: below.id, timeReverted, dataLossRows }
  } catch (e) {
    try {
      db.exec("ROLLBACK")
    } catch {
      // already rolled back by SQLite
    }
    if (e instanceof StoreError && e.code === "STORE_MIGRATION_IRREVERSIBLE") throw e
    throw new StoreError("STORE_MIGRATION_FAILED", `reverse of migration ${m.id} failed`, { id: m.id, direction: "down" }, e)
  } finally {
    if (fkWasOn) db.exec("PRAGMA foreign_keys = ON")
  }
}

/**
 * Revert, newest first, until `toId` is the newest applied migration; `toId` itself stays. Each step is its own
 * transaction and its own record, so a refusal part-way leaves the store at the last migration that was reverted
 * cleanly, never between two. Returns the steps done (empty when the store is already at `toId`).
 */
export function revertMigrations(db: SqliteDb, opts: RevertOptions, toId: string, list: readonly Migration[] = MIGRATIONS): RevertResult[] {
  const applied = appliedInOrder(db, list)
  const at = applied.findIndex((m) => m.id === toId)
  if (at < 0) throw new StoreError("STORE_MIGRATION_IRREVERSIBLE", `migration ${toId} is not applied, cannot revert to it`, { id: toId, reason: "target-not-applied" })
  return applied
    .slice(at + 1)
    .reverse()
    .map((m) => revertMigration(db, { ...opts, id: m.id }, list))
}

/**
 * 1.3.3 row 145: split SQL into single statements, each from its first token to its closing `;` (no text after it).
 * Skips `--` and `/* *\/` comments and `'…'`, `"…"`, `` `…` ``, `[…]` quoting; inside `CREATE [TEMP] TRIGGER` a `;`
 * closes the statement only as `; END ;` (the rule of sqlite3_complete). Text after the last `;` is a statement too.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = []
  let start = -1
  let head: string[] = []
  let sinceSemi: string[] = []
  let i = 0
  while (i < sql.length) {
    const c = sql[i]!
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i)
      i = nl < 0 ? sql.length : nl + 1
      continue
    }
    if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2)
      i = end < 0 ? sql.length : end + 2
      continue
    }
    if (/\s/.test(c)) {
      i++
      continue
    }
    if (start < 0) start = i
    if (c === ";") {
      const trigger = head[0] === "CREATE" && (head[1] === "TRIGGER" || ((head[1] === "TEMP" || head[1] === "TEMPORARY") && head[2] === "TRIGGER"))
      if (trigger && !(sinceSemi.length === 1 && sinceSemi[0] === "END")) {
        sinceSemi = []
        i++
        continue
      }
      out.push(sql.slice(start, i + 1))
      start = -1
      head = []
      sinceSemi = []
      i++
      continue
    }
    const close = c === "[" ? "]" : c === "'" || c === '"' || c === "`" ? c : undefined
    if (close) {
      let j = i + 1
      while (j < sql.length && !(sql[j] === close && !(close !== "]" && sql[j + 1] === close))) j += sql[j] === close ? 2 : 1
      i = j + 1
      if (head.length < 3) head.push("?")
      sinceSemi.push("?")
      continue
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(sql.slice(i, i + 64))?.[0]
    const token = word ? word.toUpperCase() : c
    if (head.length < 3) head.push(token)
    sinceSemi.push(token)
    i += word ? word.length : 1
  }
  if (start >= 0) out.push(sql.slice(start).trimEnd())
  return out
}

/** The applied migrations in seq order. Refuses a journal id that neither MIGRATIONS nor `list` knows. Creates nothing. */
function appliedInOrder(db: SqliteDb, list: readonly Migration[]): Migration[] {
  if (!db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'migration'")) return []
  const done = new Set(db.all<{ id: string }>("SELECT id FROM migration").map((r) => r.id))
  const known = new Map([...MIGRATIONS, ...list].map((m) => [m.id, m]))
  const unknown = [...done].filter((id) => !known.has(id))
  if (unknown.length > 0) throw new StoreError("STORE_SCHEMA_NEWER", "store was migrated by a newer release", { unknown })
  return [...known.values()].filter((m) => done.has(m.id)).sort((a, b) => a.seq - b.seq)
}
