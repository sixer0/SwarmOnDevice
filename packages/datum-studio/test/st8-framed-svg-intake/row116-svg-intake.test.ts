// Swarm 1.3.3 row 116 (ST-8, Q4 = U4): end to end without Electron and without a port.
//   studio_asset_put { svg, width } and R18 POST { svg, width }
//     -> sanitiseSvg (src/mcp-host/svg-intake.ts) -> placeFramedSvg (sheet - 14 mm must fit the column)
//     -> rasterizeSvg (vendored engine/browser, 300 dpi) over a FAKE render bridge (setRenderBridgeTransport; the
//        real bridge is Electron main and cannot run under bun, as rows 32/67/68/108)
//     -> storeAsset (real store in a temp folder) -> PNG asset; the SVG is never stored.
//   Then a v2 image block { asset: sha256:<png>, width } is composed and the HTML page prints it at the chosen width.
//   R9: the six held p3 sheets (research/replay/R9_p3_held_sheets) are reported per sheet.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { NormDocSnapshot } from "../../vendor/src/lib/studio/contract"
import { replayInputs } from "../replay-dir"

type J = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const SCRIPTS = path.resolve(PKG, "..", "desktop", "datum", "gsp-diagram-standard", "scripts")
const FRAME_SCRIPT = path.join(SCRIPTS, "bingkai_lembar.py")
const GOLDEN_128 = readFileSync(path.join(SCRIPTS, "testdata", "golden_128.svg"), "utf8")
const GOLDEN_166 = readFileSync(path.join(SCRIPTS, "testdata", "golden_166.svg"), "utf8")
// Row 146: read from SWARM_REPLAY_DIR/R9_p3_held_sheets, never a fixed path; skipped when the variable is unset.
const R9 = replayInputs("row 116 replay R9", ["R9_p3_held_sheets"] as const)
const R9_DIR = R9.paths[0]

const base = process.env.TMPDIR ?? tmpdir()
mkdirSync(base, { recursive: true })
const WORK = realpathSync(mkdtempSync(path.join(base, "row116-")))
const ROOT = path.join(WORK, "datum-studio")

const K = await import("../ported/renderers/_kit")
const S = await import("../ported/structure/_kit")
const runtime = await import("../../vendor/src/lib/studio/engine/browser/runtime")
const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
const { assembleHtml } = await import("../../vendor/src/lib/studio/engine/html/assemble")
const { FIGURE_WIDTH_MM } = await import("../../vendor/src/lib/studio/contract/schema/v2/common.schema")
const { localStudioCaller } = await import("../../vendor/src/lib/studio/contract/auth")
const { openHostStore, closeHostStore } = await import("../../src/store-bridge/index.ts")
const { assetHostExtension } = await import("../../src/mcp-host/asset-tool")
const r18 = await import("../../src/mcp-host/local-api/routes/r18-assets")

// Fake render bridge: records the SVG the engine hands over and answers a PNG of the asked pixel size.
const HELLO = { ok: true, electron: "42.3.3", chrome: "142.0.0.0", partition: "datum-render", sandbox: true, contextIsolation: true, nodeIntegration: false, javascriptContent: false, network: "blocked", fonts: 20, scripts: ["studio.measure"] }
const rasterSrc: string[] = []
const fakeBridge = async (req: J) => {
  if (req.op === "hello") return HELLO
  if (req.op === "png") {
    const src = readFileSync(String(req.src), "utf8")
    rasterSrc.push(src)
    // Same SVG -> same bytes (the engine re-shoots until two captures match); different SVG -> different sha256.
    writeFileSync(String(req.dst), K.makePng(Number(req.width), Number(req.height), [...src].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 1000, 7)))
    return { ok: true, electron: "42.3.3", dst: req.dst, width: req.width, height: req.height }
  }
  return { ok: false, code: "UNKNOWN_OP", message: "?" }
}

const session = { sessionId: "row116-session", agentId: "row116", fileRoot: WORK } as never
const tool = assetHostExtension()
const put = async (args: J) => (await tool.call(args, session)) as J
const caller = localStudioCaller("row116")
const rc = { params: {}, agentId: "row116", caller, fileRoot: WORK } as never
const post = (body: J) => r18.POST(new Request("http://local/api/studio/assets", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), rc)

let store: Awaited<ReturnType<typeof openHostStore>> | undefined
beforeAll(async () => {
  process.env.STUDIO_WORKSPACE_ROOT = ROOT
  const env = await import("../../vendor/src/lib/studio/contract/env")
  env.resetStudioEnvCache()
  store = await openHostStore(ROOT, { release: "1.3.3", logFile: path.join(WORK, "logs", "store.jsonl") })
  runtime.setRenderBridgeTransport(fakeBridge as never)
})
afterAll(async () => {
  runtime.setRenderBridgeTransport(null)
  if (store) await closeHostStore(store)
})
beforeEach(() => {
  rasterSrc.length = 0
  r18.resetAssetUploadLimiter()
})

/** Compose one document with the given image blocks and return the printed width (mm) of each image. */
async function printedWidths(blocks: Array<{ sha: string; widthPx: number; heightPx: number; width?: "text" | "full" }>): Promise<number[]> {
  const doc = S.e1()
  doc.sections.content.chapters[0].sections[0].blocks = [
    { type: "paragraph", text: "Paragraf sintetis sebelum lembar." },
    ...blocks.map((b, i) => ({ type: "image", asset: `sha256:${b.sha}`, caption: { text: `Lembar uji ${i + 1}.` }, source: { text: "Sumber sintetis uji." }, ...(b.width ? { width: b.width } : {}) })),
  ]
  const { template: _t, ...sub } = doc
  const slots = S.datumSlots()
  const snap = composeV2({
    source: S.merge(sub, undefined, { slots }).doc,
    skeleton: S.skeletonInput(slots),
    params: S.defaultParams(),
    assets: Object.fromEntries(blocks.map((b) => [b.sha, { mime: "image/png", widthPx: b.widthPx, heightPx: b.heightPx }])),
  }).snapshot as unknown as NormDocSnapshot
  const bytes = new Map<string, Uint8Array>()
  const tpl = await K.canonicalTemplate()
  const html = await assembleHtml(K.makeCtx(snap, tpl, { assetBytes: (sha: string) => bytes.get(sha) ?? K.makePng(1512, 100) } as never).ctx, { preview: false })
  const figures = [...html.matchAll(/<figure\b[^>]*data-block-type="image"[^>]*>[\s\S]*?<\/figure>/g)].map((m) => m[0])
  return figures.map((f) => Number(/<img\b[^>]*style="[^"]*\bwidth:([\d.]+)mm/.exec(f)?.[1]))
}

describe("row 116: studio_asset_put { svg, width }", () => {
  test("a framed 142 mm sheet at `text` becomes a 300 dpi PNG asset 128 mm wide (1512 px); the SVG is not stored", async () => {
    const r = await put({ svg: GOLDEN_128, width: "text" })
    expect(r.isError).toBeUndefined()
    const sc = r.structuredContent
    expect(sc.ok).toBe(true)
    expect(sc.mime).toBe("image/png")
    // 300 dpi at the printed size; the engine's own +-1 px tolerance (CSS px truncation, rasterizeSvg row 122 note).
    expect(Math.abs(sc.widthPx - 1512)).toBeLessThanOrEqual(1)
    expect(Math.abs(sc.heightPx - Math.round((((111 * 128) / 142) / 25.4) * 300))).toBeLessThanOrEqual(1)
    expect(sc.fromSvg).toMatchObject({ width: "text", sheetWidthMm: 142, sheetHeightMm: 111, widthMm: 128, dpi: 300 })
    expect(r.content[0].text).toContain('"width":"text"')
    // The renderer got the re-serialised tree at the printed size, not the original text.
    // The engine shoots until two captures match (D-259): two or more png ops, all of the same SVG.
    expect(rasterSrc.length).toBeGreaterThanOrEqual(1)
    expect(new Set(rasterSrc).size).toBe(1)
    expect(rasterSrc[0]).toContain('width="128mm"')
    expect(rasterSrc[0]).not.toContain("<!--")
    expect(rasterSrc[0]).not.toContain("<?xml")
  })

  test("a framed 180 mm sheet (166 mm figure) at `text` is refused FIGURE_OVER_CAPACITY, nothing rasterised", async () => {
    const r = await put({ svg: GOLDEN_166, width: "text" })
    expect(r.isError).toBe(true)
    expect(r.structuredContent.code).toBe("FIGURE_OVER_CAPACITY")
    expect(r.structuredContent.error.details).toMatchObject({ reason: "framed_sheet_too_wide", sheetWidthMm: 180, figureWidthMm: 166, width: "text", columnMm: 128 })
    expect(r.content[0].text).toContain("refused, not shrunk")
    expect(rasterSrc.length).toBe(0)
  })

  test("the same 180 mm sheet at `full` becomes a PNG 166 mm wide (1961 px)", async () => {
    const r = await put({ svg: GOLDEN_166, width: "full" })
    expect(r.structuredContent.ok).toBe(true)
    expect(Math.abs(r.structuredContent.widthPx - 1961)).toBeLessThanOrEqual(1)
    expect(r.structuredContent.fromSvg).toMatchObject({ width: "full", widthMm: 166 })
  })

  test("a forbidden construct is refused by name before any raster", async () => {
    const bad = GOLDEN_128.replace(/<\/svg>\s*$/, "<script>alert(1)</script></svg>")
    const r = await put({ svg: bad, width: "text" })
    expect(r.isError).toBe(true)
    expect(r.structuredContent.code).toBe("ASSET_TYPE_UNSUPPORTED")
    expect(r.structuredContent.error.details).toMatchObject({ reason: "svg_unsafe", construct: "script element" })
    expect(r.content[0].text).toContain("script element")
    expect(rasterSrc.length).toBe(0)
  })

  test("argument shape: width is required with svg, only with svg, and svg excludes path and dataBase64", async () => {
    for (const args of [{ svg: GOLDEN_128 }, { svg: GOLDEN_128, width: "wide" }, { dataBase64: "AAAA", width: "text" }, { svg: GOLDEN_128, width: "text", path: "/x.png" }]) {
      const r = await put(args)
      expect(r.isError).toBe(true)
      expect(r.structuredContent.code).toBe("INVALID_ARGUMENT")
    }
  })

  test("an SVG sent as dataBase64 is still refused ASSET_TYPE_UNSUPPORTED (SVG only through the conversion)", async () => {
    const r = await put({ dataBase64: Buffer.from(GOLDEN_128).toString("base64") })
    expect(r.isError).toBe(true)
    expect(r.structuredContent.code).toBe("ASSET_TYPE_UNSUPPORTED")
  })
})

describe("row 116: R18 POST { svg, width }", () => {
  test("201 with the PNG asset and fromSvg; forbidden construct 415 by name; too wide 422", async () => {
    const ok = await post({ svg: GOLDEN_166, width: "full" })
    // 201 new, or 200 when the same PNG is already stored (dedupe by sha256; the tool test above stored it).
    expect([200, 201]).toContain(ok.status)
    const b = (await ok.json()) as J
    expect(b.asset.mime).toBe("image/png")
    expect(Math.abs(b.asset.widthPx - 1961)).toBeLessThanOrEqual(1)
    expect(b.fromSvg).toMatchObject({ width: "full", widthMm: 166, dpi: 300 })

    const bad = await post({ svg: GOLDEN_128.replace(/<\/svg>\s*$/, '<rect width="1" height="1" onload="x()"/></svg>'), width: "text" })
    expect(bad.status).toBe(415)
    const e = (await bad.json()) as J
    expect(e.code).toBe("ASSET_TYPE_UNSUPPORTED")
    expect(e.error).toContain("event-handler attribute onload")

    const wide = await post({ svg: GOLDEN_166, width: "text" })
    expect(wide.status).toBe(422)
    expect(((await wide.json()) as J).code).toBe("FIGURE_OVER_CAPACITY")

    const noWidth = await post({ svg: GOLDEN_128 })
    expect(noWidth.status).toBe(400)
    expect(((await noWidth.json()) as J).code).toBe("SCHEMA_INVALID")
  })
})

describe("row 116: the PNG asset prints at the chosen width (compose -> HTML page)", () => {
  test("text sheet -> 128 mm, full sheet -> 166 mm", async () => {
    const a = (await put({ svg: GOLDEN_128, width: "text" })).structuredContent
    const b = (await put({ svg: GOLDEN_166, width: "full" })).structuredContent
    const widths = await printedWidths([
      { sha: a.sha256, widthPx: a.widthPx, heightPx: a.heightPx, width: "text" },
      { sha: b.sha256, widthPx: b.widthPx, heightPx: b.heightPx, width: "full" },
    ])
    expect(widths).toEqual([FIGURE_WIDTH_MM.text, FIGURE_WIDTH_MM.full])
  })
})

// R9: the six held p3 sheets. Two inputs per sheet: the sheet as captured (lembar-N.svg), and the same Studio figure
// framed again by the bundled frame script from its own lembar-N.json WITHOUT `font_dir` (the script's optional
// file:// @font-face; the raster embeds the template's own Plex faces). Nothing is edited by hand.
const r9Present = R9.present
const python = spawnSync("python3", ["--version"]).status === 0
describe.skipIf(!r9Present)("row 116: R9 six held p3 sheets", () => {
  const sheets = r9Present ? readdirSync(R9_DIR).filter((f) => /^lembar-\d\.\d\.svg$/.test(f)).sort() : []
  const figureOf = (n: string) => readdirSync(R9_DIR).find((f) => f.startsWith(`Gambar ${n} `) && f.endsWith(".svg"))!
  const table: Array<Record<string, string | number>> = []
  afterAll(() => console.log(`row116 R9 table:\n${table.map((r) => JSON.stringify(r)).join("\n")}`))

  test("six sheets present", () => {
    expect(sheets.length).toBe(6)
  })

  for (const f of ["3.1", "3.2", "3.3", "4.1", "4.2", "4.3"]) {
    test(`sheet ${f}: captured copy refused by name; re-framed without font_dir placed at text`, async () => {
      const captured = readFileSync(path.join(R9_DIR, `lembar-${f}.svg`), "utf8")
      const r1 = await put({ svg: captured, width: "text" })
      expect(r1.isError).toBe(true)
      expect(r1.structuredContent.code).toBe("ASSET_TYPE_UNSUPPORTED")
      expect(r1.structuredContent.error.details.construct).toBe("external reference url()")
      expect(r1.content[0].text).toContain("file:///Applications/Swarm.app")
      const row: Record<string, string | number> = { sheet: f, captured: `refused ${r1.structuredContent.code} (${r1.structuredContent.error.details.construct}: @font-face src file://)` }
      if (!python) {
        row.reframed = "not verifiable (python3 absent)"
        table.push(row)
        return
      }
      const meta = JSON.parse(readFileSync(path.join(R9_DIR, `lembar-${f}.json`), "utf8")) as J
      delete meta.font_dir
      const metaPath = path.join(WORK, `meta-${f}.json`)
      const out = path.join(WORK, `lembar-${f}.svg`)
      writeFileSync(metaPath, JSON.stringify(meta))
      const run = spawnSync("python3", [FRAME_SCRIPT, "--svg", path.join(R9_DIR, figureOf(f)), "--meta", metaPath, "--out", out], { encoding: "utf8" })
      expect(run.status).toBe(0)
      const reframed = readFileSync(out, "utf8")
      const r2 = await put({ svg: reframed, width: "text" })
      expect(r2.structuredContent?.code).toBeUndefined()
      const sc = r2.structuredContent
      expect(sc.ok).toBe(true)
      expect(Math.abs(sc.widthPx - 1512)).toBeLessThanOrEqual(1)
      const [printed] = await printedWidths([{ sha: sc.sha256, widthPx: sc.widthPx, heightPx: sc.heightPx, width: "text" }])
      expect(printed).toBe(128)
      row.reframed = `placed: sheet ${sc.fromSvg.sheetWidthMm} x ${sc.fromSvg.sheetHeightMm} mm -> PNG ${sc.widthPx} x ${sc.heightPx} px, printed ${printed} x ${sc.fromSvg.heightMm} mm, sha256 ${String(sc.sha256).slice(0, 12)}`
      table.push(row)
    })
  }
})
