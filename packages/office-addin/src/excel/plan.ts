// FS 6.3: insert/replace target planner with refusals, and the write plan the Excel
// adapter (M8-03) executes in one Excel.run batch. Pure: no Office.js.
//
// Two steps, because the empty check needs the target's values loaded by the adapter:
//   1. prepareWrite(action, reply, selection) -> target to load, or a refusal
//   2. completeWrite(prepared, targetValues)   -> assignments, or targetNotEmpty
//
// The plan can only name `numberFormat` and `values` (FR-15: no formula property is
// ever named). numberFormat comes first (SC-45, C14).
import { EXCEL_TEXT_NUMBER_FORMAT } from "../constants"
import { convertCell, isTooLong, type CellPlan } from "./cell"
import { replyToMatrix, type ReplyMatrix } from "./matrix"
import type { ExcelValue } from "./tsv"

export type WriteAction = "insert" | "replace"

// rowIndex/columnIndex (zero-based, Range.rowIndex/columnIndex, ExcelApi 1.1) are
// optional; with them the planner also gives the target address and the grid check.
export type Selection = { rowCount: number; columnCount: number; rowIndex?: number; columnIndex?: number }

// anchor "below": S.getLastRow().getOffsetRange(1, 0).getCell(0, 0)
// anchor "topLeft": S.getCell(0, 0)
// target range: a.getBoundingRect(a.getCell(rows - 1, columns - 1))
// check: which target cells must be "" before writing.
export type Target = {
  anchor: "below" | "topLeft"
  rows: number
  columns: number
  check: "all" | "exceptAnchor" | "none"
  rowIndex?: number
  columnIndex?: number
  address?: string
}

export type Refusal =
  | { code: "office.error.writeFailed"; reason: "cellTooLong"; row: number; column: number; length: number }
  | { code: "office.error.writeFailed"; reason: "outsideGrid" }
  | {
      code: "office.error.shapeMismatch"
      params: { replyRows: number; replyCols: number; selRows: number; selCols: number }
    }
  | { code: "office.error.targetNotEmpty"; row: number; column: number }

export type Prepared = {
  ok: true
  action: WriteAction
  matrix: ReplyMatrix
  cells: CellPlan[][]
  target: Target
  formulaAsText: number
}

export type Assignment =
  | { property: "numberFormat"; value: (string | null)[][] }
  | { property: "values"; value: (string | number)[][] }

export type WritePlan = { ok: true; target: Target; cells: CellPlan[][]; assignments: Assignment[] }

export const EXCEL_MAX_ROWS = 1_048_576
export const EXCEL_MAX_COLUMNS = 16_384

export function columnName(index: number): string {
  if (index < 26) return String.fromCharCode(65 + index)
  return columnName(Math.floor(index / 26) - 1) + String.fromCharCode(65 + (index % 26))
}

export function address(rowIndex: number, columnIndex: number, rows: number, columns: number) {
  const start = `${columnName(columnIndex)}${rowIndex + 1}`
  if (rows === 1 && columns === 1) return start
  return `${start}:${columnName(columnIndex + columns - 1)}${rowIndex + rows}`
}

function locate(target: Target, selection: Selection): Target | undefined {
  if (selection.rowIndex === undefined || selection.columnIndex === undefined) return target
  const rowIndex = target.anchor === "below" ? selection.rowIndex + selection.rowCount : selection.rowIndex
  const columnIndex = selection.columnIndex
  if (rowIndex + target.rows > EXCEL_MAX_ROWS || columnIndex + target.columns > EXCEL_MAX_COLUMNS) return undefined
  return { ...target, rowIndex, columnIndex, address: address(rowIndex, columnIndex, target.rows, target.columns) }
}

export function prepareWrite(
  action: WriteAction,
  reply: string,
  selection: Selection,
): Prepared | { ok: false; refusal: Refusal } {
  const matrix = replyToMatrix(reply)

  // FR-16 first: the whole write fails before any target is touched.
  const long = matrix.rows.flatMap((row, r) =>
    row.flatMap((text, c) => (isTooLong(text) ? [{ r, c, length: text.length }] : [])),
  )[0]
  if (long)
    return {
      ok: false,
      refusal: {
        code: "office.error.writeFailed",
        reason: "cellTooLong",
        row: long.r,
        column: long.c,
        length: long.length,
      },
    }

  const same = matrix.m === selection.rowCount && matrix.n === selection.columnCount
  const single = selection.rowCount === 1 && selection.columnCount === 1
  if (action === "replace" && !same && !single)
    return {
      ok: false,
      refusal: {
        code: "office.error.shapeMismatch",
        params: {
          replyRows: matrix.m,
          replyCols: matrix.n,
          selRows: selection.rowCount,
          selCols: selection.columnCount,
        },
      },
    }

  const base: Target =
    action === "insert"
      ? { anchor: "below", rows: matrix.m, columns: matrix.n, check: "all" }
      : { anchor: "topLeft", rows: matrix.m, columns: matrix.n, check: same ? "none" : "exceptAnchor" }
  const target = locate(base, selection)
  if (!target) return { ok: false, refusal: { code: "office.error.writeFailed", reason: "outsideGrid" } }

  const cells = matrix.rows.map((row) => row.map(convertCell))
  return {
    ok: true,
    action,
    matrix,
    cells,
    target,
    formulaAsText: cells.flat().filter((cell) => cell.kind === "text" && cell.formulaLeading).length,
  }
}

// targetValues: `values` of the target range as loaded by the adapter (rows x columns).
// Not needed when target.check is "none".
export function completeWrite(
  prepared: Prepared,
  targetValues?: ExcelValue[][],
): WritePlan | { ok: false; refusal: Refusal } {
  const target = prepared.target
  if (target.check !== "none") {
    if (
      !targetValues ||
      targetValues.length !== target.rows ||
      targetValues.some((row) => row.length !== target.columns)
    )
      throw new RangeError("excel: target values do not match the planned target shape")
    const busy = targetValues
      .flatMap((row, r) => row.flatMap((value, c) => (value !== "" ? [{ r, c }] : [])))
      .find((cell) => target.check === "all" || cell.r !== 0 || cell.c !== 0)
    if (busy) return { ok: false, refusal: { code: "office.error.targetNotEmpty", row: busy.r, column: busy.c } }
  }

  const text = prepared.cells.some((row) => row.some((cell) => cell.kind === "text"))
  const format: Assignment = {
    property: "numberFormat",
    value: prepared.cells.map((row) => row.map((cell) => (cell.kind === "text" ? EXCEL_TEXT_NUMBER_FORMAT : null))),
  }
  const values: Assignment = { property: "values", value: prepared.cells.map((row) => row.map((cell) => cell.value)) }
  return { ok: true, target, cells: prepared.cells, assignments: text ? [format, values] : [values] }
}
