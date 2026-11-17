// FR-13: reply text to the matrix written back to Excel.
import { writeText } from "../state/prompt"

export type ReplyMatrix = { rows: string[][]; m: number; n: number }

// Same text rule as Word Insert/Replace and Copy (state/prompt.ts writeText, M8-02b):
// leading whitespace-only lines (empty rows) and trailing line breaks are dropped.
export function replyToMatrix(reply: string): ReplyMatrix {
  const text = writeText(reply)
  if (!text.includes("\t")) return { rows: [[text]], m: 1, n: 1 }
  const split = text.split("\n").map((line) => line.split("\t"))
  const n = Math.max(...split.map((row) => row.length))
  return {
    rows: split.map((row) => [...row, ...Array<string>(n - row.length).fill("")]),
    m: split.length,
    n,
  }
}
