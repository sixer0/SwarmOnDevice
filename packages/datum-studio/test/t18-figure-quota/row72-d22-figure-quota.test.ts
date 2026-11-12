// Swarm 1.2.6 row 72 (T-18 / W-10, register N-113..N-115): per-document figure quota.
// `figure.quota.maxPerDocument` (default null = no quota) caps the chart, diagram and image figures of one
// document; lint check D22 FAILs a document over the quota, and a recorded `figure.quota.exceptionReason`
// turns the over-quota count into a REPORT finding that prints the reason (a reported exception, not a failure).
// Acceptance (01_specs T-18): 41 figures at quota 40 fail D22; the same document with an exceptionReason passes
// with the reason printed in the finding.
// Names new in 1.2.6 are not imported on purpose: the red run at BASE must fail on the assertions.
import { describe, expect, test } from "bun:test"
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { lintStructureWith } from "../../vendor/src/lib/studio/engine/lint/structure"
import { LINT_REGISTRY } from "../../vendor/src/lib/studio/registry/lint"
import { PARAMS_BY_KEY } from "../../vendor/src/lib/studio/params"
import { canonicalTemplate, makeDoc, snapshotOf, withParams } from "../ported/engine-core/fixtures"

const QUOTA = "figure.quota.maxPerDocument"
const REASON = "figure.quota.exceptionReason"

function figures(n: number): Record<string, unknown>[] {
  // Chart and diagram figures alternate (both reference a stored artifact, so no inline spec is needed).
  return Array.from({ length: n }, (_, i) => ({
    type: i % 2 === 0 ? "diagram" : "chart",
    spec: { artifactId: `fig-${i + 1}` },
    caption: { inline: { text: `Alur uji nomor ${i + 1} tahun 2026.` } },
  }))
}

function run(n: number, params: Record<string, unknown>) {
  const doc = makeDoc({ tier: "TERBIT", blocks: figures(n) as never })
  const tpl = withParams(canonicalTemplate(), params)
  return lintStructureWith(snapshotOf(doc), tpl, "TERBIT", { only: ["D22"] }).filter((i) => i.checkId === "D22")
}

describe("T-18 registry and parameters", () => {
  test("D22 is registered as a group D structure check with paramRef figure.quota.maxPerDocument", () => {
    const d22 = LINT_REGISTRY.find((d) => d.id === "D22")
    expect(d22?.group).toBe("D")
    expect(d22?.module).toBe("structure")
    expect(d22?.title).toBe("Kuota gambar per dokumen")
    expect(d22?.paramRef).toBe(QUOTA)
  })

  test("the two document parameters exist with defaults null and empty string", () => {
    expect(PARAMS_BY_KEY.get(QUOTA)?.default).toBeNull()
    expect(PARAMS_BY_KEY.get(QUOTA)?.type).toBe("int")
    expect(PARAMS_BY_KEY.get(REASON)?.default).toBe("")
    expect(PARAMS_BY_KEY.get(REASON)?.scope).toBe("document")
    expect(PARAMS_BY_KEY.get(QUOTA)?.scope).toBe("document")
  })
})

describe("T-18 lint D22", () => {
  test("41 figures at quota 40 -> D22 FAIL naming the count and the quota", () => {
    const out = run(41, { [QUOTA]: 40 })
    console.log(`row72: D22 41@40 -> ${JSON.stringify(out)}`)
    expect(out.map((i) => i.status)).toEqual(["FAIL"])
    expect(out[0]!.detail).toContain("41")
    expect(out[0]!.detail).toContain("40")
    expect(out[0]!.detail).toContain(REASON)
  })

  test("the same document with an exceptionReason -> no FAIL; a REPORT finding prints the reason", () => {
    const reason = "Lampiran foto survei lapangan diminta pemberi tugas"
    const out = run(41, { [QUOTA]: 40, [REASON]: reason })
    console.log(`row72: D22 41@40 + reason -> ${JSON.stringify(out)}`)
    expect(out.some((i) => i.status === "FAIL")).toBe(false)
    expect(out.map((i) => i.status)).toEqual(["REPORT"])
    expect(out[0]!.detail).toContain(reason)
  })

  test("40 figures at quota 40 -> PASS; no quota (default null) -> PASS", () => {
    expect(run(40, { [QUOTA]: 40 }).map((i) => i.status)).toEqual(["PASS"])
    expect(run(41, {}).map((i) => i.status)).toEqual(["PASS"])
  })
})
