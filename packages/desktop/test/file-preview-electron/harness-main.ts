// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2): a bare-Electron harness (the repo's own
// Electron 42.3.3 binary, a fixture userData, never the Swarm app and never real user data) that proves in Chromium
// what happy-dom cannot:
//   P1 a Studio PDF (Chromium printToPDF of a real Studio HTML output, the bridge's own `pdf` op) loads in Chromium's
//      built-in viewer from a renderer `blob:` URL, with `plugins: true` and the viewer's page count read back;
//   P2 an HTML output with `<script>document.title='x'</script>` previews with the script not run and 0 network
//      requests in the webRequest log;
//   P5 the window is built from mainWindowWebPreferences (the function windows.ts uses);
//   P6 a click on a link inside the HTML preview, and a programmatic navigation of a preview frame, neither navigate
//      the app nor open a window nor reach the network (wirePreviewFramePolicy, the function windows.ts uses);
//   P7 after closing, the blob URL no longer resolves.
// Results go to $ROW112_WORK/result.json; the bun test next to this file asserts them.
import { app, BrowserWindow, net, protocol, session, type WebFrameMain } from "electron"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { mainWindowWebPreferences, wirePreviewFramePolicy } from "../../src/main/preview-policy"
import { countPdfPages } from "../../../app/src/pages/session/file-preview-policy"

// Never touch the macOS keychain from a fixture HOME (controller rule, driver_rules.md); also passed on the command line.
app.commandLine.appendSwitch("use-mock-keychain")

const work = process.env.ROW112_WORK
if (!work) throw new Error("ROW112_WORK is required")
const studioHtml = process.env.ROW112_STUDIO_HTML ?? join(work, "studio.html")
mkdirSync(join(work, "userData"), { recursive: true })
app.setPath("userData", join(work, "userData"))

protocol.registerSchemesAsPrivileged([
  { scheme: "oc", privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true } },
])
const isRendererUrl = (url: string) =>
  URL.canParse(url) && new URL(url).protocol === "oc:" && new URL(url).host === "renderer"

const PDF_EXTENSION = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai"
const result: Record<string, unknown> = { electron: process.versions.electron, chrome: process.versions.chrome }
const requests: { phase: string; url: string; type: string }[] = []
const blocked: { phase: string; message: string; url: unknown }[] = []
const navigations: { phase: string; kind: string; url: string }[] = []
let phase = "start"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const watchdog = setTimeout(() => {
  result.error = "watchdog timeout"
  finish(2)
}, 90_000)

function finish(code: number) {
  clearTimeout(watchdog)
  result.requests = requests
  result.blocked = blocked
  result.navigations = navigations
  writeFileSync(join(work!, "result.json"), JSON.stringify(result, null, 2))
  app.exit(code)
  // app.exit can stall while a load is still pending; the result is already on disk.
  setTimeout(() => process.exit(code), 1500).unref()
}

function frames(win: BrowserWindow) {
  return win.webContents.mainFrame.framesInSubtree.map((f) => ({ url: f.url, origin: f.origin, name: f.name }))
}

async function inFrame(frame: WebFrameMain | undefined, code: string) {
  if (!frame) return { error: "no frame" }
  try {
    return { value: await frame.executeJavaScript(code) }
  } catch (error) {
    return { error: String(error) }
  }
}

const HOSTILE = `<meta http-equiv="refresh" content="1;url=https://example.invalid/refresh">
<link rel="stylesheet" href="https://example.invalid/s.css"><link rel="dns-prefetch" href="//prefetch.example.invalid">
<script>document.title='x';fetch('http://127.0.0.1:9/ran').catch(()=>{})</script>
<a id="row112-link" href="https://example.invalid/clicked" style="display:block;position:fixed;left:0;top:0;width:400px;height:120px;font-size:48px;background:#fc0;z-index:99">CLICK</a>
<img src="http://127.0.0.1:9/pixel.png"><iframe src="https://example.invalid/frame"></iframe>`

app.whenReady().then(async () => {
  try {
    const served: unknown[] = []
    result.served = served
    protocol.handle("oc", (request) => {
      try {
        const url = new URL(request.url)
        if (url.host !== "renderer") return new Response("Not found", { status: 404 })
        const name = basename(url.pathname) || "index.html"
        const type = name.endsWith(".js") ? "text/javascript" : "text/html"
        served.push({ name, type })
        // As windows.ts serves the renderer: net.fetch of the file URL.
        return net.fetch(pathToFileURL(join(work!, "renderer", name)).toString())
      } catch (error) {
        served.push({ error: String(error) })
        return new Response("error", { status: 500 })
      }
    })

    // 2. The preview window: the main window's prefs and navigation wiring, the app's renderer origin and CSP.
    phase = "load"
    const rendererFiles = pathToFileURL(join(work, "renderer")).toString() + "/"
    result.rendererFiles = rendererFiles
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      requests.push({ phase, url: details.url.slice(0, 200), type: details.resourceType })
      const scheme = URL.canParse(details.url) ? new URL(details.url).protocol : "?"
      // The renderer's own files (served through net.fetch) are the only file: URLs let through.
      const ownFile = details.url.startsWith(rendererFiles)
      callback({ cancel: !ownFile && !["oc:", "blob:", "data:", "chrome-extension:", "chrome:", "about:"].includes(scheme) })
    })
    const prefs = mainWindowWebPreferences(join(work, "renderer", "preload.js"))
    result.prefs = { ...prefs }
    const win = new BrowserWindow({ show: false, width: 1000, height: 820, paintWhenInitiallyHidden: true, webPreferences: prefs })
    result.effectivePrefs = (win.webContents as any).getLastWebPreferences?.() ?? null
    win.webContents.setWindowOpenHandler(({ url }) => {
      navigations.push({ phase, kind: "window-open", url })
      return { action: "deny" }
    })
    win.webContents.on("will-navigate", (event, url) => {
      navigations.push({ phase, kind: "will-navigate", url })
      if (!isRendererUrl(url)) event.preventDefault()
    })
    win.webContents.on("did-frame-navigate", (_e, url, _code, _status, isMainFrame) => {
      navigations.push({ phase, kind: isMainFrame ? "did-navigate-main" : "did-navigate-frame", url: url.slice(0, 120) })
    })
    win.webContents.on("will-frame-navigate", (e) => {
      navigations.push({ phase, kind: `will-frame-navigate main=${e.isMainFrame}`, url: String(e.url).slice(0, 120) })
    })
    win.webContents.on("did-start-navigation", (e) => {
      navigations.push({ phase, kind: `did-start-navigation main=${e.isMainFrame}`, url: String(e.url).slice(0, 120) })
    })
    win.webContents.on("render-process-gone", (_e, details) => {
      navigations.push({ phase, kind: `render-process-gone ${details.reason}`, url: "" })
    })
    win.webContents.on("did-fail-load", (_e, code, description, url, isMainFrame) => {
      navigations.push({ phase, kind: `did-fail-load ${code} ${description} main=${isMainFrame}`, url: url.slice(0, 120) })
    })
    wirePreviewFramePolicy(win.webContents, isRendererUrl, (message, data) =>
      blocked.push({ phase, message, url: data.url }),
    )
    await win.loadURL("oc://renderer/index.html")
    const mainUrl = win.webContents.getURL()

    // A Studio PDF: Chromium's printToPDF of a real Studio HTML output, in its own partition (file:// allowed there).
    phase = "print"
    const printer = new BrowserWindow({
      show: false,
      webPreferences: { partition: "row112-print", sandbox: true, javascript: false },
    })
    await printer.loadFile(studioHtml)
    const pdf = await printer.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true })
    printer.destroy()
    writeFileSync(join(work, "studio.pdf"), pdf)
    result.pdf = { bytes: pdf.length, head: pdf.subarray(0, 5).toString("latin1"), pages: countPdfPages(pdf) }


    // P1: the PDF in Chromium's viewer.
    phase = "pdf"
    const opened = await win.webContents.executeJavaScript(`__preview.openPdf(${JSON.stringify(pdf.toString("base64"))})`)
    let lastBlob: string = opened.url
    let viewer: WebFrameMain | undefined
    for (let i = 0; i < 40 && !viewer; i++) {
      await sleep(250)
      viewer = win.webContents.mainFrame.framesInSubtree.find((f) => f.origin === PDF_EXTENSION)
    }
    await sleep(2500)
    const pageCountScript = `(() => {
      const seen = new Set(); const found = [];
      const walk = (root) => { if (!root || seen.has(root)) return; seen.add(root);
        for (const el of root.querySelectorAll('*')) {
          for (const k of ['docLength', 'docLength_', 'pageCount']) if (typeof el[k] === 'number') found.push({ tag: el.localName, key: k, value: el[k] });
          if (el.shadowRoot) walk(el.shadowRoot);
        } };
      walk(document);
      const input = (() => { const q = []; const w = (r) => { for (const el of r.querySelectorAll('*')) { if (el.id === 'pageSelector' || el.localName === 'viewer-page-selector') q.push({ tag: el.localName, text: (el.shadowRoot?.textContent || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60) }); if (el.shadowRoot) w(el.shadowRoot); } }; w(document); return q; })();
      return { found, input, title: document.title };
    })()`
    result.pdfPreview = {
      opened,
      frames: frames(win),
      viewerFrame: viewer ? { url: viewer.url, origin: viewer.origin } : null,
      viewerPageCount: await inFrame(viewer, pageCountScript),
      blobReadableBeforeClose: await win.webContents.executeJavaScript(`__preview.blobReadable(${JSON.stringify(opened.url)})`),
    }
    const shot = await win.webContents.capturePage()
    writeFileSync(join(work, "pdf-preview.png"), shot.toPNG())
    result.pdfScreenshot = { path: join(work, "pdf-preview.png"), empty: shot.isEmpty(), size: shot.getSize() }

    // P1 again on a multi-page PDF printed from a Studio-shaped page (the real Studio sample is one page).
    if (process.env.ROW112_MULTIPAGE_HTML) {
      phase = "pdf-multipage"
      const printer2 = new BrowserWindow({ show: false, webPreferences: { partition: "row112-print", sandbox: true, javascript: false } })
      await printer2.loadFile(process.env.ROW112_MULTIPAGE_HTML)
      const pdf2 = await printer2.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true })
      printer2.destroy()
      writeFileSync(join(work, "multipage.pdf"), pdf2)
      await win.webContents.executeJavaScript(`__preview.closePdf()`)
      const opened2 = await win.webContents.executeJavaScript(`__preview.openPdf(${JSON.stringify(pdf2.toString("base64"))})`)
      let viewer2: WebFrameMain | undefined
      for (let i = 0; i < 40 && !viewer2; i++) {
        await sleep(250)
        viewer2 = win.webContents.mainFrame.framesInSubtree.find((f) => f.origin === PDF_EXTENSION)
      }
      await sleep(2500)
      result.multipage = { pages: countPdfPages(pdf2), opened: opened2, viewerPageCount: await inFrame(viewer2, pageCountScript) }
      const shot2 = await win.webContents.capturePage()
      writeFileSync(join(work, "pdf-multipage.png"), shot2.toPNG())
      result.multipage = { ...(result.multipage as object), firstBlobReadableAfterReplace: await win.webContents.executeJavaScript(`__preview.blobReadable(${JSON.stringify(opened.url)})`) }
      lastBlob = opened2.url
    }

    // P6 on the PDF frame: a navigation of the preview frame to the web is refused before any request.
    phase = "pdf-nav"
    await win.webContents.executeJavaScript(`__preview.navigateFrame("file-preview-pdf", "https://example.invalid/from-pdf")`)
    await sleep(1000)

    // P7: closing revokes the URL.
    phase = "pdf-close"
    await win.webContents.executeJavaScript(`__preview.closePdf()`)
    result.blobReadableAfterClose = await win.webContents.executeJavaScript(
      `__preview.blobReadable(${JSON.stringify(lastBlob)})`,
    )

    // P2: the HTML preview of the real Studio HTML with the hostile additions.
    phase = "html"
    const studio = readFileSync(studioHtml, "utf8")
    const hostile = studio.replace(/<body([^>]*)>/i, (m) => `${m}${HOSTILE}`).replace(/<head>/i, `<head>${HOSTILE}`)
    await win.webContents.executeJavaScript(`__preview.openHtml(${JSON.stringify(hostile)})`)
    await sleep(2500)
    const htmlFrame = win.webContents.mainFrame.framesInSubtree.find((f) => f !== win.webContents.mainFrame && f.url === "about:srcdoc")
    result.htmlPreview = {
      frames: frames(win),
      frameTitle: await inFrame(htmlFrame, "document.title"),
      frameScripts: await inFrame(htmlFrame, "document.scripts.length"),
      frameText: await inFrame(htmlFrame, "document.body && document.body.innerText.slice(0, 80)"),
      frameCsp: await inFrame(htmlFrame, `document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content`),
      linkHref: await inFrame(htmlFrame, `document.getElementById('row112-link')?.getAttribute('href') ?? null`),
      srcdoc: await win.webContents.executeJavaScript(`__preview.srcdocFacts("file-preview-html")`),
      appTitle: await win.webContents.executeJavaScript("document.title"),
    }

    // P6: a real mouse click on the link's text inside the HTML frame.
    phase = "html-click"
    const rect = await win.webContents.executeJavaScript(`__preview.frameRect("file-preview-html")`)
    if (rect) {
      const x = Math.round(rect.x + 60)
      const y = Math.round(rect.y + 40)
      win.webContents.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 })
      win.webContents.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 })
      result.click = { x, y }
    }
    await sleep(1500)
    phase = "html-nav"
    await win.webContents.executeJavaScript(`__preview.navigateFrame("file-preview-html", "https://example.invalid/from-html")`)
    await sleep(1000)
    result.mainUrlBefore = mainUrl
    result.mainUrlAfter = win.webContents.getURL()
    result.windowsAfter = BrowserWindow.getAllWindows().length

    // Contrast (not a shipped path): sandbox="" alone, without the sanitiser and the CSP, on the same hostile HTML.
    phase = "contrast-sandbox-only"
    await win.webContents.executeJavaScript(`__preview.openHtml(${JSON.stringify(hostile)}, true)`)
    await sleep(2500)
    const raw = win.webContents.mainFrame.framesInSubtree.filter((f) => f.url === "about:srcdoc").at(-1)
    result.contrast = { frameTitle: await inFrame(raw, "document.title") }

    phase = "done"
    finish(0)
  } catch (error) {
    result.error = String(error instanceof Error ? error.stack : error)
    finish(1)
  }
})
