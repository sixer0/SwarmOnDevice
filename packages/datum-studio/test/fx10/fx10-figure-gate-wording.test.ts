// Swarm 1.2.6 fix row FX-10 (gate 04 findings F6, F7, F8, F9, F12; decisions C19a, C19b).
// F6/C19a: the six texts that name the figure gate say one rule, word for word: the machine gate is the INLINE
// preview (standalone is not the gate), and a figure is done only after the machine gate AND an eye check of the
// rendered PNG. Before FX-10 three of them said "the gate is the inline preview" and three "the preview alone is not
// the gate". F7/C19b: the diagram resource quotes the engine's label hints (~20 / ~40), not 18 / 32. F9: the
// resource's defect definition is the preview classification. F8: the caption refusal is SCHEMA_INVALID with checkId
// CAPTION_TOKEN_DUPLICATE. F12: the status line can carry STALE. Red before FX-10 (pre-fix HEAD), green after.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { diagramGuideText } from "../../src/mcp-host/diagram-guide.ts"
import { PREVIEW_ISSUE_CLASS } from "../../src/mcp-host/local-api/routes/figure-preview-figure.ts"
import { MCP_DOC_RECIPE } from "../../vendor/scripts/studio/mcp/resources"

const DS = path.join(import.meta.dir, "..", "..")
const read = (...p: string[]) => readFileSync(path.join(...p), "utf8")
const flat = (s: string) => s.replace(/\s+/g, " ")
const count = (text: string, s: string) => text.split(s).length - 1

const GATE_ID =
  "Gerbang figur: gerbang mesin = pratinjau inline (pratinjau mandiri bukan gerbang); figur selesai hanya setelah gerbang mesin DAN gerbang mata atas PNG hasil render."
const GATE_EN =
  "Figure gate: machine gate = the inline preview (the standalone preview is not the gate); a figure is done only after the machine gate AND an eye check of the rendered PNG."

const DIAGRAM = diagramGuideText()
const RECIPE = flat(MCP_DOC_RECIPE)
const GUIDE = flat(read(DS, "vendor", "docs", "STUDIO-AGENT-GUIDE.md"))
const WORKFLOW = flat(read(DS, "..", "opencode", "src", "skill", "swarm-workflow.md"))
const FIGURE_TOOLS = read(DS, "vendor", "scripts", "studio", "mcp", "figure-tools.ts")
const PREVIEW_DESC = /name: "studio_figure_preview",\s*description:\s*"((?:[^"\\]|\\.)*)"/.exec(FIGURE_TOOLS)?.[1] ?? ""

describe("FX-10 F6 / C19a: one figure-gate rule in all six texts", () => {
  test("diagram resource (EN) and swarm-workflow (EN) carry the rule once", () => {
    expect(count(flat(DIAGRAM), GATE_EN)).toBe(1)
    expect(count(WORKFLOW, GATE_EN)).toBe(1)
  })

  test("studio_figure_preview description, dokumen-klien recipe (ID) carry the rule once", () => {
    expect(count(PREVIEW_DESC, GATE_ID)).toBe(1)
    expect(count(RECIPE, GATE_ID)).toBe(1)
  })

  test("agent guide carries it in section 4.1.2 step 5 and section 8.4 (twice, nowhere else)", () => {
    expect(count(GUIDE, GATE_ID)).toBe(2)
    const s412 = GUIDE.indexOf("#### 4.1.2 "), s42 = GUIDE.indexOf("### 4.2 "), s84 = GUIDE.indexOf("### 8.4 "), s85 = GUIDE.indexOf("### 8.5 ")
    const first = GUIDE.indexOf(GATE_ID), second = GUIDE.indexOf(GATE_ID, first + 1)
    expect(first > s412 && first < s42).toBe(true)
    expect(second > s84 && second < s85).toBe(true)
  })

  test("none of the six keeps a contradicting gate phrase", () => {
    const all = [flat(DIAGRAM), WORKFLOW, PREVIEW_DESC, RECIPE, GUIDE].join("\n")
    for (const bad of [
      "Gerbang = pratinjau inline",
      "gerbangnya pratinjau inline",
      "gerbang figur tetap pratinjau inline",
      "the preview alone is not the gate",
      "a clean preview alone is not the gate",
      "Pratinjau bersih saja bukan gerbang",
    ])
      expect(all).not.toContain(bad)
  })
})

describe("FX-10 F7 / C19b: label limits follow the engine hints", () => {
  const AUTOFIT = read(DS, "vendor", "src", "lib", "studio", "engine", "diagram", "build", "autofit.ts")
  const FITLABELS = read(DS, "vendor", "src", "lib", "studio", "engine", "diagram", "build", "fitlabels.ts")
  const edge = new Set([...(AUTOFIT + FITLABELS).matchAll(/label tepi \(maks ~(\d+) karakter\)/g)].map((m) => m[1]))
  const node = new Set([...AUTOFIT.matchAll(/label simpul \(maks ~(\d+) karakter\)/g)].map((m) => m[1]))

  test("the engine hints agree on one edge and one node number", () => {
    expect([...edge]).toEqual(["20"])
    expect([...node]).toEqual(["40"])
  })

  test("diagram resource quotes them; 18 / 32 are gone", () => {
    expect(count(DIAGRAM, `edge label at most ~${[...edge][0]} characters, node label at most ~${[...node][0]}; a second detail goes in \`sub\``)).toBe(1)
    expect(DIAGRAM).not.toMatch(/at most 18\b|at most 32\b/)
  })
})

describe("FX-10 F9: the resource's defect definition is the preview classification", () => {
  test("every code classed as a defect, plus any FAIL and GEOM_*, is named", () => {
    const line = DIAGRAM.split("\n").find((l) => l.includes("must reach zero")) ?? ""
    expect(line).toContain("Defects (figure.defects: any FAIL, GEOM_*, ")
    const defects = Object.entries(PREVIEW_ISSUE_CLASS).filter(([, c]) => c === "defect").map(([k]) => k)
    expect(defects.length).toBeGreaterThan(0)
    for (const code of defects) expect(line).toContain(code)
  })

  test("the resource stays compact", () => {
    expect(Buffer.byteLength(DIAGRAM)).toBeLessThan(3000)
  })
})

describe("FX-10 F8: the caption refusal names SCHEMA_INVALID and its checkId", () => {
  const RX = /400 `?SCHEMA_INVALID`? \(`?checkId`?:? `?"?CAPTION_TOKEN_DUPLICATE"?`?\)/
  test("agent guide section 4.1.2 and the dokumen-klien recipe", () => {
    const s412 = GUIDE.slice(GUIDE.indexOf("#### 4.1.2 "), GUIDE.indexOf("### 4.2 "))
    expect(s412).toMatch(RX)
    expect(RECIPE).toMatch(RX)
  })
})

describe("FX-10 F12: the stored verdict line can carry STALE", () => {
  test("agent guide section 8.3 names `RENDER_UNVERIFIED(U24) STALE` as the doc-tools status prints it", () => {
    const DOC_TOOLS = read(DS, "vendor", "scripts", "studio", "mcp", "doc-tools.ts")
    expect(DOC_TOOLS).toContain('`RENDER_UNVERIFIED(U24)${v.reason === "STALE" ? " STALE" : ""} fail=')
    const s83 = GUIDE.slice(GUIDE.indexOf("### 8.3 "), GUIDE.indexOf("### 8.4 "))
    expect(s83).toContain("`RENDER_UNVERIFIED(U24) STALE fail=… unknown=…`")
  })
})
