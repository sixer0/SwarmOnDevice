// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T07 (01_specs §4): a diamond holds its wrapped label: height >= 2 text lines (or the node auto-widens);
// textOverNode 0 and textExceedsNode 0.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const D = path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const lint = await import(path.join(D, "fit", "lint.ts"))

const spec = (family: string, extra: S, width = 166): S => ({ $schema: "studio.diagram/v1", family, id: "9.1", title: "Uji sintetis.", classification: "BIASA", width_mm: width, apparatus: "page", labels_verified: true, sources: ["Uji sintetis"], ...extra })
const LABEL = "Apakah persediaan gudang mencukupi?"
const ends = { a: { id: "a", label: "Mulai" }, z: { id: "z", label: "Selesai" } }
const edges = [{ from: "a", to: "d", kind: "data", label: "isi" }, { from: "d", to: "z", kind: "data", label: "ya" }]
const fams: Record<string, S> = {
  graph: spec("graph", { nodes: [{ ...ends.a, class: { col: 0, row: 0 } }, { id: "d", label: LABEL, shape: "diamond", class: { col: 1, row: 0 } }, { ...ends.z, class: { col: 2, row: 0 } }], edges }, 128),
  layered: spec("layered", { nodes: [{ ...ends.a, class: { tier: 0 } }, { id: "d", label: LABEL, shape: "diamond", class: { tier: 1 } }, { ...ends.z, class: { tier: 2 } }], edges }, 128),
  "flow TB": spec("flow", { direction: "TB", nodes: [{ ...ends.a, class: { col: 0, row: 0 } }, { id: "d", label: LABEL, shape: "diamond", class: { col: 0, row: 1 } }, { ...ends.z, class: { col: 0, row: 2 } }], edges }, 128),
  "flow legacy": spec("flow", { nodes: [{ ...ends.a, class: { col: 0, row: 0 } }, { id: "d", label: LABEL, shape: "diamond", class: { col: 1, row: 0 } }, { ...ends.z, class: { col: 2, row: 0 } }], edges }, 128),
}

describe("rel127 VERIFY T-07: diamond height (2-line rule or auto-widen)", () => {
  for (const [name, s] of Object.entries(fams)) {
    test(`${name}: diamond holds its wrapped label`, () => {
      const r = build.buildDiagramSvg(structuredClone(s), { release: true })
      const poly = /<polygon points="([^"]+)"[^>]*data-node="d"/.exec(r.svg)
      expect(poly).not.toBeNull()
      const pts = poly![1].trim().split(/\s+/).map((p) => p.split(",").map(Number))
      const h = Math.max(...pts.map((p) => p[1])) - Math.min(...pts.map((p) => p[1]))
      const t = /<text\b[^>]*font-size="([\d.]+)"[^>]*>(.*?)<\/text>/.exec(r.svg.slice(r.svg.indexOf('data-node="d"')))
      const size = Number(t?.[1] ?? NaN)
      expect(Number.isFinite(size)).toBe(true)
      expect(h).toBeGreaterThanOrEqual(2 * 1.2 * size - 1e-6)
      const g = lint.lintDiagramGeometry(r.svg)
      expect(g.counts.textOverNode ?? 0).toBe(0)
      expect(g.counts.textExceedsNode ?? 0).toBe(0)
    })
  }
})
