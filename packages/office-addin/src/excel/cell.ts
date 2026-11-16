// FR-14..FR-16: per-cell conversion for Excel writes (register 8.4, C12, C14, C15).
// A cell is a number only if it matches EXCEL_NUMBER_PATTERN; every other cell is text
// and gets numberFormat "@" before `values` is assigned (SC-45). `formulaLeading` only
// feeds the preview marker (FR-63); the guard itself does not depend on it.
import { EXCEL_FORMULA_LEADING, EXCEL_NUMBER_PATTERN, OFFICE_EXCEL_CELL_MAX_CHARS } from "../constants"

export type CellPlan = { kind: "number"; value: number } | { kind: "text"; value: string; formulaLeading: boolean }

const FULLWIDTH: Record<string, string> = { "＝": "=", "＋": "+", "－": "-", "＠": "@" }

export function isNumberCell(text: string) {
  return EXCEL_NUMBER_PATTERN.test(text)
}

// C12 OQ-T4: = + - @ lead a formula, also after leading tab, space or CR, and in their
// fullwidth forms. An ASCII "-" followed only by a number is a number (C14, C15).
export function isFormulaLeading(text: string) {
  const rest = text.replace(/^[\t \r]+/, "")
  if (isNumberCell(rest)) return false
  const first = rest.charAt(0)
  const folded = FULLWIDTH[first] ?? first
  return folded !== "" && EXCEL_FORMULA_LEADING.some((lead) => lead === folded)
}

export function convertCell(text: string): CellPlan {
  if (isNumberCell(text)) return { kind: "number", value: Number(text) }
  return { kind: "text", value: text, formulaLeading: isFormulaLeading(text) }
}

// FR-16 (H-3): length in UTF-16 code units, as Excel counts characters.
export function isTooLong(text: string) {
  return text.length > OFFICE_EXCEL_CELL_MAX_CHARS
}
