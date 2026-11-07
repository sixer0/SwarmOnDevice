/**
 * The SQLite driver seam (spec 01_specs_studio_store.md §2.3 item 2, decision C36).
 * `#sqlite` resolves to `sqlite.bun.ts` (bun:sqlite) under bun and to `sqlite.node.ts`
 * (node:sqlite, Electron's Node in the host) under Node. The store needs only these calls.
 * Parameters are positional (`?` or `?NNN`) in both drivers.
 */
export type SqlValue = string | number | bigint | null | Uint8Array
export type SqlParam = SqlValue | boolean | undefined
export type SqlRow = Record<string, unknown>

export interface RunResult {
  changes: number
  lastInsertRowid: number | bigint
}

export interface SqliteDb {
  readonly driver: "bun:sqlite" | "node:sqlite"
  exec(sql: string): void
  run(sql: string, params?: readonly SqlParam[]): RunResult
  get<T = SqlRow>(sql: string, params?: readonly SqlParam[]): T | undefined
  all<T = SqlRow>(sql: string, params?: readonly SqlParam[]): T[]
  close(): void
}

export interface SqliteOpenOptions {
  readonly?: boolean
}

/** undefined -> NULL, boolean -> 0/1 (node:sqlite refuses both as-is). */
export function bindable(params: readonly SqlParam[] | undefined): SqlValue[] {
  if (!params) return []
  return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p))
}
