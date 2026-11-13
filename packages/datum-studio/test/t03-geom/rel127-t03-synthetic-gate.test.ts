/**
 * Swarm 1.2.7 row 37 (T-03 rest, AC-T03, register N7-150; ledger class CHAR-T03-rest, green at BASE by design:
 * the engine part shipped in 1.2.6 rows 25/26). Replaces the TERBATAS six-PNG acceptance with synthetic figures.
 *
 * Each synthetic class figure gives at least one FAIL of its own class through the FIGURE_FIT gate
 * (`checkFigureFit`, H verify/static-checks.ts): shared entry, stub, tangent, two line colours.
 *
 * Two line colours (C23): FIGURE_FIT has no colour code of its own. A data line and a control line sharing one
 * trunk into one port fail as FIG_GEOMETRY `edgeEntryCollision` (preview code GEOM_ENTRY_COLLISION); the shared
 * trunk itself is `edgeCollinear`, a report-only NOTE. The test asserts exactly that, so a future colour code
 * would be a visible change here.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { checkFigureFit, DIAGRAM_FAIL_KINDS } from "../../src/mcp-host/verify/static-checks"
import { diagramGeometryIssues } from "@/lib/studio/engine/diagram/build/autofit"
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint"

const SYN = path.join(import.meta.dir, "..", "fixtures", "syn127")
const syn = (name: string) => readFileSync(path.join(SYN, name), "utf8")

const gate = (svg: string) => checkFigureFit({ format: "SVG", svg, figureKind: "diagram", figureLabel: "Gambar 1.1" })
type Gate = ReturnType<typeof gate>
const geomKinds = (c: Gate) => c.findings.filter((f) => f.code === "FIG_GEOMETRY").map((f) => (f.detail ?? "").split(":")[0])
/** Kinds that FAIL the gate (fail and note findings share `findings`; the gate's fail set decides). */
const failKinds = (c: Gate) => geomKinds(c).filter((k) => DIAGRAM_FAIL_KINDS.has(k as never))

const CLASSES: Array<{ cls: string; file: string; kind: string; code: string }> = [
  { cls: "shared entry", file: "n6_entry_collision.svg", kind: "edgeEntryCollision", code: "GEOM_ENTRY_COLLISION" },
  { cls: "stub", file: "t03_stub.svg", kind: "stubSegment", code: "GEOM_STUB_SEGMENT" },
  { cls: "tangent", file: "t03_tangent.svg", kind: "arrowTangent", code: "GEOM_ARROW_TANGENT" },
  { cls: "two line colours", file: "t03_two_line_colours.svg", kind: "edgeEntryCollision", code: "GEOM_ENTRY_COLLISION" },
]

describe("AC-T03: one FIGURE_FIT FAIL per synthetic class", () => {
  for (const { cls, file, kind, code } of CLASSES) {
    test(`${cls} (${file}): FIGURE_FIT FAIL, FIG_GEOMETRY ${kind}; preview ${code}`, () => {
      const c = gate(syn(file))
      expect(c.status).toBe("FAIL")
      expect(failKinds(c)).toContain(kind)
      expect(diagramGeometryIssues(lintDiagramGeometry(syn(file))).map((i) => i.checkId)).toContain(code)
    })
  }

  test("two line colours: no colour code of its own; the trunk is a report-only edgeCollinear NOTE", () => {
    const c = gate(syn("t03_two_line_colours.svg"))
    // The refusal code it raises is FIG_GEOMETRY (edgeEntryCollision); no other finding code fails it.
    expect([...new Set(c.findings.map((f) => f.code))]).toEqual(["FIG_GEOMETRY"])
    expect(new Set(failKinds(c))).toEqual(new Set(["edgeEntryCollision"]))
    expect(geomKinds(c)).toContain("edgeCollinear")
    expect(DIAGRAM_FAIL_KINDS.has("edgeCollinear")).toBe(false)
  })

  test("negative control: the 5.0 mm twin passes FIGURE_FIT", () => {
    expect(gate(syn("n6_entry_clear.svg")).status).toBe("PASS")
  })
})
