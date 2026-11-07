/**
 * Store bridge for the vendored Studio services (row 109, the Prisma cut of 01_specs_studio.md §1.2).
 * Vendor twins/patches import this module by relative path; nothing here imports vendor code.
 */
export * from "./db.ts"
export * from "./rows.ts"
export * from "./documents.ts"
export { createStoreFileLogger, openHostStore, closeHostStore, type FileLoggerOptions, type HostStoreOptions } from "./log.ts"
export { newId, docNumberSafe, getStudioStore, setStudioStore, SqliteStudioStore, StoreError, type StoreTx } from "../store/index.ts"
