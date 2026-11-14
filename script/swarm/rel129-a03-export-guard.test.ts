import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"

// N9-102 (1.2.9 A03). One describe block per AC line (AC-A03.60, .61, .62, .63a, .63b, .63c, .64); each block carries
// its row's regenerated name list inline. Rows 61-63c add their block under lock export-guard (N9-272), row 64 adds
// the guard script (N9-084) and its shrink-only baseline (N9-085). Run from this folder: `bun test ./rel129-a03-export-guard.test.ts`.

const repo = path.resolve(import.meta.dir, "../..")
const self = path.relative(repo, import.meta.path)

/** Lines of `git grep -n -w <name>` over tracked files, this test file excluded (it names the words it looks for). */
function trackedWordHits(name: string): string[] {
  const out = spawnSync("git", ["grep", "-n", "-w", "-e", name, "--", ".", `:(exclude)${self}`], {
    cwd: repo,
    encoding: "utf8",
  })
  // git grep: 0 = matches, 1 = no match, anything else is an error the test must not read as "no match".
  if (out.status !== 0 && out.status !== 1) throw new Error(`git grep failed (${out.status}): ${out.stderr}`)
  return out.stdout.split("\n").filter(Boolean)
}

describe("AC-A03.60", () => {
  // N9-073: exports with no reader anywhere (01b an3: own 0, outProd 0, outTest 0, textOut 0). Removed, not wired:
  // no reader exists and none is in scope (01a AT-A03.60).
  const dead = [
    ["INDEX_ROLLUP_PERIOD", "packages/opencode/src/memory/memory.ts"],
    ["IndexLimits", "packages/schema/src/project-memory.ts"],
    ["existingDefaultProjectDir", "packages/desktop/src/main/onboarding-test-root.ts"],
  ] as const

  for (const [name, file] of dead) {
    test(`${name} (${file}) is gone from every tracked file`, () => {
      expect(trackedWordHits(name)).toEqual([])
    })
  }

  test("INDEX_LIMITS, the value IndexLimits aliased, stays", () => {
    expect(trackedWordHits("INDEX_LIMITS").length).toBeGreaterThan(1)
  })
})

const MARKER = "@internal test seam"

/** Lines of a tracked source file, split on \n. */
function linesOf(file: string): string[] {
  return readFileSync(path.join(repo, file), "utf8").split("\n")
}

/** Lines that start an export declaration (`export const`, `export function`, `export interface`, `export {` ...). */
function exportLines(file: string): string[] {
  return linesOf(file).filter((l) => /^export\b/.test(l))
}

/** Index of the line that declares `name` (with or without `export`), or -1. */
function declLine(file: string, name: string): number {
  const re = new RegExp(`^(export\\s+)?(declare\\s+)?(async\\s+)?(const|let|function|interface|type|class|enum)\\s+${name}\\b`)
  return linesOf(file).findIndex((l) => re.test(l))
}

/** True when the comment lines directly above line `i` (its doc block or a one-line comment) carry the N9-071 marker. */
function carriesMarker(file: string, i: number): boolean {
  const lines = linesOf(file)
  const block: string[] = []
  for (let k = i - 1; k >= 0; k--) {
    const t = lines[k].trim()
    if (!(t.startsWith("/**") || t.startsWith("*") || t.startsWith("//"))) break
    block.push(t)
    if (t.startsWith("/**")) break
  }
  return block.some((t) => t.includes(MARKER))
}

describe("AC-A03.61", () => {
  // N9-102 block .61 (1.2.9 row 61): datum-studio vendor, 24 names in the diagram engine and 7 elsewhere. Un-exported:
  // no file outside the declaring file reads them (rule 3). Test-only exports stay and carry N9-071 (C91).
  const vd = "packages/datum-studio/vendor"
  const dg = `${vd}/src/lib/studio/engine/diagram`
  const unexport: Record<string, readonly string[]> = {
    [`${dg}/build/lanesroute.ts`]: ["RouteRule", "RULE_CLEAR_MM", "RULE_OFFSET_MM"],
    [`${dg}/core/svg.ts`]: [
      "DOUBLED_DIVIDER_CLEAR_MM",
      "shadowUnderlaySvg",
      "shadowRectSvg",
      "doubledDividerY",
      "EdgeHead",
      "EdgeLine",
      "edgeLineWidth",
      "kindHeadType",
      "edgeArrowsOf",
      "edgeLineOf",
      "edgeMarkerId",
      "arrowMarkerSvg",
    ],
    [`${dg}/fit/labels.ts`]: ["pointAtFraction"],
    [`${dg}/fit/lint.ts`]: ["EDGE_OUTSIDE_MIN_MM", "EDGE_END_ON_NODE_MM", "OWN_NODE_END_MM", "LABEL_COLLISION_EPS_MM", "labelCollisions"],
    [`${dg}/fit/text.ts`]: ["labelBelowSizeMm", "subprocessBandMm"],
    [`${dg}/layout-b/swimlane.ts`]: ["SwimBand"],
    [`${vd}/scripts/studio/mcp/write-client.ts`]: ["diagramBlock"],
    [`${vd}/scripts/studio/mcp/write-content.ts`]: ["TableOverflowLikely"],
    [`${vd}/src/lib/studio/contract/schema/v2/refusal-hints.ts`]: ["LANE_ORIENTATION_CLAUSE"],
    [`${vd}/src/lib/studio/contract/types/diagram.ts`]: ["DiagramViaPoint"],
    [`${vd}/src/lib/studio/services/import/markdown.ts`]: ["DIAGRAM_FENCE_INFOS", "DIAGRAM_FENCE_INVALID", "FENCE_KEPT_AS_CODE"],
  }
  // Exported lines per file before row 61 (`^export` lines at HEAD before this row) minus the names above.
  const exportsAfter: Record<string, number> = {
    [`${dg}/build/lanesroute.ts`]: 6,
    [`${dg}/core/svg.ts`]: 46,
    [`${dg}/fit/labels.ts`]: 16,
    [`${dg}/fit/lint.ts`]: 20,
    [`${dg}/fit/text.ts`]: 26,
    [`${dg}/layout-b/swimlane.ts`]: 6,
    [`${vd}/scripts/studio/mcp/write-client.ts`]: 31,
    [`${vd}/scripts/studio/mcp/write-content.ts`]: 35,
    [`${vd}/src/lib/studio/contract/schema/v2/refusal-hints.ts`]: 12,
    [`${vd}/src/lib/studio/contract/types/diagram.ts`]: 7,
    [`${vd}/src/lib/studio/services/import/markdown.ts`]: 7,
  }
  // Test-only exports kept (D list of 60_a03_list.md, plus the 1.2.9 seams of C91); each carries the marker.
  const seams: Record<string, readonly string[]> = {
    [`${dg}/build/svg.ts`]: ["jumpHops"],
    [`${dg}/build/fitlabels.ts`]: ["ZONE_CLEAR_MM"],
    [`${dg}/core/svg.ts`]: ["TAG_INSET_MM", "tagAnchor", "headTrimMm"],
    [`${dg}/core/tokens.ts`]: ["LINE_STYLE_MAX", "LINE_STYLE_MAX_WITH_MARK", "PHASES_MAX", "POOLS_MAX", "VIA_MAX", "ARROW_HEAD_MIN_MM"],
    [`${dg}/fit/lint.ts`]: ["FRAME_OUTSIDE_MIN_MM", "EDGE_ALONG_MIN_MM", "EDGE_ALONG_TOL_MM", "HEADER_CLEAR_MM"],
    [`${vd}/scripts/studio/mcp/write-content.ts`]: ["tableOverflowLikely"],
  }

  test("the list names 31 names in 11 files", () => {
    expect(Object.keys(unexport).length).toBe(11)
    expect(Object.values(unexport).reduce((n, names) => n + names.length, 0)).toBe(31)
  })

  for (const [file, names] of Object.entries(unexport)) {
    for (const name of names) {
      test(`${name} is file-local in ${path.basename(file)}`, () => {
        const i = declLine(file, name)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(linesOf(file)[i]).not.toMatch(/^export\b/)
      })
    }
  }

  for (const [file, count] of Object.entries(exportsAfter)) {
    test(`${path.basename(file)} keeps ${count} export lines`, () => {
      expect(exportLines(file).length).toBe(count)
    })
  }

  for (const [file, names] of Object.entries(seams)) {
    for (const name of names) {
      test(`${name} stays exported in ${path.basename(file)} and carries ${MARKER}`, () => {
        const i = declLine(file, name)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(linesOf(file)[i]).toMatch(/^export\b/)
        expect(carriesMarker(file, i)).toBe(true)
      })
    }
  }
})

describe("AC-A03.62", () => {
  // N9-102 block .62 (1.2.9 row 62): opencode, 34 names of 01b/60_a03_list.md un-exported plus the three C91 names of
  // instance-store.ts (no outside reader, tests only name LOCATION_NOT_FOLDER as a string). DIAGRAM_FLOW_SKILL_NAME,
  // _CONTENT and _TRIGGERS stay: test/g04-agent-guide/rel128-vis10-guide.test.ts pins their `export const` source text.
  const oc = "packages/opencode/src"
  const hp = `${oc}/server/routes/instance/httpapi`
  const unexport: Record<string, readonly string[]> = {
    [`${oc}/memory/memory.ts`]: ["indexRefusal"],
    [`${oc}/memory/vault-mirror.ts`]: ["NoteKind", "ReportSource", "RenderedFile", "reportPath", "MirrorJob"],
    [`${oc}/permission/autonomy-parts/types.ts`]: ["OwnApiReadCategory"],
    [`${oc}/project/rehome.ts`]: ["StepName", "Refused", "JournalState", "JournalStep"],
    [`${oc}/project/instance-store.ts`]: ["LOCATION_NOT_FOLDER", "LOCATION_NOT_FOLDER_MESSAGE", "LocationNotFolderError"],
    [`${hp}/groups/project.ts`]: ["RehomePath", "RehomeCodes"],
    [`${hp}/groups/skill.ts`]: ["SkillPaths", "SkillSavePayload", "SkillDraftApprovePayload"],
    [`${hp}/handlers/project.ts`]: ["rehomePorts"],
    [`${oc}/skill/index.ts`]: [
      "SKILL_AUTHORING_SKILL_NAME",
      "SKILL_AUTHORING_SKILL_CONTENT",
      "SKILL_AUTHORING_SKILL_TRIGGERS",
      "OBSIDIAN_MEMORY_SKILL_NAME",
      "OBSIDIAN_MEMORY_SKILL_DESCRIPTION",
      "OBSIDIAN_MEMORY_SKILL_CONTENT",
      "PROJECT_FOLDERS_SKILL_NAME",
      "PROJECT_FOLDERS_SKILL_DESCRIPTION",
      "PROJECT_FOLDERS_SKILL_CONTENT",
      "SWARM_WHATS_NEW_SKILL_NAME",
      "SWARM_WHATS_NEW_SKILL_CONTENT",
      "SWARM_WHATS_NEW_SKILL_TRIGGERS",
      "TRIGGER_LIMITS",
    ],
    [`${oc}/skill/manage.ts`]: ["APPROVALS_FILE", "Checked"],
    [`${oc}/tool/skill_draft.ts`]: ["SKILL_DRAFTS_FULL", "DraftRecord"],
  }
  // `^export` lines per file after the sweep (the count before row 62 minus the names above).
  const exportsAfter: Record<string, number> = {
    [`${oc}/memory/memory.ts`]: 27,
    [`${oc}/memory/vault-mirror.ts`]: 30,
    [`${oc}/permission/autonomy-parts/types.ts`]: 16,
    [`${oc}/project/rehome.ts`]: 17,
    [`${oc}/project/instance-store.ts`]: 7,
    [`${hp}/groups/project.ts`]: 4,
    [`${hp}/groups/skill.ts`]: 10,
    [`${hp}/handlers/project.ts`]: 5,
    [`${oc}/skill/index.ts`]: 50,
    [`${oc}/skill/manage.ts`]: 38,
    [`${oc}/tool/skill_draft.ts`]: 3,
  }
  // Test-only exports kept (D list of 60_a03_list.md, the Reach seams N9-072, the three DIAGRAM_FLOW names above and the
  // 1.2.9 seams TerminalScan, runningTerminalCwds, setRehomeDecisionForTests, resetForTests); each carries the marker.
  const seams: Record<string, readonly string[]> = {
    [`${oc}/mcp/catalog.ts`]: ["PERSON_ONLY_MCP_TOOLS"],
    [`${oc}/memory/learn.ts`]: ["INDEX_LOAD_BUDGET_TOKENS", "INDEX_EXPAND_MAX"],
    [`${oc}/memory/vault-mirror.ts`]: [
      "MIRROR_REPORT_MAX_BYTES",
      "VAULT_NOTE_NAME_PATTERN",
      "MIRROR_PLAIN_FENCE_LANGS",
      "MIRROR_CLASSIFIED_WORDS",
      "RenderInput",
      "noteName",
      "neutraliseReport",
      "readReport",
      "bodyHash",
      "SyncStage",
      "SyncIO",
      "SyncInput",
      "SyncResult",
      "MIRROR_DEBOUNCE_MS",
      "onRun",
      "hubState",
    ],
    [`${oc}/permission/autonomy-parts/own-api.ts`]: ["OWN_API_READ_ROUTES"],
    [`${oc}/permission/autonomy-texts.ts`]: ["OWN_API_AUTO_APPROVE_RUN_TEXT"],
    [`${oc}/project/rehome.ts`]: ["Journal"],
    [`${oc}/session/system.ts`]: ["SkillFocus", "suggestedSkills"],
    [`${oc}/skill/index.ts`]: [
      "SKILL_AUTHORING_SKILL_DESCRIPTION",
      "DIAGRAM_FLOW_SKILL_NAME",
      "DIAGRAM_FLOW_SKILL_DESCRIPTION",
      "DIAGRAM_FLOW_SKILL_CONTENT",
      "DIAGRAM_FLOW_SKILL_TRIGGERS",
      "SWARM_WHATS_NEW_SKILL_DESCRIPTION",
      "SKILL_HASH_MAX_BYTES",
    ],
    [`${oc}/tool/reach.ts`]: ["forgetSkillFolders", "rememberSkillFolders", "skillFolder"],
    [`${oc}/tool/remember.ts`]: ["UNTRUSTED_TASK_DEPTH"],
    [`${oc}/tool/secrets.ts`]: ["resetForTests"],
    [`${hp}/handlers/project.ts`]: ["TerminalScan", "runningTerminalCwds", "setRehomeDecisionForTests"],
  }

  test("the list names 37 names in 11 files; 39 seams in 12 files", () => {
    expect(Object.keys(unexport).length).toBe(11)
    expect(Object.values(unexport).reduce((n, names) => n + names.length, 0)).toBe(37)
    expect(Object.keys(seams).length).toBe(12)
    expect(Object.values(seams).reduce((n, names) => n + names.length, 0)).toBe(39)
  })

  for (const [file, names] of Object.entries(unexport)) {
    for (const name of names) {
      test(`${name} is file-local in ${path.basename(file)}`, () => {
        const i = declLine(file, name)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(linesOf(file)[i]).not.toMatch(/^export\b/)
      })
    }
  }

  for (const [file, count] of Object.entries(exportsAfter)) {
    test(`${path.basename(file)} keeps ${count} export lines`, () => {
      expect(exportLines(file).length).toBe(count)
    })
  }

  for (const [file, names] of Object.entries(seams)) {
    for (const name of names) {
      test(`${name} stays exported in ${path.basename(file)} and carries the test-seam marker`, () => {
        const i = declLine(file, name)
        expect(i).toBeGreaterThanOrEqual(0)
        expect(linesOf(file)[i]).toMatch(/^export\b/)
        expect(carriesMarker(file, i)).toBe(true)
      })
    }
  }
})
