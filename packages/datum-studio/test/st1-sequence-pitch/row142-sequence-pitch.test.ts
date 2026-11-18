// Swarm 1.3.3 row 142 (ST-1, engine defect E2 of row 36): the sequence family's lifeline pitch.
//
// Before: the column pitch was `snap(W / actors)` (round to nearest lattice column, 10.667 mm). With 6 actors on the
// 166 mm sheet 27.67 mm rounds UP to 32 mm, the sixth actor box is centred at 165.33 mm, snaps to 170.667 mm, and the
// figure is refused `DATUM-37-sheet: simpul p5 keluar lebar lembar (170.667..170.667 dari 166.0 mm)`, while 7 and 8
// actors (pitch rounds down to 21.33 mm) pass and 6 pass at 128 mm (128 / 6 = 21.33 mm exactly).
// After: when the rounded pitch puts a box or a lifeline outside the sheet, the pitch rounds down instead.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import type { DiagramSheet, StudioDiagramV1 } from "../../vendor/src/lib/studio/contract"
import { layoutSequence } from "../../vendor/src/lib/studio/engine/diagram/layout-b/sequence"
import { snap } from "../../vendor/src/lib/studio/engine/diagram/core/geometry"
import { DIMENSIONS, createHarness, passes, type Harness } from "../st1-capacity-table/capacity-harness"

const LX = 128 / 12
const sheet = (widthMm: number): DiagramSheet =>
  ({ widthMm, heightMm: 0, colMm: LX, rowMm: (12 * 25.4) / 72, add() {}, toSvg: () => "" }) as unknown as DiagramSheet

const spec = (n: number): StudioDiagramV1 =>
  ({
    family: "sequence",
    nodes: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, label: `Simpul ${i + 1}` })),
    edges: Array.from({ length: n - 1 }, (_, i) => ({ from: `p${i}`, to: `p${i + 1}`, label: "data", kind: "data" })),
  }) as unknown as StudioDiagramV1

const r3 = (v: number) => Math.round(v * 1000) / 1000

describe("row 142: layoutSequence keeps every actor and lifeline on the sheet", () => {
  test("6 actors on 166 mm: pitch 21.333 mm (rounded down), last lifeline 117.333 mm, last box ends inside", () => {
    const l = layoutSequence(spec(6), sheet(166))
    const last = l.nodes.p5
    expect(r3(l.lifelines[5].x)).toBe(117.333)
    expect(r3(l.lifelines[1].x - l.lifelines[0].x)).toBe(21.333)
    expect(last.x + last.w).toBeLessThanOrEqual(166 + 1e-6)
  })

  test("unaffected counts keep the rounded pitch: lifelines and boxes where the old formula put them", () => {
    // old formula: pitch = snap(W / n); 166 mm: 5 -> 32 mm, 7 and 8 -> 21.333 mm; 128 mm: 4 -> 32 mm, 5 and 6 -> 21.333 mm
    const cases: [number, number][] = [[166, 2], [166, 3], [166, 4], [166, 5], [166, 7], [166, 8], [128, 2], [128, 3], [128, 4], [128, 5], [128, 6]]
    for (const [w, n] of cases) {
      const colw = snap(w / n, LX)
      const l = layoutSequence(spec(n), sheet(w))
      const want = Array.from({ length: n }, (_, i) => r3(snap(i * colw + colw / 2, LX)))
      expect([w, n, l.lifelines.map((ll) => r3(ll.x))]).toEqual([w, n, want])
      expect([w, n, r3(l.nodes.p0.w)]).toEqual([w, n, r3(Math.min(32, colw - LX))])
    }
  })

  test("for 2..15 actors at both widths: whenever a rounded-down pitch leaves room for an actor, every box starts at least one column before the edge and every lifeline is on the sheet", () => {
    let checked = 0
    for (const w of [128, 166]) {
      for (let n = 2; n <= 15; n++) {
        if (Math.floor(w / n / LX + 1e-9) * LX - LX <= 1e-6) continue // pitch below two columns: no room for a box (real limit, refused)
        checked++
        const l = layoutSequence(spec(n), sheet(w))
        for (const b of Object.values(l.nodes)) expect([w, n, b.x + LX <= w + 1e-6, b.w > 0]).toEqual([w, n, true, true])
        for (const ll of l.lifelines) expect([w, n, ll.x <= w + 1e-6]).toEqual([w, n, true])
      }
    }
    expect(checked).toBe(11) // 128 mm: 2..6; 166 mm: 2..7 (8 keeps its rounded pitch of 21.33 mm, covered above)
  })
})

describe("row 142: through both product paths, passing is monotone in the number of lifelines", () => {
  let h: Harness
  beforeAll(async () => {
    h = await createHarness()
  }, 60_000)
  afterAll(() => h?.dispose())
  const dim = DIMENSIONS.find((d) => d.key === "sequence.lifelines")!

  const expected: Record<"text" | "full", Record<number, boolean>> = {
    text: { 4: true, 5: true, 6: true, 7: false },
    full: { 5: true, 6: true, 7: true, 8: true, 9: false },
  }
  for (const w of ["text", "full"] as const) {
    for (const [n, ok] of Object.entries(expected[w])) {
      test(`${n} lifelines at ${w === "text" ? 128 : 166} mm ${ok ? "pass" : "are refused"}`, async () => {
        const o = await h.probe(dim.spec(Number(n)), w)
        expect(passes(o)).toBe(ok)
      })
    }
  }

  test("166 mm holds at least as many lifelines as 128 mm, and no count passes above the first refusal (2..12)", async () => {
    const firstFail: Record<string, number> = {}
    for (const w of ["text", "full"] as const) {
      let fail = 0
      for (let n = 2; n <= 12; n++) {
        const ok = passes(await h.probe(dim.spec(n), w))
        if (!ok && !fail) fail = n
        if (fail) expect([w, n, ok]).toEqual([w, n, false])
      }
      firstFail[w] = fail
    }
    expect(firstFail.full).toBeGreaterThanOrEqual(firstFail.text)
  }, 60_000)
})
