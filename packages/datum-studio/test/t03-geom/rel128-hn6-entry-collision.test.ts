/**
 * Swarm 1.2.8 row 35c (AT-HN6 / AC-HN6, register N8-341; decision C25: run as a PROBE).
 *
 * Question: does an ENGINE-built diagram exist whose SVG `lintDiagramGeometry` counts `edgeEntryCollision >= 1`
 * while the figure preview (`renderResolved`, the machine gate) lists no `GEOM_ENTRY_COLLISION`?
 *
 * Probe, not a red-green pin: for the row 25b fixture `syn128/hn6_engine_entry_collision.json` (5-way fan-in on one
 * side) and a seeded set of fan-in variants (left/right 5 and 6 sources, top/bottom 4 and 5, at 128 and 166 mm; graph family; a
 * layout the engine refuses for capacity is skipped), the preview lists
 * `GEOM_ENTRY_COLLISION` (class defect) exactly when the lint of the SVG it returns counts the kind. A red here at
 * BASE would have met the AT-HN6 premise; green at BASE = "not reproduced" (C25), no product change.
 * The fixture's `measured` block (row 25b) is checked against the current engine, so a later engine change that
 * makes the fan-in collide is seen here first.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint"
import { renderResolved } from "../../src/mcp-host/local-api/routes/figure-preview-figure"

type J = Record<string, any>
const PKG = path.resolve(import.meta.dir, "..", "..")
const FX = JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "syn128", "hn6_engine_entry_collision.json"), "utf8")) as {
  spec: J
  measured: { edgeEntryCollision: number; stubSegment: number }
}

async function preview(spec: J) {
  const p = await renderResolved(
    { block: { blockId: "hn6", address: "1.1", type: "diagram", content: {} } as never, type: "diagram", spec: structuredClone(spec) as never },
    { params: {} } as never,
    { inline: true, withSvg: true, lang: "ID" },
  )
  const lint = lintDiagramGeometry(p.svg as string)
  return {
    collisions: lint.counts.edgeEntryCollision ?? 0,
    listed: p.defects.some((d) => d.checkId === "GEOM_ENTRY_COLLISION"),
    notice: p.notices.some((d) => d.checkId === "GEOM_ENTRY_COLLISION"),
  }
}

/** Fan-in of `n` sources into one side of `t` (graph lattice, no empty column or row). */
function fanIn(side: "left" | "right" | "top" | "bottom", n: number, width: 128 | 166): J {
  const nodes: J[] = []
  const edges: J[] = []
  const mid = Math.floor((n - 1) / 2)
  for (let i = 0; i < n; i++) {
    const cls = side === "left" ? { col: 0, row: i } : side === "right" ? { col: 1, row: i } : side === "top" ? { col: i, row: 0 } : { col: i, row: 1 }
    nodes.push({ id: `s${i}`, label: `Sumber ${String.fromCharCode(65 + i)}`, class: cls })
    edges.push({ from: `s${i}`, to: "t", kind: "data", label: `m${i + 1}` })
  }
  const t = side === "left" ? { col: 1, row: mid } : side === "right" ? { col: 0, row: mid } : side === "top" ? { col: mid, row: 1 } : { col: mid, row: 0 }
  nodes.push({ id: "t", label: "Tujuan", class: t })
  return { ...structuredClone(FX.spec), width_mm: width, nodes, edges }
}

describe("AT-HN6 probe (N8-341): engine entry collision vs the figure preview", () => {
  test("fixture: the preview lists GEOM_ENTRY_COLLISION exactly when the lint of its SVG counts it", async () => {
    const r = await preview(FX.spec)
    expect(r.notice).toBe(false)
    expect(r.listed).toBe(r.collisions >= 1)
    // Row 25b measurement still holds for the current engine (premise state recorded in the ledger).
    expect(r.collisions).toBe(FX.measured.edgeEntryCollision)
  })

  test("seeded fan-in variants: preview and lint agree on every render", async () => {
    const seen: string[] = []
    const refused: string[] = []
    for (const side of ["left", "right", "top", "bottom"] as const)
      for (const n of side === "left" || side === "right" ? [5, 6] : [4, 5])
        for (const w of [128, 166] as const) {
          let r: Awaited<ReturnType<typeof preview>>
          try {
            r = await preview(fanIn(side, n, w))
          } catch (e) {
            // A refused layout (FIGURE_OVER_CAPACITY: too many columns at this width) renders nothing to compare.
            expect((e as { code?: string }).code).toBe("FIGURE_OVER_CAPACITY")
            refused.push(`${side}/${n}/${w}`)
            continue
          }
          expect(r.notice).toBe(false)
          expect({ side, n, w, listed: r.listed }).toEqual({ side, n, w, listed: r.collisions >= 1 })
          if (r.collisions >= 1) seen.push(`${side}/${n}/${w}:${r.collisions}`)
        }
    expect(16 - refused.length).toBeGreaterThanOrEqual(8)
    // Probe record (not a gate): engine fan-ins with an entry collision, if any.
    console.log(`HN6 probe: ${16 - refused.length} rendered, ${refused.length} refused ${JSON.stringify(refused)}; ${seen.length} with edgeEntryCollision >= 1 ${JSON.stringify(seen)}`)
  })
})
