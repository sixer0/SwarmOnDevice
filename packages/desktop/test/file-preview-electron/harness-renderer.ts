// Row 112: the renderer half of the bare-Electron harness. It builds the two preview frames exactly as
// packages/app/src/pages/session/file-preview.tsx does (same policy functions, same attributes), inside a page served
// from the app's own `oc://renderer` origin under the app's own renderer CSP.
import {
  buildHtmlPreviewDocument,
  countPdfPages,
  createPdfObjectUrl,
  PREVIEW_HTML_SANDBOX,
} from "../../../app/src/pages/session/file-preview-policy"

let pdf: { url: string; revoke(): void } | undefined

function bytesOf(base64: string) {
  const raw = atob(base64)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function frame(slot: string) {
  const el = document.createElement("iframe")
  el.setAttribute("data-slot", slot)
  el.setAttribute("referrerpolicy", "no-referrer")
  el.style.cssText = "display:block;width:900px;height:700px;border:0"
  return el
}

;(window as any).__preview = {
  openPdf(base64: string) {
    const bytes = bytesOf(base64)
    pdf = createPdfObjectUrl(bytes)
    const el = frame("file-preview-pdf")
    el.setAttribute("data-page-count", String(countPdfPages(bytes)))
    el.src = pdf.url
    document.body.append(el)
    return { url: pdf.url, pages: countPdfPages(bytes) }
  },
  closePdf() {
    document.querySelector('[data-slot="file-preview-pdf"]')?.remove()
    pdf?.revoke()
  },
  async blobReadable(url: string) {
    try {
      const response = await fetch(url)
      return response.ok
    } catch {
      return false
    }
  },
  openHtml(html: string, raw = false) {
    const el = frame(raw ? "raw-sandbox-only" : "file-preview-html")
    el.setAttribute("sandbox", PREVIEW_HTML_SANDBOX)
    el.srcdoc = raw ? html : buildHtmlPreviewDocument(html)
    document.body.append(el)
    return el.srcdoc.length
  },
  frameRect(slot: string) {
    const r = document.querySelector(`[data-slot="${slot}"]`)?.getBoundingClientRect()
    return r ? { x: r.x, y: r.y } : null
  },
  navigateFrame(slot: string, url: string) {
    const el = document.querySelector<HTMLIFrameElement>(`[data-slot="${slot}"]`)
    if (!el) return
    // srcdoc wins over src, so drop it first to make the frame really navigate.
    el.removeAttribute("srcdoc")
    el.src = url
  },
  srcdocFacts(slot: string) {
    const el = document.querySelector<HTMLIFrameElement>(`[data-slot="${slot}"]`)
    if (!el) return null
    const doc = new DOMParser().parseFromString(el.srcdoc, "text/html")
    return {
      sandbox: el.getAttribute("sandbox"),
      csp: doc.head.firstElementChild?.getAttribute("http-equiv") === "Content-Security-Policy" ? doc.head.firstElementChild.getAttribute("content") : null,
      scripts: doc.querySelectorAll("script").length,
      linkHref: doc.getElementById("row112-link")?.getAttribute("href") ?? null,
      linkText: doc.getElementById("row112-link")?.textContent ?? null,
      remote: /example\.invalid|127\.0\.0\.1/.test(el.srcdoc),
      text: (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    }
  },
}
document.title = "harness"
