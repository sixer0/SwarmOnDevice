// Host adapter contract (M8-03; FS §5, FR-01..FR-04, FR-17..FR-19, FR-49). The Word and
// Excel executors (word.ts, excel.ts) and the in-memory adapter (memory.ts) implement it.
// Every member reads the document at the moment it is called (FR-01) and runs in one
// Word.run / Excel.run batch (FR-02). Failures are returned, never thrown, so the pane
// shows a key and stays usable (FR-03); `detail` carries the Office error for logging.
import { address, EXCEL_MAX_COLUMNS, EXCEL_MAX_ROWS, replyToMatrix, type ExcelValue, type Refusal, type WriteAction, type WritePlan } from "../excel"
import type { ContextScope } from "../state/prompt"

export type { WriteAction }

type ErrorDetail = { name: string; code?: string; message: string }

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

type WordLocation = "After" | "Replace"

type WordRead = { ok: true; host: "Word"; scope: ContextScope; text: string }

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
  // Location identity of the previewed selection (M8-03c, SC-44, FR-49). Text alone cannot
  // tell a moved caret ("" === "") or another range with the same text. Set by `preview`;
  // `write` with this plan as `expected` requires the same location as well as the same plan.
  anchor?: WordAnchor
}

// - tracked: WordApi 1.3 and later. The preview's selection Range, tracked across batches,
//   compared with the fresh selection by Range.compareLocationWith ("Equal" required).
// - paragraphs: WordApi 1.1/1.2 fallback. Index of the selection's first and last
//   paragraph in the body, and the body paragraph count. 1.1 has no range identity, so the
//   index is found by paragraph text (first match); a move inside one paragraph, or between
//   paragraphs with identical text, is not seen there (decision M8-03c-1).
// - memory: the in-memory adapter's `position`.
export type WordAnchor =
  | { kind: "tracked"; range: Word.Range }
  | { kind: "paragraphs"; start: number; end: number; count: number }
  | { kind: "memory"; position: number }

type WordWritten = { ok: true; host: "Word"; plan: WordPlan }

// FR-49 / SC-44: the selection moved since the preview; nothing was written.
type WordChanged = { ok: false; changed: true; plan: WordPlan }

export type WordHost = {
  host: "Word"
  supported(): boolean
  read(scope: ContextScope): Promise<WordRead | HostFailure>
  preview(action: WriteAction, reply: string): Promise<WordPlan | HostFailure>
  // `expected`: the plan shown in the preview; when given and the fresh plan differs,
  // nothing is written and the fresh plan is returned.
  write(action: WriteAction, reply: string, expected?: WordPlan): Promise<WordWritten | WordChanged | HostFailure>
  // M8-03d: releases the tracked anchor of a plan the pane drops without writing (Cancel, Esc,
  // another preview). `write` itself releases the anchor of `expected` on every path, so a plan
  // passed to `write` must not be released again. Never fails; a no-op for value anchors.
  release(plan: WordPlan): Promise<void>
}

// ---------- Excel ----------

type ExcelRead = {
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

// M8-03b (C59): the cells a refusal is about, so the preview can name them and label the
// grid (mockup S13). `address` is sheet-qualified ("Sheet1!B10:D12"); rowIndex and
// columnIndex are zero-based. Built from the selection's address and indexes only: no
// values of the selection are loaded for it.
export type RefusedTarget = { address: string; rowIndex: number; columnIndex: number; rows: number; columns: number }

type ExcelRefused = { ok: false; host: "Excel"; refusal: Refusal; target: RefusedTarget }

type ExcelWritten = { ok: true; host: "Excel"; plan: WritePlan; selected: boolean }

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

// M8-03b: the target of a refused Excel write. targetNotEmpty and cellTooLong name the
// planned m x n target at the anchor of FS §6.3 (Insert: below the selection; Replace: its
// top-left cell). shapeMismatch names the selection (the Replace target the reply does not
// fit), and so does outsideGrid or a planned target that would leave the sheet grid.
export function refusedTarget(
  action: WriteAction,
  reply: string,
  refusal: Refusal,
  sheet: string,
  selection: { rowIndex: number; columnIndex: number; rowCount: number; columnCount: number },
): RefusedTarget {
  const own = {
    address: `${sheet}!${address(selection.rowIndex, selection.columnIndex, selection.rowCount, selection.columnCount)}`,
    rowIndex: selection.rowIndex,
    columnIndex: selection.columnIndex,
    rows: selection.rowCount,
    columns: selection.columnCount,
  }
  if (refusal.code === "office.error.shapeMismatch") return own
  if (refusal.code === "office.error.writeFailed" && refusal.reason === "outsideGrid") return own
  const matrix = replyToMatrix(reply)
  const rowIndex = action === "insert" ? selection.rowIndex + selection.rowCount : selection.rowIndex
  if (rowIndex + matrix.m > EXCEL_MAX_ROWS || selection.columnIndex + matrix.n > EXCEL_MAX_COLUMNS) return own
  return {
    address: `${sheet}!${address(rowIndex, selection.columnIndex, matrix.m, matrix.n)}`,
    rowIndex,
    columnIndex: selection.columnIndex,
    rows: matrix.m,
    columns: matrix.n,
  }
}
