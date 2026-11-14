// Swarm 1.2.9 row 26 (AC-A02, B9-A02; register N9-101, N9-203; 01a AT-A02 amended by C12 / OP13-1). A connector path
// (`data-mark="link"`) does not repeat a vertex: a point equal to the one before it draws nothing, so it is dropped at
// the emitter (`edgePathSvg`, engine/diagram/core/svg.ts) after the coordinates are rounded. Legacy flows (family
// `flow` without `direction`, frozen at their 1.2.5 bytes by 01e A15) keep their bytes, repeats included (C12).
// Corpora: (i) `parityRenders()` (diagram renders), (ii) the 52b CHAR corpus specs (sync and auto build), (iii) the
// 68a carry specs B1/B4/C1 through the preview path at 128 and 166 mm.
// 1. Non-legacy link paths: no two consecutive vertices closer than 0.005 mm.
// 2. Legacy flows: the whole SVG equals the hash pinned at BASE d4282fcfd8 (REL129_A02_PRINT=1 prints the table), and
//    at least one legacy path still repeats a vertex, so the gate is exercised and not vacuous.
// 3. Emitter oracle: for points with repeats (start, middle, end) the drawn length equals the length of the points
//    within 0.01 mm (repeats add 0 length, so the dash phase is unchanged) and the last non-zero piece keeps its
//    direction (marker orient=auto); a legacy-marked point list is drawn exactly as `polylineD` draws it.
// Red at BASE: 1 and 3 fail (03a probe: 46 of 90 link paths in 16 parity renders repeat a vertex); 2 is green at BASE
// by design (the pin is the invariant). Namespace imports: at BASE the legacy marker does not exist, so the red run
// fails on assertions, not on a link error.
import { useStudioEnv } from "../ported/_env"
useStudioEnv()
import { beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parityRenders } from "../ported/figures/_svgManifest"
import { PARITY_DIAGRAM_DIR } from "../ported/figures/_helpers"
import { buildDiagramSvg } from "../../vendor/src/lib/studio/engine/diagram/build/index"
import { buildDiagramSvgAuto } from "../../vendor/src/lib/studio/engine/diagram/elk/index"
import { diagramSpec } from "../../vendor/src/lib/studio/services/compose/blocks"

type J = Record<string, any>
type Pt = [number, number]
const core = (await import("../../vendor/src/lib/studio/engine/diagram/core/svg")) as J
const compose = (await import("../../vendor/src/lib/studio/services/compose/index.ts")) as J
const fig = (await import("../../src/mcp-host/local-api/routes/figure-preview-figure.ts")) as J

const TEST_ROOT = path.resolve(import.meta.dir, "..")
const h16 = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)
/** Legacy flow (01e A15): family `flow` and no `direction`. */
const isLegacy = (s: J) => s?.family === "flow" && (s.direction === undefined || s.direction === null)

// ── link paths read from the SVG ──────────────────────────────────────────────────────────────────────────────────
/** Vertices of every polyline link path (`M x y L x y ...`), in document order. */
function linkPolylines(svg: string): Pt[][] {
  const out: Pt[][] = []
  for (const m of svg.matchAll(/<path\b([^>]*)\/>/g)) {
    if (!/\sdata-mark="link"/.test(m[1])) continue
    const d = /\sd="([^"]*)"/.exec(m[1])?.[1] ?? ""
    if (!/^M[\d\s.L-]+$/.test(d)) continue // heads and arcs are not polylines
    out.push(d.replace(/^M\s*/, "").split(/\s*L\s*/).map((p) => p.trim().split(/\s+/).map(Number) as Pt))
  }
  return out
}
/** Index of every vertex equal (< 0.005 mm) to the one before it. */
const repeatsOf = (pts: Pt[]) => pts.flatMap((p, k) => (k > 0 && Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) < 0.005 ? [k] : []))
const lengthOf = (pts: ReadonlyArray<readonly [number, number]>) => pts.reduce((a, p, k) => (k ? a + Math.hypot(p[0] - pts[k - 1][0], p[1] - pts[k - 1][1]) : 0), 0)
/** Unit direction of the last piece of non-zero length. */
function lastDir(pts: ReadonlyArray<readonly [number, number]>): Pt {
  const e = pts[pts.length - 1]
  for (let k = pts.length - 2; k >= 0; k--) {
    const v: Pt = [e[0] - pts[k][0], e[1] - pts[k][1]]
    const n = Math.hypot(v[0], v[1])
    if (n > 1e-9) return [v[0] / n, v[1] / n]
  }
  return [0, 0]
}
const parseD = (d: string): Pt[] => d.replace(/^M\s*/, "").split(/\s*L\s*/).map((p) => p.trim().split(/\s+/).map(Number) as Pt)
const dOf = (pathEl: string) => /\sd="([^"]*)"/.exec(pathEl)![1]

// ── the three corpora ─────────────────────────────────────────────────────────────────────────────────────────────
type Render = { key: string; legacy: boolean; svg: string }

/** (i) diagram renders of `parityRenders()`; the spec file says whether the figure is a legacy flow. */
function parityCorpus(): { renders: Render[]; total: number } {
  const all = parityRenders()
  const renders = all
    .filter((r) => r.id.startsWith("diagram/"))
    .map((r) => {
      const file = r.id.slice("diagram/".length).replace(/@(rel|draft)$/, "")
      const spec = JSON.parse(readFileSync(path.join(PARITY_DIAGRAM_DIR, file), "utf8")) as J
      return { key: `parity:${r.id}`, legacy: isLegacy(spec), svg: r.svg }
    })
  return { renders, total: all.length }
}

/** (ii) the 52b CHAR corpus files (rel128-vis0-contract-defaults.test.ts CHAR_FILES), sync and auto build. */
const CHAR_FILES = [
  "engine-rev-a/svg/fixtures/case04.studio.json",
  "engine-rev-a/svg/fixtures/case04_v2.studio.json",
  "engine-rev-a/svg/fixtures/case05_diagram_block.json",
  "engine-rev-a/svg/fixtures/row162_elk_not_better.json",
  "engine-rev-a/svg/fixtures/row162_large_layered.json",
  "fixtures/syn127/f6_fan_in_specs.json",
  "fixtures/syn127/m03_render_fail_doc.json",
  "fixtures/syn127/n7_autofit_t03_rest.json",
  "fixtures/syn127/t06_diagram_six_colours.json",
  "fixtures/syn127/t11_flow_inline_v2.json",
  "fixtures/syn127/t12_standalone_key_source.json",
  "fixtures/syn128/hn13_import.md",
  "fixtures/syn128/hn6_engine_entry_collision.json",
  "fixtures/syn128/hna_flow_v2.json",
  "fixtures/syn128/hnb2_capacity_adapt.json",
  "fixtures/syn128/hnb4_flow_rank_overflow.json",
  "fixtures/syn128/hnb4_graph_sheet_overflow.json",
  "fixtures/syn128/hnb_fit_to_zero.json",
  "fixtures/syn128/r18g_lr_166.json",
]
const isSpec = (o: unknown): o is J => !!o && typeof o === "object" && !Array.isArray(o) && Array.isArray((o as J).nodes) && typeof (o as J).family === "string"
async function charCorpus(): Promise<Render[]> {
  const out: Render[] = []
  for (const rel of CHAR_FILES) {
    const text = readFileSync(path.join(TEST_ROOT, rel), "utf8")
    const roots: Array<[string, J]> = rel.endsWith(".md")
      ? [...text.matchAll(/```(?:diagram|json)\n([\s\S]*?)\n```/g)].map((m, i) => [`/fence${i}`, JSON.parse(m[1])] as [string, J])
      : [["", JSON.parse(text)]]
    for (const [base, root] of roots) {
      const opts = { release: false, ...((root.buildOptions as J) ?? {}) }
      const specs: Array<[string, J]> = []
      const walk = (o: unknown, ptr: string) => {
        if (isSpec(o)) return void specs.push([ptr, o])
        if (o && typeof o === "object") for (const [k, v] of Object.entries(o as J)) walk(v, `${ptr}/${k}`)
      }
      walk(root, "")
      for (const [ptr, o] of specs) {
        const v1 = o.$schema ? structuredClone(o) : diagramSpec(structuredClone(o) as never, "Uji.", "SUMBER: uji.", 128, { artifactLabel: "1.1", classification: "TERBATAS", params: {} } as never)
        const key = `${rel}#${base}${ptr}`
        for (const auto of [false, true]) {
          try {
            const r = (auto ? await buildDiagramSvgAuto(structuredClone(v1) as never, opts as never, {}) : buildDiagramSvg(structuredClone(v1) as never, opts as never)) as J
            out.push({ key: `char:${key}@${auto ? "auto" : "sync"}`, legacy: isLegacy(o), svg: r.svg as string })
          } catch {
            // a refused spec draws no connector
          }
        }
      }
    }
  }
  return out
}

/** (iii) the 68a carry specs through the preview path (compose mapBlock -> renderFigure) at 128 and 166 mm. */
async function carryCorpus(): Promise<Render[]> {
  const FX = JSON.parse(readFileSync(path.join(TEST_ROOT, "fixtures", "syn128", "vis68a_live_specs.json"), "utf8")) as J
  const out: Render[] = []
  for (const name of ["B1_carry_pools_phases", "B4_carry_flow", "C1_via"]) {
    for (const widthMm of [128, 166]) {
      const f = FX[name]
      const b = { type: "diagram", caption: { text: f.caption }, source: { text: f.source }, spec: structuredClone(f.spec) }
      const params = { "diagram.widthMm": widthMm }
      const content = compose.mapBlock(b, "fig-a02", { glyphs: compose.glyphSet(undefined), params, classification: "TERBATAS", artifactLabel: "Gambar 1.1" })
      const nb = { blockId: "fig-a02", pid: "fig-a02", address: "1.1.1", ordinal: 0, unitKey: "", type: "diagram", content, textPlain: "", contentSha256: "", artifactLabel: "Gambar 1.1" }
      const r = await fig.renderFigure(nb, { params } as never, { inline: true, withSvg: true, lang: "ID" })
      out.push({ key: `carry:${name}@${widthMm}`, legacy: isLegacy(f.spec), svg: r.svg as string })
    }
  }
  return out
}

/**
 * Legacy-flow renders of the three corpora, whole-SVG sha256 (first 16 hex), GENERATED at BASE d4282fcfd8 in the
 * red-base worktree with REL129_A02_PRINT=1 (C12: legacy flows stay byte-identical). Edit only as INTENT of a listed
 * AC line.
 */
const LEGACY_PINS: Record<string, string> = {
  "parity:diagram/dg_flow.json@rel": "fc48425d8f2eded6",
  "parity:diagram/dg_flow.json@draft": "fc48425d8f2eded6",
  "parity:diagram/dg_flow_wrapped.json@rel": "bb2a06d4d8d55c6b",
  "parity:diagram/dg_flow_wrapped.json@draft": "bb2a06d4d8d55c6b",
  "char:fixtures/syn127/f6_fan_in_specs.json#/specs/5/spec@sync": "555deb241743acbb",
  "char:fixtures/syn127/f6_fan_in_specs.json#/specs/5/spec@auto": "555deb241743acbb",
  "char:fixtures/syn127/m03_render_fail_doc.json#/chapters/0/chapter/sections/0/blocks/1/spec@sync": "3f0f35339e73c5b0",
  "char:fixtures/syn127/m03_render_fail_doc.json#/chapters/0/chapter/sections/0/blocks/1/spec@auto": "3f0f35339e73c5b0",
  "char:fixtures/syn127/t11_flow_inline_v2.json#/block/spec@sync": "5850dd65ccaf081a",
  "char:fixtures/syn127/t11_flow_inline_v2.json#/block/spec@auto": "5850dd65ccaf081a",
  "char:fixtures/syn127/t12_standalone_key_source.json#/block/spec@sync": "463526c2b27cc56e",
  "char:fixtures/syn127/t12_standalone_key_source.json#/block/spec@auto": "463526c2b27cc56e",
  "char:fixtures/syn128/hn13_import.md#/fence0@sync": "ed4f6e318a6f4bd4",
  "char:fixtures/syn128/hn13_import.md#/fence0@auto": "ed4f6e318a6f4bd4",
  "char:fixtures/syn128/hn13_import.md#/fence1/spec@sync": "02b521566ecaa5a5",
  "char:fixtures/syn128/hn13_import.md#/fence1/spec@auto": "02b521566ecaa5a5",
  "char:fixtures/syn128/hna_flow_v2.json#/block/spec@sync": "44e280ba26404ba0",
  "char:fixtures/syn128/hna_flow_v2.json#/block/spec@auto": "44e280ba26404ba0",
  "char:fixtures/syn128/hna_flow_v2.json#/writeBlock/diagram/spec@sync": "44e280ba26404ba0",
  "char:fixtures/syn128/hna_flow_v2.json#/writeBlock/diagram/spec@auto": "44e280ba26404ba0",
  "char:fixtures/syn128/hna_flow_v2.json#/chapter/chapter/sections/0/blocks/1/spec@sync": "44e280ba26404ba0",
  "char:fixtures/syn128/hna_flow_v2.json#/chapter/chapter/sections/0/blocks/1/spec@auto": "44e280ba26404ba0",
  "carry:B4_carry_flow@128": "463f9660c1b7d3dd",
  "carry:B4_carry_flow@166": "165891c2ff7beeff",
}

describe("AC-A02 zero-length points in link paths", () => {
  let renders: Render[] = []
  let parityTotal = 0
  beforeAll(async () => {
    const p = parityCorpus()
    parityTotal = p.total
    renders = [...p.renders, ...(await charCorpus()), ...(await carryCorpus())]
    if (process.env.REL129_A02_PRINT === "1") {
      const pins: Record<string, string> = {}
      for (const r of renders) if (r.legacy) pins[r.key] = h16(r.svg)
      console.log(`[rel129-a02] LEGACY_PINS ${JSON.stringify(pins, null, 2)}`)
      for (const r of renders) {
        const rep = linkPolylines(r.svg).filter((pl) => repeatsOf(pl).length).length
        console.log(`[rel129-a02] ${r.legacy ? "legacy" : "nonleg"} ${rep}/${linkPolylines(r.svg).length} ${r.key} ${h16(r.svg)}`)
      }
    }
  }, 180_000)

  test("non-legacy link paths repeat no vertex (parity, CHAR corpus, carry previews)", () => {
    expect(parityTotal).toBe(118)
    const offenders: string[] = []
    let links = 0
    for (const r of renders.filter((x) => !x.legacy)) {
      linkPolylines(r.svg).forEach((pl, i) => {
        links++
        const rep = repeatsOf(pl)
        if (rep.length) offenders.push(`${r.key} link ${i}: vertex ${rep.join(",")} repeats (${pl[rep[0]].join(" ")})`)
      })
    }
    console.log(`[rel129-a02] non-legacy: ${renders.filter((x) => !x.legacy).length} renders, ${links} link paths, ${offenders.length} with a repeat`)
    expect(links).toBeGreaterThan(0)
    expect(offenders).toEqual([])
  })

  test("legacy flows (family flow, no direction) keep their bytes, repeats included (C12)", () => {
    const legacy = renders.filter((r) => r.legacy)
    expect(legacy.map((r) => r.key).sort()).toEqual(Object.keys(LEGACY_PINS).sort())
    for (const r of legacy) expect(h16(r.svg), r.key).toBe(LEGACY_PINS[r.key])
    // not vacuous: the legacy corpus holds paths with a repeated vertex, and they are still drawn
    const withRepeat = legacy.flatMap((r) => linkPolylines(r.svg)).filter((pl) => repeatsOf(pl).length).length
    console.log(`[rel129-a02] legacy: ${legacy.length} renders, ${withRepeat} link paths keep a repeated vertex`)
    expect(withRepeat).toBeGreaterThan(0)
  })

  test("emitter: repeats dropped, drawn length and last direction kept; legacy points drawn as polylineD draws them", () => {
    const cases: Array<[string, Pt[]]> = [
      ["middle", [[10, 10], [10, 20], [10, 20], [10, 20], [30, 20], [30, 40]]],
      ["start", [[5, 5], [5, 5], [25, 5], [25, 15]]],
      ["end", [[0, 0], [0, 12.5], [18.25, 12.5], [18.25, 12.5]]],
      ["rounding", [[1, 1], [1, 7], [1.001, 7.002], [9, 7]]],
    ]
    for (const [name, pts] of cases) {
      for (const kind of ["data", "control", "accent"] as const) {
        const d = parseD(dOf(core.edgePathSvg(pts, kind)))
        expect(repeatsOf(d), `${name}/${kind}`).toEqual([])
        const trim = kind === "accent" ? core.headTrimMm(kind, "kind") : 0
        expect(Math.abs(lengthOf(d) - (lengthOf(pts) - trim)), `${name}/${kind} length`).toBeLessThan(0.01)
        const [ux, uy] = lastDir(d)
        const [vx, vy] = lastDir(pts)
        expect(Math.abs(ux * vy - uy * vx) < 1e-3 && ux * vx + uy * vy > 0, `${name}/${kind} last direction`).toBe(true)
      }
    }
    expect(typeof core.keepLinkRepeats).toBe("function")
    for (const [name, pts] of cases) {
      const kept = pts.map((p) => [...p] as Pt)
      core.keepLinkRepeats(kept)
      expect(dOf(core.edgePathSvg(kept, "data")), `legacy ${name}`).toBe(core.polylineD(kept))
    }
  })
})
