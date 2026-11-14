/**
 * Swarm 1.2.8 row 35 (N8-339; AC-HNB, AC-HNB2, AC-HNB3): auto-fit notices.
 * - H-NB: the AUTO_FIT detail marks its lead count as the pre-fit one (`sebelum fit <n>, sesudah fit <rest>`); the
 *   no-better branch says `sebelum fit <n>; tidak lebih baik`. BASE: `cacat geometri terdeteksi (<n>)`.
 * - H-NB2: a self-correction made during the FIRST render (T-08 fan split, `build/route.ts`) is reported once as a
 *   REPORT entry on the early-return path (first render scores 0) and on the `best` path. BASE: the early return
 *   drops it (diagramFitNote records nothing outside withDiagramFit). The capacity path (fixture
 *   syn128/hnb2_capacity_adapt.json) already reported CAPACITY_ADAPT at BASE (C25) and still does, once.
 * - H-NB3: the stub-segment advice names a longer run, not a label change; label advice stays on the label kinds.
 * Inputs are synthetic (syn128 fixtures and inline specs).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const PKG = path.resolve(import.meta.dir, "..", "..")
const D = path.join(PKG, "vendor", "src", "lib", "studio", "engine", "diagram")
const build = await import(path.join(D, "build", "index.ts"))
const autofit = await import(path.join(D, "build", "autofit.ts"))
const lint = await import(path.join(D, "fit", "lint.ts"))
const elk = await import(path.join(D, "elk", "index.ts"))

type Rec = Record<string, any>
const fixture = (f: string) => JSON.parse(readFileSync(path.join(PKG, "test", "fixtures", "syn128", f), "utf8")) as Rec
const geomOf = (r: Rec): Rec[] => (r.report?.geometry ?? []) as Rec[]
const run = (s: unknown) => build.buildDiagramSvg(structuredClone(s), { release: false }) as Rec
const keyOf = (i: Rec) => `${i.checkId}\u0000${i.detail}`

const base = (family: string, extra: Record<string, unknown>) => ({
  $schema: "studio.diagram/v1", family, id: "9.1", title: "Gambar sintetis uji.", classification: "BIASA", width_mm: 166,
  apparatus: "page", labels_verified: true, sources: ["Sumber sintetis uji"], ...extra,
})
const fanOut = (n: number, direction: string, label: (i: number) => string = (i) => `Tujuan ${i}`) =>
  base("flow", {
    direction,
    nodes: [{ id: "s", label: "Sumber", class: {} }, ...Array.from({ length: n }, (_, i) => ({ id: `t${i}`, label: label(i), class: {} }))],
    edges: Array.from({ length: n }, (_, i) => ({ from: "s", to: `t${i}`, kind: "data", label: `d${i}` })),
  })

describe("H-NB", () => {
  test("hnb_fit_to_zero: AUTO_FIT says sebelum fit 1, sesudah fit sisa 0; suggest tidak ada", () => {
    const fx = fixture("hnb_fit_to_zero.json")
    const r = build.buildDiagramSvg(structuredClone(fx.spec), fx.buildOptions) as Rec
    const auto = geomOf(r).find((i) => i.checkId === "AUTO_FIT")
    expect(auto).toBeDefined()
    expect(String(auto!.detail)).toMatch(/^cacat geometri sebelum fit 1, sesudah fit sisa 0; /)
    expect(String(auto!.detail)).not.toMatch(/terdeteksi/)
    expect(auto!.suggest).toBe("tidak ada")
    expect(lint.lintDiagramGeometry(r.svg).score).toBe(0)
  })

  test("no-better branch: sebelum fit <n>; tidak lebih baik, first render kept", () => {
    // A connector through a third box: scored defect (edgeThroughNode), the re-render returns the same figure.
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">\n<rect x="0" y="0" width="120" height="60" fill="#FCFCFB"/>\n` +
      `<rect x="5" y="25" width="10" height="10" data-node="a" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>\n` +
      `<rect x="50" y="20" width="20" height="20" data-node="m" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>\n` +
      `<rect x="105" y="25" width="10" height="10" data-node="b" fill="none" stroke="#2B3640" stroke-width="0.45" data-mark="node"/>\n` +
      `<path d="M 15 30 L 105 30" fill="none" stroke="#101418" stroke-width="0.45" marker-end="url(#head-data)" data-mark="link"/>\n</svg>`
    const n = lint.lintDiagramGeometry(svg).score
    expect(n).toBeGreaterThan(0)
    const first = { svg, widthMm: 120, heightMm: 60, report: { checksRun: [], issues: [] } }
    const out = autofit.autoFitDiagram(first, () => first) as Rec
    expect(out.svg).toBe(svg)
    const auto = geomOf(out).find((i) => i.checkId === "AUTO_FIT")
    expect(String(auto!.detail)).toMatch(new RegExp(`^cacat geometri sebelum fit ${n}; tidak lebih baik`))
    expect(String(auto!.detail)).toMatch(/render pertama dipertahankan$/)
  })
})

describe("H-NB2", () => {
  for (const [name, s] of [
    ["fan-out 5, TB 166", fanOut(5, "TB")],
    ["fan-out 6, LR 166", fanOut(6, "LR")],
  ] as const) {
    test(`${name}: first render scores 0 after the fan split; EDGE_LANES reported once, no AUTO_FIT`, () => {
      const r = run(s)
      expect(lint.lintDiagramGeometry(r.svg).score).toBe(0)
      const geo = geomOf(r)
      expect(geo.map((i) => i.checkId)).not.toContain("AUTO_FIT")
      const lanes = geo.filter((i) => i.checkId === "EDGE_LANES")
      expect(lanes.length).toBe(1)
      expect(lanes[0]).toMatchObject({ status: "REPORT" })
      expect(String(lanes[0].detail)).toMatch(/konektor kipas diberi titik keluar dan tingkat belok sendiri/)
      expect(run(s).svg).toBe(r.svg) // deterministic; the report change does not touch the SVG
    })
  }

  test("buildDiagramSvgAuto takes the same path for the fan (EDGE_LANES once)", async () => {
    const r = (await elk.buildDiagramSvgAuto(structuredClone(fanOut(5, "TB")), { release: false })) as Rec
    expect(geomOf(r).filter((i) => i.checkId === "EDGE_LANES").length).toBe(1)
  })

  test("best path: the fan split of the first render appears once, no duplicate entries", () => {
    const r = run(fanOut(5, "TB", (i) => `Tujuan dengan label yang sangat panjang sekali nomor ${i} lagi`))
    const geo = geomOf(r)
    expect(geo[0]?.checkId).toBe("AUTO_FIT")
    expect(geo.filter((i) => i.checkId === "EDGE_LANES").length).toBe(1)
    expect(new Set(geo.map(keyOf)).size).toBe(geo.length)
  })

  test("capacity path (hnb2_capacity_adapt): CAPACITY_ADAPT once, AUTO_FIT says the first render was refused", () => {
    const fx = fixture("hnb2_capacity_adapt.json")
    const r = build.buildDiagramSvg(structuredClone(fx.spec), fx.buildOptions) as Rec
    const geo = geomOf(r)
    expect(geo.filter((i) => i.checkId === "CAPACITY_ADAPT").length).toBe(1)
    expect(String(geo.find((i) => i.checkId === "AUTO_FIT")?.detail)).toMatch(/^render pertama ditolak DATUM-37/)
    expect(new Set(geo.map(keyOf)).size).toBe(geo.length)
  })

  test("a first-render record never reaches another figure (stale guard)", () => {
    run(fanOut(5, "TB")) // leaves nothing behind: autoFitDiagram took it
    build.routeEdges(structuredClone(fanOut(5, "TB")), { widthMm: 166 } as never) // bare routing leaves a record
    const clean = run(base("flow", { direction: "LR", nodes: [{ id: "a", label: "A", class: {} }, { id: "b", label: "B", class: {} }], edges: [{ from: "a", to: "b", kind: "data", label: "x" }] }))
    expect(geomOf(clean).map((i) => i.checkId)).not.toContain("EDGE_LANES")
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n<rect x="0" y="0" width="10" height="10" fill="#FCFCFB"/>\n</svg>`
    const hand = { svg, widthMm: 10, heightMm: 10, report: { checksRun: [], issues: [] } }
    build.routeEdges(structuredClone(fanOut(5, "TB")), { widthMm: 166 } as never)
    expect(autofit.autoFitDiagram(hand, () => hand)).toBe(hand) // CHAR: clean hand-built result returned as is
  })
})

describe("H-NB3", () => {
  const g = (kind: string) => ({ widthMm: 100, heightMm: 80, counts: {}, score: 0, defects: [{ kind, text: "x" }] })
  const suggestOf = (kind: string) => String(autofit.diagramGeometryIssues(g(kind) as never)[0]?.suggest)

  test("stubSegment advice: lengthen the short run (distance, another column or row, another side); no label advice", () => {
    const s = suggestOf("stubSegment")
    expect(s).toMatch(/perpanjang potongan pendek/)
    expect(s).toMatch(/jarak lebih antara kedua simpul/)
    expect(s).toMatch(/kolom atau baris lain/)
    expect(s).toMatch(/sisi simpul lain/)
    expect(s).not.toMatch(/label/)
  })

  test("label advice stays on the label kinds", () => {
    for (const k of ["textOverlap", "lineThroughText", "textOverNode", "textExceedsNode"]) expect([k, suggestOf(k)]).toEqual([k, expect.stringMatching(/label/)])
  })
})
