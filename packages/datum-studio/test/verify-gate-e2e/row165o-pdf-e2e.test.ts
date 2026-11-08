// Row 165O (C204 items 3 and 4) on real PDFs, printed by the REAL render bridge (the repo's Electron 42 binary, row 157
// harness, fixture HOME, --use-mock-keychain, dead proxy) from the in-process case 01 / case 05 HTML (datum-kanonik):
//   item 3: the cover control block is a 4 x 2 grid: 4 rows on case 01, 3 on case 05 (= its own field count), with
//           "Klasifikasi : TERBATAS" as its own line under the number (rows counted on the HTML the PDF is printed
//           from; the PDFs are kept for a PyMuPDF read in the row report);
//   item 4: no #000000 fill colour operator (`0 0 0 rg`, `0 g`, `0 0 0 1 k`) in any page content stream (F-Y3: the
//           hatch lines had no fill and Chromium wrote a black fill colour on the figure page).
// OPT-IN: runs only with ROW165O_E2E=1 (it launches Electron; command sandbox off: Unix socket).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { inflateSync } from "node:zlib"
import { realBridgeRunnable, startRealBridge, type RealBridge } from "./real-bridge"

const E2E = process.env.ROW165O_E2E === "1" && realBridgeRunnable
const e2e = E2E ? describe : describe.skip
const ROOT = process.env.ROW165O_ROOT ?? "/private/tmp/claude-501/row165O"
const TAG = process.env.ROW165O_TAG ?? "after"

/** Fill-colour operators setting pure black, counted over every Flate content stream of the PDF. */
function blackFillOps(pdf: Uint8Array): number {
  const buf = Buffer.from(pdf)
  let n = 0
  let at = 0
  for (;;) {
    const s = buf.indexOf("stream", at, "latin1")
    if (s < 0) break
    const start = buf[s + 6] === 0x0d && buf[s + 7] === 0x0a ? s + 8 : s + 7
    const e = buf.indexOf("endstream", start, "latin1")
    if (e < 0) break
    at = e + 9
    let text: string
    try {
      text = inflateSync(buf.subarray(start, e)).toString("latin1")
    } catch {
      continue // not a Flate stream (images, fonts in other filters)
    }
    // A black fill set right before an image XObject draw (`0 0 0 rg /Gn gs /Xn Do`) is Skia's state for painting an
    // image (the cover logo, a raster figure), not a vector fill; it is not counted.
    for (const m of text.matchAll(/(?:^|[\s\]])(?:0(?:\.0+)? 0(?:\.0+)? 0(?:\.0+)? rg|0(?:\.0+)? g|0 0 0 1 k)\b/g)) {
      const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 40)
      if (/^\s*(?:\/G\d+ gs\s*)?\/X\d+ Do\b/.test(after)) continue
      n++
    }
  }
  return n
}

e2e("row 165O items 3 and 4 on real PDFs", () => {
  let bridge: RealBridge | undefined
  beforeAll(async () => {
    bridge = await startRealBridge(path.join(ROOT, "bridge-" + Date.now()), path.join(ROOT, "home-bridge"))
    process.env.DATUM_RENDER_SOCKET = bridge.info.DATUM_RENDER_SOCKET
    process.env.DATUM_RENDER_TOKEN = bridge.info.DATUM_RENDER_TOKEN
  }, 90_000)
  afterAll(async () => {
    const { closeBrowser } = await import("../../vendor/src/lib/studio/engine/browser/index")
    await closeBrowser?.()
    const st = await bridge?.stop()
    console.log(`[row165o] bridge stop ${JSON.stringify({ windowsAfter: st?.result?.windowsAfter ?? null, error: st?.result?.error ?? null })}`)
  }, 30_000)

  test("figure page (case 04 hatched diagram, both layout paths, every buildable hatched shape): no black fill operator", async () => {
    const { readFileSync } = await import("node:fs")
    const { printHtmlToPdf } = await import("../../vendor/src/lib/studio/services/render/pdf")
    const ENGINE = path.join(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio", "engine")
    const build = await import(path.join(ENGINE, "diagram", "build", "index.ts"))
    const elk = await import(path.join(ENGINE, "diagram", "elk", "index.ts"))
    const spec = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "engine-rev-a", "svg", "fixtures", "case04_v2.studio.json"), "utf8"))
    const svgs: string[] = [build.buildDiagramSvg(structuredClone(spec), { release: false }).svg, (await elk.buildDiagramSvgAuto(structuredClone(spec), { release: false })).svg]
    for (const shape of ["stadium", "parallelogram", "hexagon", "cylinder", "circle", "doubled", "shadowed"]) {
      const s = structuredClone(spec)
      s.nodes = s.nodes.map((n: any) => ({ ...n, shape, class: { ...(n.class ?? {}), accent: true } }))
      const r = await elk.buildDiagramSvgAuto(s, { release: false }).catch(() => null)
      if (r) svgs.push(r.svg)
    }
    const hatched = svgs.filter((x) => x.includes("data-hatch=")).length
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:210mm 297mm;margin:20mm}body{margin:0;background:#fff}svg{display:block;width:128mm;height:auto;break-inside:avoid;margin-bottom:6mm}</style></head><body>${svgs.join("")}</body></html>`
    const r = await printHtmlToPdf(html, { jobId: "row165o-figure" })
    mkdirSync(path.join(ROOT, "pdf", TAG), { recursive: true })
    const file = path.join(ROOT, "pdf", TAG, "figures.pdf")
    writeFileSync(file, r.pdf)
    const black = blackFillOps(r.pdf)
    console.log(`[row165o] ${TAG} figures svgs ${svgs.length} hatched ${hatched} pages ${r.pageCount} blackFillOps ${black} -> ${file}`)
    expect(hatched).toBeGreaterThanOrEqual(5)
    expect(black).toBe(0)
  }, 180_000)

  // Row 165P consequence edit (C205, CP-05): case 05 holds the manual's eight fields too, so 4 rows.
  for (const [name, rows] of [["case01.json", 4], ["case05.json", 4]] as const) {
    test(`${name}: control block ${rows} rows with the classification line; no black fill operator in the PDF`, async () => {
      const K = await import("../engine-rev-a/row165a/_kit")
      const { printHtmlToPdf } = await import("../../vendor/src/lib/studio/services/render/pdf")
      const html = await K.renderHtml(K.compose(K.loadCase(name)))
      const cover = K.unitHtml(html, "cover")
      const table = cover.slice(cover.indexOf('<table class="st-control"'), cover.indexOf("</table>", cover.indexOf('<table class="st-control"')))
      const trs = (table.match(/<tr>/g) ?? []).length
      const r = await printHtmlToPdf(html, { jobId: `row165o-${name}` })
      mkdirSync(path.join(ROOT, "pdf", TAG), { recursive: true })
      const file = path.join(ROOT, "pdf", TAG, name.replace(".json", ".pdf"))
      writeFileSync(file, r.pdf)
      const black = blackFillOps(r.pdf)
      console.log(`[row165o] ${TAG} ${name} pages ${r.pageCount} controlRows ${trs} blackFillOps ${black} figure ${html.includes("data-hatch=")} -> ${file}`)
      expect(trs).toBe(rows)
      expect(table).toContain('<div class="st-control-line">Klasifikasi : ')
      expect(black).toBe(0)
    }, 120_000)
  }
})
