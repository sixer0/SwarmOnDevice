// FR-13: reply text to the matrix written back to Excel.

export type ReplyMatrix = { rows: string[][]; m: number; n: number }

export function replyToMatrix(reply: string): ReplyMatrix {
  const text = reply.replace(/\r\n/g, "\n").replace(/\n+$/, "")
  if (!text.includes("\t")) return { rows: [[text]], m: 1, n: 1 }
  const split = text.split("\n").map((line) => line.split("\t"))
  const n = Math.max(...split.map((row) => row.length))
  return {
    rows: split.map((row) => [...row, ...Array<string>(n - row.length).fill("")]),
    m: split.length,
    n,
  }
}
