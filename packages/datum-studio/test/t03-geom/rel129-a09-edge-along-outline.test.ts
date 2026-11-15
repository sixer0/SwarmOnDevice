// Swarm 1.2.9 row 31 (AC-A09, B9-A09; register N9-020..N9-025, test N9-108, fixture N9-152; C2 ruling 1, C10(d), C12 D-1).
// A connector that runs along the outline of another node reads as part of that node's border (1.2.8 B1: `tidak` from
// Cek C to Selesai F ran 11.89 mm down the right side of Data E). New lint kind `edgeAlongOutline`: a link segment (not
// the segment that ends on that node) collinear with an outline segment of another node (data-node rect, polygon, path,
// circle tangent; container and zone frames are not nodes) within link half-width + node half-stroke +
// EDGE_ALONG_TOL_MM (0.1 mm), over at least EDGE_ALONG_MIN_MM (1.0 mm). It is a T-03 kind: outside the auto-fit `score`,
// so no figure the engine builds changes bytes. Its code is GEOM_EDGE_ALONG (fails FIGURE_FIT) or EDGE_ALONG_NODE (a
// preview notice, not in the fail set), whichever the Q1 sweep of row 31 allowed; exactly one ships.
// Red at BASE d4282fcfd8 (kind, constants and codes absent; B1 / N9-152 not reported); green after row 31.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

type J = Record<string, any>
// Namespace imports, so a run on the BASE engine fails on assertions, not on a missing export.
const lint = (await import("../../vendor/src/lib/studio/engine/diagram/fit/lint")) as J
const fitMod = (await import("../../vendor/src/lib/studio/engine/diagram/build/autofit")) as J
const checks = (await import("../../src/mcp-host/verify/static-checks")) as J
const fig = (await import("../../src/mcp-host/local-api/routes/figure-preview-figure.ts")) as J
const compose = (await import("../../vendor/src/lib/studio/services/compose/index.ts")) as J

const KIND = "edgeAlongOutline"
const GEOM = "GEOM_EDGE_ALONG" // N9-021, fail path
const NOTICE = "EDGE_ALONG_NODE" // N9-022, warning path
const FIX = path.join(import.meta.dir, "..", "fixtures")
const A09 = JSON.parse(readFileSync(path.join(FIX, "syn129", "a09_edge_along_outline.json"), "utf8")) as J
const LIVE = JSON.parse(readFileSync(path.join(FIX, "syn128", "vis68a_live_specs.json"), "utf8")) as J

const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">\n<rect x="0" y="0" width="100" height="80" fill="#FCFCFB"/>\n${body}\n</svg>`
const link = (d: string) => `<path d="${d}" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`
const box = (id: string, x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" data-node="${id}" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`
/** A connector that runs 20 mm down the right side of box b (x 50, y 10..30) between a and c. */
const ALONG = [box("a", 10, 0, 10, 10), box("b", 40, 10, 10, 30), box("c", 70, 25, 10, 10), link("M 20 5 L 50 5 L 50 30 L 70 30")].join("\n")
const along = (svg: string) => (lint.lintDiagramGeometry(svg).defects as J[]).filter((d) => d.kind === KIND)

/** The code the engine reports for the kind (autofit CHECK, read through diagramGeometryIssues). */
function shippedCodes(): string[] {
  const g = lint.lintDiagramGeometry(svgOf(ALONG))
  return ((fitMod.diagramGeometryIssues(g) as J[]).map((i) => i.checkId as string)).filter((c) => c === GEOM || c === NOTICE)
}

// ── the preview a stored block gets (compose mapBlock -> renderFigure, what studio_figure_preview runs) ──────────────
interface Prev {
  svg: string
  defects: string[]
  notices: string[]
}
const cache = new Map<string, Prev>()
async function preview(f: J, key: string, widthMm: number): Promise<Prev> {
  const k = `${key}@${widthMm}`
  const hit = cache.get(k)
  if (hit) return hit
  const b = { type: "diagram", caption: { text: f.caption }, source: { text: f.source }, spec: structuredClone(f.spec) }
  const params = { "diagram.widthMm": widthMm }
  const content = compose.mapBlock(b, "fig-a09", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
  const nb = { blockId: "fig-a09", pid: "fig-a09", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
  const r = await fig.renderFigure(nb, { params } as never, { inline: true, withSvg: true, lang: "ID" })
  const out = { svg: r.svg as string, defects: ((r.defects ?? []) as J[]).map((d) => d.checkId as string), notices: ((r.notices ?? []) as J[]).map((d) => d.checkId as string) }
  cache.set(k, out)
  return out
}
function figureFit(svg: string): { status: string; failKinds: string[]; noteKinds: string[] } {
  const c = checks.checkFigureFit({ format: "SVG", svg, figureKind: "diagram", figureLabel: "Gambar 1.1" })
  const kinds = (c.findings as J[]).filter((f) => f.code === "FIG_GEOMETRY").map((f) => String(f.detail ?? "").split(":")[0])
  return { status: c.status, failKinds: [...new Set(kinds.filter((k) => checks.DIAGRAM_FAIL_KINDS.has(k)))].sort(), noteKinds: [...new Set(kinds.filter((k) => !checks.DIAGRAM_FAIL_KINDS.has(k)))].sort() }
}

describe("A09 register names, thresholds and the one shipped code", () => {
  test("kind N9-020 in DIAGRAM_DEFECT_KINDS and counts; thresholds N9-023 1.0 mm, N9-024 0.1 mm (C12 D-1)", () => {
    expect(lint.DIAGRAM_DEFECT_KINDS).toContain(KIND)
    expect(lint.lintDiagramGeometry(svgOf("")).counts[KIND]).toBe(0)
    expect(lint.EDGE_ALONG_MIN_MM).toBe(1.0)
    expect(lint.EDGE_ALONG_TOL_MM).toBe(0.1)
  })
  test("exactly one of GEOM_EDGE_ALONG / EDGE_ALONG_NODE is the engine code, with the WHAT/SUGGEST texts N9-025", () => {
    expect(shippedCodes().length).toBe(1)
    const g = lint.lintDiagramGeometry(svgOf(ALONG))
    const issue = (fitMod.diagramGeometryIssues(g) as J[]).find((i) => i.checkId === shippedCodes()[0])
    expect(issue?.status).toBe("REPORT")
    expect(issue?.detail).toContain("garis menyusuri tepi simpul lain")
    expect(issue?.suggest).toBe("geser simpul atau atur via agar garis tidak menempel di tepi simpul lain")
  })
  test("the shipped code and the FIGURE_FIT fail set agree (C10(d)): GEOM_* -> defect and failing, else notice and not failing", () => {
    const [code] = shippedCodes()
    const failing = checks.DIAGRAM_FAIL_KINDS.has(KIND)
    expect([code, failing]).toEqual(code === GEOM ? [GEOM, true] : [NOTICE, false])
    expect(fig.previewIssueClass(code, "REPORT")).toBe(code === GEOM ? "defect" : "notice")
    expect(fig.GEOM_T03_CODES).not.toContain(code) // the diagram guide list is not extended (budget 0 B)
  })
  test("a T-03 kind: counted, but outside the auto-fit score (no figure changes bytes)", () => {
    const g = lint.lintDiagramGeometry(svgOf(ALONG))
    expect(g.counts[KIND]).toBe(1)
    expect(g.score).toBe(0)
  })
})

describe("A09 hand-written SVGs", () => {
  test("a run of 20 mm on the right side of another box is reported once, naming that node and the length", () => {
    const d = along(svgOf(ALONG))
    expect(d.length).toBe(1)
    expect([d[0].text, d[0].other]).toEqual(["konektor 0", "b"])
    expect(d[0].amount).toBeCloseTo(20, 1)
  })
  test("a polygon side (data-object style) and a circle the connector runs tangent to are outlines too", () => {
    const poly = `<polygon points="40,10 47.6,10 50,12.4 50,40 40,40" data-node="p" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`
    expect(along(svgOf([box("a", 10, 0, 10, 10), poly, box("c", 70, 25, 10, 10), link("M 20 5 L 50 5 L 50 30 L 70 30")].join("\n"))).map((d) => d.other)).toEqual(["p"])
    const circle = `<circle cx="45" cy="40" r="4" data-node="o" fill="none" stroke="#2B3640" stroke-width="0.9" data-mark="node"/>`
    expect(along(svgOf([box("a", 10, 30, 10, 20), circle, box("c", 70, 30, 10, 20), link("M 20 44 L 70 44")].join("\n"))).map((d) => d.other)).toEqual(["o"])
  })
  test("under 1.0 mm along, or 2 mm beside the side, is not reported", () => {
    // overlap 0.9 mm: the run at x 50 meets the box b side only for y 39.1..40
    expect(along(svgOf([box("a", 10, 45, 10, 10), box("b", 40, 10, 10, 30), box("c", 70, 35, 10, 10), link("M 20 50 L 50 50 L 50 39.1 L 70 39.1")].join("\n")))).toEqual([])
    expect(along(svgOf([box("a", 10, 0, 10, 10), box("b", 40, 10, 10, 30), box("c", 70, 25, 10, 10), link("M 20 5 L 52 5 L 52 30 L 70 30")].join("\n")))).toEqual([])
  })
  test("the segment that ends on a node is not checked against that node (arrowTangent covers it); a container frame is no node", () => {
    expect(along(svgOf([box("a", 10, 10, 10, 10), box("b", 40, 30, 10, 20), link("M 20 15 L 40 15 L 40 40")].join("\n")))).toEqual([])
    const frame = `<rect x="45" y="5" width="30" height="60" fill="none" stroke="#2B3640" stroke-width="0.45"/>`
    expect(along(svgOf([box("a", 10, 10, 10, 10), frame, box("c", 80, 50, 10, 10), link("M 20 15 L 45 15 L 45 55 L 80 55")].join("\n")))).toEqual([])
  })
})

const CASES: Array<{ name: string; f: J; link: number; node: string; mm: number }> = [
  { name: "N9-152 syn129 a09 figure", f: A09.figure, link: 1, node: "e", mm: 11.89 },
  { name: "B1_carry_pools_phases", f: LIVE.B1_carry_pools_phases, link: 3, node: "e", mm: 11.89 },
]

describe("A09 on the preview path: B1 and N9-152 at 128 and 166 mm, clean twin silent", () => {
  for (const c of CASES) {
    for (const w of [128, 166]) {
      test(`${c.name} @${w}: TIDAK along Data E is reported, the preview lists the shipped code in its class, FIGURE_FIT agrees`, async () => {
        const p = await preview(c.f, c.name, w)
        const d = along(p.svg)
        expect(d.map((x) => [x.text, x.other])).toEqual([[`konektor ${c.link}`, c.node]])
        expect(d[0].amount).toBeCloseTo(c.mm, 1)
        const [code] = shippedCodes()
        const ff = figureFit(p.svg)
        if (code === GEOM) {
          expect(p.defects).toContain(GEOM)
          expect(ff.status).toBe("FAIL")
          expect(ff.failKinds).toContain(KIND)
        } else {
          expect(p.notices).toContain(NOTICE)
          expect(p.defects).not.toContain(NOTICE)
          expect(ff.failKinds).not.toContain(KIND)
          expect(ff.noteKinds).toContain(KIND)
        }
      })
    }
  }
  for (const w of [128, 166]) {
    test(`N9-152 clean twin @${w}: the connector off the outline is not reported`, async () => {
      const p = await preview(A09.clean_twin, "clean_twin", w)
      expect(along(p.svg)).toEqual([])
      expect([...p.defects, ...p.notices].filter((c) => c === GEOM || c === NOTICE)).toEqual([])
    })
  }
})
