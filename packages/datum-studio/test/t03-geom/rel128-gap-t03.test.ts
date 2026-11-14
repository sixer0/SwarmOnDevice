// Swarm 1.2.8 row 36 (AC-T03, T-03 residual, register N8-383; ledger class PROBE). The 1.2.7 audit could not run its
// sixth render of the false-green set (handoff 2026-11-13 §1, row T-03: "uji keenam PNG rev 252 tidak jalan"); 1.2.7
// row 37 (rel127-t03-synthetic-gate.test.ts, CHAR-T03-rest) checked each class on the SVG output only. This probe
// sends the three connector-end classes through every output the verify pipeline runs FIGURE_FIT on
// (`runStaticChecks`, VERIFY_MATRIX.FIGURE_FIT: SVG self, PNG same-job SVG, HTML/PDF/DOCX same-job HTML with the
// figure inline) and through the preview issue path (GEOM_T03_CODES). Red condition (01_specs.md AC-T03): a class
// fixture that renders without a FAIL of its class. Fixtures: the synthetic syn127 class figures, read in place
// (byte-identical inputs; syn128 holds no copies), plus the 5.0 mm twin as negative control.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { DIAGRAM_FAIL_KINDS, runStaticChecks } from "../../src/mcp-host/verify/static-checks"
import { GEOM_T03_CODES, previewIssueClass } from "../../src/mcp-host/local-api/routes/figure-preview-figure"
import { diagramGeometryIssues } from "@/lib/studio/engine/diagram/build/autofit"
import { lintDiagramGeometry } from "@/lib/studio/engine/diagram/fit/lint"

const SYN = path.join(import.meta.dir, "..", "fixtures", "syn127")
const syn = (name: string) => readFileSync(path.join(SYN, name), "utf8")

const CLASSES = [
  { cls: "shared entry", file: "n6_entry_collision.svg", kind: "edgeEntryCollision", code: "GEOM_ENTRY_COLLISION" },
  { cls: "stub", file: "t03_stub.svg", kind: "stubSegment", code: "GEOM_STUB_SEGMENT" },
  { cls: "tangent", file: "t03_tangent.svg", kind: "arrowTangent", code: "GEOM_ARROW_TANGENT" },
] as const
const FORMATS = ["SVG", "PNG", "HTML", "PDF", "DOCX"] as const
type Format = (typeof FORMATS)[number]

/** Same-job HTML of a one-figure document: the engine's figure wrapper with the SVG inline. */
const htmlWith = (svg: string) =>
  `<!doctype html><html><body><figure data-block-type="diagram" data-block-id="b1" data-address="2.1" data-figure="Gambar 2.1">${svg}<figcaption>Gambar 2.1 Uji</figcaption></figure></body></html>`

function figureFit(format: Format, svg: string) {
  const sameJobSvg = format === "SVG" || format === "PNG"
  const r = runStaticChecks({
    format,
    lint: { lint: null } as never,
    completeness: { completeness: null, completenessReport: null } as never,
    ...(sameJobSvg ? { svg, figureKind: "diagram", figureLabel: "Gambar 2.1" } : { html: htmlWith(svg), bytes: null }),
    // Height part (DATUM-33) has no bridge here; geometry runs on the inline SVG regardless.
    layout: { unknown: "BRIDGE_UNAVAILABLE" },
  })
  return r.checks.FIGURE_FIT!
}
const failKinds = (c: ReturnType<typeof figureFit>) =>
  c.findings
    .filter((f) => f.code === "FIG_GEOMETRY")
    .map((f) => (f.detail ?? "").split(":")[0])
    .filter((k) => DIAGRAM_FAIL_KINDS.has(k as never))

describe("rel128 gap T-03: every connector-end class FAILs FIGURE_FIT on every output format", () => {
  for (const { cls, file, kind } of CLASSES) {
    for (const format of FORMATS) {
      test(`${cls} (${file}) as ${format}: FIGURE_FIT FAIL with FIG_GEOMETRY ${kind}`, () => {
        const c = figureFit(format, syn(file))
        expect({ format, status: c.status }).toEqual({ format, status: "FAIL" })
        expect(failKinds(c)).toContain(kind)
      })
    }
  }

  for (const { cls, file, code } of CLASSES) {
    test(`${cls} (${file}): preview reports ${code} as a defect`, () => {
      const ids = diagramGeometryIssues(lintDiagramGeometry(syn(file))).map((i) => i.checkId)
      expect(ids).toContain(code)
      expect((GEOM_T03_CODES as readonly string[]).includes(code)).toBe(true)
      expect(previewIssueClass(code)).toBe("defect")
    })
  }

  test("negative control: the 5.0 mm twin passes FIGURE_FIT geometry on SVG and PNG", () => {
    for (const format of ["SVG", "PNG"] as const) expect({ format, status: figureFit(format, syn("n6_entry_clear.svg")).status }).toEqual({ format, status: "PASS" })
    for (const format of ["HTML", "PDF", "DOCX"] as const) expect({ format, fails: failKinds(figureFit(format, syn("n6_entry_clear.svg"))) }).toEqual({ format, fails: [] })
  })
})
