/**
 * Swarm 1.3.3 row 145 (ST-11, finding of row 144): a reverse step is recorded in `store_meta.migration_reversals`
 * only when every statement of it ran, in the same transaction, under bun:sqlite and node:sqlite alike.
 * Cause found in row 145: bun:sqlite's `Database.exec` with more than one statement (or any text after the last `;`)
 * drops the error of a statement that fails while running (SQLITE_LOCKED, a constraint) and carries on with the next
 * statement. The runner therefore runs a reverse step one statement at a time.
 * Temp folders: ROW145_133_TEST_DIR, else the OS temp folder. The live store is never opened.
 */
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import type { SqliteDb } from "./driver-types.ts"
import { isStoreError } from "./errors.ts"
import { applyMigrations, MIGRATION_REVERSALS_KEY, MIGRATIONS, revertMigration, type Migration } from "./migrations/index.ts"
import { MIGRATION_0011_ID } from "./migrations/0011_datum_purge_fk_indexes.ts"

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
const T = (isBun ? await import("bun:test") : await import("./test-harness.node.ts")) as unknown as typeof import("./test-harness.node.ts")
const { describe, test, expect } = T

const BASE = process.env.ROW145_133_TEST_DIR ?? join(tmpdir(), "row145-133-reversal-ledger-test")
mkdirSync(BASE, { recursive: true })
const RUN = mkdtempSync(join(BASE, `${isBun ? "bun" : "node"}-`))
let tick = 1_800_000_000_000
const clock = () => ++tick
const UP_TO_8 = MIGRATIONS.filter((m) => m.seq <= 8)
const FK_INDEXES = ["doc_block_chapter_idx", "doc_block_doc_section_idx", "doc_subsection_revision_idx", "render_job_revision_idx"]

function open(name: string): SqliteDb {
  const dir = join(RUN, name)
  mkdirSync(dir, { recursive: true })
  const db = openSqlite(join(dir, "datum-studio.sqlite"))
  db.exec("PRAGMA foreign_keys = ON")
  return db
}

const schema = (db: SqliteDb) =>
  db
    .all<{ type: string; name: string; sql: string | null }>("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .map((r) => `${r.type}|${r.name}|${r.sql ?? ""}`)
    .join("\n")
const journal = (db: SqliteDb) => db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id)
const meta = (db: SqliteDb) => Object.fromEntries(db.all<{ key: string; value: string }>("SELECT key, value FROM store_meta ORDER BY key").map((r) => [r.key, r.value]))
const reversals = (db: SqliteDb) => JSON.parse(meta(db)[MIGRATION_REVERSALS_KEY] ?? "[]") as Array<{ id: string }>
const state = (db: SqliteDb) => [schema(db), journal(db).join(), JSON.stringify(meta(db))]

/** Runs the revert; returns the error code it raised, or "ok". Any error that is not a StoreError is rethrown. */
function attempt(fn: () => unknown): string {
  try {
    fn()
    return "ok"
  } catch (e) {
    if (isStoreError(e, "STORE_MIGRATION_FAILED")) return "STORE_MIGRATION_FAILED"
    throw e
  }
}

/** A synthetic migration on top of 0008: one table to drop, one keyed table whose duplicate insert fails at step time. */
const SYN: Migration = {
  seq: 145,
  id: "20990145000000_syn_row145",
  sql: "CREATE TABLE syn_a (id TEXT PRIMARY KEY, v TEXT); CREATE TABLE syn_k (k INTEGER PRIMARY KEY); INSERT INTO syn_k (k) VALUES (1);",
}

function synStore(name: string, down: string): { db: SqliteDb; list: Migration[]; m: Migration } {
  const db = open(name)
  const m = { ...SYN, down }
  const list = [...UP_TO_8, m]
  applyMigrations(db, { release: "1.3.3", now: clock }, list)
  db.run("INSERT INTO syn_a (id, v) VALUES ('1', 'kept')")
  return { db, list, m }
}

describe("row 145: the reversal ledger is written only after the whole reverse step ran", () => {
  test("a statement that fails while running, followed by more statements: refused, schema and ledger unchanged", () => {
    // Under bun:sqlite before row 145 the duplicate key error was dropped, DROP TABLE ran and the reversal was recorded.
    const { db, list, m } = synStore("fail-middle", "-- reverse of syn_row145\nINSERT INTO syn_k (k) VALUES (1);\nDROP TABLE syn_a;\n")
    try {
      const before = state(db)
      expect(attempt(() => revertMigration(db, { release: "1.3.3", now: clock, id: m.id }, list))).toBe("STORE_MIGRATION_FAILED")
      expect(state(db)).toEqual(before)
      expect(reversals(db)).toEqual([])
      expect(db.get<{ v: string }>("SELECT v FROM syn_a")!.v).toBe("kept")
      db.exec("BEGIN IMMEDIATE")
      db.exec("ROLLBACK")
    } finally {
      db.close()
    }
  })

  test("the last statement fails after an earlier one ran: the earlier one is rolled back with it", () => {
    const { db, list, m } = synStore("fail-last", "-- reverse of syn_row145\nDROP TABLE syn_a;\nINSERT INTO syn_k (k) VALUES (1);\n")
    try {
      const before = state(db)
      expect(attempt(() => revertMigration(db, { release: "1.3.3", now: clock, id: m.id }, list))).toBe("STORE_MIGRATION_FAILED")
      expect(state(db)).toEqual(before)
      expect(reversals(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  test("statements split correctly: comments, quoted ';', and a trigger body run as written", () => {
    const down = [
      "-- reverse of syn_row145; this comment has a ';' in it",
      "/* block comment; also ';' */",
      "DROP TABLE syn_a;",
      "INSERT INTO syn_k (k) VALUES (2); -- trailing comment ; here",
      "CREATE TABLE syn_log (msg TEXT, \"we;ird\" TEXT DEFAULT 'a;b');",
      "CREATE TRIGGER syn_k_log AFTER INSERT ON syn_k BEGIN",
      "  INSERT INTO syn_log (msg) VALUES ('k;' || CASE WHEN NEW.k > 5 THEN 'big' ELSE 'small' END);",
      "  INSERT INTO syn_log (msg) VALUES ('end');",
      "END;",
      "",
    ].join("\n")
    const { db, list, m } = synStore("split", down)
    try {
      const r = revertMigration(db, { release: "1.3.3", now: clock, id: m.id }, list)
      expect(r.id).toBe(m.id)
      expect(db.get("SELECT 1 FROM sqlite_master WHERE name = 'syn_a'") ?? null).toBeNull()
      expect(db.all<{ k: number }>("SELECT k FROM syn_k ORDER BY k").map((x) => x.k)).toEqual([1, 2])
      db.run("INSERT INTO syn_k (k) VALUES (9)")
      expect(db.all<{ msg: string; w: string }>('SELECT msg, "we;ird" AS w FROM syn_log ORDER BY rowid').map((x) => `${x.msg}/${x.w}`)).toEqual(["k;big/a;b", "end/a;b"])
      expect(reversals(db).map((x) => x.id)).toEqual([m.id])
    } finally {
      db.close()
    }
  })

  test("an EXPLAIN left on the handle (row 144's case): the record exists exactly when the indexes are gone", () => {
    // bun:sqlite 1.3.14 leaves the EXPLAIN statement active, so DROP INDEX gets SQLITE_LOCKED; node:sqlite does not.
    // Either outcome is allowed; a ledger entry with the indexes still present is not.
    const db = open("explain")
    try {
      applyMigrations(db, { release: "1.3.3", now: clock })
      expect(db.all("EXPLAIN QUERY PLAN SELECT id FROM doc_block WHERE chapter_id = ?", ["x"]).length).toBeGreaterThan(0)
      const before = state(db)
      const outcome = attempt(() => revertMigration(db, { release: "1.3.3", now: clock, id: MIGRATION_0011_ID }))
      const left = db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${FK_INDEXES.map(() => "?").join(", ")})`, FK_INDEXES).length
      if (outcome === "ok") {
        expect(left).toBe(0)
        expect(reversals(db).map((x) => x.id)).toEqual([MIGRATION_0011_ID])
        expect(journal(db)).not.toContain(MIGRATION_0011_ID)
        return
      }
      expect(outcome).toBe("STORE_MIGRATION_FAILED")
      expect(left).toBe(4)
      expect(state(db)).toEqual(before)
      expect(reversals(db)).toEqual([])
    } finally {
      db.close()
    }
  })

  test("the real reverse steps 0011, 0010, 0009 still run whole and record one entry each", () => {
    const db = open("real")
    try {
      applyMigrations(db, { release: "1.3.3", now: clock })
      const ids = MIGRATIONS.filter((m) => m.seq >= 9).map((m) => m.id).reverse()
      for (const id of ids) revertMigration(db, { release: "1.3.3", now: clock, id })
      expect(reversals(db).map((x) => x.id)).toEqual(ids)
      expect(db.get("SELECT 1 FROM sqlite_master WHERE name IN ('revision_prune', 'doc_block_chapter_idx')") ?? null).toBeNull()
      expect(db.all<{ name: string }>("SELECT name FROM pragma_table_info('mission_row') WHERE name IN ('deliverables', 'knowledge', 'awaiting_human_check')")).toEqual([])
      expect(applyMigrations(db, { release: "1.3.3", now: clock })).toEqual(ids.toReversed())
    } finally {
      db.close()
    }
  })
})
