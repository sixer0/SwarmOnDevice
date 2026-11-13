// Swarm 1.2.7 row 35c (N-5, N7-100): page-witness PNG names say they are witnesses, not final artefacts.
// The page images are an approximation of the printed page for the agent's eye check; a bare pNNN.png read like a
// deliverable. Names come from PAGE_WITNESS_PREFIX (N7-066); the desktop path policy has no name pattern (paths.ts).
import { describe, expect, test } from "bun:test"
import * as pageImages from "./page-images"

describe("rel127 N-5: witness page file names", () => {
  test("pageFileName prefixes witness- (witness-p001.png, witness-p1234.png)", () => {
    expect(pageImages.pageFileName(1)).toBe("witness-p001.png")
    expect(pageImages.pageFileName(42)).toBe("witness-p042.png")
    expect(pageImages.pageFileName(1234)).toBe("witness-p1234.png")
  })

  test("PAGE_WITNESS_PREFIX is the registered value and starts every page name", () => {
    const prefix = (pageImages as Record<string, unknown>).PAGE_WITNESS_PREFIX
    expect(prefix).toBe("witness-")
    for (const n of [1, 9, 10, 99, 100, 999, 1000]) expect(pageImages.pageFileName(n).startsWith("witness-p")).toBe(true)
  })

  test("names stay .png at the same directory depth, so the output path policy is unaffected", () => {
    const name = pageImages.pageFileName(7)
    expect(name.endsWith(".png")).toBe(true)
    expect(name.includes("/")).toBe(false)
  })
})
