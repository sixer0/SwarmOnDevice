/**
 * Swarm 1.3.3 row 81 (ST-11): reversal in the store migration runner.
 * `revertMigration` steps back exactly one migration, `revertMigrations` repeats it down to a named id. Both are
 * operator functions: no tool, no store method and no `open` path calls them.
 * Temp folders: ROW81_133_TEST_DIR, else the OS temp folder. Nothing outside it is written; the live store is never opened.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { openSqlite } from "#sqlite"
import type { SqliteDb } from "./driver-types.ts"
import { isStoreError, type StoreErrorCode } from "./errors.ts"
import { applyMigrations, MIGRATION_REVERSALS_KEY, MIGRATIONS, revertMigration, revertMigrations, type Migration } from "./migrations/index.ts"
import { MIGRATION_0008_ID } from "./migrations/0008_datum_decision_provenance.ts"
import { MIGRATION_0009_ID } from "./migrations/0009_datum_mission_row_contract.ts"
import { MIGRATION_0009_DOWN_LOSS_SQL, MIGRATION_0009_DOWN_SQL } from "./migrations/0009_datum_mission_row_contract.down.ts"
import { pinBuiltinMissionTypes } from "./mission/index.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect } = T

const BASE = process.env.ROW81_133_TEST_DIR ?? join(tmpdir(), "row81-133-migration-reversal-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
let tick = 1_800_000_000_000
const clock = () => ++tick
const UP_TO_8 = MIGRATIONS.filter((m) => m.seq <= 8)
const UP_TO_9 = MIGRATIONS.filter((m) => m.seq <= 9)

function open(name: string): SqliteDb {
  const dir = join(RUN, name)
  mkdirSync(dir, { recursive: true })
  const db = openSqlite(join(dir, "datum-studio.sqlite"))
  db.exec("PRAGMA foreign_keys = ON")
  return db
}

/** A store as 1.3.2 leaves it: migrations 0001-0008 (byte-identical in 1.3.2), two missions with two rows each. */
function store132(name: string): SqliteDb {
  const db = open(name)
  applyMigrations(db, { release: "1.3.2", now: clock }, UP_TO_8)
  pinBuiltinMissionTypes(db, clock(), () => {})
  for (const id of ["2026-11-16_open", "2026-11-16_other"]) {
    db.run("INSERT INTO mission (id, title, type_id, type_version, owner, project_dir, time_created, time_updated) VALUES (?, 't', 'feature-release', 1, 'master-controller', '/p', 1, 1)", [id])
    for (const r of ["1", "2"]) {
      db.run(
        "INSERT INTO mission_row (mission_id, row_id, phase_id, kind, title, agent, model_tier, size, output, verification, note, ord, time_created, time_updated) VALUES (?, ?, 'implementation', 'implementation', ?, 'coder-execution', 'thinker', 'S', 'o', 'v', 'old note', ?, 1, 1)",
        [id, r, `Row ${r} title`, Number(r)],
      )
    }
  }
  return db
}

/** Every schema object with its SQL text, in name order: equal dumps mean equal schemas. */
function schema(db: SqliteDb): string {
  return db
    .all<{ type: string; name: string; tbl_name: string; sql: string | null }>("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name")
    .map((r) => `${r.type}|${r.name}|${r.tbl_name}|${r.sql ?? ""}`)
    .join("\n")
}
const journal = (db: SqliteDb) => db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id)
const meta = (db: SqliteDb) => Object.fromEntries(db.all<{ key: string; value: string }>("SELECT key, value FROM store_meta ORDER BY key").map((r) => [r.key, r.value]))
const reversals = (db: SqliteDb) => JSON.parse(meta(db)[MIGRATION_REVERSALS_KEY] ?? "[]") as Array<Record<string, unknown>>
/** The columns of mission_row that exist before 0009, as one string per row. */
const OLD_COLS = "mission_id, row_id, phase_id, kind, title, agent, model_tier, size, status, output, verification, note, resources, ord, time_created, time_updated"
const oldRows = (db: SqliteDb) => db.all<Record<string, unknown>>(`SELECT ${OLD_COLS} FROM mission_row ORDER BY mission_id, row_id`).map((r) => JSON.stringify(r))
const healthy = (db: SqliteDb) => [db.all("PRAGMA foreign_key_check").length, db.all<{ integrity_check: string }>("PRAGMA integrity_check").map((x) => x.integrity_check).join()]

function refused(fn: () => unknown, code: StoreErrorCode): { message: string; details: Record<string, unknown> } {
  try {
    fn()
  } catch (e) {
    if (!isStoreError(e, code)) throw new Error(`expected ${code}, got ${e instanceof Error ? e.message : String(e)}`)
    return { message: e.message, details: e.details ?? {} }
  }
  throw new Error(`expected ${code}, nothing thrown`)
}

describe("row 81: migration reversal", () => {
  test("which migrations declare a reverse step: 0009 only; 0001-0008 none", () => {
    expect(MIGRATIONS.filter((m) => m.down !== undefined).map((m) => m.seq)).toEqual([9, 10, 11]) // 1.3.3 row 82: + 0010, 1.3.3 row 144: + 0011
    expect(MIGRATIONS.find((m) => m.seq === 9)!.down).toBe(MIGRATION_0009_DOWN_SQL)
    expect(MIGRATIONS.find((m) => m.seq === 9)!.downLossSql).toBe(MIGRATION_0009_DOWN_LOSS_SQL)
    expect(MIGRATIONS.filter((m) => m.seq <= 8).every((m) => m.down === undefined && m.downLossSql === undefined)).toBe(true)
  })

  test("a 1.3.2-shaped store migrates forward as before: same journal shape, no reversal record", () => {
    const db = store132("forward-compat")
    try {
      const before = oldRows(db)
      expect(journal(db)).toEqual(UP_TO_8.map((m) => m.id))
      expect(meta(db).schema_version).toBe(MIGRATION_0008_ID)
      expect(meta(db).created_by_release).toBe("1.3.2")
      expect(applyMigrations(db, { release: "1.3.3", now: clock })).toEqual(MIGRATIONS.filter((m) => m.seq > 8).map((m) => m.id))
      expect(applyMigrations(db, { release: "1.3.3", now: clock })).toEqual([])
      expect(journal(db)).toEqual(MIGRATIONS.map((m) => m.id))
      expect(db.all<{ name: string; type: string; notnull: number; pk: number }>("PRAGMA table_info(migration)").map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`)).toEqual(["id:TEXT:0:1", "time_completed:INTEGER:1:0"])
      // the forward path writes no key beyond the three it always wrote
      expect(Object.keys(meta(db))).toEqual(["created_by_release", "schema_version", "store_id"])
      expect(meta(db).schema_version).toBe(MIGRATIONS.at(-1)!.id)
      expect(meta(db).created_by_release).toBe("1.3.2")
      expect(oldRows(db)).toEqual(before)
      expect(healthy(db)).toEqual([0, "ok"])
    } finally {
      db.close()
    }
  })

  test("forward, reverse, forward: the schema returns each time and the row data outside the dropped columns is kept", () => {
    const db = store132("round-trip")
    try {
      const schema8 = schema(db)
      const rows8 = oldRows(db)
      const storeId = meta(db).store_id
      expect(applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)).toEqual([MIGRATION_0009_ID])
      const schema9 = schema(db)
      expect(schema9).not.toBe(schema8)

      const out = revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0009_ID }, UP_TO_9)
      expect([out.id, out.seq, out.schemaVersion, out.dataLossRows]).toEqual([MIGRATION_0009_ID, 9, MIGRATION_0008_ID, 0])
      expect(schema(db)).toBe(schema8)
      expect(oldRows(db)).toEqual(rows8)
      expect(journal(db)).toEqual(UP_TO_8.map((m) => m.id))
      expect(meta(db).schema_version).toBe(MIGRATION_0008_ID)
      expect(meta(db).store_id).toBe(storeId)
      expect(reversals(db)).toEqual([{ id: MIGRATION_0009_ID, seq: 9, timeReverted: out.timeReverted, release: "1.3.3", dataLossRows: 0 }])
      expect(healthy(db)).toEqual([0, "ok"])
      // foreign keys were on before and are on after
      expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1)

      expect(applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)).toEqual([MIGRATION_0009_ID])
      expect(schema(db)).toBe(schema9)
      expect(oldRows(db)).toEqual(rows8)
      expect(journal(db)).toEqual(UP_TO_9.map((m) => m.id))
      expect(meta(db).schema_version).toBe(MIGRATION_0009_ID)
      expect(db.all<{ d: string; k: string | null; a: string | null }>("SELECT deliverables AS d, knowledge AS k, awaiting_human_check AS a FROM mission_row").map((r) => `${r.d}:${r.k ?? "-"}:${r.a ?? "-"}`)).toEqual(["[]:-:-", "[]:-:-", "[]:-:-", "[]:-:-"])
      // the record of the reversal stays after the migration is applied again
      expect(reversals(db).length).toBe(1)
      expect(healthy(db)).toEqual([0, "ok"])
    } finally {
      db.close()
    }
  })

  test("0009 reverse step discards the three columns: refused while a row carries data, unless the operator accepts the loss", () => {
    const db = store132("data-loss")
    try {
      applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)
      db.run(`UPDATE mission_row SET deliverables = '[{"path":"deliverables/x/a.pdf"}]' WHERE mission_id = '2026-11-16_open' AND row_id = '1'`)
      db.run(`UPDATE mission_row SET knowledge = '{"domains":[]}' WHERE mission_id = '2026-11-16_open' AND row_id = '2'`)
      db.run(`UPDATE mission_row SET awaiting_human_check = '{"checks":["labels_verified"]}', note = 'kept note' WHERE mission_id = '2026-11-16_other' AND row_id = '1'`)
      const schema9 = schema(db)
      const rows9 = oldRows(db)

      const r = refused(() => revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0009_ID }, UP_TO_9), "STORE_MIGRATION_IRREVERSIBLE")
      expect([r.details.id, r.details.reason, r.details.rows]).toEqual([MIGRATION_0009_ID, "data-loss", 3])
      expect(r.message).toContain(MIGRATION_0009_ID)
      expect(schema(db)).toBe(schema9)
      expect(journal(db)).toEqual(UP_TO_9.map((m) => m.id))
      expect(reversals(db)).toEqual([])

      const out = revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0009_ID, acceptDataLoss: true }, UP_TO_9)
      expect(out.dataLossRows).toBe(3)
      expect(reversals(db).map((x) => x.dataLossRows)).toEqual([3])
      // every other column of every row survives, including a note written after 0009
      expect(oldRows(db)).toEqual(rows9)
      expect(db.all<{ name: string }>("PRAGMA table_info(mission_row)").map((c) => c.name).filter((n) => ["deliverables", "knowledge", "awaiting_human_check"].includes(n))).toEqual([])
      // applied again, the columns come back empty: the discarded values are not restored
      applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)
      expect(Number(db.get<{ n: number }>(MIGRATION_0009_DOWN_LOSS_SQL)!.n)).toBe(0)
      expect(healthy(db)).toEqual([0, "ok"])
    } finally {
      db.close()
    }
  })

  test("a migration without a reverse step is refused by name and nothing changes", () => {
    const db = store132("irreversible")
    try {
      const before = [schema(db), journal(db).join(), JSON.stringify(meta(db))]
      const r = refused(() => revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0008_ID }), "STORE_MIGRATION_IRREVERSIBLE")
      expect([r.details.id, r.details.seq, r.details.reason]).toEqual([MIGRATION_0008_ID, 8, "no-reverse-step"])
      expect(r.message).toContain(MIGRATION_0008_ID)
      expect([schema(db), journal(db).join(), JSON.stringify(meta(db))]).toEqual(before)

      // revertMigrations stops at the same place: 0009 is reverted, 0008 is refused, the store rests at 0008
      applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)
      const r2 = refused(() => revertMigrations(db, { release: "1.3.3", now: clock }, MIGRATIONS[0]!.id, UP_TO_9), "STORE_MIGRATION_IRREVERSIBLE")
      expect(r2.details.id).toBe(MIGRATION_0008_ID)
      expect(journal(db)).toEqual(UP_TO_8.map((m) => m.id))
      expect(meta(db).schema_version).toBe(MIGRATION_0008_ID)
      expect(reversals(db).map((x) => x.id)).toEqual([MIGRATION_0009_ID])
    } finally {
      db.close()
    }
  })

  test("the migration named must be the newest applied one; an empty store has nothing to revert", () => {
    const db = store132("not-latest")
    try {
      applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)
      const r = refused(() => revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0008_ID }, UP_TO_9), "STORE_MIGRATION_IRREVERSIBLE")
      expect([r.details.id, r.details.reason, r.details.latest]).toEqual([MIGRATION_0008_ID, "not-latest", MIGRATION_0009_ID])
      expect(journal(db)).toEqual(UP_TO_9.map((m) => m.id))
    } finally {
      db.close()
    }
    const empty = open("empty")
    try {
      const r = refused(() => revertMigration(empty, { release: "1.3.3", now: clock, id: MIGRATION_0009_ID }), "STORE_MIGRATION_IRREVERSIBLE")
      expect(r.details.reason).toBe("nothing-applied")
      // a refusal on an empty file creates nothing
      expect(empty.all("SELECT name FROM sqlite_master")).toEqual([])
    } finally {
      empty.close()
    }
  })

  test("a store newer than the code is refused in both directions (STORE_SCHEMA_NEWER unchanged)", () => {
    const db = store132("newer")
    try {
      applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)
      db.run("INSERT INTO migration (id, time_completed) VALUES ('20991231000000_from_the_future', 1)")
      const before = [schema(db), journal(db).join(), JSON.stringify(meta(db))]
      const down = refused(() => revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0009_ID, acceptDataLoss: true }, UP_TO_9), "STORE_SCHEMA_NEWER")
      expect(down.details.unknown).toEqual(["20991231000000_from_the_future"])
      const up = refused(() => applyMigrations(db, { release: "1.3.3", now: clock }), "STORE_SCHEMA_NEWER")
      expect(up.details.unknown).toEqual(["20991231000000_from_the_future"])
      expect([schema(db), journal(db).join(), JSON.stringify(meta(db))]).toEqual(before)
    } finally {
      db.close()
    }
  })

  test("an older release opens the store again once 0009 is reverted (its runner knows only 0001-0008)", () => {
    const db = store132("downgrade")
    try {
      applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)
      const known132 = new Set(UP_TO_8.map((m) => m.id))
      expect(journal(db).filter((id) => !known132.has(id))).toEqual([MIGRATION_0009_ID])
      revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0009_ID }, UP_TO_9)
      // what 1.3.2 checks at open: no journal id it does not know; and it applies nothing
      expect(journal(db).filter((id) => !known132.has(id))).toEqual([])
      expect(applyMigrations(db, { release: "1.3.2", now: clock }, UP_TO_8)).toEqual([])
    } finally {
      db.close()
    }
  })

  // Synthetic migrations after 0001-0009: they prove the runner, not a shipped migration.
  const SYN_A: Migration = { seq: 101, id: "20990101000000_syn_a", sql: "CREATE TABLE syn_a (id TEXT PRIMARY KEY, v TEXT);", down: "DROP TABLE syn_a;" }
  const SYN_B: Migration = { seq: 102, id: "20990102000000_syn_b", sql: "CREATE TABLE syn_b (id TEXT PRIMARY KEY, a TEXT REFERENCES syn_a(id));", down: "DROP TABLE syn_b;" }

  test("revertMigrations walks back to the named id, one transaction and one record per step", () => {
    const db = store132("walk")
    try {
      const list = [...UP_TO_9, SYN_A, SYN_B]
      applyMigrations(db, { release: "1.3.3", now: clock }, UP_TO_9)
      const schema9 = schema(db)
      // first-time apply of the synthetic ids only: a second applyMigrations would refuse them as unknown, by design
      expect(applyMigrations(db, { release: "1.3.3", now: clock }, list)).toEqual([SYN_A.id, SYN_B.id])
      expect(revertMigrations(db, { release: "1.3.3", now: clock }, MIGRATION_0009_ID, list).map((r) => r.id)).toEqual([SYN_B.id, SYN_A.id])
      expect(schema(db)).toBe(schema9)
      expect(journal(db)).toEqual(UP_TO_9.map((m) => m.id))
      expect(meta(db).schema_version).toBe(MIGRATION_0009_ID)
      expect(reversals(db).map((x) => x.id)).toEqual([SYN_B.id, SYN_A.id])
      // already at the target: nothing to do, nothing recorded
      expect(revertMigrations(db, { release: "1.3.3", now: clock }, MIGRATION_0009_ID, list)).toEqual([])
      expect(reversals(db).length).toBe(2)
      // a target that is not applied is refused before anything is reverted
      const r = refused(() => revertMigrations(db, { release: "1.3.3", now: clock }, SYN_A.id, list), "STORE_MIGRATION_IRREVERSIBLE")
      expect([r.details.id, r.details.reason]).toEqual([SYN_A.id, "target-not-applied"])
      expect(journal(db)).toEqual(UP_TO_9.map((m) => m.id))
    } finally {
      db.close()
    }
  })

  test("a reverse step that fails is rolled back whole: schema, journal and record unchanged", () => {
    const db = store132("failing-down")
    try {
      const bad: Migration = { ...SYN_A, down: "DROP TABLE syn_a; DROP TABLE no_such_table;" }
      const list = [...UP_TO_8, bad]
      applyMigrations(db, { release: "1.3.3", now: clock }, list)
      db.run("INSERT INTO syn_a (id, v) VALUES ('1', 'kept')")
      const before = [schema(db), journal(db).join(), JSON.stringify(meta(db))]
      const r = refused(() => revertMigration(db, { release: "1.3.3", now: clock, id: bad.id }, list), "STORE_MIGRATION_FAILED")
      expect([r.details.id, r.details.direction]).toEqual([bad.id, "down"])
      expect([schema(db), journal(db).join(), JSON.stringify(meta(db))]).toEqual(before)
      expect(db.get<{ v: string }>("SELECT v FROM syn_a")!.v).toBe("kept")
      // no transaction is left open
      db.exec("BEGIN IMMEDIATE")
      db.exec("ROLLBACK")
    } finally {
      db.close()
    }
  })

  test("foreignKeysOff applies to the reverse step too: broken foreign keys roll it back, the pragma is restored", () => {
    const db = store132("fk-off")
    try {
      // a rebuild-style reverse step: the parent table is recreated empty while a child row still points at it
      const a: Migration = {
        seq: 103,
        id: "20990103000000_syn_fk",
        sql: "CREATE TABLE syn_a (id TEXT PRIMARY KEY, v TEXT); CREATE TABLE syn_b (id TEXT PRIMARY KEY, a TEXT REFERENCES syn_a(id));",
        down: "DROP TABLE syn_a; CREATE TABLE syn_a (id TEXT PRIMARY KEY);",
        foreignKeysOff: true,
      }
      const list = [...UP_TO_8, a]
      applyMigrations(db, { release: "1.3.3", now: clock }, list)
      db.run("INSERT INTO syn_a (id, v) VALUES ('p', 'x')")
      db.run("INSERT INTO syn_b (id, a) VALUES ('c', 'p')")
      const r = refused(() => revertMigration(db, { release: "1.3.3", now: clock, id: a.id }, list), "STORE_MIGRATION_FAILED")
      expect([r.details.id, r.details.direction]).toEqual([a.id, "down"])
      expect(db.get<{ v: string }>("SELECT v FROM syn_a")!.v).toBe("x")
      expect(journal(db)).toEqual(list.map((m) => m.id))
      expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1)
      // without the dangling child the same step passes
      db.run("DELETE FROM syn_b")
      expect(revertMigration(db, { release: "1.3.3", now: clock, id: a.id }, list).id).toBe(a.id)
      expect(db.get<{ foreign_keys: number }>("PRAGMA foreign_keys")!.foreign_keys).toBe(1)
    } finally {
      db.close()
    }
  })

  test("reversal is an operator function: the store, the host and the tool scripts never call it", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = join(here, "..", "..")
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) {
          if (name !== "node_modules") walk(p)
        } else if (/\.(ts|tsx|mts|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) files.push(p)
      }
    }
    walk(join(pkg, "src"))
    walk(join(pkg, "vendor", "scripts"))
    const users = files.filter((f) => /revertMigrations?\s*\(|import[^\n]*revertMigration|0009_datum_mission_row_contract\.down/.test(readFileSync(f, "utf8"))).map((f) => f.slice(pkg.length + 1))
    expect(users.sort()).toEqual(["src/store/migrations/index.ts"])
  })
})
