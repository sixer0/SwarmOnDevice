import { DatabaseSync, type StatementSync } from "node:sqlite"
import { bindable, type RunResult, type SqliteDb, type SqliteOpenOptions, type SqlParam } from "./driver-types.ts"

/** node:sqlite driver: the host's runtime (Electron 42.3.3, Node 24.15.0, SQLite 3.51.3; spec §2.2). */
export function openSqlite(file: string, opts: SqliteOpenOptions = {}): SqliteDb {
  const db = new DatabaseSync(file, { readOnly: opts.readonly === true, enableForeignKeyConstraints: true })
  const cache = new Map<string, StatementSync>()
  const stmt = (sql: string) => {
    let s = cache.get(sql)
    if (!s) {
      s = db.prepare(sql)
      cache.set(sql, s)
    }
    return s
  }
  return {
    driver: "node:sqlite",
    exec(sql: string) {
      db.exec(sql)
    },
    run(sql: string, params?: readonly SqlParam[]): RunResult {
      const r = stmt(sql).run(...bindable(params))
      return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
    },
    get<T>(sql: string, params?: readonly SqlParam[]): T | undefined {
      return (stmt(sql).get(...bindable(params)) ?? undefined) as T | undefined
    },
    all<T>(sql: string, params?: readonly SqlParam[]): T[] {
      return stmt(sql).all(...bindable(params)) as T[]
    },
    close() {
      cache.clear()
      db.close()
    },
  }
}
