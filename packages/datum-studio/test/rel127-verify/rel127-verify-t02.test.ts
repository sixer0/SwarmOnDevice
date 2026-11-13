// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T02 (01_specs §4): graph col 0 never clips a node: node outlines inside the 2 mm inset at 128 and 166 mm; a
// figure that does not fit is refused DATUM-37 naming the column.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const D = path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))

const spec = (family: string, extra: S, width = 166): S => ({ $schema: "studio.diagram/v1", family, id: "9.1", title: "Uji sintetis.", classification: "BIASA", width_mm: width, apparatus: "page", labels_verified: true, sources: ["Uji sintetis"], ...extra })
const run = (s: S) => build.buildDiagramSvg(structuredClone(s), { release: true })
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}
type Box = { id: string; x: number; y: number; w: number; h: number }
function nodeBoxes(svg: string): Box[] {
  const out: Box[] = []
  for (const m of svg.matchAll(/<rect\b([^>]*\bdata-node="[^"]*"[^>]*)\/?>/g)) {
    const a = attrs(m[1])
    out.push({ id: a["data-node"], x: +a.x, y: +a.y, w: +a.width, h: +a.height })
  }
  for (const m of svg.matchAll(/<polygon\b([^>]*\bdata-node="[^"]*"[^>]*)\/?>/g)) {
    const a = attrs(m[1])
    const pts = a.points.trim().split(/\s+/).map((p) => p.split(",").map(Number))
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    out.push({ id: a["data-node"], x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) })
  }
  return out
}
function caught(fn: () => unknown): S | null {
  try {
    fn()
    return null
  } catch (e) {
    return e as S
  }
}
const graph = (width: number, cols: number[], label: (c: number) => string) =>
  spec("graph", {
    nodes: cols.map((c) => ({ id: `k${c}`, label: label(c), class: { col: c, row: c % 2 } })),
    edges: cols.slice(1).map((c, i) => ({ from: `k${cols[i]}`, to: `k${c}`, kind: "data", label: "alir" })),
  }, width)

describe("rel127 VERIFY T-02: graph col 0 inset", () => {
  for (const width of [128, 166]) {
    test(`width ${width}: four columns from col 0, every node outline >= 2 mm inside both sides`, () => {
      const boxes = nodeBoxes(run(graph(width, [0, 1, 2, 3], (c) => `Pos ${c}`)).svg)
      expect(boxes.length).toBe(4)
      expect(Math.min(...boxes.map((b) => b.x))).toBeGreaterThanOrEqual(2 - 1e-6)
      expect(Math.max(...boxes.map((b) => b.x + b.w))).toBeLessThanOrEqual(width - 2 + 1e-6)
    })
  }
  test("128 mm, three wide columns: inside 2..126 or refused DATUM-37 naming the column", () => {
    const s = graph(128, [0, 1, 2], (c) => `Gudang penyimpanan sementara nomor ${c}`)
    const e = caught(() => run(s))
    if (e) {
      const msg = String(e.message ?? "")
      expect(`${String(e.checkId ?? e.details?.checkId ?? "")} ${msg}`).toMatch(/DATUM-37/)
      expect(msg).toMatch(/kolom graph \d+|rank \d+/)
      return
    }
    const boxes = nodeBoxes(run(s).svg)
    expect(Math.min(...boxes.map((b) => b.x))).toBeGreaterThanOrEqual(2 - 1e-6)
    expect(Math.max(...boxes.map((b) => b.x + b.w))).toBeLessThanOrEqual(126 + 1e-6)
  })
})
