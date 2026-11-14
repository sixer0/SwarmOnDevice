// Swarm 1.2.8 row 68a (C166; M3 router + lint; user item 7: connectors at the MS Visio minimum). The three figures of the
// row 68 final live check that failed (test/04_live_final.md lines 12 and 18), as Studio stored them
// (fixtures/syn128/vis68a_live_specs.json), rendered through the preview path (compose mapBlock -> renderFigure, what
// studio_figure_preview runs) at 128 and 166 mm. One block per defect:
//  1. via: the leg from the via to the end node attaches to the side facing it and never crosses the end node
//     (C1 SATU ran into Langkah D's body, across its label, and ended inside it; DUA's last leg grazed Langkah B's top);
//  2. glue/via outside the figure: every connector stays inside the figure box (B4 MASUK and B1 MULAI ran to x = 0 and
//     y = 0, the caption band, and back down through their own start node);
//  3. a `route: straight` connector that crosses node bodies keeps its straight route and is reported (B4 SALIN through
//     Proses B and Dokumen C: GEOM_EDGE_NODE, FIGURE_FIT fails);
//  4. a connector ends on its target node outline, never on a zone frame (B4 CEK); an end on no node is reported
//     (edgeEndOffNode / GEOM_EDGE_END), as is a connector past the figure (edgeOutside / GEOM_EDGE_OUTSIDE);
//  5. the preview lists every defect the FIGURE_FIT gate fails on (same set).
// Red at the pre-row HEAD 5ddf892d8b (and at BASE e1f9673772); green after.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type J = Record<string, any>
type Pt = [number, number]
const FX = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "fixtures", "syn128", "vis68a_live_specs.json"), "utf8")) as J
// Namespace imports, so a run on an older engine fails on assertions, not on a missing export.
const compose = (await import("../../vendor/src/lib/studio/services/compose/index.ts")) as J
const fig = (await import("../../src/mcp-host/local-api/routes/figure-preview-figure.ts")) as J
const lintMod = (await import("../../vendor/src/lib/studio/engine/diagram/fit/lint")) as J
const fitMod = (await import("../../vendor/src/lib/studio/engine/diagram/build/autofit")) as J
const checks = (await import("../../src/mcp-host/verify/static-checks")) as J
const WIDTHS = [128, 166] as const

/** GEOM_* check id per lint kind (engine/diagram/build/autofit.ts CHECK). */
const CHECK: Record<string, string> = {
  textOverlap: "GEOM_TEXT_OVERLAP",
  textOutside: "GEOM_TEXT_OUTSIDE",
  lineThroughText: "GEOM_LINE_TEXT",
  textOverNode: "GEOM_TEXT_NODE",
  textExceedsNode: "GEOM_LABEL_OVERFLOW",
  edgeThroughNode: "GEOM_EDGE_NODE",
  edgeEntryCollision: "GEOM_ENTRY_COLLISION",
  stubSegment: "GEOM_STUB_SEGMENT",
  arrowTangent: "GEOM_ARROW_TANGENT",
  labelCollision: "GEOM_LABEL_COLLISION",
  frameOutside: "GEOM_FRAME_OUTSIDE",
  edgeOutside: "GEOM_EDGE_OUTSIDE",
  edgeEndOffNode: "GEOM_EDGE_END",
}

// ── the preview a stored block gets ───────────────────────────────────────────────────────────────────────────────
interface Prev {
  svg: string
  defects: string[]
}
const cache = new Map<string, Prev>()
async function preview(name: string, widthMm: number): Promise<Prev> {
  const key = `${name}@${widthMm}`
  const hit = cache.get(key)
  if (hit) return hit
  const f = FX[name]
  const b = { type: "diagram", caption: { text: f.caption }, source: { text: f.source }, spec: structuredClone(f.spec) }
  const params = { "diagram.widthMm": widthMm }
  const content = compose.mapBlock(b, "fig-68a", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
  const nb = { blockId: "fig-68a", pid: "fig-68a", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
  const r = await fig.renderFigure(nb, { params } as never, { inline: true, withSvg: true, lang: "ID" })
  const out = { svg: r.svg as string, defects: (r.defects as J[]).map((d) => d.checkId as string) }
  cache.set(key, out)
  return out
}

// ── geometry read from the SVG (independent of the lint) ──────────────────────────────────────────────────────────
const attr = (el: string, k: string): string | undefined => new RegExp(`\\s${k}="([^"]*)"`).exec(el)?.[1]
function viewBox(svg: string): { W: number; H: number } {
  const v = /<svg\b[^>]*viewBox="([^"]+)"/.exec(svg)![1].trim().split(/[\s,]+/).map(Number)
  return { W: v[2], H: v[3] }
}
/** Connector polylines by edge index (`data-index`), with half their stroke width. */
function links(svg: string): Map<number, { pts: Pt[]; half: number }> {
  const out = new Map<number, { pts: Pt[]; half: number }>()
  for (const m of svg.matchAll(/<path d="([^"]+)"([^>]*data-mark="link"[^>]*)\/>/g)) {
    const i = Number(attr(m[2], "data-index"))
    if (out.has(i)) continue // the first path of an edge is its line (heads drawn as separate paths come after)
    const pts = m[1]
      .replace(/^M\s*/, "")
      .split(/\s*L\s*/)
      .map((p) => p.trim().split(/\s+/).map(Number) as Pt)
    out.set(i, { pts, half: Number(attr(m[2], "stroke-width") ?? 0) / 2 })
  }
  return out
}
function nodeEl(svg: string, id: string): string {
  const m = new RegExp(`<(rect|polygon|path|circle)\\b[^>]*data-node="${id}"[^>]*>`).exec(svg)
  if (!m) throw new Error(`node ${id} not drawn`)
  return m[0]
}
/** Box [x0, y0, x1, y1] of a rect / circle / polygon node. */
function nodeBox(svg: string, id: string): [number, number, number, number] {
  const el = nodeEl(svg, id)
  if (el.startsWith("<rect")) {
    const x = Number(attr(el, "x")), y = Number(attr(el, "y"))
    return [x, y, x + Number(attr(el, "width")), y + Number(attr(el, "height"))]
  }
  if (el.startsWith("<circle")) {
    const cx = Number(attr(el, "cx")), cy = Number(attr(el, "cy")), r = Number(attr(el, " r") ?? attr(el, "r"))
    return [cx - r, cy - r, cx + r, cy + r]
  }
  const v = attr(el, "points")!.trim().split(/[\s,]+/).map(Number)
  const xs = v.filter((_, k) => k % 2 === 0), ys = v.filter((_, k) => k % 2 === 1)
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]
}
/** Samples of the polyline more than `skip` mm from both of its ends. */
function inner(pts: Pt[], skip: number): Pt[] {
  const s: Pt[] = []
  for (let k = 0; k + 1 < pts.length; k++) {
    for (let q = 0; q <= 40; q++) {
      const t = q / 40
      const p: Pt = [pts[k][0] + (pts[k + 1][0] - pts[k][0]) * t, pts[k][1] + (pts[k + 1][1] - pts[k][1]) * t]
      const e0 = pts[0], e1 = pts[pts.length - 1]
      if (Math.hypot(p[0] - e0[0], p[1] - e0[1]) > skip && Math.hypot(p[0] - e1[0], p[1] - e1[1]) > skip) s.push(p)
    }
  }
  return s
}
const deepIn = (p: Pt, b: [number, number, number, number], m = 0.3) => p[0] > b[0] + m && p[0] < b[2] - m && p[1] > b[1] + m && p[1] < b[3] - m
/** Last visible piece of a polyline as a vector (end minus the previous distinct point). */
function lastPiece(pts: Pt[]): Pt {
  const e = pts[pts.length - 1]
  for (let k = pts.length - 2; k >= 0; k--) if (Math.hypot(pts[k][0] - e[0], pts[k][1] - e[1]) > 1e-9) return [e[0] - pts[k][0], e[1] - pts[k][1]]
  return [0, 0]
}
const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b[0] - a[0], dy = b[1] - a[1]
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy)
}
const kinds = (svg: string): J[] => lintMod.lintDiagramGeometry(svg).defects as J[]
const gateFailKinds = (svg: string): string[] => {
  const c = checks.checkFigureFit({ format: "SVG", svg, figureKind: "diagram", figureLabel: "Gambar 1.1" })
  return [...new Set((c.findings as J[]).filter((f) => f.code === "FIG_GEOMETRY").map((f) => String(f.detail ?? "").split(":")[0]).filter((k) => checks.DIAGRAM_FAIL_KINDS.has(k)))].sort() as string[]
}

// ── 1. via legs ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("68a-1 via: the leg into the end node attaches to a side facing the via and never crosses the node", () => {
  for (const w of WIDTHS) {
    test(`C1 @${w}: SATU (via, to_side right) stays outside Langkah D and enters its right side from the right`, async () => {
      const p = await preview("C1_via", w)
      const satu = links(p.svg).get(0)!.pts
      const d = nodeBox(p.svg, "d")
      expect(inner(satu, 1.5).filter((q) => deepIn(q, d)).length).toBe(0)
      const v = lastPiece(satu)
      expect([Math.abs(v[1]) < 1e-6, v[0] < 0]).toEqual([true, true]) // horizontal, moving left into the right side
      expect(Math.abs(satu[satu.length - 1][0] - d[2])).toBeLessThan(1.0)
    })
    test(`C1 @${w}: DUA (straight via, to_side top) meets Langkah B's top steeply; 0 preview defects`, async () => {
      const p = await preview("C1_via", w)
      const dua = links(p.svg).get(1)!.pts
      const v = lastPiece(dua)
      const deg = (Math.atan2(Math.abs(v[1]), Math.abs(v[0])) * 180) / Math.PI
      expect(deg).toBeGreaterThanOrEqual(40)
      expect(p.defects).toEqual([])
    })
  }
})

// ── 2. inside the figure ──────────────────────────────────────────────────────────────────────────────────────────
describe("68a-2 a via on the sheet border or a glued side never sends a connector out of the figure", () => {
  for (const name of ["B4_carry_flow", "B1_carry_pools_phases"]) {
    for (const w of WIDTHS) {
      test(`${name} @${w}: every connector stroke inside the figure box; MASUK/MULAI not through their start node`, async () => {
        const p = await preview(name, w)
        const { W, H } = viewBox(p.svg)
        const out: string[] = []
        for (const [i, l] of links(p.svg)) {
          for (const q of l.pts) if (q[0] - l.half < 0 || q[0] + l.half > W || q[1] - l.half < 0 || q[1] + l.half > H) out.push(`${i}@${q.join(",")}`)
        }
        expect(out).toEqual([])
        const first = links(p.svg).get(0)!.pts
        expect(inner(first, 1.5).filter((q) => deepIn(q, nodeBox(p.svg, "a"))).length).toBe(0)
        expect(kinds(p.svg).filter((d) => d.kind === "edgeOutside")).toEqual([])
      })
    }
  }
})

// ── 3. straight through nodes: kept, reported ─────────────────────────────────────────────────────────────────────
describe("68a-3 a straight connector across node bodies keeps its route and is a defect (preview and FIGURE_FIT)", () => {
  for (const w of WIDTHS) {
    test(`B4 @${w}: SALIN is one straight segment; edgeThroughNode for Proses B and Dokumen C; GEOM_EDGE_NODE in the preview`, async () => {
      const p = await preview("B4_carry_flow", w)
      expect(links(p.svg).get(1)!.pts.length).toBe(2)
      const through = kinds(p.svg).filter((d) => d.kind === "edgeThroughNode" && d.text === "konektor 1").map((d) => d.other).sort()
      expect(through).toEqual(["b", "c"])
      expect(gateFailKinds(p.svg)).toContain("edgeThroughNode")
      expect(p.defects).toContain("GEOM_EDGE_NODE")
    })
  }
})

// ── 4. ends on the target outline ─────────────────────────────────────────────────────────────────────────────────
const svgOf = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">\n<rect x="0" y="0" width="100" height="80" fill="#FCFCFB"/>\n${body}\n</svg>`
const link = (d: string) => `<path d="${d}" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`
const box = (id: string, x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" data-node="${id}" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`
const zone = `<rect x="10" y="40" width="60" height="30" fill="none" stroke="#5A6670" stroke-width="0.3" stroke-dasharray="3.2,1.6"/>`
const SYN: Record<string, { bad: string; clean: string; kind: string }> = {
  edgeEndOffNode: {
    bad: svgOf([box("a", 20, 5, 20, 10), zone, link("M 30 15 L 30 40"), box("b", 20, 50, 20, 10)].join("\n")),
    clean: svgOf([box("a", 20, 5, 20, 10), zone, link("M 30 15 L 30 50"), box("b", 20, 50, 20, 10)].join("\n")),
    kind: "edgeEndOffNode",
  },
  edgeOutside: {
    bad: svgOf([box("a", 20, 5, 20, 10), link("M 20 10 L 0 10 L 0 55 L 20 55"), box("b", 20, 50, 20, 10)].join("\n")),
    clean: svgOf([box("a", 20, 5, 20, 10), link("M 20 10 L 5 10 L 5 55 L 20 55"), box("b", 20, 50, 20, 10)].join("\n")),
    kind: "edgeOutside",
  },
  ownNode: {
    bad: svgOf([box("a", 20, 5, 20, 10), link("M 40 7 L 20 55"), box("b", 20, 50, 20, 10)].join("\n")),
    clean: svgOf([box("a", 20, 5, 20, 10), link("M 30 15 L 30 50"), box("b", 20, 50, 20, 10)].join("\n")),
    kind: "edgeThroughNode",
  },
}

describe("68a-4 connector ends: on the target outline, never on a frame; ends on nothing and strokes past the figure are defects", () => {
  for (const w of WIDTHS) {
    test(`B4 @${w}: CEK ends on Cek D's outline (not on the zone frame); no end on nothing in the three figures`, async () => {
      const p = await preview("B4_carry_flow", w)
      const cek = links(p.svg).get(2)!.pts
      const e = cek[cek.length - 1]
      const v = attr(nodeEl(p.svg, "d"), "points")!.trim().split(/[\s,]+/).map(Number)
      const poly: Pt[] = [0, 2, 4, 6].map((k) => [v[k], v[k + 1]])
      const dist = Math.min(...poly.map((a, k) => segDist(e, a, poly[(k + 1) % 4])))
      expect(dist).toBeLessThan(1.0)
      for (const name of ["C1_via", "B4_carry_flow", "B1_carry_pools_phases"]) {
        const q = await preview(name, w)
        expect([name, kinds(q.svg).filter((d) => d.kind === "edgeEndOffNode")]).toEqual([name, []])
      }
    })
  }
  for (const [name, c] of Object.entries(SYN)) {
    test(`synthetic ${name}: the lint reports ${c.kind}, FIGURE_FIT fails on it and the preview lists ${CHECK[c.kind]}; the clean twin passes`, () => {
      expect(kinds(c.bad).map((d) => d.kind)).toContain(c.kind)
      expect(gateFailKinds(c.bad)).toContain(c.kind)
      const first = { svg: c.bad, widthMm: 100, heightMm: 80, report: { checksRun: [], issues: [] } }
      const out = fitMod.autoFitDiagram(first, () => first) as J
      const geo = ((out.report.geometry ?? []) as J[]).map((g) => g.checkId)
      expect(geo).toContain(CHECK[c.kind])
      expect(kinds(c.clean)).toEqual([])
      expect(gateFailKinds(c.clean)).toEqual([])
    })
  }
})

// ── 5. preview = gate ─────────────────────────────────────────────────────────────────────────────────────────────
describe("68a-5 the preview lists every defect FIGURE_FIT fails on", () => {
  for (const name of ["C1_via", "B4_carry_flow", "B1_carry_pools_phases"]) {
    for (const w of WIDTHS) {
      test(`${name} @${w}`, async () => {
        const p = await preview(name, w)
        const missing = gateFailKinds(p.svg).filter((k) => !p.defects.includes(CHECK[k]))
        expect(missing).toEqual([])
      })
    }
  }
})
