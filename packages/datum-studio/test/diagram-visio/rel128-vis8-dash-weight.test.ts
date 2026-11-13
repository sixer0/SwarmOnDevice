// Swarm 1.2.8 row 57b (AC-VIS8, VIS-8, F-VISIO 01f §3.1, §3.5, AT-V8-dash-weight; register N8-212, N8-262, N8-263,
// N8-264, N8-380, N8-468; C78, C111). Edge `dash` (solid, dashed, dotted, longdash, dashdot = DASH_PATTERNS) and
// `weight` (thin 0.30, normal 0.45, thick 0.70 mm = WEIGHT_MM) are drawn on the connector; an arrowhead follows the
// weight (its marker id gains `-<weight>`, its stroke the line width: a thick edge never reuses the normal head);
// explicit defaults render byte-identical; DATUM-25L counts the (kind, dash, weight) styles; every stroke >= 0.18 mm.
// Fixture: test/fixtures/syn128/vis8_dash_weight.json (synthetic labels).
// Red at BASE e1f9673772: the schema refuses `dash` and `weight`, the engine draws the kind pattern and width only.
// Namespace imports, so the red run fails on assertions, not on a link error.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as core from "../../vendor/src/lib/studio/engine/diagram/core"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"

type J = Record<string, any>
const C = core as J
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis8_dash_weight.json"), "utf8")) as J
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const DASH: Record<string, string | undefined> = { solid: undefined, dashed: "3.2,1.6", dotted: "0.2,1.1", longdash: "7.1,1.6", dashdot: "7.1,1.6,0.2,1.6" }
const WEIGHT: Record<string, number> = { thin: 0.3, normal: 0.45, thick: 0.7 }

const svgOf = (spec: J): string => {
  const r = buildDiagramSvg(clone(spec) as never, O) as J
  return r.svg as string
}
const links = (svg: string) => [...svg.matchAll(/<path d="[^"]+"([^>]*data-mark="link"[^>]*)\/>/g)].map((m) => m[1])
const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]+)"`).exec(s)?.[1]
const endRef = (s: string) => /url\(#([^)]+)\)/.exec(attr(s, "marker-end") ?? "")?.[1]
function markers(svg: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of svg.matchAll(/<marker\b([^>]*)>([\s\S]*?)<\/marker>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[1])![1]
    expect(out.has(id), `marker ${id} defined once`).toBe(false)
    out.set(id, m[2])
  }
  return out
}
const refusals = (spec: J) => (C.validateSpec(C.loadSpec(clone(spec))) as J[]).filter((i) => i.status !== "PASS")

describe("VIS-8 dash patterns (N8-262)", () => {
  for (const k of ["dashes_a", "dashes_b"]) {
    test(`${k}: each connector's stroke-dasharray is DASH_PATTERNS[dash] (solid = no attribute); passes validateSpec`, () => {
      expect(refusals(FX[k])).toEqual([])
      const ls = links(svgOf(FX[k]))
      expect(ls.length).toBe(FX[k].edges.length)
      FX[k].edges.forEach((e: J, i: number) => expect(attr(ls[i], "stroke-dasharray"), `${k} edge ${i} ${e.dash}`).toBe(DASH[e.dash]))
    })
  }
  test("dashes_b: a solid control edge keeps the control colour and its open kind head (dash is not colour or head)", () => {
    const ls = links(svgOf(FX.dashes_b))
    expect(attr(ls[1], "stroke")).toBe("#2B3640")
    expect(endRef(ls[1])).toBe("head-control")
  })
})

describe("VIS-8 weights (N8-263, N8-264) and the head per weight (C111)", () => {
  const svg = svgOf(FX.weights)
  const ls = links(svg)
  const mk = markers(svg)
  test("stroke-width thin 0.30, absent 0.45, thick 0.70 mm; control thick 0.70", () => {
    expect(ls.map((l) => Number(attr(l, "stroke-width")))).toEqual([0.3, 0.45, 0.7, 0.7])
  })
  test("heads: head-data-thin, head-data (normal), head-data-thick, head-control-thick; each defined once", () => {
    expect(ls.map(endRef)).toEqual(["head-data-thin", "head-data", "head-data-thick", "head-control-thick"])
    for (const id of ["head-data-thin", "head-data", "head-data-thick", "head-control-thick"]) expect(mk.has(id), id).toBe(true)
    expect(mk.has("head-control")).toBe(false)
  })
  test("the open head of the thick control edge is stroked at the line width (0.70), not the normal 0.45", () => {
    expect(Number(attr(mk.get("head-control-thick")!, "stroke-width"))).toBe(0.7)
  })
  test("C119: on the thick line the path stops under the triangle where the head is as wide as the line; the tip stays", () => {
    // reach = tip x - refX of the head = how far the tip lies past the drawn path end (vertical edges, pointing down)
    const reachOf = (id: string) => {
      const m = new RegExp(`<marker id="${id}"[^>]*refX="([\\d.]+)"[^>]*>([\\s\\S]*?)</marker>`).exec(svg)!
      return Math.max(...[...m[2].matchAll(/M?L?(-?[\d.]+),/g)].map((p) => Number(p[1]))) - Number(m[1])
    }
    const endY = (l: number) => {
      const d = [...svg.matchAll(/<path d="([^"]+)"[^>]*data-mark="link"/g)][l][1]
      return Number(d.trim().split(/\s+/).pop())
    }
    expect(reachOf("head-data-thick")).toBeCloseTo(0.7 / 0.89, 1)
    expect(reachOf("head-data")).toBeCloseTo(3.2 / 18, 1)
    expect(reachOf("head-data-thin")).toBeCloseTo(3.2 / 18, 1)
    // the tip of the thick edge (index 2) lands where the normal edge's tip (index 1) does: same target row
    expect(Math.abs(endY(2) + reachOf("head-data-thick") - (endY(1) + reachOf("head-data")))).toBeLessThanOrEqual(0.02)
  })
  test("every stroke-width in the figure >= 0.18 mm (photocopy floor)", () => {
    const ws = [...svg.matchAll(/stroke-width="([^"]+)"/g)].map((m) => Number(m[1]))
    expect(ws.length).toBeGreaterThan(0)
    expect(Math.min(...ws)).toBeGreaterThanOrEqual(0.18)
  })
})

describe("VIS-8 accent width", () => {
  test("C119: accent (0.72 mm) path ends 0.72 / 0.89 mm before the tip, accent weight normal keeps L/18", () => {
    const reach = (svg: string, id: string) => {
      const m = new RegExp(`<marker id="${id}"[^>]*refX="([\\d.]+)"[^>]*>([\\s\\S]*?)</marker>`).exec(svg)!
      return Math.max(...[...m[2].matchAll(/(-?[\d.]+),/g)].map((p) => Number(p[1]))) - Number(m[1])
    }
    expect(reach(svgOf(FX.accent_absent), "head-accent")).toBeCloseTo(0.72 / 0.89, 1)
    expect(reach(svgOf(FX.accent_normal), "head-accent-normal")).toBeCloseTo(3.2 / 18, 1)
  })
  test("accent absent = 0.72 mm with head-accent; weight normal on accent = 0.45 mm with head-accent-normal", () => {
    const a = links(svgOf(FX.accent_absent))[0]
    const n = links(svgOf(FX.accent_normal))[0]
    expect([Number(attr(a, "stroke-width")), endRef(a)]).toEqual([0.72, "head-accent"])
    expect([Number(attr(n, "stroke-width")), endRef(n)]).toEqual([0.45, "head-accent-normal"])
  })
})

describe("VIS-8 explicit default = absent (01f §3.2.2)", () => {
  test("dash = the kind pattern and weight normal render byte-identical to the absent fields, sync and auto", async () => {
    expect(svgOf(FX.explicit_defaults)).toBe(svgOf(FX.absent))
    const a = ((await buildDiagramSvgAuto(clone(FX.absent), O as never, {}, () => {})) as J).svg
    const e = ((await buildDiagramSvgAuto(clone(FX.explicit_defaults), O as never, {}, () => {})) as J).svg
    expect(e).toBe(a)
  })
})

describe("VIS-8 DATUM-25L key = (kind, dash, weight) (N8-212, 01f §3.5)", () => {
  test("4 styles of one kind with a node mark: refused, the message gives the count, the styles and the limit 3", () => {
    const r = refusals(FX.refused_mark)
    expect(r.map((i) => i.checkId)).toEqual(["DATUM-25L"])
    expect(r[0].detail).toContain("DATUM-25L: 4 gaya garis")
    expect(r[0].detail).toContain("data/dashed/normal")
    expect(r[0].detail).toContain("data/solid/thick")
    expect(r[0].detail).toContain("maksimum 3")
  })
  test("5 styles without a mark: refused with the count 5 and the limit 4; the same 4 styles without the fifth pass", () => {
    const r = refusals(FX.refused_five)
    expect(r.map((i) => i.checkId)).toEqual(["DATUM-25L"])
    expect(r[0].detail).toContain("DATUM-25L: 5 gaya garis")
    expect(r[0].detail).toContain("maksimum 4")
    expect(refusals(FX.four_ok)).toEqual([])
  })
  test("the engine refuses the 5-style figure at build (no SVG)", () => {
    expect(() => buildDiagramSvg(clone(FX.refused_five), O)).toThrow(/DATUM-25L/)
  })
})

describe("VIS-8 geometry", () => {
  for (const k of ["dashes_a", "dashes_b", "weights", "accent_normal", "four_ok"]) {
    test(`${k}: 0 geometry defects, sync and production (auto) path`, async () => {
      expect(lintDiagramGeometry(svgOf(FX[k])).defects).toEqual([])
      const auto = (await buildDiagramSvgAuto(clone(FX[k]), O as never, {}, () => {})) as J
      expect(lintDiagramGeometry(auto.svg).defects).toEqual([])
    })
  }
})
