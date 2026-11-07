// DATUM render bridge: op dispatch (row 24). Validates, reads inputs, builds the page, asks the
// page engine (Electron in production, a fake in tests) and writes outputs atomically.

import { randomBytes, createHash } from "node:crypto"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import {
  type CheckPageRequest,
  type PagePngRequest,
  type PdfRequest,
  type PngRequest,
  type RenderRequest,
  BridgeError,
  MAX_PAGE_IMAGES,
  PAGE_PNG_DPI,
  validateRequest,
} from "./protocol"
import { A4_MM, pageFileName, type PageSizeMm } from "./page-images"
import { checkInputPath, checkOutputPath, type PathPolicy } from "./paths"
import { htmlWithFonts, mmToPx, svgPdfPage, svgPngPage, svgSizeMm } from "./pages"
import { checkPageExpression, type ScriptAllowList } from "./scripts"
import type { FontBundle } from "./fonts"

export type EngineInfo = {
  electron: string
  chrome: string
  partition: string
  sandbox: boolean
  contextIsolation: boolean
  nodeIntegration: boolean
  javascriptContent: boolean
  network: "blocked"
}

export interface PageEngine {
  png(job: { html: string; width: number; height: number }): Promise<Buffer>
  pdf(job: { html: string; widthMm: number; heightMm: number; preferCSSPageSize: boolean }): Promise<Buffer>
  evaluate(job: { html: string; viewportWidth: number; viewportHeight: number; expression: string }): Promise<unknown>
  /** Row 151b: print-emulated layout, one PNG per selected page (page-images.ts). */
  pagePngs(job: PagePngsJob): Promise<PagePngsResult>
  info(): EngineInfo
}

export type PagePngsJob = {
  html: string
  /** Page size when the document has no CSS @page size. */
  fallback: PageSizeMm
  dpi: number
  /** 1-based pages to image; null = the first MAX_PAGE_IMAGES. */
  pages: number[] | null
}
export type PagePngsResult = {
  layout: "paged" | "flow"
  media: "print"
  pageCount: number
  pageSizeMm: PageSizeMm
  /** "css" when an @page size rule was read, else "fallback". */
  pageSizeSource: "css" | "fallback"
  images: Array<{ n: number; png: Buffer; width: number; height: number }>
  /** Row 151c (DEFECT-157-1): why the images only approximate the printed pages (flow layout); absent when exact. */
  approximate?: string
}

export type DispatchDeps = {
  engine: PageEngine
  policy: PathPolicy
  fonts: () => FontBundle
  scripts: ScriptAllowList
}

export type DispatchResult = Record<string, unknown>

const DEFAULT_HTML_PAGE_MM = { wMm: 210, hMm: 297 }

function readText(path: string) {
  return readFileSync(path, "utf8")
}

function writeAtomic(target: string, bytes: Buffer) {
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`
  writeFileSync(tmp, bytes, { flag: "wx", mode: 0o644 })
  renameSync(tmp, target)
}

function written(dst: string, bytes: Buffer) {
  writeAtomic(dst, bytes)
  return { dst, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
}

async function png(req: PngRequest, d: DispatchDeps) {
  const src = checkInputPath(req.src, d.policy)
  const dst = checkOutputPath(req.dst, d.policy)
  const svg = readText(src)
  const width = req.width
  let height = req.height
  if (height === undefined) {
    // rsvg-convert -w W without -h (datum_diagram.py:2032): keep the SVG's aspect ratio.
    const { wMm, hMm } = svgSizeMm(svg)
    height = Math.max(1, Math.round((width * hMm) / wMm))
  }
  const bytes = await d.engine.png({ html: svgPngPage(svg, width, height, d.fonts().css), width, height })
  return { ...written(dst, bytes), width, height }
}

async function pdf(req: PdfRequest, d: DispatchDeps) {
  const src = checkInputPath(req.src, d.policy)
  const dst = checkOutputPath(req.dst, d.policy)
  const text = readText(src)
  const isSvg = src.toLowerCase().endsWith(".svg")
  let html: string
  let size: { wMm: number; hMm: number }
  let preferCSSPageSize: boolean
  if (isSvg) {
    size = req.widthMm !== undefined ? { wMm: req.widthMm, hMm: req.heightMm! } : svgSizeMm(text)
    html = svgPdfPage(text, size.wMm, size.hMm, d.fonts().css)
    preferCSSPageSize = req.preferCSSPageSize ?? true
  } else {
    // Studio prints its own HTML (assembleHtml); its @page rules decide the sheet (row07 -> row24).
    size = req.widthMm !== undefined ? { wMm: req.widthMm, hMm: req.heightMm! } : DEFAULT_HTML_PAGE_MM
    html = htmlWithFonts(text, d.fonts().css)
    preferCSSPageSize = req.preferCSSPageSize ?? true
  }
  const bytes = await d.engine.pdf({ html, widthMm: size.wMm, heightMm: size.hMm, preferCSSPageSize })
  return { ...written(dst, bytes), preferCSSPageSize }
}

async function checkPage(req: CheckPageRequest, d: DispatchDeps) {
  const script = d.scripts.check(req.script)
  const source = req.src !== undefined ? readText(checkInputPath(req.src, d.policy)) : req.html!
  const html = htmlWithFonts(source, d.fonts().css)
  const arg = req.arg !== undefined ? req.arg : { w: req.wMm, h: req.hMm }
  const expression = checkPageExpression(req.script, arg)
  const viewportWidth = req.viewportWidth ?? mmToPx(req.wMm)
  const viewportHeight = req.viewportHeight ?? mmToPx(req.hMm)
  const result = await d.engine.evaluate({ html, viewportWidth, viewportHeight, expression })
  return { script, result }
}

async function pagePng(req: PagePngRequest, d: DispatchDeps) {
  const src = checkInputPath(req.src, d.policy)
  // The folder must exist, be within reach and not protected; checked before any render, per file again after.
  checkOutputPath(`${req.dstDir}/${pageFileName(1)}`, d.policy)
  const html = htmlWithFonts(readText(src), d.fonts().css)
  const dpi = req.dpi ?? PAGE_PNG_DPI
  const fallback = req.widthMm !== undefined ? { wMm: req.widthMm, hMm: req.heightMm! } : { ...A4_MM }
  const r = await d.engine.pagePngs({ html, fallback, dpi, pages: req.pages ?? null })
  if (r.images.length > MAX_PAGE_IMAGES) throw new BridgeError("RENDER_FAILED", "page engine returned too many images")
  const pages = r.images.map((img) => ({
    n: img.n,
    ...written(checkOutputPath(`${req.dstDir}/${pageFileName(img.n)}`, d.policy), img.png),
    width: img.width,
    height: img.height,
  }))
  return {
    layout: r.layout,
    media: r.media,
    pageCount: r.pageCount,
    pageSizeMm: r.pageSizeMm,
    pageSizeSource: r.pageSizeSource,
    dpi,
    pages,
    approximate: typeof r.approximate === "string" && r.approximate.length > 0 ? r.approximate : null,
  }
}

/** Serialises jobs: one render at a time keeps output deterministic and the host light. */
export function createDispatcher(deps: DispatchDeps) {
  let chain: Promise<unknown> = Promise.resolve()
  const run = async (body: unknown): Promise<DispatchResult> => {
    const req: RenderRequest = validateRequest(body)
    switch (req.op) {
      case "hello":
        return { ...deps.engine.info(), fonts: deps.fonts().faceCount, scripts: deps.scripts.names() }
      case "png":
        return png(req, deps)
      case "pdf":
        return pdf(req, deps)
      case "checkPage":
        return checkPage(req, deps)
      case "pagePng":
        return pagePng(req, deps)
    }
  }
  // Every success reply names the Electron version: the row 106 shim prints it in its stderr label.
  const electron = deps.engine.info().electron
  const runTagged = async (body: unknown) => ({ electron, ...(await run(body)) })
  return (body: unknown): Promise<DispatchResult> => {
    const next = chain.then(
      () => runTagged(body),
      () => runTagged(body),
    )
    chain = next.catch(() => undefined)
    return next
  }
}
