// Swarm 1.3.3 row 133 (ST-2 follow-up of row 38): the manual's reference schedule (Figure 29.6, sheet 347: 14 tasks,
// 5 milestones = 19 rows) must PASS preview and render as a document figure.
// Rule kept, not gutted: `rowsInProposal` [8, 15] is the row bound at the reference height of 62 mm, i.e. a minimum
// row pitch (W07_MIN_ROW_PITCH_MM). Above 15 rows a schedule without `heightMm` grows at that pitch; above the text
// block it is refused with the split offer; a caller-fixed height that cannot hold the rows still reports.
// Red before the change: preview of the reference case returned the defect `chart.kind.W-07.rowsInProposal`
// (19 > 15), the canvas stayed 62 mm (pitch 2.49 mm), and float and milestone had no key entry.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { readFileSync } from "node:fs"
import path from "node:path"
import * as chartCore from "../../vendor/src/lib/studio/engine/chart/core"
import * as geometry from "../../vendor/src/lib/studio/engine/chart/core/geometry"
import { W07_MIN_ROW_PITCH_MM } from "../../vendor/src/lib/studio/engine/chart/family-w2/gantt"
import { W2_REFERENCE_HEIGHT_MM } from "../../vendor/src/lib/studio/engine/chart/family-w2"
import { CHART_PARAMS } from "../../vendor/src/lib/studio/registry/charts"
import { chartSvg } from "../../vendor/src/lib/studio/services/render/figures"
import { glyphSet, mapBlock } from "../../vendor/src/lib/studio/services/compose"
import * as preview from "../../src/mcp-host/local-api/routes/figure-preview-figure"

type J = any
const FIX = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "r8_p347_master_schedule.json"), "utf8"))
const BLOCK: J = FIX.block
const TPL = (chartCore as J).EMPTY_CHART_TEMPLATE
const ROWS_KEY = "chart.kind.W-07.rowsInProposal"

function specOf(block: J): J {
  const content: J = mapBlock(structuredClone(block), "p-row133", { glyphs: glyphSet(undefined), params: {}, classification: "" } as J)
  return content.spec
}
const render = (spec: J): { svg: string; heightMm: number; report: J } => (chartCore as J).renderChart(structuredClone(spec), TPL)
const tasks = (n: number, extra: J = {}): J => ({
  $schema: "studio.chart/v1",
  kind: "W-07",
  title: "Jadwal",
  source: "Uji row 133",
  widthMm: 128,
  data: { shape: "intervals", timeUnit: "minggu", items: Array.from({ length: n }, (_, i) => ({ label: `T${i + 1}`, start: i, end: i + 2 })) },
  ...extra,
})
/** Row pitch in mm, measured on the drawn bars (centre of consecutive task rows). */
function pitchOf(svg: string): number {
  const ys = [...svg.matchAll(/<rect data-mark="interval"[^>]*? y="([\d.]+)"[^>]*? height="([\d.]+)"/g)].map((m) => Number(m[1]) + Number(m[2]) / 2)
  expect(ys.length).toBeGreaterThan(1)
  return Math.min(...ys.slice(1).map((y, i) => y - ys[i]))
}
const issueIds = (r: { report: J }): string[] => r.report.issues.map((i: J) => i.checkId)

describe("row 133: what the row bound protects", () => {
  test("the minimum pitch is the pitch of the old bound: 15 rows in the 62 mm reference canvas with key and status bands", () => {
    const def = (CHART_PARAMS as J[]).find((d) => d.key === ROWS_KEY)
    expect(def.default).toEqual([8, 15])
    const rowBand = (W2_REFERENCE_HEIGHT_MM as J)["W-07"] - (1.6 + 4.6 + 3.4) - 5.0
    expect(Math.round((rowBand / def.default[1]) * 100) / 100).toBe(W07_MIN_ROW_PITCH_MM)
    expect(W07_MIN_ROW_PITCH_MM).toBe(3.16)
  })
})

describe("row 133: the reference schedule passes preview and render", () => {
  for (const widthMm of [128, 166]) {
    test(`width ${widthMm} mm: no preview defect, preview and render byte-equal (ID and EN), height grown`, async () => {
      const spec = { ...specOf(BLOCK), widthMm }
      const block: J = { blockId: "p-row133", address: null, ordinal: 0, unitKey: "", type: "chart", content: { spec }, textPlain: "", contentSha256: "" }
      for (const lang of [undefined, "EN"] as const) {
        const viaRender = chartSvg(structuredClone(spec), TPL, lang as J)
        const viaPreview = await preview.renderResolved({ block, type: "chart", spec: structuredClone(spec) }, TPL, { inline: true, withSvg: true, ...(lang ? { lang } : {}) } as J)
        expect(viaPreview.defects).toEqual([])
        expect(viaPreview.layoutIssueCount).toBe(0)
        expect(viaPreview.svg, String(lang)).toBe(viaRender.svg)
        expect(viaPreview.size.heightMm).toBe(viaRender.heightMm)
        expect(issueIds(viaRender)).not.toContain(ROWS_KEY)
        // 19 rows: 9.6 (edge, key, status label) + 19 x 3.16 + 5.0 (axis) = 74.64 -> 74.7 mm.
        expect(viaRender.heightMm).toBe(74.7)
        expect(pitchOf(viaRender.svg)).toBeGreaterThanOrEqual(W07_MIN_ROW_PITCH_MM - 1e-3)
      }
    })
  }

  test("geometry lint is clean and the bytes are deterministic", () => {
    const spec = specOf(BLOCK)
    const a = render(spec)
    expect((geometry as J).lintChartGeometry(a.svg, (geometry as J).CHART_LINT_OPTIONS).score).toBe(0)
    expect(render(spec).svg).toBe(a.svg)
  })
})

describe("row 133: key entries for float and milestone", () => {
  const key = (svg: string): string => svg.slice(svg.indexOf('<g data-key="row">'), svg.indexOf("</g>", svg.indexOf('<g data-key="row">')))
  test("the float tail and the milestone marker have a key entry drawn as their own mark", () => {
    const k = key(render(specOf(BLOCK)).svg)
    expect(k).toContain(">jalur kritis<")
    expect(k).toContain(">non-kritis<")
    expect(k).toContain(">kelonggaran (float)<")
    expect(k).toContain(">milestone<")
    expect((k.match(/data-key-sample="tail"/g) ?? []).length).toBe(1)
    expect(k).toMatch(/<line [^>]*stroke-dasharray="0.5 0.5" data-key-sample="tail"\/>/)
    expect((k.match(/data-key-sample="diamond"/g) ?? []).length).toBe(1)
    // key samples are decoration: no data-mark, so mark counts and the accent budget are unchanged.
    expect(k).not.toContain("data-mark")
  })
  test("EN document: float, milestone", () => {
    const k = key(chartSvg(specOf(BLOCK), TPL, "EN" as J).svg)
    expect(k).toContain(">critical path<")
    expect(k).toContain(">float<")
    expect(k).toContain(">milestone<")
  })
  test("the status line keeps its direct label and gets no key entry", () => {
    const svg = render(specOf(BLOCK)).svg
    expect(svg).toContain(">status minggu 10<")
    expect(key(svg)).not.toContain("status")
  })
  test("float without a critical path still gets the key; a schedule without float gets no float entry", () => {
    const withFloat = tasks(4)
    withFloat.data.items[1].float = 2
    expect(key(render(withFloat).svg)).toContain(">kelonggaran (float)<")
    const crit = tasks(4)
    crit.data.items[0].critical = true
    expect(key(render(crit).svg)).not.toContain("float")
    expect(render(tasks(4)).svg).not.toContain('data-key="row"')
  })
})

describe("row 133: the row limit follows the height in use", () => {
  test("up to 15 rows the canvas stays at the 62 mm reference; from 16 rows it grows at the minimum pitch", () => {
    expect(render(tasks(15)).heightMm).toBe(62)
    const r16 = render(tasks(16))
    // no key, no status line: 1.6 + 16 x 3.16 + 5.0 = 57.16 < 62 -> still the reference height.
    expect(r16.heightMm).toBe(62)
    const r30 = render(tasks(30))
    expect(r30.heightMm).toBe(101.4) // 1.6 + 30 x 3.16 + 5.0
    expect(pitchOf(r30.svg)).toBeGreaterThanOrEqual(W07_MIN_ROW_PITCH_MM - 1e-3)
    expect(issueIds(r30)).not.toContain(ROWS_KEY)
  })

  test("the limit of the text block: the last row count that fits renders, one more is refused with the split offer", () => {
    // page apparatus, no key, no status: floor((247 - 1.6 - 5.0) / 3.16) = 76 rows.
    const limit = Math.floor((247 - 1.6 - 5.0) / W07_MIN_ROW_PITCH_MM)
    expect(limit).toBe(76)
    const ok = render(tasks(limit))
    expect(ok.heightMm).toBeLessThanOrEqual(247)
    expect(issueIds(ok)).not.toContain(ROWS_KEY)
    let err: J
    try {
      render(tasks(limit + 1))
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err.details).toMatchObject({ checkId: "DATUM-33", family: "W-07", figure: "chart", quantity: "baris jadwal", unit: "baris", limit, measured: limit + 1 })
    expect(err.details.suggestion).toContain("pecah menjadi dua gambar W-07")
    expect(err.details.suggestion).toContain("per fase")
    expect(err.details.suggestion).toContain("per jendela waktu (mis. minggu 0-39 dan minggu 39-78)")
    expect(err.message).toContain(`baris jadwal maks ${limit} baris, terukur ${limit + 1} baris`)
  })

  test("preview refuses the over-limit schedule the same way", async () => {
    const spec = tasks(90)
    const block: J = { blockId: "p-row133", address: null, ordinal: 0, unitKey: "", type: "chart", content: { spec }, textPlain: "", contentSha256: "" }
    let err: J
    try {
      await preview.renderResolved({ block, type: "chart", spec: structuredClone(spec) }, TPL, { inline: true, withSvg: true } as J)
    } catch (e) {
      err = e
    }
    expect(err?.code).toBe("FIGURE_OVER_CAPACITY")
    expect(err.details.suggestion).toContain("per fase")
  })

  test("a caller-fixed height that cannot hold the rows still reports, with the computed limit and the split offer", () => {
    const fixed = render({ ...specOf(BLOCK), heightMm: 62 })
    const issue = fixed.report.issues.find((i: J) => i.checkId === ROWS_KEY)
    expect(issue?.status).toBe("REPORT")
    expect(issue.detail).toContain("19 baris > 15 pada tinggi 62 mm")
    expect(issue.detail).toContain("jarak baris minimum 3,16 mm")
    expect(issue.detail).toContain("per fase")
    expect(issue.detail).toContain("per jendela waktu")
    expect(preview.previewIssueClass(ROWS_KEY, "REPORT")).toBe("defect")
    // a fixed height that does hold the rows is not reported
    expect(issueIds(render({ ...specOf(BLOCK), heightMm: 80 }))).not.toContain(ROWS_KEY)
  })
})
