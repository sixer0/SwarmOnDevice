import { describe, expect, test } from "bun:test"
import { condense } from "../../src/tool/condense"

const lines = (count: number, line: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => line(index)).join("\n")

describe("condense", () => {
  test("removes colours and keeps only what a progress bar drew last", () => {
    const text = "\x1b[36mDownloading\x1b[0m 1%\rDownloading 50%\rDownloading 100%\n\x1b[1;31mdone\x1b[0m"
    expect(condense({ text })).toEqual({ text: "Downloading 100%\ndone", hidden: 0 })
  })

  test("collapses a long run of lines that differ only by numbers, keeping both ends", () => {
    const result = condense({ text: lines(100, (i) => `ok test_${i} (${i}ms)`) })
    expect(result.hidden).toBe(95)
    expect(result.text.split("\n")).toEqual([
      "ok test_0 (0ms)",
      "ok test_1 (1ms)",
      "ok test_2 (2ms)",
      "... 95 similar lines ...",
      "ok test_98 (98ms)",
      "ok test_99 (99ms)",
    ])
  })

  test("never hides a failure, however many look alike", () => {
    const text = lines(40, (i) => `FAILED tests/case_${i}.py`)
    expect(condense({ text })).toEqual({ text, hidden: 0 })
  })

  test("a failure in the middle of passing lines survives", () => {
    const text = [
      lines(30, (i) => `ok ${i}`),
      "error: database refused the connection",
      lines(30, (i) => `ok ${i}`),
    ].join("\n")
    const result = condense({ text })
    expect(result.text).toContain("error: database refused the connection")
    expect(result.hidden).toBe(50)
  })

  test("leaves short runs alone", () => {
    const text = lines(11, (i) => `step ${i}`)
    expect(condense({ text })).toEqual({ text, hidden: 0 })
  })

  test("does not collapse output the agent selected on purpose, in any part of a pipeline", () => {
    const text = lines(50, (i) => `row ${i},${i * 2}`)
    for (const command of ["cat data.csv", "bun run report | head -50", "cd src && grep -n row x", "git log --oneline"])
      expect(condense({ text, command }).hidden).toBe(0)
    expect(condense({ text, command: "bun test" }).hidden).toBe(45)
  })

  test("treats blank lines as content", () => {
    const text = lines(30, () => "")
    expect(condense({ text })).toEqual({ text, hidden: 0 })
  })
})
