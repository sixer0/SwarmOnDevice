// Swarm 1.2.9 row 32 (AC-A10a, B9-A10; register N9-026..N9-030, test N9-109, fixture N9-153; C2 ruling 1, C10(d), C12 D-1).
// A connector that runs over or right at the edge of a pool or lane header text (1.2.8 B1 at 128 mm: the `mulai` via leg
// at x 48.0 runs down through the left end of `KOLAM X` [47.92, 12.23, 58.74, 14.60] and `LAJUR 2`) is not seen by
// `lineThroughText`, whose 7 x 3 sample grid is inset from the text box. New lint kind `edgeOverHeader`: container header
// texts only (bold tracked `table_header` signature, centre outside every node), the text box grown by HEADER_CLEAR_MM
// (0.3 mm) tested against every link stroke (centre line + half width). A header that `lineThroughText` already reports is
// not reported twice. `lineThroughText` itself is not widened (it is in the auto-fit `score` and ROUTE_KINDS). A T-03
// kind: outside `score`, so no figure the engine builds changes bytes. Its code is GEOM_EDGE_HEADER (fails FIGURE_FIT) or
// EDGE_OVER_HEADER (a preview notice, not in the fail set), whichever the Q1 sweep of row 32 allowed; exactly one ships.
// Red at BASE d4282fcfd8 (kind, constant and codes absent; B1 / N9-153 at 128 mm not reported); green after row 32.
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

const KIND = "edgeOverHeader"
const GEOM = "GEOM_EDGE_HEADER" // N9-027, fail path
const NOTICE = "EDGE_OVER_HEADER" // N9-028, warning path
const FIX = path.join(import.meta.dir, "..", "fixtures")
const A10A = JSON.parse(readFileSync(path.join(FIX, "syn129", "a10a_header_text.json"), "utf8")) as J
const LIVE = JSON.parse(readFileSync(path.join(FIX, "syn128", "vis68a_live_specs.json"), "utf8")) as J

const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">\n<rect x="0" y="0" width="100" height="80" fill="#FCFCFB"/>\n${body}\n</svg>`
const link = (d: string) => `<path d="${d}" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`
const box = (id: string, x: number, y: number, w: number, h: number) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" data-node="${id}" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`
/** The pool header the engine draws (role table_header: weight 600, tracked); box [47.92, 12.23, 58.74, 14.60]. */
const header = (s: string, weight = 600, track = 0.216) =>
  `<text x="53.33" y="14.31" font-family="IBM Plex Sans Condensed" font-size="2.399" font-weight="${weight}" fill="#6B7783" text-anchor="middle" letter-spacing="${track}">${s}</text>`
const overHeader = (svg: string) => (lint.lintDiagramGeometry(svg).defects as J[]).filter((d) => d.kind === KIND)

/** The code the engine reports for the kind (autofit CHECK, read through diagramGeometryIssues). */
function shippedCodes(): string[] {
  const g = lint.lintDiagramGeometry(svgOf([header("KOLAM X"), link("M 47.5 2 L 47.5 30")].join("\n")))
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
  const content = compose.mapBlock(b, "fig-a10a", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
  const nb = { blockId: "fig-a10a", pid: "fig-a10a", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
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

describe("A10a register names, threshold and the one shipped code", () => {
  test("kind N9-026 in DIAGRAM_DEFECT_KINDS and counts; HEADER_CLEAR_MM N9-029 0.3 mm (C12 D-1)", () => {
    expect(lint.DIAGRAM_DEFECT_KINDS).toContain(KIND)
    expect(lint.lintDiagramGeometry(svgOf("")).counts[KIND]).toBe(0)
    expect(lint.HEADER_CLEAR_MM).toBe(0.3)
  })
  test("exactly one of GEOM_EDGE_HEADER / EDGE_OVER_HEADER is the engine code, with the WHAT/SUGGEST texts N9-030", () => {
    expect(shippedCodes().length).toBe(1)
    const g = lint.lintDiagramGeometry(svgOf([header("KOLAM X"), link("M 47.5 2 L 47.5 30")].join("\n")))
    const issue = (fitMod.diagramGeometryIssues(g) as J[]).find((i) => i.checkId === shippedCodes()[0])
    expect(issue?.status).toBe("REPORT")
    expect(issue?.detail).toContain("garis melintasi teks judul kolam/lajur")
    expect(issue?.suggest).toBe("atur via agar garis lewat di luar pita judul kolam/lajur")
  })
  test("the shipped code and the FIGURE_FIT fail set agree (C10(d)): GEOM_* -> defect and failing, else notice and not failing", () => {
    const [code] = shippedCodes()
    const failing = checks.DIAGRAM_FAIL_KINDS.has(KIND)
    expect([code, failing]).toEqual(code === GEOM ? [GEOM, true] : [NOTICE, false])
    expect(fig.previewIssueClass(code, "REPORT")).toBe(code === GEOM ? "defect" : "notice")
    expect(fig.GEOM_T03_CODES).not.toContain(code) // the diagram guide list is not extended (budget 0 B)
  })
  test("a T-03 kind: counted, but outside the auto-fit score (no figure changes bytes)", () => {
    const g = lint.lintDiagramGeometry(svgOf([header("KOLAM X"), link("M 47.5 2 L 47.5 30")].join("\n")))
    expect(g.counts[KIND]).toBe(1)
    expect(g.counts.lineThroughText).toBe(0)
    expect(g.score).toBe(0)
  })
})

describe("A10a hand-written SVGs", () => {
  test("a stroke 0.42 mm left of the header box (inside the 0.3 mm clearance with its half width) is reported once, naming the header and the connector", () => {
    const d = overHeader(svgOf([header("KOLAM X"), link("M 47.5 2 L 47.5 30")].join("\n")))
    expect(d.map((x) => [x.text, x.other])).toEqual([["KOLAM X", "konektor 0"]])
  })
  test("a stroke 0.92 mm away is clear; a regular-weight or untracked text is no header", () => {
    expect(overHeader(svgOf([header("KOLAM X"), link("M 47.0 2 L 47.0 30")].join("\n")))).toEqual([])
    expect(overHeader(svgOf([header("Kolam X", 400), link("M 47.5 2 L 47.5 30")].join("\n")))).toEqual([])
    expect(overHeader(svgOf([header("KOLAM X", 600, 0), link("M 47.5 2 L 47.5 30")].join("\n")))).toEqual([])
  })
  test("a bold tracked tag inside a node is no container header; a header lineThroughText already reports is not reported twice", () => {
    expect(overHeader(svgOf([box("n", 45, 10, 18, 8), header("REQ 1"), link("M 47.5 2 L 47.5 9")].join("\n")))).toEqual([])
    // x 53.33 = the text centre: lineThroughText's middle sample column; x 53 would pass between its samples
    const through = lint.lintDiagramGeometry(svgOf([header("KOLAM X"), link("M 53.33 2 L 53.33 30")].join("\n")))
    expect(through.counts.lineThroughText).toBe(1)
    expect(through.counts[KIND]).toBe(0)
  })
})

const CASES: Array<{ name: string; f: J }> = [
  { name: "N9-153 syn129 a10a figure", f: A10A.figure },
  { name: "B1_carry_pools_phases", f: LIVE.B1_carry_pools_phases },
]

describe("A10a on the preview path: B1 and N9-153 reported at 128 mm, silent at 166 mm", () => {
  for (const c of CASES) {
    test(`${c.name} @128: the via leg at x 48.0 over KOLAM X and LAJUR 2 is reported, the preview lists the shipped code in its class, FIGURE_FIT agrees`, async () => {
      const p = await preview(c.f, c.name, 128)
      expect(p.svg).toContain('d="M 53.33 46.1 L 53.33 57.15 L 2.38 57.15 L 2.38 4.76 L 48.0 4.76 L 48.0 66.67"')
      const d = overHeader(p.svg)
      expect(d.map((x) => [x.text, x.other])).toEqual([
        ["KOLAM X", "konektor 0"],
        ["LAJUR 2", "konektor 0"],
      ])
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
    test(`${c.name} @166 (negative control): the leg at x 50.67 is clear of the headers from 53.26 and nothing is reported`, async () => {
      const p = await preview(c.f, c.name, 166)
      expect(p.svg).toContain("L 50.67 4.76 L 50.67 66.67")
      expect(overHeader(p.svg)).toEqual([])
      expect([...p.defects, ...p.notices].filter((x) => x === GEOM || x === NOTICE)).toEqual([])
    })
  }
})
