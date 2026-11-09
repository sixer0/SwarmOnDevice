// DATUM render bridge: the Electron page engine (row 24, runtime spec §3.2, §3.6; prereview M6).
//
// A fresh hidden BrowserWindow per job in the in-memory session partition "datum-render", driven
// through webContents.debugger (CDP), the same calls Playwright issues for screenshot/evaluate:
//   png       Emulation.setDeviceMetricsOverride + Page.captureScreenshot
//   pdf       webContents.printToPDF (paper in inches, margins 0, printBackground, preferCSSPageSize, no header/footer).
//             Not CDP Page.printToPDF: Electron 42's webContents.debugger answers "'Page.printToPDF' wasn't
//             found" (row 55 F55-1); Electron's own API prints the same Chromium page (row 24a).
//   checkPage Runtime.evaluate of an allow-listed fixed script
//   pagePngs  (row 151b) Emulation.setEmulatedMedia print + the bridge's own fixed PAGE_LAYOUT_SCRIPT (page-images.ts)
//             + Page.captureScreenshot clipped to each page, at dpi/96 deviceScaleFactor
// Content is set with Page.setDocumentContent on about:blank (setContent-equivalent): no goto, no
// file:// document. Every request except data:, about:blank and the allowed font/input files is
// cancelled, navigation and new windows are refused, permissions and downloads are denied.

import { BrowserWindow, session, type Debugger, type Session, type WebContents } from "electron"
import { BridgeError } from "./protocol"
import type { EngineInfo, PageEngine, PagePngsJob, PagePngsResult } from "./dispatch"
import { backgroundRgb, composePage, decodePngRgb, flowApproximation, MAX_PAGE_INDEX, pageBackground, pageLayoutExpression, parseMargins, parsePageSize, pngSize, readLayout, readSizeInfo, selectPages } from "./page-images"
import { MAX_PX } from "./protocol"
import { isAllowedRendererUrl } from "./paths"
import { MM_PER_INCH, RENDER_PARTITION, renderWebPreferences, type WindowKind } from "./pages"
import type { BridgeLog } from "./socket-server"

export const JOB_TIMEOUT_MS = 60_000
const SETTLE_MS = 250
const FONTS_READY = "document.fonts.ready.then(function () { return document.fonts.size; })"

let configured: Session | undefined

export function configureRenderSession(allowedFiles: ReadonlySet<string>, log: BridgeLog): Session {
  if (configured) return configured
  const ses = session.fromPartition(RENDER_PARTITION, { cache: false })
  ses.webRequest.onBeforeRequest((details, callback) => {
    const ok = isAllowedRendererUrl(details.url, allowedFiles)
    if (!ok) log("warn", "datum-render.network", "request blocked", { scheme: details.url.split(":")[0], type: details.resourceType })
    callback({ cancel: !ok })
  })
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.enableNetworkEmulation({ offline: true })
  ses.on("will-download", (event) => event.preventDefault())
  configured = ses
  return ses
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout()
      reject(new BridgeError("RENDER_TIMEOUT", `render took longer than ${ms} ms`))
    }, ms)
  })
  try {
    return await Promise.race([p, t])
  } finally {
    clearTimeout(timer)
  }
}

type Job<T> = (dbg: Debugger, wc: WebContents) => Promise<T>

async function inWindow<T>(kind: WindowKind, width: number, height: number, html: string, job: Job<T>, deviceScaleFactor = 1): Promise<T> {
  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: Math.min(width, 4096),
    height: Math.min(height, 4096),
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: renderWebPreferences(kind),
  })
  const wc = win.webContents
  let ready = false
  wc.setWindowOpenHandler(() => ({ action: "deny" }))
  wc.on("will-navigate", (event) => event.preventDefault())
  wc.on("will-redirect", (event) => event.preventDefault())
  wc.on("will-frame-navigate", (event) => {
    if (ready) event.preventDefault()
  })
  wc.setAudioMuted(true)
  const dbg = wc.debugger
  const run = async () => {
    await win.loadURL("about:blank")
    ready = true
    dbg.attach("1.3")
    await dbg.sendCommand("Page.enable")
    // Page script never runs, also in the check window where V8 stays on for Runtime.evaluate.
    await dbg.sendCommand("Emulation.setScriptExecutionDisabled", { value: true })
    await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor, mobile: false })
    // Row 205 (1.2.3, HB-1): no scrollbar takes layout width. With a mouse attached and macOS "Show scroll bars:
    // automatic" (or "always") Chromium reserves a classic 15 px scrollbar in this window, so the layout viewport is
    // 779 px instead of the 794 px A4 sheet: every Studio flow document then measured `.st-unit` (210 mm wide in
    // screen media) 3.89 mm past the right edge (OVERLAP_CLIP and DATUM-37), and flow page images were cut 15 px
    // narrow. Playwright's headless Chromium, which the vendored engine was written against, hides scrollbars too.
    await dbg.sendCommand("Emulation.setScrollbarsHidden", { hidden: true })
    const tree = (await dbg.sendCommand("Page.getFrameTree")) as { frameTree: { frame: { id: string } } }
    await dbg.sendCommand("Page.setDocumentContent", { frameId: tree.frameTree.frame.id, html })
    try {
      await dbg.sendCommand("Runtime.evaluate", { expression: FONTS_READY, awaitPromise: true, returnByValue: true })
    } catch {
      // Hypothesis (row smoke to confirm): evaluate is unavailable with javascript:false; the settle delay covers fonts.
    }
    await delay(SETTLE_MS)
    return job(dbg, wc)
  }
  try {
    return await withTimeout(run(), JOB_TIMEOUT_MS, () => {
      if (!win.isDestroyed()) win.destroy()
    })
  } finally {
    try {
      if (dbg.isAttached()) dbg.detach()
    } catch {}
    if (!win.isDestroyed()) win.destroy()
  }
}

async function evalValue(dbg: Debugger, expression: string): Promise<unknown> {
  const res = (await dbg.sendCommand("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })) as {
    result?: { value?: unknown }
    exceptionDetails?: { text?: string }
  }
  if (res.exceptionDetails) throw new BridgeError("RENDER_FAILED", "page script raised an exception")
  return res.result?.value ?? null
}

const cssPx = (mm: number) => (mm * 96) / MM_PER_INCH

/**
 * Row 151b: page images of an HTML render. Same hidden window, partition, network gate and timeout as every
 * other job; the check window kind (V8 on for CDP only, page script disabled, CSP script-src 'none').
 */
function pagePngs(job: PagePngsJob): Promise<PagePngsResult> {
  const scale = job.dpi / 96
  const w0 = Math.ceil(cssPx(job.fallback.wMm))
  const h0 = Math.ceil(cssPx(job.fallback.hMm))
  const job0 = async (dbg: Debugger): Promise<PagePngsResult> => {
    // Print CSS (@media print) as printToPDF would apply it. Verified on Electron 42 by the row 151b real-Electron test.
    await dbg.sendCommand("Emulation.setEmulatedMedia", { media: "print" })
    const info = readSizeInfo(await evalValue(dbg, pageLayoutExpression({ phase: "size" })))
    const css = parsePageSize(info.size)
    const size = css ?? job.fallback
    const vw = Math.ceil(cssPx(size.wMm))
    const vh = Math.ceil(cssPx(size.hMm))
    if (vw * scale > MAX_PX || vh * scale > MAX_PX) throw new BridgeError("INPUT_TOO_LARGE", `a page image would exceed ${MAX_PX} px`)
    if (!info.paged) return flowPages(dbg, job, size, css ? "css" : "fallback", info, scale)
    if (vw !== w0 || vh !== h0) {
      await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: vw, height: vh, deviceScaleFactor: scale, mobile: false })
    }
    const layout = readLayout(
      await evalValue(dbg, pageLayoutExpression({ phase: "layout", wMm: size.wMm, hMm: size.hMm, maxRects: MAX_PAGE_INDEX })),
    )
    const images: PagePngsResult["images"] = []
    for (const n of selectPages(Math.min(layout.pageCount, layout.rects.length), job.pages)) {
      const r = layout.rects[n - 1]
      if (r.w < 1 || r.h < 1 || r.w * scale > MAX_PX || r.h * scale > MAX_PX) {
        throw new BridgeError("RENDER_FAILED", `page ${n} has no usable size for an image`)
      }
      const shot = (await dbg.sendCommand("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: true,
        clip: { x: r.x, y: r.y, width: r.w, height: r.h, scale: 1 },
      })) as { data: string }
      const png = Buffer.from(shot.data, "base64")
      images.push({ n, png, ...pngSize(png) })
    }
    return {
      layout: layout.layout,
      media: "print",
      pageCount: layout.pageCount,
      pageSizeMm: size,
      pageSizeSource: css ? "css" : "fallback",
      images,
    }
  }
  return inWindow("check", w0, h0, job.html, job0, scale)
}

/**
 * Row 151c (DEFECT-157-1): a flow document (no Studio `.page` elements) as the printer lays it out: content at the
 * @page content width, cut at the content height (flowCut in PAGE_LAYOUT_SCRIPT), each cut drawn on a whole page in
 * the @page background at the margins. Printed fragmentation is estimated, so the result says `approximate` and why.
 */
async function flowPages(
  dbg: Debugger,
  job: PagePngsJob,
  size: { wMm: number; hMm: number },
  source: "css" | "fallback",
  info: ReturnType<typeof readSizeInfo>,
  scale: number,
): Promise<PagePngsResult> {
  const read = parseMargins(info.margins)
  const m = read ?? { top: 0, right: 0, bottom: 0, left: 0 }
  const cwMm = size.wMm - m.left - m.right
  const chMm = size.hMm - m.top - m.bottom
  if (!(cwMm >= 10 && chMm >= 10)) throw new BridgeError("RENDER_FAILED", "page margins leave no content area")
  // Same pixel size as a paged image of this sheet: Chromium truncates a fractional CSS clip, then scales.
  const W = Math.round(Math.trunc(cssPx(size.wMm)) * scale)
  const H = Math.round(Math.trunc(cssPx(size.hMm)) * scale)
  const cw = Math.round(cssPx(cwMm))
  const ch = cssPx(chMm)
  if (W > MAX_PX || H > MAX_PX) throw new BridgeError("INPUT_TOO_LARGE", `a page image would exceed ${MAX_PX} px`)
  const bg = backgroundRgb(info.background)
  await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width: cw, height: Math.ceil(ch), deviceScaleFactor: scale, mobile: false })
  // Studio prints `body{background:none}`; the page colour comes from @page. The cut is captured on a transparent
  // canvas and its alpha composited over the page colour in main (decodePngRgb); an opaque override was not honoured.
  await dbg.sendCommand("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } })
  const layout = readLayout(await evalValue(dbg, pageLayoutExpression({ phase: "flowcut", hMm: chMm, maxRects: MAX_PAGE_INDEX })))
  const images: PagePngsResult["images"] = []
  for (const n of selectPages(Math.min(layout.pageCount, layout.rects.length), job.pages)) {
    const r = layout.rects[n - 1]
    const h = Math.min(Math.max(1, r.h), ch)
    const shot = (await dbg.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: r.y, width: cw, height: h, scale: 1 },
    })) as { data: string }
    const content = decodePngRgb(Buffer.from(shot.data, "base64"), bg)
    const png = composePage({ width: W, height: H, bg, content, left: Math.round(cssPx(m.left) * scale), top: Math.round(cssPx(m.top) * scale) })
    images.push({ n, png, width: W, height: H })
  }
  return {
    layout: "flow",
    media: "print",
    pageCount: layout.pageCount,
    pageSizeMm: size,
    pageSizeSource: source,
    images,
    approximate: flowApproximation(info, read !== null),
  }
}

export function createElectronEngine(allowedFiles: ReadonlySet<string>, log: BridgeLog): PageEngine {
  configureRenderSession(allowedFiles, log)
  const raster = renderWebPreferences("raster")
  return {
    png: ({ html, width, height }) =>
      inWindow("raster", width, height, html, async (dbg) => {
        const shot = (await dbg.sendCommand("Page.captureScreenshot", {
          format: "png",
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        })) as { data: string }
        return Buffer.from(shot.data, "base64")
      }),
    pdf: ({ html, widthMm, heightMm, preferCSSPageSize }) =>
      inWindow("raster", Math.round((widthMm * 96) / MM_PER_INCH), Math.round((heightMm * 96) / MM_PER_INCH), html, async (_dbg, wc) => {
        // Electron 42 PrintToPDFOptions (electron.d.ts): pageSize {width,height} in inches; margins in inches and
        // each one defaults to 0.4 when left out (marginType is not read), so all four are set to 0 here.
        const out = await wc.printToPDF({
          printBackground: true,
          preferCSSPageSize,
          pageSize: { width: widthMm / MM_PER_INCH, height: heightMm / MM_PER_INCH },
          margins: { top: 0, bottom: 0, left: 0, right: 0 },
          displayHeaderFooter: false,
          landscape: false,
          scale: 1,
        })
        return out
      }),
    evaluate: ({ html, viewportWidth, viewportHeight, expression }) =>
      inWindow("check", viewportWidth, viewportHeight, html, async (dbg) => {
        const res = (await dbg.sendCommand("Runtime.evaluate", {
          expression,
          awaitPromise: true,
          returnByValue: true,
        })) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } }
        if (res.exceptionDetails) throw new BridgeError("RENDER_FAILED", "page script raised an exception")
        return res.result?.value ?? null
      }),
    pagePngs,
    info: (): EngineInfo => ({
      electron: process.versions.electron ?? "unknown",
      chrome: process.versions.chrome ?? "unknown",
      partition: RENDER_PARTITION,
      sandbox: raster.sandbox,
      contextIsolation: raster.contextIsolation,
      nodeIntegration: raster.nodeIntegration,
      javascriptContent: raster.javascript,
      network: "blocked",
    }),
  }
}
