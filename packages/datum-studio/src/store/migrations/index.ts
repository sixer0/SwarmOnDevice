import type { SqliteDb } from "../driver-types.ts"
import { StoreError } from "../errors.ts"
import { newId } from "../ids.ts"
import { MIGRATION_0001_SQL } from "./0001_datum_studio_init.ts"
import { MIGRATION_0002_ID, MIGRATION_0002_SQL } from "./0002_datum_template_guard.ts"
import { MIGRATION_0003_ID, MIGRATION_0003_SQL } from "./0003_datum_mission.ts"

/**
 * Store migrations (spec §3.1: own runner, journal table shaped like core's
 * `migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`; each migration in one BEGIN IMMEDIATE).
 */
export interface Migration {
  seq: number
  id: string
  sql: string
}

export const MIGRATIONS: readonly Migration[] = [
  { seq: 1, id: "20261106000000_datum_studio_init", sql: MIGRATION_0001_SQL },
  // row 64: template guard columns (templates spec §5.5), additive only
  { seq: 2, id: MIGRATION_0002_ID, sql: MIGRATION_0002_SQL },
  // row 119a: mission contract tables (U19, U20, C57; masterplan/01_specs_mission_contract.md §7), additive only
  { seq: 3, id: MIGRATION_0003_ID, sql: MIGRATION_0003_SQL },
]

/**
 * Numbers held for later rows. Only the owner row may use its number, and must remove it here.
 * 0002: taken by row 64 (`20261106120000_datum_template_guard`, see MIGRATIONS).
 * 0003: taken by row 119a (`20261107000000_datum_mission`, see MIGRATIONS).
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
    db.exec("BEGIN IMMEDIATE")
    try {
      db.exec(m.sql)
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
    }
  }
  return applied
}
