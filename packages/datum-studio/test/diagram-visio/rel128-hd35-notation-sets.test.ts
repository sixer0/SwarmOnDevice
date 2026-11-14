// Swarm 1.2.8 row 53a (AC-HD35 = VIS-1a, H-D35; ruling D-V1; F-VISIO 01f §1.4; register N8-245, N8-370).
// Notation sets with overlap acceptance: `SHAPES[s].notation_set` replaces the single `notation` string; DATUM-35 refuses a
// figure only when the intersection of the sets of its non-universal nodes is empty, and its message lists each dialect
// once with one example node, separator "; ".
// Red at BASE e1f9673772: hexagon carries the string "ISO 5807, BPMN", so stadium + hexagon + diamond (+ parallelogram)
// is refused as two dialects and the message joins three entries with commas; the BPMN tokens do not exist.
// The "event_start + diamond + task" case is marked "(after VIS-3)" in 01_specs.md:127; row 54 (plan issue I-3) turned its
// test.todo into a test (valid, and drawn with the event outline and 0 geometry defects).
// Namespace import: at BASE `notation_set` does not exist, so the red run fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import * as tokens from "../../vendor/src/lib/studio/engine/diagram/core/tokens"
import { loadSpec, validateSpec } from "../../vendor/src/lib/studio/engine/diagram/core/spec"
import * as buildMod from "../../vendor/src/lib/studio/engine/diagram/build"
import * as lintMod from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import fx from "../fixtures/syn128/hd35_sets.json"

type J = Record<string, any>
type Case = { name: string; shapes: string[]; expect: "valid" | "DATUM-35"; common?: string[]; message?: string; after?: string }
const SHAPES = (tokens as J).SHAPES as Record<string, J>

/** A flow spec around the case shapes: chain n1 -> n2 -> ..., every decision shape gets two labelled exits. */
function spec(shapes: string[]): J {
  const nodes: J[] = shapes.map((s, i) => ({ id: `n${i + 1}`, label: `Alfa ${i + 1}`, shape: s, class: {} }))
  const edges: J[] = []
  shapes.forEach((s, i) => {
    const decision = s === "diamond" || s.startsWith("gateway_")
    if (i + 1 < shapes.length) edges.push({ from: `n${i + 1}`, to: `n${i + 2}`, kind: "data", label: decision ? "ya" : "lanjut" })
    if (decision) {
      nodes.push({ id: `x${i + 1}`, label: `Bravo ${i + 1}`, class: {} })
      edges.push({ from: `n${i + 1}`, to: `x${i + 1}`, kind: "data", label: "tidak" })
    }
  })
  return { family: "flow", id: "1.1", title: "Uji notasi.", classification: "BIASA", width_mm: 128, labels_verified: true, sources: ["S"], nodes, edges }
}
const fails = (shapes: string[]) => validateSpec(loadSpec(spec(shapes))).filter((i: J) => i.status === "FAIL")

describe("rel128-hd35 notation sets (AC-HD35)", () => {
  test("token field: notation_set per 01f §1.4 (universal = [])", () => {
    const want: Record<string, string[]> = {
      box: [], circle: [], cylinder: [], annotation: [],
      stadium: ["ISO 5807"], parallelogram: ["ISO 5807"], hexagon: ["ISO 5807"], predefined: ["ISO 5807"], document: ["ISO 5807"], offpage: ["ISO 5807"],
      diamond: ["ISO 5807", "BPMN"],
      event_start: ["BPMN"], event_intermediate: ["BPMN"], event_end: ["BPMN"], task: ["BPMN"], subprocess: ["BPMN"],
      gateway_exclusive: ["BPMN"], gateway_parallel: ["BPMN"], gateway_inclusive: ["BPMN"], gateway_complex: ["BPMN"], data_object: ["BPMN"],
      doubled: ["UML component"], shadowed: ["DFD Gane-Sarson"], bus: ["IEC 60617"],
    }
    for (const [shape, set] of Object.entries(want)) expect([...(SHAPES[shape]?.notation_set ?? ["<missing>"])], shape).toEqual(set)
    for (const t of Object.values(SHAPES)) expect("notation" in t).toBe(false)
  })

  test(`(a) ${fx.base_case.name}: valid at HEAD`, () => {
    expect(fails(fx.base_case.shapes).map((i: J) => i.checkId)).toEqual([])
  })

  for (const c of fx.cases as Case[]) {
    if (c.after) {
      // Row 54 (plan I-3, C42): the "(after VIS-3)" case is valid AND drawn — the event outline exists since row 54, so the
      // figure builds and the event adds no geometry defect: the lint gives exactly what the same figure gives with a box
      // in the event's place (this legacy list flow's diamond fan has two pre-existing connector-end findings).
      test(`${c.name}: valid {${(c.common ?? []).join(", ")}} and drawn; the event adds no geometry defect (${c.after})`, () => {
        expect(fails(c.shapes).map((i: J) => i.checkId)).toEqual([])
        const lint = (shapes: string[]) => {
          const r = (buildMod as J).buildDiagramSvg(spec(shapes), { release: false })
          return { svg: r.svg as string, defects: (lintMod as J).lintDiagramGeometry(r.svg).defects as J[] }
        }
        const ev = lint(c.shapes)
        expect(/<circle\b[^>]*data-node="n1"/.test(ev.svg)).toBe(true)
        expect(ev.defects.filter((d) => d.other === "n1")).toEqual([])
        expect(ev.defects).toEqual(lint(c.shapes.map((s) => (s.startsWith("event_") ? "box" : s))).defects)
      })
      continue
    }
    test(`${c.name}: ${c.expect === "valid" ? `valid {${(c.common ?? []).join(", ") || "universal"}}` : "refused DATUM-35"}`, () => {
      const f = fails(c.shapes)
      if (c.expect === "valid") {
        expect(f.map((i: J) => i.checkId)).toEqual([])
        return
      }
      expect(f.map((i: J) => i.checkId)).toEqual(["DATUM-35"])
      // (b) each dialect once with one example node, separator "; " (no comma join of a comma-holding string).
      expect(f[0].detail).toBe(`DATUM-35: notasi bentuk tidak dapat digabung: ${c.message} — satu notasi per gambar (P3/P5)`)
      expect(f[0].pointer).toBe("/nodes")
    })
  }

  test("(b) two dialects give exactly two message entries", () => {
    const f = fails(["stadium", "hexagon", "diamond", "parallelogram", "doubled"])
    expect(f.map((i: J) => i.checkId)).toEqual(["DATUM-35"])
    const entries = String(f[0].detail).replace(/^DATUM-35: notasi bentuk tidak dapat digabung: /, "").replace(/ — .*$/, "").split("; ")
    expect(entries).toEqual(["ISO 5807 (n1: stadium)", "UML component (n5: doubled)"])
  })

  test("(b) a multi-dialect node is named only when no single-dialect node covers it (diamond + bus)", () => {
    const f = fails(["diamond", "bus"])
    expect(f.map((i: J) => i.checkId)).toEqual(["DATUM-35"])
    expect(f[0].detail).toBe("DATUM-35: notasi bentuk tidak dapat digabung: ISO 5807 / BPMN (n1: diamond); IEC 60617 (n2: bus) — satu notasi per gambar (P3/P5)")
  })
})
