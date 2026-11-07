// Row 165J (decision C197; findings of verification/25_row165h_recheck.md): fixes of the row 165H recheck.
// - F165H-1 (DATUM-15): the control-sheet method statement is set at the body text measure (--col), not across the
//   136.9 mm span. The measured DATUM-15 result (real Chromium) is in test/verify-gate-e2e/row165j-datum15-e2e.test.ts.
// - F165H-2: every text line of a hatched node has a paper ground inside the node (no hatch line through a glyph).
// - F165H-3: the PDF/HTML signature line is a CSS border (vector), not a gradient background (printed as a raster).
// - F165H-4: the cover control block, the DOCX foot and the HTML/PDF foot print one number, meta.docNumber.
// - F165H-5: the studio_render reply text names the delivered title name of each output (untrusted block only).
// In process: no network, no model, no browser.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { strFromU8, unzipSync } from "fflate"

const K = await import("../row165a/_kit")
const PKG = K.PKG
const ENGINE = path.join(PKG, "vendor", "src", "lib", "studio", "engine")
const elk = await import(path.join(ENGINE, "diagram", "elk", "index.ts"))
const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"))
const tokens = await import(path.join(ENGINE, "diagram", "core", "tokens.ts"))
const colour = await import(path.join(ENGINE, "lint", "render", "colour.ts"))

const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]))

describe("F165H-1: method statement at the body measure", () => {
  test("case 05 and B-FIX HTML: the method paragraph is st-method and st-method is capped at max-width var(--col)", async () => {
    for (const name of ["case05.json", "bfix-datum-kanonik-ID.studio.json"] as const) {
      const html = await K.renderHtml(K.compose(K.loadCase(name)))
      expect(html).toMatch(/<p class="st-p st-method[^"]*"[^>]*data-role="controlSheet\.methodStatement"/)
      expect(html).toContain(".st-method,body.st-doc .st-unit.st-unit-controlSheet .st-p.st-method{max-width:var(--col)}")
      expect(html).toMatch(/--col:128mm;/)
    }
  })
})

describe("F165H-3: signature lines are vector rules", () => {
  test("signature holder: no gradient background; a 0.22 mm border-top on ::before, column padding 4 mm kept", async () => {
    const html = await K.renderHtml(K.compose(K.loadCase("case01.json")))
    const css = html.match(/\.st-signature-holder[^{]*\{[^}]*\}/g) ?? []
    expect(css.join("\n")).not.toContain("linear-gradient")
    expect(css).toContain('.st-signature-holder::before{content:"";display:block;border-top:0.22mm solid var(--st-sign-rule,#C4BEB4);margin-bottom:1.4mm}')
    expect(html).toContain(".st-signature th,.st-signature td{padding-right:4mm;")
    // three 55 mm columns (DOCX grid 3118/3175/3118 as shares of the 166 mm span)
    const sig = html.slice(html.indexOf('class="st-signature'))
    expect((sig.match(/<colgroup>.*?<\/colgroup>/)?.[0].match(/<col /g) ?? []).length).toBe(3)
  })
})

describe("F165H-2: text on hatched nodes has a paper ground", () => {
  const CASE04 = JSON.parse(readFileSync(path.join(PKG, "test", "engine-rev-a", "svg", "fixtures", "case04_v2.studio.json"), "utf8"))
  const node = (svg: string) => {
    const m = /<rect\b([^>]*data-node="srv"[^>]*)\/>/.exec(svg)
    const a = attrs(m![1])
    return { x0: +a.x, y0: +a.y, x1: +a.x + +a.width, y1: +a.y + +a.height }
  }
  const texts = (svg: string) =>
    [...svg.matchAll(/<text\b([^>]*)>([^<]*)<\/text>/g)].map((m) => ({ a: attrs(m[1]), s: m[2] })).filter((t) => ["Server Pemantauan", "1U · 2 × 960 GB", "REQ-MON-01"].includes(t.s))

  test("case 04 (engine and ELK path): label, sub-label and tag of the hatched node each sit on a paper rect inside the node, drawn after the hatch", async () => {
    for (const svg of [build.buildDiagramSvg(structuredClone(CASE04), { release: false }).svg, (await elk.buildDiagramSvgAuto(structuredClone(CASE04), { release: false })).svg]) {
      const hatchAt = svg.indexOf('data-hatch="45"')
      expect(hatchAt).toBeGreaterThan(0)
      const groundAt = svg.indexOf('data-text-ground="1"')
      expect(groundAt).toBeGreaterThan(hatchAt)
      const g = /<g data-text-ground="1"[^>]*>(.*?)<\/g>/.exec(svg)![1]
      const rects = [...g.matchAll(/<rect\b([^>]*)\/>/g)].map((m) => attrs(m[1]))
      const box = node(svg)
      for (const r of rects) {
        expect(r.fill).toBe(tokens.PAPER)
        expect(+r.x).toBeGreaterThanOrEqual(box.x0)
        expect(+r.y).toBeGreaterThanOrEqual(box.y0)
        expect(+r.x + +r.width).toBeLessThanOrEqual(box.x1 + 1e-9)
        expect(+r.y + +r.height).toBeLessThanOrEqual(box.y1 + 1e-9)
      }
      const ts = texts(svg)
      expect(ts.map((t) => t.s).sort()).toEqual(["1U · 2 × 960 GB", "REQ-MON-01", "Server Pemantauan"])
      for (const t of ts) {
        const x = +t.a.x
        const y = +t.a.y - 0.5 // inside the glyphs, above the baseline
        expect(rects.some((r) => x >= +r.x && x <= +r.x + +r.width && y >= +r.y && y <= +r.y + +r.height)).toBe(true)
      }
    }
  })

  test("CP-43: the ground adds no colour (paper is the figure ground); figure colours stay <= 5", async () => {
    const svg = (await elk.buildDiagramSvgAuto(structuredClone(CASE04), { release: false })).svg
    const cols = [...svg.matchAll(/(?:fill|stroke)="(#[0-9A-Fa-f]{3,8})"/g)].map((m) => m[1])
    const n = colour.countFigureColourValues(cols)
    expect(n.count).toBeLessThanOrEqual(5)
  })

  test("a node without hatch gets no ground (other figures byte-identical)", async () => {
    const s = structuredClone(CASE04)
    const walk = (o: any) => {
      if (Array.isArray(o)) o.forEach(walk)
      else if (o && typeof o === "object") {
        if (o.class && typeof o.class === "object") delete o.class.accent
        Object.values(o).forEach(walk)
      }
    }
    walk(s)
    expect(build.buildDiagramSvg(s, { release: false }).svg).not.toContain("data-text-ground")
  })
})

describe("F165H-4: one document number for cover, DOCX foot and HTML/PDF foot", () => {
  const META = "016/GSP/KT/XI/2026"
  const SAMPLE = "012/GSP/KT/XI/2026"
  const doc = () => {
    const d = K.loadCase("case01.json")
    d.meta.docNumber = META // the material's cover control block still prints the template sample 012
    return d
  }
  test("the material differs from meta (precondition)", () => {
    expect(JSON.stringify(doc().sections?.cover ?? doc())).toContain(SAMPLE)
  })
  test("DOCX: register foot and cover control block print meta.docNumber, never the cover sample number", async () => {
    const files = unzipSync(await K.renderDocx(K.compose(doc())))
    const feet = Object.keys(files).filter((k) => /^word\/footer\d*\.xml$/.test(k)).map((k) => strFromU8(files[k]).replace(/<[^>]+>/g, "")).join("\n")
    expect(feet).toContain(META)
    expect(feet).not.toContain(SAMPLE)
    const body = strFromU8(files["word/document.xml"])
    const control = (body.match(/<w:tbl>.*?<\/w:tbl>/gs) ?? []).map((t) => t.replace(/<[^>]+>/g, " ")).find((t) => /Nomor dokumen/.test(t))
    expect(control).toBeDefined()
    expect(control).toContain(META)
    expect(control).not.toContain(SAMPLE)
  })
  test("HTML/PDF: cover control block and register foot print meta.docNumber", async () => {
    const html = await K.renderHtml(K.compose(doc()))
    const cover = K.text(K.unitHtml(html, "cover"))
    expect(cover).toContain(META)
    expect(cover).not.toContain(SAMPLE)
    const pages = html.slice(html.indexOf('<style data-studio="pages">'), html.indexOf("</style>", html.indexOf('<style data-studio="pages">')))
    expect(pages).toContain(META)
    expect(pages).not.toContain(SAMPLE)
  })
})

describe("F165H-5: studio_render reply names the delivered title name", async () => {
  const { useStudioEnv } = await import("../../ported/_env")
  useStudioEnv()
  const { DOC, FINAL, SHA } = await import("../../ported/draft/r3-stateful-harness")
  const { connect, FILE_ID, studioMock } = await import("../../ported/mcp/mcp-harness")
  const TITLE = "Pemantauan Iklim Ruang Simpan Arsip Statis Gedung B 012-GSP-KT-XI-2026 RevA.html"
  test("each output line points to its title name; the names are printed only inside the untrusted block", async () => {
    const m = studioMock({
      ["POST /api/studio/documents/" + DOC + "/render"]: () => ({
        status: 200,
        body: { outputs: [{ id: FILE_ID, role: "PRIMARY", format: "HTML", sha256: SHA, finalFileName: FINAL, fileName: TITLE }, { id: "cmvvfile0000000000000r3f2b", role: "PRIMARY", format: "PDF", sha256: SHA, finalFileName: FINAL, fileName: "../x 012 RevA.pdf" }] },
      }),
    })
    const { call } = await connect({ fetch: m.f })
    const r = await call("studio_render", { documentId: DOC })
    expect(r.isError).toBeFalsy()
    const at = r.text.indexOf("<data-tak-tepercaya")
    expect(at).toBeGreaterThan(0)
    const before = r.text.slice(0, at)
    expect(before).toContain(`HTML ${FILE_ID} ${FINAL} · nama terkirim #1 (blok di bawah)`)
    expect(before).not.toContain(TITLE)
    expect(before).not.toContain("nama terkirim #2") // unsafe name -> no title name
    expect(r.text.slice(at)).toContain(`#1 HTML ${FILE_ID}: ${TITLE}`)
    expect(r.text).not.toContain("../x 012 RevA.pdf")
  })
})
