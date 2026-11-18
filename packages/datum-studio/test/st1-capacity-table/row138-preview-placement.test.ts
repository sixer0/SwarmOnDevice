// Swarm 1.3.3 row 138 (ST-1/ST-7, engine defects E1 and E7 of row 36): the preview must give the same verdict as the
// document render for the same block at the same width.
//
// Cause (row 36 section 6, proven here): after the build, the preview computed the `via` lattice with a plain
// `placeDiagram`, i.e. the FIRST placement. For graph and swimlane figures the build refuses that placement
// (DATUM-37-sheet) and draws the capacity layout instead (notice CAPACITY_ADAPT); the preview's lattice step then threw
// the bare first-placement refusal (BY_CONSTRUCTION_FAILED, no advice) for a figure the render prints.
//
// Every E1 case of row 36's table goes through both product paths (capacity-harness.ts: R = buildFigures, P =
// renderFigure). A figure that truly does not fit is refused by both with FIGURE_OVER_CAPACITY and the engine's advice.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { DIMENSIONS, createHarness, type Harness, type Width } from "./capacity-harness"

let h: Harness
beforeAll(async () => {
  h = await createHarness()
}, 60_000)
afterAll(() => h?.dispose())

const specOf = (key: string, n: number) => {
  const d = DIMENSIONS.find((x) => x.key === key)
  if (!d) throw new Error(`no dimension ${key}`)
  return d.spec(n)
}

/** Row 36 section 6, E1: the document render passes, the preview refused (before this row). */
const E1_CASES: ReadonlyArray<{ key: string; n: number; width: Width }> = [
  { key: "graph.cols", n: 5, width: "full" },
  { key: "graph.zones", n: 5, width: "full" },
  { key: "swimlane.perLane", n: 3, width: "text" },
  { key: "swimlane.perLane", n: 4, width: "full" },
  { key: "swimlane.oneLane", n: 3, width: "text" },
  { key: "swimlane.oneLane", n: 4, width: "text" },
  { key: "swimlane.oneLane", n: 4, width: "full" },
]

describe("row 138 (E1): preview and render agree on figures the capacity layout fits", () => {
  for (const c of E1_CASES) {
    test(`${c.key} n=${c.n} @ ${c.width}: render passes and the preview gives the same verdict`, async () => {
      const o = await h.probe(specOf(c.key, c.n), c.width)
      expect(o.result).toBe("pass")
      expect(o.notices ?? []).toContain("CAPACITY_ADAPT")
      // `preview` is present only when the preview path ends differently from the render path.
      expect(o.preview).toBeUndefined()
    }, 60_000)
  }
})

/** Node boxes the SVG draws (`data-node` rects), in mm. */
function drawnBoxes(svg: string): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  for (const m of svg.matchAll(/<rect\b[^>]*\bdata-node="([^"]+)"[^>]*>/g)) {
    const x = /\bx="(-?[\d.]+)"/.exec(m[0])
    const y = /\by="(-?[\d.]+)"/.exec(m[0])
    if (x && y && !(m[1] in out)) out[m[1]] = { x: Number(x[1]), y: Number(y[1]) }
  }
  return out
}

describe("row 138 (E1): the lattice the preview returns is the placement the build drew", () => {
  test("graph 5 columns @ full: every lattice cell sits where the SVG draws its node", async () => {
    const { renderFigure } = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
    const spec = specOf("graph.cols", 5)
    const r = await h.render(spec, "full")
    expect(r.outcome.result).toBe("pass")
    // the preview of the same block, with its SVG
    const block = { type: "diagram", width: "full", caption: { text: "Uji kapasitas." }, source: { text: "Sumber sintetis uji." }, spec }
    const pre = await previewOf(block, renderFigure)
    expect(pre.lattice).toBeDefined()
    const lat = pre.lattice as NonNullable<typeof pre.lattice>
    const boxes = drawnBoxes(pre.svg as string)
    const ids = Object.keys(lat.nodes)
    expect(ids.length).toBe(5)
    // The drawn sheet sits a constant vertical offset from the placement sheet (same on a plain figure: 4 columns).
    const plain = await previewOf({ ...block, spec: specOf("graph.cols", 4) }, renderFigure)
    const plainBoxes = drawnBoxes(plain.svg as string)
    const pl = plain.lattice as NonNullable<typeof plain.lattice>
    const dyPlain = pl.nodes.g0c0[1] - plainBoxes.g0c0.y / pl.row_mm
    for (const id of ids) {
      expect(boxes[id]).toBeDefined()
      expect(Math.abs(lat.nodes[id][0] - boxes[id].x / lat.col_mm)).toBeLessThan(0.02)
      expect(Math.abs(lat.nodes[id][1] - boxes[id].y / lat.row_mm - dyPlain)).toBeLessThan(0.02)
    }
    // the first placement put g0c4 beyond the 166 mm sheet; the drawn one keeps every node inside it
    expect(Math.max(...ids.map((id) => lat.nodes[id][2]))).toBeLessThanOrEqual(lat.cols + 1e-6)
  }, 60_000)
})

describe("row 138 (E7): a figure that truly does not fit is refused alike, with advice", () => {
  // Graph 5 columns / 5 containers at 128 mm are refused by width (no split skeleton); a rack of 24 devices and a
  // layered figure of 7 tiers by height, with the split skeleton of rows 51/140 (render outcomes measured 2026-11-17).
  for (const c of [
    { key: "graph.cols", n: 5, width: "text" as Width, split: false },
    { key: "graph.zones", n: 5, width: "text" as Width, split: false },
    { key: "rack.devices", n: 24, width: "text" as Width, split: true },
    { key: "layered.tiers", n: 7, width: "full" as Width, split: true },
  ]) {
    test(`${c.key} n=${c.n} @ ${c.width}: FIGURE_OVER_CAPACITY with saran on both paths`, async () => {
      const o = await h.probe(specOf(c.key, c.n), c.width)
      expect(o.result).toBe("refused")
      expect(o.code).toBe("FIGURE_OVER_CAPACITY")
      expect(o.message ?? "").toContain("saran")
      expect(o.preview).toBeUndefined()
      // the preview's own refusal carries the same advice and, where render gives one, the split skeleton
      const { renderFigure } = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
      const block = { type: "diagram", width: c.width, caption: { text: "Uji kapasitas." }, source: { text: "Sumber sintetis uji." }, spec: specOf(c.key, c.n) }
      const err = (await previewOf(block, renderFigure).then(
        () => null,
        (e: unknown) => e,
      )) as { code?: string; message?: string; details?: { split?: unknown } } | null
      expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
      expect(err?.message?.slice(0, 600)).toBe(o.message) // the harness keeps the first 600 characters
      expect(err?.details?.split !== undefined).toBe(c.split)
      expect(o.split).toBe(c.split)
    }, 60_000)
  }
})

// The harness keeps its compose context private; compose the block the same way through the preview module.
async function previewOf(block: Record<string, unknown>, renderFigure: (typeof import("../../src/mcp-host/local-api/routes/figure-preview-figure"))["renderFigure"]) {
  const K = await import("../ported/renderers/_kit")
  const S = await import("../ported/structure/_kit")
  const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
  const preview = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
  const slots = S.datumSlots()
  const doc = S.e1() as Record<string, any>
  doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf sintetis sebelum figur." }, { type: "diagram", caption: { text: "Jangkar." }, source: { text: "Sumber." }, spec: specOf("flow.chain", 2) }]
  const { template: _t, ...sub } = doc
  const snap = composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams(), assets: {} }).snapshot as any
  const near = snap.blocks.find((b: any) => b.type === "diagram")
  const inline = preview.composeInlineBlock(snap, block as never, { pid: near.pid ?? near.blockId, slotKey: near.slotKey, artifactLabel: near.artifactLabel, address: near.address })
  return renderFigure(inline, await K.canonicalTemplate(), { inline: true, withSvg: true, lang: "ID" })
}
