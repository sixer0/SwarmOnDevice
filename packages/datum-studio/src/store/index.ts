/**
 * DATUM Studio store (row 30). Not wired into the vendor services here: rows 29/109 install the
 * host's instance with `setStudioStore` and the twins call `getStudioStore()` (01_specs_studio.md §1.2).
 */
import { StoreError } from "./errors.ts"
import { SqliteStudioStore } from "./studio-store.ts"

export * from "./types.ts"
export { StoreError, isStoreError, STORE_ERROR_CODES, type StoreErrorCode } from "./errors.ts"
export { SqliteStudioStore, assertFts5, encodeSearchCursor, decodeSearchCursor, SEARCH_LIMITS, CONTRACT_QUERY_LIMITS, STORE_TX_TIMEOUT_MS, STORE_BUSY_TIMEOUT_MS } from "./studio-store.ts"
export { translateFtsQuery, parseWebsearch } from "./fts-query.ts"
export { newId, sha256Hex, canonicalJson, docNumberSafe } from "./ids.ts"
export { MIGRATIONS, RESERVED_MIGRATIONS, latestSchemaId } from "./migrations/index.ts"
export { verifySnapshot } from "./backup.ts"
export { verifyExport, restoreExport, EXPORT_MANIFEST_FILE, type ExportVerification } from "./export.ts"
export { STORE_DB_FILE, STORE_LOCK_FILE } from "./paths.ts"
export { assetRelPath } from "./files.ts"
// row 119a: mission contract (U19, U20, C57); `store.missions` is the API
export * as mission from "./mission/index.ts"
export { MissionStore, type MissionReader } from "./mission/mission-store.ts"
export { MIGRATION_0003_ID } from "./migrations/0003_datum_mission.ts"

let current: SqliteStudioStore | null = null

/** Installed once by the host after `open()`. */
export function setStudioStore(store: SqliteStudioStore | null): void {
  current = store
}

export function getStudioStore(): SqliteStudioStore {
  if (!current) throw new StoreError("STORE_CLOSED", "DATUM Studio store is not open in this process")
  return current
}
