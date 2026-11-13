/**
 * Store error codes (spec §10): new STORE_* codes plus kept Studio codes.
 * `StoreError.code` is stable; the message is for logs, never shown raw to a user.
 */
export const STORE_ERROR_CODES = [
  "STORE_LOCKED",
  "STORE_FTS5_MISSING",
  "STORE_TX_TIMEOUT",
  "STORE_TX_CLOSED",
  "STORE_NESTED_TX",
  "STORE_BUSY",
  "STORE_CLOSED",
  "STORE_ROOT_INVALID",
  "STORE_SCHEMA_NEWER",
  "STORE_MIGRATION_FAILED",
  "TEMPLATE_READ_ONLY",
  "TEMPLATE_VERSION_CONFLICT",
  "REVISION_IMMUTABLE",
  "TEMPLATE_VERSION_IMMUTABLE",
  "DOC_BLOCK_IMMUTABLE",
  "DOC_KEY_TAKEN",
  "DOC_NUMBER_TAKEN",
  "ALREADY_EXISTS",
  "INTEGRITY_MISMATCH",
  "OUTPUT_EXISTS",
  "CONSTRAINT",
  "NOT_IMPLEMENTED",
  "BASE_CONFLICT",
  "NOT_FOUND",
  "SCHEMA_INVALID",
  "PATH_OUTSIDE_ROOT",
  // row 119a: mission contract refusals (masterplan/01_specs_mission_contract.md §6.2, §13) and the C57 entities
  "MISSION_REQUIRED",
  "MISSION_NOT_FOUND",
  "MISSION_ID_TAKEN",
  "MISSION_NOT_APPROVED",
  "MISSION_PAUSED",
  "MISSION_CLOSED",
  "MISSION_TYPE_UNKNOWN",
  "MISSION_TYPE_LOCKED",
  "MISSION_TYPE_IMMUTABLE",
  "MISSION_TYPE_CHANGED",
  "PHASE_UNKNOWN",
  "KIND_NOT_ALLOWED",
  "ROW_UNKNOWN",
  "ROW_ID_TAKEN",
  "ROW_CLOSED",
  "DOC_KEY_MISMATCH",
  "DEP_SELF",
  "DEP_UNKNOWN",
  "DEP_CYCLE",
  "DEP_DROPPED",
  "DEP_NOT_DONE",
  "STATUS_TRANSITION",
  "DECISION_REQUIRED",
  "DECISION_UNKNOWN",
  "APPROVAL_NEEDS_USER_DECISION",
  "AUTONOMOUS_MODE_OFF",
  "DECISION_ID_TAKEN",
  "DECISION_IMMUTABLE",
  "LOCK_HELD",
  "LOCK_NOT_HELD",
  "MISSION_ROWS_OPEN",
  "MISSION_EMPTY",
  "SUPERSEDE_TARGET",
  "FIELD_READ_ONLY",
  "REPORT_NOT_IN_MISSION",
  "SNAPSHOT_IMMUTABLE",
  "EVENT_IMMUTABLE",
  "DECISION_REQUEST_ID_TAKEN",
  "DECISION_REQUEST_UNKNOWN",
  "DECISION_REQUEST_CLOSED",
  "DECISION_PENDING",
  "OPTION_UNKNOWN",
  "CHECKPOINT_IMMUTABLE",
  "MESSAGE_IMMUTABLE",
  // row 149: output verification (masterplan/01_specs_output_verification.md §5, §7.3; C130). OUTPUT_UNVERIFIED is row 155's refusal.
  "VERIFY_SHA_MISMATCH",
  "VERIFY_STATE_INVALID",
  "VERIFY_REPORT_TOO_LARGE",
  "OUTPUT_UNVERIFIED",
  // row 174 (C218 F146b-3): studio_mission_update_row `retire` refused (not a live deliverable of the row, or none would stay).
  "DELIVERABLE_NOT_RETIRABLE",
  // 1.2.8 row 39 (MEM-e, N8-013): a Swarm `done` close while the project memory has no index entry for the mission.
  "MEMORY_INDEX_MISSING",
  // 1.2.8 row 45 (PROJ-b, N8-145): studio_mission_place / setProjectDir without an answered placement or tidy decision.
  "PLACE_DECISION_UNANSWERED",
] as const

export type StoreErrorCode = (typeof STORE_ERROR_CODES)[number]

export class StoreError extends Error {
  readonly code: StoreErrorCode
  readonly details: Record<string, unknown> | undefined
  constructor(code: StoreErrorCode, message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(`${code}: ${message}`, cause === undefined ? undefined : { cause })
    this.name = "StoreError"
    this.code = code
    this.details = details
  }
}

export function isStoreError(e: unknown, code?: StoreErrorCode): e is StoreError {
  return e instanceof StoreError && (code === undefined || e.code === code)
}

/** Trigger messages of migration 0003; longer names first so no code matches inside another. */
const MISSION_TRIGGER_CODES: readonly StoreErrorCode[] = [
  "DECISION_REQUEST_CLOSED",
  "MISSION_TYPE_IMMUTABLE",
  "MISSION_TYPE_LOCKED",
  "CHECKPOINT_IMMUTABLE",
  "DECISION_IMMUTABLE",
  "SNAPSHOT_IMMUTABLE",
  "MESSAGE_IMMUTABLE",
  "EVENT_IMMUTABLE",
  "KIND_NOT_ALLOWED",
  "MISSION_CLOSED",
  "PHASE_UNKNOWN",
]

/** Map a raw SQLite error (bun SQLiteError or node:sqlite Error) to a StoreError. */
export function mapSqliteError(e: unknown): unknown {
  if (e instanceof StoreError) return e
  const msg = e instanceof Error ? e.message : String(e)
  const pick = (code: StoreErrorCode) => new StoreError(code, msg, undefined, e)
  if (msg.includes("REVISION_IMMUTABLE")) return pick("REVISION_IMMUTABLE")
  if (msg.includes("TEMPLATE_VERSION_IMMUTABLE")) return pick("TEMPLATE_VERSION_IMMUTABLE")
  if (msg.includes("DOC_BLOCK_IMMUTABLE")) return pick("DOC_BLOCK_IMMUTABLE")
  // row 119a: RAISE(ABORT, '<CODE>') messages of migration 0003 triggers
  for (const code of MISSION_TRIGGER_CODES) if (msg.includes(code)) return pick(code)
  if (msg.includes("UNIQUE constraint failed: mission.id")) return pick("MISSION_ID_TAKEN")
  if (msg.includes("UNIQUE constraint failed: mission_row.mission_id, mission_row.row_id")) return pick("ROW_ID_TAKEN")
  if (msg.includes("UNIQUE constraint failed: mission_decision.mission_id, mission_decision.decision_id")) return pick("DECISION_ID_TAKEN")
  if (msg.includes("UNIQUE constraint failed: mission_decision_request.mission_id")) return pick("DECISION_REQUEST_ID_TAKEN")
  if (msg.includes("UNIQUE constraint failed: mission_lock.resource")) return pick("LOCK_HELD")
  if (/database is locked|SQLITE_BUSY/i.test(msg)) return pick("STORE_BUSY")
  // row 149: the 0004 table CHECK (a verified record with any FAIL/UNKNOWN), before the generic CHECK mapping
  if (msg.includes("CHECK constraint failed") && msg.includes("state = 'unverified'")) return pick("VERIFY_STATE_INVALID")
  if (msg.includes("UNIQUE constraint failed: document.mission_folder, document.mission_doc_key")) return pick("DOC_KEY_TAKEN")
  if (msg.includes("UNIQUE constraint failed: document.doc_number")) return pick("DOC_NUMBER_TAKEN")
  if (msg.includes("UNIQUE constraint failed")) return pick("ALREADY_EXISTS")
  if (msg.includes("CHECK constraint failed") || msg.includes("NOT NULL constraint failed")) return pick("SCHEMA_INVALID")
  if (msg.includes("FOREIGN KEY constraint failed")) return pick("CONSTRAINT")
  return e
}
