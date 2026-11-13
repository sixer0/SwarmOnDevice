// Swarm 1.2.7 row 40 (AC-T13, N7-109): chapter-scope OVERLAP_CLIP reads the page margins. In chapter (draft) scope
// the first selector-less @page rule is the DRAF margin-box rule without margins, so `contentHeightMm` returned null
// (MARGINS_UNREADABLE). No browser: `lengthMm` and `contentHeightMm` are sliced out of the OVERLAP_SCRIPT text and
// evaluated with a stub `pageRules` built from the synthetic fixtures.
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { OVERLAP_SCRIPT } from "../../src/mcp-host/verify/overlap-script"

interface FixtureRule {
  type: number
  selectorText: string
  style: Record<string, string>
}
interface Fixture {
  pageHeightMm: number
  expectedContentHeightMm: number
  rules: FixtureRule[]
}

const FX = join(import.meta.dir, "..", "fixtures", "syn127")
const load = (name: string): Fixture => JSON.parse(readFileSync(join(FX, name), "utf8"))

/** Source text of `function <name>(...) { ... }` in the script, by brace matching. */
function sliceFunction(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let depth = 0
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1)
  }
  throw new Error(`function ${name} not closed`)
}

function contentHeight(fx: Pick<Fixture, "pageHeightMm" | "rules">): number | null {
  const rules = fx.rules.map((r) => ({
    type: r.type,
    selectorText: r.selectorText,
    style: { getPropertyValue: (n: string) => r.style[n] ?? "" },
  }))
  const body = `${sliceFunction(OVERLAP_SCRIPT, "lengthMm")}\n${sliceFunction(OVERLAP_SCRIPT, "contentHeightMm")}\nreturn contentHeightMm();`
  return new Function("o", "pageRules", body)({ pageHeightMm: fx.pageHeightMm }, () => rules) as number | null
}

describe("rel127 T-13: contentHeightMm picks the margin-bearing @page rule", () => {
  it("chapter order (DRAF margin-box rule first): 297 - 26 - 24 = 247", () => {
    const fx = load("t13_chapter_page_rules.json")
    expect(contentHeight(fx)).toBe(fx.expectedContentHeightMm)
    expect(contentHeight(fx)).toBe(247)
  })

  it("CHAR: document order (margin rule first) gives 247", () => {
    const fx = load("t13_document_page_rules.json")
    expect(contentHeight(fx)).toBe(247)
  })

  it("CHAR: no readable margins anywhere gives null (MARGINS_UNREADABLE path kept)", () => {
    const fx = load("t13_chapter_page_rules.json")
    const rules = fx.rules.map((r) => ({ ...r, style: Object.fromEntries(Object.entries(r.style).filter(([k]) => !k.startsWith("margin"))) }))
    expect(contentHeight({ pageHeightMm: 297, rules })).toBeNull()
    expect(contentHeight({ pageHeightMm: 297, rules: [] })).toBeNull()
  })

  it("a selector rule with margins is used only when no selector-less rule has them", () => {
    const fx = load("t13_chapter_page_rules.json")
    const rules = [fx.rules[0], { type: 6, selectorText: "st-x", style: { "margin-top": "10mm", "margin-bottom": "10mm" } }]
    expect(contentHeight({ pageHeightMm: 297, rules })).toBe(277)
  })
})
