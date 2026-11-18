// Swarm 1.3.3 row 32 (ST-1 item 1; contract row 25). The per-figure `width` (`text` | `full`) of a chart, diagram or
// image block decides the figure width in compose, and the SAME block gives the SAME width on the three paths:
//   A. standalone preview  : an inline block -> composeInlineBlock (src/mcp-host/local-api/routes/figure-preview-figure.ts
//                            :210-241, mapBlock at :222) -> renderResolved (:390), also with `standalone: true`
//   B. in-document preview : the stored block (composeV2 -> services/compose/snapshot.ts:342 mapBlock) -> findFigureBlock
//                            -> renderFigure (:476)
//   C. render              : the same stored block -> services/render/figures.ts buildFigures (:197) -> the figure store
//                            (engine/docx/figures/store.ts:96 `placedW = widthOf(block)`), and for images the page
//                            renderer (engine/html/tables/figure.ts resolveGraphic reads `content.widthMm`)
// All three read the block that services/compose/blocks.ts `mapBlock` wrote; `figureWidthMm` is the one decision.
// Absent `width` keeps the template behaviour (`<kind>.widthClass` through `<kind>.widthMm`).
// Also (contract row 26): compose `diagramSpec` carries the root `tiers` unchanged.
// Pure: no store, no port; the raster step of buildFigures runs against a fake render bridge (as rel127-verify-t15).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"

type J = Record<string, any>
const L = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio")
const K = await import("../ported/renderers/_kit")
const S = await import("../ported/structure/_kit")
const { composeV2, figureWidthMm, mapBlock } = await import("../../vendor/src/lib/studio/services/compose")
const { diagramSpec } = await import("../../vendor/src/lib/studio/services/compose/blocks")
const { FIGURE_WIDTH_MM, FIGURE_WIDTH_VALUES } = await import("../../vendor/src/lib/studio/contract/schema/v2/common.schema")
const { PARAMS_BY_KEY } = await import("../../vendor/src/lib/studio/params")
const { COMPOSE_PARAM_KEYS } = await import("../../vendor/src/lib/studio/services/compose/context")
const preview = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
const { buildFigures } = await import("../../vendor/src/lib/studio/services/render/figures")
const { InlineSpecReader, createDetachedJob } = await import("../../vendor/src/lib/studio/services/render/pure/job")
const { assembleHtml } = await import("../../vendor/src/lib/studio/engine/html/assemble")
const runtime = await import(path.join(L, "engine", "browser", "runtime.ts"))

const WIDTHS = [...FIGURE_WIDTH_VALUES, undefined] as const
type W = (typeof WIDTHS)[number]
const name = (w: W) => w ?? "absent"
/** Registry values (not literals of this test): the text column and the full span of the default A4 DATUM grid. */
const TEXT_MM = PARAMS_BY_KEY.get("grid.textColumnMm")!.default as number
const FULL_MM = PARAMS_BY_KEY.get("grid.fullSpanMm")!.default as number
const expected = (w: W) => (w === "full" ? FULL_MM : TEXT_MM)

const t = (text: string) => ({ text })
/** Parity fixture dg_flow.json (4 nodes; fits the text column), reduced to the DiagramSpecV2 fields. */
const FLOW = JSON.parse(readFileSync(path.resolve(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "diagram", "dg_flow.json"), "utf8")) as J
const withWidth = (b: J, w: W): J => (w === undefined ? b : { ...b, width: w })
const diagramBlock = (w: W): J =>
  withWidth(
    {
      type: "diagram",
      caption: t(`Alur uji lebar ${name(w)}.`),
      source: t("Sumber sintetis uji."),
      spec: { family: FLOW.family, labels_verified: true, nodes: FLOW.nodes, edges: FLOW.edges, legend: FLOW.legend },
    },
    w,
  )
const chartBlock = (w: W): J =>
  withWidth(
    {
      type: "chart",
      code: "P-01",
      unit: "ton",
      data: { shape: "categorical", points: [{ label: "Alfa", value: 4 }, { label: "Bravo", value: 3 }, { label: "Charlie", value: 2 }, { label: "Delta", value: 1 }] },
      caption: t(`Bagan uji lebar ${name(w)}.`),
      source: t("Sumber sintetis uji, 2026."),
    },
    w,
  )
const SHA = "ab".repeat(32)
const imageBlock = (w: W): J => withWidth({ type: "image", asset: `sha256:${SHA}`, caption: t(`Gambar uji lebar ${name(w)}.`), source: t("Sumber sintetis uji.") }, w)

/** One document: per kind, the three width cases in order text, full, absent. */
function submission(): J {
  const doc = S.e1()
  doc.sections.content.chapters[0].sections[0].blocks = [
    { type: "paragraph", text: "Paragraf sintetis sebelum figur." },
    ...WIDTHS.map(diagramBlock),
    ...WIDTHS.map(chartBlock),
    ...WIDTHS.map(imageBlock),
  ]
  return doc
}

// Fake render bridge (no Electron), as test/rel127-verify/rel127-verify-t15.test.ts.
const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
const fakeBridge = async (req: J) => {
  if (req.op === "hello") return HELLO
  if (req.op === "png") {
    writeFileSync(String(req.dst), K.makePng(Number(req.width), Number(req.height)))
    return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
  }
  return { ok: false, code: "UNKNOWN_OP", message: "?" }
}

let snap: NormDocSnapshot
let tpl: ResolvedTemplate
let stored: Record<"diagram" | "chart" | "image", Array<NormBlock & { pid?: string; slotKey?: string }>>

beforeAll(async () => {
  const slots = S.datumSlots()
  const { template: _t, ...sub } = submission()
  snap = composeV2({
    source: S.merge(sub, undefined, { slots }).doc,
    skeleton: S.skeletonInput(slots),
    params: S.defaultParams(),
    assets: { [SHA]: { mime: "image/png", widthPx: 1961, heightPx: 709 } },
  }).snapshot as unknown as NormDocSnapshot
  tpl = await K.canonicalTemplate()
  const of = (type: string) => (snap.blocks as Array<NormBlock & { pid?: string; slotKey?: string }>).filter((b) => b.type === type)
  stored = { diagram: of("diagram"), chart: of("chart"), image: of("image") }
  runtime.setRenderBridgeTransport(fakeBridge)
})
afterAll(() => runtime.setRenderBridgeTransport(null))

describe("row 32: figureWidthMm reads the block width first, then the template parameter", () => {
  test("the registry values are the contract values (128 / 166 on A4 DATUM)", () => {
    expect({ text: TEXT_MM, full: FULL_MM }).toEqual({ ...FIGURE_WIDTH_MM })
  })

  test("text and full on the default grid, for chart, diagram and image", () => {
    for (const kind of ["chart", "diagram", "image"] as const) {
      expect(figureWidthMm(kind, {}, "text")).toBe(TEXT_MM)
      expect(figureWidthMm(kind, {}, "full")).toBe(FULL_MM)
      expect(figureWidthMm(kind, {})).toBe(TEXT_MM)
    }
  })

  test("the numbers come from the template grid, not from literals", () => {
    const grid = { "grid.textColumnMm": 120, "grid.allowedFigureWidthsMm": [120, 150] }
    expect(figureWidthMm("diagram", grid, "text")).toBe(120)
    expect(figureWidthMm("diagram", grid, "full")).toBe(150)
  })

  test("the block width wins over the template class in both directions; absent keeps the template", () => {
    const fullTemplate = { "diagram.widthMm": FULL_MM, "chart.output.widthMm": FULL_MM, "image.widthMm": FULL_MM }
    for (const kind of ["chart", "diagram", "image"] as const) {
      expect(figureWidthMm(kind, fullTemplate)).toBe(FULL_MM)
      expect(figureWidthMm(kind, fullTemplate, "text")).toBe(TEXT_MM)
      expect(figureWidthMm(kind, fullTemplate, "full")).toBe(FULL_MM)
      expect(figureWidthMm(kind, {}, "full")).toBe(FULL_MM)
    }
  })

  test("only keys of the stored compose context are read, so the inline preview resolves the same number", () => {
    // A grid whose derived keys disagree with the registry defaults: a key outside COMPOSE_PARAM_KEYS would be lost
    // in the stored context (services/compose/context.ts `pick`) and the two paths would then differ.
    const full: J = { "grid.textColumnMm": 120, "grid.fullSpanMm": 150, "grid.allowedFigureWidthsMm": [120, 150] }
    const picked = Object.fromEntries(Object.entries(full).filter(([k]) => (COMPOSE_PARAM_KEYS as readonly string[]).includes(k)))
    expect(Object.keys(picked)).not.toContain("grid.fullSpanMm")
    for (const w of FIGURE_WIDTH_VALUES) expect(figureWidthMm("diagram", picked, w)).toBe(figureWidthMm("diagram", full, w))
  })

  test("a symbol sheet has no width field and keeps the template width", () => {
    const b = mapBlock({ type: "symbolSheet", dialect: "IEC", caption: t("Lembar."), source: t("Sumber."), width: "full" } as never, "p1", { glyphs: new Set<string>(), params: {}, classification: "" }) as J
    expect(b.widthMm).toBe(TEXT_MM)
  })
})

describe("row 32: the same block gives the same width on the three paths", () => {
  test("the document holds three blocks per kind, numbered", () => {
    for (const kind of ["diagram", "chart", "image"] as const) {
      expect(stored[kind].length).toBe(3)
      for (const b of stored[kind]) expect(b.artifactLabel).toMatch(/^Gambar 1\.\d+$/)
    }
  })

  for (const [i, w] of WIDTHS.entries()) {
    test(`diagram, width ${name(w)}: standalone preview = in-document preview = render = ${expected(w)} mm`, async () => {
      const block = stored.diagram[i]
      // B. in-document preview (stored block by pid)
      const hit = preview.findFigureBlock(snap as never, { pid: block.pid } as never)
      const inDoc = await preview.renderFigure(hit, tpl, { inline: false, withSvg: true, lang: "ID" })
      // A. standalone preview: the same v2 block sent inline, and the stand-alone figure mode
      const inline = preview.composeInlineBlock(snap as never, diagramBlock(w) as never, { slotKey: block.slotKey, artifactLabel: block.artifactLabel, address: block.address })
      const lone = await preview.renderFigure(inline, tpl, { inline: true, withSvg: true, lang: "ID" })
      const solo = await preview.renderResolved(await preview.resolveFigure(inline), tpl, { inline: true, withSvg: true, standalone: true, lang: "ID" })
      // C. render
      const built = await buildFigures({ snapshot: { ...snap, blocks: [block] } as never, tpl, tier: "NOTA", job: createDetachedJob(["HTML"]) as never, reader: new InlineSpecReader({}) })
      const got = {
        composeStored: (block.content as J).widthMm,
        specStored: (block.content as J).spec.width_mm,
        composeInline: (inline.content as J).widthMm,
        specInline: (inline.content as J).spec.width_mm,
        previewInDocument: inDoc.size.widthMm,
        previewStandalone: lone.size.widthMm,
        previewStandaloneFigure: solo.size.widthMm,
        renderSvg: built.svgs[0]?.widthMm,
        renderPlaced: (built.store.get(block.artifactLabel as string) as J | undefined)?.widthMm,
      }
      const e = expected(w)
      expect(got).toEqual({ composeStored: e, specStored: e, composeInline: e, specInline: e, previewInDocument: e, previewStandalone: e, previewStandaloneFigure: e, renderSvg: e, renderPlaced: e })
      // The drawing itself is the same on the preview and the render path (preview called with the document language,
      // as the route does; without `lang` only the key word differs, KEY against KUNCI).
      expect(built.svgs[0].svg).toBe(inDoc.svg as string)
      expect(lone.svg).toBe(inDoc.svg as string)
    })

    test(`chart, width ${name(w)}: standalone preview = in-document preview = render = ${expected(w)} mm`, async () => {
      const block = stored.chart[i]
      const hit = preview.findFigureBlock(snap as never, { pid: block.pid } as never)
      const inDoc = await preview.renderFigure(hit, tpl, { inline: false, withSvg: true, lang: "ID" })
      const inline = preview.composeInlineBlock(snap as never, chartBlock(w) as never, { slotKey: block.slotKey, artifactLabel: block.artifactLabel, address: block.address })
      const lone = await preview.renderFigure(inline, tpl, { inline: true, withSvg: true, lang: "ID" })
      const built = await buildFigures({ snapshot: { ...snap, blocks: [block] } as never, tpl, tier: "NOTA", job: createDetachedJob(["HTML"]) as never, reader: new InlineSpecReader({}) })
      const got = {
        composeStored: (block.content as J).widthMm,
        specStored: (block.content as J).spec.widthMm,
        composeInline: (inline.content as J).widthMm,
        specInline: (inline.content as J).spec.widthMm,
        previewInDocument: inDoc.size.widthMm,
        previewStandalone: lone.size.widthMm,
        renderSvg: built.svgs[0]?.widthMm,
        renderPlaced: (built.store.get(block.artifactLabel as string) as J | undefined)?.widthMm,
      }
      const e = expected(w)
      expect(got).toEqual({ composeStored: e, specStored: e, composeInline: e, specInline: e, previewInDocument: e, previewStandalone: e, renderSvg: e, renderPlaced: e })
      expect(lone.svg).toBe(inDoc.svg as string)
    })
  }

  test("image: the block width is the same from document compose and from the inline compose path", () => {
    // The figure preview admits chart and diagram only (findFigureBlock BLOCK_TYPE_NOT_ADMITTED); for an image the
    // two compose entries and the page renderer are the paths.
    for (const [i, w] of WIDTHS.entries()) {
      const block = stored.image[i]
      const viaMap = mapBlock(imageBlock(w) as never, "preview", { glyphs: new Set<string>(), params: (snap as J).compose.params, classification: "" }) as J
      expect((block.content as J).widthMm).toBe(expected(w))
      expect(viaMap.widthMm).toBe(expected(w))
    }
  })

  test("a `full` image block prints at 166 mm; `text` and absent print at 128 mm", async () => {
    const png = K.makePng(1961, 709)
    const html = await assembleHtml(K.makeCtx(snap, tpl, { assetBytes: () => png } as never).ctx, { preview: false })
    const figures = [...html.matchAll(/<figure\b[^>]*data-block-type="image"[^>]*>[\s\S]*?<\/figure>/g)].map((m) => m[0])
    expect(figures.length).toBe(3)
    const widths = figures.map((f) => /<img\b[^>]*style="[^"]*\bwidth:([\d.]+)mm/.exec(f)?.[1])
    expect(widths.map(Number)).toEqual(WIDTHS.map(expected))
    expect(Number(widths[1])).toBe(FIGURE_WIDTH_MM.full)
  })
})

describe("row 32 (contract row 26): compose carries the diagram root `tiers` unchanged", () => {
  const CTX = { glyphs: new Set<string>(), params: {}, classification: "TERBATAS" }
  const tiers = [
    { tier: 0, label: "Lapisan akses" },
    { tier: 1, label: "Lapisan inti" },
  ]
  const base = { family: "layered", nodes: [{ id: "a", label: "A", class: { tier: 0 } }, { id: "b", label: "B", class: { tier: 1 } }] }

  test("present: the same array reaches studio.diagram/v1", () => {
    const out = diagramSpec({ ...base, tiers } as never, "Judul", "Sumber", TEXT_MM, CTX as never) as J
    expect(out.tiers).toEqual(tiers)
    expect(out.tiers).toBe(tiers)
  })

  test("absent stays absent; an empty array stays an empty array", () => {
    expect("tiers" in (diagramSpec(base as never, "Judul", "Sumber", TEXT_MM, CTX as never) as J)).toBe(false)
    expect((diagramSpec({ ...base, tiers: [] } as never, "Judul", "Sumber", TEXT_MM, CTX as never) as J).tiers).toEqual([])
  })

  test("through the block path (mapBlock)", () => {
    const b = mapBlock({ type: "diagram", caption: t("Lapisan."), source: t("Sumber."), spec: { ...base, tiers } } as never, "p1", CTX as never) as J
    expect(b.spec.tiers).toEqual(tiers)
  })
})
