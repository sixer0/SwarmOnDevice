// Swarm 1.3.3 row 77 (ST-10; register 03 "Negative chart value at write", "String inside edits"):
// 1. ONE SHAPE: studio_edit takes the figure blocks of studio_write ({figure, chart} = the chart block fields as a
//    patch, {figure, diagram} and append = the write blocks). Drift test between the two tools.
// 2. NEGATIVE VALUES: refused at write with the field path and the value, for exactly the chart codes the engine
//    refuses at render (every gallery code is rendered here with one negative value); other codes keep them.
// 3. ARGUMENT ERRORS: the refusal names the offending field; "/edits must be array" only when edits is not a list.
// 4. NO SILENT DROP: every prune rule of write-normalize.ts is a refusal with a path or a reported drop.
// 5. Replay of the quoted round failures (p3, p5, the two-diagram edit) as far as the extract allows.
// Pure: no port. HTTP is a stub that counts calls.
import { useStudioEnv } from "../ported/_env"; useStudioEnv()
import { describe, expect, test } from "bun:test"
import Ajv from "ajv"
import { renderChart } from "../../vendor/src/lib/studio/engine/chart/core"
import { argIssues, closestBranchErrors } from "../../vendor/scripts/studio/mcp/arg-issues"
import { loadConfig } from "../../vendor/scripts/studio/mcp/config"
import { McpToolError, REAL_NODE_FS } from "../../vendor/scripts/studio/mcp/safety"
import { executeTool, TOOLS } from "../../vendor/scripts/studio/mcp/tools"
import { buildClient, chapterOf, chartBlock, chartCodeOf, diagramBlock } from "../../vendor/scripts/studio/mcp/write-client"
import { applyClientEdits } from "../../vendor/scripts/studio/mcp/write-client-edit"
import { CHART_INTERVALS_INPUT_KEYS, NON_NEGATIVE_CHART_CODES, negativeChartValues } from "../../vendor/scripts/studio/mcp/write-figure-input"
import { CHART_KEYS, normalizeEditArgs, normalizeWriteArgs } from "../../vendor/scripts/studio/mcp/write-normalize"
import { EDIT_FIGURE_PATCHES, prepareStructEdits, refuseNegativeCharts, withNegativePointer, WRITE_FIGURE_BLOCKS } from "../../vendor/scripts/studio/mcp/write-tools"
import { chartSpecsByCode, clone } from "../ported/figures/_helpers"

type S = Record<string, any>
const tool = (name: string) => TOOLS.find((t) => t.name === name) as S
const ajv = () => new Ajv({ allErrors: true, strict: true })
const writeValid = ajv().compile(tool("studio_write").inputSchema)
const editValid = ajv().compile(tool("studio_edit").inputSchema)

const SPEC = { family: "flow", nodes: [{ id: "a", label: "Mulai", class: { col: 0, row: 0 } }, { id: "b", label: "Selesai", class: { col: 0, row: 1 } }], edges: [{ from: "a", to: "b", kind: "data", label: "lanjut" }] }
const CHART = { type: "bar", categories: ["A", "B", "C"], series: [{ name: "Nilai", values: [3, 5, 2] }], caption: "Nilai per lokasi.", source: "Sumber sintetis.", unit: "MW", stacked: false, width: "full" }
const W07 = { type: "W-07", intervals: [{ label: "Survei", start: 0, end: 2 }, { label: "Instalasi", start: 2, end: 6, critical: true }], statusAt: 3, timeUnit: "minggu", caption: "Jadwal sintetis.", source: "Sumber sintetis.", width: "text" }
const DIAGRAM = { spec: SPEC, caption: "Alur sintetis.", source: "Sumber sintetis.", width: "full" }

function writeArgs(blocks: unknown[], extra: S = {}) {
  const a: S = { mission: "2026-11-17_row77", docKey: "r77", template: "latest", meta: { title: "Uji", author: "Agen", source: "Sumber meta." }, sections: [{ heading: "Satu", blocks: clone(blocks) }], ...extra }
  const warnings = normalizeWriteArgs(a)
  const ok = writeValid(a)
  return { a, warnings, ok, issues: ok ? [] : argIssues(writeValid.errors, a) }
}
function editArgs(edits: unknown, extra: S = {}) {
  const a: S = { documentId: "cmvdoc0000000000000row77a", edits: clone(edits), ...extra }
  const warnings = normalizeEditArgs(a)
  const ok = editValid(a)
  return { a, warnings, ok, issues: ok ? [] : argIssues(editValid.errors, a) }
}
function refusal(fn: () => unknown): S {
  try {
    fn()
  } catch (e) {
    if (e instanceof McpToolError) return { code: e.code, message: e.message, pointer: e.extra.pointer, details: e.extra.details }
    throw e
  }
  return { code: "no-throw" }
}
/** executeTool with a stub HTTP layer; `calls` = every request the tool tried to send. */
async function exec(name: string, args: unknown) {
  const calls: string[] = []
  const fetchImpl = async (url: string, init: S) => {
    calls.push(`${init.method} ${new URL(url).pathname}`)
    return new Response(JSON.stringify({ error: "stub", code: "ROUTE_NOT_FOUND" }), { status: 404, headers: { "content-type": "application/json" } })
  }
  const config = loadConfig({ INTERNAL_API_SECRET: "rahasia-uji-row77-JANGAN-TERCETAK", STUDIO_BASE_URL: "http://127.0.0.1:9021", STUDIO_AGENT_ID: "agen-row77", STUDIO_MCP_FILE_ROOTS: process.env.TMPDIR ?? "/tmp" }, "/tmp")
  const r = (await executeTool(name, args, { config, fetchImpl, nfs: REAL_NODE_FS } as never)) as S
  return { r, calls, error: r.data?.error as S | undefined }
}
/** A stored client document (the R20 projection) with one chart and one diagram built by the write builders. */
function storedDoc(chart: S = CHART, diagram: S = DIAGRAM) {
  const ch = chapterOf({ heading: "Satu", blocks: ["Pembuka.", { chart: clone(chart) }, { diagram: clone(diagram) }] } as never, "1", "Satu", null, () => undefined, "bagian 1") as S
  const content: S = { meta: {}, sections: { content: { chapters: [ch] } } }
  const blocks = ch.intro as S[]
  return { content, chart: blocks.find((b) => b.type === "chart") as S, diagram: blocks.find((b) => b.type === "diagram") as S }
}
const apply = (content: S, edits: S[]) => applyClientEdits(content, edits as never, () => undefined)

// ── 1. one shape ────────────────────────────────────────────────────────

describe("row 77 PARITY: studio_edit takes the figure blocks of studio_write", () => {
  const W = WRITE_FIGURE_BLOCKS.chart as S
  const E = EDIT_FIGURE_PATCHES.chart as S

  test("DRIFT chart: same field names; same schema per field except the two documented patch rules", () => {
    expect(Object.keys(E.properties).sort()).toEqual(Object.keys(W.properties).sort())
    for (const k of Object.keys(W.properties)) {
      if (k === "caption" || k === "source") expect(E.properties[k]).toEqual({ ...W.properties[k], minLength: 1 })
      else expect(E.properties[k]).toEqual(W.properties[k])
    }
    expect(E.additionalProperties).toBe(false)
    expect(E.required).toBeUndefined() // a patch: every field optional
    expect(E.anyOf).toBeUndefined()
  })

  test("DRIFT normaliser: the chart keys the normaliser knows are the chart block fields; intervals keys come from the contract", () => {
    expect([...CHART_KEYS].sort()).toEqual(Object.keys(W.properties).sort())
    for (const k of CHART_INTERVALS_INPUT_KEYS) expect(Object.keys(E.properties)).toContain(k)
  })

  test("DRIFT diagram: the edit form is the write form (same object)", () => {
    expect(EDIT_FIGURE_PATCHES.diagram).toBe(WRITE_FIGURE_BLOCKS.diagram)
  })

  test("DRIFT tools/list: studio_edit lists {figure, chart} and {figure, diagram}; studio_write lists {chart} and {diagram}", () => {
    const forms = (tool("studio_edit").inputSchema.properties.edits.items.anyOf as S[]).map((f) => Object.keys(f.properties).sort().join("+"))
    expect(forms).toContain("chart+figure")
    expect(forms).toContain("diagram+figure")
    const blocks = (tool("studio_write").inputSchema.properties.sections.items.properties.blocks.items.anyOf as S[]).filter((b) => b.type === "object").map((b) => Object.keys(b.properties).sort().join("+"))
    expect(blocks).toContain("chart")
    expect(blocks).toContain("diagram")
  })

  test.each([["categories x series", CHART], ["W-07 intervals", W07]])("a chart block that studio_write accepts is accepted as {figure, chart} and as append: %s", (_n, chart) => {
    expect(writeArgs([{ chart }]).issues).toEqual([])
    const fig = editArgs([{ figure: "Nilai per lokasi", chart }])
    expect(fig.issues).toEqual([])
    expect(fig.warnings.filter((w: S) => w.code === "ARG_IGNORED")).toEqual([])
    expect(() => prepareStructEdits(fig.a.edits)).not.toThrow()
    const app = editArgs([{ section: "Satu", append: { chart } }])
    expect(app.issues).toEqual([])
    expect(() => prepareStructEdits(app.a.edits)).not.toThrow()
  })

  test("a diagram block that studio_write accepts is accepted as {figure, diagram} and as append", () => {
    expect(writeArgs([{ diagram: DIAGRAM }]).issues).toEqual([])
    const fig = editArgs([{ figure: "Alur sintetis", diagram: DIAGRAM }])
    expect(fig.issues).toEqual([])
    expect(fig.warnings.filter((w: S) => w.code === "ARG_IGNORED")).toEqual([])
    const app = editArgs([{ section: "Satu", append: [{ diagram: DIAGRAM }, { diagram: DIAGRAM }] }])
    expect(app.issues).toEqual([])
    expect(() => prepareStructEdits(app.a.edits)).not.toThrow()
  })

  test("a chart field studio_write refuses is refused by {figure, chart} at the same field", () => {
    const w = writeArgs([{ chart: { ...CHART, width: "lebar" } }])
    expect(w.issues.map((i: S) => i.pointer)).toEqual(["/sections/0/blocks/0/chart/width"])
    const e = editArgs([{ figure: "Nilai", chart: { width: "lebar" } }])
    const r = refusal(() => prepareStructEdits(e.a.edits))
    expect(r.code).toBe("INVALID_ARGUMENT")
    expect(r.pointer).toBe("/edits/0/chart/width")
    const unknown = refusal(() => prepareStructEdits(editArgs([{ figure: "Nilai", chart: { todayAt: 3 } }]).a.edits))
    expect(unknown.pointer).toBe("/edits/0/chart/todayAt")
  })

  test("the variant names of a written chart work in {figure, chart} too (one normaliser)", () => {
    const e = editArgs([{ figure: "Nilai", chart: { labels: ["A", "B"], data: [{ label: "Nilai", data: [1, 2] }], title: "Baru." } }])
    expect(e.a.edits[0].chart).toEqual({ categories: ["A", "B"], series: [{ name: "Nilai", values: [1, 2] }], caption: "Baru." })
    expect(e.issues).toEqual([])
  })

  test("{figure, chart: {width}} stores the width; data and caption stay", () => {
    const d = storedDoc({ ...CHART, width: undefined })
    expect("width" in d.chart).toBe(false)
    const before = clone(d.chart)
    apply(d.content, [{ figure: "Nilai per lokasi", chart: { width: "full" } }])
    expect(d.chart.width).toBe("full")
    expect(d.chart.data).toEqual(before.data)
    expect(d.chart.caption).toEqual(before.caption)
  })

  test("{figure, chart: {intervals}} edits a stored W-07 chart field by field (was refused: 'hanya kategori x seri')", () => {
    const d = storedDoc(W07)
    expect(d.chart.code).toBe("W-07")
    apply(d.content, [{ figure: "Jadwal sintetis", chart: { statusAt: 5 } }])
    expect(d.chart.data).toEqual({ shape: "intervals", items: W07.intervals, statusAt: 5, timeUnit: "minggu" })
    const items = [{ label: "Uji", start: 0, end: 4, float: 1 }]
    apply(d.content, [{ figure: "Jadwal sintetis", chart: { intervals: items } }])
    expect(d.chart.data).toEqual({ shape: "intervals", items, statusAt: 5, timeUnit: "minggu" })
    expect(d.chart.code).toBe("W-07")
    // a malformed interval is refused naming the field, nothing changed
    const snap = clone(d.chart)
    const r = refusal(() => apply(d.content, [{ figure: "Jadwal sintetis", chart: { intervals: [{ label: "X", start: 0, end: 1, float: -2 }] } }]))
    expect(r.code).toBe("CHART_DATA_INVALID")
    expect(r.message).toContain("/intervals/0/float")
    expect(d.chart).toEqual(snap)
  })

  test("{figure, chart: {intervals}} turns a categories chart into W-07; {categories, series} turns it back", () => {
    const d = storedDoc()
    apply(d.content, [{ figure: "Nilai per lokasi", chart: { intervals: W07.intervals, timeUnit: "minggu" } }])
    expect(d.chart.code).toBe("W-07")
    expect(d.chart.data).toEqual({ shape: "intervals", items: W07.intervals, timeUnit: "minggu" })
    apply(d.content, [{ figure: "Nilai per lokasi", chart: { categories: ["A", "B"], series: [{ name: "Nilai", values: [1, 2] }], type: "bar" } }])
    expect(d.chart.data).toEqual({ shape: "categorical", points: [{ label: "A", value: 1 }, { label: "B", value: 2 }] })
  })

  test("{figure, diagram} replaces the given fields of the stored diagram through the write builder", () => {
    const d = storedDoc()
    const spec2 = { ...SPEC, nodes: [...SPEC.nodes, { id: "c", label: "Arsip", class: { col: 0, row: 2 } }], edges: [...SPEC.edges, { from: "b", to: "c", kind: "data", label: "simpan" }] }
    const res = apply(d.content, [{ figure: "Alur sintetis", diagram: { spec: spec2, width: "text" } }])
    expect(res.charts).toHaveLength(1)
    expect(d.diagram.type).toBe("diagram")
    expect(d.diagram.spec).toEqual(spec2)
    expect(d.diagram.width).toBe("text")
    expect(d.diagram.caption).toEqual({ text: "Alur sintetis." })
    // the same block studio_write would build from the merged input
    expect(d.diagram).toEqual(diagramBlock({ ...DIAGRAM, spec: spec2, width: "text" } as never, null, () => undefined, "x"))
  })

  test("{figure, diagram} with a spec studio_write refuses is refused with the same validator text; nothing changed", () => {
    const d = storedDoc()
    const snap = clone(d.diagram)
    const bad = { spec: { family: "flow", nodes: "bukan larik" } }
    const viaEdit = refusal(() => apply(d.content, [{ figure: "Alur sintetis", diagram: bad }]))
    const viaWrite: S[] = []
    diagramBlock({ ...DIAGRAM, ...bad } as never, null, () => undefined, "x", (i) => viaWrite.push(i))
    expect(viaEdit.code).toBe("SCHEMA_INVALID")
    expect(viaWrite).toHaveLength(1)
    expect(viaEdit.message).toContain(viaWrite[0].message)
    expect(d.diagram).toEqual(snap)
  })

  test("{figure} that matches no diagram is an address miss (TEXT_NOT_FOUND), like a chart", () => {
    const d = storedDoc()
    const res = apply(d.content, [{ figure: "tidak ada", diagram: { width: "full" } }, { figure: "Nilai per lokasi", chart: { width: "text" } }])
    expect(res.notApplied.map((n: S) => n.code)).toEqual(["TEXT_NOT_FOUND"])
    expect(d.chart.width).toBe("text")
  })

  test("image: neither tool has an image block; both refuse it at the block, naming the unknown field", () => {
    const w = writeArgs([{ image: { assetId: "a1", caption: "c" } }])
    expect(w.ok).toBe(false)
    expect(w.issues.map((i: S) => i.pointer)).toContain("/sections/0/blocks/0/image")
    const r = refusal(() => prepareStructEdits(editArgs([{ section: "Satu", append: { image: { assetId: "a1", caption: "c" } } }]).a.edits))
    expect(r.code).toBe("INVALID_ARGUMENT")
    expect((r.details as S[]).map((i) => i.pointer)).toContain("/edits/0/append/0/image")
  })
})

// ── 2. negative values ──────────────────────────────────────────────────

describe("row 77 NEGATIVE: refused at write for the codes the engine refuses at render", () => {
  const SPECS = chartSpecsByCode() as S
  /** Render every gallery code of the two write shapes with one negative value. */
  function engineVerdicts() {
    const refused: string[] = []
    const draws: string[] = []
    const other: Array<[string, string]> = []
    for (const code of Object.keys(SPECS).sort()) {
      const s = clone(SPECS[code])
      if (s.data?.shape === "categorical") s.data.points[0].value = -Math.abs(s.data.points[0].value || 1)
      else if (s.data?.shape === "series") {
        const v = s.data.series[0].values as Array<number | null>
        const i = v.findIndex((x) => typeof x === "number")
        v[i] = -Math.abs((v[i] as number) || 1)
      } else continue
      try {
        renderChart(s)
        draws.push(code)
      } catch (e) {
        const m = String((e as Error).message)
        if (/negatif|>= 0/.test(m)) refused.push(code)
        else other.push([code, m])
      }
    }
    return { refused, draws, other }
  }

  test("DRIFT: NON_NEGATIVE_CHART_CODES is exactly the set of codes renderChart refuses for a negative value (V-02, V-06: family-v)", () => {
    const v = engineVerdicts()
    const mirrored = [...NON_NEGATIVE_CHART_CODES].filter((c) => !c.startsWith("V-")).sort()
    expect(mirrored).toEqual(v.refused)
    expect(v.refused).toEqual(["K-01", "K-02", "K-04", "K-05", "K-06", "K-07", "K-08", "K-09", "K-10", "K-12", "P-01", "P-02", "P-03", "P-09", "P-11", "W-02", "W-05"])
    // K-03 (diverging) draws negatives; its mixed-sign rule is another refusal and is not mirrored here
    expect(v.other.map(([c]) => c)).toEqual(["K-03"])
    for (const c of v.draws) expect(NON_NEGATIVE_CHART_CODES.has(c)).toBe(false)
    expect([...NON_NEGATIVE_CHART_CODES].filter((c) => c.startsWith("V-")).sort()).toEqual(["V-02", "V-06"])
  })

  const two = [{ name: "A", values: [4, -5, 6] }, { name: "B", values: [1, 2, 3] }]
  const one = [{ name: "A", values: [4, -5, 6] }]
  const CATEGORICAL_CODES = new Set(["P-01", "P-02", "P-09", "P-11", "K-05", "K-06", "K-07", "K-08", "K-09", "K-10", "W-02"])

  test.each([...NON_NEGATIVE_CHART_CODES].sort())("%s: a negative value is refused with path and value, by the pre-check and by the builder", (code) => {
    const series = CATEGORICAL_CODES.has(code) ? one : two
    const chart = { type: code, categories: ["x", "y", "z"], series, caption: "Uji.", source: "Sumber." }
    expect(chartCodeOf(chart as never, () => undefined, "x")).toBe(code)
    const r = refusal(() => refuseNegativeCharts([{ chart, pointer: "/sections/0/blocks/1/chart" }]))
    expect(r.code).toBe("INVALID_ARGUMENT")
    expect(r.pointer).toBe("/sections/0/blocks/1/chart/series/0/values/1")
    expect(r.details).toEqual([{ pointer: "/sections/0/blocks/1/chart/series/0/values/1", keyword: "minimum", message: expect.stringContaining("CH-01: series/0/values/1 = -5") }])
    expect(r.message).toContain(code)
    const b = refusal(() => chartBlock(chart as never, null, () => undefined, "edit 1", "Bab"))
    expect(b.code).toBe("INVALID_ARGUMENT")
    expect(b.message).toContain("CH-01: series/0/values/1 = -5")
  })

  test.each([["line", "W-01", two], ["W-03", "W-03", two], ["W-04", "W-04", one], ["W-06", "W-06", two], ["W-09", "W-09", two], ["lollipop", "P-04", one], ["dumbbell", "P-06", two], ["slope", "P-08", two], ["P-10", "P-10", one], ["small multiples", "P-12", two], ["P-14", "P-14", two], ["K-03", "K-03", two]])(
    "type %s (%s) draws negative values: accepted and stored unchanged",
    (type, code, series) => {
      const chart = { type, categories: ["x", "y", "z"], series, caption: "Uji.", source: "Sumber." }
      expect(() => refuseNegativeCharts([{ chart, pointer: "/c" }])).not.toThrow()
      const b = chartBlock(chart as never, null, () => undefined, "edit 1", "Bab") as S
      expect(b.code).toBe(code)
      expect(JSON.stringify(b.data)).toContain("-5")
    },
  )

  test("null values and zero are not negative; an intervals chart is not checked", () => {
    expect(negativeChartValues("P-03", [{ name: "A", values: [0, null, 3] }])).toEqual([])
    expect(() => refuseNegativeCharts([{ chart: W07, pointer: "/c" }])).not.toThrow()
  })

  test("studio_write: refused before the first network call, INVALID_ARGUMENT with every negative field in details", async () => {
    const { r, calls, error } = await exec("studio_write", { mission: "2026-11-17_row77", docKey: "r77", template: "latest", meta: { title: "Uji", author: "Agen" }, sections: [{ heading: "Satu", blocks: ["Teks.", { chart: { categories: ["x", "y", "z"], series: [{ name: "A", values: [4, -5, 6] }, { name: "B", values: [-1, 2, 3] }], caption: "Uji.", source: "Sumber." } }] }] })
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
    expect(error?.code).toBe("INVALID_ARGUMENT")
    expect(error?.pointer).toBe("/sections/0/blocks/1/chart/series/0/values/1")
    expect((error?.details as S[]).map((d) => [d.pointer, d.keyword])).toEqual([["/sections/0/blocks/1/chart/series/0/values/1", "minimum"], ["/sections/0/blocks/1/chart/series/1/values/0", "minimum"]])
    expect(error?.message).toContain("P-03")
    expect(error?.message).toContain("= -5")
  })

  test("studio_write of a work report (no template) keeps the chart as a table: negative values are data, not refused", async () => {
    const { error } = await exec("studio_write", { mission: "2026-11-17_row77", docKey: "lap", sections: [{ heading: "Bukti", blocks: [{ chart: { categories: ["x", "y"], series: [{ name: "Selisih", values: [4, -5] }], caption: "Uji.", source: "Sumber." } }] }] })
    expect(error?.code).not.toBe("INVALID_ARGUMENT")
  })

  test("studio_edit {figure, chart}: the code of the STORED chart decides; refused before anything is sent, pointer in the edit", () => {
    const d = storedDoc() // stored P-01
    const snap = clone(d.chart)
    let thrown: unknown
    try {
      apply(d.content, [{ find: "Pembuka", replace: "Pembuka baru" }, { figure: "Nilai per lokasi", chart: { series: [{ name: "Nilai", values: [3, -5, 2] }] } }])
    } catch (e) {
      thrown = withNegativePointer(e)
    }
    const e = thrown as McpToolError
    expect(e.code).toBe("INVALID_ARGUMENT")
    expect(e.extra.pointer).toBe("/edits/1/chart/series/0/values/1")
    expect(e.extra.details).toEqual([{ pointer: "/edits/1/chart/series/0/values/1", keyword: "minimum", message: expect.stringContaining("CH-01: series/0/values/1 = -5") }])
    expect(d.chart).toEqual(snap)
    // the same values on a stored line chart are accepted
    const line = storedDoc({ ...CHART, type: "line", series: [{ name: "Nilai", values: [3, 5, 2] }, { name: "Lain", values: [1, 1, 1] }] })
    apply(line.content, [{ figure: "Nilai per lokasi", chart: { series: [{ name: "Nilai", values: [3, -5, 2] }, { name: "Lain", values: [1, 1, 1] }] } }])
    expect(JSON.stringify(line.chart.data)).toContain("-5")
  })

  test("studio_edit append: the builder's refusal gets the pointer of the appended block", () => {
    const d = storedDoc()
    let thrown: unknown
    try {
      apply(d.content, [{ section: "Satu", append: ["Teks.", { chart: { categories: ["x", "y"], series: [{ name: "A", values: [1, -2] }], caption: "Uji.", source: "Sumber." } }] }])
    } catch (e) {
      thrown = withNegativePointer(e)
    }
    expect((thrown as McpToolError).extra.pointer).toBe("/edits/0/append/1/chart/series/0/values/1")
  })

  test("a one-series code given several series is refused (the other series used to be left out silently)", () => {
    const r = refusal(() => chartBlock({ type: "P-01", categories: ["x", "y"], series: [{ name: "A", values: [1, 2] }, { name: "B", values: [3, 4] }], caption: "Uji.", source: "S." } as never, null, () => undefined, "edit 1", "Bab"))
    expect(r.code).toBe("CHART_DATA_INVALID")
    expect(r.message).toContain("P-01 menggambar satu seri; diterima 2 seri")
    // the friendly names still pick a multi-series code
    expect((chartBlock({ type: "column", categories: ["x", "y"], series: [{ name: "A", values: [1, 2] }, { name: "B", values: [3, 4] }], caption: "Uji.", source: "S." } as never, null, () => undefined, "e", "Bab") as S).code).toBe("P-03")
  })
})

// ── 3. argument errors ──────────────────────────────────────────────────

describe("row 77 MESSAGES: the refusal names the field that is wrong", () => {
  test("a string inside edits -> /edits/0 'must be object, got string', never the bare /edits", async () => {
    const { calls, error } = await exec("studio_edit", { documentId: "cmvdoc0000000000000row77a", edits: ["ganti judul"] })
    expect(calls).toEqual([])
    expect(error?.code).toBe("INVALID_ARGUMENT")
    expect(error?.details).toEqual([{ pointer: "/edits/0", keyword: "type", message: "must be object, got string" }])
    expect(error?.message).toBe("argumen tidak sah menurut skema alat: /edits/0 must be object, got string")
    expect(JSON.stringify(error)).not.toContain('"pointer":"/edits"')
  })

  test("an edit that misses `section` -> one issue: /edits/0 must have required property 'section' (was 20 lines of every form)", async () => {
    const { error } = await exec("studio_edit", { documentId: "cmvdoc0000000000000row77a", edits: [{ find: "a b c", replace: "x" }, { append: { chart: CHART } }] })
    expect(error?.details).toEqual([{ pointer: "/edits/1", keyword: "required", message: "must have required property 'section'" }])
  })

  test("a wrong field inside one form names that field", async () => {
    const { error } = await exec("studio_edit", { documentId: "cmvdoc0000000000000row77a", edits: [{ pid: "p-abc-1", at: "nol-bukan-angka", replace: "x" }] })
    expect(error?.details).toEqual([{ pointer: "/edits/0/at", keyword: "type", message: "must be integer, got string" }])
  })

  test("'/edits must be array' appears only when edits really is not a list", async () => {
    const { error } = await exec("studio_edit", { documentId: "cmvdoc0000000000000row77a", edits: 5 })
    expect(error?.details).toEqual([{ pointer: "/edits", keyword: "type", message: "must be array, got integer" }])
  })

  test("edits sent as text that is not JSON: says so (text, not a list; cut off or wrongly quoted), nothing sent", async () => {
    const { calls, error } = await exec("studio_edit", { documentId: "cmvdoc0000000000000row77a", edits: '[{"section":"Satu","append":{"diagram":{"spec":' })
    expect(calls).toEqual([])
    expect(error?.code).toBe("INVALID_ARGUMENT")
    expect(error?.pointer).toBe("/edits")
    expect(error?.message).toContain("/edits dikirim sebagai teks, bukan larik")
    expect(error?.message).toContain("bukan JSON yang sah")
    expect((error?.details as S[])[0].message).toContain("got string (47 karakter)")
  })

  test("sections sent as text that is JSON of another kind: says so", async () => {
    const { calls, error } = await exec("studio_write", { mission: "2026-11-17_row77", docKey: "r77", sections: '"satu"' })
    expect(calls).toEqual([])
    expect(error?.pointer).toBe("/sections")
    expect(error?.message).toContain("JSON yang sah tetapi bukan larik")
  })

  test("append: the issue of the closest block form, at its field (was '/ must be string')", () => {
    const e = editArgs([{ section: "Satu", append: [{ chart: CHART }, { chart: { ...CHART, series: [{ name: "A", values: ["tiga"] }] } }] }])
    const r = refusal(() => prepareStructEdits(e.a.edits))
    expect(r.code).toBe("INVALID_ARGUMENT")
    expect(r.pointer).toBe("/edits/0/append/1/chart/series/0/values/0")
    expect(r.message).toContain("append blok 2 tidak sah (/chart/series/0/values/0 must be number or null, got string)")
    expect(r.message).not.toContain("/ must be string")
  })

  test("studio_write block: one issue at the field of the closest form", () => {
    const w = writeArgs(["Teks.", { chart: { categories: ["a"], series: [{ name: "s", values: [1] }], todayAt: 3 } }])
    expect(w.issues).toEqual([{ pointer: "/sections/0/blocks/1/chart/todayAt", keyword: "additionalProperties", message: "must NOT have additional properties" }])
    const n = writeArgs(["Teks.", 7 as never, true as never])
    expect(n.issues).toEqual([{ pointer: "/sections/0/blocks/2", keyword: "type", message: "must be string or array or object, got boolean" }])
  })

  test("closestBranchErrors keeps issues that belong to no union, in order", () => {
    const errs = [
      { instancePath: "", schemaPath: "#/required", keyword: "required", message: "must have required property 'mission'", params: {} },
      { instancePath: "/x", schemaPath: "#/properties/x/anyOf/0/type", keyword: "type", message: "must be string", params: { type: "string" } },
      { instancePath: "/x", schemaPath: "#/properties/x/anyOf/1/required", keyword: "required", message: "must have required property 'a'", params: {} },
      { instancePath: "/x", schemaPath: "#/properties/x/anyOf", keyword: "anyOf", message: "must match a schema in anyOf", params: {} },
    ]
    expect(closestBranchErrors(errs).map((e) => e.message)).toEqual(["must have required property 'mission'", "must have required property 'a'"])
  })
})

// ── 4. no silent drop ───────────────────────────────────────────────────

describe("row 77 NO SILENT DROP: every prune rule is a refusal with a path or a reported drop", () => {
  const codes = (w: S[]) => w.map((x) => x.code)
  const text = (w: S[], code: string) => w.filter((x) => x.code === code).map((x) => x.message).join(" ")

  test("F-132-3: an array-of-arrays table is stored as a table or refused by code; studio_write and studio_edit append agree", () => {
    const numeric = [["Lokasi", "Daya"], ["A", 12], ["B", 15]]
    const w = writeArgs(["Teks.", numeric], { meta: { title: "Uji", author: "Agen" } })
    expect(w.issues).toEqual([])
    const viaWrite = refusal(() => buildClient({ meta: w.a.meta, title: null, sections: w.a.sections, today: "2026-11-17" }))
    expect(viaWrite.code).toBe("CONTENT_INVALID")
    const writeCodes = ((viaWrite.details as S).issues as S[]).map((i) => i.code)
    expect(writeCodes).toEqual(["TABLE_UNIT_MISSING", "SOURCE_MISSING"])
    const d = storedDoc()
    const e = editArgs([{ section: "Satu", append: numeric }])
    prepareStructEdits(e.a.edits)
    expect(e.a.edits[0].append).toEqual([numeric])
    expect(writeCodes).toContain(refusal(() => apply(d.content, e.a.edits)).code)
    // with unit and source the same block is stored as one table by both
    const good = { table: [["Lokasi", "Daya (MW)"], ["A", 12], ["B", 15]], caption: "Daya per lokasi.", source: "Sumber sintetis." }
    const built = buildClient({ meta: { title: "Uji", author: "Agen" }, title: null, sections: writeArgs(["Teks.", good]).a.sections, today: "2026-11-17" })
    const tables = (c: S) => [...(c.intro ?? []), ...(c.sections ?? []).flatMap((s: S) => s.blocks)].filter((b: S) => b.type === "table")
    expect(tables(built.chapters[0] as S)).toHaveLength(1)
    const before = tables(d.content.sections.content.chapters[0]).length
    const goodEdit = editArgs([{ section: "Satu", append: good }])
    prepareStructEdits(goodEdit.a.edits)
    apply(d.content, goodEdit.a.edits)
    expect(tables(d.content.sections.content.chapters[0]).length).toBe(before + 1)
    expect((tables(built.chapters[0] as S)[0] as S).rows).toEqual((tables(d.content.sections.content.chapters[0]).at(-1) as S).rows)
  })

  test("a table with one bracket level too many is opened and reported (was stored as one row of JSON text)", () => {
    const w = writeArgs(["Teks.", [[["Nama", "Ket"], ["a", "x"]]]])
    expect(w.a.sections[0].blocks[1]).toEqual([["Nama", "Ket"], ["a", "x"]])
    expect(text(w.warnings, "ARG_MAPPED")).toContain("satu tingkat kurung dibuka")
  })

  test("a cell that is an object or a list is written as JSON text and reported", () => {
    const w = writeArgs([[["Nama", "Ket"], ["a", { x: 1 }]]])
    expect(w.a.sections[0].blocks[0][1][1]).toBe('{"x":1}')
    expect(text(w.warnings, "ARG_MAPPED")).toContain("sel berupa objek/larik")
  })

  test("chart: an unknown key in the chart or in a series is refused with its path (was ARG_IGNORED)", () => {
    const c = writeArgs([{ chart: { ...CHART, todayAt: 3 } }])
    expect(c.issues.map((i: S) => i.pointer)).toEqual(["/sections/0/blocks/0/chart/todayAt"])
    const s = writeArgs([{ chart: { ...CHART, series: [{ name: "Nilai", values: [3, 5, 2], color: "red" }] } }])
    expect(s.issues.map((i: S) => i.pointer)).toEqual(["/sections/0/blocks/0/chart/series/0/color"])
  })

  test("chart: a key beside `chart` is moved in (caption, source, unit, stacked, width) or named in ARG_IGNORED", () => {
    const w = writeArgs([{ chart: { categories: ["A"], series: [{ name: "N", values: [1] }] }, caption: "Cap.", width: "full", note: "x" }])
    expect(w.issues).toEqual([])
    expect(w.a.sections[0].blocks[0]).toEqual({ chart: { categories: ["A"], series: [{ name: "N", values: [1] }], caption: "Cap.", width: "full" } })
    expect(text(w.warnings, "ARG_IGNORED")).toContain("sections[0].blocks[0].note")
  })

  test("chart: `title` is read as caption (as a table does); a label that is an object is refused with its path", () => {
    const w = writeArgs([{ chart: { categories: ["A"], series: [{ name: "N", values: [1] }], title: "Judul." } }])
    expect(w.a.sections[0].blocks[0].chart.caption).toBe("Judul.")
    const bad = writeArgs([{ chart: { categories: ["A", { label: "B" }], series: [{ name: "N", values: [1, 2] }] } }])
    expect(bad.issues.map((i: S) => i.pointer)).toEqual(["/sections/0/blocks/0/chart/categories/1"])
  })

  test("paragraph and sub-heading objects: the keys left out are named (were dropped silently)", () => {
    const w = writeArgs([{ text: "Halo.", bold: true }, { heading: "Sub", level: 2 }])
    expect(w.a.sections[0].blocks).toEqual(["Halo.", { subheading: "Sub" }])
    const ig = text(w.warnings, "ARG_IGNORED")
    expect(ig).toContain("sections[0].blocks[0].bold")
    expect(ig).toContain("sections[0].blocks[1].level")
  })

  test("list: an item that is not text is refused with its path (was stored as '[object Object]'); a bad `ordered` is named", () => {
    const bad = writeArgs([{ list: ["a", { label: "b" }] }])
    expect(bad.issues.map((i: S) => i.pointer)).toEqual(["/sections/0/blocks/0/list/1"])
    const w = writeArgs([{ list: ["a", 2, { text: "c" }], ordered: "ya" }])
    expect(w.a.sections[0].blocks[0]).toEqual({ list: ["a", "2", "c"] })
    expect(text(w.warnings, "ARG_IGNORED")).toContain("sections[0].blocks[0].ordered")
  })

  test("table, section, args, ref and meta: unknown keys are named in ARG_IGNORED; a cut meta value is reported", () => {
    const w = writeArgs([{ table: [["A", "B"], ["x", "y"]], align: "left" }, { ref: { rel: "basis", documentId: "d1" }, note: 1 }], { meta: { title: "Uji", author: "Agen", extra: { a: 1 }, long: "x".repeat(2100) }, bogus: 1 })
    w.a.sections[0].zzz = 1
    const ig = text(w.warnings, "ARG_IGNORED")
    for (const k of ["sections[0].blocks[0].table.align", "sections[0].blocks[1].note", "meta.extra", "args.bogus"]) expect(ig).toContain(k)
    expect(text(w.warnings, "ARG_MAPPED")).toContain("meta.long (2100 karakter) -> dipotong 2000 karakter")
    expect(w.a.meta.long).toHaveLength(2000)
  })

  test("ARG_IGNORED names 12 keys and counts the rest", () => {
    const junk = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`k${i}`, 1]))
    const w = writeArgs(["Teks."], junk)
    expect(codes(w.warnings)).toContain("ARG_IGNORED")
    expect(text(w.warnings, "ARG_IGNORED")).toContain("(+3 lain)")
  })

  test("studio_edit: {figure} keeps chart and diagram, names any other key; other forms name what they leave out", () => {
    const e = editArgs([{ figure: "Nilai", chart: { width: "full" }, section: "Satu" }, { find: "a b c", replace: "x", occurrence: "first", note: 1 }])
    expect(e.issues).toEqual([])
    const ig = text(e.warnings, "ARG_IGNORED")
    for (const k of ["edits[0].section", "edits[1].occurrence", "edits[1].note"]) expect(ig).toContain(k)
  })
})

// ── 5. replay of the quoted round failures ──────────────────────────────

describe("row 77 REPLAY: the three quoted failures (payload class; the original payloads are not in the replay extract)", () => {
  const big = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: `Simpul nomor ${i} dengan nama yang cukup panjang`, class: { col: i % 4, row: Math.floor(i / 4) } }))
  const diagram = (n: number) => ({ diagram: { spec: { family: "flow", nodes: big(n), edges: big(n).slice(1).map((x, i) => ({ from: `n${i}`, to: x.id, kind: "data", label: `alir ${i}` })) }, caption: "Alur sintetis.", source: "Sumber sintetis." } })

  test("p3 ('/edits must be array' with `section` first in the item): edits as JSON text is read once and accepted", () => {
    const edits = [{ section: "Bukti", append: { chart: CHART } }]
    const e = editArgs(JSON.stringify(edits))
    expect(e.issues).toEqual([])
    expect(e.a.edits).toEqual(edits)
    expect(e.warnings.map((w: S) => w.code)).toContain("ARGS_PARSED")
    expect(() => prepareStructEdits(e.a.edits)).not.toThrow()
    // key order does not matter for a real list either
    expect(editArgs([{ append: { chart: CHART }, section: "Bukti" }]).issues).toEqual([])
    expect(editArgs(edits).issues).toEqual([])
  })

  test("p5 ('/sections must be array' for a whole document in one call): sections as JSON text is read once and accepted", () => {
    const sections = Array.from({ length: 12 }, (_, i) => ({ heading: `${i + 1}. Bab ${i + 1}`, blocks: ["Paragraf ".repeat(200), [["Kolom", "Isi"], ["a", "b"]]] }))
    const a: S = { mission: "2026-11-17_row77", docKey: "r77", template: "latest", sections: JSON.stringify(sections) }
    const warnings = normalizeWriteArgs(a)
    expect(JSON.stringify(sections).length).toBeGreaterThan(20000)
    expect(writeValid(a)).toBe(true)
    expect(a.sections).toHaveLength(12)
    expect(warnings.map((w: S) => w.code)).toContain("ARGS_PARSED")
  })

  test("two diagram blocks (~4.5 KB) in one studio_edit: accepted as a list and as JSON text; one edit item as text too", () => {
    const edits = [{ section: "Arsitektur", append: [diagram(16), diagram(16)] }]
    const size = JSON.stringify(edits).length
    expect(size).toBeGreaterThan(4000)
    const asList = editArgs(edits)
    expect(asList.issues).toEqual([])
    expect(() => prepareStructEdits(asList.a.edits)).not.toThrow()
    const asText = editArgs(JSON.stringify(edits))
    expect(asText.issues).toEqual([])
    expect(asText.a.edits[0].append).toHaveLength(2)
    const itemText = editArgs([JSON.stringify(edits[0])])
    expect(itemText.issues).toEqual([])
    expect(itemText.warnings.map((w: S) => w.code)).toContain("ARGS_PARSED")
  })

  test("through the tool: the text form reaches the server (the call is no longer refused as 'not an array')", async () => {
    const { calls, error } = await exec("studio_edit", { documentId: "cmvdoc0000000000000row77a", edits: JSON.stringify([{ section: "Bukti", append: "Teks." }]) })
    expect(calls.length).toBeGreaterThan(0)
    expect(error?.code).not.toBe("INVALID_ARGUMENT")
  })
})
