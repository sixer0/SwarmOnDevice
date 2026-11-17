// 1.3.3 row 114 (ST-8 item 1), unit level (no port): the `figures` reply items and text lines of the studio_render
// wrapper (src/mcp-host/verify/render-wrapper.ts `figureFiles`, `figureLines`).
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { figureFiles, figureLines, RENDER_FIGURES_MAX } from "../../src/mcp-host/verify/render-wrapper"
import type { VerifyOutputFile } from "../../src/mcp-host/verify/verify-outputs"

const WORK = realpathSync(mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "row114-unit-")))
const SHA = "ab".repeat(32)
const file = (id: string, over: Partial<VerifyOutputFile> = {}): VerifyOutputFile => {
  const p = path.join(WORK, `${id}.svg`)
  writeFileSync(p, `<svg id="${id}"/>`)
  return { id, format: "SVG", role: "FIGURE", figureLabel: `Gambar ${id}`, sha256: SHA, lintVerdict: null, bytes: null, absPath: p, ...over }
}
const snapshot = {
  blocks: [
    { blockId: "p-a", address: "1/2", type: "diagram", artifactLabel: "Gambar 1", content: {}, ordinal: 1 },
    { blockId: "p-b", address: "2/2", type: "chart", artifactLabel: "Gambar 2", content: {}, ordinal: 2 },
    { blockId: "p-c", address: "3/2", type: "paragraph", content: {}, ordinal: 3 },
  ],
  numbering: {},
}

describe("row 114: figureFiles", () => {
  test("one item per FIGURE file in order; primary outputs are not listed; block id from the snapshot", () => {
    const out = figureFiles([file("x", { role: "PRIMARY", format: "HTML", figureLabel: null }), file("1"), file("2"), file("9", { figureLabel: "Gambar 9" })], snapshot)
    expect(out.truncated).toBe(0)
    expect(out.items.map((i) => [i.outputId, i.label, i.blockId, i.format])).toEqual([
      ["1", "Gambar 1", "p-a", "SVG"],
      ["2", "Gambar 2", "p-b", "SVG"],
      ["9", "Gambar 9", null, "SVG"],
    ])
    for (const i of out.items) expect(i.path).toBe(path.join(WORK, `${i.outputId}.svg`))
  })

  test("a path that is not an existing regular file is null, never guessed", () => {
    const gone = file("g", { absPath: path.join(WORK, "absent.svg") })
    const dir = path.join(WORK, "d")
    mkdirSync(dir)
    const out = figureFiles([gone, file("d", { absPath: dir }), file("n", { absPath: null })], null)
    expect(out.items.map((i) => i.path)).toEqual([null, null, null])
    expect(out.items.map((i) => i.blockId)).toEqual([null, null, null])
  })

  test("a snapshot that cannot be read gives null block ids, not an error", () => {
    const out = figureFiles([file("s")], { blocks: "not a list" })
    expect(out.items.map((i) => [i.outputId, i.blockId, i.path !== null])).toEqual([["s", null, true]])
  })

  test("a symlink to a file is reported as the store path (statSync follows it; the store never makes links)", () => {
    const target = file("t")
    const link = path.join(WORK, "link.svg")
    symlinkSync(target.absPath!, link)
    expect(figureFiles([{ ...target, absPath: link }], null).items[0].path).toBe(link)
  })

  test("the reply is capped; the rest is counted", () => {
    const many = Array.from({ length: RENDER_FIGURES_MAX + 5 }, (_, i) => ({ ...file("cap"), id: `cap${i}` }))
    const out = figureFiles(many, null)
    expect(out.items).toHaveLength(RENDER_FIGURES_MAX)
    expect(out.truncated).toBe(5)
    expect(figureLines(out).at(-1)).toContain("5 more figure files not listed")
  })
})

describe("row 114: figureLines (safe tokens only)", () => {
  test("label shown only when safe; path and sha256 on the line; a missing file is said", () => {
    const lines = figureLines({
      items: [
        { label: "Gambar 1.2", blockId: "p-a", format: "SVG", outputId: "o1", path: "/s/out/a.svg", sha256: SHA },
        { label: "Gambar 2 <x>", blockId: null, format: "PNG", outputId: "o2", path: null, sha256: "bad" },
        { label: null, blockId: null, format: "SVG", outputId: "o3", path: "/s/out/\u0007odd.svg", sha256: SHA },
      ],
      truncated: 0,
    })
    expect(lines[0]).toStartWith("figures: 3 files")
    expect(lines[1]).toBe(`  SVG "Gambar 1.2" block=p-a /s/out/a.svg sha256=${SHA}`)
    expect(lines[2]).toBe("  PNG ? block=? path=none (file not in the store) sha256=?")
    expect(lines[3]).toBe(`  SVG ? block=? path=structuredContent.figures sha256=${SHA}`)
  })
})
