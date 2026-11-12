// 1.2.6 row FX-7 item c (M2 S3, N1; follow-up of rows 46/47, T-11 + T-02): the ranked-flow TB placement and the ELK
// tier placement share ONE clamp helper (elk/plan.ts clampTierXs). The ranked TB branch hands ELK the T-02 inset
// window [0, floor((W - 2 x GRAPH_EDGE_INSET_MM) / lx) x lx], so an ELK plan that puts a 4-wide rank against a sheet
// edge is clamped inside the inset instead of throwing DATUM-37-lebar in applyEdgeInset (which made R4 discard the
// ELK build). Seam test: the plan is injected with withElkPlan (ELK itself does not produce an edge plan for the
// 14.1 fixture, R2 stops first). Layered (legacy) callers keep the full-width window, so their bytes do not move.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const D = path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const plans = await import(path.join(D, "elk", "plan.ts"))
const K1 = JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "anon126", "t11_k1.json"), "utf8"))
const W = 128
const INSET = 2

const nodeBoxes = (svg: string) =>
  [...svg.matchAll(/<rect\b([^>]*\bdata-mark="node"[^>]*)\/>/g)].map((m) => {
    const a = Object.fromEntries([...m[1].matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((x) => [x[1], x[2]]))
    return { id: a["data-node"], x: +a.x, w: +a.width }
  })

// ELK frame: rank 0 node against the left edge, the 4-wide rank 1 pushed against the right edge.
const edgePlan = (s: any) => ({
  key: plans.elkPlanKey(s),
  widthMm: W,
  direction: "TB",
  routes: false,
  order: { "0": ["n1"], "1": ["n2", "n3", "n4", "n5"], "2": ["n6", "n7"], "3": ["n8"] },
  cx: { n1: 16, n2: 21.33, n3: 53.33, n4: 85.33, n5: 117.33, n6: 32, n7: 96, n8: 64 },
  box: {},
  sections: [],
  layers: [["n1"], ["n2", "n3", "n4", "n5"], ["n6", "n7"], ["n8"]],
})

describe("FX-7 c (M2 S3): ranked TB ELK placement honours the T-02 inset", () => {
  test("a 4-wide rank at 128 mm with an edge-hugging ELK plan builds (no DATUM-37-lebar), every node inside the inset", () => {
    const s = { ...structuredClone(K1), width_mm: W, direction: "TB" }
    let err: any
    let svg = ""
    try {
      svg = plans.withElkPlan(edgePlan(s), () => build.buildDiagramSvg(s, { release: false })).svg
    } catch (e) {
      err = e
    }
    expect(err?.details?.checkId ?? err?.code ?? "built").toBe("built")
    const boxes = nodeBoxes(svg)
    expect(boxes.length).toBe(8)
    for (const b of boxes) {
      expect([b.id, b.x >= INSET - 1e-6]).toEqual([b.id, true])
      expect([b.id, b.x + b.w <= W - INSET + 1e-6]).toEqual([b.id, true])
    }
  })

  test("clampTierXs: one helper, explicit window; keeps order and gap, null when the tier does not fit", () => {
    expect(plans.clampTierXs([-5, 0, 200], 10, 2, 100)).toEqual([0, 12, 100])
    expect(plans.clampTierXs([0, 0, 0], 40, 10, 60)).toBeUndefined()
  })
})
