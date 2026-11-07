import { Database } from "bun:sqlite"
import { bindable, type RunResult, type SqliteDb, type SqliteOpenOptions, type SqlParam } from "./driver-types.ts"

/** bun:sqlite driver, used under `bun test` only (the host uses sqlite.node.ts, spec §2.3). */
export function openSqlite(file: string, opts: SqliteOpenOptions = {}): SqliteDb {
  const db = opts.readonly ? new Database(file, { readonly: true }) : new Database(file, { create: true, readwrite: true })
  return {
    driver: "bun:sqlite",
    exec(sql: string) {
      db.exec(sql)
    },
    run(sql: string, params?: readonly SqlParam[]): RunResult {
      const r = db.query(sql).run(...(bindable(params) as never[]))
      return { changes: r.changes, lastInsertRowid: r.lastInsertRowid }
    },
    get<T>(sql: string, params?: readonly SqlParam[]): T | undefined {
      const r = db.query(sql).get(...(bindable(params) as never[]))
      return (r ?? undefined) as T | undefined
    },
    all<T>(sql: string, params?: readonly SqlParam[]): T[] {
      return db.query(sql).all(...(bindable(params) as never[])) as T[]
    },
    close() {
      db.close()
    },
  }
}
