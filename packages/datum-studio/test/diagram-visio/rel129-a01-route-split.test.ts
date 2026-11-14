// Swarm 1.2.9 row 25 (AC-A01, B9-A01; register N9-078, N9-080, N9-081, N9-100; 01a AT-A01; 03a lines 107-117).
// REFACTOR-PIN for the split of engine/diagram/build/route.ts into end placement (route-ends.ts) and run shaping
// (route-shape.ts). (a) Structure: both modules exist; every symbol of the 03a end-placement list is declared in
// route-ends.ts and nowhere else, every symbol of the 03a run-shaping list in route-shape.ts and nowhere else; imports
// run one way only (ends <- shape <- route). Re-exported runtime names are the module's own bindings.
// (b) Export pin (N9-078): route.ts exports exactly the 12 names it exported at BASE d4282fcfd8, read at run time
// (Object.keys of the module) for the 9 values and from the source for the 3 type-only names, which a compile-time
// `import type` below also checks. Byte identity of the output is the 52b harness (rel128-vis0 "char"), not this file.
// Red at BASE: (a) fails, the two modules are absent; (b) is green at BASE by design (the pin is the invariant).
import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import ts from "typescript"
import type { EdgeRouteStyle, HoppedEdge, RouteLattice } from "../../vendor/src/lib/studio/engine/diagram/build/route"

const BUILD = path.resolve(import.meta.dir, "../../vendor/src/lib/studio/engine/diagram/build")
const FILES = { route: "route.ts", ends: "route-ends.ts", shape: "route-shape.ts" } as const
type Mod = keyof typeof FILES

/** 03a line 111: shared types and helpers, side choice and glue, with their constants. */
const ENDS = [
  "Pt", "Side", "SidePair", "OPP", "NORMAL", "EdgeRouteStyle", "edgeRouteOf", "routeStyleOfPath", "sideField", "slotField",
  "viaOf", "glued", "between", "indexOfEdge", "nodeOf", "OUTLINE_SHAPES", "HEAD_RUN_MM", "STRAIGHT_END_MIN_DEG",
  "incidenceDeg", "EDGE_CLEAR_MM", "clampIn", "withSides", "slotAnchor", "sideOf", "anchor", "outlineBottomY", "glueEnd",
  "outlineYAt", "outlineXAt", "glueOutline", "glueLabelBelow", "markLabelBeside", "glueToOutlines", "boxEnds",
  "belowSides", "annotationSides", "sideCandidates", "diamondVertexSides", "straightSpan", "arcSpan", "boxLike",
  "sharedBand", "straightEnd", "facingSide", "SIDE_SPREAD_FRAC", "DIAMOND_HEAD_CLEAR_DEG", "SHARED_BAND_CLEAR_MM",
  "ARC_SPAN_FRAC",
]
/** 03a line 112: run shaping and fan groups. */
const SHAPE = [
  "curvedPoints", "RouteLattice", "routeLattice", "viaFamily", "viaPoints", "legOut", "straightLeg", "viaRoute", "rectHit",
  "OUTSIDE", "blocked", "normalEnds", "endNormal", "doublesBack", "manhattan", "detour", "throughEnds", "cornerRoute",
  "FANOUT_SPLIT_MIN", "FAN_LEVEL_STEP", "FanGroup", "fanGroups", "conflictsOf", "fanRaw", "forwardRun", "monotone",
]
/** 03a line 113: what route.ts keeps. */
const ROUTE = ["HoppedEdge", "routeRackSide", "routePlaced", "routeWithSides", "crossingHops"]
/** N9-078: the 12 names route.ts exports (BASE `grep -n "^export" route.ts`). */
const EXPORTS_12 = [
  "HoppedEdge", "EdgeRouteStyle", "edgeRouteOf", "routeStyleOfPath", "curvedPoints", "RouteLattice", "routeLattice",
  "viaFamily", "EDGE_CLEAR_MM", "routePlaced", "FANOUT_SPLIT_MIN", "crossingHops",
]
const TYPE_ONLY = ["HoppedEdge", "EdgeRouteStyle", "RouteLattice"]

const read = (m: Mod) => readFileSync(path.join(BUILD, FILES[m]), "utf8")
const parse = (m: Mod) => ts.createSourceFile(FILES[m], read(m), ts.ScriptTarget.Latest, true)

/** Top-level declared names (functions, consts, types, interfaces). */
function declared(sf: ts.SourceFile): string[] {
  const out: string[] = []
  for (const s of sf.statements) {
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) out.push((d.name as ts.Identifier).text)
    else if ((ts.isFunctionDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isInterfaceDeclaration(s)) && s.name) out.push(s.name.text)
  }
  return out
}
/** Relative module specifiers of every import and re-export. */
function specifiers(sf: ts.SourceFile): string[] {
  const out: string[] = []
  for (const s of sf.statements)
    if ((ts.isImportDeclaration(s) || ts.isExportDeclaration(s)) && s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier)) out.push(s.moduleSpecifier.text)
  return out
}
/** Names a file exports, read from the syntax: `export` modifiers and `export { ... }` lists (no `export *`). */
function exported(sf: ts.SourceFile): { names: string[]; star: number } {
  const names: string[] = []
  let star = 0
  for (const s of sf.statements) {
    if (ts.isExportDeclaration(s)) {
      if (!s.exportClause) star++
      else if (ts.isNamedExports(s.exportClause)) for (const e of s.exportClause.elements) names.push(e.name.text)
      continue
    }
    const mods = ts.canHaveModifiers(s) ? ts.getModifiers(s) ?? [] : []
    if (!mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue
    if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) names.push((d.name as ts.Identifier).text)
    else if ("name" in s && s.name && ts.isIdentifier(s.name as ts.Node)) names.push((s.name as ts.Identifier).text)
  }
  return { names, star }
}
const sorted = (a: readonly string[]) => [...a].sort()
const toRoute = (spec: string) => /^\.\/route(\.ts)?$/.test(spec)
const toShape = (spec: string) => /^\.\/route-shape(\.ts)?$/.test(spec)

describe("A01 structure (a)", () => {
  test("route-ends.ts and route-shape.ts exist next to route.ts", () => {
    expect([existsSync(path.join(BUILD, FILES.ends)), existsSync(path.join(BUILD, FILES.shape))]).toEqual([true, true])
  })

  test("each 03a list is declared in its own module only", () => {
    const d = { route: declared(parse("route")), ends: declared(parse("ends")), shape: declared(parse("shape")) }
    expect(ENDS.filter((n) => !d.ends.includes(n)), "missing in route-ends.ts").toEqual([])
    expect(SHAPE.filter((n) => !d.shape.includes(n)), "missing in route-shape.ts").toEqual([])
    expect(ROUTE.filter((n) => !d.route.includes(n)), "missing in route.ts").toEqual([])
    expect(ENDS.filter((n) => d.route.includes(n) || d.shape.includes(n)), "end-placement names outside route-ends.ts").toEqual([])
    expect(SHAPE.filter((n) => d.route.includes(n) || d.ends.includes(n)), "run-shaping names outside route-shape.ts").toEqual([])
    // no name is declared twice across the three modules
    const all = [...d.route, ...d.ends, ...d.shape]
    expect(all.filter((n, i) => all.indexOf(n) !== i)).toEqual([])
  })

  test("imports run one way: ends <- shape <- route", () => {
    const ends = specifiers(parse("ends"))
    const shape = specifiers(parse("shape"))
    expect(ends.filter((s) => toRoute(s) || toShape(s)), "route-ends.ts imports").toEqual([])
    expect(shape.filter(toRoute), "route-shape.ts imports").toEqual([])
    expect(shape.some((s) => /^\.\/route-ends(\.ts)?$/.test(s))).toBe(true)
  })

  test("route.ts re-exports the moved runtime names as the modules' own bindings", async () => {
    const ends = (await import(path.join(BUILD, FILES.ends))) as Record<string, unknown>
    const shape = (await import(path.join(BUILD, FILES.shape))) as Record<string, unknown>
    const R = (await import(path.join(BUILD, FILES.route))) as Record<string, unknown>
    for (const n of ["edgeRouteOf", "routeStyleOfPath", "EDGE_CLEAR_MM"]) expect(R[n] === ends[n] && R[n] !== undefined, n).toBe(true)
    for (const n of ["curvedPoints", "routeLattice", "viaFamily", "FANOUT_SPLIT_MIN"]) expect(R[n] === shape[n] && R[n] !== undefined, n).toBe(true)
  })
})

describe("A01 export pin (b, N9-078)", () => {
  test("Object.keys(route.ts) are the 9 runtime names of the 12", async () => {
    const mod = await import("../../vendor/src/lib/studio/engine/diagram/build/route")
    expect(Object.keys(mod).sort()).toEqual(sorted(EXPORTS_12.filter((n) => !TYPE_ONLY.includes(n))))
  })

  test("route.ts source exports exactly the 12 names, no export *", () => {
    const { names, star } = exported(parse("route"))
    expect(star).toBe(0)
    expect(sorted(names)).toEqual(sorted(EXPORTS_12))
  })

  test("the type-only names resolve at compile time (import type) and keep their shape", () => {
    const style: EdgeRouteStyle = "curved"
    const lattice: Pick<RouteLattice, "col_mm" | "row_mm"> = { col_mm: 1, row_mm: 2 }
    const hop: Pick<HoppedEdge, "hops"> = { hops: [[3, 4]] }
    expect([style, lattice.col_mm + lattice.row_mm, hop.hops.length]).toEqual(["curved", 3, 1])
  })
})
