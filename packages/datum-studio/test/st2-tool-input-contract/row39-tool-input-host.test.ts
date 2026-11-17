// Swarm 1.3.3 row 39 (ST-2 write side): what the store holds after the real tools ran. Real host over a temp store
// (test/diagram-persist/hna-host.ts; binds an ephemeral port, so it needs the command sandbox off).
// - studio_write with `chart.intervals` + statusAt + timeUnit (client document) stores a ChartV2 block whose data is
//   {shape:"intervals", items, statusAt, timeUnit} with the given values unchanged, code W-07.
// - a malformed interval is refused naming the field and the stored block does not change.
// - `width` on the chart and on the diagram block is stored; studio_figure_revise sets `width` on both kinds.
// - the host tools/list stays within the 1.2.9 pin (73 748 B).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { CHANGE, clone, diagramsOf, FIXTURE, META, startHost, withoutId, type Host, type S } from "../diagram-persist/hna-host"

const MISSION = "2026-11-17_row39"
let h: Host
beforeAll(async () => {
  h = await startHost("row39")
}, 120_000)
afterAll(async () => {
  await h?.close()
})

const W07: S = {
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
const DATA = { shape: "intervals", items: W07.intervals, statusAt: 8, timeUnit: "minggu" }

function chartsOf(content: S): S[] {
  const out: S[] = []
  const walk = (x: unknown) => {
    if (Array.isArray(x)) x.forEach(walk)
    else if (x !== null && typeof x === "object") {
      if ((x as S).type === "chart") out.push(x as S)
      else Object.values(x as S).forEach(walk)
    }
  }
  walk(content)
  return out
}
const write = (docKey: string, blocks: unknown[]) =>
  h.call("studio_write", { mission: MISSION, docKey, template: "datum-nota", meta: META, sections: [{ heading: "Pendahuluan", blocks: ["Paragraf pembuka sintetis alfa bravo charlie."] }, { heading: "Jadwal pelaksanaan", blocks: ["Paragraf sintetis sebelum figur.", ...blocks] }] })

let doc = ""
describe("row 39 (host): studio_write stores the W-07 intervals shape unchanged", () => {
  test("chart.intervals + statusAt + timeUnit -> ChartV2 data {shape:intervals,...}, code W-07", async () => {
    const r = await write("r39-w07", [{ chart: clone(W07) }])
    console.log(`[row39-host] write W-07: ok=${r.ok} code=${r.code ?? "-"} warnings=${JSON.stringify((r.warnings ?? []).map((w: S) => w.code))}`)
    expect(r.ok, r._text).not.toBe(false)
    expect(JSON.stringify(r.warnings ?? [])).not.toContain("ARG_IGNORED")
    doc = String(r.documentId)
    const cs = chartsOf(await h.content(doc))
    expect(cs).toHaveLength(1)
    expect(cs[0].code).toBe("W-07")
    expect(cs[0].data).toEqual(DATA)
    expect("width" in cs[0]).toBe(false)
  }, 120_000)

  test("a malformed interval (negative float) is refused naming the field; the stored block is unchanged", async () => {
    const bad = clone(W07)
    bad.intervals[1].float = -1
    const r = await write("r39-w07", [{ chart: bad }])
    console.log(`[row39-host] malformed: ok=${r.ok} code=${r.code ?? "-"}`)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).toContain("CHART_DATA_INVALID")
    expect(JSON.stringify(r)).toContain("/intervals/1/float")
    expect(chartsOf(await h.content(doc))[0].data).toEqual(DATA)
  }, 60_000)

  test("width on the chart block and on the diagram block is stored as given", async () => {
    const r = await write("r39-width", [{ chart: { ...clone(W07), width: "full" } }, { diagram: { ...clone(FIXTURE.writeBlock.diagram), width: "full" } }])
    expect(r.ok, r._text).not.toBe(false)
    const content = await h.content(String(r.documentId))
    const cs = chartsOf(content)
    const ds = diagramsOf(content)
    expect(cs).toHaveLength(1)
    expect(ds).toHaveLength(1)
    expect(cs[0].width).toBe("full")
    expect(cs[0].data).toEqual(DATA)
    expect(withoutId(ds[0])).toEqual({ ...FIXTURE.block, width: "full" })
    const refused = await write("r39-width-bad", [{ chart: { ...clone(W07), width: "166mm" } }])
    expect(refused.ok).toBe(false)
    expect(JSON.stringify(refused)).toContain("/chart/width")
  }, 120_000)

  test("studio_figure_revise: patch {width} is accepted on a chart and on a diagram", async () => {
    const r = await write("r39-revise", [{ chart: clone(W07) }, { diagram: clone(FIXTURE.writeBlock.diagram) }])
    expect(r.ok, r._text).not.toBe(false)
    const id = String(r.documentId)
    const before = await h.content(id)
    for (const pid of [String(chartsOf(before)[0].id), String(diagramsOf(before)[0].id)]) {
      const rev = await h.call("studio_figure_revise", { documentId: id, pid, patch: { width: "full" }, change: CHANGE, preview: false })
      expect(rev.ok, rev._text).not.toBe(false)
    }
    const after = await h.content(id)
    expect(chartsOf(after)[0].width).toBe("full")
    expect(chartsOf(after)[0].data).toEqual(DATA)
    expect(diagramsOf(after)[0].width).toBe("full")
    expect(diagramsOf(after)[0].spec).toEqual(diagramsOf(before)[0].spec)
    const back = await h.call("studio_figure_revise", { documentId: id, pid: String(chartsOf(after)[0].id), patch: { width: "text" }, change: CHANGE, preview: false })
    expect(back.ok, back._text).not.toBe(false)
    expect(chartsOf(await h.content(id))[0].width).toBe("text")
  }, 120_000)

  test("budget: host tools/list <= 73 748 B (rel129 A13 pin)", async () => {
    const bytes = await h.toolsBytes()
    console.log(`[row39-host] host tools/list ${bytes} B`)
    expect(bytes).toBeLessThanOrEqual(73_748)
  }, 60_000)
})
