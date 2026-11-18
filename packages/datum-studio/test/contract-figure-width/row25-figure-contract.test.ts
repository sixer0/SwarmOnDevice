// Swarm 1.3.3 row 25 (ST-1, ST-2; register 03 section 6): the figure contract.
// (a) `width` ("text" = 128 mm, "full" = 166 mm; schema default "text") on ChartV2, DiagramV2 and ImageV2 blocks.
//     The name `widthClass` stays a DISPLAY_FIELD in blocks (DF-66..DF-70 unchanged); SymbolSheetV2 and
//     ChartPanelV2 take no `width`.
// (b) W-07 intervals: item fields `float` (number >= 0) and `critical` (boolean); data fields `statusAt`
//     (number or string) and `timeUnit` (string 1..40), in studio.doc/v2 (ChartDataV2) and studio.chart/v1 (ChartData).
// Contract only: no engine, layout, preview or render behaviour is tested here.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import path from "node:path"
import { BLOCK_AT, probeDoc, setAt } from "../ported/structure/_kit"

const V = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio")
const { validateV2Against, validateAgainst } = await import(path.join(V, "services", "ingest", "validate.ts"))
const common = await import(path.join(V, "contract", "schema", "v2", "common.schema.ts"))
const chartV1 = await import(path.join(V, "contract", "schema", "chart.schema.ts"))
const forbidden = await import(path.join(V, "contract", "schema", "v2", "forbidden.ts"))

type Rec = Record<string, any>
const CHART = BLOCK_AT(7)
const PANEL = `${BLOCK_AT(8)}/panels/0`
const DIAGRAM = BLOCK_AT(9)
const IMAGE = BLOCK_AT(10)
const SYMBOL = BLOCK_AT(11)

function withField(parent: string, field: string, value: unknown) {
  const doc = probeDoc()
  setAt(doc, `${parent}/${field}`, value)
  return validateV2Against("studio.doc/v2", doc) as Array<{ checkId?: string; pointer: string; message: string }>
}

const intervals = (extra: Rec = {}, item: Rec = {}) => ({
  shape: "intervals",
  items: [
    { label: "Desain", start: 1, end: 4, ...item },
    { label: "BAST", start: 6, end: 6, milestone: true },
  ],
  ...extra,
})

function withChartData(data: unknown) {
  const doc = probeDoc()
  setAt(doc, `${CHART}/code`, "W-07")
  setAt(doc, `${CHART}/data`, data)
  return validateV2Against("studio.doc/v2", doc) as Array<{ checkId?: string; pointer: string; message: string }>
}

const v1Chart = (data: unknown) => ({
  $schema: "studio.chart/v1",
  kind: "W-07",
  title: "Jadwal",
  source: "Rencana proyek",
  widthMm: 128,
  data,
})

describe("row 25 width: exported names", () => {
  test("values, default and millimetres", () => {
    expect([...common.FIGURE_WIDTH_VALUES]).toEqual(["text", "full"])
    expect(common.FIGURE_WIDTH_DEFAULT).toBe("text")
    expect(common.FIGURE_WIDTH_MM).toEqual({ text: 128, full: 166 })
  })
  test("schema: enum with default `text` on ChartV2, DiagramV2, ImageV2 only", () => {
    const defs = common.commonV2Schema.$defs as Rec
    for (const d of ["ChartV2", "DiagramV2", "ImageV2"]) {
      expect(defs[d].properties.width, d).toEqual({ enum: ["text", "full"], default: "text" })
      expect(defs[d].required, d).not.toContain("width")
    }
    for (const d of ["SymbolSheetV2", "ChartPanelV2", "ChartCustomFormV2", "DiagramSpecV2", "TableV2"]) {
      expect(defs[d].properties.width, d).toBeUndefined()
    }
  })
})

describe("row 25 width: studio.doc/v2", () => {
  test("baseline probe document without `width` is valid (absent = default)", () => {
    expect(validateV2Against("studio.doc/v2", probeDoc())).toEqual([])
  })
  test.each([
    ["chart", CHART, "text"],
    ["chart", CHART, "full"],
    ["diagram", DIAGRAM, "text"],
    ["diagram", DIAGRAM, "full"],
    ["image", IMAGE, "text"],
    ["image", IMAGE, "full"],
  ])("%s block accepts width %s", (_kind, parent, value) => {
    expect(withField(parent as string, "width", value)).toEqual([])
  })
  test.each([
    ["chart", CHART, "wide"],
    ["diagram", DIAGRAM, 166],
    ["image", IMAGE, ""],
    ["chart", CHART, null],
  ])("%s block refuses width %p", (_kind, parent, value) => {
    const issues = withField(parent as string, "width", value)
    expect(issues.length).toBeGreaterThan(0)
    expect(issues.some((i) => i.pointer.startsWith(`${parent}/width`) || i.pointer === parent)).toBe(true)
  })
  test("composite chart block accepts width; a panel does not", () => {
    expect(withField(BLOCK_AT(8), "width", "full")).toEqual([])
    expect(withField(PANEL, "width", "full").length).toBeGreaterThan(0)
  })
  test("symbolSheet block still takes no width", () => {
    expect(withField(SYMBOL, "width", "full").length).toBeGreaterThan(0)
  })
  test("`widthClass` stays DISPLAY_FIELD in blocks (DF-66..DF-70 unchanged)", () => {
    const F = forbidden.DISPLAY_FIELDS_BY_LOCATION as Rec
    expect(["DF-66", "DF-67", "DF-68", "DF-69", "DF-70"].map((id) => [F[id].location, F[id].fields])).toEqual([
      ["ImageV2", ["widthClass"]],
      ["SymbolSheetV2", ["widthClass"]],
      ["ChartV2", ["widthClass"]],
      ["DiagramV2", ["widthClass"]],
      ["ChartPanelV2", ["widthClass"]],
    ])
    for (const parent of [IMAGE, SYMBOL, CHART, DIAGRAM, PANEL]) {
      const hits = withField(parent, "widthClass", "full").filter((i) => i.checkId === "DISPLAY_FIELD")
      expect(hits.map((h) => h.pointer)).toEqual([`${parent}/widthClass`])
    }
  })
  test("`width` beside `widthClass`: only widthClass is reported as DISPLAY_FIELD", () => {
    const doc = probeDoc()
    setAt(doc, `${CHART}/width`, "full")
    setAt(doc, `${CHART}/widthClass`, "full")
    const hits = (validateV2Against("studio.doc/v2", doc) as Array<{ checkId?: string; pointer: string }>).filter((i) => i.checkId === "DISPLAY_FIELD")
    expect(hits.map((h) => h.pointer)).toEqual([`${CHART}/widthClass`])
  })
})

describe("row 25 W-07 intervals: studio.doc/v2 ChartDataV2", () => {
  test("existing shape still valid", () => {
    expect(withChartData(intervals())).toEqual([])
  })
  test("accepts float, critical, statusAt (number), timeUnit", () => {
    expect(withChartData(intervals({ statusAt: 3, timeUnit: "minggu" }, { float: 2, critical: true, group: "Fase 1" }))).toEqual([])
  })
  test("accepts float 0, critical false, statusAt as ISO date string", () => {
    const data = {
      shape: "intervals",
      items: [{ label: "Desain", start: "2026-01-05", end: "2026-02-02", float: 0, critical: false }],
      statusAt: "2026-01-19",
      timeUnit: "hari",
    }
    expect(withChartData(data)).toEqual([])
  })
  test.each([
    ["float negative", intervals({}, { float: -1 })],
    ["float string", intervals({}, { float: "2" })],
    ["critical string", intervals({}, { critical: "ya" })],
    ["statusAt boolean", intervals({ statusAt: true })],
    ["statusAt empty string", intervals({ statusAt: "" })],
    ["timeUnit empty", intervals({ timeUnit: "" })],
    ["timeUnit 41 chars", intervals({ timeUnit: "m".repeat(41) })],
    ["timeUnit number", intervals({ timeUnit: 7 })],
    ["unknown item field", intervals({}, { slack: 2 })],
    ["unknown data field", intervals({ todayAt: 3 })],
  ])("refuses %s", (_name, data) => {
    expect(withChartData(data).length).toBeGreaterThan(0)
  })
  test("item cap stays 200", () => {
    const item = (i: number) => ({ label: `T${i}`, start: i, end: i + 1, float: 0, critical: i % 2 === 0 })
    expect(withChartData({ shape: "intervals", items: Array.from({ length: 200 }, (_, i) => item(i)) })).toEqual([])
    expect(withChartData({ shape: "intervals", items: Array.from({ length: 201 }, (_, i) => item(i)) }).length).toBeGreaterThan(0)
  })
  test("statusAt and timeUnit are refused on another shape", () => {
    const doc = probeDoc()
    setAt(doc, `${CHART}/data/statusAt`, 3)
    expect(validateV2Against("studio.doc/v2", doc).length).toBeGreaterThan(0)
    const doc2 = probeDoc()
    setAt(doc2, `${CHART}/data/timeUnit`, "minggu")
    expect(validateV2Against("studio.doc/v2", doc2).length).toBeGreaterThan(0)
  })
  test("a panel's intervals data takes the same fields", () => {
    const doc = probeDoc()
    setAt(doc, `${PANEL}/code`, "W-07")
    setAt(doc, `${PANEL}/data`, intervals({ statusAt: 3, timeUnit: "minggu" }, { float: 1, critical: true }))
    expect(validateV2Against("studio.doc/v2", doc)).toEqual([])
  })
})

describe("row 25 W-07 intervals: studio.chart/v1 ChartData (same fields, one contract)", () => {
  test("existing shape still valid", () => {
    expect(validateAgainst("studio.chart/v1", v1Chart(intervals()))).toEqual([])
  })
  test("accepts float, critical, statusAt, timeUnit", () => {
    expect(validateAgainst("studio.chart/v1", v1Chart(intervals({ statusAt: 3, timeUnit: "minggu" }, { float: 2, critical: true })))).toEqual([])
    expect(validateAgainst("studio.chart/v1", v1Chart(intervals({ statusAt: "2026-01-19" }, { float: 0, critical: false })))).toEqual([])
  })
  test.each([
    ["float negative", intervals({}, { float: -0.5 })],
    ["critical number", intervals({}, { critical: 1 })],
    ["statusAt object", intervals({ statusAt: {} })],
    ["timeUnit 41 chars", intervals({ timeUnit: "m".repeat(41) })],
    ["unknown data field", intervals({ todayAt: 3 })],
  ])("refuses %s", (_name, data) => {
    expect(validateAgainst("studio.chart/v1", v1Chart(data)).length).toBeGreaterThan(0)
  })
  test("v1 and v2 intervals variants declare the same item and data fields", () => {
    const pick = (variants: Rec[]) => variants.find((v) => v.properties?.shape?.const === "intervals") as Rec
    const v1 = pick((chartV1.chartSchema.$defs as Rec).ChartData.oneOf)
    const v2 = pick((common.commonV2Schema.$defs as Rec).ChartDataV2.oneOf)
    const fields = (v: Rec) => ({
      data: Object.keys(v.properties).sort(),
      item: Object.keys(v.properties.items.items.properties).sort(),
      required: v.properties.items.items.required,
      float: v.properties.items.items.properties.float,
      critical: v.properties.items.items.properties.critical,
      statusAt: v.properties.statusAt,
      timeUnit: v.properties.timeUnit,
    })
    expect(fields(v1)).toEqual(fields(v2))
    expect(fields(v2)).toEqual({
      data: ["items", "shape", "statusAt", "timeUnit"],
      item: ["critical", "end", "float", "group", "label", "milestone", "start"],
      required: ["label", "start", "end"],
      float: { type: "number", minimum: 0 },
      critical: { type: "boolean" },
      statusAt: { type: ["number", "string"], minLength: 1, maxLength: 200 },
      timeUnit: { type: "string", minLength: 1, maxLength: 40 },
    })
    expect(v2.properties.items.maxItems).toBe(200)
  })
})
