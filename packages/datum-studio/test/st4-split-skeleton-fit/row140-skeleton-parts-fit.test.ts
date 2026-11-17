// Swarm 1.3.3 row 140 (ST-4, engine defect E6 of row 36): the split skeleton of a capacity refusal offers only parts
// that themselves pass the build's capacity check at the width in use.
//   (1) off-page nodes of a tiered family (layered, topology, stack) sit on a tier of their own at the cut edge;
//   (2) one off-page pair per pair of nodes joined across the cut (several connectors share it, each keeps its label);
//   (3) each part is built before the skeleton is offered; if no cut gives two parts that pass, no skeleton is offered
//       and the refusal says which part is still refused and by which limit.
// Acceptance case: Gambar 16.6 of the manual with row 36's adaptations D1-D3, rendered at `full` through the same two
// product paths as row 36 (document render and preview), using row 36's harness and fixture (read-only).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import type { StudioDiagramV1 } from "../../vendor/src/lib/studio/contract"
import { DiagramDefect } from "../../vendor/src/lib/studio/engine/diagram/core"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build"
import {
  CAPACITY_SPLIT_MAX_PARTS,
  SPLIT_PLACEHOLDER_PART_1,
  SPLIT_PLACEHOLDER_PART_2,
  overCapacityOf,
  splitSkeletonOf,
  type DiagramOverCapacityDetails,
  type DiagramSplitSkeleton,
} from "../../vendor/src/lib/studio/engine/diagram/build/capacity"
import { FIXTURE_FILE, createHarness, gambar166Spec, readJson, type G166Family, type Harness, type ProbeOutcome } from "../st1-capacity-table/capacity-harness"

type Rec = Record<string, any>
const D1_D3 = ["D1", "D2", "D3"] as const
const PART_IDS = ["g16-6-a", "g16-6-b"] as const
const fill = (k: DiagramSplitSkeleton): [Rec, Rec] =>
  JSON.parse(JSON.stringify(k.specs).replaceAll(SPLIT_PLACEHOLDER_PART_1, PART_IDS[0]).replaceAll(SPLIT_PLACEHOLDER_PART_2, PART_IDS[1]))
const offpages = (s: Rec): Rec[] => (s.nodes as Rec[]).filter((n) => n.shape === "offpage")
const real = (s: Rec): Rec[] => (s.nodes as Rec[]).filter((n) => n.shape !== "offpage")
/** The v2 block an agent writes from a filled part (same fields as row 36's harness `PART_FIELDS`). */
const v2Of = (part: Rec): Rec => {
  const out: Rec = { family: part.family, nodes: part.nodes, edges: part.edges }
  for (const k of ["zones", "legend", "notes", "tiers", "direction"]) if (part[k] !== undefined) out[k] = part[k]
  return out
}

let h: Harness
let fx: Rec
const text = () => ({ caption: fx.caption as string, source: fx.sourceLine as string })
const skeletonFor = (family: G166Family): DiagramSplitSkeleton | null =>
  splitSkeletonOf(h.composed(gambar166Spec(fx, family, [...D1_D3]), "full", text()) as unknown as StudioDiagramV1)

/** Outcomes of the two parts through both product paths, recorded for the report (console) and asserted below. */
const outcomes: Record<string, ProbeOutcome[]> = {}

beforeAll(async () => {
  h = await createHarness()
  fx = readJson(FIXTURE_FILE)
}, 120_000)
afterAll(() => h?.dispose())

describe("row 140: Gambar 16.6 (D1-D3) at full gets a skeleton whose parts pass", () => {
  for (const family of ["layered", "topology"] as const) {
    it(`${family}: both parts pass the capacity check of the build and are not refused on either product path`, async () => {
      // the one-sheet figure is refused (row 36): that is why a skeleton is needed
      const one = await h.probe(gambar166Spec(fx, family, [...D1_D3]), "full", text())
      const k = skeletonFor(family)
      expect(k).not.toBeNull()
      expect(k!.specs.length).toBe(CAPACITY_SPLIT_MAX_PARTS)
      const parts = fill(k!)
      // (3) the capacity check itself: the engine build of each filled part does not throw
      for (const p of parts) expect(() => buildDiagramSvg(structuredClone(p) as unknown as StudioDiagramV1, { release: false })).not.toThrow()
      // the product paths: document render and preview, as row 36 probes them
      const got: ProbeOutcome[] = []
      for (const [i, p] of parts.entries()) got.push(await h.probe(v2Of(p), "full", { caption: `Polres–Polda VMS architecture, part ${i + 1} of 2.`, source: text().source }))
      outcomes[family] = got
      console.log(`[row140] ${family} one sheet: ${JSON.stringify(one)}`)
      console.log(`[row140] ${family} cut ${k!.axis}, parts ${k!.specs.map((s) => s.nodes.length).join(" + ")} nodes, pairs ${k!.pairs.map((p) => `${p.key} ${p.from}>${p.to} x${p.connectors.length}`).join(", ")}`)
      for (const [i, o] of got.entries()) console.log(`[row140] ${family} part ${i + 1}: ${JSON.stringify(o)}`)
      for (const o of got) {
        expect(o.result).not.toBe("refused")
        expect(o.preview?.result).not.toBe("refused")
      }
    }, 120_000)
  }

  it("one pair per node pair: the two FW-01 -> WAN edge connectors share one pair, each half keeps its label", () => {
    const k = skeletonFor("layered")!
    const fw = k.pairs.filter((p) => [p.from, p.to].includes("fw01") && [p.from, p.to].includes("wanedge"))
    expect(fw.length).toBe(1)
    expect(fw[0].connectors.map((c) => c.label)).toEqual(["MPLS 100 Mb/s · 16 Mb/s used", "LTE backup · alarms only"])
    // every pair joins a distinct pair of nodes
    const nodePairs = k.pairs.map((p) => [p.from, p.to].sort().join("|"))
    expect(new Set(nodePairs).size).toBe(k.pairs.length)
    // both halves of both connectors are present, on the shared off-page node, with their own label and kind
    const [a, b] = k.specs as unknown as [Rec, Rec]
    const id = fw[0].offpage[0]
    const halves = [...a.edges, ...b.edges].filter((e: Rec) => e.from === id || e.to === id)
    expect(halves.length).toBe(4)
    expect(halves.map((e: Rec) => e.label).sort()).toEqual(["LTE backup · alarms only", "LTE backup · alarms only", "MPLS 100 Mb/s · 16 Mb/s used", "MPLS 100 Mb/s · 16 Mb/s used"])
    // exactly one off-page node per pair per part
    for (const s of [a, b]) expect(offpages(s).length).toBe(k.pairs.length)
  })

  it("(1) the off-page nodes of a tiered family take a tier of their own at the cut edge", () => {
    const k = skeletonFor("layered")!
    expect(k.axis).toBe("class.tier")
    const [a, b] = k.specs as unknown as [Rec, Rec]
    const tiersOf = (ns: Rec[]) => ns.map((n) => Number(n.class.tier))
    const aReal = tiersOf(real(a))
    const bReal = tiersOf(real(b))
    // part 1 holds the upper tiers: its off-page tier is one below its last tier, and is the last tier in node order
    for (const n of offpages(a)) expect(n.class).toEqual({ tier: Math.max(...aReal) + 1 })
    expect((a.nodes as Rec[]).slice(-offpages(a).length).every((n) => n.shape === "offpage")).toBe(true)
    // part 2 holds the lower tiers: its off-page tier is one above its first tier, and is the first tier in node order
    for (const n of offpages(b)) expect(n.class).toEqual({ tier: Math.min(...bReal) - 1 })
    expect((b.nodes as Rec[]).slice(0, offpages(b).length).every((n) => n.shape === "offpage")).toBe(true)
    // no real node of a part shares the off-page tier
    expect(aReal).not.toContain(Math.max(...aReal) + 1)
    expect(bReal).not.toContain(Math.min(...bReal) - 1)
  })
})

describe("row 140: a skeleton whose parts would still be refused is never offered", () => {
  const flowWide = (): Rec => ({
    $schema: "studio.diagram/v1",
    family: "flow",
    id: "Gambar 2.1",
    title: "Alur paralel.",
    classification: "INTERNAL",
    width_mm: 166,
    sources: ["Dokumen desain"],
    direction: "TB",
    nodes: [{ id: "a", label: "Mulai", class: {} }, ...Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, label: `Cabang ${i + 1}`, class: {} })), { id: "z", label: "Selesai", class: {} }],
    edges: [...Array.from({ length: 7 }, (_, i) => ({ from: "a", to: `p${i}`, kind: "control", label: "bagi" })), ...Array.from({ length: 7 }, (_, i) => ({ from: `p${i}`, to: "z", kind: "control", label: "gabung" }))],
  })

  it("TB flow with 7 nodes in one rank at full: no skeleton; the refusal names the part and the limit", () => {
    let e: { code: string; message: string; details: DiagramOverCapacityDetails } | undefined
    try {
      buildDiagramSvg(flowWide() as unknown as StudioDiagramV1, { release: false })
    } catch (x) {
      e = x as never
    }
    expect(e).toBeDefined()
    expect(e!.code).toBe("FIGURE_OVER_CAPACITY")
    expect(e!.details.checkId).toBe("DATUM-37-rank")
    expect(e!.details.split).toBeUndefined()
    expect(e!.details.suggestion).toMatch(/kerangka pecahan tidak ditawarkan: .*bagian [12] \(\d+ simpul\) tetap ditolak DATUM-37-\w+: .* maks \d+ .*, terukur \d+/)
    expect(e!.details.suggestion).toContain(`paling banyak ${CAPACITY_SPLIT_MAX_PARTS} bagian`)
    // message and details say the same
    expect(e!.message).toContain(e!.details.suggestion)
    expect(splitSkeletonOf(flowWide() as unknown as StudioDiagramV1)).toBeNull()
  })

  it("every skeleton that is offered builds: graph refusal (7 columns) parts pass the build", () => {
    const g = {
      $schema: "studio.diagram/v1",
      family: "graph",
      id: "Gambar 2.1",
      title: "Arsitektur jaringan.",
      classification: "INTERNAL",
      width_mm: 166,
      sources: ["Dokumen desain"],
      nodes: Array.from({ length: 7 }, (_, c) => ({ id: `g${c}`, label: `Simpul ${c + 1}`, class: { col: c, row: 0 } })),
      edges: Array.from({ length: 6 }, (_, c) => ({ from: `g${c}`, to: `g${c + 1}`, kind: "data", label: `alir ${c + 1}` })),
    }
    const o = overCapacityOf(new DiagramDefect("DATUM-37-sheet: uji", { checkId: "DATUM-37-sheet" }), g as unknown as StudioDiagramV1)!
    const k = (o.details as DiagramOverCapacityDetails).split!
    expect(k).toBeDefined()
    for (const p of fill(k)) expect(() => buildDiagramSvg(p as unknown as StudioDiagramV1, { release: false })).not.toThrow()
  })
})
