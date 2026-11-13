// Swarm 1.2.8 row 58b (C134, gate M3 finding G3-08 ruling). Row 57c added the lint kind `labelCollision`
// (GEOM_LABEL_COLLISION: a label band over an arrowhead, a node outline or a container rule) to the preview and the
// auto-fit score, but not to verify/static-checks DIAGRAM_FAIL_KINDS, so a figure with a label over an arrowhead passed
// FIGURE_FIT (only a note). Ruling C134: labelCollision fails FIGURE_FIT (Visio minimum). Red at the pre-58b HEAD
// 30168cc94c (the finding is a note and the check PASSes), green after.
// Synthetic SVG in the engine's own form (57c defect-6 shape: one link with a data head, label band, node b), placed so
// the ONLY defect is the collision with the arrowhead: the band sits over the head, off the node.
import { describe, expect, test } from "bun:test"
import { checkFigureFit, DIAGRAM_FAIL_KINDS } from "../../src/mcp-host/verify/static-checks"
import { lintDiagramGeometry } from "../../vendor/src/lib/studio/engine/diagram/fit/lint"

type J = Record<string, any>

/** `bandX`: left edge of the 8 mm label band; the head of the link ends at x 60 (refX 4.2, body x 56.8..60). */
function figure(bandX: number): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 40">`,
    `<defs><marker id="head-data" markerUnits="userSpaceOnUse" markerWidth="5.2" markerHeight="4.85" refX="4.2" refY="2.42" orient="auto"><path d="M1,1 L4.2,2.42 L1,3.85 Z"/></marker></defs>`,
    `<path d="M 30 20 L 60 20" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>`,
    `<rect x="${bandX}" y="17" width="8" height="3.54" fill="#FCFCFB"/><text x="${bandX + 4}" y="19.4" font-family="IBM Plex Mono" font-size="2.081">KE</text>`,
    `<rect x="60" y="10" width="20" height="20" data-node="b" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>`,
    `</svg>`,
  ].join("\n")
}
const OVER_HEAD = figure(50) // band x 50..58 over the head body
const CLEAR = figure(40) // band x 40..48, clear of the head and the node

describe("G3-08: a label over an arrowhead fails FIGURE_FIT", () => {
  test("labelCollision is a FIGURE_FIT fail kind; edgeCross / edgeCollinear stay report-only", () => {
    expect(DIAGRAM_FAIL_KINDS.has("labelCollision")).toBe(true)
    expect(DIAGRAM_FAIL_KINDS.has("edgeCross")).toBe(false)
    expect(DIAGRAM_FAIL_KINDS.has("edgeCollinear")).toBe(false)
  })

  test("the synthetic figure's only defect is labelCollision with the arrowhead (subject check)", () => {
    const g = lintDiagramGeometry(OVER_HEAD) as J
    expect((g.defects as J[]).map((d) => d.kind)).toEqual(["labelCollision"])
    expect(String((g.defects as J[])[0].other)).toMatch(/kepala panah/)
  })

  for (const format of ["SVG", "PNG"] as const) {
    test(`${format}: label over the arrowhead -> FIGURE_FIT FAIL with a FIG_GEOMETRY labelCollision finding`, () => {
      const c = checkFigureFit({ format, svg: OVER_HEAD, figureKind: "diagram", figureLabel: "Gambar 1.1" } as never) as J
      expect(c.status).toBe("FAIL")
      expect((c.findings as J[]).filter((f) => f.code === "FIG_GEOMETRY" && /^labelCollision: KE \/ kepala panah/.test(f.detail)).length).toBe(1)
    })
    test(`${format}: the same label clear of the head -> FIGURE_FIT PASS, no finding (control)`, () => {
      expect((lintDiagramGeometry(CLEAR) as J).defects.length).toBe(0)
      const c = checkFigureFit({ format, svg: CLEAR, figureKind: "diagram", figureLabel: "Gambar 1.1" } as never) as J
      expect(c.status).toBe("PASS")
      expect(c.findings.length).toBe(0)
    })
  }

  test("symbolSheet: the same geometry read as a symbol sheet fails too (same lint, same fail set)", () => {
    const c = checkFigureFit({ format: "SVG", svg: OVER_HEAD, figureKind: "symbolSheet" } as never) as J
    expect(c.status).toBe("FAIL")
  })
})
