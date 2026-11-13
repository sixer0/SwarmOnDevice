// Swarm 1.2.8 row 34 (H-N15, AC-HN15, N8-335; RED-GREEN): studio_write / studio_edit warn TABLE_OVERFLOW_LIKELY
// (N8-210) when a table's estimated width at a likely glyph advance exceeds the text column (166 mm), naming the table
// and the estimate against the column, before render. The DT-10a lower bound (tableMinWidthMm, 0.42 em) is unchanged
// and still does not refuse the table (119.18 mm <= 166 mm). The fitting table gives no warning.
// Channels: client document studio_write and studio_edit {append, addRow} on the REAL host (hna-host.ts, row 33,
// needs the command sandbox off: it binds an ephemeral port); work report blockLines (studio_write) and applyEdits
// {append, addRow} (studio_edit) as pure functions.
// Red at BASE e1f9673772: no TABLE_OVERFLOW_LIKELY on any channel, the estimator does not exist.
// CHAR: render-side TABLE_OVERFLOW (src/mcp-host/verify/overlap-clip.ts) and DT-10a are untouched.
// Fixtures: test/fixtures/syn128/hn15_wide_table.json, hn15_fit_table.json (row 25b, synthetic).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { CHANGE, startHost, type Host, type S } from "../diagram-persist/hna-host"

const PKG = path.resolve(import.meta.dir, "..", "..")
const MCP = path.join(PKG, "vendor", "scripts", "studio", "mcp")
const fx = (f: string) => JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "syn128", f), "utf8")) as { args: S; expected: S }
const WIDE = fx("hn15_wide_table.json")
const FIT = fx("hn15_fit_table.json")
const wideBlock = (): S => JSON.parse(JSON.stringify(WIDE.args.sections[1].blocks[0]))
const fitBlock = (): S => JSON.parse(JSON.stringify(FIT.args.sections[1].blocks[0]))
const WM = "WMWMWMWMWMWMWMWM"
const M = "2026-11-14_hn15"

const wc = (await import(path.join(MCP, "write-content.ts"))) as Record<string, any>
const we = (await import(path.join(MCP, "write-edit.ts"))) as Record<string, any>
const tf = await import(path.join(PKG, "vendor", "src", "lib", "studio", "engine", "table-fit.ts"))

type W = { code: string; message: string }
const likely = (ws: W[]) => ws.filter((w) => w.code === "TABLE_OVERFLOW_LIKELY")
/** The one TABLE_OVERFLOW_LIKELY warning names the table and gives the estimate against the 166 mm text column. */
function expectWarned(ws: W[], name: string): void {
  const l = likely(ws)
  expect(l.length, JSON.stringify(ws)).toBe(1)
  expect(l[0].message).toContain(`tabel "${name}"`)
  expect(l[0].message).toMatch(/perkiraan \d+\.\d mm > 166 mm/)
  expect(l[0].message).toContain(WM)
  const est = Number(/perkiraan (\d+\.\d) mm/.exec(l[0].message)?.[1])
  expect(est).toBeGreaterThan(166)
}

describe("AC-HN15 estimator", () => {
  test("wide fixture: DT-10a lower bound 119.18 mm (not refused) but likely width > 166 mm; fit fixture: none", () => {
    const wide = wc.rowsTableShape(wideBlock().table)
    const fit = wc.rowsTableShape(fitBlock().table)
    expect(tf.tableMinWidthMm(wide, {}).minMm).toBeCloseTo(WIDE.expected.dt10aLowerBoundMm, 2)
    expect(tf.tableMinWidthMm(fit, {}).minMm).toBeCloseTo(FIT.expected.dt10aLowerBoundMm, 2)
    expect(() => tf.assertTableFits({ ...wide, type: "table" }, {})).not.toThrow()
    const o = wc.tableOverflowLikely(wide)
    console.log(`[rel128-hn15] wide: lower ${tf.tableMinWidthMm(wide, {}).minMm.toFixed(2)} mm, likely ${o?.estimatedMm.toFixed(2)} mm, span ${o?.spanMm} mm`)
    expect(o.spanMm).toBe(WIDE.expected.spanMm)
    expect(o.estimatedMm).toBeGreaterThan(166)
    expect(o.widest.text).toBe(WM)
    expect(wc.tableOverflowLikely(fit)).toBeNull()
  })
})

describe("AC-HN15 work report (pure)", () => {
  test("studio_write blockLines: {table} wide -> TABLE_OVERFLOW_LIKELY naming the caption; fit -> none", () => {
    const ws: W[] = []
    wc.blockLines(wideBlock(), (w: W) => ws.push(w), "bagian 2 blok 1", new Set())
    expectWarned(ws, "Tabel sintetis lebar")
    const ok: W[] = []
    wc.blockLines(fitBlock(), (w: W) => ok.push(w), "bagian 2 blok 1", new Set())
    expect(likely(ok)).toEqual([])
  })

  const partsOf = (body: string[]) => [{ part: "bab 3", md: { header: [], intro: [], tail: [], body: [...body] } }]
  test("studio_edit applyEdits append: wide -> warned; fit -> none", () => {
    for (const [block, n] of [[wideBlock(), 1], [fitBlock(), 0]] as const) {
      const ws: W[] = []
      we.applyEdits(partsOf(["## Bukti", "", "isi"]), [{ section: "Bukti", append: [block] }], (w: W) => ws.push(w), {})
      expect(likely(ws).length, JSON.stringify(ws)).toBe(n)
    }
  })

  test("studio_edit applyEdits addRow: wide rows into a 6-column table -> warned (header names the table); short row -> none", () => {
    const body = ["## Bukti", "", "| Kolom A | Kolom B | Kolom C | Kolom D | Kolom E | Kolom F |", "| --- | --- | --- | --- | --- | --- |", "| a | b | c | d | e | f |", ""]
    const ws: W[] = []
    we.applyEdits(partsOf(body), [{ section: "Bukti", addRow: wideBlock().table.slice(1) }], (w: W) => ws.push(w), {})
    expectWarned(ws, "Kolom A | Kolom B | Kolom C | Kolom D | Kolom E | Kolom F")
    const ok: W[] = []
    we.applyEdits(partsOf(body), [{ section: "Bukti", addRow: [["g", "h", "i", "j", "k", "l"]] }], (w: W) => ok.push(w), {})
    expect(likely(ok)).toEqual([])
  })
})

let h: Host
beforeAll(async () => {
  h = await startHost("hn15")
}, 120_000)
afterAll(async () => {
  await h?.close()
})

const warningsOf = (r: S): W[] => (Array.isArray(r.warnings) ? (r.warnings as W[]) : [])
const write = (args: S, docKey: string) => h.call("studio_write", { ...JSON.parse(JSON.stringify(args)), docKey, mission: M })

describe("AC-HN15 client document on the real host", () => {
  let fitDoc = ""
  test("studio_write hn15_wide_table.json -> TABLE_OVERFLOW_LIKELY naming the table; content still written", async () => {
    const r = await write(WIDE.args, "syn128-hn15-wide")
    console.log(`[rel128-hn15] write wide: ok=${r.ok} warnings=${JSON.stringify(warningsOf(r).map((w) => w.code))}`)
    expect(r.ok, r._text).not.toBe(false)
    expect(typeof r.documentId).toBe("string")
    expectWarned(warningsOf(r), "Tabel sintetis lebar")
    expect(r._text).toContain("TABLE_OVERFLOW_LIKELY")
  }, 120_000)

  test("studio_write hn15_fit_table.json -> no TABLE_OVERFLOW_LIKELY", async () => {
    const r = await write(FIT.args, "syn128-hn15-fit")
    expect(r.ok, r._text).not.toBe(false)
    fitDoc = String(r.documentId)
    expect(likely(warningsOf(r))).toEqual([])
    expect(r._text).not.toContain("TABLE_OVERFLOW_LIKELY")
  }, 120_000)

  test("studio_edit {append: wide table} -> warned; {append: fit table} -> none", async () => {
    const wide = await h.call("studio_edit", { documentId: fitDoc, edits: [{ section: "Rincian", append: [wideBlock()] }], change: CHANGE })
    console.log(`[rel128-hn15] edit append wide: ok=${wide.ok} warnings=${JSON.stringify(warningsOf(wide).map((w) => w.code))}`)
    expect(wide.ok, wide._text).not.toBe(false)
    expectWarned(warningsOf(wide), "Tabel sintetis lebar")
    const fit = await h.call("studio_edit", { documentId: fitDoc, edits: [{ section: "Rincian", append: [fitBlock()] }], change: CHANGE })
    expect(fit.ok, fit._text).not.toBe(false)
    expect(likely(warningsOf(fit))).toEqual([])
  }, 120_000)

  test("studio_edit {addRow: wide rows} into a 6-column table that fits -> warned; {addRow: short row} -> none", async () => {
    const base = JSON.parse(JSON.stringify(WIDE.args))
    base.sections[1].blocks[0] = { table: [WIDE.args.sections[1].blocks[0].table[0], ["a", "b", "c", "d", "e", "f"]], caption: "Tabel enam kolom", source: "Sumber sintetis uji." }
    const w = await write(base, "syn128-hn15-addrow")
    expect(w.ok, w._text).not.toBe(false)
    expect(likely(warningsOf(w))).toEqual([])
    const doc = String(w.documentId)
    const ok = await h.call("studio_edit", { documentId: doc, edits: [{ section: "Rincian", addRow: [["g", "h", "i", "j", "k", "l"]] }], change: CHANGE })
    expect(ok.ok, ok._text).not.toBe(false)
    expect(likely(warningsOf(ok))).toEqual([])
    const wide = await h.call("studio_edit", { documentId: doc, edits: [{ section: "Rincian", addRow: wideBlock().table.slice(1) }], change: CHANGE })
    console.log(`[rel128-hn15] edit addRow wide: ok=${wide.ok} warnings=${JSON.stringify(warningsOf(wide).map((x) => x.code))}`)
    expect(wide.ok, wide._text).not.toBe(false)
    expectWarned(warningsOf(wide), "Tabel enam kolom")
  }, 120_000)
})
