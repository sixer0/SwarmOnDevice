// Swarm 1.2.7 row 45 (N7-114, CHAR-VERIFY): regression test committed from the row 9 engine probe
// ($T/test/probes/datum-studio/probe9_engine.test.ts). Must pass at BASE 04067a9d02 and at HEAD; no code change for
// this item. Synthetic inputs only: every figure and chart below is built in-test from filler words.
// AC-T05 (01_specs §4): the provenance glyph is inset by node shape: textOverNode 0 on five shapes.
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

describe("rel127 VERIFY T-05: provenance glyph on slanted shapes", () => {
  for (const shape of ["diamond", "parallelogram", "hexagon", "circle", "cylinder"]) {
    test(`${shape} with marks: zero textOverNode in the built figure`, () => {
      const s = spec("graph", {
        nodes: [
          { id: "a", label: "Masukan", class: { col: 0, row: 0 }, mark: "TERUKUR" },
          { id: "b", label: "Uji kelayakan", shape, class: { col: 1, row: 0 }, mark: "ASUMSI" },
          { id: "c", label: "Keluaran", shape, class: { col: 2, row: 0 }, mark: "DITURUNKAN" },
          { id: "z", label: "Arsip", class: { col: 3, row: 0 } },
        ],
        edges: [{ from: "a", to: "b", kind: "data", label: "isi" }, { from: "b", to: "c", kind: "data", label: "lolos" }, { from: "c", to: "z", kind: "data", label: "simpan" }],
        legend: ["TERUKUR = nilai diukur; ASUMSI = nilai asumsi; DITURUNKAN = nilai turunan."],
      })
      const r = build.buildDiagramSvg(structuredClone(s), { release: true })
      expect((r.svg.match(/[■□▲△◆◇●○]/g) ?? []).length).toBeGreaterThan(0)
      expect(lint.lintDiagramGeometry(r.svg).counts.textOverNode ?? 0).toBe(0)
    })
  }
})
