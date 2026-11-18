// FR-14..FR-16: per-cell conversion for Excel writes (register 8.4, C12, C14, C15).
// A cell is a number only if it matches EXCEL_NUMBER_PATTERN and isExactNumber (C66); every other cell is text
// and gets numberFormat "@" before `values` is assigned (SC-45). `formulaLeading` only
// feeds the preview marker (FR-63); the guard itself does not depend on it.
import { EXCEL_FORMULA_LEADING, EXCEL_NUMBER_PATTERN, OFFICE_EXCEL_CELL_MAX_CHARS } from "../constants"

export type CellPlan = { kind: "number"; value: number } | { kind: "text"; value: string; formulaLeading: boolean }

const FULLWIDTH: Record<string, string> = { "＝": "=", "＋": "+", "－": "-", "＠": "@" }

// C66 (extends C15, CP-M8 F-4): a pattern match is written as a number only if Excel
// can hold it exactly as typed: (a) no leading zero in the integer part unless that
// part is exactly "0" ("0812..." phone numbers, "007" codes stay text), (b) at most 15
// significant digits (Excel's precision; a 16-digit NIK stays text), (c) a finite
// number. Also kept as text: a non-zero value that underflows to 0 (executor E-7).
// Significant digits: all digits after the leading zeros, trailing zeros included.
export const EXCEL_MAX_SIGNIFICANT_DIGITS = 15

export function isExactNumber(text: string) {
  const unsigned = text.replace(/^-/, "")
  const integer = unsigned.split(".")[0]
  if (integer.length > 1 && integer.startsWith("0")) return false
  const digits = unsigned.replace(".", "").replace(/^0+/, "")
  if (digits.length > EXCEL_MAX_SIGNIFICANT_DIGITS) return false
  const value = Number(text)
  return Number.isFinite(value) && (value !== 0 || digits === "")
}

export function isNumberCell(text: string) {
  return EXCEL_NUMBER_PATTERN.test(text) && isExactNumber(text)
}

// C12 OQ-T4: = + - @ lead a formula, also after leading tab, space or CR, and in their
// fullwidth forms. An ASCII "-" followed only by a number is a number (C14, C15).
export function isFormulaLeading(text: string) {
  const rest = text.replace(/^[\t \r]+/, "")
  if (EXCEL_NUMBER_PATTERN.test(rest)) return false
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
