/**
 * Swarm 1.3.3 row 65 (ST-7) replay R4: the six p2 figures (research/replay/R4_p2_figures, read-only).
 *
 * The copies are the specs as finally stored (rev 34, render SUCCEEDED); the refused versions were not kept
 * (research/05_replay_inventory.md R4). So the exact replay of the six refusals is not verifiable. What is checked:
 *  1. the six stored figures: preview and the render's per-figure path (same build + render lint + structure lint at
 *     the document tier NOTA and at SERAH) agree: no defect at preview where the render has no FAIL;
 *  2. the two refusals quoted in R10 p2 LAPORAN.md gap 1 (Gambar 1.1 DATUM-26, Gambar 1.4 DATUM-35), rebuilt from the
 *     stored spec with exactly the quoted fault: refused at preview with the same code the render gave.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { mapBlock, glyphSet } from "@/lib/studio/services/compose"
import { buildDiagramSvgAuto } from "@/lib/studio/engine/diagram/elk"
import { figureGrid } from "@/lib/studio/engine/chart/core/guards"
import { lintStructureWith } from "@/lib/studio/engine/lint/structure"
import { lintRenderedWith, renderLintLimitsFromParams } from "@/lib/studio/engine/lint/render"
import { diagramApparatusOptions } from "@/lib/studio/services/render/figures"
import { renderFigure } from "../../src/mcp-host/local-api/routes/figure-preview-figure"
import { replayInputs } from "../replay-dir"

type J = Record<string, any>
// Row 146: read from SWARM_REPLAY_DIR/R4_p2_figures, never a fixed path; skipped when the variable is unset.
const REPLAY = replayInputs("row 65 replay R4", ["R4_p2_figures/1.json"] as const)
const R4 = REPLAY.paths[0].replace(/\/1\.json$/, "")
const params = { "diagram.widthMm": 128 }
const tpl = { params } as never
const docOf = (tier: string, chapters: unknown[] = []) => ({ $schema: "studio.doc/v1", template: { slug: "datum-laporan" }, meta: { tier, language: "ID", classification: "BIASA" }, chapters })
const snapOf = (tier: string, chapters: unknown[] = []) => ({ schema: "studio.norm/v1", doc: docOf(tier, chapters), blocks: [], units: [], numbering: {}, register: {} }) as never
const load = (n: number): J => JSON.parse(readFileSync(`${R4}/${n}.json`, "utf8"))
const compose = (b: J, n: number) => mapBlock(structuredClone(b) as never, `fig-${n}`, { glyphs: glyphSet(undefined), params, classification: "BIASA", artifactLabel: `Gambar 1.${n}` }) as J
const normBlock = (content: J, n: number) => ({ blockId: `fig-${n}`, pid: `fig-${n}`, address: `1.3.${n}`, artifactLabel: `Gambar 1.${n}`, ordinal: 0, unitKey: "1", type: "diagram", content, textPlain: "", contentSha256: "" })

async function preview(b: J, n: number, tier: string) {
  return renderFigure(normBlock(compose(b, n), n) as never, tpl, { inline: true, withSvg: false, lang: "ID", document: snapOf(tier) } as never)
}

/** The render's per-figure path (services/render/figures.ts buildFigures + lintAfterRender's structure and render modules). */
async function render(b: J, n: number, tier: string): Promise<{ refused?: string; fails: string[] }> {
  const content = compose(b, n)
  try {
    const r = await buildDiagramSvgAuto(content.spec, { release: false, grid: figureGrid(params), ...diagramApparatusOptions("ID") })
    const doc = [{ key: "1", title: "Bab", intro: [{ ...content, blockId: `fig-${n}` }] }]
    // Structure rows that point into this figure's block (rules about other parts of a one-figure document, such as
    // the logo or required sections, are not about the figure), plus the render module's SVG rows.
    const structure = lintStructureWith(snapOf(tier, doc), tpl, tier as never).filter((x) => (x.pointer ?? "").startsWith("/chapters/0/intro/0"))
    const rendered = lintRenderedWith({ svgs: [r], metrics: { pageCount: 0, elements: [] } }, renderLintLimitsFromParams(params))
    return { fails: [...new Set([...structure, ...rendered].filter((x) => x.status === "FAIL").map((x) => x.checkId))] }
  } catch (e) {
    return { refused: (e as { details?: { checkId?: string } }).details?.checkId ?? "?", fails: [] }
  }
}

const available = REPLAY.present

describe.skipIf(!available)("row 65 replay R4 (six p2 figures)", () => {
  for (const n of [1, 2, 3, 4, 5, 6]) {
    for (const tier of ["NOTA", "SERAH"]) {
      test(`Gambar 1.${n} as stored, tier ${tier}: preview defects (FAIL rows) equal the render's per-figure FAILs`, async () => {
        const b = load(n)
        const want = await render(b, n, tier)
        expect(want.refused).toBeUndefined()
        const f = await preview(b, n, tier)
        const lintFails = [...new Set(f.defects.filter((d) => d.status === "FAIL").map((d) => d.checkId))]
        expect(lintFails.sort()).toEqual(want.fails.sort())
        console.log(`R4 Gambar 1.${n} ${tier}: render FAIL [${want.fails.join(",")}] preview defects [${f.defects.map((d) => d.checkId).join(",")}] notRun ${f.notRun?.map((x) => `${x.id}:${x.cause}`).join(",")} ran ${f.checksRun}`)
      })
    }
  }

  test("Gambar 1.1 rebuilt with the quoted fault (two accent subjects): refused at preview with DATUM-26, as at render", async () => {
    const b = load(1)
    b.spec.edges[0].kind = "accent"
    b.spec.edges[1].kind = "accent"
    const want = await render(b, 1, "NOTA")
    expect(want.refused).toBe("DATUM-26")
    await expect(preview(b, 1, "NOTA")).rejects.toMatchObject({ details: { checkId: "DATUM-26" } })
  })

  test("Gambar 1.4 rebuilt with the quoted fault (pln: stadium, wd1: bus): refused at preview with DATUM-35, as at render", async () => {
    const b = load(4)
    b.spec.nodes[0].shape = "stadium"
    b.spec.nodes[1].shape = "bus"
    const want = await render(b, 4, "NOTA")
    expect(want.refused).toBe("DATUM-35")
    await expect(preview(b, 4, "NOTA")).rejects.toMatchObject({ details: { checkId: "DATUM-35" } })
  })

  test("two accented nodes on Gambar 1.1 at SERAH: the structure twin of DATUM-26 refuses at render lint and now at preview", async () => {
    const b = load(1)
    b.spec.nodes[1].class = { ...b.spec.nodes[1].class, accent: true }
    const want = await render(b, 1, "SERAH")
    expect(want.fails).toContain("DATUM-26")
    const f = await preview(b, 1, "SERAH")
    expect(f.defects.map((d) => d.checkId)).toContain("DATUM-26")
  })
})

describe.skipIf(!available)("row 65 timing (Gambar 1.5, 11 nodes, SERAH)", () => {
  test("parity adds little to a preview: no PDF, no raster", async () => {
    const { previewLintParity } = await import("../../src/mcp-host/local-api/routes/figure-preview-parity")
    const b = load(5)
    const content = compose(b, 5)
    const nb = normBlock(content, 5)
    const svg = await buildDiagramSvgAuto(content.spec, { release: false, grid: figureGrid(params), ...diagramApparatusOptions("ID") })
    const med = (xs: number[]) => xs.sort((x, y) => x - y)[xs.length >> 1]
    const total: number[] = []
    const parity: number[] = []
    for (let k = 0; k < 21; k++) {
      let t = performance.now()
      await renderFigure(nb as never, tpl, { inline: true, withSvg: false, lang: "ID", document: snapOf("SERAH") } as never)
      total.push(performance.now() - t)
      t = performance.now()
      previewLintParity({ block: nb as never, spec: content.spec, svg, tpl, snapshot: snapOf("SERAH") })
      parity.push(performance.now() - t)
    }
    console.log(`R4 timing: preview median ${med(total).toFixed(1)} ms; parity alone median ${med(parity).toFixed(2)} ms; preview without parity ~${(med(total) - med(parity)).toFixed(1)} ms`)
    expect(med(parity)).toBeLessThan(50)
  })
})
