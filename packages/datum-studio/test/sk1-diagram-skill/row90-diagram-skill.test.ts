// Swarm 1.3.3 row 90 (SK-1): the bundled gsp-diagram-standard skill states only what the engine does.
// - The tested examples A and B in SKILL.md are the row 89 fixtures byte for byte (as JSON) and still pass both paths
//   at `text` with no defect; example C (PoE tree) is refused at `text` and passes at `full` (decision C29).
// - Text rules of the brief: no "pairing reconstructed", no font-dir field in the frame guide (C31), no `tool {json}`
//   call form, every `datum-studio_studio_*` name is a Studio tool, the capacity resource is the published one.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { DIAGRAM_CAPACITY_URI } from "../../src/mcp-host/capacity-guide"
import { createProduct, type Product, type Rendered } from "../st3-round2-replay/_product"

type J = Record<string, any>
const PKG = path.join(import.meta.dir, "..", "..")
const SKILL_DIR = path.join(PKG, "..", "desktop", "datum", "gsp-diagram-standard")
const SKILL = readFileSync(path.join(SKILL_DIR, "SKILL.md"), "utf8")
const GUIDE = readFileSync(path.join(SKILL_DIR, "references", "cara_bingkai_lembar.md"), "utf8")
const FIX = path.join(PKG, "test", "sk1-reference-specs", "fixtures")
const fixture = (name: string) => JSON.parse(readFileSync(path.join(FIX, name), "utf8")) as J

/** The JSON code block that follows the example heading `<letter>. ` in SKILL.md section 10. */
function example(letter: string): J {
  const at = SKILL.indexOf(`\n${letter}. `)
  expect(at).toBeGreaterThan(-1)
  const m = /```json\n([\s\S]*?)\n```/.exec(SKILL.slice(at))
  if (!m) throw new Error(`example ${letter}: no json block`)
  return JSON.parse(m[1]) as J
}

/** Every tool name the Studio host and the vendored MCP scripts register or name, read from their source text. */
function studioToolNames(): Set<string> {
  const names = new Set<string>()
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".ts")) for (const m of readFileSync(p, "utf8").matchAll(/"(studio_[a-z_]+)"/g)) names.add(m[1])
    }
  }
  walk(path.join(PKG, "src", "mcp-host"))
  walk(path.join(PKG, "vendor", "scripts", "studio", "mcp"))
  return names
}

let product: Product
const out: Record<string, Rendered> = {}

beforeAll(async () => {
  product = await createProduct()
  out.a = await product.render(fixture("spec_1_d1_template.json"), "text")
  out.b = await product.render(fixture("spec_6_rag_sequence.json"), "text")
  out.cText = await product.render(fixture("spec_3_poe_budget.json"), "text")
  out.cFull = await product.render(fixture("spec_3_poe_budget.json"), "full")
}, 180000)
afterAll(() => product?.dispose())

describe("row 90: tested examples in the skill", () => {
  test("examples A and B are the row 89 fixtures", () => {
    expect(example("A")).toEqual(fixture("spec_1_d1_template.json"))
    expect(example("B")).toEqual(fixture("spec_6_rag_sequence.json"))
  })

  test("A and B build on the document and preview paths at text with no defect", () => {
    for (const r of [out.a, out.b]) {
      for (const p of [r.document, r.preview]) {
        expect(p.refusal).toBeNull()
        expect(p.svg).not.toBeNull()
        expect(p.defects).toEqual([])
      }
    }
  })

  test("C is refused at text and builds with no defect at full", () => {
    for (const p of [out.cText.document, out.cText.preview]) {
      expect(p.refusal?.code).toBe("FIGURE_OVER_CAPACITY")
      expect(p.refusal?.checkId).toBe("DATUM-37-sheet")
    }
    for (const p of [out.cFull.document, out.cFull.preview]) {
      expect(p.refusal).toBeNull()
      expect(p.defects).toEqual([])
    }
  })
})

describe("row 90: text rules", () => {
  test("no reconstructed-pairing mark is left (row 88 E1-E9)", () => {
    expect(SKILL).not.toContain("pairing reconstructed")
  })

  test("the frame guide and the skill never name the font-dir field (C31)", () => {
    expect(GUIDE).not.toContain("font_dir")
    expect(SKILL).not.toContain("font_dir")
  })

  test("no `tool {json}` call form", () => {
    expect(SKILL).not.toMatch(/studio_\w+ \{/)
    expect(GUIDE).not.toMatch(/studio_\w+ \{/)
  })

  test("every datum-studio tool name is a Studio tool", () => {
    const known = studioToolNames()
    const used = [...new Set([...`${SKILL}\n${GUIDE}`.matchAll(/datum-studio_(studio_[a-z_]+)/g)].map((m) => m[1]))]
    expect(used.length).toBeGreaterThan(5)
    expect(used.filter((n) => !known.has(n))).toEqual([])
  })

  test("the capacity table is the published resource", () => {
    expect(SKILL).toContain(DIAGRAM_CAPACITY_URI)
  })
})
