// Swarm 1.3.3 row 149 (senior S10): the framed-SVG intake takes the column width from compose's `figureWidthMm`
// for the document's template, not from the A4 contract constant. Without a document it uses the A4 values and the
// reply says so. A template with a 150 mm text column (180 mm full span) places a 142 mm sheet at 150 mm, and compose
// prints that image block at the same 150 mm.
//   No Electron and no port: the render bridge is the stand-in transport (as row 116), the store is a temp folder.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NormDocSnapshot, ParamMap } from "../../vendor/src/lib/studio/contract"

type J = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const SCRIPTS = path.resolve(PKG, "..", "desktop", "datum", "gsp-diagram-standard", "scripts")
const GOLDEN_128 = readFileSync(path.join(SCRIPTS, "testdata", "golden_128.svg"), "utf8")
const GOLDEN_166 = readFileSync(path.join(SCRIPTS, "testdata", "golden_166.svg"), "utf8")

const base = process.env.TMPDIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(base, "row149-")))
const ROOT = path.join(WORK, "datum-studio")

const K = await import("../ported/renderers/_kit")
const S = await import("../ported/structure/_kit")
const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
const { composeV2, figureWidthMm } = await import("../../vendor/src/lib/studio/services/compose")
const { assembleHtml } = await import("../../vendor/src/lib/studio/engine/html/assemble")
const { openHostStore, closeHostStore } = await import("../../src/store-bridge/index.ts")
const { assetHostExtension, figureParamsOf } = await import("../../src/mcp-host/asset-tool")
const { figureColumns, placeFramedSvg, sanitiseSvg } = await import("../../src/mcp-host/svg-intake")

const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
const fakeBridge = async (req: J) => {
  if (req.op === "hello") return HELLO
  if (req.op === "png") {
    const src = readFileSync(String(req.src), "utf8")
    writeFileSync(String(req.dst), K.makePng(Number(req.width), Number(req.height), [...src].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 11)))
    return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
  }
  return { ok: false, code: "UNKNOWN_OP", message: "?" }
}

/** A template whose text column is 150 mm and full span 180 mm (not A4 DATUM). */
const WIDE: ParamMap = { ...S.defaultParams(), "grid.textColumnMm": 150, "grid.allowedFigureWidthsMm": [150, 180] }

const session = { sessionId: "row149-session", agentId: "row149", fileRoot: WORK } as never
const asked: string[] = []
let docs: string[] = []
const tool = assetHostExtension({
  templateParams: async (id) => {
    asked.push(id)
    return WIDE
  },
})
const plain = assetHostExtension()
const put = async (t: typeof tool, args: J) => (await t.call(args, session)) as J

let store: Awaited<ReturnType<typeof openHostStore>> | undefined
beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = ROOT
  const env = await import("../../vendor/src/lib/studio/contract/env")
  env.resetStudioEnvCache()
  store = await openHostStore(ROOT, { release: "1.3.3", logFile: path.join(WORK, "logs", "store.jsonl") })
  runtime.setRenderBridgeTransport(fakeBridge as never)
  docs = []
})
afterAll(async () => {
  runtime.setRenderBridgeTransport(null)
  if (store) await closeHostStore(store)
})

/** Compose one image block with the given template parameters; the printed width (mm) in the HTML page. */
async function printedWidth(params: ParamMap, sha: string, widthPx: number, heightPx: number, width: "text" | "full"): Promise<number> {
  const doc = S.e1()
  doc.sections.content.chapters[0].sections[0].blocks = [
    { type: "paragraph", text: "Paragraf sintetis sebelum lembar." },
    { type: "image", asset: `sha256:${sha}`, caption: { text: "Lembar uji templat lebar." }, source: { text: "Sumber sintetis uji." }, width },
  ]
  const { template: _t, ...sub } = doc
  const slots = S.datumSlots()
  const snap = composeV2({
    source: S.merge(sub, undefined, { slots }).doc,
    skeleton: S.skeletonInput(slots),
    params,
    assets: { [sha]: { mime: "image/png", widthPx, heightPx } },
  }).snapshot as unknown as NormDocSnapshot
  const tpl = await K.canonicalTemplate()
  const html = await assembleHtml(K.makeCtx(snap, tpl, { assetBytes: () => K.makePng(widthPx, heightPx) } as never).ctx, { preview: false })
  const fig = /<figure\b[^>]*data-block-type="image"[^>]*>[\s\S]*?<\/figure>/.exec(html)?.[0] ?? ""
  return Number(/<img\b[^>]*style="[^"]*\bwidth:([\d.]+)mm/.exec(fig)?.[1])
}

describe("row 149: the column comes from compose for the template", () => {
  test("figureColumns: no parameters = A4 (128/166, a4-default); a 150/180 template = 150/180 (document-template)", () => {
    expect(figureColumns()).toEqual({ text: 128, full: 166, source: "a4-default" })
    expect(figureColumns(WIDE)).toEqual({ text: 150, full: 180, source: "document-template" })
    // The same function compose maps the image block with.
    expect(figureColumns(WIDE).text).toBe(figureWidthMm("image", WIDE, "text"))
  })

  test("placement: a 142 mm sheet prints at 150 mm in the wide template; a 180 mm sheet (166 mm figure) is refused at `text` (150) and placed at `full` (180)", () => {
    const s = sanitiseSvg(GOLDEN_128)
    const p = placeFramedSvg(s, "text", figureColumns(WIDE))
    expect(p).toMatchObject({ widthMm: 150, columnMm: 150, widthSource: "document-template" })
    const wide = sanitiseSvg(GOLDEN_166)
    let refusal: J | undefined
    try {
      placeFramedSvg(wide, "text", figureColumns(WIDE))
    } catch (e) {
      refusal = e as J
    }
    expect(refusal?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(refusal?.details).toMatchObject({ columnMm: 150, widthSource: "document-template" })
    expect(String(refusal?.message)).toContain('width "full" (180 mm)')
    expect(placeFramedSvg(wide, "full", figureColumns(WIDE)).widthMm).toBe(180)
  })

  test("figureParamsOf: the revision's stored compose context first, else the pinned template's parameters", () => {
    expect(figureParamsOf({ compose: { v: 1, skeleton: {}, tier: "DRAF", params: { "grid.textColumnMm": 150 } } }, { params: { "grid.textColumnMm": 999 } })).toEqual({ "grid.textColumnMm": 150 })
    expect(figureParamsOf({ doc: {} }, { params: { "grid.textColumnMm": 140 } })).toEqual({ "grid.textColumnMm": 140 })
    expect(figureParamsOf({}, null)).toBeUndefined()
  })
})

describe("row 149: studio_asset_put { svg, width, documentId }", () => {
  test("without documentId: A4 width, and the reply says so", async () => {
    const r = await put(plain, { svg: GOLDEN_128, width: "text" })
    expect(r.isError).toBeUndefined()
    expect(r.structuredContent.fromSvg).toMatchObject({ width: "text", widthMm: 128, widthSource: "a4-default" })
    expect(r.content[0].text).toContain("memakai nilai A4")
    expect(r.content[0].text).toContain("kirim documentId")
  })

  test("an unknown documentId is refused before any width is asked", async () => {
    asked.length = 0
    const r = await put(tool, { svg: GOLDEN_128, width: "text", documentId: "row149-missing" })
    expect(r.structuredContent.code).toBe("DOCUMENT_NOT_FOUND")
    expect(asked).toEqual([])
  })

  test("with the document's 150 mm template: placed at 150 mm, and compose prints the block at 150 mm", async () => {
    // A document row for the existence check (docById); its template parameters come from the injected resolver,
    // the store read path (`documentFigureParams` -> figure-preview loader) is not exercised here.
    const { createDocumentRowForTest } = await seedDocument()
    const id = await createDocumentRowForTest()
    asked.length = 0
    const r = await put(tool, { svg: GOLDEN_128, width: "text", documentId: id })
    expect(r.isError).toBeUndefined()
    expect(asked).toEqual([id])
    const sc = r.structuredContent
    expect(sc.fromSvg).toMatchObject({ width: "text", widthMm: 150, widthSource: "document-template" })
    expect(sc.widthPx).toBeGreaterThanOrEqual(1771) // 150 mm at 300 dpi = 1771.65 px (engine +-1 px)
    expect(sc.widthPx).toBeLessThanOrEqual(1772)
    expect(r.content[0].text).toContain(`dari templat dokumen ${id}`)
    expect(await printedWidth(WIDE, sc.sha256, sc.widthPx, sc.heightPx, "text")).toBe(150)
    // And the A4 template still prints at 128 (unchanged behaviour).
    expect(await printedWidth(S.defaultParams(), sc.sha256, sc.widthPx, sc.heightPx, "text")).toBe(128)
  })
})

/** Seeds one document row (store-bridge `insertDocument`) so the tool's existence check finds it; returns its id. */
async function seedDocument(): Promise<{ createDocumentRowForTest: () => Promise<string> }> {
  const { withStudioTx, insertDocument } = await import("../../src/store-bridge/index.ts")
  return {
    createDocumentRowForTest: async () => {
      const n = docs.length + 1
      const d = await withStudioTx(async (tx) => {
        if (n === 1) {
          tx.run("INSERT INTO template (id, slug, origin, name, kind, latest_version_no, created_by, time_created, time_updated) VALUES ('row149-template', 'user-row149-wide', 'user', 'Templat uji 150 mm', 'DOCUMENT', 0, 'row149', ?, ?)", [tx.now, tx.now])
        }
        return insertDocument(tx, { docNumber: `R149/${n}`, numberSource: "AGENT", title: "Dokumen uji templat lebar", typeCode: "LAP", classification: "BIASA", tier: "NOTA", templateId: "row149-template", createdBy: "row149" } as never)
      })
      docs.push(d.id)
      return d.id
    },
  }
}
