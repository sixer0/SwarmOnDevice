// Swarm 1.3.3 row 38 (ST-2, register 03 section 6; contract of row 25): the W-07 renderer draws the schedule fields.
// Reference case = the manual's master schedule, Figure 29.6 on sheet 347 (replay R8): 14 tasks, 5 milestones, status
// line at week 10, critical path 27 weeks. The fixture is a transcription (provenance inside the file).
// Asserted structurally on the SVG, never by pixels:
//   bars on a week axis, a float tail after every non-critical bar with float > 0, 5 milestone markers, one status
//   line at week 10, the accent colour on critical bars only (one accent subject, DATUM-26), critical path = 27 weeks.
// One contract: the same v2 block passes the write schema, the preview path and the render path, with equal bytes.
// Red before the change: float, critical, statusAt and timeUnit were not read by gantt.ts.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { readFileSync } from "node:fs"
import path from "node:path"
import { BLOCK_AT, probeDoc, setAt } from "../ported/structure/_kit"
import * as chartCore from "../../vendor/src/lib/studio/engine/chart/core"
import * as geometry from "../../vendor/src/lib/studio/engine/chart/core/geometry"
import { chartSvg } from "../../vendor/src/lib/studio/services/render/figures"
import { glyphSet, mapBlock } from "../../vendor/src/lib/studio/services/compose"
import * as preview from "../../src/mcp-host/local-api/routes/figure-preview-figure"

type J = any
const V = path.resolve(import.meta.dir, "..", "..", "vendor", "src", "lib", "studio")
const { validateV2Against, validateAgainst } = await import(path.join(V, "services", "ingest", "validate.ts"))

const FIX = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "r8_p347_master_schedule.json"), "utf8"))
const BLOCK: J = FIX.block
const ITEMS: J[] = BLOCK.data.items
const TASKS = ITEMS.filter((it) => it.milestone !== true)
const MILESTONES = ITEMS.filter((it) => it.milestone === true)
const TPL = (chartCore as J).EMPTY_CHART_TEMPLATE
const PAL = (chartCore as J).chartPalette({ widthMm: 128 }, TPL)
const hex = (c: string): string => `#${c.replace(/^#/, "").toUpperCase()}`
const ACCENT = hex(PAL.role.accent)

/** The internal chart spec of the v2 block, through compose (the path write, preview and render share). */
function specOf(block: J): J {
  const content: J = mapBlock(structuredClone(block), "p-row38", { glyphs: glyphSet(undefined), params: {}, classification: "" } as J)
  return content.spec
}
const v1 = (data: J, extra: J = {}): J => ({ $schema: "studio.chart/v1", kind: "W-07", title: "Jadwal", source: "Uji row 38", widthMm: 128, data, ...extra })
const render = (spec: J): { svg: string; report: J } => (chartCore as J).renderChart(structuredClone(spec), TPL)

interface El {
  tag: string
  a: Record<string, string>
  text?: string
}
function elements(svg: string): El[] {
  const out: El[] = []
  for (const m of svg.matchAll(/<([a-zA-Z]+)\b([^>]*?)\/?>(?:([^<]*)<\/text>)?/g)) {
    const a: Record<string, string> = {}
    for (const p of m[2].matchAll(/([\w:-]+)="([^"]*)"/g)) a[p[1]] = p[2]
    out.push({ tag: m[1], a, ...(m[1] === "text" ? { text: m[3] ?? "" } : {}) })
  }
  return out
}
const n = (v: string | undefined): number => Number(v)

/** Week -> mm, measured from the printed tick labels of the x axis (no engine internals). */
function weekScale(svg: string): { at: (week: number) => number; perWeek: number; ticks: number[] } {
  const axis = /<g data-axis="x">([\s\S]*?)<\/g>/.exec(svg)?.[1] ?? ""
  const ticks = elements(axis).filter((e) => e.tag === "text" && /^\d+$/.test(e.text ?? "") && e.a["text-anchor"] === "middle")
  expect(ticks.length, "numeric tick labels on the x axis").toBeGreaterThanOrEqual(2)
  const first = ticks[0]
  const last = ticks[ticks.length - 1]
  const perWeek = (n(last.a.x) - n(first.a.x)) / (n(last.text) - n(first.text))
  const x0 = n(first.a.x) - n(first.text) * perWeek
  return { at: (w) => x0 + w * perWeek, perWeek, ticks: ticks.map((t) => n(t.text)) }
}

describe("row 38 fixture: the manual's schedule, sheet 347 (R8)", () => {
  test("14 tasks, 5 milestones, status at week 10, unit minggu, nothing marked illegible", () => {
    expect(TASKS.length).toBe(14)
    expect(MILESTONES.length).toBe(5)
    expect(BLOCK.data.statusAt).toBe(10)
    expect(BLOCK.data.timeUnit).toBe("minggu")
    expect(FIX._provenance.illegible).toEqual([])
  })
  test("critical tasks are exactly those with float 0, chain end to start, and sum to 27 weeks", () => {
    const crit = TASKS.filter((t) => t.critical === true)
    expect(crit.map((t) => t.label[0]).join("")).toBe("ABCEGJLN")
    for (const t of TASKS) expect(t.critical === true, t.label).toBe(t.float === 0)
    for (let i = 1; i < crit.length; i++) expect(crit[i].start, crit[i].label).toBe(crit[i - 1].end)
    expect(crit.reduce((s, t) => s + (t.end - t.start), 0)).toBe(27)
    expect(crit[crit.length - 1].end).toBe(27)
  })
  test("write contract: the block passes studio.doc/v2 and the resolved spec passes studio.chart/v1", () => {
    const doc = probeDoc()
    for (const k of ["code", "data", "caption", "source"]) setAt(doc, `${BLOCK_AT(7)}/${k}`, BLOCK[k])
    const at = (validateV2Against("studio.doc/v2", doc) as J[]).filter((e) => String(e.pointer).startsWith(BLOCK_AT(7)))
    expect(at).toEqual([])
    const spec = specOf(BLOCK)
    expect(spec.data).toEqual(BLOCK.data)
    expect(validateAgainst("studio.chart/v1", v1(BLOCK.data))).toEqual([])
  })
})

describe("row 38 render: W-07 draws float, critical accent, status line and time unit", () => {
  const spec = specOf(BLOCK)
  const res = render(spec)
  const els = elements(res.svg)
  const scale = weekScale(res.svg)
  const bars = els.filter((e) => e.tag === "rect" && e.a["data-mark"] === "interval")

  test("14 bars on a week axis, each drawn to scale", () => {
    expect(bars.length).toBe(14)
    expect(scale.ticks[0]).toBe(0)
    expect(scale.ticks[scale.ticks.length - 1]).toBeGreaterThanOrEqual(27)
    expect(scale.perWeek).toBeGreaterThan(1)
    bars.forEach((b) => {
      const t = ITEMS[n(b.a["data-index"])]
      expect(n(b.a.x), `${t.label} start`).toBeCloseTo(scale.at(t.start), 1)
      expect(n(b.a.width), `${t.label} length`).toBeCloseTo((t.end - t.start) * scale.perWeek, 1)
    })
    // The unit word is printed on the axis.
    const unit = els.filter((e) => e.tag === "text" && e.a["data-axis-unit"] !== undefined)
    expect(unit.map((u) => u.text)).toEqual(["minggu"])
  })

  test("a float tail after every non-critical bar with float > 0, from the bar end to the late finish", () => {
    const want = TASKS.filter((t) => t.float > 0)
    expect(want.map((t) => t.label[0]).join("")).toBe("DFHIKM")
    const tails = els.filter((e) => e.tag === "line" && e.a["data-float"] === "tail")
    expect(tails.length).toBe(want.length)
    for (const tail of tails) {
      const t = ITEMS[n(tail.a["data-index"])]
      expect(t.critical, t.label).not.toBe(true)
      expect(n(tail.a.x1), `${t.label} tail start`).toBeCloseTo(scale.at(t.end), 1)
      expect(n(tail.a.x2), `${t.label} tail end`).toBeCloseTo(scale.at(t.end + t.float), 1)
      expect(tail.a["stroke-dasharray"], "dashed, so it reads as float and not as work").toBeDefined()
      expect(n(tail.a["stroke-width"])).toBeGreaterThanOrEqual(0.18)
      expect(hex(tail.a.stroke)).not.toBe(ACCENT)
      // Same row as its bar.
      const bar = bars.find((b) => b.a["data-index"] === tail.a["data-index"]) as El
      expect(n(tail.a.y1)).toBeCloseTo(n(bar.a.y) + n(bar.a.height) / 2, 2)
    }
    // Late-finish end caps, one per tail.
    expect(els.filter((e) => e.tag === "line" && e.a["data-float"] === "end").length).toBe(want.length)
  })

  test("5 milestone markers at their weeks", () => {
    const ms = els.filter((e) => e.tag === "path" && e.a["data-mark"] === "point" && e.a["data-series"] === "milestone")
    expect(ms.length).toBe(5)
    for (const m of ms) {
      const t = ITEMS[n(m.a["data-index"])]
      expect(t.milestone).toBe(true)
      const x = n(/^M(-?[\d.]+)/.exec(m.a.d)?.[1])
      expect(x, t.label).toBeCloseTo(scale.at(t.start), 1)
      expect(hex(m.a.fill), "milestones do not take the accent").not.toBe(ACCENT)
    }
  })

  test("one status line at week 10", () => {
    const lines = els.filter((e) => e.tag === "line" && e.a["data-status"] === "line")
    expect(lines.length).toBe(1)
    expect(lines[0].a["data-status-at"]).toBe("10")
    expect(n(lines[0].a.x1)).toBeCloseTo(scale.at(10), 1)
    expect(n(lines[0].a.x2)).toBeCloseTo(scale.at(10), 1)
    expect(els.filter((e) => e.a["data-today"] !== undefined).length, "no second (todayAt) line").toBe(0)
    expect(els.some((e) => e.tag === "text" && /10/.test(e.text ?? "") && /minggu/.test(e.text ?? "") && /status/i.test(e.text ?? ""))).toBe(true)
  })

  test("accent on critical bars only; non-critical bars take a neutral ink; critical path = 27 weeks on the drawing", () => {
    const accentBars = bars.filter((b) => hex(b.a.fill) === ACCENT)
    expect(accentBars.map((b) => ITEMS[n(b.a["data-index"])].label[0]).join("")).toBe("ABCEGJLN")
    const weeks = accentBars.reduce((s, b) => s + n(b.a.width) / scale.perWeek, 0)
    expect(weeks).toBeCloseTo(27, 1)
    const inks = new Set([PAL.ink900, PAL.ink700, PAL.ink400, PAL.ink200].map(hex))
    for (const b of bars.filter((x) => hex(x.a.fill) !== ACCENT)) expect(inks.has(hex(b.a.fill)), b.a["data-index"]).toBe(true)
    // Nothing else filled or stroked with the accent, apart from the key swatch of the critical path.
    const others = els.filter((e) => (hex(e.a.fill ?? "") === ACCENT || hex(e.a.stroke ?? "") === ACCENT) && e.a["data-mark"] !== "interval")
    expect(others.every((e) => e.tag === "rect" && e.a["data-mark"] === undefined)).toBe(true)
    expect(others.length).toBeLessThanOrEqual(1)
  })

  test("colour budget and accent budget hold: no DATUM-25 / DATUM-26 / DATUM-27 / DATUM-28 failure, no layout defect", () => {
    for (const id of ["DATUM-25", "DATUM-26", "DATUM-27", "DATUM-28"]) expect(res.report.checksRun, id).toContain(id)
    expect(res.report.issues.filter((i: J) => i.status === "FAIL")).toEqual([])
    const geo = geometry.lintChartGeometry(res.svg, geometry.CHART_LINT_OPTIONS)
    expect(geo.defects).toEqual([])
    expect(geo.score).toBe(0)
    // The lint's own count: every critical bar is one accent subject (the critical path).
    const scan = (chartCore as J).scanSvg(res.svg)
    const acc = ACCENT.slice(1)
    const subjects = new Set(scan.marks.filter((m: J) => m.fill === acc || m.stroke === acc).map((m: J) => m.accentGroup))
    expect([...subjects]).toEqual(["jalur-kritis"])
  })

  test("deterministic: the same input gives the same bytes", () => {
    expect(render(spec).svg).toBe(res.svg)
  })
})

describe("row 38 one contract: preview and render draw the same thing", () => {
  test("preview (renderResolved) and render (chartSvg) of the same block are byte-equal, ID and EN", async () => {
    const spec = specOf(BLOCK)
    const block: J = { blockId: "p-row38", address: null, ordinal: 0, unitKey: "", type: "chart", content: { spec }, textPlain: "", contentSha256: "" }
    for (const lang of [undefined, "EN"] as const) {
      const viaRender = chartSvg(structuredClone(spec), TPL, lang as J)
      const viaPreview = await preview.renderResolved({ block, type: "chart", spec: structuredClone(spec) }, TPL, { inline: true, withSvg: true, ...(lang ? { lang } : {}) } as J)
      expect(viaPreview.svg, String(lang)).toBe(viaRender.svg)
      expect(viaPreview.code).toBe("W-07")
      // Row 133: the 19 rows (14 tasks + 5 milestone rows) are above the reference bound `rowsInProposal` (15 at
      // 62 mm), so the figure grows instead of reporting; the reference case previews with no defect at all.
      expect(viaPreview.defects.map((d: J) => `${d.checkId}:${d.status}`)).toEqual([])
      expect(viaPreview.issues.map((i: J) => i.checkId).sort()).toEqual(viaRender.report.issues.map((i: J) => i.checkId).sort())
      expect(viaPreview.size.heightMm).toBe(viaRender.heightMm)
      expect((viaRender.svg.match(/data-float="tail"/g) ?? []).length).toBe(6)
      expect((viaRender.svg.match(/data-status="line"/g) ?? []).length).toBe(1)
    }
  })
})

describe("row 38 rules at the engine", () => {
  const base = [
    { label: "Desain", start: 0, end: 4, critical: true, float: 0 },
    { label: "Pengadaan", start: 2, end: 5, float: 3 },
    { label: "Instalasi", start: 4, end: 8, critical: true },
    { label: "BAST", start: 8, end: 8, milestone: true },
  ]
  const data = (extra: J = {}, items: J[] = base): J => ({ shape: "intervals", items, ...extra })
  const thrown = (fn: () => unknown): J => {
    try {
      fn()
    } catch (e) {
      return e
    }
    throw new Error("did not throw")
  }

  test("statusAt of another kind than start/end is refused (number axis, ISO status)", () => {
    const e = thrown(() => render(v1(data({ statusAt: "2026-03-01" }))))
    expect(e.code).toBe("SCHEMA_INVALID")
    expect(String(e.message)).toContain("statusAt")
  })
  test("a negative or non-numeric float is refused", () => {
    for (const bad of [-1, "2", Number.NaN]) {
      const e = thrown(() => render(v1(data({}, [{ label: "A", start: 0, end: 2, float: bad }, base[3]]))))
      expect(e.code, String(bad)).toBe("SCHEMA_INVALID")
      expect(String(e.message)).toContain("float")
    }
  })
  test("ISO dates: float in days extends the tail, statusAt as ISO draws the line", () => {
    const res = render(
      v1(
        data({ statusAt: "2026-01-20", timeUnit: "hari" }, [
          { label: "Desain", start: "2026-01-05", end: "2026-01-19", critical: true },
          { label: "Pengadaan", start: "2026-01-12", end: "2026-01-26", float: 7 },
          { label: "BAST", start: "2026-02-09", end: "2026-02-09", milestone: true },
        ]),
      ),
    )
    const els = elements(res.svg)
    const tail = els.filter((e) => e.a["data-float"] === "tail")
    expect(tail.length).toBe(1)
    const bar = els.find((e) => e.a["data-mark"] === "interval" && e.a["data-index"] === "1") as El
    // 14 days of work, 7 days of float: the tail is half the bar.
    expect((n(tail[0].a.x2) - n(tail[0].a.x1)) / n(bar.a.width)).toBeCloseTo(0.5, 2)
    expect(els.filter((e) => e.a["data-status"] === "line").length).toBe(1)
  })
  test("an accent hint on a non-critical task beside a critical path is a second accent subject: DATUM-26", () => {
    const e = thrown(() => render(v1(data(), { accent: { point: "Pengadaan" } })))
    expect(String(e.message)).toContain("DATUM-26")
    // On a critical task the hint adds nothing: still one subject.
    expect(() => render(v1(data(), { accent: { point: "Desain" } }))).not.toThrow()
  })
  test("a critical task that carries float > 0 is reported, not accented away", () => {
    const res = render(v1(data({}, [{ label: "A", start: 0, end: 2, critical: true, float: 1 }, { label: "B", start: 2, end: 5 }, base[3]])))
    expect(res.report.issues.some((i: J) => i.checkId === "W-07.float" && i.status === "REPORT")).toBe(true)
  })
  test("gallery style draws the same fields", () => {
    const res = render(v1(data({ statusAt: 3, timeUnit: "minggu" }), { style: "gallery" }))
    const els = elements(res.svg)
    expect(els.filter((e) => e.a["data-float"] === "tail").length).toBe(1)
    expect(els.filter((e) => e.a["data-status"] === "line").length).toBe(1)
    expect(els.filter((e) => e.a["data-mark"] === "interval" && hex(e.a.fill) === ACCENT).length).toBe(2)
  })
})

describe("row 38 keeps old W-07 specs as they were", () => {
  // sha256 of the parity fixture w07.json rendered before the change (captured at the red step, both styles).
  const PIN: Record<string, string> = JSON.parse(readFileSync(path.join(import.meta.dir, "fixtures", "w07_parity_pins.json"), "utf8"))
  const w07 = JSON.parse(readFileSync(path.join(import.meta.dir, "..", "ported", "_fixtures", "tests", "parity", "fixtures", "chart", "w07.json"), "utf8"))
  for (const style of ["datum", "gallery"]) {
    test(`parity fixture w07 @${style}: bytes unchanged (no new field = no new mark)`, () => {
      const svg = render({ ...w07, style }).svg
      expect(new Bun.CryptoHasher("sha256").update(svg).digest("hex")).toBe(PIN[style])
      expect(svg).not.toContain("data-float")
      expect(svg).not.toContain("data-status")
      expect(svg).not.toContain("data-axis-unit")
    })
  }
  test("todayAt (template parameter) still draws its line when statusAt is absent", () => {
    const svg = render(v1({ shape: "intervals", items: [{ label: "A", start: 0, end: 4 }, { label: "B", start: 4, end: 4, milestone: true }] }, { params: { "chart.kind.W-07.todayAt": "2" } })).svg
    expect((svg.match(/data-today="line"/g) ?? []).length).toBe(1)
  })
})
