// N10-184 (Swarm 1.2.10 row 63, AC-P5b, P5-b, U3; spec 01e AT-P5b, C26 D-P5-4). Name drift pin for the built-in
// skill `diagram-flow` (src/skill/diagram-flow.md): every Studio tool, fit code and named source token in the skill
// exists in source registration, and the via-rule anchor the skill's advice rests on is still in the engine.
// Sources are read as TEXT (no cross-package import), the way rel128-builtin-skill-pack.test.ts reads them. One pure
// function `drift(skill, sources)` returns the names in the skill that the sources do not register; the checks call it.
// Check 9 runs `drift` on mutated sources, Check 10 on a skill with a renamed tool. Its manual twin: point the test-only
// variable REL1210_P5B_SKILL at a scratch copy of the skill with a renamed tool, and Checks 1, 3 and 8 go red.
// Red at BASE a3e3c4c93a: Checks 4 and 5 fail because the required names are absent from the skill. Checks 1-3 and
// 6-10 are guards and are green at BASE.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const OC = path.join(import.meta.dir, "..", "..")
const PACKAGES = path.join(OC, "..")
const readOptional = (...parts: string[]) => {
  try {
    return readFileSync(path.join(...parts), "utf8")
  } catch {
    return ""
  }
}

const SKILL = readOptional(process.env.REL1210_P5B_SKILL || path.join(OC, "src", "skill", "diagram-flow.md"))

const DS = path.join(PACKAGES, "datum-studio")
const VS = path.join(DS, "vendor", "scripts", "studio", "mcp")
const V = path.join(DS, "vendor", "src", "lib", "studio")
const D = path.join(V, "engine", "diagram")

type Sources = {
  /** VS/figure-tools.ts, doc-tools.ts, write-tools.ts, tools.ts joined. */
  vendorTools: string
  /** DS/src/mcp-host/tool-table.ts */
  hostTable: string
  /** D/build/autofit.ts */
  autofit: string
  /** DS/src/mcp-host/verify/static-checks.ts */
  staticChecks: string
  /** D/layout-a/flow.ts */
  flow: string
  /** V/contract/enums.ts */
  enums: string
  /** V/registry/charts.ts */
  charts: string
}

const SOURCES: Sources = {
  vendorTools: ["figure-tools.ts", "doc-tools.ts", "write-tools.ts", "tools.ts"].map((f) => readOptional(VS, f)).join("\n"),
  hostTable: readOptional(DS, "src", "mcp-host", "tool-table.ts"),
  autofit: readOptional(D, "build", "autofit.ts"),
  staticChecks: readOptional(DS, "src", "mcp-host", "verify", "static-checks.ts"),
  flow: readOptional(D, "layout-a", "flow.ts"),
  enums: readOptional(V, "contract", "enums.ts"),
  charts: readOptional(V, "registry", "charts.ts"),
}
const FIGURE_TOOLS_FILE = readOptional(VS, "figure-tools.ts")
const VENDOR_TOOLS_FILE = readOptional(VS, "tools.ts")
const SPEC_FILE = readOptional(D, "core", "spec.ts")
const ROUTE_SHAPE_FILE = readOptional(D, "build", "route-shape.ts")

// --- Parsers over source text -----------------------------------------------------------------------------------------
const uniq = (xs: string[]) => [...new Set(xs)]
/** The body of `<head> ... <end>`, or "" when the head is absent. */
const block = (text: string, head: string, end: string) => {
  const i = text.indexOf(head)
  if (i < 0) return ""
  const j = text.indexOf(end, i + head.length)
  return j < 0 ? "" : text.slice(i + head.length, j)
}
/** Vendor tool registrations: `name: "studio_…"`. */
const vendorRegistered = (s: Sources) => new Set([...s.vendorTools.matchAll(/\bname:\s*"(studio_[a-z_]+)"/g)].map((m) => m[1]))
/** `HOST_KEPT_TOOLS` entries: the tools Swarm actually lists. */
const hostKept = (s: Sources) =>
  new Set([...block(s.hostTable, "export const HOST_KEPT_TOOLS = [", "] as const").matchAll(/"(studio_[a-z_]+)"/g)].map((m) => m[1]))
/** The autofit `CHECK` map, value -> key (the defect kind). */
const checkMap = (s: Sources) =>
  new Map(
    [...block(s.autofit, "const CHECK: Record<DiagramDefectKind, string> = {", "};").matchAll(/^\s*([a-zA-Z]+):\s*"([A-Z_]+)"/gm)].map(
      (m) => [m[2], m[1]] as const,
    ),
  )
/** `DIAGRAM_FAIL_KINDS`: the kinds that fail FIGURE_FIT. */
const failKinds = (s: Sources) =>
  new Set(
    [...block(s.staticChecks, "export const DIAGRAM_FAIL_KINDS: ReadonlySet<DiagramDefectKind> = new Set([", "])").matchAll(/"([a-zA-Z]+)"/g)].map(
      (m) => m[1],
    ),
  )

// --- Names the skill uses -------------------------------------------------------------------------------------------
const studioNames = (skill: string) => uniq([...skill.matchAll(/\bstudio_[a-z_]*[a-z]\b/g)].map((m) => m[0]))
/** Every full GEOM_ fit code (the bare "GEOM_" / "GEOM_*" prefix is not a code). */
const geomCodes = (skill: string) => uniq([...skill.matchAll(/\bGEOM_[A-Z]+(?:_[A-Z]+)*\b/g)].map((m) => m[0]))
const NEW_FAIL_CODES = ["GEOM_EDGE_ALONG", "GEOM_EDGE_HEADER", "GEOM_EDGE_DOUBLE_BACK"] as const
/** Check 5 tokens and where each one is registered (exact source forms). */
const TOKEN_SITES: Record<string, (s: Sources) => boolean> = {
  FIGURE_FIT: (s) => /\bFIGURE_FIT\b/.test(s.staticChecks),
  FLOW_SERIALISED: (s) => s.flow.includes('export const FLOW_SERIALISED = "FLOW_SERIALISED";'),
  TERUKUR: (s) => /export const PROVENANCE_MARKS = \[[^\]]*"TERUKUR"[^\]]*\] as const;/.test(s.enums),
  "G-04": (s) => /^\s*"G-04":\s*"/m.test(s.charts),
}
/** Section 3.2 of 01e: the seven tool names the skill names (a new one needs a C-decision and a P5-d re-review). */
const FROZEN_TOOLS = [
  "studio_chapter_import_markdown",
  "studio_chapter_submit",
  "studio_edit",
  "studio_figure_preview",
  "studio_figure_revise",
  "studio_render",
  "studio_write",
]

/** Names in the skill that the sources do not register (in skill order, each once). */
function drift(skill: string, sources: Sources): string[] {
  const vendor = vendorRegistered(sources)
  const host = hostKept(sources)
  const check = checkMap(sources)
  const fail = failKinds(sources)
  const unknown: string[] = []
  for (const name of studioNames(skill)) if (!vendor.has(name) || !host.has(name)) unknown.push(name)
  for (const code of geomCodes(skill)) {
    const kind = check.get(code)
    if (kind === undefined) unknown.push(code)
    else if ((NEW_FAIL_CODES as readonly string[]).includes(code) && !fail.has(kind)) unknown.push(code)
  }
  for (const [token, registered] of Object.entries(TOKEN_SITES))
    if (new RegExp(`(?<![A-Za-z0-9_-])${token}(?![A-Za-z0-9_-])`).test(skill) && !registered(sources)) unknown.push(token)
  return uniq(unknown)
}
const absent = (skill: string, names: readonly string[]) =>
  names.filter((n) => !new RegExp(`(?<![A-Za-z0-9_-])${n}(?![A-Za-z0-9_-])`).test(skill))

describe("AC-P5b diagram-flow skill: every named tool, fit code and token exists in source registration", () => {
  test("sources and skill were read", () => {
    expect(SKILL.length).toBeGreaterThan(0)
    for (const [k, v] of Object.entries(SOURCES)) expect(v.length > 0 ? "" : `empty source: ${k}`).toBe("")
    expect(vendorRegistered(SOURCES).size).toBeGreaterThan(20)
    expect(hostKept(SOURCES).size).toBeGreaterThan(20)
    expect(checkMap(SOURCES).size).toBeGreaterThan(15)
    expect(failKinds(SOURCES).size).toBeGreaterThan(15)
  })

  test("Check 1: every studio_* name in the skill is a vendor tool registration", () => {
    const vendor = vendorRegistered(SOURCES)
    expect(studioNames(SKILL).length).toBeGreaterThan(0)
    expect(studioNames(SKILL).filter((n) => !vendor.has(n))).toEqual([])
  })

  test("Check 2: every studio_* name in the skill is in HOST_KEPT_TOOLS, so the agent sees it through Swarm", () => {
    const host = hostKept(SOURCES)
    expect(studioNames(SKILL).filter((n) => !host.has(n))).toEqual([])
  })

  test("Check 3: studio_figure_preview and studio_figure_revise are named and registered", () => {
    const names = studioNames(SKILL)
    for (const tool of ["studio_figure_preview", "studio_figure_revise"]) {
      expect(names).toContain(tool)
      expect(FIGURE_TOOLS_FILE).toContain(`name: "${tool}",`)
    }
    expect(VENDOR_TOOLS_FILE).toContain("...FIGURE_TOOLS,")
  })

  test("Check 4: every GEOM_ fit code is an exact CHECK value; the three 1.2.9 codes are present and fail FIGURE_FIT", () => {
    expect(absent(SKILL, NEW_FAIL_CODES)).toEqual([])
    const check = checkMap(SOURCES)
    expect(geomCodes(SKILL).filter((c) => !check.has(c))).toEqual([])
    expect(NEW_FAIL_CODES.map((c) => check.get(c))).toEqual(["edgeAlongOutline", "edgeOverHeader", "edgeDoublesBack"])
    const fail = failKinds(SOURCES)
    expect(NEW_FAIL_CODES.filter((c) => !fail.has(check.get(c) ?? ""))).toEqual([])
  })

  test("Check 5: FIGURE_FIT, FLOW_SERIALISED, TERUKUR and G-04 are named and registered", () => {
    expect(absent(SKILL, Object.keys(TOKEN_SITES))).toEqual([])
    expect(Object.entries(TOKEN_SITES).flatMap(([t, ok]) => (ok(SOURCES) ? [] : [t]))).toEqual([])
    expect(drift(SKILL, SOURCES)).toEqual([])
  })

  test("Check 6: the via-rule anchor in the engine is unchanged", () => {
    expect(SPEC_FILE).toContain('const VIA_FAMILIES = "flow tanpa direction, graph, swimlane";')
    expect(SPEC_FILE).toContain('const ranked = fam === "flow" && given(spec, "direction");')
    expect(ROUTE_SHAPE_FILE).toContain(
      'return s.family === "graph" || s.family === "swimlane" || (s.family === "flow" && s.direction === undefined);',
    )
    expect(ROUTE_SHAPE_FILE).toMatch(/export function viaFamily\([^)]*\): boolean \{\n\s*return s\.family === "graph"/)
  })

  test("Check 7: no invented or prefixed tool names", () => {
    expect(SKILL).not.toMatch(/\bstudio_diagram_/)
    expect(SKILL).not.toMatch(/\bstudio_chart_/)
    expect(SKILL).not.toContain("datum-studio_")
  })

  test("Check 8: the tool set is frozen at the seven names of 01e section 3.2", () => {
    expect([...studioNames(SKILL)].sort()).toEqual(FROZEN_TOOLS)
  })

  test("Check 9: drift() goes red when a tool registration or a CHECK value is renamed", () => {
    expect(drift(SKILL, SOURCES)).toEqual([])
    const tool = { ...SOURCES, vendorTools: SOURCES.vendorTools.replaceAll('"studio_figure_revise"', '"studio_figure_revize"') }
    expect(drift(SKILL, tool)).toEqual(["studio_figure_revise"])
    const code = { ...SOURCES, autofit: SOURCES.autofit.replace('"GEOM_EDGE_HEADER"', '"GEOM_EDGE_HEADERS"') }
    expect(drift(SKILL, code)).toEqual(["GEOM_EDGE_HEADER"])
  })

  test("Check 10: a tool renamed in the skill is reported (manual twin: REL1210_P5B_SKILL on a scratch copy)", () => {
    const renamed = SKILL.replaceAll("studio_figure_preview", "studio_figure_previews")
    expect(renamed).not.toBe(SKILL)
    expect(drift(renamed, SOURCES)).toEqual(["studio_figure_previews"])
    expect([...studioNames(renamed)].sort()).not.toEqual(FROZEN_TOOLS)
  })
})
