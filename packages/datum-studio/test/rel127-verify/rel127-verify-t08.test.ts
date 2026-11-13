// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T08 (01_specs §4): a fan-out of four gives edgeCollinear 0 and four distinct exit positions (graph, flow TB,
// flow LR at 166 mm).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"

type S = Record<string, any>
type P = [number, number]
const PKG = path.resolve(import.meta.dir, "..", "..")
const V = path.join(PKG, "vendor", "src", "lib", "studio", "engine")
const build = await import(path.join(V, "diagram", "build", "index.ts"))
const lint = await import(path.join(V, "diagram", "fit", "lint.ts"))
const scan = await import(path.join(V, "chart", "core", "svgscan.ts"))

const spec = (family: string, extra: S, width = 166): S => ({ $schema: "studio.diagram/v1", family, id: "9.1", title: "Uji sintetis.", classification: "BIASA", width_mm: width, apparatus: "page", labels_verified: true, sources: ["Uji sintetis"], ...extra })
const attrs = (tag: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)) out[m[1]] = m[2]
  return out
}
const links = (svg: string): P[][] =>
  [...svg.matchAll(/<path\b([^>]*\bdata-mark="link"[^>]*)>/g)]
    .map((m) => attrs(m[1]))
    .sort((a, b) => Number(a["data-index"] ?? 0) - Number(b["data-index"] ?? 0))
    .map((a) => (scan.pathPolylines(a.d) as P[][]).flat() as P[])
const FAN = (family: string, extra: S = {}) =>
  spec(family, {
    nodes: [{ id: "s", label: "Pusat", class: { col: 0, row: 0 } }, ...[0, 1, 2, 3].map((i) => ({ id: `t${i}`, label: `Cabang ${i + 1}`, class: { col: i, row: 1 } }))],
    edges: [0, 1, 2, 3].map((i) => ({ from: "s", to: `t${i}`, kind: "data", label: `k${i + 1}` })),
    ...extra,
  })

describe("rel127 VERIFY T-08: fan-out of four", () => {
  for (const [name, s] of [["graph", FAN("graph")], ["flow TB", FAN("flow", { direction: "TB" })], ["flow LR 166", FAN("flow", { direction: "LR" })]] as Array<[string, S]>) {
    test(`${name}: edgeCollinear 0 and four distinct exits`, () => {
      const r = build.buildDiagramSvg(structuredClone(s), { release: true })
      const exits = links(r.svg).map((pl) => `${pl[0][0].toFixed(2)},${pl[0][1].toFixed(2)}`)
      expect(lint.lintDiagramGeometry(r.svg).counts.edgeCollinear ?? 0).toBe(0)
      expect(exits.length).toBe(4)
      expect(new Set(exits).size).toBe(4)
    })
  }
})
