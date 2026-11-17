/**
 * Swarm 1.3.3 row 144 (ST-11): operator script, run by hand on a COPY of the store, never on the live store.
 * The file name has no `.test.`, so the suite does not run it.
 *
 *   bun test/st11-rehearsal/row144-index-timing.ts <absolute root>    (the copy is <root>/store/datum-studio.sqlite)
 *
 * Steps: forward to 0010 on a raw handle; foreign-key coverage audit (every foreign key whose child column is not the
 * first column of any index); child-lookup query plans before; migration 0011 through the runner, timed (this is
 * what `open` runs at app start); plans after; size and WAL growth; reverse step through the runner, timed; each
 * index alone, timed; 0011 forward again through the runner (second run); then the copy is put back to 0009
 * (0011 and 0010 reverted with row 81's runner) so row 83's rehearsal script can run on it unchanged.
 * Writes <root>/row144-timing.json.
 */
import { realpathSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { openSqlite } from "#sqlite"
import type { SqliteDb } from "../../src/store/driver-types.ts"
import { applyMigrations, MIGRATIONS, revertMigration, revertMigrations } from "../../src/store/migrations/index.ts"
import { MIGRATION_0009_ID } from "../../src/store/migrations/0009_datum_mission_row_contract.ts"
import { MIGRATION_0011_ID, MIGRATION_0011_INDEXES, MIGRATION_0011_SQL } from "../../src/store/migrations/0011_datum_purge_fk_indexes.ts"

const ROOT = process.argv[2]
if (!ROOT || !ROOT.startsWith("/")) throw new Error("usage: row144-index-timing.ts <absolute root>")
const FILE = join(ROOT, "store", "datum-studio.sqlite")
if (realpathSync(FILE).includes("/.local/share/swarm/") || realpathSync(FILE).startsWith(join(homedir(), ".local", "share", "swarm"))) throw new Error(`refused: ${FILE} is under a live Swarm data folder`)

const RELEASE = "1.3.3-row144"
/** First row via `all`, so no statement stays stepped (an open bun `get` statement blocks wal_checkpoint with SQLITE_LOCKED). */
let one = <T>(_sql: string, _p?: readonly (string | number)[]): T | undefined => undefined
const report: Record<string, unknown> = { file: FILE }
const log = (m: string) => process.stderr.write(`[row144] ${m}\n`)
const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10
const size = (p: string) => {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}
const pages = (db: SqliteDb) => ({ pageCount: Number(one<{ page_count: number }>("PRAGMA page_count")!.page_count), fileBytes: size(FILE), walBytes: size(`${FILE}-wal`) })
const LOOKUPS: Array<[string, string]> = [
  ["doc_block", "chapter_id"],
  ["doc_block", "doc_section_id"],
  ["doc_subsection", "revision_id"],
  ["render_job", "revision_id"],
]
/**
 * Query plans on a separate read-only connection, closed at once: under bun:sqlite an EXPLAIN QUERY PLAN statement
 * stays active after `.all()`, and a later DROP INDEX on the same connection then fails with SQLITE_LOCKED, which
 * bun's exec does not report when the SQL starts with a comment line (found by this row; see the report).
 */
const plansOf = () => {
  const ro = openSqlite(FILE, { readonly: true })
  const out = plans(ro)
  ro.close()
  return out
}
const plans = (db: SqliteDb) =>
  Object.fromEntries(LOOKUPS.map(([t, c]) => [`${t}.${c}`, db.all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT 1 FROM ${t} WHERE ${c} = ?`, ["x"]).map((r) => r.detail).join(" / ")]))

/** Every foreign key whose child column(s) are not a prefix of some index of the child table (PK and UNIQUE included). */
function uncoveredForeignKeys(db: SqliteDb) {
  const tables = db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL%'").map((r) => r.name)
  const out: Array<{ table: string; column: string; parent: string; onDelete: string; rows: number }> = []
  for (const t of tables) {
    const fks = db.all<{ id: number; seq: number; table: string; from: string; on_delete: string }>(`PRAGMA foreign_key_list(${t})`)
    if (fks.length === 0) continue
    const prefixes = db.all<{ name: string }>(`PRAGMA index_list(${t})`).map((i) => db.all<{ name: string | null }>(`PRAGMA index_info(${i.name})`).map((c) => c.name ?? ""))
    const pk = db.all<{ name: string; pk: number }>(`PRAGMA table_info(${t})`).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
    if (pk.length > 0) prefixes.push(pk)
    const byId = new Map<number, typeof fks>()
    for (const f of fks) byId.set(f.id, [...(byId.get(f.id) ?? []), f])
    for (const group of byId.values()) {
      const cols = group.sort((a, b) => a.seq - b.seq).map((f) => f.from)
      const covered = prefixes.some((p) => cols.every((c, i) => p[i] === c))
      if (!covered) out.push({ table: t, column: cols.join(","), parent: group[0]!.table, onDelete: group[0]!.on_delete, rows: Number(one<{ n: number }>(`SELECT count(*) AS n FROM ${t}`)!.n) })
    }
  }
  return out
}

const db = openSqlite(FILE)
one = <T>(sql: string, p?: readonly (string | number)[]) => db.all<T>(sql, p)[0]
db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL")
report.asFound = { ...pages(db), journal: db.all<{ id: string }>("SELECT id FROM migration ORDER BY id").map((r) => r.id).at(-1), doc_block: Number(one<{ n: number }>("SELECT count(*) AS n FROM doc_block")!.n), doc_subsection: Number(one<{ n: number }>("SELECT count(*) AS n FROM doc_subsection")!.n), render_job: Number(one<{ n: number }>("SELECT count(*) AS n FROM render_job")!.n) }
try {
  report.dbstat = Object.fromEntries(
    db.all<{ name: string; bytes: number }>("SELECT name, sum(pgsize) AS bytes FROM dbstat WHERE name IN ('doc_block', 'doc_subsection', 'render_job') GROUP BY name").map((r) => [r.name, Number(r.bytes)]),
  )
} catch (e) {
  report.dbstat = `unavailable: ${(e as Error).message}`
}
log(`as found ${JSON.stringify(report.asFound)} dbstat ${JSON.stringify(report.dbstat)}`)

let t = performance.now()
report.forwardTo0010 = { applied: applyMigrations(db, { release: RELEASE, now: Date.now }, MIGRATIONS.filter((m) => m.seq <= 10)), ms: ms(t) }
db.exec("PRAGMA wal_checkpoint(TRUNCATE)")
report.uncoveredBefore = uncoveredForeignKeys(db)
report.plansBefore = plansOf()
const before = pages(db)

// 1. the migration as `open` runs it: the runner, one BEGIN IMMEDIATE, all four indexes
t = performance.now()
const applied = applyMigrations(db, { release: RELEASE, now: Date.now })
report.migration0011 = { applied, ms: ms(t), walBytesAfterCommit: size(`${FILE}-wal`) }
log(`0011 first run ${JSON.stringify(report.migration0011)}`)
// A checkpoint on this handle right after the runner fails with SQLITE_LOCKED under bun:sqlite (a cached statement
// stays active), so it runs on a second, short-lived connection.
t = performance.now()
const ck = openSqlite(FILE)
;(report.migration0011 as Record<string, unknown>).checkpoint = ck.all("PRAGMA wal_checkpoint(TRUNCATE)")[0]
ck.close()
;(report.migration0011 as Record<string, unknown>).checkpointMs = ms(t)
const after = pages(db)
report.growth = { before, after, addedPages: after.pageCount - before.pageCount, addedBytes: (after.pageCount - before.pageCount) * 4096 }
report.plansAfter = plansOf()
report.uncoveredAfter = uncoveredForeignKeys(db)
log(`0011 ${JSON.stringify(report.migration0011)} growth ${JSON.stringify(report.growth)}`)

// 2. the reverse step through the runner
t = performance.now()
const rev = revertMigration(db, { release: RELEASE, now: Date.now, id: MIGRATION_0011_ID })
report.reverse0011 = { ...rev, ms: ms(t), indexesLeft: db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (${MIGRATION_0011_INDEXES.map(() => "?").join(",")})`, [...MIGRATION_0011_INDEXES]).length }
log(`reverse ${JSON.stringify(report.reverse0011)}`)
if ((report.reverse0011 as { indexesLeft: number }).indexesLeft !== 0) throw new Error("reverse step left indexes behind")

// 3. each index alone (same statements as the migration, outside the runner), then dropped again
const each: Record<string, number> = {}
for (const stmt of MIGRATION_0011_SQL.split("\n").filter((l) => l.startsWith("CREATE INDEX"))) {
  const name = stmt.match(/EXISTS (\w+) ON/)![1]!
  t = performance.now()
  db.exec(stmt)
  each[name] = ms(t)
}
db.exec(MIGRATIONS.find((m) => m.seq === 11)!.down!)
report.perIndexMs = each
log(`per index ${JSON.stringify(each)}`)

// 4. forward again through the runner (second run, warm cache)
t = performance.now()
report.migration0011Second = { applied: applyMigrations(db, { release: RELEASE, now: Date.now }), ms: ms(t) }
log(`0011 second ${JSON.stringify(report.migration0011Second)}`)

// 5. back to 0009 for row 83's rehearsal script (which forwards from 0009 itself)
t = performance.now()
report.backTo0009 = { steps: revertMigrations(db, { release: RELEASE, now: Date.now }, MIGRATION_0009_ID).map((s) => s.id), ms: ms(t), quickCheck: one<{ quick_check: string }>("PRAGMA quick_check")!.quick_check }
db.close()
const ck2 = openSqlite(FILE)
ck2.all("PRAGMA wal_checkpoint(TRUNCATE)")
ck2.close()
const chk = openSqlite(FILE, { readonly: true })
;(report.backTo0009 as Record<string, unknown>).leftovers = chk.all<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'revision_prune%' OR name = 'revision_delete_guard' OR name IN ('doc_block_chapter_idx', 'doc_block_doc_section_idx', 'doc_subsection_revision_idx', 'render_job_revision_idx')").map((r) => r.name)
chk.close()
log(`back to 0009 ${JSON.stringify(report.backTo0009)}`)
if (((report.backTo0009 as { leftovers: string[] }).leftovers).length > 0) throw new Error("revert to 0009 left schema objects behind")
writeFileSync(join(ROOT, "row144-timing.json"), JSON.stringify(report, null, 2))
