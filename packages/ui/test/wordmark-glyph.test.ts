import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// I1 — the structural legibility gate for the SWARM bit-block wordmark.
//
// Specified before the artwork changed, at docs/2026-10-19_opencode_swarm_rebrand/
// research/s6_r241b_wordmark_legibility.md §5.1, after the product owner read the mark as
// "SVARN": the M drew no centre vertex (its inner ink is a monotone staircase, which is the
// letter N's distinguishing stroke) and the W drew one bottom foot with its apex fused to the
// right stem (the silhouette of a V). Both failures are geometry, not contrast: the diagnosis
// measured the same Δ 29 on every cell including the distinguishing ones, and showed the
// staircase survives at alpha 1.0 (§3.1). Nothing in this file touches opacity.
//
// WHY THE GEOMETRY IS READ AS TEXT AND NOT IMPORTED. Rendering a Solid component is unavailable
// in this lane (`packages/app/tsconfig.json:14` sets `"jsx": "preserve"` and the transform lives
// only in the Vite build), which is exactly why blueprint row 168's pin reads logo.tsx as text
// (packages/app/src/pages/new-session/new-session-view-mark.test.ts:129-131). This file follows
// that precedent: it decodes the shipped `d` attribute back onto the cell grid, so it asserts on
// what the browser will be handed rather than on a re-typed copy of it.
//
// WHY MUTANTS LIVE INSIDE THE GREEN SUITE. The exhaustive search in §2.3 found four-column
// patterns that satisfy every assertion below and still look wrong, so these assertions are a
// necessary condition, not a sufficient one — the human reading task (I3) is the sufficient one.
// Each battery is therefore shown capable of failing from the inside: the mutant grids named
// below are the shipped art and single-cell removals from the fixed art, and every one of them
// must come back red for the green above them to mean anything.

const PITCH = 8.4
const ORIGIN_X = 16.2
const ROWS = 5
const WORD = "SWARM"

const logoPath = new URL("../src/components/logo.tsx", import.meta.url)
const oauthPagePath = new URL("../../core/src/oauth/page.ts", import.meta.url)
const cliBannerPath = new URL("../../opencode/src/cli/ui.ts", import.meta.url)
const tuiLogoPath = new URL("../../tui/src/logo.ts", import.meta.url)
const tuiPresentationPath = new URL("../../tui/src/util/presentation.ts", import.meta.url)

const logoSource = readFileSync(fileURLToPath(logoPath), "utf8")
const oauthSource = readFileSync(fileURLToPath(oauthPagePath), "utf8")
const cliSource = readFileSync(fileURLToPath(cliBannerPath), "utf8")
const tuiLogoSource = readFileSync(fileURLToPath(tuiLogoPath), "utf8")
const tuiPresentationSource = readFileSync(fileURLToPath(tuiPresentationPath), "utf8")

type Grid = {
  ink: Set<string>
  rects: number
  columns: number
  width: number
  viewBox: string
  d: string
}

// The rectangle runs are laid down row-major, so decoding is the inverse of the encoder: divide
// the origin by the pitch and round, exactly as the diagnosis instrument did (§1.1). Scoped to
// the <svg> element that carries the wordmark slot, because logo.tsx also draws the hexagon mark
// on its own 16x20 canvas and the first viewBox in the file is not this one.
function wordmarkSvg(source: string): string {
  const slot = source.indexOf('data-slot="logo-wordmark"')
  if (slot < 0) throw new Error("no logo-wordmark slot in this source")
  const start = source.lastIndexOf("<svg", slot)
  const end = source.indexOf("</svg>", slot)
  if (start < 0 || end < 0) throw new Error("the logo-wordmark slot is not inside an <svg> element")
  return source.slice(start, end)
}

function decodeSvg(source: string): Grid {
  const svg = wordmarkSvg(source)
  const d = /\sd="([^"]+)"/.exec(svg)
  if (!d) throw new Error("the wordmark <svg> carries no d attribute")
  const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(svg)
  if (!viewBox) throw new Error("the wordmark <svg> carries no viewBox")
  const ink = new Set<string>()
  let rects = 0
  for (const rect of d[1].matchAll(/M([\d.]+) ([\d.]+)h([\d.]+)v([\d.]+)h-([\d.]+)z/g)) {
    rects += 1
    const col = Math.round((Number(rect[1]) - ORIGIN_X) / PITCH)
    const row = Math.round(Number(rect[2]) / PITCH)
    for (let dc = 0; dc < Math.round(Number(rect[3]) / PITCH); dc += 1) {
      for (let dr = 0; dr < Math.round(Number(rect[4]) / PITCH); dr += 1) {
        ink.add(`${row + dr}:${col + dc}`)
      }
    }
  }
  const columns = Math.round((Number(viewBox[1]) - 2 * ORIGIN_X) / PITCH)
  return { ink, rects, columns, width: Number(viewBox[1]), viewBox: viewBox[0], d: d[1] }
}

function decodeAsciiRows(rows: string[]): Set<string> {
  const ink = new Set<string>()
  rows.forEach((row, r) => {
    ;[...row].forEach((char, c) => {
      if (char === "█") ink.add(`${r}:${c}`)
    })
  })
  return ink
}

function quotedStrings(block: string): string[] {
  return [...block.matchAll(/["`]([^"`\n]*)["`]/g)].map((m) => m[1])
}

// The combined banner: five backtick rows in the `wordmark` array (non-TTY path of `logo()`).
function cliBannerRows(source: string): string[] {
  const block = /const wordmark\s*=\s*\[([\s\S]*?)\]/.exec(source)
  if (!block) throw new Error("no wordmark array in packages/opencode/src/cli/ui.ts")
  return quotedStrings(block[1])
}

// The split banner: `logo` holds `left` and `right`, stitched by the renderer with one space.
// Anchored on the `logo` object because `go` in the same file also declares left/right halves.
function splitBannerRows(source: string): string[] {
  const object = /(?:export )?const logo\s*=\s*\{([\s\S]*?)\n\}/.exec(source)
  if (!object) throw new Error("no logo object in the TUI source")
  const halves = (["left", "right"] as const).map((side) => {
    const array = new RegExp(`${side}:\\s*\\[([\\s\\S]*?)\\]`).exec(object[1])
    if (!array) throw new Error(`no ${side} half in the TUI logo`)
    return quotedStrings(array[1])
  })
  return halves[0].map((row, index) => `${row} ${halves[1][index] ?? ""}`)
}

function groupsOf(ink: Set<string>, columns: number): [number, number][] {
  const out: [number, number][] = []
  let open = -1
  for (let c = 0; c < columns; c += 1) {
    const inked = Array.from({ length: ROWS }, (_, r) => ink.has(`${r}:${c}`)).some(Boolean)
    if (inked && open < 0) open = c
    if (!inked && open >= 0) {
      out.push([open, c - 1])
      open = -1
    }
  }
  if (open >= 0) out.push([open, columns - 1])
  return out
}

// Letter width is inferred from the grid, never hard-coded: the whole defect was that four
// columns cannot carry a centre feature, and a test that pinned 4 could not express the fix.
function glyph(ink: Set<string>, lo: number, hi: number): Set<string> {
  const out = new Set<string>()
  for (const cell of ink) {
    const [row, col] = cell.split(":").map(Number)
    if (col >= lo && col <= hi) out.add(`${row}:${col - lo}`)
  }
  return out
}

function rowRuns(ink: Set<string>, row: number, width: number): number {
  const line = Array.from({ length: width }, (_, c) => (ink.has(`${row}:${c}`) ? "#" : ".")).join("")
  return line.split(".").filter(Boolean).length
}

function rowCount(ink: Set<string>, row: number, width: number): number {
  return Array.from({ length: width }, (_, c) => ink.has(`${row}:${c}`)).filter(Boolean).length
}

function innerCells(ink: Set<string>, width: number): [number, number][] {
  return [...ink]
    .map((cell) => cell.split(":").map(Number) as [number, number])
    .filter(([row, col]) => col > 0 && col < width - 1)
}

// One inked inner cell per consecutive row, advancing rightward as it descends: the N diagonal.
function isMonotoneStaircase(inner: [number, number][]): boolean {
  const byRow = new Map<number, number>()
  for (const [r, c] of inner) {
    if (byRow.has(r)) return false
    byRow.set(r, c)
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b)
  if (rows.length < 2) return false
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i] !== rows[i - 1] + 1) return false
    if (byRow.get(rows[i])! <= byRow.get(rows[i - 1])!) return false
  }
  return true
}

function mBattery(ink: Set<string>, width: number): Record<string, boolean> {
  const inner = innerCells(ink, width)
  const armsPerRow = new Map<number, number>()
  for (const [r] of inner) armsPerRow.set(r, (armsPerRow.get(r) ?? 0) + 1)
  const tests = {
    m1_two_arms_share_a_row: [...armsPerRow.values()].some((n) => n >= 2),
    m2_not_a_monotone_staircase: !isMonotoneStaircase(inner),
    m3_vertex_stops_above_bottom: inner.length > 0 && Math.max(...inner.map(([r]) => r)) <= ROWS - 2,
    m4_top_row_has_two_runs: rowRuns(ink, 0, width) >= 2,
    m5_bottom_row_has_two_runs: rowRuns(ink, ROWS - 1, width) >= 2,
    m6_vertex_spans_two_rows: new Set(inner.map(([r]) => r)).size >= 2,
  }
  return { ...tests, PASS: Object.values(tests).every(Boolean) }
}

function wBattery(ink: Set<string>, width: number): Record<string, boolean> {
  const inner = innerCells(ink, width)
  const bottom = Math.max(...[...ink].map((cell) => Number(cell.split(":")[0])))
  const deepestInner = inner.length ? Math.max(...inner.map(([r]) => r)) : -1
  const apexes = inner.filter(([r]) => deepestInner - r >= 2)
  const tests = {
    w1_at_least_two_separated_feet: rowRuns(ink, bottom, width) >= 2,
    w2_centre_vertex_rises_2_rows: apexes.length > 0,
    w3_apex_free_standing: apexes.some(([r, c]) => !ink.has(`${r}:${c - 1}`) && !ink.has(`${r}:${c + 1}`)),
    w4_no_full_bar_in_the_bottom_half: [bottom - 1, bottom].every((r) => rowRuns(ink, r, width) < width),
  }
  return { ...tests, PASS: tests.w1_at_least_two_separated_feet && tests.w2_centre_vertex_rises_2_rows && tests.w3_apex_free_standing }
}

function sBattery(ink: Set<string>, width: number): Record<string, boolean> {
  const bars = Array.from({ length: ROWS }, (_, r) => r).filter((r) => rowCount(ink, r, width) === width)
  const connectors = Array.from({ length: ROWS }, (_, r) => r).filter((r) => !bars.includes(r))
  const upper = connectors.length ? connectorsSpan(ink, connectors[0], width) : []
  const lower = connectors.length > 1 ? connectorsSpan(ink, connectors[connectors.length - 1], width) : []
  const tests = {
    s1_three_full_bars: bars.length === 3 && bars[0] === 0 && bars[2] === ROWS - 1,
    // The upper stroke joins on the left and the lower on the right; if they agree, S becomes 8,
    // and if the lower one disappears entirely, it becomes a 5 or an E.
    s2_connectors_alternate_sides: upper.length > 0 && lower.length > 0 && Math.max(...upper) < Math.min(...lower),
    s3_no_full_height_stem: Array.from({ length: width }, (_, c) => c).every(
      (c) => Array.from({ length: ROWS }, (_, r) => r).filter((r) => ink.has(`${r}:${c}`)).length < ROWS,
    ),
    s4_bars_span_the_whole_glyph: bars.every((r) => rowCount(ink, r, width) === width),
  }
  return { ...tests, PASS: Object.values(tests).every(Boolean) }
}

function connectorsSpan(ink: Set<string>, row: number, width: number): number[] {
  return Array.from({ length: width }, (_, c) => c).filter((c) => ink.has(`${row}:${c}`))
}

function aBattery(ink: Set<string>, width: number): Record<string, boolean> {
  const crossbar = Array.from({ length: ROWS }, (_, r) => r).filter((r) => r > 0 && r < ROWS - 1 && rowCount(ink, r, width) === width)
  const below = crossbar.length ? Array.from({ length: ROWS }, (_, r) => r).filter((r) => r > Math.max(...crossbar)) : []
  const tests = {
    // A's top is an apex, R's top is a bar. A↔R is the tightest pair in the word (Hamming 4), so
    // this is the assertion that carries the most weight in the whole file.
    a1_top_is_an_apex_not_a_bar: rowCount(ink, 0, width) > 0 && rowCount(ink, 0, width) < width,
    a2_crossbar_spans_the_glyph: crossbar.length > 0,
    a3_crossbar_is_interior: crossbar.length > 0 && Math.min(...crossbar) > 0 && Math.max(...crossbar) < ROWS - 1,
    a4_every_row_below_is_two_legs: below.length > 0 && below.every((r) => rowRuns(ink, r, width) >= 2),
    a5_legs_reach_the_baseline: rowRuns(ink, ROWS - 1, width) >= 2,
  }
  return { ...tests, PASS: Object.values(tests).every(Boolean) }
}

function rBattery(ink: Set<string>, width: number): Record<string, boolean> {
  const bowl = [1, 2].filter((r) => [0, 1, 2].every((c) => ink.has(`${r}:${c}`)))
  const legs = [3, 4].filter((r) => rowRuns(ink, r, width) >= 2 && connectorsSpan(ink, r, width).some((c) => c > 0 && c < width - 1))
  const tests = {
    r1_top_is_a_full_bar: rowCount(ink, 0, width) === width,
    r2_bowl_closes_on_the_stem: bowl.length > 0,
    // R's leg kicks out from inside the bowl; without it R collapses into P (measured d=3).
    r3_leg_kicks_out_internally: legs.length > 0,
    r4_bottom_has_two_runs: rowRuns(ink, ROWS - 1, width) >= 2,
    r5_bowl_stops_above_the_legs: bowl.length > 0 && Math.max(...bowl) <= 2,
  }
  return { ...tests, PASS: Object.values(tests).every(Boolean) }
}

const BATTERIES: Record<string, (ink: Set<string>, width: number) => Record<string, boolean>> = {
  S: sBattery,
  W: wBattery,
  A: aBattery,
  R: rBattery,
  M: mBattery,
}

function parse(word: string): { lo: number; hi: number; width: number; ink: Set<string>; battery: Record<string, boolean> }[] {
  const grid = decodeSvg(logoSource)
  return groupsOf(grid.ink, grid.columns).map(([lo, hi], index) => {
    const width = hi - lo + 1
    const ink = glyph(grid.ink, lo, hi)
    return { lo, hi, width, ink, battery: BATTERIES[word[index]](ink, width) }
  })
}

describe("the wordmark decodes onto the cell grid it claims to draw", () => {
  const grid = decodeSvg(logoSource)

  test("five letters, separated by one blank column each", () => {
    expect(groupsOf(grid.ink, grid.columns)).toHaveLength(WORD.length)
  })

  test("the canvas grew and the pitch did not, which is what keeps the archive search key alive", () => {
    // `M16.20 0.00h33.60` is the byte-level key that proves the Swarm mark is in the shipped
    // bytes for five separate instruments (research/s6_r241b_wordmark_legibility.md §4.1).
    // Squeezing 26 columns into the old 234-unit canvas would move every coordinate and void all
    // five silently, each reporting a clean zero; this pin is what makes that variant fail here.
    expect(grid.d.startsWith("M16.20 0.00h33.60v8.40h-33.60z")).toBe(true)
    expect(grid.columns).toBe(26)
    expect(grid.viewBox).toBe('viewBox="0 0 250.8 42"')
  })

  test("the canvas width is exactly the inferred column count at the unchanged pitch", () => {
    expect(grid.width).toBeCloseTo(ORIGIN_X + grid.columns * PITCH + ORIGIN_X, 6)
  })
})

describe("I1 per-glyph battery — every letter passes its own structural test", () => {
  const glyphs = parse(WORD)

  for (const [index, letter] of [...[...WORD].entries()]) {
    test(`${letter} at grid columns ${glyphs[index].lo}-${glyphs[index].hi} passes its battery`, () => {
      expect(glyphs[index].width).toBeGreaterThanOrEqual(4)
      expect(glyphs[index].battery.PASS).toBe(true)
    })
  }

  test("the two disputed glyphs now draw the features they were missing", () => {
    const m = glyphs[4].battery
    expect(m.m1_two_arms_share_a_row).toBe(true)
    expect(m.m2_not_a_monotone_staircase).toBe(true)
    const w = glyphs[1].battery
    expect(w.w1_at_least_two_separated_feet).toBe(true)
    expect(w.w3_apex_free_standing).toBe(true)
  })
})

describe("anti-blank floor — no assertion may be satisfied by deleting ink", () => {
  const grid = decodeSvg(logoSource)

  test("each glyph keeps at least ten cells and the mark keeps at least sixty", () => {
    for (const [lo, hi] of groupsOf(grid.ink, grid.columns)) {
      expect(glyph(grid.ink, lo, hi).size).toBeGreaterThanOrEqual(10)
    }
    expect(grid.ink.size).toBeGreaterThanOrEqual(60)
  })
})

describe("copy parity — the five transcriptions of the art cannot drift apart", () => {
  const grid = decodeSvg(logoSource)
  const cli = cliBannerRows(cliSource)
  const split = splitBannerRows(tuiLogoSource)
  const presented = splitBannerRows(tuiPresentationSource)

  test("the OAuth page carries the identical path data", () => {
    expect(decodeSvg(oauthSource).viewBox).toBe(grid.viewBox)
    expect(decodeSvg(oauthSource).d).toBe(grid.d)
  })

  test("the CLI combined banner decodes to the same cells as the SVG", () => {
    expect(cli).toHaveLength(ROWS)
    expect(decodeAsciiRows(cli)).toEqual(grid.ink)
  })

  test("both TUI split copies decode to the same cells as the SVG", () => {
    expect(split).toHaveLength(ROWS)
    expect(presented).toHaveLength(ROWS)
    expect(decodeAsciiRows(split)).toEqual(grid.ink)
    expect(decodeAsciiRows(presented)).toEqual(grid.ink)
  })

  test("the split halves still stitch into the combined rows with one space", () => {
    const left = splitBannerLeft(tuiLogoSource)
    const right = splitBannerRight(tuiLogoSource)
    expect(left.map((row, index) => `${row} ${right[index] ?? ""}`)).toEqual(cli)
  })
})

function splitBannerLeft(source: string): string[] {
  const object = /(?:export )?const logo\s*=\s*\{([\s\S]*?)\n\}/.exec(source)
  if (!object) throw new Error("no logo object in the TUI source")
  return quotedStrings(new RegExp(`left:\\s*\\[([\\s\\S]*?)\\]`).exec(object[1])![1])
}

function splitBannerRight(source: string): string[] {
  const object = /(?:export )?const logo\s*=\s*\{([\s\S]*?)\n\}/.exec(source)
  if (!object) throw new Error("no logo object in the TUI source")
  return quotedStrings(new RegExp(`right:\\s*\\[([\\s\\S]*?)\\]`).exec(object[1])![1])
}

describe("mutation control — each battery is shown capable of failing", () => {
  // The shipped art, transcribed. These are the negative control from research §5.4 restated as
  // assertions: if any of these ever goes green, the corresponding limb above has stopped biting.
  const SHIPPED_M = "#..#/##.#/#.##/#..#/#..#"
  const SHIPPED_W = "#..#/#..#/#.##/####/.##."
  const FIXED_M = "#...#/##.##/#.#.#/#...#/#...#"
  const FIXED_W = "#...#/#...#/#.#.#/##.##/##.##"
  const FIXED_A = ".##./#..#/####/#..#/#..#"
  const FIXED_R = "####/#..#/###./#.##/#..#"
  const FIXED_S = "####/#.../####/...#/####"

  test("the shipped M fails exactly the two assertions the user's eye caught", () => {
    const result = mBattery(cells(SHIPPED_M, 4), 4)
    expect(result.PASS).toBe(false)
    expect(result.m1_two_arms_share_a_row).toBe(false)
    expect(result.m2_not_a_monotone_staircase).toBe(false)
  })

  test("the shipped W fails feet and apex separability", () => {
    const result = wBattery(cells(SHIPPED_W, 4), 4)
    expect(result.PASS).toBe(false)
    expect(result.w1_at_least_two_separated_feet).toBe(false)
    expect(result.w3_apex_free_standing).toBe(false)
  })

  test("removing the added M vertex turns it red again", () => {
    expect(mBattery(drop(cells(FIXED_M, 5), 2, 2), 5).PASS).toBe(false)
  })

  test("removing either added M arm turns it red again", () => {
    expect(mBattery(drop(cells(FIXED_M, 5), 1, 1), 5).PASS).toBe(false)
    expect(mBattery(drop(cells(FIXED_M, 5), 1, 3), 5).PASS).toBe(false)
  })

  test("taking the fifth column back out of the W turns it red again", () => {
    // Deleting column 2 of the fixed W and closing the gap is the shipped four-column frame
    // rebuilt from the fixed art: the two feet fuse into one full-width bar again.
    expect(wBattery(cells("#..#/#..#/##.#/####/####", 4), 4).PASS).toBe(false)
    expect(wBattery(cells(FIXED_W, 5), 5).PASS).toBe(true)
  })

  test("fusing the W apex back onto a leg turns it red again", () => {
    expect(wBattery(add(cells(FIXED_W, 5), 2, 3), 5).PASS).toBe(false)
  })

  test("the S, A and R batteries bite too: each named mutation loses its distinguishing stroke", () => {
    expect(sBattery(drop(cells(FIXED_S, 4), 3, 3), 4).PASS).toBe(false)
    expect(aBattery(add(add(cells(FIXED_A, 4), 0, 0), 0, 3), 4).PASS).toBe(false)
    expect(rBattery(drop(cells(FIXED_R, 4), 3, 2), 4).PASS).toBe(false)
  })
})

function cells(pattern: string, width: number): Set<string> {
  const ink = new Set<string>()
  pattern.split("/").forEach((row, r) => {
    ;[...row].forEach((char, c) => {
      if (char === "#" && c < width) ink.add(`${r}:${c}`)
    })
  })
  return ink
}

function drop(ink: Set<string>, row: number, col: number): Set<string> {
  const out = new Set(ink)
  out.delete(`${row}:${col}`)
  return out
}

function add(ink: Set<string>, row: number, col: number): Set<string> {
  const out = new Set(ink)
  out.add(`${row}:${col}`)
  return out
}
