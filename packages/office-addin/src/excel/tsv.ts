// FR-10..FR-12: a range's `values` (2-D array) to TSV for the prompt context.
// Pure: no Office.js. Input is what `Range.values` returns (string, number, boolean;
// error values arrive as strings such as "#DIV/0!", E-2).

export type ExcelValue = string | number | boolean | null | undefined

// FR-10.1 and FR-10.2: one cell to one TSV field.
export function valueToField(value: ExcelValue) {
  const text =
    typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : value === null || value === undefined ? "" : String(value)
  return text.replace(/\r\n|\r|\n|\t/g, " ")
}

// FR-10.3 and FR-12. A ragged matrix cannot come from Office (a range is rectangular),
// so it is rejected rather than padded.
export function valuesToTsv(values: ExcelValue[][]) {
  const width = values[0]?.length ?? 0
  if (values.some((row) => row.length !== width)) throw new RangeError("excel: ragged values matrix")
  const fields = values.map((row) => row.map(valueToField))
  if (fields.every((row) => row.every((field) => field === ""))) return ""
  return fields.map((row) => row.join("\t")).join("\n")
}
