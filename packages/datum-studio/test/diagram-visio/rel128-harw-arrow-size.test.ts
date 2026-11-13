// Swarm 1.2.8 row 57 (AC-HARW, H-ARW, F-VISIO 01f §5.3, AT-HARW; register N8-216, N8-217, N8-378, N8-475; C10 OP13-5,
// C12 OP-18-2). The arrowhead is readable at print size: `head-<kind>` markers are drawn in `markerUnits="userSpaceOnUse"`
// mm at size `m` (3.2 mm head length, width 0.89 L), every size >= ARROW_HEAD_MIN_MM 2.5, the tip meets the node outline,
// markers carry no data-mark and the geometry lint (arrowTangent) still reads 0 defects.
// Fixture: test/fixtures/syn128/harw_control_128.json (synthetic labels).
// Red at BASE e1f9673772: markers use the default markerUnits (= stroke width), so a 0.45 mm `control` edge draws a
// 3.6 x 0.45 = 1.62 mm head; ARROW_HEAD_MIN_MM does not exist. Namespace import, so the red run fails on assertions.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import * as tokens from "../../vendor/src/lib/studio/engine/diagram/core/tokens"

type J = Record<string, any>
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "harw_control_128.json"), "utf8")) as J
const O = { release: false }
const KINDS = ["data", "control", "sync", "accent", "alert", "verify"] as const
const OPEN = new Set(["control", "sync", "alert", "verify"])

interface Head {
  id: string
  units: string | undefined
  refX: number
  refY: number
  xs: number[]
  ys: number[]
  closed: boolean
  fill: string
  sw: number
}
const num = (a: string, k: string) => Number(new RegExp(`\\b${k}="([^"]+)"`).exec(a)?.[1] ?? Number.NaN)
function heads(svg: string): Map<string, Head> {
  const out = new Map<string, Head>()
  for (const m of svg.matchAll(/<marker\b([^>]*)>([\s\S]*?)<\/marker>/g)) {
    const a = m[1]
    const body = m[2]
    const d = /\bd="([^"]+)"/.exec(body)?.[1] ?? ""
    const pts = [...d.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])])
    out.set(/\bid="([^"]+)"/.exec(a)![1], {
      id: /\bid="([^"]+)"/.exec(a)![1],
      units: /\bmarkerUnits="([^"]+)"/.exec(a)?.[1],
      refX: num(a, "refX"),
      refY: num(a, "refY"),
      xs: pts.map((p) => p[0]),
      ys: pts.map((p) => p[1]),
      closed: /Z\s*$/i.test(d.trim()),
      fill: /\bfill="([^"]+)"/.exec(body)?.[1] ?? "",
      sw: Number(/\bstroke-width="([^"]+)"/.exec(body)?.[1] ?? 0),
    })
  }
  return out
}
/** Stroke width (mm) of the link paths that reference a marker (markerUnits strokeWidth scales by it). */
function linkStroke(svg: string, id: string): number {
  const m = new RegExp(`<path [^>]*stroke-width="([\\d.]+)"[^>]*marker-end="url\\(#${id}\\)"`).exec(svg)
  return Number(m?.[1] ?? Number.NaN)
}
/** Printed head length and width (mm) of a marker as the SVG renderer draws it. */
function printed(svg: string, h: Head): { len: number; wid: number } {
  const scale = h.units === "userSpaceOnUse" ? 1 : linkStroke(svg, h.id)
  return { len: (Math.max(...h.xs) - Math.min(...h.xs)) * scale, wid: (Math.max(...h.ys) - Math.min(...h.ys)) * scale }
}
/** How far (mm) the drawn head reaches past the path end: tip (+ miter of a stroked tip) minus refX. */
function reach(h: Head): number {
  const tip = Math.max(...h.xs)
  const L = tip - Math.min(...h.xs)
  const W = Math.max(...h.ys) - Math.min(...h.ys)
  const miter = h.closed ? 0 : h.sw / 2 / Math.sin(Math.atan(W / 2 / L))
  return tip + miter - h.refX
}

describe("H-ARW arrowhead size (N8-378)", () => {
  test("ARROW_HEAD_MIN_MM is 2.5; ARROW_SIZES_MM s/m/l = 2.5/3.2/4.0, every size >= the floor (N8-216, N8-217)", () => {
    const t = tokens as J
    expect(t.ARROW_HEAD_MIN_MM).toBe(2.5)
    expect(t.ARROW_SIZES_MM).toEqual({ s: 2.5, m: 3.2, l: 4.0 })
    for (const v of Object.values(t.ARROW_SIZES_MM as Record<string, number>)) expect(v).toBeGreaterThanOrEqual(t.ARROW_HEAD_MIN_MM)
  })

  test("control edge @128: head-control in userSpaceOnUse mm, 3.2 mm long (was 1.62), 0.89 L wide, stroke >= 0.30", () => {
    const svg = buildDiagramSvg(FX.spec, O).svg as string
    const h = heads(svg).get("head-control")!
    expect(h).toBeDefined()
    expect(h.units).toBe("userSpaceOnUse")
    const p = printed(svg, h)
    expect(p.len).toBeGreaterThanOrEqual(2.5)
    expect(Math.abs(p.len - 3.2)).toBeLessThanOrEqual(0.01)
    expect(Math.abs(p.wid - 0.89 * 3.2)).toBeLessThanOrEqual(0.01)
    expect(h.closed).toBe(false)
    expect(h.sw).toBeGreaterThanOrEqual(0.3)
  })

  for (const auto of [false, true]) {
    test(`every kind's head is 3.2 mm (accent too) and its tip lies L/18 past the path end, ${auto ? "production (auto)" : "sync"} path`, async () => {
      const seen = new Set<string>()
      for (const fig of ["kinds_a", "kinds_b"]) {
        const r = (auto ? await buildDiagramSvgAuto(structuredClone(FX[fig]), O as never, {}, () => {}) : buildDiagramSvg(structuredClone(FX[fig]), O)) as J
        for (const [id, h] of heads(r.svg)) {
          const kind = id.replace(/^head-/, "")
          seen.add(kind)
          expect(h.units, id).toBe("userSpaceOnUse")
          expect(Math.abs(printed(r.svg, h).len - 3.2), id).toBeLessThanOrEqual(0.01)
          expect(h.closed, id).toBe(!OPEN.has(kind))
          // the outermost point of the head lies L/18 = 0.18 mm past the path end: inside the node's 0.225 mm half stroke
          expect(Math.abs(reach(h) - 3.2 / 18), id).toBeLessThanOrEqual(0.02)
        }
      }
      expect([...seen].sort()).toEqual([...KINDS].sort())
    })
  }

  test("markers carry no data-mark; one link path per edge; geometry lint 0 defects (arrowTangent unchanged), sync and auto", async () => {
    for (const fig of ["spec", "kinds_a", "kinds_b"]) {
      for (const svg of [buildDiagramSvg(structuredClone(FX[fig]), O).svg as string, ((await buildDiagramSvgAuto(structuredClone(FX[fig]), O as never, {}, () => {})) as J).svg as string]) {
        for (const m of svg.match(/<marker\b[\s\S]*?<\/marker>/g) ?? []) expect(m, fig).not.toContain("data-mark")
        expect((svg.match(/data-mark="link"/g) ?? []).length, fig).toBe(FX[fig].edges.length)
        expect(lintDiagramGeometry(svg).defects, fig).toEqual([])
      }
    }
  })
})
