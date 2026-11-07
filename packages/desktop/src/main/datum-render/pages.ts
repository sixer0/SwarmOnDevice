// DATUM render bridge: page builders and window settings (row 24). Pure; no Electron import.
//
// png/pdf of an SVG: the SVG markup is inlined into <body> with the Plex @font-face block (an SVG
// loaded as <img> cannot see the page's @font-face, runtime spec §3.2 "Fonts on this path").
// pdf/checkPage of an HTML file: the HTML is loaded as is, with the font block and a CSP meta
// prepended so the document's own @font-face rules (Studio rasterFontCss) still win.

import { BridgeError } from "./protocol"

export const RENDER_PARTITION = "datum-render"

/** Content may load only data: images, fonts and styles; no script, no connect, no frames. */
export const CONTENT_CSP =
  "default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline' data:; script-src 'none'; " +
  "connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

export type WindowKind = "raster" | "check"

/**
 * webPreferences of the hidden render window. Raster (png/pdf) pages run with JavaScript off.
 * checkPage needs CDP Runtime.evaluate, so its window keeps the V8 engine on but page script
 * execution is disabled through CDP Emulation.setScriptExecutionDisabled before the content is set,
 * and the CSP above forbids every script source (prereview M6).
 */
export function renderWebPreferences(kind: WindowKind) {
  return {
    partition: RENDER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    javascript: kind === "check",
    webviewTag: false,
    plugins: false,
    experimentalFeatures: false,
    spellcheck: false,
    backgroundThrottling: false,
    offscreen: false,
    enableWebSQL: false,
    navigateOnDragDrop: false,
    autoplayPolicy: "document-user-activation-required" as const,
    disableDialogs: true,
    images: true,
  }
}

function escapeAttr(s: string) {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

function head(fontCss: string, extraCss: string) {
  return (
    `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttr(CONTENT_CSP)}">` +
    `<style data-datum-fonts>${fontCss}</style>` +
    (extraCss ? `<style data-datum-page>${extraCss}</style>` : "")
  )
}

/** Strip the XML prologue and doctype so the markup can be inlined in HTML. */
export function svgMarkupForInline(svgSource: string): string {
  let s = svgSource.replace(/^﻿/, "").trimStart()
  const prologue = /^(<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>)/i
  for (let m = prologue.exec(s); m; m = prologue.exec(s)) s = s.slice(m[0].length).trimStart()
  if (!/^<svg[\s>]/i.test(s)) throw new BridgeError("SVG_INVALID", "src does not start with an <svg> root element")
  return s
}

/** Same rule as datum_render.py svg_size_mm (render.py:36-48): mm attributes, else viewBox as mm, else 166x100. */
export function svgSizeMm(svgSource: string): { wMm: number; hMm: number } {
  const headText = svgSource.slice(0, 2048)
  const w = /\bwidth="([0-9.]+)mm"/.exec(headText)
  const h = /\bheight="([0-9.]+)mm"/.exec(headText)
  if (w && h) return { wMm: parseFloat(w[1]), hMm: parseFloat(h[1]) }
  const vb = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/.exec(headText)
  if (vb) return { wMm: parseFloat(vb[1]), hMm: parseFloat(vb[2]) }
  return { wMm: 166, hMm: 100 }
}

export function svgPngPage(svgSource: string, widthPx: number, heightPx: number, fontCss: string) {
  const css =
    `html,body{margin:0;padding:0;background:#fff;overflow:hidden}` +
    `body>svg{display:block;width:${widthPx}px;height:${heightPx}px}`
  return `<!doctype html><html><head>${head(fontCss, css)}</head><body>${svgMarkupForInline(svgSource)}</body></html>`
}

export function svgPdfPage(svgSource: string, wMm: number, hMm: number, fontCss: string) {
  const css =
    `@page{size:${wMm}mm ${hMm}mm;margin:0}html,body{margin:0;padding:0;background:#fff}` +
    `body>svg{display:block;width:${wMm}mm;height:${hMm}mm}`
  return `<!doctype html><html><head>${head(fontCss, css)}</head><body>${svgMarkupForInline(svgSource)}</body></html>`
}

/** Prepend the CSP meta and font block to an HTML document, before any of its own head content. */
export function htmlWithFonts(html: string, fontCss: string) {
  const block = head(fontCss, "")
  const headTag = /<head(\s[^>]*)?>/i.exec(html)
  if (headTag) {
    const at = headTag.index + headTag[0].length
    return html.slice(0, at) + block + html.slice(at)
  }
  const htmlTag = /<html(\s[^>]*)?>/i.exec(html)
  if (htmlTag) {
    const at = htmlTag.index + htmlTag[0].length
    return html.slice(0, at) + `<head>${block}</head>` + html.slice(at)
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype[0] + `<head>${block}</head>` + html.slice(doctype[0].length)
  return `<head>${block}</head>` + html
}

export const PX_PER_MM = 96 / 25.4
export const mmToPx = (mm: number) => Math.max(1, Math.round(mm * PX_PER_MM))
export const MM_PER_INCH = 25.4
