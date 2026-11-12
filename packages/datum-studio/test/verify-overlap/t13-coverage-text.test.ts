// Swarm 1.2.6 row 30 (T-13, N-032, E-14): the OVERLAP_CLIP coverage reaches the verdict text as "diukur m/n halaman"
// (render-wrapper verificationLines, overlap-clip overlapCoverageText); pages left unmeasured keep MEASURE_TRUNCATED.
// Red at BASE e363918a69: no coverage on the check and no coverage text in the verdict lines.
// The page scripts are injected fakes (`OverlapClipDeps`) over a document of 60 fixed sheets: a piece truncates above
// 25 sheets, and with `poison` any piece of more than one sheet holding sheet 10 truncates too (its pages stay unmeasured).
import { describe, expect, it } from "bun:test"
import * as overlapClip from "../../src/mcp-host/verify/overlap-clip"
import { runOverlapClip } from "../../src/mcp-host/verify/overlap-clip"
import { verificationLines } from "../../src/mcp-host/verify/render-wrapper"
import type { OutputVerificationReport, VerifiedOutput, VerifyCheck } from "../../src/mcp-host/verify/types"
import type { MeasuredLayout } from "../../vendor/src/lib/studio/engine/browser/index"

// Namespace read, so the file loads at BASE (where the name does not exist) and fails on behaviour, not on import.
const overlapCoverageText = (overlapClip as Record<string, unknown>).overlapCoverageText as
  | ((c: { id: string; coverage?: unknown }) => string | null)
  | undefined

const A4 = { pageWidthMm: 210, pageHeightMm: 297 }
const SHEETS = 60
const sheet = (k: number) => `<section class="page" data-page><div class="body"><p data-address="s${k}/p1">x</p></div></section>`
const HTML = `<!doctype html><html><head></head><body>${Array.from({ length: SHEETS }, (_, k) => sheet(k + 1)).join("\n")}</body></html>`
const sheetsIn = (h: string) => (h.match(/<section class="page"/g) ?? []).length

function deps(poison: boolean) {
  const truncated = (h: string) => sheetsIn(h) > 25 || (poison && sheetsIn(h) > 1 && h.includes('data-address="s10/p1"'))
  const els = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "page", page: i + 1, xMm: 0, yMm: i * 297, widthMm: 210, heightMm: 297, colors: ["#101418"], label: "page", overflow: false }))
  return {
    measure: async (h: string) => ({ paged: true, pageCount: sheetsIn(h), pageCountSource: "elements", truncated: truncated(h), elements: els(sheetsIn(h)) }) as unknown as MeasuredLayout,
    checkPage: async (call: { html: string }) => {
      const n = sheetsIn(call.html)
      return { paged: true, pageCount: n, truncated: truncated(call.html), marginsUnreadable: false, contentHeightMm: 257, boxes: n, scanned: n, findingsTotal: 0, findings: [], viewportPx: 794, layoutWidthPx: 794 }
    },
  }
}

const out = (format: VerifiedOutput["format"], checks: VerifyCheck[], id: string): VerifiedOutput => ({
  outputId: id,
  format,
  role: "PRIMARY",
  figureLabel: null,
  sha256: "a".repeat(64),
  state: checks.every((c) => c.status === "PASS" || c.status === "NOT_APPLICABLE") ? "verified" : "unverified",
  checks,
  pages: [],
})
const report = (outputs: VerifiedOutput[]): OutputVerificationReport => ({
  $schema: "studio.output-verification/v1",
  checksVersion: 1,
  documentId: "doc30",
  revisionNo: 1,
  renderJobId: null,
  scope: "DOCUMENT",
  draft: false,
  layout: "paged",
  formatsAdded: [],
  layoutWitness: true,
  overall: outputs.every((o) => o.state === "verified") ? "verified" : "unverified",
  outputs,
}) as unknown as OutputVerificationReport
const lines = (v: VerifiedOutput[]) => verificationLines(report(v), { made: 0, reason: null })

describe("1.2.6 row 30 T-13: coverage in the verdict text", () => {
  it("a fully measured document says OVERLAP_CLIP PASS diukur 60/60 halaman under the verified output", async () => {
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 }, deps(false))
    expect(r.check.status).toBe("PASS")
    const text = lines([out("HTML", [r.check], "o-html")])
    const i = text.indexOf("  HTML o-html VERIFIED")
    expect(i).toBeGreaterThanOrEqual(0)
    expect(text[i + 1]).toBe("    OVERLAP_CLIP PASS diukur 60/60 halaman")
  })

  it("unmeasured pages keep MEASURE_TRUNCATED; the text says how many pages were measured", async () => {
    const r = await runOverlapClip({ format: "HTML", html: HTML, ...A4 }, deps(true))
    expect(r.check).toMatchObject({ status: "UNKNOWN", reason: "MEASURE_TRUNCATED" })
    const text = lines([out("HTML", [r.check], "o-html")])
    // The summary line keeps its shape (row 206 parses it) and its UNKNOWN reason.
    expect(text).toContain("  HTML o-html UNVERIFIED fail=- unknown=OVERLAP_CLIP:MEASURE_TRUNCATED")
    const cov = text.find((l) => l.startsWith("    OVERLAP_CLIP "))
    expect(cov).toMatch(/^ {4}OVERLAP_CLIP UNKNOWN:MEASURE_TRUNCATED diukur (\d+)\/60 halaman$/)
    const m = Number(/diukur (\d+)\//.exec(cov!)![1])
    expect(m).toBeLessThan(SHEETS)
    expect(m).toBeGreaterThanOrEqual(SHEETS - 20)
  })

  it("the PDF that took its OVERLAP_CLIP from the same job's HTML reports the coverage too", async () => {
    const r = await runOverlapClip({ format: "PDF", html: HTML, ...A4 }, deps(true))
    const text = lines([out("PDF", [r.check], "o-pdf")])
    expect(text.join("\n")).toMatch(/ {2}PDF o-pdf UNVERIFIED fail=- unknown=OVERLAP_CLIP:MEASURE_TRUNCATED\n {4}OVERLAP_CLIP UNKNOWN:MEASURE_TRUNCATED diukur \d+\/60 halaman/)
  })

  it("overlapCoverageText: the check text, null without well-formed coverage", () => {
    expect(typeof overlapCoverageText).toBe("function")
    const c = { id: "OVERLAP_CLIP" }
    expect(overlapCoverageText!({ ...c, coverage: { measuredPages: 211, totalPages: 217 } })).toBe("diukur 211/217 halaman")
    expect(overlapCoverageText!(c)).toBeNull()
    expect(overlapCoverageText!({ ...c, coverage: { measuredPages: 5, totalPages: 4 } })).toBeNull()
    expect(overlapCoverageText!({ ...c, coverage: { measuredPages: "5", totalPages: 9 } })).toBeNull()
    expect(overlapCoverageText!({ id: "LINT", coverage: { measuredPages: 1, totalPages: 1 } })).toBeNull()
  })

  it("an output whose OVERLAP_CLIP carries no coverage prints no coverage line", () => {
    const na: VerifyCheck = { id: "OVERLAP_CLIP", status: "NOT_APPLICABLE", basis: "self", reason: null, findings: [], truncated: 0, ms: 1 }
    const text = lines([out("DOCX", [na], "o-docx")])
    expect(text.some((l) => l.includes("diukur"))).toBe(false)
  })
})
