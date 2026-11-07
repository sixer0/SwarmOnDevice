// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2, decision U12): the main-process half of
// the document preview that the renderer shows inside the existing file tab
// (packages/app/src/pages/session/file-preview.tsx).
//
// 1. `mainWindowWebPreferences`: the main window keeps contextIsolation true, nodeIntegration false and sandbox true;
//    the only addition is `plugins: true`, which Chromium's built-in PDF viewer needs. No webviewTag (P5).
// 2. `previewFrameNavigationAllowed` + `wirePreviewFramePolicy`: the existing `will-navigate` policy only sees the
//    main frame, so a link inside a preview frame (a PDF link annotation, or an HTML link the sanitiser missed) would
//    navigate the frame itself. Sub-frame navigations are allowed only to inert, local schemes; anything else is
//    blocked and logged, so a click inside a preview neither leaves the app nor reaches the network (P6, P2).
//    New windows still go through the existing `setWindowOpenHandler` (windows.ts).
import type { WebContents, WebPreferences } from "electron"

export function mainWindowWebPreferences(preload: string) {
  return {
    preload,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    plugins: true,
  } satisfies WebPreferences
}

// The frame schemes a preview needs: the srcdoc/blob documents themselves and the internal schemes Chromium's PDF
// viewer runs in. Everything else (http, https, file, ftp, ws, data:, custom app schemes other than the renderer's
// own) is refused for sub-frames. data: is refused (decision C103, row 48 L3): a frame navigated to
// data:text/html would be a script-capable document inside the main window. data: images and fonts inside a
// preview are subresources, not frame navigations, and are not affected.
const PREVIEW_FRAME_SCHEMES = new Set(["about:", "blob:", "chrome-extension:", "chrome:"])

export function previewFrameNavigationAllowed(url: string, isRendererUrl: (url: string) => boolean) {
  if (isRendererUrl(url)) return true
  if (!URL.canParse(url)) return false
  const parsed = new URL(url)
  if (parsed.protocol === "blob:") {
    // A blob: URL carries its creator's origin; only the renderer's own blobs may load in a frame.
    const inner = url.slice("blob:".length)
    return URL.canParse(inner) && isRendererUrl(inner)
  }
  return PREVIEW_FRAME_SCHEMES.has(parsed.protocol)
}

type FrameNavigationEvent = { isMainFrame: boolean; url: string; preventDefault(): void }
type Log = (message: string, data: Record<string, unknown>) => void

/** Handles one `will-frame-navigate` event; exported for the unit test. Returns true when it blocked. */
export function handlePreviewFrameNavigation(
  event: FrameNavigationEvent,
  isRendererUrl: (url: string) => boolean,
  log: Log,
) {
  // Main-frame navigations stay with the existing will-navigate policy (windows.ts wireNavigationPolicy).
  if (event.isMainFrame) return false
  if (previewFrameNavigationAllowed(event.url, isRendererUrl)) return false
  event.preventDefault()
  log("blocked sub-frame navigation", { url: event.url.slice(0, 200) })
  return true
}

export function wirePreviewFramePolicy(contents: WebContents, isRendererUrl: (url: string) => boolean, log: Log) {
  contents.on("will-frame-navigate", (event) => {
    handlePreviewFrameNavigation(event, isRendererUrl, log)
  })
}
