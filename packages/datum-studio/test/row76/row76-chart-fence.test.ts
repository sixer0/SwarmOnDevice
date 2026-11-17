// Swarm 1.3.3 row 76 (ST-10): a ```chart fence is never stored as a code block; the import is refused with CHART_FENCE_REFUSED.
import { describe, expect, test } from "bun:test"
import { importMarkdownChapter } from "../../vendor/src/lib/studio/services/import/markdown"

const run = (md: string) => importMarkdownChapter(md, { chapterKey: "1" })
const refusal = (md: string): any => {
  try {
    run(md)
  } catch (e) {
    return e
  }
  return null
}

describe("row 76: chart fence refused", () => {
  test("refuses the whole import with the code, the fence line and the way to add a chart", () => {
    const e = refusal('# Bab\n\nTeks.\n\n```chart\n{"type":"bar"}\n```\n')
    expect(e).not.toBeNull()
    expect(e.code).toBe("SCHEMA_INVALID")
    expect(e.message).toContain("CHART_FENCE_REFUSED")
    expect(e.message).toContain("line 5")
    expect(e.message).toContain("studio_write chart block")
    expect(e.details[0].line).toBe(5)
  })
  test("tilde fence, upper case label and several fences list every line", () => {
    const e = refusal("# Bab\n\n~~~Chart\na\n~~~\n\n```chart extra\nb\n```\n")
    expect(e.message).toContain("lines 3, 7")
  })
  test("ordinary code fences are unchanged", () => {
    const r = run("# Bab\n\n```ts\nconst a = 1\n```\n\n```json\n{\"type\":\"table\"}\n```\n")
    expect((r.chapter.intro ?? []).map((b) => b.type)).toEqual(["monoBlock", "monoBlock"])
    expect(r.report.warnings.map((w) => w.code)).toEqual(["FENCE_KEPT_AS_CODE", "NO_SECTIONS"])
  })
  test("a chart label inside a quote or an indented block is plain text, not a chart fence", () => {
    const r = run("# Bab\n\n> ```chart\n> x\n> ```\n\ntext\n\n    ```chart\n    y\n    ```\n")
    expect(JSON.stringify(r.chapter)).not.toContain('"label":"chart"')
    expect(r.report.warnings.map((w) => w.code)).not.toContain("CHART_FENCE_REFUSED")
  })
  test("a chart word later in the info string or a different language word is not a chart fence", () => {
    const r = run("# Bab\n\n```python chart\nprint(1)\n```\n")
    expect((r.chapter.intro ?? []).map((b) => b.type)).toEqual(["monoBlock"])
  })
})
