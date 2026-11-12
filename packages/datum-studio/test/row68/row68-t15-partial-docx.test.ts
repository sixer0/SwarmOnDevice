// 1.2.6 row 68 (T-15, register N-036 / E-15, U3): one figure that fails during preparation no longer aborts DOCX
// assembly. The figure store keeps a FIGURE_PREPARE_FAILED marker for it, the DOCX holds the other figures plus a
// visible marked placeholder, and verification never calls that output green: the same-job HTML raises the
// existing FIGURE_PLACEHOLDER FAIL and the DOCX placeholder paragraph raises the existing PLACEHOLDER_IN_OUTPUT FAIL.
// Pure local: fixture doc_serah_handover (chart, diagram, symbolSheet), stub SVG and stub rasterizer, no browser.
import { describe, expect, test } from "bun:test"
import type { NormBlock } from "../../vendor/src/lib/studio/contract"
import { useStudioEnv } from "../ported/_env"

// Own call (not through a shared kit module): the env is restored after this file, and a cached kit would not set it
// again for the next file in the same process.
useStudioEnv()
const R = await import("../ported/renderers/_kit")
const { assembleDocxDetailed } = await import("../../vendor/src/lib/studio/engine/docx/assemble")
const { assembleHtml } = await import("../../vendor/src/lib/studio/engine/html/assemble")
const { prepareFigureStore } = await import("../../vendor/src/lib/studio/engine/docx/figures/store")
const { checkEmptySlots } = await import("../../src/mcp-host/verify/static-checks")
const { outputState } = await import("../../src/mcp-host/verify/verify-outputs")
const { buildFigures } = await import("../../vendor/src/lib/studio/services/render/figures")
const { InlineSpecReader, createDetachedJob } = await import("../../vendor/src/lib/studio/services/render/pure/job")

const FIG_TYPES = ["chart", "diagram", "symbolSheet"]
const svgOf = (id: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="166mm" height="60mm" viewBox="0 0 166 60"><rect x="1" y="1" width="164" height="58" fill="none" stroke="#000"/><text x="10" y="30">${id}</text></svg>`

async function setup() {
  const tpl = await R.fixtureTemplate("doc_serah_handover")
  const snap = R.snapshotOf(R.loadFixtureDoc("doc_serah_handover"))
  const figs = snap.blocks.filter((b) => FIG_TYPES.includes(b.type))
  expect(figs.length).toBe(3)
  const failing = figs[1]
  const svgFor = async (b: NormBlock) => {
    if (b.blockId === failing.blockId) throw new Error("stub: figure 2 of 3 cannot be built")
    return { svg: svgOf(b.blockId), widthMm: 166, heightMm: 60 }
  }
  const rasterize = async () => R.STUB_FIG.png
  return { tpl, snap, figs, failing, svgFor, rasterize }
}

describe("T-15: a failing figure gives a FIGURE_PREPARE_FAILED placeholder, never an aborted DOCX", () => {
  test("prepareFigureStore resolves: figures 1 and 3 are rasterised, figure 2 carries the FIGURE_PREPARE_FAILED marker", async () => {
    const { snap, figs, failing, svgFor, rasterize } = await setup()
    const logs: Array<{ level: string; code?: string; message: string }> = []
    const store = await prepareFigureStore(snap, { svgFor, rasterize, log: (e) => logs.push(e as never), types: FIG_TYPES })
    const keyOf = (b: NormBlock) => b.artifactLabel ?? snap.numbering[b.blockId] ?? b.blockId
    for (const b of [figs[0], figs[2]]) expect(store.get(keyOf(b))?.png?.length ?? 0).toBeGreaterThan(0)
    const marked = store.get(keyOf(failing)) as { png?: Uint8Array; svg?: string; failed?: { code: string; message: string } } | undefined
    expect(marked?.failed?.code).toBe("FIGURE_PREPARE_FAILED")
    expect(marked?.failed?.message).toContain("figure 2 of 3")
    expect(marked?.png).toBeUndefined()
    expect(marked?.svg).toBeUndefined()
    expect(logs.some((l) => l.level === "error" && l.code === "FIGURE_PREPARE_FAILED")).toBe(true)
  }, 60_000)

  test("DOCX assembly completes with figures 1 and 3 plus a visible marked placeholder; the verdict is UNVERIFIED", async () => {
    const { tpl, snap, figs, failing, svgFor, rasterize } = await setup()
    const { ctx } = R.makeCtx(snap, tpl, { figures: { get: () => undefined } })
    const { bytes } = await assembleDocxDetailed(ctx, { svgFor, rasterize, figureTypes: FIG_TYPES })
    const parts = R.unzip(bytes)
    const doc = new TextDecoder().decode(parts["word/document.xml"])
    // Pictures of figures 1 and 3 are in the DOCX; figure 2 has none (decorative drawings are not counted).
    const label = snap.numbering[failing.blockId] ?? failing.artifactLabel ?? failing.blockId
    const pictureNames = [...doc.matchAll(/<wp:docPr id="\d+" name="([^"]*)"/g)].map((m) => m[1])
    const pictured = (b: NormBlock) => pictureNames.filter((n) => n.startsWith(`${snap.numbering[b.blockId] ?? b.artifactLabel} `)).length
    expect(pictured(figs[0])).toBe(1)
    expect(pictured(figs[2])).toBe(1)
    expect(pictured(failing)).toBe(0)
    expect(Object.keys(parts).filter((p) => p.startsWith("word/media/")).length).toBeGreaterThan(0)
    // The placeholder paragraph is visible (dashed signal border) and names the figure and the marker.
    const paras = [...doc.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map((m) => m[0])
    const ph = paras.filter((p) => p.includes("FIGURE_PREPARE_FAILED"))
    expect(ph.length).toBe(1)
    expect(ph[0]).toMatch(/<w:pBdr>[\s\S]*w:val="dashed"[\s\S]*w:color="B45309"/)
    const phText = [...ph[0].matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")
    expect(phText).toContain(label)
    // Verification of the DOCX output: the existing placeholder scan fails it, so it is never verified.
    const docxCheck = checkEmptySlots({ format: "DOCX", completeness: "COMPLETE", completenessReport: null, docx: bytes })
    expect(docxCheck.status).toBe("FAIL")
    expect(docxCheck.findings.some((f) => f.code === "PLACEHOLDER_IN_OUTPUT" && String(f.label ?? "").includes("FIGURE_PREPARE_FAILED"))).toBe(true)
    expect(outputState([docxCheck])).toBe("unverified")
  }, 60_000)

  test("the same-job HTML shows the figure as a placeholder and verification raises FIGURE_PLACEHOLDER (E-15) naming it", async () => {
    const { tpl, snap, failing, svgFor, rasterize } = await setup()
    const store = await prepareFigureStore(snap, { svgFor, rasterize, log: () => {}, types: FIG_TYPES })
    const { ctx } = R.makeCtx(snap, tpl, { figures: store })
    const html = await assembleHtml(ctx, { preview: false })
    const htmlCheck = checkEmptySlots({ format: "HTML", completeness: "COMPLETE", completenessReport: null, html })
    expect(htmlCheck.status).toBe("FAIL")
    const label = snap.numbering[failing.blockId] ?? failing.artifactLabel ?? failing.blockId
    const fp = htmlCheck.findings.filter((f) => f.code === "FIGURE_PLACEHOLDER")
    expect(fp.length).toBe(1)
    expect(String(fp[0].label)).toBe(label)
    expect(outputState([htmlCheck])).toBe("unverified")
  }, 60_000)

  test("render service: a figure whose SVG fails is a job error (PARTIAL) and a FIGURE_PREPARE_FAILED marker, not a skipped key", async () => {
    const job = createDetachedJob(["DOCX"])
    const blocks = [{ blockId: "b1", type: "chart", content: { spec: { artifactId: "art-1" } }, address: "6.1.1", unitKey: "6" }] as unknown as NormBlock[]
    const snapshot = { doc: { meta: { issueDate: "2026-11-12", tier: "NOTA" } }, numbering: { b1: "Gambar 6.1" }, blocks } as never
    const points = Array.from({ length: 5000 }, (_, i) => ({ label: `K${i}`, value: i + 1 }))
    const spec = { $schema: "studio.chart/v1", kind: "P-02", title: "t", source: "s", widthMm: 166, data: { shape: "categorical", points } }
    const r = await buildFigures({ snapshot, tpl: { params: {} } as never, tier: "NOTA", job: job as never, reader: new InlineSpecReader({ "art-1": { kind: "CHART", spec } }) })
    expect(job.errors.length).toBe(1)
    const e = r.store.get("Gambar 6.1") as { failed?: { code: string; causeCode?: string } } | undefined
    expect(e?.failed?.code).toBe("FIGURE_PREPARE_FAILED")
    expect(e?.failed?.causeCode).toBe("BY_CONSTRUCTION_FAILED")
  }, 60_000)
})
