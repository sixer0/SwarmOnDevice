// DATUM render bridge: the Electron page engine (row 24, runtime spec §3.2, §3.6; prereview M6).
//
// A fresh hidden BrowserWindow per job in the in-memory session partition "datum-render", driven
// through webContents.debugger (CDP), the same calls Playwright issues for screenshot/evaluate:
//   png       Emulation.setDeviceMetricsOverride + Page.captureScreenshot
//   pdf       webContents.printToPDF (paper in inches, margins 0, printBackground, preferCSSPageSize, no header/footer).
//             Not CDP Page.printToPDF: Electron 42's webContents.debugger answers "'Page.printToPDF' wasn't
//             found" (row 55 F55-1); Electron's own API prints the same Chromium page (row 24a).
//   checkPage Runtime.evaluate of an allow-listed fixed script
// Content is set with Page.setDocumentContent on about:blank (setContent-equivalent): no goto, no
// file:// document. Every request except data:, about:blank and the allowed font/input files is
// cancelled, navigation and new windows are refused, permissions and downloads are denied.

import { BrowserWindow, session, type Debugger, type Session, type WebContents } from "electron"
import { BridgeError } from "./protocol"
import type { EngineInfo, PageEngine } from "./dispatch"
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

async function inWindow<T>(kind: WindowKind, width: number, height: number, html: string, job: Job<T>): Promise<T> {
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
    await dbg.sendCommand("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false })
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
