// Swarm 1.2.6 row 97 (G-01, W-01, W-02, W-14, T-11 guide line): the working norms in studio://skema/diagram.
// GUIDE pins: each norm appears exactly once, the numbers come from the engine constants, no 1.2.5 workaround
// survives, and the text names no project.
import { describe, expect, test } from "bun:test"
import { diagramGuideText } from "../../src/mcp-host/diagram-guide.ts"
// Namespace imports: at 1.2.5 some constants do not exist yet, so the red run fails on assertions, not on a link error.
import * as sheet from "../../vendor/src/lib/studio/engine/diagram/core/sheet.ts"
import * as tokens from "../../vendor/src/lib/studio/engine/diagram/core/tokens.ts"
import * as flow from "../../vendor/src/lib/studio/engine/diagram/layout-a/flow.ts"
import * as route from "../../vendor/src/lib/studio/engine/diagram/build/route.ts"
import * as bounds from "../../vendor/src/lib/studio/contract/schema/figure-bounds.ts"

const t = diagramGuideText()
const count = (s: string) => t.split(s).length - 1
const K = { cap: 100, inset: 2, fan: 4, tb128: 4, tb166: 5, lrPar: 6, lr128: 3, lr166: 4 }

describe("row 97: diagram resource norms (G-01)", () => {
  const NORMS: Array<[string, string]> = [
    ["W-02 dual gate (FX-10, C19a)", "Figure gate: machine gate = the inline preview (the standalone preview is not the gate)"],
    ["W-01 caption", `Studio prints the label; the caption never starts with it; at most ${K.cap} characters`],
    ["labels ~20/~40 + sub (FX-10, C19b: the engine hints)", "edge label at most ~20 characters, node label at most ~40; a second detail goes in `sub`"],
    ["one accent", "One accent per drawing"],
    ["line kinds with glyphs", "At most 3 edge kinds when any node has a mark (4 without; DATUM-25)"],
    ["col 0 + inset", `\`col: 0\` is valid; Studio keeps a ${K.inset} mm inset from the sheet edge`],
    ["fan-out + split", `Fan-out of ${K.fan} or more edges is sub-ranked by Studio`],
    ["measure first (W-04)", "Preview a shape before promising it"],
    ["randomise (W-12)", "randomise which side each version is on before a judge sees them"],
    ["graph delta (W-05)", "After every revision read FIGURE_GRAPH_DELTA"],
  ]
  for (const [name, pin] of NORMS) test(`${name} appears exactly once`, () => expect(count(pin)).toBe(1))

  // FX-10 (C19a, F9): one gate sentence shared with the five other gate texts; the defect list is figure.defects.
  test("W-02: machine gate and an eye check of the rendered PNG; notices are not defects", () => {
    expect(count("a figure is done only after the machine gate AND an eye check of the rendered PNG")).toBe(1)
    expect(t).toMatch(/Defects \(figure\.defects: any FAIL, GEOM_\*, [^)]*\) must reach zero; notices are information/)
  })

  // FX-10 (C19a): the standalone rule now lives in the shared gate sentence.
  test("W-14: the inline preview is the machine gate; standalone is not the gate", () => {
    expect(count("machine gate = the inline preview (the standalone preview is not the gate)")).toBe(1)
  })

  test("T-11 guide line: direction, capacities from the flow constants, legacy flow and FLOW_SERIALISED", () => {
    const { tb128, tb166, lr128, lr166, lrPar } = K
    expect(count('- direction (flow only): "TB" or "LR"; ranks nodes by the edges, parallel branches side by side')).toBe(1)
    expect(t).toContain(`Rank max: TB ${tb128} @128 mm, ${tb166} @166 mm; LR ${lrPar}. LR max ${lr128} ranks @128 mm, ${lr166} @166 mm.`)
    expect(t).toContain("Without it: list order (per_row), FLOW_SERIALISED if branches serialise.")
  })

  test("the pinned numbers are the engine constants (the guide generates them, never types them)", () => {
    const lx = (tokens as any).LATTICE_X
    const f = flow as any
    expect([(bounds as any).CAPTION_GUIDE_MAX_CHARS, (sheet as any).GRAPH_EDGE_INSET_MM, (route as any).FANOUT_SPLIT_MIN]).toEqual([K.cap, K.inset, K.fan])
    expect(typeof f.flowTbMaxPerRank).toBe("function")
    expect([f.flowTbMaxPerRank(128, lx), f.flowTbMaxPerRank(166, lx), f.FLOW_LR_MAX_PARALLEL, f.flowLrMaxRanks(128, lx), f.flowLrMaxRanks(166, lx)]).toEqual([K.tb128, K.tb166, K.lrPar, K.lr128, K.lr166])
  })

  test("no 1.2.5 workaround and no project-specific text", () => {
    for (const bad of [/must be (a )?box/i, /col(umn)?s? (start|from) (at )?1/i, /start col at 1/i, /\bgraph \+ col\/row\b/, /14 char/i, /arah ditolak/i, /\b1[0-9]\.[0-9]\b/, /\bGambar \d/, /\bGAMBAR \d/, /\brev ?\d{2,}/i, /\bloop \d/i])
      expect(t).not.toMatch(bad)
  })

  test("still a compact resource", () => {
    expect(Buffer.byteLength(t)).toBeLessThan(3000)
  })
})
