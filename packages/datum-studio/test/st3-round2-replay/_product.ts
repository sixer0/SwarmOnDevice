// Swarm 1.3.3 row 49 (ST-3 acceptance): the product path for one round-2 block, document render and preview.
//
// Taken from row 36's `createHarness` (test/st1-capacity-table/capacity-harness.ts), with two differences only:
//   1. the preview is asked for its SVG (`withSvg: true`), so the four counts run on the preview figure as well;
//   2. the block keeps its own type, caption and source, so the chart block of the set (u3/3.1) takes the chart path.
// Both paths start from the same composed inline block (compose `mapBlock` via `composeInlineBlock`, the one width
// decision of row 32: text = 128 mm, full = 166 mm):
//   R. document render: services/render/figures.ts `buildFigures` (raster step against a fake render bridge, as rows 36
//      and 32 do; no Electron in tests);
//   P. preview (the machine gate the agent guide names): `renderFigure` of figure-preview-figure.ts;
//   S. the stand-alone figure preview (`renderResolved(..., { standalone: true })`, row 165C): the only product path in
//      this tree that draws KUNCI and SUMBER inside the SVG (the document and the inline preview print them as page
//      rows under the figure), so it is the path on which a struck key row can be seen at all.
// A path that throws (or that the document job records as a figure error) is a refusal, with its code and check id.
import { writeFileSync } from "node:fs"
import type { NormBlock, NormDocSnapshot, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"

type J = Record<string, any>
export type Width = "text" | "full"
type Issue = { checkId: string; status: string; detail?: string | null }

export interface Refusal {
  code: string
  checkId?: string
  message: string
}
export interface PathResult {
  svg: string | null
  refusal: Refusal | null
  widthMm?: number
  /** Defect check ids the preview classing gives (sorted, unique). */
  defects: string[]
  notices: string[]
}
export interface Rendered {
  document: PathResult
  preview: PathResult
  /** The stand-alone figure preview (row 165C): KUNCI and SUMBER are drawn inside the SVG. Diagram blocks only. */
  standalone: PathResult | null
  /** The composed inline block both paths received (null when compose refused it); `content.keyRow` is the page key. */
  inline: J | null
}
export interface Product {
  widthMm: (w: Width) => number
  /** Render one block (`{type, caption, source, spec}`) at a width through both paths. */
  render: (block: J, width: Width) => Promise<Rendered>
  /** The HTML the document prints as the figure's KUNCI row (`keyRowHtml` of html/tables/figure.ts), "" when none. */
  pageKeyHtml: (inline: J) => string
  /** Document language of the anchor document ("ID" / "EN"). */
  lang: "ID" | "EN"
  dispose: () => void
}

const MSG_MAX = 300
const uniq = (xs: string[]) => [...new Set(xs)].sort()

function refusalOf(e: unknown): Refusal {
  const err = e as { code?: unknown; message?: unknown; details?: unknown; name?: unknown }
  const details = (typeof err.details === "object" && err.details !== null ? err.details : {}) as J
  return {
    code: typeof err.code === "string" ? err.code : String(err.name ?? "Error"),
    ...(typeof details.checkId === "string" ? { checkId: details.checkId } : {}),
    message: String(err.message ?? e).slice(0, MSG_MAX),
  }
}

export async function createProduct(): Promise<Product> {
  const K = await import("../ported/renderers/_kit")
  const S = await import("../ported/structure/_kit")
  const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
  const { FIGURE_WIDTH_MM } = await import("../../vendor/src/lib/studio/contract/schema/v2/common.schema")
  const preview = await import("../../src/mcp-host/local-api/routes/figure-preview-figure")
  const { buildFigures } = await import("../../vendor/src/lib/studio/services/render/figures")
  const { InlineSpecReader, createDetachedJob } = await import("../../vendor/src/lib/studio/services/render/pure/job")
  const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
  const { keyRowHtml } = await import("../../vendor/src/lib/studio/engine/html/tables/apparatus")

  // One synthetic document gives the compose context and the template (row 36's anchor document).
  const slots = S.datumSlots()
  const doc = S.e1() as J
  const anchor = { type: "diagram", caption: { text: "Jangkar." }, source: { text: "Sumber sintetis uji." }, spec: { family: "flow", direction: "LR", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [{ from: "a", to: "b" }] } }
  doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf sintetis sebelum figur." }, anchor]
  const { template: _t, ...sub } = doc
  const snap = composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams(), assets: {} }).snapshot as unknown as NormDocSnapshot
  const tpl: ResolvedTemplate = await K.canonicalTemplate()
  const near = (snap.blocks as Array<NormBlock & { pid?: string; slotKey?: string }>).find((b) => b.type === "diagram")
  if (!near) throw new Error("row 49: the anchor diagram block is missing from the composed snapshot")

  const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
  const pngs = new Map<string, Uint8Array>()
  const pngOf = (w: number, hh: number): Uint8Array => {
    const k = `${w}x${hh}`
    if (!pngs.has(k)) pngs.set(k, K.makePng(w, hh))
    return pngs.get(k) as Uint8Array
  }
  runtime.setRenderBridgeTransport((async (req: J) => {
    if (req.op === "hello") return HELLO
    if (req.op === "png") {
      writeFileSync(String(req.dst), pngOf(Number(req.width), Number(req.height)))
      return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
    }
    return { ok: false, code: "UNKNOWN_OP", message: "?" }
  }) as never)

  const inlineOf = (block: J) => preview.composeInlineBlock(snap as never, block as never, { pid: near.pid ?? near.blockId, slotKey: near.slotKey, artifactLabel: near.artifactLabel, address: near.address })
  const lang = String((snap.doc?.meta as J | undefined)?.language ?? "ID").toUpperCase() === "EN" ? "EN" : "ID"

  const issuesOf = (issues: Issue[]) => {
    const split = preview.splitPreviewIssues(issues.filter((i) => i.status !== "PASS"))
    return { defects: uniq(split.defects.map((d: Issue) => d.checkId)), notices: uniq(split.notices.map((d: Issue) => d.checkId)) }
  }

  const documentRender = async (inline: NormBlock): Promise<PathResult> => {
    const job = createDetachedJob(["HTML"]) as J
    let recorded: unknown = null
    let recordedText = ""
    const addError = job.addError.bind(job)
    job.addError = (code: string, message: string, format?: unknown, err?: unknown) => {
      if (recorded === null) {
        recorded = err ?? new Error(message)
        recordedText = `${code}: ${message}`
      }
      return addError(code, message, format, err)
    }
    try {
      const built = await buildFigures({ snapshot: { ...snap, blocks: [inline] } as never, tpl, tier: "NOTA", job: job as never, reader: new InlineSpecReader({}) })
      if (recorded !== null) {
        const r = refusalOf(recorded)
        return { svg: null, refusal: recordedText.includes("raster failed") ? { ...r, message: recordedText.slice(0, MSG_MAX) } : r, defects: [], notices: [] }
      }
      const r = built.svgs[0] as unknown as { svg: string; widthMm: number; report: { issues: Issue[]; geometry?: unknown[] } }
      const geometry = (Array.isArray(r.report.geometry) ? r.report.geometry : []).filter((g): g is Issue => typeof g === "object" && g !== null && typeof (g as J).checkId === "string")
      return { svg: r.svg, refusal: null, widthMm: r.widthMm, ...issuesOf([...r.report.issues, ...geometry]) }
    } catch (e) {
      return { svg: null, refusal: refusalOf(e), defects: [], notices: [] }
    }
  }

  const previewRender = async (inline: NormBlock): Promise<PathResult> => {
    try {
      const r = (await preview.renderFigure(inline, tpl, { inline: true, withSvg: true, lang })) as J
      return { svg: String(r.svg ?? ""), refusal: null, widthMm: r.size?.widthMm, defects: uniq((r.defects as Issue[]).map((d) => d.checkId)), notices: uniq((r.notices as Issue[]).map((d) => d.checkId)) }
    } catch (e) {
      return { svg: null, refusal: refusalOf(e), defects: [], notices: [] }
    }
  }

  const standaloneRender = async (inline: NormBlock): Promise<PathResult> => {
    try {
      const f = await preview.resolveFigure(inline)
      const r = (await preview.renderResolved(f, tpl, { inline: true, withSvg: true, lang, standalone: true })) as J
      return { svg: String(r.svg ?? ""), refusal: null, widthMm: r.size?.widthMm, defects: uniq((r.defects as Issue[]).map((d) => d.checkId)), notices: uniq((r.notices as Issue[]).map((d) => d.checkId)) }
    } catch (e) {
      return { svg: null, refusal: refusalOf(e), defects: [], notices: [] }
    }
  }

  const render: Product["render"] = async (block, width) => {
    let inline: NormBlock
    try {
      inline = inlineOf({ ...block, width })
    } catch (e) {
      const refusal = refusalOf(e)
      const p: PathResult = { svg: null, refusal, defects: [], notices: [] }
      return { document: p, preview: p, standalone: block.type === "diagram" ? p : null, inline: null }
    }
    return { document: await documentRender(inline), preview: await previewRender(inline), standalone: block.type === "diagram" ? await standaloneRender(inline) : null, inline: inline as unknown as J }
  }
  const ctx = K.makeCtx(snap, tpl).ctx
  const pageKeyHtml: Product["pageKeyHtml"] = (inline) => (inline.content?.keyRow ? keyRowHtml(inline.content.keyRow, ctx) : "")
  return { widthMm: (w) => FIGURE_WIDTH_MM[w], render, pageKeyHtml, lang, dispose: () => runtime.setRenderBridgeTransport(null) }
}
