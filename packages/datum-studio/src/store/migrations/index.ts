import type { SqliteDb } from "../driver-types.ts"
import { StoreError } from "../errors.ts"
import { newId } from "../ids.ts"
import { MIGRATION_0001_SQL } from "./0001_datum_studio_init.ts"
import { MIGRATION_0002_ID, MIGRATION_0002_SQL } from "./0002_datum_template_guard.ts"
import { MIGRATION_0003_ID, MIGRATION_0003_SQL } from "./0003_datum_mission.ts"
import { MIGRATION_0004_ID, MIGRATION_0004_SQL } from "./0004_datum_output_verification.ts"
import { MIGRATION_0005_ID, MIGRATION_0005_SQL } from "./0005_datum_mission_gsp_tiers.ts"
import { MIGRATION_0006_ID, MIGRATION_0006_SQL } from "./0006_datum_mission_autonomous_decision.ts"

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
]

/**
 * Numbers held for later rows. Only the owner row may use its number, and must remove it here.
 * 0002: taken by row 64 (`20261106120000_datum_template_guard`, see MIGRATIONS).
 * 0003: taken by row 119a (`20261107000000_datum_mission`, see MIGRATIONS).
 * 0004: taken by row 149 (`20261107120000_datum_output_verification`, see MIGRATIONS).
 * 0005: taken by row 166 (`20261108000000_datum_mission_gsp_tiers`, see MIGRATIONS).
 * 0006: taken by row 188 (`20261108120000_datum_mission_autonomous_decision`, see MIGRATIONS).
 * Nothing is reserved now.
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
