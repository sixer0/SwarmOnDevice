/**
 * Swarm 1.2.7 row 37 (N-6 / F-6, AC-N6, register N7-104, N7-069; decision C3: publish, no reorder, engine test).
 *
 * Contract part (red at 04067a9d02):
 *  (a) `GEOM_T03_CODES` exported by the preview route equals the three T-03 preview codes, in order.
 *  (b) each name equals the engine `CHECK` code of its kind, observed through `diagramGeometryIssues`.
 *  (c) `diagramGuideText()` names each code and the scope note `at least 1.5 mm`.
 *  (d) the agent guide carries the scope sentence `Cakupan: GEOM_ENTRY_COLLISION`.
 * Engine part (CHAR, green at BASE and HEAD: when ENTRY_COLLISION fires):
 *  (e) a hand-drawn SVG with two connector ends 1.0 mm apart on one node border gives edgeEntryCollision >= 1
 *      and the GEOM_ENTRY_COLLISION issue; (f) the same figure at 5.0 mm gives 0;
 *  (g) F-6: the 8 engine fan-in layouts built with `buildDiagramSvgAuto` give edgeEntryCollision = 0.
 * Fixtures: syn127 (row 20), synthetic, filler labels. No fit/lint.ts or autofit.ts change (no reorder).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
// Namespace import: at BASE the export is missing, so (a) fails on an assertion, not on a link error.
import * as route from "../../src/mcp-host/local-api/routes/figure-preview-figure"
import { diagramGuideText } from "../../src/mcp-host/diagram-guide.ts"
import { diagramGeometryIssues } from "@/lib/studio/engine/diagram/build/autofit"
import { lintDiagramGeometry, type DiagramGeomLint } from "@/lib/studio/engine/diagram/fit/lint"
import { buildDiagramSvgAuto } from "@/lib/studio/engine/diagram/elk"

const PKG = path.resolve(import.meta.dir, "..", "..")
const SYN = path.join(PKG, "test", "fixtures", "syn127")
const syn = (name: string) => readFileSync(path.join(SYN, name), "utf8")
const GUIDE = readFileSync(path.join(PKG, "vendor", "docs", "STUDIO-AGENT-GUIDE.md"), "utf8")

const NAMES = ["GEOM_ENTRY_COLLISION", "GEOM_STUB_SEGMENT", "GEOM_ARROW_TANGENT"] as const
const KINDS = ["edgeEntryCollision", "stubSegment", "arrowTangent"] as const

describe("N-6 contract: GEOM_T03_CODES (N7-069)", () => {
  test("(a) the route exports the three T-03 codes, in order", () => {
    expect((route as Record<string, unknown>).GEOM_T03_CODES).toEqual([...NAMES])
  })

  test("(b) each name is the engine check id of its kind (diagramGeometryIssues)", () => {
    const codes = ((route as Record<string, unknown>).GEOM_T03_CODES ?? []) as readonly string[]
    KINDS.forEach((kind, i) => {
      const g = {
        widthMm: 100,
        heightMm: 80,
        score: 0,
        counts: {},
        defects: [{ kind, text: "uji", amount: 1 }],
      } as unknown as DiagramGeomLint
      expect(diagramGeometryIssues(g).map((x) => x.checkId)).toEqual([codes[i]])
    })
  })

  test("(c) the diagram resource names each code and the 1.5 mm scope note", () => {
    const t = diagramGuideText()
    for (const n of NAMES) expect(t).toContain(n)
    expect(t).toContain("at least 1.5 mm")
    expect(t).toContain("hand-drawn or imported SVG")
  })

  test("(d) the agent guide carries the scope sentence", () => {
    expect(GUIDE).toContain("Cakupan: GEOM_ENTRY_COLLISION")
  })
})

describe("N-6 engine part (CHAR): when GEOM_ENTRY_COLLISION fires", () => {
  test("(e) hand-drawn SVG, two entries 1.0 mm apart on one border: fires", () => {
    const g = lintDiagramGeometry(syn("n6_entry_collision.svg"))
    expect(g.counts.edgeEntryCollision).toBeGreaterThanOrEqual(1)
    expect(diagramGeometryIssues(g).map((i) => i.checkId)).toContain("GEOM_ENTRY_COLLISION")
  })

  test("(f) the same figure with entries 5.0 mm apart: clean", () => {
    const g = lintDiagramGeometry(syn("n6_entry_clear.svg"))
    expect(g.counts.edgeEntryCollision).toBe(0)
    expect(diagramGeometryIssues(g).map((i) => i.checkId)).not.toContain("GEOM_ENTRY_COLLISION")
  })

  const F6 = JSON.parse(syn("f6_fan_in_specs.json")) as { specs: Array<{ name: string; spec: any }> }
  test("(g) F-6: the fixture holds the 8 probe fan-in configurations", () => {
    expect(F6.specs.length).toBe(8)
  })
  for (const { name, spec } of F6.specs) {
    test(`(g) F-6 engine layout never collides: ${name}`, async () => {
      const r = await buildDiagramSvgAuto(structuredClone(spec), { release: false })
      expect(lintDiagramGeometry(r.svg).counts.edgeEntryCollision).toBe(0)
    })
  }
})
