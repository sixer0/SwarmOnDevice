// Swarm 1.3.3 row 39 (ST-2 write side; register 03 §6; contract_row25_landed.md): the MCP tool input copies of the
// figure contract accept what the contract schema accepts.
// - studio_write chart block: `chart.intervals` (W-07) with `statusAt` and `timeUnit` beside it, items carrying
//   `float` and `critical`, normalised to `data {shape:"intervals", items, statusAt?, timeUnit?}` with the values
//   unchanged; a malformed interval is refused naming the field; `width` on the chart and diagram block.
// - studio_figure_revise: `width` is a patch key of charts and diagrams.
// - DRIFT: the tool reads its key lists and its validator from the contract schema; this file fails when a key the
//   contract accepts is dropped or refused by the tool input, or when a tool key is not a contract key.
// Pure (no port). Stored-content checks over the real host: row39-tool-input-host.test.ts.
// Red before the row: `chart.intervals` is pruned (ARG_IGNORED) and the block refused for missing categories/series.
import { describe, expect, test } from "bun:test"
import Ajv from "ajv"
import { commonV2Schema, FIGURE_WIDTH_VALUES } from "../../vendor/src/lib/studio/contract/schema/v2/common.schema"
import { validateBlockV2 } from "../../vendor/src/lib/studio/services/revisions/v2/body"
import { CHART_PATCH_KEYS, DIAGRAM_PATCH_KEYS, mergeFigurePatch } from "../../vendor/scripts/studio/mcp/figure-tools"
import { TOOLS } from "../../vendor/scripts/studio/mcp/tools"
import { chapterOf, chartBlock } from "../../vendor/scripts/studio/mcp/write-client"
import { buildWorkReport } from "../../vendor/scripts/studio/mcp/write-content"
import { normalizeWriteArgs } from "../../vendor/scripts/studio/mcp/write-normalize"
import { prepareStructEdits } from "../../vendor/scripts/studio/mcp/write-tools"

type S = Record<string, any>
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const defs = commonV2Schema.$defs as unknown as S
const INTERVALS = (defs.ChartDataV2.oneOf as S[]).find((v) => v.properties?.shape?.const === "intervals") as S
const ITEM = INTERVALS.properties.items.items as S

/** The payload of the test report (hasil2/u3-siber-proyek): chart.intervals, now with the row 25 fields. */
const W07 = {
  type: "W-07",
  intervals: [
    { label: "Survei lokasi", start: 0, end: 2, group: "Persiapan" },
    { label: "Pengadaan", start: 2, end: 7, float: 1.5 },
    { label: "Instalasi", start: 6, end: 10, critical: true, float: 0 },
    { label: "Serah terima", start: 14, end: 14, milestone: true, critical: true },
  ],
  statusAt: 8,
  timeUnit: "minggu",
  caption: "Serah terima jatuh pada minggu ke-14.",
  source: "Sumber sintetis uji.",
}

const writeSchema = (TOOLS.find((t) => t.name === "studio_write") as S).inputSchema
const writeValid = new Ajv({ allErrors: true, strict: true }).compile(writeSchema)
/** normalise (the tool's `prepare`) then the tool input schema; returns warnings, schema errors and the chart block input. */
function prepared(block: S, template: string | null = "datum-nota") {
  const a: S = { mission: "2026-11-17_row39", docKey: "r39", ...(template !== null ? { template } : {}), sections: [{ heading: "Jadwal", blocks: [clone(block)] }] }
  const warnings = normalizeWriteArgs(a)
  const ok = writeValid(a)
  return { a, warnings, ok, errors: (writeValid.errors ?? []).map((e) => `${e.instancePath} ${e.message}`), block: a.sections[0].blocks[0] as S }
}
function built(chart: S) {
  const issues: S[] = []
  const warns: S[] = []
  const b = chartBlock(chart as never, null, (w) => warns.push(w), "bagian 1 blok 1", "Jadwal", (i) => issues.push(i))
  return { b, issues, warns }
}

describe("row 39: studio_write chart block accepts the W-07 intervals shape", () => {
  test("chart.intervals + statusAt + timeUnit pass normalise and the input schema; nothing is ignored", () => {
    const p = prepared({ chart: W07 })
    expect(p.errors).toEqual([])
    expect(p.warnings.filter((w: S) => w.code === "ARG_IGNORED")).toEqual([])
    expect(p.block.chart.intervals).toEqual(W07.intervals)
    expect(p.block.chart.statusAt).toBe(8)
    expect(p.block.chart.timeUnit).toBe("minggu")
  })

  test("the built block carries data {shape:intervals} with the given values unchanged and is a valid ChartV2", () => {
    const { b, issues } = built(prepared({ chart: W07 }).block.chart)
    expect(issues).toEqual([])
    expect(b.type).toBe("chart")
    expect(b.code).toBe("W-07")
    expect(b.data).toEqual({ shape: "intervals", items: W07.intervals, statusAt: 8, timeUnit: "minggu" })
    expect(validateBlockV2(b, "/chart")).toEqual([])
  })

  test("without `type` the code is W-07; a string statusAt and no timeUnit are kept as given", () => {
    const { type: _t, timeUnit: _u, ...rest } = W07
    const { b, issues } = built(prepared({ chart: { ...rest, statusAt: "2026-12-01", intervals: [{ label: "A", start: "2026-11-01", end: "2026-12-15" }] } }).block.chart)
    expect(issues).toEqual([])
    expect(b.code).toBe("W-07")
    expect(b.data).toEqual({ shape: "intervals", items: [{ label: "A", start: "2026-11-01", end: "2026-12-15" }], statusAt: "2026-12-01" })
    expect(validateBlockV2(b, "/chart")).toEqual([])
  })

  test("the contract's own data shape (chart.data {shape:intervals,...}) is lifted to the same block (one payload)", () => {
    const data = { shape: "intervals", items: W07.intervals, statusAt: 8, timeUnit: "minggu" }
    const p = prepared({ chart: { type: "W-07", data, caption: W07.caption, source: W07.source } })
    expect(p.errors).toEqual([])
    expect(p.warnings.some((w: S) => w.code === "ARG_MAPPED")).toBe(true)
    const { b, issues } = built(p.block.chart)
    expect(issues).toEqual([])
    expect(b.data).toEqual(data)
  })

  test("a whole section goes through chapterOf with the block in place", () => {
    const p = prepared({ chart: W07 })
    const ch = chapterOf(p.a.sections[0], "1", "Jadwal", null, () => undefined, "bagian 1") as S
    const blocks = JSON.stringify(ch)
    expect(blocks).toContain('"shape":"intervals"')
    expect(blocks).toContain('"timeUnit":"minggu"')
  })

  test("the categories x series chart is untouched (no intervals keys, same data as before)", () => {
    const p = prepared({ chart: { categories: ["a", "b"], series: [{ name: "s", values: [1, 2] }], caption: "Uji.", source: "Sumber." } })
    expect(p.errors).toEqual([])
    const { b } = built(p.block.chart)
    expect(b).toEqual({ type: "chart", code: "P-02", data: { shape: "categorical", points: [{ label: "a", value: 1 }, { label: "b", value: 2 }] }, caption: { text: "Uji." }, source: { text: "Sumber." } })
  })
})

describe("row 39: a malformed interval is refused naming the field", () => {
  const bad = (mut: (c: S) => void): S => {
    const c = clone(W07) as S
    mut(c)
    const p = prepared({ chart: c })
    if (!p.ok) return { stage: "schema", text: p.errors.join("; ") }
    const { b, issues } = built(p.block.chart)
    return { stage: "build", b, issues, text: issues.map((i) => `${i.code} ${i.message}`).join("; ") }
  }
  test("negative float", () => {
    const r = bad((c) => (c.intervals[1].float = -1))
    expect(r.b).toEqual({})
    expect(r.issues[0].code).toBe("CHART_DATA_INVALID")
    expect(r.text).toContain("/intervals/1/float")
  })
  test("critical that is not a boolean", () => {
    expect(bad((c) => (c.intervals[2].critical = "ya")).text).toContain("/intervals/2/critical")
  })
  test("missing end", () => {
    const r = bad((c) => delete c.intervals[0].end)
    expect(r.text).toContain("/intervals/0")
    expect(r.text).toContain("end")
  })
  test("unknown item field (slack) and a field of another name (todayAt inside data)", () => {
    expect(bad((c) => (c.intervals[0].slack = 2)).text).toContain("/intervals/0/slack")
  })
  test("timeUnit longer than the contract allows, statusAt of the wrong type", () => {
    expect(bad((c) => (c.timeUnit = "m".repeat(41))).text).toContain("/timeUnit")
    expect(bad((c) => (c.statusAt = true)).text).toContain("/statusAt")
  })
  test("intervals that is not an array of objects, or empty: refused by the input schema with its pointer", () => {
    const a = bad((c) => (c.intervals = "0-2"))
    expect(a.stage).toBe("schema")
    expect(a.text).toContain("/sections/0/blocks/0/chart/intervals")
    expect(bad((c) => (c.intervals = [])).text).toContain("/chart/intervals")
  })
  test("statusAt without intervals, and intervals together with series, are refused", () => {
    const p = prepared({ chart: { statusAt: 3, categories: ["a"], series: [{ name: "s", values: [1] }], caption: "x", source: "y" } })
    const r = built(p.block.chart)
    expect(r.b).toEqual({})
    expect(r.issues[0].message).toContain("intervals")
    const both = built({ ...clone(W07), categories: ["a"], series: [{ name: "s", values: [1] }] })
    expect(both.b).toEqual({})
    expect(both.issues[0].message).toContain("/categories")
  })
  test("a chart with neither categories+series nor intervals is refused by the input schema", () => {
    const p = prepared({ chart: { caption: "x", source: "y" } })
    expect(p.ok).toBe(false)
    expect(p.errors.join("; ")).toContain("/sections/0/blocks/0/chart")
  })
})

describe("row 39: width on figure blocks", () => {
  test("chart: width text/full passes and is stored on the block; another value is refused naming the field", () => {
    for (const width of FIGURE_WIDTH_VALUES) {
      const p = prepared({ chart: { ...W07, width } })
      expect(p.errors).toEqual([])
      const { b, issues } = built(p.block.chart)
      expect(issues).toEqual([])
      expect(b.width).toBe(width)
      expect(validateBlockV2(b, "/chart")).toEqual([])
    }
    const series = prepared({ chart: { categories: ["a", "b"], series: [{ name: "s", values: [1, 2] }], caption: "Uji.", source: "Sumber.", width: "full" } })
    expect(series.errors).toEqual([])
    expect(built(series.block.chart).b.width).toBe("full")
    const bad = prepared({ chart: { ...W07, width: "166mm" } })
    expect(bad.ok).toBe(false)
    expect(bad.errors.join("; ")).toContain("/sections/0/blocks/0/chart/width")
  })
  test("chart: width beside the chart key is moved into it (as caption/source are)", () => {
    const p = prepared({ chart: clone(W07), width: "full" })
    expect(p.errors).toEqual([])
    expect(p.block.chart.width).toBe("full")
  })
  test("no width given: none is written (absent = the template parameter)", () => {
    expect("width" in built(prepared({ chart: W07 }).block.chart).b).toBe(false)
  })
  test("diagram: width passes the input schema and reaches the DiagramV2 block; a bad value names /diagram/width", () => {
    const spec = { family: "flow", nodes: [{ id: "a", label: "Mulai", class: { col: 0, row: 0 } }, { id: "b", label: "Selesai", class: { col: 0, row: 1 } }], edges: [{ from: "a", to: "b", kind: "data", label: "lanjut" }] }
    const p = prepared({ diagram: { spec, caption: "Alur sintetis.", source: "Sumber sintetis.", width: "full" } })
    expect(p.errors).toEqual([])
    const issues: S[] = []
    const ch = chapterOf(p.a.sections[0], "1", "Jadwal", null, () => undefined, "bagian 1", (i) => issues.push(i)) as S
    expect(issues).toEqual([])
    expect(JSON.stringify(ch)).toContain('"width":"full"')
    const q = prepared({ diagram: { spec, caption: "Alur sintetis.", source: "Sumber sintetis.", width: "lebar" } })
    const bad: S[] = []
    chapterOf(q.a.sections[0], "1", "Jadwal", null, () => undefined, "bagian 1", (i) => bad.push(i))
    expect(bad.map((i) => i.message).join("; ")).toContain("/diagram/width")
  })
  test("studio_figure_revise: width is a patch key of charts and diagrams; merge sets and removes it", () => {
    expect(CHART_PATCH_KEYS as readonly string[]).toContain("width")
    expect(DIAGRAM_PATCH_KEYS as readonly string[]).toContain("width")
    const stored = { type: "chart", code: "W-07", data: { shape: "intervals", items: W07.intervals }, caption: { text: "x" }, source: { text: "y" } }
    const full = mergeFigurePatch(stored, { width: "full" })
    expect(full).toEqual({ ...stored, width: "full" })
    expect(validateBlockV2(full, "/chart")).toEqual([])
    expect("width" in mergeFigurePatch(full, { width: null })).toBe(false)
  })
})

describe("row 39: studio_edit append and the work report take the same chart block", () => {
  test("append: the W-07 block passes the block schema; a bad width is refused", () => {
    const ok: S[] = [{ section: "Jadwal", append: { chart: clone(W07) } }]
    expect(() => prepareStructEdits(ok)).not.toThrow()
    // The refusal text of studio_edit names only the first schema error of the block union ("/ must be string"):
    // naming the field there is row 77 (ST-10 messages). Here: refused before anything is written.
    expect(() => prepareStructEdits([{ section: "Jadwal", append: { chart: { ...clone(W07), width: "x" } } }])).toThrow(/append blok 1 tidak sah/)
  })
  test("work report (no figures): the intervals chart is written as a table of its items; a malformed one is refused", () => {
    const base = { mission: "2026-11-17_row39", docKey: "r39", title: null, meta: {}, agentId: null, now: new Date("2026-11-17T03:00:00Z") }
    const p = prepared({ chart: W07 }, null)
    const r = buildWorkReport({ ...base, sections: p.a.sections } as never)
    expect(r.warnings.some((w) => w.code === "CHART_AS_TABLE")).toBe(true)
    expect(r.markdown).toContain("| label | start | end | group | milestone | float | critical |")
    expect(r.markdown).toContain("| Pengadaan | 2 | 7 |")
    const c = clone(W07) as S
    c.intervals[1].float = -1
    expect(() => buildWorkReport({ ...base, sections: prepared({ chart: c }, null).a.sections } as never)).toThrow(/\/intervals\/1\/float/)
  })
})

describe("row 39 DRIFT: tool input versus the contract schema", () => {
  /** A value the property schema accepts (boolean, number, string, or a number-or-string union). */
  const sample = (s: S): unknown => {
    const t = Array.isArray(s.type) ? s.type[0] : s.type
    return t === "boolean" ? true : t === "number" || t === "integer" ? 1 : "x"
  }
  /** Properties of the chart block in the studio_write input schema (tools/list). */
  const CHART_INPUT = (((writeSchema as S).properties.sections.items.properties.blocks.items.anyOf as S[]).find((b) => b.properties?.chart) as S).properties.chart.properties as S
  const dataKeys = Object.keys(INTERVALS.properties).filter((k) => k !== "shape" && k !== "items")
  const itemKeys = Object.keys(ITEM.properties)

  test("the names are the ones the landed contract carries (register 03 §6)", () => {
    expect(dataKeys).toEqual(["statusAt", "timeUnit"])
    expect(itemKeys).toEqual(["label", "start", "end", "group", "milestone", "float", "critical"])
  })

  test("the tool's key lists are read from the contract", async () => {
    const m = await import("../../vendor/scripts/studio/mcp/write-figure-input")
    expect([...m.CHART_INTERVALS_DATA_KEYS]).toEqual(dataKeys)
    expect([...m.CHART_INTERVALS_ITEM_KEYS]).toEqual(itemKeys)
    expect([...m.CHART_INTERVALS_INPUT_KEYS]).toEqual(["intervals", ...dataKeys])
    const chartProps = Object.keys(CHART_INPUT)
    for (const k of ["intervals", ...dataKeys, "width"]) expect(chartProps).toContain(k)
    const list = CHART_INPUT.intervals
    expect(list.minItems).toBe(INTERVALS.properties.items.minItems)
    expect(list.maxItems).toBe(INTERVALS.properties.items.maxItems)
  })

  test("every field the contract's intervals shape accepts survives normalise + schema + build unchanged", () => {
    const item = Object.fromEntries(itemKeys.map((k) => [k, sample(ITEM.properties[k])]))
    const data = Object.fromEntries(dataKeys.map((k) => [k, sample(INTERVALS.properties[k])]))
    const p = prepared({ chart: { intervals: [item], ...data, caption: "Uji.", source: "Sumber." } })
    expect(p.errors).toEqual([])
    expect(p.warnings.filter((w: S) => w.code === "ARG_IGNORED")).toEqual([])
    const { b, issues } = built(p.block.chart)
    expect(issues).toEqual([])
    expect(b.data).toEqual({ shape: "intervals", items: [item], ...data })
    expect(validateBlockV2(b, "/chart")).toEqual([])
  })

  test("width: the input enum equals the contract enum of the chart, diagram and image blocks", () => {
    const chart = CHART_INPUT
    expect(chart.width.enum).toEqual([...FIGURE_WIDTH_VALUES])
    for (const d of ["ChartV2", "DiagramV2", "ImageV2"]) expect(defs[d].properties.width.enum, d).toEqual(chart.width.enum)
  })

  test("every studio_figure_revise patch key is a field of its contract block", () => {
    for (const k of CHART_PATCH_KEYS) expect(Object.keys(defs.ChartV2.properties), k).toContain(k)
    for (const k of DIAGRAM_PATCH_KEYS) expect(Object.keys(defs.DiagramV2.properties), k).toContain(k)
  })
})
