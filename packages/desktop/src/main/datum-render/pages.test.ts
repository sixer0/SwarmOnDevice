import { describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { buildFontBundle, FONT_FILES } from "./fonts"
import { BridgeError } from "./protocol"
import { CONTENT_CSP, htmlWithFonts, RENDER_PARTITION, renderWebPreferences, svgMarkupForInline, svgPngPage, svgSizeMm } from "./pages"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

const FONTS = resolve(import.meta.dir, "../../../datum/datum-house-style/assets/fonts")

describe("render window settings", () => {
  test("raster window: sandbox, isolation, no node, JavaScript off, own partition", () => {
    const p = renderWebPreferences("raster")
    expect(p).toMatchObject({
      partition: RENDER_PARTITION,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      javascript: false,
      webSecurity: true,
      webviewTag: false,
    })
    expect(RENDER_PARTITION).toBe("datum-render")
  })

  test("check window keeps sandbox and no node; V8 on only for CDP evaluate", () => {
    const p = renderWebPreferences("check")
    expect(p).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true })
  })

  test("content CSP forbids scripts and every network source", () => {
    expect(CONTENT_CSP).toContain("script-src 'none'")
    expect(CONTENT_CSP).toContain("default-src 'none'")
    expect(CONTENT_CSP).toContain("connect-src 'none'")
    expect(CONTENT_CSP).not.toMatch(/https?:|file:/)
  })
})

describe("render pages", () => {
  test("svg size follows datum_render.py svg_size_mm", () => {
    expect(svgSizeMm('<svg width="166mm" height="100mm" viewBox="0 0 166 100">')).toEqual({ wMm: 166, hMm: 100 })
    expect(svgSizeMm('<svg viewBox="0 0 120 80">')).toEqual({ wMm: 120, hMm: 80 })
    expect(svgSizeMm("<svg>")).toEqual({ wMm: 166, hMm: 100 })
  })

  test("svg is inlined without its prologue; non-svg is refused", () => {
    const src = '<?xml version="1.0"?>\n<!-- c -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x">\n<svg viewBox="0 0 1 1"/>'
    expect(svgMarkupForInline(src)).toBe('<svg viewBox="0 0 1 1"/>')
    expect(() => svgMarkupForInline("<html></html>")).toThrow(BridgeError)
    const page = svgPngPage('<svg viewBox="0 0 1 1"/>', 300, 200, "/*fonts*/")
    expect(page).toContain("width:300px;height:200px")
    expect(page.indexOf("Content-Security-Policy")).toBeLessThan(page.indexOf("<svg"))
  })

  test("html keeps its own styles after the injected font block", () => {
    const out = htmlWithFonts('<!doctype html><html><head><style>@font-face{font-family:"T"}</style></head><body/></html>', "/*plex*/")
    expect(out.indexOf("/*plex*/")).toBeLessThan(out.indexOf('font-family:"T"'))
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("/*plex*/"))
    expect(htmlWithFonts("<p>x</p>", "F")).toStartWith("<head>")
    expect(htmlWithFonts("<!doctype html><p>x</p>", "F")).toStartWith("<!doctype html><head>")
  })

  test("font bundle: 16 bundled Plex files as data URLs, Condensed alias included", () => {
    expect(FONT_FILES.length).toBe(16)
    const b = buildFontBundle(FONTS)
    expect(b.files.length).toBe(16)
    expect(b.faceCount).toBe(20)
    expect(b.css).toContain('font-family:"IBM Plex Sans Cond"')
    expect(b.css).toContain('font-family:"IBM Plex Sans Condensed"')
    expect(b.css).toContain("font-weight:600 700")
    expect(b.css).not.toContain("file:")
    expect(b.files.every((f) => f.startsWith(FONTS) || f.endsWith(".ttf"))).toBe(true)
  })

  test("font bundle refuses a folder with missing files", () => {
    const empty = mkdtempSync(join(tmpdir(), "row24-nofonts-"))
    expect(() => buildFontBundle(empty)).toThrow("bundled fonts missing")
  })
})
