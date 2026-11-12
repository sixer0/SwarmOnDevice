// Row 205 of docs/2026-11-09_swarm_1_2_3_patch (defect HB-1): OVERLAP_CLIP judges a flow document's right edge only
// when the layout had the sheet width. Bridge stubbed (OverlapClipDeps): the measure answers with the HB-1 finding
// (`.st-unit` 3.89 mm past the right edge, page null) and the overlap script reports the layout viewport.
//   - layout at the sheet width (794/794): the measured overflow is a FAIL (a real overflow still fails);
//   - layout 15 px narrow (classic scrollbar, 794/779): the 3.89 mm overflow is explained by the missing width ->
//     UNKNOWN FLOW_LAYOUT_UNMEASURABLE, never PASS, never FAIL;
//   - same narrow layout with a 50 mm overflow: still FAIL (FAIL outranks UNKNOWN), the 3.89 mm one dropped;
//   - an older script answer without viewport fields: unchanged behaviour (no judgement);
//   - paged documents are not judged by the viewport (page limits are the page boxes);
//   - flow findings say why page / address are null (limit L-1).
import { describe, expect, test } from "bun:test"
import {
  ADDRESS_NULL_NOTE,
  FLOW_PAGE_NULL_NOTE,
  flowWidthShortfallPx,
  parseOverlapResult,
  runOverlapClip,
  type OverlapClipDeps,
} from "../../src/mcp-host/verify/overlap-clip.ts"

const A4 = { pageWidthMm: 210, pageHeightMm: 297 }
const HTML = `<!doctype html><html><head><style>@page{size:A4;margin:20mm}</style></head><body><div class="st-unit"><p>isi dokumen</p></div></body></html>`

function overflowEl(mm: number, label = "st-unit", address?: string) {
  return { kind: "overflow", axis: "right", overflow: true, overflowMm: mm, label, tag: "div", xMm: 0, yMm: 0, widthMm: 210, heightMm: 10, ...(address ? { address } : {}) }
}

function deps(over: number[], viewport: { viewportPx?: number; layoutWidthPx?: number } | null, paged = false): OverlapClipDeps {
  return {
    measure: async () =>
      ({
        pageCount: 1,
        paged,
        pageCountSource: paged ? "elements" : "print",
        truncated: false,
        elements: [
          paged
            ? { kind: "page", page: 1, xMm: 0, yMm: 0, widthMm: 210, heightMm: 297, colors: [] }
            : { kind: "document", xMm: 0, yMm: 0, widthMm: 210, heightMm: 300, colors: [], overflow: over.length > 0 },
          { kind: "text", xMm: 20, yMm: 20, widthMm: 120, heightMm: 5, label: "p" },
          ...over.map((mm, i) => overflowEl(mm, i === 0 ? "st-unit" : "div", i === 0 ? undefined : "9.9")),
        ],
        blockedRequests: 0,
        viewportWidthPx: 794,
        media: "screen",
      }) as never,
    checkPage: async () => ({
      paged,
      pageCount: paged ? 1 : 0,
      truncated: false,
      marginsUnreadable: false,
      contentHeightMm: 257,
      boxes: 3,
      scanned: 5,
      findingsTotal: 0,
      findings: [],
      ...(viewport ?? {}),
    }),
  }
}

describe("row 205: OVERLAP_CLIP and the flow layout viewport (HB-1)", () => {
  test("layout at the sheet width: a measured right overflow FAILs, page null with the L-1 note", async () => {
    const r = await runOverlapClip({ format: "PDF", html: HTML, ...A4 }, deps([3.89], { viewportPx: 794, layoutWidthPx: 794 }))
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings).toHaveLength(1)
    const f = r.check.findings[0]
    expect([f.code, f.label, f.amount, f.page, f.address]).toEqual(["OVERFLOW_RIGHT", "st-unit", 3.89, null, null])
    expect(f.detail).toContain(FLOW_PAGE_NULL_NOTE)
    expect(f.detail).toContain(ADDRESS_NULL_NOTE)
  })

  test("HB-1: layout 15 px narrow (classic scrollbar) and the 3.89 mm st-unit overflow -> UNKNOWN FLOW_LAYOUT_UNMEASURABLE", async () => {
    const r = await runOverlapClip({ format: "PDF", html: HTML, ...A4 }, deps([3.89], { viewportPx: 794, layoutWidthPx: 779 }))
    expect(r.check.status).toBe("UNKNOWN")
    expect(r.check.reason).toBe("FLOW_LAYOUT_UNMEASURABLE")
    expect(r.check.findings).toEqual([])
  })

  test("narrow layout with a clean document is UNKNOWN, never PASS", async () => {
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 }, deps([], { viewportPx: 794, layoutWidthPx: 779 }))
    expect(r.check.status).toBe("UNKNOWN")
    expect(r.check.reason).toBe("FLOW_LAYOUT_UNMEASURABLE")
  })

  test("a viewport that is not the sheet is unmeasurable too", async () => {
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 }, deps([], { viewportPx: 700, layoutWidthPx: 700 }))
    expect(r.check.status).toBe("UNKNOWN")
    expect(r.check.reason).toBe("FLOW_LAYOUT_UNMEASURABLE")
  })

  test("narrow layout with a real 50 mm overflow still FAILs; the 3.89 mm one explained by the scrollbar is dropped", async () => {
    const r = await runOverlapClip({ format: "PDF", html: HTML, ...A4 }, deps([3.89, 50], { viewportPx: 794, layoutWidthPx: 779 }))
    expect(r.check.status).toBe("FAIL")
    expect(r.check.findings.map((f) => [f.code, f.address, f.amount])).toEqual([["OVERFLOW_RIGHT", "9.9", 50]])
  })

  test("an older overlap script answer without viewport fields keeps the earlier behaviour", async () => {
    const r = await runOverlapClip({ format: "PDF", html: HTML, ...A4 }, deps([3.89], null))
    expect(r.check.status).toBe("FAIL")
    expect(r.overlap!.viewportPx).toBeNull()
  })

  test("paged documents are not judged by the viewport", () => {
    const o = parseOverlapResult({ paged: true, pageCount: 1, truncated: false, findings: [], viewportPx: 794, layoutWidthPx: 779 })!
    expect(flowWidthShortfallPx(o, 794)).toBe(0)
    const f = parseOverlapResult({ paged: false, pageCount: 0, truncated: false, findings: [], viewportPx: 794, layoutWidthPx: 779 })!
    expect(flowWidthShortfallPx(f, 794)).toBe(15)
    expect(flowWidthShortfallPx(parseOverlapResult({ paged: false, pageCount: 0, truncated: false, findings: [] })!, 794)).toBeNull()
  })
})
