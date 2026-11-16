// Excel pure logic (M8-01, TR-1). No Office.js calls; the host adapter (M8-03) runs the plans.
export { valueToField, valuesToTsv, type ExcelValue } from "./tsv"
export { replyToMatrix, type ReplyMatrix } from "./matrix"
export {
  convertCell,
  isExactNumber,
  isFormulaLeading,
  isNumberCell,
  isTooLong,
  EXCEL_MAX_SIGNIFICANT_DIGITS,
  type CellPlan,
} from "./cell"
export {
  address,
  columnName,
  completeWrite,
  prepareWrite,
  EXCEL_MAX_COLUMNS,
  EXCEL_MAX_ROWS,
  type Assignment,
  type Prepared,
  type Refusal,
  type Selection,
  type Target,
  type WriteAction,
  type WritePlan,
} from "./plan"
