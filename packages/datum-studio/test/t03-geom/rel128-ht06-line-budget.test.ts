/**
 * Swarm 1.2.8 row 35c (AT-HT06 / AC-HT06, register N8-342; check id N8-212 `DATUM-25L`, limits N8-213
 * `LINE_STYLE_MAX` = 4, `LINE_STYLE_MAX_WITH_MARK` = 3).
 *
 * Red at BASE: a spec with 4 edge kinds and one node `mark` passes `validateSpec` with 0 refusals.
 * Green at HEAD: refused with `DATUM-25L`, the message gives the count and the limit (3 with a mark); 4 kinds without
 * a mark pass; 5 kinds without a mark are refused. A spec within 3 styles keeps its BASE check list (no DATUM-25L run).
 * The closure check DATUM-25 (colours) is not touched. Synthetic specs written here (filler labels).
 */
import { describe, expect, test } from "bun:test"
import * as core from "@/lib/studio/engine/diagram/core"
import * as tokens from "@/lib/studio/engine/diagram/core/tokens"

type J = Record<string, any>
const KINDS = ["data", "control", "sync", "alert", "verify"] as const

function spec(kinds: number, withMark: boolean): J {
  const nodes: J[] = [{ id: "n0", label: "Simpul 0", class: { col: 0, row: 0 }, ...(withMark ? { mark: "TERUKUR" } : {}) }]
  const edges: J[] = []
  for (let i = 0; i < kinds; i++) {
    nodes.push({ id: `n${i + 1}`, label: `Simpul ${i + 1}`, class: { col: 1, row: i } })
    edges.push({ from: "n0", to: `n${i + 1}`, kind: KINDS[i], label: `e${i + 1}` })
  }
  return {
    $schema: "studio.diagram/v1",
    family: "graph",
    id: "9.2",
    title: "Gambar sintetis uji.",
    classification: "BIASA",
    width_mm: 166,
    apparatus: "page",
    labels_verified: true,
    sources: ["Sumber sintetis uji"],
    nodes,
    edges,
    legend: withMark ? ["TERUKUR"] : [],
  }
}
const run = (s: J): J[] => core.validateSpec(structuredClone(s) as never, { release: false }) as unknown as J[]
const fails = (s: J): J[] => run(s).filter((i) => i.status === "FAIL")
const budget = (s: J): J[] => fails(s).filter((i) => i.checkId === "DATUM-25L")

describe("AT-HT06 (N8-342): DATUM-25L line-style budget at spec level", () => {
  test("limits are the register values (N8-213)", () => {
    expect((tokens as J).LINE_STYLE_MAX).toBe(4)
    expect((tokens as J).LINE_STYLE_MAX_WITH_MARK).toBe(3)
  })

  test("4 kinds and one node mark: refused with DATUM-25L, count and limit 3 in the message", () => {
    const f = budget(spec(4, true))
    expect(f.length).toBe(1)
    expect(f[0].detail).toContain("4 gaya garis")
    expect(f[0].detail).toContain("maksimum 3")
    expect(f[0].pointer).toBe("/edges")
    expect(() => core.assertValidSpec(structuredClone(spec(4, true)) as never)).toThrow(/DATUM-25L/)
  })

  test("4 kinds without a mark: pass, DATUM-25L listed as PASS", () => {
    expect(fails(spec(4, false))).toEqual([])
    expect(run(spec(4, false)).some((i) => i.checkId === "DATUM-25L" && i.status === "PASS")).toBe(true)
  })

  test("5 kinds without a mark: refused, limit 4", () => {
    const f = budget(spec(5, false))
    expect(f.length).toBe(1)
    expect(f[0].detail).toContain("5 gaya garis")
    expect(f[0].detail).toContain("maksimum 4")
  })

  test("3 kinds with a mark: pass, check not run (`ran` unchanged for specs within the lower limit)", () => {
    expect(fails(spec(3, true))).toEqual([])
    expect(run(spec(3, true)).some((i) => i.checkId === "DATUM-25L")).toBe(false)
  })

  test("SPEC_CHECK_IDS lists DATUM-25L before P3-diamond-exits (still last)", () => {
    const ids = [...(core.SPEC_CHECK_IDS as readonly string[])]
    expect(ids).toContain("DATUM-25L")
    expect(ids[ids.length - 1]).toBe("P3-diamond-exits")
    expect(ids.indexOf("DATUM-25L")).toBe(ids.indexOf("DATUM-34") + 1)
  })
})
