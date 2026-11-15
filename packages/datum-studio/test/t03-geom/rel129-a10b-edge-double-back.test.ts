// Swarm 1.2.9 row 33 (AC-A10b, B9-A10; register N9-031..N9-034, test N9-110, fixture N9-154; C2 ruling 1, C10(d), C12 D-1).
// A connector whose via is clamped at the figure edge doubles back on itself (1.2.8 B4 at 128 and 166 mm: the `masuk`
// connector `... L 2.38 16.67 L 2.38 2.38 L 2.38 4.76 L 2.38 40.48 ...` runs up to the clamp at y 2.38 and straight back
// down over its own stroke). No lint kind saw the spur. New lint kind `edgeDoublesBack`: two consecutive collinear
// segments of a link with opposite direction, after repeated vertices are removed, of any length (an SVG-side predicate;
// the router's `doublesBack` is not imported). A path that only repeats a vertex is not reported. A T-03 kind: outside
// `score`, so no figure the engine builds changes bytes. Its code is GEOM_EDGE_DOUBLE_BACK (fails FIGURE_FIT) or
// EDGE_DOUBLES_BACK (a preview notice, not in the fail set), whichever the Q1 sweep of row 33 allowed; exactly one ships.
// Red at BASE d4282fcfd8 (kind and codes absent; the B4 / N9-154 spur not reported); green after row 33.
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

const KIND = "edgeDoublesBack"
const GEOM = "GEOM_EDGE_DOUBLE_BACK" // N9-032, fail path
const NOTICE = "EDGE_DOUBLES_BACK" // N9-033, warning path
const FIX = path.join(import.meta.dir, "..", "fixtures")
const A10B = JSON.parse(readFileSync(path.join(FIX, "syn129", "a10b_edge_clamp_spur.json"), "utf8")) as J
const LIVE = JSON.parse(readFileSync(path.join(FIX, "syn128", "vis68a_live_specs.json"), "utf8")) as J

const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80">\n<rect x="0" y="0" width="100" height="80" fill="#FCFCFB"/>\n${body}\n</svg>`
const link = (d: string) => `<path d="${d}" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`
const doublesBack = (svg: string) => (lint.lintDiagramGeometry(svg).defects as J[]).filter((d) => d.kind === KIND)
const SPUR = "M 40 20 L 10 20 L 10 2 L 10 5 L 10 60 L 40 60"

/** The code the engine reports for the kind (autofit CHECK, read through diagramGeometryIssues). */
function shippedCodes(): string[] {
  const g = lint.lintDiagramGeometry(svgOf(link(SPUR)))
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
  const content = compose.mapBlock(b, "fig-a10b", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
  const nb = { blockId: "fig-a10b", pid: "fig-a10b", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
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

describe("A10b register names and the one shipped code", () => {
  test("kind N9-031 in DIAGRAM_DEFECT_KINDS and counts", () => {
    expect(lint.DIAGRAM_DEFECT_KINDS).toContain(KIND)
    expect(lint.lintDiagramGeometry(svgOf("")).counts[KIND]).toBe(0)
  })
  test("exactly one of GEOM_EDGE_DOUBLE_BACK / EDGE_DOUBLES_BACK is the engine code, with the WHAT/SUGGEST texts N9-034", () => {
    expect(shippedCodes().length).toBe(1)
    const g = lint.lintDiagramGeometry(svgOf(link(SPUR)))
    const issue = (fitMod.diagramGeometryIssues(g) as J[]).find((i) => i.checkId === shippedCodes()[0])
    expect(issue?.status).toBe("REPORT")
    expect(issue?.detail).toContain("garis berbalik arah di tepi gambar")
    expect(issue?.suggest).toBe("hapus via di tepi gambar atau pilih sisi lain")
  })
  test("the shipped code and the FIGURE_FIT fail set agree (C10(d)): GEOM_* -> defect and failing, else notice and not failing", () => {
    const [code] = shippedCodes()
    const failing = checks.DIAGRAM_FAIL_KINDS.has(KIND)
    expect([code, failing]).toEqual(code === GEOM ? [GEOM, true] : [NOTICE, false])
    expect(fig.previewIssueClass(code, "REPORT")).toBe(code === GEOM ? "defect" : "notice")
    expect(fig.GEOM_T03_CODES).not.toContain(code) // the diagram guide list is not extended (budget 0 B)
  })
  test("a T-03 kind: counted, but outside the auto-fit score (no figure changes bytes)", () => {
    const g = lint.lintDiagramGeometry(svgOf(link(SPUR)))
    expect(g.counts[KIND]).toBe(1)
    expect(g.score).toBe(0)
  })
})

describe("A10b hand-written SVGs", () => {
  test("a spur up to y 2 and straight back down is reported once, naming the connector, the turning point and the spur length", () => {
    const d = doublesBack(svgOf(link(SPUR)))
    expect(d.map((x) => [x.text, x.other, x.amount])).toEqual([["konektor 0", "x 10.00, y 2.00", 3]])
  })
  test("any length: a 0.05 mm spur is reported; a horizontal reversal too", () => {
    expect(doublesBack(svgOf(link("M 10 10 L 10 30 L 10 29.95 L 30 29.95"))).length).toBe(1)
    expect(doublesBack(svgOf(link("M 10 10 L 40 10 L 20 10 L 20 30"))).length).toBe(1)
  })
  test("repeated vertices are removed first: a repeated point without a reversal is not reported, a reversal behind repeated points is", () => {
    expect(doublesBack(svgOf(link("M 58.67 47.62 L 58.67 52.39 L 58.67 52.39 L 58.67 52.39 L 58.67 52.39 L 58.67 57.15")))).toEqual([])
    expect(doublesBack(svgOf(link("M 10 10 L 10 2 L 10 2 L 10 2 L 10 5")))).toHaveLength(1)
  })
  test("right angles, straight runs, a U-turn with a jog and a sampled curve are no reversal", () => {
    expect(doublesBack(svgOf(link("M 10 10 L 10 30 L 40 30 L 40 10")))).toEqual([])
    expect(doublesBack(svgOf(link("M 10 10 L 10 20 L 10 30 L 10 40")))).toEqual([])
    expect(doublesBack(svgOf(link("M 10 10 L 10 2 L 12 2 L 12 30")))).toEqual([])
    expect(doublesBack(svgOf(link("M 10 10 C 30 10 30 40 10 40")))).toEqual([])
  })
})

const CASES: Array<{ name: string; f: J; spur: Record<number, string> }> = [
  {
    name: "N9-154 syn129 a10b figure",
    f: A10B.figure,
    spur: { 128: "M 42.67 16.67 L 2.38 16.67 L 2.38 2.38 L 2.38 4.76 L 2.38 40.48 L 42.67 40.48", 166: "M 64.0 16.67 L 2.38 16.67 L 2.38 2.38 L 2.38 4.76 L 2.38 40.48 L 64.0 40.48" },
  },
  {
    name: "B4_carry_flow",
    f: LIVE.B4_carry_flow,
    spur: { 128: "M 42.67 16.67 L 2.38 16.67 L 2.38 2.38 L 2.38 4.76 L 2.38 40.48 L 42.67 40.48", 166: "M 64.0 16.67 L 2.38 16.67 L 2.38 2.38 L 2.38 4.76 L 2.38 40.48 L 64.0 40.48" },
  },
]

describe("A10b on the preview path: the MASUK spur of B4 and N9-154 is reported at 128 and 166 mm", () => {
  for (const c of CASES) {
    for (const w of [128, 166]) {
      test(`${c.name} @${w}: the clamped via doubles back at (2.38, 2.38); only that connector is reported; the preview lists the shipped code in its class; FIGURE_FIT agrees`, async () => {
        const p = await preview(c.f, c.name, w)
        expect(p.svg).toContain(`d="${c.spur[w]}"`)
        const d = doublesBack(p.svg)
        expect(d.map((x) => [x.text, x.other, x.amount])).toEqual([["konektor 0", "x 2.38, y 2.38", 2.38]])
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
  test("N9-154 `keluar` (connector 1) repeats the vertex (x, 52.39) four times but never reverses: not reported at either width", async () => {
    for (const w of [128, 166]) {
      const p = await preview(A10B.figure, CASES[0].name, w)
      const second = [...p.svg.matchAll(/<path d="([^"]+)"[^>]*data-mark="link"/g)][1][1]
      expect(second.match(/L [\d.]+ 52\.39/g)?.length).toBe(4)
      expect(doublesBack(p.svg).filter((x) => x.text === "konektor 1")).toEqual([])
    }
  })
})
