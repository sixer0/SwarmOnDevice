/**
 * Swarm 1.2.6 row 26 (T-03 gate, register N-007, U3): the three T-03 defect kinds `edgeEntryCollision`,
 * `stubSegment`, `arrowTangent` FAIL FIGURE_FIT (`DIAGRAM_FAIL_KINDS` 6 -> 9). Flow F1: each anonymised
 * judge-rejected figure (fixtures anon126/t03_k1..k7) fails FIGURE_FIT on a new kind from its expected set; the
 * negative controls t03_n1 / t03_n2 carry no new-kind FAIL. One synthetic SVG per kind fails with that kind.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { checkFigureFit, DIAGRAM_FAIL_KINDS } from "../../src/mcp-host/verify/static-checks"

const NEW = ["edgeEntryCollision", "stubSegment", "arrowTangent"] as const
type NewKind = (typeof NEW)[number]

const FIX = path.join(import.meta.dir, "..", "fixtures", "anon126")
const fixture = (name: string) => readFileSync(path.join(FIX, `${name}.svg`), "utf8")

const gate = (svg: string) => checkFigureFit({ format: "SVG", svg, figureKind: "diagram", figureLabel: "Gambar 1.1" })
/**
 * New kinds among the FIG_GEOMETRY findings that FAIL the check. Fail and note findings both land in `findings`,
 * so a kind counts as failing only when the gate's own fail set holds it (a note-only kind does not fail).
 */
const kindsOf = (c: ReturnType<typeof gate>) =>
  c.findings.filter((f) => f.code === "FIG_GEOMETRY").map((f) => (f.detail ?? "").split(":")[0])
const newKindsOf = (c: ReturnType<typeof gate>) =>
  kindsOf(c).filter((k) => (NEW as readonly string[]).includes(k) && DIAGRAM_FAIL_KINDS.has(k as NewKind))

const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">\n<rect x="0" y="0" width="100" height="80" fill="#FCFCFB"/>\n${body}\n</svg>`
const link = (d: string) => `<path d="${d}" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`
const box = (id: string, x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" data-node="${id}" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`

const SYNTH: Record<NewKind, { bad: string; clean: string }> = {
  edgeEntryCollision: {
    bad: svgOf([link("M 30 10 L 30 50"), link("M 31 10 L 31 50"), box("n1", 20, 50, 30, 10)].join("\n")),
    clean: svgOf([link("M 30 10 L 30 50"), link("M 35 10 L 35 50"), box("n1", 20, 50, 30, 10)].join("\n")),
  },
  stubSegment: {
    bad: svgOf([box("a", 20, 5, 20, 10), link("M 30 15 L 30 30 L 31 30 L 31 50"), box("b", 21, 50, 20, 10)].join("\n")),
    clean: svgOf([box("a", 20, 5, 20, 10), link("M 30 15 L 30 50"), box("b", 20, 50, 20, 10)].join("\n")),
  },
  arrowTangent: {
    bad: svgOf([link("M 40 70 L 40 25"), box("n1", 40, 20, 30, 10)].join("\n")),
    clean: svgOf([link("M 55 70 L 55 30"), box("n1", 40, 20, 30, 10)].join("\n")),
  },
}

describe("T-03 gate: DIAGRAM_FAIL_KINDS 6 -> 9 (N-007)", () => {
  test("the three T-03 kinds fail FIGURE_FIT; edgeCross / edgeCollinear stay report-only", () => {
    expect(DIAGRAM_FAIL_KINDS.size).toBe(13) // 1.2.8 row 55c (INTENT, C133): + frameOutside; row 58b (INTENT, C134): + labelCollision; row 68a (INTENT, C166): + edgeOutside, edgeEndOffNode
    for (const k of NEW) expect(DIAGRAM_FAIL_KINDS.has(k)).toBe(true)
    expect(DIAGRAM_FAIL_KINDS.has("edgeCross")).toBe(false)
    expect(DIAGRAM_FAIL_KINDS.has("edgeCollinear")).toBe(false)
  })
  for (const k of NEW) {
    test(`${k}: synthetic SVG FAILS FIGURE_FIT with that kind; its clean twin PASSES`, () => {
      const bad = gate(SYNTH[k].bad)
      expect(bad.status).toBe("FAIL")
      expect(newKindsOf(bad)).toContain(k)
      expect(gate(SYNTH[k].clean).status).toBe("PASS")
    })
  }
})

/** Expected kind set per F1 figure (01g F1 mapping, as row 25). */
const F1: Record<string, NewKind[]> = {
  t03_k1: ["stubSegment", "arrowTangent"],
  t03_k2: ["stubSegment", "edgeEntryCollision"],
  t03_k3: ["stubSegment", "arrowTangent"],
  t03_k4: ["stubSegment"],
  t03_k5: ["stubSegment", "arrowTangent", "edgeEntryCollision"],
  t03_k6: ["stubSegment"],
  t03_k7: ["stubSegment"],
}

describe("F1: judge-rejected figures FAIL FIGURE_FIT on a new kind", () => {
  for (const [name, expected] of Object.entries(F1)) {
    test(`${name}: FAIL with ${expected.join(" | ")}`, () => {
      const c = gate(fixture(name))
      expect(c.status).toBe("FAIL")
      expect(newKindsOf(c).some((k) => (expected as string[]).includes(k))).toBe(true)
    })
  }
})

describe("F1 negative controls: no new-kind FAIL", () => {
  for (const name of ["t03_n1", "t03_n2"]) {
    test(`${name}: no T-03 kind in FIGURE_FIT`, () => {
      expect(newKindsOf(gate(fixture(name)))).toEqual([])
    })
  }
})
