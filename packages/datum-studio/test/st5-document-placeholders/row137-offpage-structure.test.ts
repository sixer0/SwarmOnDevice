// Swarm 1.3.3 row 137 (decision C20): `OFFPAGE_UNPAIRED` gets its registry row (text of row 50's report) and a structure
// check that reports what row 50's render step refuses, with the same id and message, so document lint shows it
// before render. Fixture: replay R5 u1 Gambar 2.1 / 2.2 (row 50's byte copies, read in place).
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { beforeAll, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { NormDocSnapshot, ResolvedTemplate } from "../../vendor/src/lib/studio/contract"

type J = Record<string, any>
const K = await import("../ported/renderers/_kit")
const S = await import("../ported/structure/_kit")
const { composeV2 } = await import("../../vendor/src/lib/studio/services/compose")
const { lintStructureWith, STRUCTURE_CHECKS, structureCoverageGaps } = await import("../../vendor/src/lib/studio/engine/lint/structure")
const { LINT_REGISTRY } = await import("../../vendor/src/lib/studio/registry/lint")
const { defaultEnforcement } = await import("../../vendor/src/lib/studio/engine/lint/structure/enforcement")
const { releaseFor } = await import("../../vendor/src/lib/studio/services/render/lint")
const { applyRenderScope } = await import("../../vendor/src/lib/studio/services/render/pure/scope")
const P = await import("../../vendor/src/lib/studio/services/render/offpage-pairs")

const ID = "OFFPAGE_UNPAIRED"
const FIX = path.resolve(import.meta.dir, "..", "st4-offpage-pairing", "fixtures")
const fixture = (name: string): J => JSON.parse(readFileSync(path.join(FIX, name), "utf8")) as J
const A = "gbr-situs"
const B = "gbr-wan"
const KEY = "FW-01"

function r5(refs?: { a?: J | null; b?: J | null }): [J, J] {
  const a: J = { ...fixture("r5_u1_gambar_2_1.json"), id: A }
  const b: J = { ...fixture("r5_u1_gambar_2_2.json"), id: B }
  const ra = refs?.a === undefined ? (refs ? { figure: B, key: KEY } : null) : refs.a
  const rb = refs?.b === undefined ? (refs ? { figure: A, key: KEY } : null) : refs.b
  if (ra) a.spec.nodes.find((n: J) => n.id === "offp").ref = ra
  if (rb) b.spec.nodes.find((n: J) => n.id === "offp2").ref = rb
  return [a, b]
}
function compose(blocks2: J[], blocks1?: J[]): NormDocSnapshot {
  const doc = S.e1()
  if (blocks1) doc.sections.content.chapters[0].sections[0].blocks = [{ type: "paragraph", text: "Paragraf bab satu." }, ...blocks1]
  doc.sections.content.chapters[1].sections[0].blocks = [{ type: "paragraph", id: "par-awal", text: "Paragraf sebelum gambar." }, ...blocks2]
  const slots = S.datumSlots()
  const { template: _t, ...sub } = doc
  return composeV2({ source: S.merge(sub, undefined, { slots }).doc, skeleton: S.skeletonInput(slots), params: S.defaultParams() }).snapshot as unknown as NormDocSnapshot
}

let tpl: ResolvedTemplate
beforeAll(async () => {
  tpl = await K.canonicalTemplate()
})
const lintOf = (s: NormDocSnapshot, tier = "TERBIT") => lintStructureWith(s as never, tpl, tier as never, { only: [ID] })

describe("row 137: OFFPAGE_UNPAIRED registry row and structure check", () => {
  test("registry row: once, group D, structure, build, all tiers, release-blocking, never blocks ingest (row 50's text)", () => {
    const rows = LINT_REGISTRY.filter((d) => d.id === ID)
    expect(rows).toHaveLength(1)
    const d = rows[0]
    expect([d.group, d.module, d.stage, d.blocksIngest, d.partial, [...d.tiers], [...d.hqMode], d.ruleRef, d.notRunReason]).toEqual([
      "D", "structure", "build", false, false, ["NOTA", "TERBIT", "SERAH"], ["S"], "register 03 s7", undefined,
    ])
    expect(d.title).toBe("Penghubung luar-halaman berpasangan di gambar yang dirujuk (ref.figure dan ref.key sama di kedua ujung)")
    expect(d.limit).toBe("0 konektor luar halaman tanpa pasangan")
    expect(defaultEnforcement(d)).toBe("release")
    expect(typeof STRUCTURE_CHECKS[ID]).toBe("function")
    expect(structureCoverageGaps()).toEqual([])
  })

  for (const tier of ["NOTA", "TERBIT", "SERAH"]) {
    test(`R5 pair without ref: structure lint at ${tier} lists OFFPAGE_UNPAIRED for both figures, same messages as the render step`, () => {
      const snap = compose(r5())
      const out = lintOf(snap, tier)
      expect(out.map((i) => `${i.checkId}:${i.status}`)).toEqual([`${ID}:FAIL`, `${ID}:FAIL`])
      const render = P.checkOffpagePairs(snap)
      expect(out.map((i) => i.detail)).toEqual(render.refusals.map((r) => r.message))
      expect(out[0].detail).toStartWith(`OFFPAGE_UNPAIRED: Gambar 2.1 (blok ${A}), simpul "offp"`)
      expect(out[1].detail).toStartWith(`OFFPAGE_UNPAIRED: Gambar 2.2 (blok ${B}), simpul "offp2"`)
      expect(out.every((i) => typeof i.address === "string")).toBe(true)
      expect(releaseFor(out, tier as never)).toBe("FAIL")
    })
  }

  test("ref on both ends: one PASS row, the render step's own detail", () => {
    expect(lintOf(compose(r5({})))).toEqual([{ checkId: ID, status: "PASS", detail: "1 pasang penghubung luar-halaman berpasangan; label dibangkitkan mesin dari nomor gambar" }])
  })

  test("key mismatch: FAIL naming both figures and both keys", () => {
    const out = lintOf(compose(r5({ b: { figure: A, key: "FW-1" } })))
    expect(out.map((i) => i.status)).toEqual(["FAIL", "FAIL"])
    expect(out[0].detail).toContain(`kunci yang ada di sana untuk gambar ini: "FW-1"`)
  })

  test("a document without offpage nodes: PASS row (the check ran), never FAIL", () => {
    const out = lintOf(compose([{ type: "paragraph", text: "Tanpa gambar." }]))
    expect(out).toHaveLength(1)
    expect(out[0].status).toBe("PASS")
  })

  test("chapter draft whose twin is outside the scope: NOT_RUN as at render, not a refusal", () => {
    const [a, b] = r5({})
    const snap = compose([b], [a])
    const scope = { kind: "CHAPTER", key: "1" } as const
    const scoped = applyRenderScope(snap as never, scope).snapshot as unknown as NormDocSnapshot
    const out = lintOf(scoped)
    expect(out.map((i) => i.status)).toEqual(["NOT_RUN"])
    const atRender = P.checkOffpagePairs(scoped, { scope }).checks
    expect(atRender.map((c) => c.status)).toEqual(["NOT_RUN"])
    expect(out[0].detail).toBe(atRender[0].detail)
  })

  test("a twin whose spec is an artefact reference cannot be judged by lint: NOT_RUN naming the render, not FAIL", () => {
    const [a, b] = r5({})
    const snap = compose([a, b])
    const blocks = snap.blocks.map((x) => (x.blockId === B ? { ...x, content: { ...(x.content as J), spec: { artifactId: "art-wan", rev: 1 } } } : x))
    const out = lintOf({ ...snap, blocks } as NormDocSnapshot)
    expect(out.map((i) => i.status)).toEqual(["NOT_RUN"])
    expect(out[0].detail).toContain("diperiksa saat render")
  })
})
