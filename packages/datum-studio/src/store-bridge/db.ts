/**
 * Store access for the vendored Studio services (row 109, Prisma cut; spec 01_specs_studio.md §1.2).
 *
 * The twins and patched call sites never see Prisma. They get:
 * - `StudioTx`: the `StoreTx` of one `StudioStore.transaction` job (raw SQL over the row 8 schema);
 * - `withStudioTx`: one write-queue job (BEGIN IMMEDIATE ... COMMIT) on the host's store;
 * - `readWith`: run a read on the caller's tx, or in a job of its own when no tx is given.
 * The store instance is the one the host installed with `setStudioStore` (row 30 / 111).
 */
import { AsyncLocalStorage } from "node:async_hooks"
import { getStudioStore, isStoreError, type SqliteStudioStore, type StoreErrorCode, type StoreTx } from "../store/index.ts"
import type { SqlParam } from "../store/driver-types.ts"

/** A transaction of the host's store (replaces `Prisma.TransactionClient` and `PrismaClient`). */
export type StudioTx = StoreTx

/** JSON value as stored in a JSON TEXT column (replaces `Prisma.JsonValue` / `InputJsonValue`). */
export type StudioJson = unknown

export type { SqlParam }

export function studioStore(): SqliteStudioStore {
  return getStudioStore()
}

/** The job a bridge call runs in (so reads without an explicit tx join it instead of nesting). */
const currentTx = new AsyncLocalStorage<StudioTx>()

/** One write-queue job. `timeoutMs` maps Prisma's `$transaction({ timeout })`. */
export function withStudioTx<T>(fn: (tx: StudioTx) => Promise<T>, opts: { timeoutMs?: number; correlationId?: string } = {}): Promise<T> {
  const open = currentTx.getStore()
  // Prisma code nested `prisma.x` reads/writes inside `$transaction` callbacks on a second
  // connection; the store has one writer, so a job inside a job joins the open one.
  if (open?.alive) return fn(open)
  return getStudioStore().transaction((tx) => currentTx.run(tx, () => fn(tx)), opts)
}

/**
 * Read on the caller's transaction (sees its own writes), else on the job this call already runs
 * in, else inside a job of its own (committed data only).
 */
export async function readWith<T>(db: StudioTx | undefined | null, fn: (q: StudioTx) => T | Promise<T>): Promise<T> {
  if (db) return await fn(db)
  return withStudioTx(async (tx) => fn(tx))
}

/** The bridge job this async context runs in, if any. */
export function activeTx(): StudioTx | undefined {
  const t = currentTx.getStore()
  return t?.alive ? t : undefined
}

/** `?, ?, ?` for an IN list (never empty: an empty list gives `NULL`, which matches nothing). */
export function inList(values: readonly unknown[]): string {
  return values.length === 0 ? "NULL" : values.map(() => "?").join(", ")
}

/** JSON column value (undefined/null -> NULL). */
export function jsonCol(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v)
}

/** Parse a JSON TEXT column read with raw SQL (the store's typed reads parse already). */
export function parseJson<T = unknown>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T
}

/** SQLite boolean (0/1) -> boolean. */
export function bool(v: unknown): boolean {
  return v === 1 || v === true || v === 1n
}

/** Integer ms column -> Date (null stays null). */
export function dateOf(v: unknown): Date {
  return new Date(Number(v))
}

export function dateOrNull(v: unknown): Date | null {
  return v === null || v === undefined ? null : new Date(Number(v))
}

/** Date -> integer ms column. */
export function msOf(d: Date | string | number | null | undefined): number | null {
  if (d === null || d === undefined) return null
  if (d instanceof Date) return d.getTime()
  return typeof d === "number" ? d : new Date(d).getTime()
}

/** Date (UTC midnight, Prisma `@db.Date`) <-> `YYYY-MM-DD` TEXT column. */
export function dayOf(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null
  if (typeof d === "string") return d.slice(0, 10)
  return d.toISOString().slice(0, 10)
}

export function dayDate(v: unknown): Date | null {
  return typeof v === "string" && v.length >= 10 ? new Date(`${v.slice(0, 10)}T00:00:00.000Z`) : null
}

/**
 * Prisma's P2002 test, over the store's mapped SQLite errors: `column` is the snake_case column
 * name (or a fragment of the UNIQUE message, e.g. "document.doc_number").
 */
export function isUniqueViolation(e: unknown, column: string): boolean {
  const codes: StoreErrorCode[] = ["ALREADY_EXISTS", "DOC_NUMBER_TAKEN", "DOC_KEY_TAKEN"]
  return codes.some((c) => isStoreError(e, c)) && (e as Error).message.includes(column)
}

export { isStoreError }
