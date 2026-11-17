// Swarm 1.3.3 row 49 (ST-3 acceptance): the 16 round-2 specs re-rendered WITHOUT changing them, four counts.
//
// Spec ST-3 (handoff patch_1_3_3/03_spek.md): "16 spec putaran 2 dirender ulang tanpa perubahan spec: 0 KUNCI tercoret,
// 0 label tertimpa arsir, 0 label garis menimpa garis wadah, huruf label sama dengan spec".
//
// Fixtures: fixtures/r2_*.json are byte copies of research/replay/R2_round2_specs (sha256 of the sorted concatenation
// ea4860e5855c0950..., the same set rows 41 and 43 copied). The spec of every file is passed through untouched. The
// only adaptation is on the wrapper: the three u3 files store caption and source as plain strings (fence form) and the
// v2 block wants `{ text }`; the text is kept as written. u3/3.1 is a chart without `kind` and is reported as refused.
//
// Paths (test/st3-round2-replay/_product.ts, after row 36's harness): document render (`buildFigures`), inline preview
// (`renderFigure`), stand-alone figure preview (`renderResolved` standalone), at both block widths ("text" 128 mm and
// "full" 166 mm; no R2 block fixes a width). The document and the inline preview print KUNCI and SUMBER as page rows
// under the figure; the key's letter case is then checked on the page row the document prints (`keyRowHtml`).
//
// Counts (test/st3-round2-replay/_counts.ts): (1) foot rows crossed by a drawn stroke; (2) text on a visible hatch
// (row 41's checker); (3) edge-label bands on a zone frame (rows 42 and 135's rule); (4) labels and key rows whose
// printed text differs from the spec text (row 43's rule).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { keyLineText } from "@/lib/studio/engine/front/texts"
import { parse } from "../st3-hatch-behind-text/_overlap"
import { caseMismatches, edgeLabelsOnBorder, footClearance, footRows, onHatch, pageKeyMismatches, struckFootRows, svgTexts } from "./_counts"
import { createProduct, type PathResult, type Product, type Width } from "./_product"

type J = Record<string, any>
const FIX = path.join(import.meta.dir, "fixtures")
const FILES = readdirSync(FIX).filter((f) => f.startsWith("r2_") && f.endsWith(".json")).sort()
const WIDTHS: Width[] = ["full", "text"]
const PATHS = ["document", "preview", "standalone"] as const

/** The block of a replay file, spec untouched; caption and source as `{ text }` (wrapper only). */
function blockOf(file: string): J {
  const raw = JSON.parse(readFileSync(path.join(FIX, file), "utf8")) as J
  const inner = (raw.diagram ?? raw.chart ?? raw) as J
  const text = (v: unknown) => (typeof v === "string" ? { text: v } : v)
  return { ...inner, type: raw.chart ? "chart" : "diagram", caption: text(inner.caption), source: text(inner.source) }
}

interface SpecRow {
  spec: string
  family: string
  renders: number
  hatched: number
  struck: string[]
  hatch: string[]
  border: string[]
  caseOff: string[]
  labels: number
  keyRows: number
  clearance: number
  refusals: string[]
  defects: string[]
}

let product: Product
const rows: SpecRow[] = []
const svgs = new Map<string, string>()
let ms = 0

beforeAll(async () => {
  const t0 = Date.now()
  product = await createProduct()
  const wording = (row: string) => keyLineText(row, product.lang)
  for (const f of FILES) {
    const block = blockOf(f)
    const r: SpecRow = { spec: f.replace(/^r2_|\.json$/g, ""), family: block.type === "chart" ? "chart" : String(block.spec?.family), renders: 0, hatched: 0, struck: [], hatch: [], border: [], caseOff: [], labels: 0, keyRows: 0, clearance: 0, refusals: [], defects: [] }
    for (const width of WIDTHS) {
      const out = await product.render(block, width)
      for (const p of PATHS) {
        const x = out[p] as PathResult | null
        if (!x) continue
        const at = `${width}/${p}`
        if (x.refusal || !x.svg) {
          r.refusals.push(`${at}: ${x.refusal?.code ?? "NO_SVG"}${x.refusal?.checkId ? ` (${x.refusal.checkId})` : ""}`)
          continue
        }
        r.renders++
        svgs.set(`${f}|${at}`, x.svg)
        if (parse(x.svg).segs.length) r.hatched++
        r.struck.push(...struckFootRows(x.svg).map((s) => `${at}: "${s.text}" by ${s.by.slice(0, 50)} (${s.mm} mm)`))
        r.clearance += footClearance(x.svg)
        r.hatch.push(...onHatch(x.svg).map((h) => `${at}: ${h}`))
        r.border.push(...edgeLabelsOnBorder(x.svg).map((b) => `${at}: "${b}"`))
        r.defects.push(...x.defects.map((d) => `${at}: ${d}`))
        const c = caseMismatches(block.spec, x.svg, product.lang === "EN" ? "KEY" : "KUNCI", wording)
        r.labels += c.labels
        r.keyRows += c.keyRows
        r.caseOff.push(...c.mismatches.map((m) => `${at}: ${m}`))
      }
      // the page KUNCI row the document prints under the figure (document and inline preview share the block); checked
      // when the document SVG draws no key of its own (an engine that draws the key in the SVG is checked there above)
      const docSvg = out.document.svg
      if (out.inline && docSvg && footRows(docSvg).length === 0 && block.type === "diagram" && (block.spec.legend ?? []).length) {
        const html = product.pageKeyHtml(out.inline)
        const legend = block.spec.legend as string[]
        r.keyRows += legend.length
        if (!html) r.caseOff.push(`${width}/page: no KUNCI row printed`)
        else r.caseOff.push(...pageKeyMismatches(legend, html, wording).map((m) => `${width}/page: ${m}`))
      }
    }
    rows.push(r)
  }
  ms = Date.now() - t0
  const sum = (k: "struck" | "hatch" | "border" | "caseOff") => rows.reduce((a, x) => a + x[k].length, 0)
  const pad = (s: string | number, n: number) => String(s).padEnd(n)
  const lines = [
    `row49 replay R2: ${FILES.length} specs, ${rows.reduce((a, x) => a + x.renders, 0)} renders, ${ms} ms`,
    `${pad("spec", 8)}${pad("family", 10)}${pad("renders", 8)}${pad("hatched", 8)}${pad("struck", 7)}${pad("hatch", 6)}${pad("border", 7)}${pad("case", 5)}${pad("labels", 7)}${pad("keyrows", 8)}refused`,
    ...rows.map((x) => `${pad(x.spec, 8)}${pad(x.family, 10)}${pad(x.renders, 8)}${pad(x.hatched, 8)}${pad(x.struck.length, 7)}${pad(x.hatch.length, 6)}${pad(x.border.length, 7)}${pad(x.caseOff.length, 5)}${pad(x.labels, 7)}${pad(x.keyRows, 8)}${x.refusals.length ? x.refusals[0] + (x.refusals.length > 1 ? ` (+${x.refusals.length - 1})` : "") : "-"}`),
    `TOTAL struck ${sum("struck")} hatch ${sum("hatch")} border ${sum("border")} case ${sum("caseOff")}; specs refused ${rows.filter((x) => x.refusals.length).map((x) => x.spec).join(", ") || "none"}; foot clearance violations ${rows.reduce((a, x) => a + x.clearance, 0)}`,
  ]
  for (const x of rows) for (const k of ["struck", "hatch", "border", "caseOff", "defects"] as const) for (const d of x[k]) lines.push(`  ${x.spec} ${k}: ${d}`)
  console.log(lines.join("\n"))
}, 120000)

afterAll(() => product?.dispose())

describe("row 49: replay of the 16 round-2 specs, spec unchanged (ST-3 acceptance)", () => {
  test("the fixture set is the 16 replay files: 15 diagrams and 1 chart", () => {
    expect(FILES.length).toBe(16)
    expect(rows.filter((r) => r.family === "chart").map((r) => r.spec)).toEqual(["u3_3.1"])
  })

  test("every diagram spec builds on all three paths at both widths (a refusal is listed and is not a pass)", () => {
    const refused = rows.filter((r) => r.family !== "chart" && r.refusals.length).map((r) => `${r.spec}: ${r.refusals.join("; ")}`)
    expect(refused).toEqual([])
    for (const r of rows.filter((x) => x.family !== "chart")) expect(r.renders).toBe(6)
  })

  test("the chart u3/3.1 is reported with its refusal code (no `kind` in the stored chart), not skipped", () => {
    const chart = rows.find((r) => r.family === "chart")!
    expect(chart.renders).toBe(0)
    expect(chart.refusals.length).toBe(4) // document and preview, two widths
    for (const x of chart.refusals) expect(x).toMatch(/: [A-Z_]+/)
  })

  test("(1) KUNCI / SUMBER rows struck by a drawn line or container border: 0", () => {
    expect(rows.flatMap((r) => r.struck)).toEqual([])
  })
  test("(2) labels on an accent hatch with no opaque ground between: 0", () => {
    expect(rows.flatMap((r) => r.hatch)).toEqual([])
  })
  test("(3) edge-label boxes on a container border: 0", () => {
    expect(rows.flatMap((r) => r.border)).toEqual([])
  })
  test("(4) edge labels and key rows whose printed text differs from the spec text: 0", () => {
    expect(rows.flatMap((r) => r.caseOff)).toEqual([])
    expect(rows.reduce((a, r) => a + r.labels, 0)).toBeGreaterThan(0)
    expect(rows.reduce((a, r) => a + r.keyRows, 0)).toBeGreaterThan(0)
  })

  test("runtime of the replay is under two minutes", () => {
    expect(ms).toBeLessThan(120000)
  })
})

describe("row 49: the counters see the defect they count (the replay can fail)", () => {
  const any = (pred: (k: string) => boolean): [string, string] => {
    for (const [k, v] of svgs) if (pred(k)) return [k, v]
    throw new Error("row 49: no render matches")
  }

  test("the hatch is there: the six accented specs render hatched on every path", () => {
    expect(rows.filter((r) => r.hatched > 0).map((r) => r.spec)).toEqual(["u2_1", "u2_2", "u2_3", "u2_5", "u3_2.1", "u3_2.2"])
  })

  test("the stand-alone path draws the foot rows inside the SVG; the document path prints them on the page", () => {
    for (const r of rows.filter((x) => x.family !== "chart")) {
      const f = `r2_${r.spec}.json`
      expect(footRows(svgs.get(`${f}|full/standalone`)!).length).toBeGreaterThan(0)
      expect(footRows(svgs.get(`${f}|full/document`)!).length).toBe(0)
    }
  })

  test("(1) a line drawn through the first key row is counted", () => {
    const [, svg] = any((k) => k.startsWith("r2_u1_2.json|full/standalone"))
    const row = footRows(svg)[0]
    const y = (row.box[1] + row.box[3]) / 2
    const struck = svg.replace("</svg>", `<line x1="0" y1="${y}" x2="160" y2="${y}" stroke="#000" stroke-width="0.25" stroke-dasharray="1 1"/></svg>`)
    expect(struckFootRows(struck).length).toBeGreaterThan(0)
    expect(struckFootRows(svg)).toEqual([])
  })

  test("(2) with the text grounds removed, labels on the hatch are counted", () => {
    const [, svg] = any((k) => k.startsWith("r2_u2_1.json|full/document"))
    expect(onHatch(svg.replace(/<g data-text-ground="1"[^>]*>.*?<\/g>/g, "")).length).toBeGreaterThan(0)
  })

  test("(3) an edge-label band moved onto a zone frame is counted", () => {
    const svg = `<svg viewBox="0 0 100 60"><rect x="0" y="0" width="100" height="60" fill="#fff"/><rect x="10" y="10" width="60" height="30" fill="none" stroke="#000" stroke-dasharray="1 1"/><rect x="30" y="38" width="20" height="4" fill="#fff"/><text x="40" y="41" text-anchor="middle">64 Mb/s</text></svg>`
    expect(edgeLabelsOnBorder(svg)).toEqual(["64 Mb/s"])
  })

  test("(4) an edge label printed in capitals is counted", () => {
    const block = blockOf("r2_u1_1.json")
    const label = (block.spec.edges as J[]).map((e) => String(e.label ?? "")).find((l) => l !== l.toUpperCase())!
    const [, svg] = any((k) => k.startsWith("r2_u1_1.json|full/document"))
    expect(svgTexts(svg)).toContain(label)
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    const upper = svg.split(`>${esc(label)}<`).join(`>${esc(label.toUpperCase())}<`)
    expect(caseMismatches(block.spec, upper, "KUNCI", (s) => s).mismatches).toContain(`edge "${label}"`)
  })
})
