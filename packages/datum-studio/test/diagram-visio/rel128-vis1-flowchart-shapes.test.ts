// Swarm 1.2.8 row 53 (AC-VIS1b = VIS-1b, F-VISIO 01f §1.1 G-1..G-5; register N8-230..N8-232, N8-372; AT-V1-predefined /
// -document / -offpage). Basic Flowchart shapes with their own outline: predefined process (box + two hair side bars),
// document (straight top and sides, bottom one sine period sampled into 16 straight pieces), off-page reference
// (pentagon, point down). Fixture: test/fixtures/syn128/vis1_flowchart_gallery.json (all 10 Basic Flowchart rows,
// ranked flow TB, synthetic labels). Not part of the 52b CHAR corpus (new shape tokens).
// Red at BASE e1f9673772: the three tokens are not in the contract, validateSpec refuses them (P1-nodes / P3-shapes)
// and the build throws. Namespace imports, so the red run fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import * as buildMod from "../../vendor/src/lib/studio/engine/diagram/build"
import * as elkMod from "../../vendor/src/lib/studio/engine/diagram/elk"
import * as specMod from "../../vendor/src/lib/studio/engine/diagram/core/spec"
import * as lintMod from "../../vendor/src/lib/studio/engine/diagram/fit/lint"
import * as chartMod from "../../vendor/src/lib/studio/engine/chart/core"

type J = Record<string, any>
type Pt = [number, number]
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis1_flowchart_gallery.json"), "utf8")) as J
const O = { release: false }
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const WIDTHS = [128, 166] as const
const NEW = ["predefined", "document", "offpage"] as const

function build(width: number): J {
  return (buildMod as J).buildDiagramSvg({ ...clone(FX.gallery), width_mm: width }, O)
}
async function buildAuto(width: number): Promise<J> {
  return (elkMod as J).buildDiagramSvgAuto({ ...clone(FX.gallery), width_mm: width }, O, {}, () => {})
}
const idOf = (shape: string): string => (FX.gallery.nodes as J[]).find((n) => (n.shape ?? "box") === shape)!.id
const attr = (el: string, k: string): string | undefined => new RegExp(`\\s${k}="([^"]*)"`).exec(el)?.[1]
/** The single element carrying data-node="<id>" (G-1: one outline element per node). */
function nodeEls(svg: string, id: string): string[] {
  return [...svg.matchAll(new RegExp(`<(rect|polygon|path|circle|line)\\b[^>]*data-node="${id}"[^>]*/>`, "g"))].map((m) => m[0])
}
/** Node box (x, y, w, h) from the layout = the routed sheet node; read back from the predefined rect or computed bboxes. */
function bbox(pts: Pt[]): [number, number, number, number] {
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)]
}
function pointsOf(el: string): Pt[] {
  const p = attr(el, "points")
  if (p) {
    const v = p.trim().split(/[\s,]+/).map(Number)
    const out: Pt[] = []
    for (let i = 0; i + 1 < v.length; i += 2) out.push([v[i], v[i + 1]])
    return out
  }
  const d = attr(el, "d")!
  return [...d.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])] as Pt)
}
/** Label text element of a node: middle-anchored caption whose content is the node label. */
function labelEl(svg: string, label: string): string {
  const m = new RegExp(`<text\\b[^>]*text-anchor="middle"[^>]*>${label.replace(/[.]/g, "\\.")}</text>`).exec(svg)
  if (!m) throw new Error(`label ${label} not found`)
  return m[0]
}
function inkBox(el: string): [number, number, number, number] {
  const text = />([^<]*)</.exec(el)![1]
  const b = (lintMod as J).textBlockBox(
    [{ x: Number(attr(el, "x")), y: Number(attr(el, "y")), s: text }],
    Number(attr(el, "font-size")),
    attr(el, "text-anchor") ?? "start",
    /mono/i.test(attr(el, "font-family") ?? "") ? "data" : "struct",
    Number(attr(el, "font-weight") ?? 400) >= 600,
    Number(attr(el, "letter-spacing") ?? 0) || 0,
  )
  return b
}

describe("VIS-1b contract and validation (N8-372)", () => {
  test("predefined, document, offpage pass validateSpec (no P1-nodes / P3-shapes FAIL)", () => {
    const s = (specMod as J).loadSpec(clone(FX.gallery))
    const fails = ((specMod as J).validateSpec(s) as J[]).filter((i) => i.status === "FAIL").map((i) => i.checkId)
    expect(fails).toEqual([])
  })

  test("the gallery holds all 10 Basic Flowchart rows of 01f §1.1", () => {
    const shapes = new Set((FX.gallery.nodes as J[]).map((n) => n.shape ?? "box"))
    expect([...shapes].sort()).toEqual(["box", "circle", "cylinder", "diamond", "document", "hexagon", "offpage", "parallelogram", "predefined", "stadium"])
  })
})

describe("VIS-1b geometry per 01f §1.1 (G-1 outline primitives, G-2 decorations)", () => {
  for (const W of WIDTHS) {
    test(`predefined @${W}: rect outline + two hair side bars at x + 1.2 and x + w - 1.2, bars without data-node/data-mark`, () => {
      const svg = build(W).svg as string
      const id = idOf("predefined")
      const els = nodeEls(svg, id)
      expect(els.length).toBe(1)
      expect(els[0].startsWith("<rect")).toBe(true)
      const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(attr(els[0], k)))
      const at = svg.indexOf(els[0]) + els[0].length
      const next2 = svg.slice(at).match(/^(<line\b[^>]*\/>)(<line\b[^>]*\/>)/)
      expect(next2).not.toBeNull()
      const lines = [next2![1], next2![2]]
      const xs = lines.map((l) => Number(attr(l, "x1")))
      expect(xs[0]).toBeCloseTo(x + 1.2, 1)
      expect(xs[1]).toBeCloseTo(x + w - 1.2, 1)
      for (const l of lines) {
        expect(Number(attr(l, "x2"))).toBe(Number(attr(l, "x1")))
        expect(Number(attr(l, "y1"))).toBeCloseTo(y, 1)
        expect(Number(attr(l, "y2"))).toBeCloseTo(y + h, 1)
        expect(attr(l, "stroke-width")).toBe("0.2")
        expect(l).not.toContain("data-node")
        expect(l).not.toContain("data-mark")
      }
    })

    test(`document @${W}: path of M/L/Z only, top and sides straight, bottom = 16 wave pieces in the band [y+h-2a, y+h], a = 0.08 h`, () => {
      const svg = build(W).svg as string
      const els = nodeEls(svg, idOf("document"))
      expect(els.length).toBe(1)
      expect(els[0].startsWith("<path")).toBe(true)
      const d = attr(els[0], "d")!
      expect(d.replace(/[\d.\s-]/g, "")).toBe(`M${"L".repeat(18)}Z`)
      const pts = pointsOf(els[0])
      expect(pts.length).toBe(19)
      const [x, y, w] = [pts[0][0], pts[0][1], pts[1][0] - pts[0][0]]
      const h = Math.max(...pts.map((p) => p[1])) - y
      // h from the crest: the lowest wave point is y + h (u = 0.75); a = 0.08 h
      const a = h * 0.08
      expect(pts[1][1]).toBe(y) // top straight
      expect(pts[2][0]).toBe(pts[1][0]) // right side straight
      const wave = pts.slice(2)
      expect(wave.length).toBe(17) // right end + 16 samples
      expect(wave[16][0]).toBeCloseTo(x, 2)
      expect(Math.abs(wave[0][1] - wave[16][1])).toBeLessThanOrEqual(0.011) // both ends on the mean line y + h - a
      const lo = Math.min(...wave.map((p) => p[1]))
      const hi = Math.max(...wave.map((p) => p[1]))
      expect(hi - lo).toBeCloseTo(2 * a, 1) // one full period: crest band 2a
      expect(wave[4][1]).toBeCloseTo(lo, 2) // right half bulges up (u = 0.25)
      expect(wave[12][1]).toBeCloseTo(hi, 2) // left half bulges down (u = 0.75)
      // sampled evenly across the width
      for (let i = 0; i < 16; i++) expect(wave[i][0] - wave[i + 1][0]).toBeCloseTo(w / 16, 1)
    })

    test(`offpage @${W}: pentagon (x,y) (x+w,y) (x+w,y+0.7h) (x+w/2,y+h) (x,y+0.7h), point down`, () => {
      const svg = build(W).svg as string
      const els = nodeEls(svg, idOf("offpage"))
      expect(els.length).toBe(1)
      expect(els[0].startsWith("<polygon")).toBe(true)
      const p = pointsOf(els[0])
      expect(p.length).toBe(5)
      const [x, y, w, h] = bbox(p)
      const exp: Pt[] = [[x, y], [x + w, y], [x + w, y + 0.7 * h], [x + w / 2, y + h], [x, y + 0.7 * h]]
      p.forEach((q, i) => {
        expect(q[0]).toBeCloseTo(exp[i][0], 1)
        expect(q[1]).toBeCloseTo(exp[i][1], 1)
      })
    })

    test(`labels inside @${W}: predefined between the bars, document above the wave band, offpage in the top 0.7 h`, () => {
      const svg = build(W).svg as string
      const lab = (shape: string) => (FX.gallery.nodes as J[]).find((n) => n.shape === shape)!.label as string
      // predefined
      const pre = nodeEls(svg, idOf("predefined"))[0]
      const [px, , pw] = ["x", "y", "width"].map((k) => Number(attr(pre, k)))
      const pb = inkBox(labelEl(svg, lab("predefined")))
      expect(pb[0]).toBeGreaterThan(px + 1.2)
      expect(pb[2]).toBeLessThan(px + pw - 1.2)
      // document
      const doc = pointsOf(nodeEls(svg, idOf("document"))[0])
      const [dx, dy, dw, dh] = bbox(doc)
      const db = inkBox(labelEl(svg, lab("document")))
      expect(db[3]).toBeLessThanOrEqual(dy + dh - 2 * 0.08 * dh + 1e-6)
      expect(db[1]).toBeGreaterThan(dy)
      expect((db[0] + db[2]) / 2).toBeCloseTo(dx + dw / 2, 1)
      // offpage
      const off = pointsOf(nodeEls(svg, idOf("offpage"))[0])
      const [ox, oy, ow, oh] = bbox(off)
      const ob = inkBox(labelEl(svg, lab("offpage")))
      expect(ob[3]).toBeLessThanOrEqual(oy + 0.7 * oh + 1e-6)
      expect(ob[1]).toBeGreaterThan(oy)
      expect(ob[0]).toBeGreaterThan(ox)
      expect(ob[2]).toBeLessThan(ox + ow)
    })

    test(`connection points @${W}: every connector end on a new shape lies on its outline (0.05 mm)`, () => {
      const svg = build(W).svg as string
      const links = [...svg.matchAll(/<path d="([^"]+)"[^>]*data-mark="link"[^>]*\/>/g)].map((m) => pointsOf(`<path d="${m[1]}"/>`))
      const outline = (shape: string): Pt[] => {
        const el = nodeEls(svg, idOf(shape))[0]
        if (el.startsWith("<rect")) {
          const [x, y, w, h] = ["x", "y", "width", "height"].map((k) => Number(attr(el, k)))
          return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
        }
        return pointsOf(el)
      }
      const segD = (p: Pt, a: Pt, b: Pt) => {
        const dx = b[0] - a[0]
        const dy = b[1] - a[1]
        const L = dx * dx + dy * dy
        const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0
        return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
      }
      let ends = 0
      for (const shape of NEW) {
        const ring = outline(shape)
        const [x, y, w, h] = bbox(ring)
        for (const pl of links) {
          for (const e of [pl[0], pl[pl.length - 1]]) {
            if (e[0] < x - 0.3 || e[0] > x + w + 0.3 || e[1] < y - 0.3 || e[1] > y + h + 0.3) continue
            const d = Math.min(...ring.map((a, i) => segD(e, a, ring[(i + 1) % ring.length])))
            expect(d, `${shape} end ${e}`).toBeLessThanOrEqual(0.05)
            ends++
          }
        }
      }
      expect(ends).toBeGreaterThanOrEqual(5) // predefined in+out, document in+out, offpage in+out
    })

    test(`0 geometry defects @${W}, sync and production (auto) path; no geometry REPORT`, async () => {
      for (const r of [build(W), await buildAuto(W)]) {
        const g = (lintMod as J).lintDiagramGeometry(r.svg)
        expect(g.defects).toEqual([])
        expect(((r.report.geometry ?? []) as J[]).map((i) => i.checkId)).toEqual([])
        expect(((r.report.issues ?? []) as J[]).filter((i) => i.status === "FAIL")).toEqual([])
      }
    })
  }

  test("hatched (accent) document and offpage clip the hatch with their own outline", () => {
    const s = clone(FX.gallery)
    for (const n of s.nodes as J[]) if (n.shape === "document" || n.shape === "offpage") n.class = { ...n.class, accent: true }
    // one accent per figure is the DATUM-26 rule: keep only the document accented, then only the offpage
    for (const shape of ["document", "offpage"]) {
      const t = clone(s)
      for (const n of t.nodes as J[]) if (n.shape !== shape && n.class) delete n.class.accent
      const svg = (buildMod as J).buildDiagramSvg(t, O).svg as string
      const clip = /<clipPath id="datum-hatch-clip-[^"]+">(<[^>]+>)<\/clipPath>/.exec(svg)
      expect(clip, shape).not.toBeNull()
      expect(clip![1].startsWith(shape === "document" ? "<path" : "<polygon")).toBe(true)
    }
  })
})

describe("VIS-1b in the chart flowchart (G-04)", () => {
  test("ISO_5807 REPORT does not list the three; each drawn with its own outline", () => {
    const spec = { $schema: "studio.chart/v1", kind: "G-04", title: "Uji.", source: "Sumber sintetis uji.", widthMm: 166, data: { shape: "steps", spec: { ...clone(FX.gallery), width_mm: 166 } } }
    const r = (chartMod as J).renderChart(spec) as J
    const shapesIssue = ((r.report.issues ?? []) as J[]).find((i) => /standardShapes/.test(i.checkId))
    expect(shapesIssue).toBeUndefined()
    const el = (id: string) => new RegExp(`<(path|rect|polygon)\\b[^>]*data-node="${id}"[^>]*/>`).exec(r.svg)![0]
    expect(el(idOf("document")).startsWith("<path")).toBe(true)
    expect(attr(el(idOf("document")), "d")!.replace(/[\d.\s-]/g, "")).toBe(`M${"L".repeat(18)}Z`)
    expect(attr(el(idOf("offpage")), "d")!.replace(/[\d.\s-]/g, "")).toBe("MLLLLZ")
    const pre = el(idOf("predefined"))
    const after = (r.svg as string).slice((r.svg as string).indexOf(pre) + pre.length)
    expect(/^\s*<line\b[^>]*stroke-width="0.2"\/>\s*<line\b[^>]*stroke-width="0.2"\/>/.test(after)).toBe(true)
  })
})
