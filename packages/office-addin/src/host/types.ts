// Host adapter contract (M8-03; FS §5, FR-01..FR-04, FR-17..FR-19, FR-49). The Word and
// Excel executors (word.ts, excel.ts) and the in-memory adapter (memory.ts) implement it.
// Every member reads the document at the moment it is called (FR-01) and runs in one
// Word.run / Excel.run batch (FR-02). Failures are returned, never thrown, so the pane
// shows a key and stays usable (FR-03); `detail` carries the Office error for logging.
import type { ExcelValue, Refusal, WriteAction, WritePlan } from "../excel"
import type { ContextScope } from "../state/prompt"

export type { WriteAction }

export type ErrorDetail = { name: string; code?: string; message: string }

export type HostFailure = {
  ok: false
  code:
    | "office.error.readFailed"
    | "office.error.writeFailed"
    | "office.error.selectionUnsupported"
    | "office.error.generic"
  // "unsupported": the WordApi / ExcelApi 1.1 runtime check failed (REG §6.2).
  reason?: "unsupported"
  detail?: ErrorDetail
}

// ---------- Word ----------

export type WordLocation = "After" | "Replace"

export type WordRead = { ok: true; host: "Word"; scope: ContextScope; text: string }

// What a Word write will do, from the selection read at action time (FR-63 preview).
export type WordPlan = {
  ok: true
  host: "Word"
  action: WriteAction
  location: WordLocation
  // The exact string the Word executor writes (FR-04, D6).
  text: string
  // The selection text as read; "" when collapsed.
  selection: string
}

export type WordWritten = { ok: true; host: "Word"; plan: WordPlan }

// FR-49 / SC-44: the selection moved since the preview; nothing was written.
export type WordChanged = { ok: false; changed: true; plan: WordPlan }

export type WordHost = {
  host: "Word"
  supported(): boolean
  read(scope: ContextScope): Promise<WordRead | HostFailure>
  preview(action: WriteAction, reply: string): Promise<WordPlan | HostFailure>
  // `expected`: the plan shown in the preview; when given and the fresh plan differs,
  // nothing is written and the fresh plan is returned.
  write(action: WriteAction, reply: string, expected?: WordPlan): Promise<WordWritten | WordChanged | HostFailure>
}

// ---------- Excel ----------

export type ExcelRead = {
  ok: true
  host: "Excel"
  scope: ContextScope
  // Range.address as loaded (sheet-qualified), for the context tag (FR-58).
  address: string
  rowCount: number
  columnCount: number
  values: ExcelValue[][]
}

// `target`: the sheet-qualified target address ("Sheet1!H1:Q1"), the worksheet taken
// from the selection's Range.address. FR-49 compares this, so the same cells on
// another sheet count as a moved selection (M8-03a).
export type ExcelPlan = { ok: true; host: "Excel"; action: WriteAction; target: string; plan: WritePlan }

export type ExcelRefused = { ok: false; host: "Excel"; refusal: Refusal }

export type ExcelWritten = { ok: true; host: "Excel"; plan: WritePlan; selected: boolean }

export type ExcelChanged = { ok: false; changed: true; plan: ExcelPlan | ExcelRefused }

export type ExcelHost = {
  host: "Excel"
  supported(): boolean
  read(scope: ContextScope): Promise<ExcelRead | HostFailure>
  preview(action: WriteAction, reply: string): Promise<ExcelPlan | ExcelRefused | HostFailure>
  // `expected`: the sheet-qualified `target` of the preview plan (FR-49, M8-03a).
  write(
    action: WriteAction,
    reply: string,
    expected?: string,
  ): Promise<ExcelWritten | ExcelRefused | ExcelChanged | HostFailure>
}

export type HostAdapter = WordHost | ExcelHost

export function errorDetail(error: unknown): ErrorDetail {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : undefined
    return { name: error.name, message: error.message, ...(code ? { code } : {}) }
  }
  return { name: "Error", message: String(error) }
}

export const unsupported: HostFailure = { ok: false, code: "office.error.generic", reason: "unsupported" }

export function failWith(code: HostFailure["code"]) {
  return (error: unknown): HostFailure => ({ ok: false, code, detail: errorDetail(error) })
}
