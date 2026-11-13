// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T04 (01_specs §4): edge labels <= 18 characters on a 3-level chain give LABEL_LEADER 0 on four layouts.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import path from "node:path"

type S = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const build = await import(path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram", "build", "index.ts"))

const spec = (family: string, extra: S, width = 166): S => ({ $schema: "studio.diagram/v1", family, id: "9.1", title: "Uji sintetis.", classification: "BIASA", width_mm: width, apparatus: "page", labels_verified: true, sources: ["Uji sintetis"], ...extra })
const run = (s: S) => build.buildDiagramSvg(structuredClone(s), { release: true })
const geomIds = (r: S): string[] => ((r.report?.geometry ?? []) as S[]).map((g) => String(g.checkId))
const L = ["kirim pesanan", "periksa stok gudang", "jadwal kirim"].map((s) => s.slice(0, 18))
const chains: Record<string, S> = {
  "flow TB": spec("flow", { direction: "TB", nodes: [0, 1, 2].map((i) => ({ id: `c${i}`, label: `Tahap ${i + 1}`, class: { col: 0, row: i } })), edges: [{ from: "c0", to: "c1", kind: "data", label: L[0] }, { from: "c1", to: "c2", kind: "data", label: L[1] }] }),
  "flow LR": spec("flow", { direction: "LR", nodes: [0, 1, 2].map((i) => ({ id: `c${i}`, label: `Tahap ${i + 1}`, class: { col: i, row: 0 } })), edges: [{ from: "c0", to: "c1", kind: "data", label: L[0] }, { from: "c1", to: "c2", kind: "data", label: L[2] }] }),
  layered: spec("layered", { nodes: [0, 1, 2].map((t) => ({ id: `l${t}`, label: `Lapis ${t}`, class: { tier: t } })), edges: [{ from: "l0", to: "l1", kind: "data", label: L[0] }, { from: "l1", to: "l2", kind: "control", label: L[1] }] }),
  "graph diagonal": spec("graph", { nodes: [0, 1, 2].map((r) => ({ id: `g${r}`, label: `Titik ${r}`, class: { col: r, row: r } })), edges: [{ from: "g0", to: "g1", kind: "data", label: L[2] }, { from: "g1", to: "g2", kind: "data", label: L[1] }] }),
}

describe("rel127 VERIFY T-04: LABEL_LEADER 0 on a 3-level chain", () => {
  for (const [name, s] of Object.entries(chains)) {
    test(`${name}: LABEL_LEADER count 0`, () => {
      for (const e of s.edges) expect(e.label.length).toBeLessThanOrEqual(18)
      expect(geomIds(run(s)).filter((id) => id === "LABEL_LEADER").length).toBe(0)
    })
  }
})
