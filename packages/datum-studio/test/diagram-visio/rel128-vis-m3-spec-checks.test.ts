// Swarm 1.2.8 row 52c (contributor to AC-VIS2a, VIS3a, VIS3b, VIS4, VIS5, VIS6, VIS7; plan P-20, P-24; F-VISIO 01f
// §1.5, §2.2, §3.3, §3.6; register N8-267 P1-edge-style, N8-268 P1-via, N8-269 P3-via-family, N8-270 P1-containers,
// N8-271 P1-event_type). Unit tests of the M3 field-level checks in core/spec.ts `validateSpec`. The owning rows keep
// their AC tests (54, 55, 56, 56b, 57); this file tests the checks themselves on small synthetic specs.
// Invariant (01f §3.2.6): a spec without the 1.2.8 fields gets the same verdict and the same `ran` list as before; each
// new check runs only when its field is present (the P1-direction pattern).
// Red at BASE e1f9673772: the five ids do not exist and gateways are unknown shapes. Namespace import, so the red run
// fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { describe, expect, test } from "bun:test"
import * as specMod from "../../vendor/src/lib/studio/engine/diagram/core/spec"

type J = Record<string, any>
const M = specMod as J
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
const NEW_IDS = ["P1-event_type", "P1-containers", "P1-edge-style", "P1-via", "P3-via-family"]
/** `ran` of a legacy spec at BASE e1f9673772 (no direction, no release gate). */
const LEGACY_RAN = [
  "P1-family",
  "P1-id",
  "P1-title",
  "P1-classification",
  "P1-width_mm",
  "P1-apparatus",
  "P1-sources",
  "P1-nodes+P3-shapes",
  "DATUM-35",
  "DATUM-24",
  "DATUM-26",
  "DATUM-34",
  "P3-diamond-exits",
]

/** Three boxes a -> b -> c, all valid; `family` and per-node class overridable. */
function base(family = "flow", cls: (i: number) => J = () => ({})): J {
  const nodes = ["a", "b", "c"].map((id, i) => ({ id, label: `Alfa ${i + 1}`, class: cls(i) }))
  const edges = [
    { from: "a", to: "b", kind: "data", label: "lanjut" },
    { from: "b", to: "c", kind: "data", label: "lanjut" },
  ]
  return { family, id: "1.1", title: "Uji cek M3.", classification: "BIASA", width_mm: 128, labels_verified: true, sources: ["S"], nodes, edges }
}
const swim = () => base("swimlane", (i) => ({ lane: i < 2 ? "L1" : "L2" }))
const run = (s: J): J[] => M.validateSpec(clone(s)) as J[]
const fails = (s: J, id: string): J[] => run(s).filter((i) => i.checkId === id && i.status === "FAIL")
const passes = (s: J, id: string): boolean => run(s).some((i) => i.checkId === id && i.status === "PASS")
const ran = (s: J): string[] => M.checksRunOf(run(s))
const listed = (s: J): string[] => [...new Set(run(s).map((i) => i.checkId))]

describe("rel128 M3 spec checks: ids and the legacy invariant", () => {
  test("SPEC_CHECK_IDS carries the five new ids in run order, P3-diamond-exits kept last", () => {
    const ids = [...(M.SPEC_CHECK_IDS as string[])]
    for (const id of NEW_IDS) expect(ids).toContain(id)
    expect(ids.indexOf("P1-event_type")).toBe(ids.indexOf("P1-nodes+P3-shapes") + 1)
    expect(ids.indexOf("P1-containers")).toBe(ids.indexOf("P1-event_type") + 1)
    expect(ids.indexOf("P1-edge-style")).toBe(ids.indexOf("DATUM-26") + 1)
    expect(ids.slice(ids.indexOf("P1-edge-style"), ids.indexOf("P1-edge-style") + 3)).toEqual(["P1-edge-style", "P1-via", "P3-via-family"])
    expect(ids[ids.length - 1]).toBe("P3-diamond-exits")
    expect(ids.indexOf("P1-direction")).toBe(ids.indexOf("P1-sources") + 1)
  })
  test("legacy flow and swimlane specs: no new id listed, `ran` equals the BASE list, no FAIL", () => {
    for (const s of [base(), swim(), base("graph", (i) => ({ col: i, row: 0 }))]) {
      for (const id of NEW_IDS) expect(listed(s)).not.toContain(id)
      expect(ran(s)).toEqual(LEGACY_RAN)
      expect(run(s).filter((i) => i.status === "FAIL")).toEqual([])
    }
  })
  test("each check runs only for its own field", () => {
    const s = base()
    s.edges[0].dash = "dashed"
    expect(listed(s)).toContain("P1-edge-style")
    for (const id of ["P1-event_type", "P1-containers", "P1-via", "P3-via-family"]) expect(listed(s)).not.toContain(id)
    const v = base("graph", (i) => ({ col: i, row: 0 }))
    v.edges[0].via = [{ col: 1, row: 2 }]
    expect(ran(v)).toEqual([...LEGACY_RAN.slice(0, -2), "P1-via", "P3-via-family", ...LEGACY_RAN.slice(-2)])
  })
  test("assertValidSpec throws the new id as checkId", () => {
    const s = base()
    s.edges[0].from_slot = 0.5
    let caught: J | undefined
    try {
      M.assertValidSpec(clone(s))
    } catch (e) {
      caught = e as J
    }
    expect(caught?.details?.checkId ?? caught?.checkId).toBe("P1-edge-style")
  })
})

describe("rel128 M3 spec checks: P1-event_type (N8-271, VIS-3a)", () => {
  test("event_type on a task is refused at /nodes/<i>/event_type", () => {
    const s = base()
    s.nodes[1].shape = "task"
    s.nodes[1].event_type = "message"
    const f = fails(s, "P1-event_type")
    expect(f.length).toBe(1)
    expect(f[0].pointer).toBe("/nodes/1/event_type")
    expect(f[0].detail).toContain("event_type hanya untuk event_start/event_intermediate/event_end")
  })
  test("event_type on a box (shape absent) is refused", () => {
    const s = base()
    s.nodes[0].event_type = "none"
    expect(fails(s, "P1-event_type").length).toBe(1)
  })
  test("three events x three event_type pass; an unknown value is refused", () => {
    const s = base()
    s.nodes = ["event_start", "event_intermediate", "event_end"].flatMap((shape, i) =>
      ["none", "message", "timer"].map((t, j) => ({ id: `e${i}${j}`, label: `Ev ${i}${j}`, shape, event_type: t, class: {} })),
    )
    s.edges = [{ from: "e00", to: "e10", kind: "data", label: "lanjut" }]
    expect(fails(s, "P1-event_type")).toEqual([])
    expect(passes(s, "P1-event_type")).toBe(true)
    s.nodes[4].event_type = "error"
    const f = fails(s, "P1-event_type")
    expect(f.length).toBe(1)
    expect(f[0].pointer).toBe("/nodes/4/event_type")
    expect(f[0].detail).toContain("none/message/timer")
  })
})

describe("rel128 M3 spec checks: P3-diamond-exits for gateways (01f §1.5, VIS-3b)", () => {
  for (const g of ["gateway_exclusive", "gateway_parallel", "gateway_inclusive", "gateway_complex"]) {
    test(`${g} without an exit is refused and named`, () => {
      const s = base()
      s.nodes[2].shape = g
      const f = fails(s, "P3-diamond-exits")
      expect(f.length).toBe(1)
      expect(f[0].pointer).toBe("/nodes/2")
      expect(f[0].detail).toBe(`keputusan ${g} 'c' tanpa keluaran berlabel (P3: every exit labelled)`)
      s.edges.push({ from: "c", to: "a", kind: "data", label: "ya" })
      expect(fails(s, "P3-diamond-exits")).toEqual([])
    })
  }
  test("diamond wording unchanged", () => {
    const s = base()
    s.nodes[2].shape = "diamond"
    expect(fails(s, "P3-diamond-exits")[0].detail).toBe("keputusan 'c' tanpa keluaran berlabel (P3: every exit labelled)")
  })
})

describe("rel128 M3 spec checks: P1-containers (N8-270, 01f §2.2, VIS-2a)", () => {
  const phased = (): J => {
    const s = swim()
    s.phases = [
      { id: "p1", label: "Fase 1" },
      { id: "p2", label: "Fase 2" },
    ]
    s.nodes.forEach((n: J, i: number) => (n.class.phase = i < 2 ? "p1" : "p2"))
    return s
  }
  test("valid swimlane with phases, pools and lane_orientation passes", () => {
    const s = phased()
    s.pools = [{ id: "o1", label: "Organisasi" }]
    s.nodes.forEach((n: J) => (n.class.pool = "o1"))
    s.lane_orientation = "vertical"
    expect(fails(s, "P1-containers")).toEqual([])
    expect(passes(s, "P1-containers")).toBe(true)
  })
  test("cause 1: phases, pools or lane_orientation outside the swimlane family", () => {
    for (const [k, v] of [
      ["phases", [{ id: "p1", label: "F" }]],
      ["pools", [{ id: "o1", label: "O" }]],
      ["lane_orientation", "horizontal"],
    ] as const) {
      const s = base()
      s[k] = v
      const f = fails(s, "P1-containers").filter((i) => i.pointer === `/${k}`)
      expect(f.length).toBe(1)
      expect(f[0].detail).toContain("hanya untuk family swimlane")
    }
  })
  test("cause 2: duplicate phase id and duplicate pool id", () => {
    const s = phased()
    s.phases.push({ id: "p1", label: "Lagi" })
    expect(fails(s, "P1-containers").map((i) => i.pointer)).toEqual(["/phases/2/id"])
    const p = swim()
    p.pools = [
      { id: "o1", label: "A" },
      { id: "o1", label: "B" },
    ]
    p.nodes.forEach((n: J) => (n.class.pool = "o1"))
    expect(fails(p, "P1-containers").map((i) => i.pointer)).toEqual(["/pools/1/id"])
  })
  test("cause 3: class.phase / class.pool naming an unknown id", () => {
    const s = phased()
    s.nodes[2].class.phase = "p9"
    expect(fails(s, "P1-containers").map((i) => i.pointer)).toEqual(["/nodes/2/class/phase"])
    const p = swim()
    p.nodes[0].class.pool = "o9"
    expect(fails(p, "P1-containers").map((i) => i.pointer)).toEqual(["/nodes/0/class/pool"])
  })
  test("cause 4: phases present but a node without class.phase (all or nothing); same for pools", () => {
    const s = phased()
    delete s.nodes[1].class.phase
    const f = fails(s, "P1-containers")
    expect(f.map((i) => i.pointer)).toEqual(["/nodes/1/class"])
    expect(f[0].detail).toContain("tanpa class.phase")
    const p = swim()
    p.pools = [{ id: "o1", label: "A" }]
    p.nodes[0].class.pool = "o1"
    expect(fails(p, "P1-containers").map((i) => i.pointer)).toEqual(["/nodes/1/class", "/nodes/2/class"])
  })
  test("cause 5: over PHASES_MAX (8) and POOLS_MAX (4)", () => {
    const s = phased()
    s.phases = Array.from({ length: 9 }, (_, i) => ({ id: `p${i + 1}`, label: `F${i + 1}` }))
    const f = fails(s, "P1-containers")
    expect(f.map((i) => i.pointer)).toEqual(["/phases"])
    expect(f[0].detail).toContain("maksimum 8")
    const p = swim()
    p.pools = Array.from({ length: 5 }, (_, i) => ({ id: `o${i + 1}`, label: `O${i + 1}` }))
    p.nodes.forEach((n: J) => (n.class.pool = "o1"))
    expect(fails(p, "P1-containers")[0].detail).toContain("maksimum 4")
  })
  test("cause 6: a pool whose nodes carry no class.lane, and a lane name repeated across pools, are allowed", () => {
    const s = base("swimlane", (i) => (i === 0 ? { lane: "L1", pool: "o1" } : i === 1 ? { pool: "o2" } : { lane: "L1", pool: "o2" }))
    s.pools = [
      { id: "o1", label: "A" },
      { id: "o2", label: "B" },
    ]
    expect(fails(s, "P1-containers")).toEqual([])
    expect(passes(s, "P1-containers")).toBe(true)
  })
  test("malformed container entries and an unknown lane_orientation are refused", () => {
    const s = phased()
    s.phases[1] = { id: "", label: "X" }
    s.lane_orientation = "diagonal"
    const ptrs = fails(s, "P1-containers").map((i) => i.pointer)
    expect(ptrs).toContain("/phases/1")
    expect(ptrs).toContain("/lane_orientation")
  })
})

describe("rel128 M3 spec checks: P1-edge-style (N8-267, 01f §3.6, VIS-4/5/7)", () => {
  test("a full valid style set passes", () => {
    const s = base()
    Object.assign(s.edges[0], {
      route: "straight",
      from_side: "right",
      to_side: "left",
      from_slot: 0.25,
      to_slot: 0.75,
      arrow_start: "circle",
      arrow_start_size: "s",
      arrow_end: "open",
      arrow_end_size: "l",
      dash: "dashdot",
      weight: "thick",
      label_at: "middle",
    })
    s.jumps = "off"
    expect(fails(s, "P1-edge-style")).toEqual([])
    expect(passes(s, "P1-edge-style")).toBe(true)
  })
  test("cause 4 (VIS-4): curved + via is refused at /edges/<i>/via", () => {
    const s = base("graph", (i) => ({ col: i, row: 0 }))
    Object.assign(s.edges[1], { route: "curved", via: [{ col: 1, row: 1 }] })
    const f = fails(s, "P1-edge-style")
    expect(f.map((i) => i.pointer)).toEqual(["/edges/1/via"])
    expect(f[0].detail).toContain("curved")
    s.edges[1].route = "straight"
    expect(fails(s, "P1-edge-style")).toEqual([])
  })
  test("cause 1 (VIS-5): slot without side, and slot with side auto", () => {
    const s = base()
    s.edges[0].from_slot = 0.5
    s.edges[1].to_slot = 0.5
    s.edges[1].to_side = "auto"
    expect(fails(s, "P1-edge-style").map((i) => i.pointer)).toEqual(["/edges/0/from_slot", "/edges/1/to_slot"])
  })
  test("cause 2: slot outside (0, 1) or not a number", () => {
    for (const v of [0, 1, -0.2, 1.5, "0.5"]) {
      const s = base()
      Object.assign(s.edges[0], { from_side: "top", from_slot: v })
      expect(fails(s, "P1-edge-style").map((i) => i.pointer)).toEqual(["/edges/0/from_slot"])
    }
  })
  test("cause 5 (VIS-5): an explicit side on an edge touching a bus node", () => {
    const s = base()
    s.nodes[1].shape = "bus"
    s.edges[0].to_side = "top"
    s.edges[1].from_side = "bottom"
    expect(fails(s, "P1-edge-style").map((i) => i.pointer)).toEqual(["/edges/0/to_side", "/edges/1/from_side"])
    s.edges[0].to_side = "auto"
    s.edges[1].from_side = "auto"
    expect(fails(s, "P1-edge-style")).toEqual([])
  })
  test("cause 3 (VIS-7): a head size without a head", () => {
    const s = base()
    s.edges[0].arrow_start_size = "l"
    s.edges[1].arrow_start = "none"
    s.edges[1].arrow_start_size = "s"
    expect(fails(s, "P1-edge-style").map((i) => i.pointer)).toEqual(["/edges/0/arrow_start_size", "/edges/1/arrow_start_size"])
    const e = base()
    e.edges[0].arrow_end_size = "s"
    expect(fails(e, "P1-edge-style")).toEqual([])
    e.edges[0].arrow_end = "none"
    expect(fails(e, "P1-edge-style").map((i) => i.pointer)).toEqual(["/edges/0/arrow_end_size"])
  })
  test("cause 6: unknown enum values are refused per field", () => {
    const s = base()
    Object.assign(s.edges[0], { route: "spline", dash: "wavy", weight: "bold", arrow_end: "arrow", label_at: "top" })
    s.jumps = "maybe"
    const ptrs = fails(s, "P1-edge-style").map((i) => i.pointer)
    expect(ptrs).toEqual(["/jumps", "/edges/0/route", "/edges/0/arrow_end", "/edges/0/dash", "/edges/0/weight", "/edges/0/label_at"])
  })
})

describe("rel128 M3 spec checks: P1-via and P3-via-family (N8-268, N8-269, D-V3, VIS-6)", () => {
  const graph = () => base("graph", (i) => ({ col: i, row: 0 }))
  test("negative col, non-integer row, non-object point and 9 points are refused", () => {
    const s = graph()
    s.edges[0].via = [{ col: -1, row: 0 }, { col: 1, row: 0.5 }, "x"]
    const f = fails(s, "P1-via")
    expect(f.map((i) => i.pointer)).toEqual(["/edges/0/via/0", "/edges/0/via/1", "/edges/0/via/2"])
    expect(f[0].detail).toContain("figure.lattice")
    const n = graph()
    n.edges[0].via = Array.from({ length: 9 }, (_, i) => ({ col: i, row: 1 }))
    expect(fails(n, "P1-via").map((i) => i.detail)).toEqual([expect.stringContaining("maksimum 8")])
    const e = graph()
    e.edges[0].via = []
    expect(fails(e, "P1-via").length).toBe(1)
  })
  test("eight valid points pass", () => {
    const s = graph()
    s.edges[0].via = Array.from({ length: 8 }, (_, i) => ({ col: i, row: 1 }))
    expect(fails(s, "P1-via")).toEqual([])
    expect(passes(s, "P1-via")).toBe(true)
  })
  test("via allowed in flow without direction, graph and swimlane", () => {
    for (const s of [base(), graph(), swim()]) {
      s.edges[0].via = [{ col: 2, row: 2 }]
      expect(fails(s, "P3-via-family")).toEqual([])
      expect(passes(s, "P3-via-family")).toBe(true)
    }
  })
  test("via refused in layered, topology, stack, sequence, sld, rack and ranked flow; family named", () => {
    for (const fam of ["layered", "topology", "stack", "sequence", "sld", "rack"]) {
      const s = base(fam, () => ({ tier: 1 }))
      s.edges[1].via = [{ col: 2, row: 2 }]
      const f = fails(s, "P3-via-family")
      expect(f.length).toBe(1)
      expect(f[0].pointer).toBe("/edges/1/via")
      expect(f[0].detail).toContain(`'${fam}'`)
      expect(f[0].detail).toContain("flow tanpa direction, graph, swimlane")
    }
    const r = base()
    r.direction = "LR"
    r.edges[0].via = [{ col: 2, row: 2 }]
    expect(fails(r, "P3-via-family")[0].detail).toContain("'flow + direction'")
  })
})
