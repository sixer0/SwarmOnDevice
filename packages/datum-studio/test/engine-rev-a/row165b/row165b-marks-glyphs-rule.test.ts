// Row 165B (C188; findings F113-1, F113-2, F113-8 of gateway_check/14_manual_judge_bundled.md).
// Renders the bundled Rev A cases 01 and 05 (row 143a fixtures) in process to HTML and DOCX and pins:
//  F113-1 (CP-29, ID p.38 Tabel 7.1): rail mark glyphs in HTML/PDF carry the mark colour (■ #101418, ◈ #B45309,
//          ◇ #6B7783), the same colours the DOCX rail already writes; the label keeps the rail colour.
//  F113-2 (CP-19): the derivation rule line (U+2500) renders in an embedded face. Plex Mono has no U+2500, so the
//          embedded DejaVu Sans @font-face must cover the Box Drawing block; otherwise Chromium falls back to a
//          system face (Menlo-Regular in the bundled PDFs).
//  F113-8 (CP-23, ID p.53 DT-13f): the DOCX Datum Rule lead grows with the sheet as the PDF lead does
//          (width x sheet / sheets, `datumRuleLeadMm`), instead of a fixed 9 mm on every chapter.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, unzipSync, unzlibSync } from "fflate"

const kit = await import("../row143a/_kit")

const CASES = ["case01.json", "case05.json"] as const

const rendered = new Map<string, { html: string; docx: Uint8Array }>()
async function render(name: (typeof CASES)[number]) {
  const hit = rendered.get(name)
  if (hit) return hit
  const snap = kit.compose(kit.loadCase(name))
  const out = { html: await kit.renderHtml(snap), docx: await kit.renderDocx(snap) }
  rendered.set(name, out)
  return out
}

const MARK_HEX: Record<string, string> = { TERUKUR: "#101418", DITURUNKAN: "#b45309", PEMASOK: "#6b7783", ASUMSI: "#9b1c1c" }

/** `<span class="st-rail-glyph ..." style="..." data-mark="X">` in document order. */
function railGlyphSpans(html: string): Array<{ mark: string; style: string; tag: string }> {
  const out: Array<{ mark: string; style: string; tag: string }> = []
  for (const m of html.matchAll(/<span\b[^>]*\bclass="[^"]*\bst-rail-glyph\b[^"]*"[^>]*>/g)) {
    const tag = m[0]
    out.push({ mark: /data-mark="([A-Z]+)"/.exec(tag)?.[1] ?? "", style: /style="([^"]*)"/.exec(tag)?.[1] ?? "", tag })
  }
  return out
}

function colourOf(style: string): string | undefined {
  return /(?:^|;)\s*color:\s*(#[0-9a-fA-F]{6})/.exec(style)?.[1]?.toLowerCase()
}

describe("row 165B F113-1: HTML/PDF rail glyph colours as the DOCX rail", () => {
  for (const name of CASES) {
    test(`${name}: every rail glyph carries its mark colour`, async () => {
      const { html } = await render(name)
      const spans = railGlyphSpans(html)
      expect(spans.length).toBeGreaterThan(0)
      for (const s of spans) expect({ mark: s.mark, colour: colourOf(s.style) }).toEqual({ mark: s.mark, colour: MARK_HEX[s.mark] })
    })

    test(`${name}: DOCX rail glyph colours are the same per mark (parity source)`, async () => {
      const { docx } = await render(name)
      const xml = kit.docXml(docx)
      const glyphs: Record<string, string> = { "■": "TERUKUR", "◈": "DITURUNKAN", "◇": "PEMASOK", "△": "ASUMSI" }
      const seen = new Set<string>()
      // Rail glyph runs: DejaVu Sans run whose text is exactly one mark glyph, followed by a label run " <label>".
      for (const m of xml.matchAll(/<w:r>(?:(?!<\/w:r>).)*?<w:t[^>]*>([■◈◇△])<\/w:t><\/w:r><w:r>(?:(?!<\/w:r>).)*?<w:t[^>]*> [A-Z]/gs)) {
        const run = m[0].slice(0, m[0].indexOf("</w:r>"))
        const c = /<w:color w:val="([0-9A-Fa-f]{6})"/.exec(run)?.[1]
        expect(`#${(c ?? "").toLowerCase()}`).toBe(MARK_HEX[glyphs[m[1]]])
        seen.add(m[1])
      }
      expect(seen.size).toBeGreaterThan(0)
    })
  }
})

/** unicode-range of every @font-face whose family is DejaVu Sans. */
function dejavuRanges(html: string): string[] {
  const out: string[] = []
  for (const m of html.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    if (!/font-family:\s*["']?DejaVu Sans["']?\s*[;}]/.test(m[1] + ";")) continue
    out.push(/unicode-range:\s*([^;}]*)/.exec(m[1])?.[1] ?? "")
  }
  return out
}

function covers(range: string, cp: number): boolean {
  if (range === "") return true // no unicode-range = the whole face
  return range.split(",").some((part) => {
    const r = /U\+([0-9A-F]+)(?:-([0-9A-F]+))?/i.exec(part.trim())
    if (!r) return false
    const a = parseInt(r[1], 16)
    const b = r[2] ? parseInt(r[2], 16) : a
    return cp >= a && cp <= b
  })
}

describe("row 165B F113-2: the U+2500 derivation rule line has an embedded face", () => {
  for (const name of CASES) {
    test(`${name}: the document prints U+2500 and the embedded DejaVu Sans covers it`, async () => {
      const { html } = await render(name)
      const body = html.slice(html.indexOf("<body"))
      expect(body.includes("─")).toBe(true)
      const ranges = dejavuRanges(html)
      expect(ranges.length).toBeGreaterThan(0)
      expect(ranges.every((r) => covers(r, 0x2500))).toBe(true)
    })
  }

  test("the embedded DejaVu Sans file has a glyph for U+2500 and Plex Mono has none (why the range matters)", () => {
    const fonts = path.resolve(import.meta.dir, "..", "..", "..", "vendor", "src", "lib", "studio", "assets", "fonts")
    expect(cmapHas(readFileSync(path.join(fonts, "DejaVuSans.ttf")), 0x2500)).toBe(true)
    expect(cmapHas(readFileSync(path.join(fonts, "IBMPlexMono-Regular.ttf")), 0x2500)).toBe(false)
  })
})

/** cmap format 4 lookup (enough for the BMP code points tested here). */
function cmapHas(d: Uint8Array, cp: number): boolean {
  const v = new DataView(d.buffer, d.byteOffset, d.byteLength)
  const n = v.getUint16(4)
  let off = -1
  for (let i = 0; i < n; i++) {
    const tag = String.fromCharCode(...d.subarray(12 + 16 * i, 16 + 16 * i))
    if (tag === "cmap") off = v.getUint32(12 + 16 * i + 8)
  }
  if (off < 0) return false
  const nt = v.getUint16(off + 2)
  for (let i = 0; i < nt; i++) {
    const o = off + v.getUint32(off + 4 + 8 * i + 4)
    if (v.getUint16(o) !== 4) continue
    const seg = v.getUint16(o + 6) / 2
    for (let s = 0; s < seg; s++) {
      const end = v.getUint16(o + 14 + 2 * s)
      const start = v.getUint16(o + 16 + 2 * seg + 2 * s)
      if (cp >= start && cp <= end) {
        const delta = v.getInt16(o + 16 + 4 * seg + 2 * s)
        const ro = o + 16 + 6 * seg + 2 * s
        const rangeOffset = v.getUint16(ro)
        const gid = rangeOffset === 0 ? (cp + delta) & 0xffff : v.getUint16(ro + rangeOffset + 2 * (cp - start))
        return gid !== 0
      }
    }
  }
  return false
}

// ── F113-8 ───────────────────────────────────────────────────────────────

const PX_PER_MM = 600 / 25.4

/** Decode an 8-bit RGBA PNG with filter 0 rows (the engine's own encoder, `encodePngRgba`). */
function decodeRule(png: Uint8Array): { w: number; h: number; leadPx: number } {
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength)
  let o = 8
  let w = 0
  let h = 0
  const idat: Uint8Array[] = []
  while (o < png.length) {
    const len = v.getUint32(o)
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8))
    const data = png.subarray(o + 8, o + 8 + len)
    if (type === "IHDR") {
      w = v.getUint32(o + 8)
      h = v.getUint32(o + 12)
    } else if (type === "IDAT") idat.push(data)
    o += 12 + len
  }
  const all = new Uint8Array(idat.reduce((a, b) => a + b.length, 0))
  let p = 0
  for (const c of idat) {
    all.set(c, p)
    p += c.length
  }
  const raw = unzlibSync(all)
  const stride = w * 4 + 1
  const row = 12 // inside the lead band (rows 6-18), below the baseline (rows 0-5)
  expect(raw[row * stride]).toBe(0)
  let leadPx = 0
  while (leadPx < w && raw[row * stride + 1 + leadPx * 4 + 3] === 255) leadPx++
  return { w, h, leadPx }
}

/** Datum Rule drawings of the DOCX body in document order: width (mm) and lead (mm) read from the PNG pixels. */
function docxRules(docx: Uint8Array): Array<{ widthMm: number; leadMm: number; target: string }> {
  const files = unzipSync(docx)
  const xml = strFromU8(files["word/document.xml"])
  const rels = strFromU8(files["word/_rels/document.xml.rels"])
  const out: Array<{ widthMm: number; leadMm: number; target: string }> = []
  for (const m of xml.matchAll(/<w:drawing>[\s\S]*?<\/w:drawing>/g)) {
    if (!/<wp:docPr\b[^>]*(?:name|descr)="[^"]*Datum Rule/.test(m[0])) continue
    const rid = /r:embed="([^"]+)"/.exec(m[0])?.[1]
    const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(rels)?.[1] ?? new RegExp(`Target="([^"]+)"[^>]*Id="${rid}"`).exec(rels)?.[1]
    const png = files[`word/${target}`]
    expect(png).toBeDefined()
    const r = decodeRule(png)
    out.push({ widthMm: r.w / PX_PER_MM, leadMm: r.leadPx / PX_PER_MM, target: target ?? "" })
  }
  return out
}

/** HTML Datum Rules in document order: viewBox width and the lead x2 the shell set. */
function htmlRules(html: string): Array<{ widthMm: number; leadMm: number }> {
  const out: Array<{ widthMm: number; leadMm: number }> = []
  for (const m of html.matchAll(/<svg class="st-datum-rule"[^>]*\bviewBox="0 0 ([0-9.]+) [0-9.]+"[^>]*>([\s\S]*?)<\/svg>/g)) {
    const x2 = /<line data-st-lead="1"[^>]*\bx2="([0-9.]+)"/.exec(m[2])?.[1]
    out.push({ widthMm: Number(m[1]), leadMm: Number(x2) })
  }
  return out
}

describe("row 165B F113-8: DOCX Datum Rule lead grows with the sheet as the PDF lead", () => {
  for (const name of CASES) {
    test(`${name}: DOCX leads equal the HTML/PDF leads rule by rule`, async () => {
      const { html, docx } = await render(name)
      const d = docxRules(docx)
      const h = htmlRules(html)
      expect(d.length).toBeGreaterThan(1)
      expect(d.length).toBe(h.length)
      d.forEach((r, i) => {
        expect(Math.abs(r.widthMm - h[i].widthMm)).toBeLessThan(0.1)
        // one 600 dpi pixel is 0.042 mm; the tick at a pitch multiple may join the lead (5 px = 0.21 mm)
        expect(Math.abs(r.leadMm - h[i].leadMm)).toBeLessThan(0.3)
      })
    })

    test(`${name}: chapter leads are not one fixed length and grow monotonically`, async () => {
      const { docx } = await render(name)
      const d = docxRules(docx)
      const fractions = d.map((r) => r.leadMm / r.widthMm)
      for (let i = 1; i < fractions.length; i++) expect(fractions[i]).toBeGreaterThan(fractions[i - 1])
      expect(fractions[fractions.length - 1]).toBeGreaterThan(0.99)
    })
  }
})
