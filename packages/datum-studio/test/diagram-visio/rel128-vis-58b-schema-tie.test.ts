// Swarm 1.2.8 row 58b (C134, gate M3 finding G3-05). The spec-level field lists of the two diagram copy paths are
// hand-kept beside the schema:
//   - services/compose/blocks.ts `diagramSpec` (DiagramSpecV2 block -> studio.diagram/v1: preview, chapter submit, render)
//   - services/adapt-v1/blocks.ts `adaptDiagramSpec` (studio.doc/v1 document -> DiagramSpecV2; `rec.rest` allow-list + copies)
// A schema field missing from either list is dropped silently. That happened three times (1.2.6 row 45 `direction`,
// 1.2.8 rows 58 and 58a: lane_orientation, phases, pools, jumps). This guard reads the property list from the schema
// itself (`commonV2Schema.$defs.DiagramSpecV2.properties`) and fails when either path does not carry one of them, so a
// future DiagramSpecV2 field fails here until both copies exist. The check is behavioural (a probe value per property,
// read back from the output), not a text match, so removing any one copy line, or one name from `rec.rest`, fails it.
// v1-only properties (studio.diagram/v1 minus DiagramSpecV2) are a named exclusion list with the reason for each; a new
// v1 property must be added to DiagramSpecV2 or to that list. Pure functions, no host, no port.
import { describe, expect, test } from "bun:test"
import { commonV2Schema } from "../../vendor/src/lib/studio/contract/schema/v2/common.schema"
import { diagramSchema } from "../../vendor/src/lib/studio/contract/schema/diagram.schema"
import { diagramSpec } from "../../vendor/src/lib/studio/services/compose/blocks"
import { adaptDiagramSpec } from "../../vendor/src/lib/studio/services/adapt-v1/blocks"
import { AdaptRecorder } from "../../vendor/src/lib/studio/services/adapt-v1/report"

type J = Record<string, any>

/** Every spec-level property of DiagramSpecV2, read from the schema (the single source). */
const V2_KEYS: string[] = Object.keys((commonV2Schema as J).$defs.DiagramSpecV2.properties)
const V1_KEYS: string[] = Object.keys((diagramSchema as J).properties)

/**
 * studio.diagram/v1 properties that are deliberately not DiagramSpecV2 fields (common.schema.ts T2-27 comment), with the
 * reason. They are figure furniture owned by the document/template, or internal signals, never agent spec fields.
 */
const V1_ONLY: Record<string, string> = {
  $schema: "v1 envelope marker; compose writes it, the adapter consumes it",
  id: "artifact label (Gambar n.m) from document numbering, not the spec",
  title: "caption text from the block caption",
  width_mm: "figure width from the template text column",
  apparatus: "caption/source furniture mode, owned by the template",
  source: "SUMBER line text from the block source",
  sld: "single-line-diagram sheet data, v1 only (T2-27)",
  keyRowOnPage: "INTERNAL compose signal (schema: `not: {}`), never agent input",
}

/** One distinct probe value per property; neither copy function validates, so any value must arrive unchanged. */
const probe = (k: string) => [`probe:${k}`]
const allV2 = (): J => Object.fromEntries(V2_KEYS.map((k) => [k, probe(k)]))
const CTX = { params: {}, classification: "ctx-classification" } as unknown as Parameters<typeof diagramSpec>[4]

/** Properties of DiagramSpecV2 that `fn(spec)` does not carry to its output with the probe value. */
function missingThrough(fn: (spec: J) => J): string[] {
  const out = fn(allV2())
  return V2_KEYS.filter((k) => JSON.stringify(out[k]) !== JSON.stringify(probe(k)))
}
const viaCompose = (spec: J) => diagramSpec(spec as never, "Judul", "Sumber", 128, CTX) as unknown as J
const viaAdapt = (spec: J) => adaptDiagramSpec({ $schema: "studio.diagram/v1", ...spec } as never, "/s", new AdaptRecorder("strip")) as unknown as J

describe("G3-05: DiagramSpecV2 spec-level fields are carried by both copy paths (schema is the source)", () => {
  test("the schema list is read, not empty, and holds the fields of every earlier drop", () => {
    for (const k of ["family", "nodes", "direction", "lane_orientation", "phases", "pools", "jumps"]) expect(V2_KEYS).toContain(k)
  })

  test("every DiagramSpecV2 property is also a studio.diagram/v1 property (compose emits v1)", () => {
    expect(V2_KEYS.filter((k) => !V1_KEYS.includes(k))).toEqual([])
  })

  test("every v1-only property is on the named exclusion list, and no excluded name is a v2 field", () => {
    expect(V1_KEYS.filter((k) => !V2_KEYS.includes(k) && !(k in V1_ONLY))).toEqual([])
    expect(Object.keys(V1_ONLY).filter((k) => V2_KEYS.includes(k))).toEqual([])
  })

  test("compose diagramSpec carries every DiagramSpecV2 property", () => {
    expect(missingThrough(viaCompose)).toEqual([])
  })

  test("adapt-v1 adaptDiagramSpec carries every DiagramSpecV2 property", () => {
    expect(missingThrough(viaAdapt)).toEqual([])
  })

  test("adapt-v1 rec.rest does not count any DiagramSpecV2 property as stripped", () => {
    const rec = new AdaptRecorder("strip")
    adaptDiagramSpec({ $schema: "studio.diagram/v1", ...allV2() } as never, "/s", rec)
    expect(rec.stripped).toEqual({})
  })

  test("adapt-v1 still strips the v1-only furniture (exclusion list is real, not a pass-through)", () => {
    const rec = new AdaptRecorder("strip")
    adaptDiagramSpec({ $schema: "studio.diagram/v1", ...allV2(), id: "Gambar 1.1", title: "t", width_mm: 128, source: "s" } as never, "/s", rec)
    expect(Object.keys(rec.stripped).sort()).toEqual(["id", "source", "title", "width_mm"])
  })

  test("self-check: the guard reports a path that drops one property (mutation stand-in)", () => {
    for (const k of V2_KEYS) {
      const dropping = (spec: J) => {
        const out = { ...viaCompose(spec) }
        delete out[k]
        return out
      }
      expect(missingThrough(dropping)).toEqual([k])
    }
  })
})
