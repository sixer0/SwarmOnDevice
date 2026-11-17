// Swarm 1.3.3 row 141 (ST-1, engine defect E5 of row 36): RACK_ROUTE is a routing note, not a defect.
//
// The engine writes it (build/route.ts `routePlaced`) when the fit re-routes rack connectors on lanes to the right of
// the rack body, with "saran: tidak ada": the engine adapted the route, nothing is left for the agent. A connector the
// re-route still leaves crossing or overlapping is reported by the geometry lint as its own GEOM_* line (a defect),
// not through RACK_ROUTE. Before this row the preview classed RACK_ROUTE as a defect (in no notice list), so a rack
// figure with any connector could never reach zero defects.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { PREVIEW_ISSUE_CLASS, previewIssueClass } from "../../src/mcp-host/local-api/routes/figure-preview-figure"
import { DIMENSIONS, createHarness, type Harness, type Width } from "./capacity-harness"

let h: Harness
beforeAll(async () => {
  h = await createHarness()
}, 60_000)
afterAll(() => h?.dispose())

describe("row 141: RACK_ROUTE class", () => {
  test("RACK_ROUTE is a notice in PREVIEW_ISSUE_CLASS; a FAIL row of the same code stays a defect", () => {
    expect(PREVIEW_ISSUE_CLASS.RACK_ROUTE).toBe("notice")
    expect(previewIssueClass("RACK_ROUTE", "REPORT")).toBe("notice")
    expect(previewIssueClass("RACK_ROUTE", "FAIL")).toBe("defect")
  })
})

describe("row 141: a rack with one connector reaches zero defects", () => {
  const rack = DIMENSIONS.find((d) => d.key === "rack.devicesUplink")
  for (const [n, width] of [
    [2, "text"],
    [2, "full"],
    [6, "text"],
  ] as Array<[number, Width]>) {
    test(`rack ${n} devices, 1 connector @ ${width}: preview and render pass, RACK_ROUTE among the notices`, async () => {
      if (!rack) throw new Error("no dimension rack.devicesUplink")
      const o = await h.probe(rack.spec(n), width)
      expect(o.defects ?? []).toEqual([])
      expect(o.result).toBe("pass")
      expect(o.notices ?? []).toContain("RACK_ROUTE")
      expect(o.preview).toBeUndefined()
    }, 60_000)
  }
})
