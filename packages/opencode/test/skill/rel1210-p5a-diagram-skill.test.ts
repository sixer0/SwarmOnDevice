// N10-183 (Swarm 1.2.10 row 62, AC-P5a, P5-a, U3; spec 01e §3.1 E1-E5 and AT-P5a, with S10-33 / C30 for the S6
// sentence). The built-in skill `diagram-flow` (src/skill/diagram-flow.md) states that the diagram engine is part of
// DATUM Studio (the host must run; there is nothing separate to start), names the two figure tools, says what 1.2.8 and
// 1.2.9 changed, explains the legacy-flow freeze and the `direction` opt-in, names the three 1.2.9 connector checks, and
// gives the via advice that matches the engine (P3-via-family refuses via in a flow with direction: use graph or
// swimlane, not "remove direction"). Check 9 is a guard: no prefixed, invented or host-only tool names.
// Red at BASE a3e3c4c93a: none of the P5 sentences or the section 8 heading exist, and the old advice is present.
// The guide bytes (2,997 B) and the vis10 pins are row-62 evidence from the datum-studio tests, not asserted here.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const SKILL_FILE = path.join(import.meta.dir, "..", "..", "src", "skill", "diagram-flow.md")
const readOptional = (file: string) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
const SKILL = readOptional(SKILL_FILE)
const flat = (s: string) => s.replace(/\s+/g, " ")
const fences = [...SKILL.matchAll(/```[a-z]*\n[\s\S]*?```/g)].map((m) => m[0])
const prose = fences.reduce((s, f) => s.replace(f, ""), SKILL)
const F = flat(prose)
const has = (s: string) => expect(F.includes(s) ? "" : `missing: ${s}`).toBe("")

describe("AC-P5a diagram-flow skill: Studio engine, 1.2.8-1.2.9 changes, legacy flow and via advice", () => {
  test("Check 1: the engine is part of DATUM Studio and there is nothing separate to start", () => {
    expect(SKILL.length).toBeGreaterThan(0)
    has("The diagram engine is part of DATUM Studio: it runs inside the Studio host, so the host must be running and connected.")
    has("There is no separate diagram engine, app or canvas to start.")
  })
  test("Check 1b (S10-33): without a figure tool the agent tells the person and does not start or reach Studio", () => {
    has(
      "If neither figure tool is in your session, Studio is not available to you: tell the person; do not start Studio or reach it another way.",
    )
  })
  test("Check 2: the two figure tools and the datum-studio prefix", () => {
    has("Two tools work on a figure: studio_figure_preview checks it and studio_figure_revise changes part of it;")
    has("Swarm lists every Studio tool with the datum-studio prefix.")
  })
  test("Check 3: the via rule matches the engine and the old advice is gone", () => {
    has("Graph and swimlane take via; a flow takes it only without direction, and a flow with direction refuses it (P3-via-family)")
    has("For bend points together with the section 8 fixes use graph or swimlane.")
    has("Removing direction instead puts the flow back on the frozen legacy layout (section 8).")
    expect(F).not.toContain("Use flow without direction, graph or swimlane.")
  })
  test("Check 4: section 8 follows section 7, and the engine intro comes before section 1", () => {
    const lines = SKILL.split("\n")
    const s7 = lines.indexOf("## 7. Fix a refusal or defect")
    const s8 = lines.indexOf("## 8. What 1.2.8 and 1.2.9 changed, and the legacy flow")
    expect(s7).toBeGreaterThan(0)
    expect(s8).toBeGreaterThan(s7)
    const intro = flat(SKILL).indexOf("The diagram engine is part of DATUM Studio")
    expect(intro).toBeGreaterThan(0)
    expect(intro).toBeLessThan(flat(SKILL).indexOf("## 1. "))
  })
  test("Check 5: the legacy freeze and the direction opt-in", () => {
    has("Its layout is frozen at the 1.2.5 drawing so that stored documents never change")
    has('Opting in: set direction "TB" or "LR" on the flow.')
    has("but it takes no via.")
    has("Adding direction to a stored flow can move its nodes: preview it again and look at the PNG.")
  })
  test("Check 6: the 1.2.9 drawing fixes", () => {
    for (const s of [
      "after a turn a connector enters a box head-on",
      "zone frames keep clear of node outlines where there is room",
      "a provenance mark such as TERUKUR sits beside its circle",
      "connector paths carry no zero-length points",
      "a short label is not cut by a dashed line on first render",
    ])
      has(s)
  })
  test("Check 7: the three 1.2.9 connector checks fail FIGURE_FIT, one line each", () => {
    has("1.2.9 connector checks, in every family including legacy flows. Each one fails FIGURE_FIT")
    const trimmed = SKILL.split("\n").map((l) => l.trim().replace(/^- /, ""))
    for (const code of ["GEOM_EDGE_ALONG", "GEOM_EDGE_HEADER", "GEOM_EDGE_DOUBLE_BACK"])
      expect(trimmed.filter((l) => l.startsWith(`${code}: `)).length, code).toBe(1)
  })
  test("Check 8: G-04 named by chart code only, no chart JSON example", () => {
    has("the flowchart chart G-04 draws BPMN events as circles")
    expect(fences.filter((f) => f.startsWith("```json") && /"type"\s*:\s*"chart"/.test(f))).toEqual([])
  })
  test("Check 9 (guard): no prefixed, invented or host-only tool names", () => {
    expect(SKILL).not.toMatch(/datum-studio_/)
    expect(SKILL).not.toMatch(/\bstudio_(?:diagram|chart)_/)
    expect(SKILL).not.toMatch(/\bstudio_(?:asset_put|slot_fill|mission_)/)
  })
})
