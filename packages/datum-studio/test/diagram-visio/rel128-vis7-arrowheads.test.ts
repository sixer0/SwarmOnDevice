// Swarm 1.2.8 row 57 (AC-VIS7, VIS-7, D-V4, F-VISIO 01f §5.2, §7 (a), AT-V7-arrowheads; register N8-260, N8-261,
// N8-267, N8-379, N8-468, N8-475; C56, C101). Arrowheads at both ends with type (none, triangle, open, diamond, circle)
// and size (s, m, l = ARROW_SIZES_MM 2.5 / 3.2 / 4.0 mm head length): marker ids `arrow-end-<type>-<size>-<kind>` /
// `arrow-start-<type>-<size>-<kind>` (default edges keep `head-<kind>`), start markers are mirrored definitions (no
// `auto-start-reverse`), diamond and circle hollow, `arrowTangent` at both ends, a size without its head is
// P1-edge-style, explicit defaults render byte-identical, and the BPMN association draws with `arrow_end: "none"`.
// Fixture: test/fixtures/syn128/vis7_arrowheads.json (synthetic labels).
// Red at BASE e1f9673772: the schema refuses every `arrow_*` field and the engine draws `head-<kind>` at the end only.
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
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis7_arrowheads.json"), "utf8")) as J
const O = { release: false }
const SIZES: Record<string, number> = { s: 2.5, m: 3.2, l: 4.0 }
const TYPES = ["triangle", "open", "diamond", "circle"] as const
const PAPER = "#FCFCFB"
const INK900 = "#101418"
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

interface Mk {
  attrs: string
  body: string
}
function markers(svg: string): Map<string, Mk> {
  const out = new Map<string, Mk>()
  for (const m of svg.matchAll(/<marker\b([^>]*)>([\s\S]*?)<\/marker>/g)) {
    const id = /\bid="([^"]+)"/.exec(m[1])![1]
    expect(out.has(id), `marker ${id} defined once`).toBe(false)
    out.set(id, { attrs: m[1], body: m[2] })
  }
  return out
}
const links = (svg: string) => [...svg.matchAll(/<path d="[^"]+"([^>]*data-mark="link"[^>]*)\/>/g)].map((m) => m[1])
const attr = (s: string, k: string) => new RegExp(`\\b${k}="([^"]+)"`).exec(s)?.[1]
const ref = (s: string, k: "marker-start" | "marker-end") => /url\(#([^)]+)\)/.exec(attr(s, k) ?? "")?.[1]
/** x-extent, outermost x on each side and the drawn outline reach of one marker body. */
function geom(m: Mk) {
  const circ = /<circle\b([^>]*)\/>/.exec(m.body)
  const sw = Number(attr(m.body, "stroke-width") ?? 0)
  if (circ) {
    const cx = Number(attr(circ[1], "cx"))
    const r = Number(attr(circ[1], "r"))
    return { len: 2 * r, wid: 2 * r, lo: cx - r - sw / 2, hi: cx + r + sw / 2, closed: true, tipAtLo: false, sw }
  }
  const d = attr(m.body, "d")!
  const pts = [...d.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((p) => [Number(p[1]), Number(p[2])] as const)
  const xs = pts.map((p) => p[0])
  const ys = pts.map((p) => p[1])
  const L = Math.max(...xs) - Math.min(...xs)
  const W = Math.max(...ys) - Math.min(...ys)
  const closed = /Z\s*$/.test(d.trim())
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2
  // the vertex on the axis that is not the diamond's back vertex: the tip
  const axis = pts.filter((p) => Math.abs(p[1] - mid) < 0.02).map((p) => p[0])
  const isDiamond = axis.length === 2
  const half = isDiamond ? Math.atan(W / L) : Math.atan(W / 2 / L)
  const miter = sw ? sw / 2 / Math.sin(half) : 0
  const tipAtLo = !isDiamond && axis[0] === Math.min(...xs)
  return { len: L, wid: W, lo: Math.min(...xs) - miter, hi: Math.max(...xs) + miter, closed, tipAtLo, sw }
}

describe("VIS-7 arrowheads at both ends (N8-379)", () => {
  for (const size of ["s", "m", "l"]) {
    describe(`size ${size}`, () => {
      const spec = FX[`size_${size}`]
      const svg = buildDiagramSvg(clone(spec), O).svg as string
      const mk = markers(svg)
      const L = SIZES[size]

      // the data kind's own head (triangle, m) is the default end: it keeps `head-data` (01f §5.2)
      const endId = (t: string) => (t === "triangle" && size === "m" ? "head-data" : `arrow-end-${t}-${size}-data`)
      const mkOf = (at: string, t: string) => mk.get(at === "end" ? endId(t) : `arrow-start-${t}-${size}-data`)!

      test("each edge references arrow-start-/arrow-end-<type>-<size>-data (head-data for the default end); every id defined once", () => {
        const ls = links(svg)
        expect(ls.length).toBe(4)
        TYPES.forEach((t, i) => {
          expect(ref(ls[i], "marker-start")).toBe(`arrow-start-${t}-${size}-data`)
          expect(ref(ls[i], "marker-end")).toBe(endId(t))
        })
        expect([...mk.keys()].sort()).toEqual(TYPES.flatMap((t) => [endId(t), `arrow-start-${t}-${size}-data`]).sort())
        expect(svg).not.toContain("auto-start-reverse")
        for (const m of mk.values()) {
          expect(attr(m.attrs, "markerUnits")).toBe("userSpaceOnUse")
          expect(attr(m.attrs, "orient")).toBe("auto")
          expect(m.body).not.toContain("data-mark")
        }
      })

      test(`shapes per 01f §5.2 at L = ${L} mm: triangle filled, open stroked, diamond and circle hollow (paper fill)`, () => {
        for (const at of ["start", "end"]) {
          const tri = mkOf(at, "triangle")
          const opn = mkOf(at, "open")
          const dia = mkOf(at, "diamond")
          const cir = mkOf(at, "circle")
          expect([geom(tri).closed, attr(tri.body, "fill"), attr(tri.body, "stroke")]).toEqual([true, INK900, undefined])
          expect([geom(opn).closed, attr(opn.body, "fill"), attr(opn.body, "stroke")]).toEqual([false, "none", INK900])
          expect(geom(opn).sw).toBeGreaterThanOrEqual(0.3)
          expect([geom(dia).closed, attr(dia.body, "fill"), attr(dia.body, "stroke")]).toEqual([true, PAPER, INK900])
          expect([attr(cir.body, "fill"), attr(cir.body, "stroke")]).toEqual([PAPER, INK900])
          for (const m of [tri, opn, dia]) {
            expect(Math.abs(geom(m).len - L), `${at} length`).toBeLessThanOrEqual(0.01)
            expect(Math.abs(geom(m).wid - 0.89 * L), `${at} width`).toBeLessThanOrEqual(0.02)
          }
          expect(Math.abs(geom(cir).len - 0.89 * L), `${at} circle diameter`).toBeLessThanOrEqual(0.02)
          // head length L >= ARROW_HEAD_MIN_MM; the circle is drawn in the L x 0.89 L box (r = W / 2)
          for (const m of [tri, opn, dia]) expect(geom(m).len).toBeGreaterThanOrEqual(2.5)
        }
      })

      test("start markers are mirrored: the tip points at the source; the head reaches L/18 past each path end", () => {
        for (const t of TYPES) {
          const s = mkOf("start", t)
          const e = mkOf("end", t)
          const gs = geom(s)
          const ge = geom(e)
          if (t === "triangle" || t === "open") {
            expect(gs.tipAtLo, `${t} start tip on the low x side`).toBe(true)
            expect(ge.tipAtLo, `${t} end tip on the high x side`).toBe(false)
          }
          expect(Math.abs(ge.hi - Number(attr(e.attrs, "refX")) - L / 18), `${t} end reach`).toBeLessThanOrEqual(0.02)
          expect(Math.abs(Number(attr(s.attrs, "refX")) - gs.lo - L / 18), `${t} start reach`).toBeLessThanOrEqual(0.02)
        }
      })

      test("0 geometry defects, sync and production (auto) path (arrowTangent read at both ends)", async () => {
        expect(lintDiagramGeometry(svg).defects).toEqual([])
        const auto = (await buildDiagramSvgAuto(clone(spec), O as never, {}, () => {})) as J
        expect(lintDiagramGeometry(auto.svg).defects).toEqual([])
        expect(links(auto.svg).filter((l) => l.includes("marker-start")).length).toBe(4)
      })
    })
  }

  describe("ends", () => {
    const svg = buildDiagramSvg(clone(FX.ends), O).svg as string
    const ls = links(svg)

    test("start only; arrow_end none = no marker attribute; message flow = circle start + kind head; explicit default = head-data", () => {
      expect([ref(ls[0], "marker-start"), ref(ls[0], "marker-end")]).toEqual(["arrow-start-triangle-m-data", undefined])
      expect([ls[1].includes("marker-start"), ls[1].includes("marker-end")]).toEqual([false, false])
      expect([ref(ls[2], "marker-start"), ref(ls[2], "marker-end")]).toEqual(["arrow-start-circle-m-control", "head-control"])
      expect([ref(ls[3], "marker-start"), ref(ls[3], "marker-end")]).toEqual([undefined, "head-data"])
      // the sync edge draws no head, so no head-sync is defined
      expect([...markers(svg).keys()].sort()).toEqual(["arrow-start-circle-m-control", "arrow-start-triangle-m-data", "head-control", "head-data"])
    })

    test("explicit defaults (arrow_start none, arrow_end = kind head, size m) render byte-identical to the absent fields", () => {
      const plain = clone(FX.ends)
      for (const f of ["arrow_start", "arrow_end", "arrow_end_size"]) delete plain.edges[3][f]
      expect(buildDiagramSvg(plain, O).svg).toBe(svg)
      const twin = clone(plain)
      Object.assign(twin.edges[3], { arrow_start: "none", arrow_end: "triangle", arrow_end_size: "m" })
      expect(buildDiagramSvg(twin, O).svg).toBe(svg)
    })

    test("0 geometry defects, sync and auto", async () => {
      expect(lintDiagramGeometry(svg).defects).toEqual([])
      expect(lintDiagramGeometry(((await buildDiagramSvgAuto(clone(FX.ends), O as never, {}, () => {})) as J).svg).defects).toEqual([])
    })
  })

  test("a size without its head is P1-edge-style (start and end), naming the field (C56)", () => {
    const issues = (C.validateSpec(C.loadSpec(clone(FX.refused))) as J[]).filter((i) => i.status !== "PASS")
    expect(issues.map((i) => i.checkId)).toEqual(["P1-edge-style", "P1-edge-style"])
    expect(JSON.stringify(issues)).toContain("arrow_start_size")
    expect(JSON.stringify(issues)).toContain("arrow_end_size")
  })

  test("arrowTangent reads the first piece of a link with marker-start (01f §7 (a)); without it the start is not checked", () => {
    const mk = (start: boolean) =>
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><rect x="0" y="0" width="100" height="80" fill="${PAPER}"/>` +
      `<rect x="30" y="10" width="20" height="10" data-node="a" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>` +
      `<rect x="30" y="60" width="20" height="10" data-node="b" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>` +
      `<path d="M 35 10 L 60 10 L 60 40 L 40 40 L 40 60" fill="none" stroke="${INK900}" stroke-width="0.45"${start ? ' marker-start="url(#s)"' : ""} marker-end="url(#e)" data-mark="link"/></svg>`
    const tang = (svg: string) => lintDiagramGeometry(svg).defects.filter((d: J) => d.kind === "arrowTangent")
    expect(tang(mk(false))).toEqual([])
    const withStart = tang(mk(true))
    expect(withStart.length).toBe(1)
    expect(withStart[0].other).toBe("a")
  })

  test("BPMN process (row 54b figure, C101): the association draws with arrow_end none; the data association keeps its head", async () => {
    const spec = FX.bpmn_process
    for (const svg of [buildDiagramSvg(clone(spec), O).svg as string, ((await buildDiagramSvgAuto(clone(spec), O as never, {}, () => {})) as J).svg as string]) {
      const ls = links(svg)
      expect(ls.length).toBe(spec.edges.length)
      const assoc = spec.edges.findIndex((e: J) => e.arrow_end === "none")
      expect(spec.edges[assoc]).toMatchObject({ from: "a", kind: "sync" })
      ls.forEach((l, i) => expect(l.includes("marker-end"), `edge ${i}`).toBe(i !== assoc))
      expect(ref(ls[spec.edges.findIndex((e: J) => e.to === "d")], "marker-end")).toBe("head-sync")
      expect(svg).not.toContain("marker-start")
    }
  })
})
