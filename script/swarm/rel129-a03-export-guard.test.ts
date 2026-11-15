import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
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
  // 1.2.10 row 75 (B10-12a): the per-file `^export` line counts that stood here pinned the total, so a new legitimate
  // export failed them. What they meant lives in the per-name file-local tests below and in block AC-A03.64.
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
  // 1.2.10 row 75 (B10-12a): the per-file `^export` line counts were dropped (see block AC-A03.61); the un-exported names
  // stay un-exported through the tests below, and every new export needs a reader or the marker (block AC-A03.64).
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

/**
 * Rows 63a-63c (AC-A03.63a/b/c): the declaration of `name` in `rel` (repo-relative) and the lines above it. A file that
 * does not declare the name exactly once is a failure of the list, not an empty answer.
 */
async function a03SweepDecl(rel: string, name: string): Promise<{ line: string; above: string[]; text: string }> {
  const text = await Bun.file(path.join(repo, rel)).text()
  const lines = text.split("\n")
  const re = new RegExp(`^(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?(?:const|let|function|class|interface|type|enum)\\s+${name}\\b`)
  const at = lines.flatMap((l, i) => (re.test(l) ? [i] : []))
  if (at.length !== 1) throw new Error(`${rel}: ${name} is declared ${at.length} times, expected 1`)
  return { line: lines[at[0]], above: lines.slice(0, at[0]), text }
}

/** True when `name` leaves `rel` through an `export { ... }` list (a way round the keyword). */
function a03SweepListed(text: string, name: string): boolean {
  return new RegExp(`export\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b`).test(text)
}

/** N9-071 in either form (C91 OP-60-3): the exact line directly above the declaration, or the tag inside the doc block directly above. */
function a03SweepMarked(above: string[]): boolean {
  let i = above.length - 1
  if (i < 0 || !above[i].trim().endsWith("*/")) return false
  const block = [above[i]]
  while (i > 0 && !above[i].trim().startsWith("/**")) block.unshift(above[--i])
  return block.some((l) => l.includes("@internal test seam"))
}

/** The sweep rows' two checks: the B names are no longer exported, the D seams are exported and marked. */
function a03SweepCases(keep: ReadonlyArray<readonly [string, readonly string[]]>, seams: ReadonlyArray<readonly [string, readonly string[]]>) {
  for (const [file, names] of keep)
    for (const name of names)
      test(`${name} (${file}) is file-local: declared once, no export keyword, not in an export list`, async () => {
        const d = await a03SweepDecl(file, name)
        expect(d.line.startsWith("export")).toBe(false)
        expect(a03SweepListed(d.text, name)).toBe(false)
      })
  for (const [file, names] of seams)
    for (const name of names)
      test(`${name} (${file}) stays exported and carries N9-071`, async () => {
        const d = await a03SweepDecl(file, name)
        expect(d.line.startsWith("export")).toBe(true)
        expect(a03SweepMarked(d.above)).toBe(true)
      })
}

describe("AC-A03.63a", () => {
  // Row 63a: datum-studio host (packages/datum-studio outside vendor/). 10 names with no outside reader lose `export`;
  // 4 test seams (a test reader, no production reader) stay exported and carry N9-071. List: implementation/60_a03_list.md.
  a03SweepCases(
    [
      ["packages/datum-studio/src/mcp-host/figure-quota.ts", ["FIGURE_QUOTA_PARAM", "FIGURE_QUOTA_TOOLS", "FigureQuota", "FigureQuotaReader", "FigureQuotaOptions"]],
      ["packages/datum-studio/src/mcp-host/mission/mission-tools.ts", ["MEMORY_INDEX_UNCHECKED_TEXT", "groupMarkerOk"]],
      ["packages/datum-studio/src/mcp-host/tool-table.ts", ["memoryIndexOf"]],
      ["packages/datum-studio/src/store/mission/types.ts", ["DecisionTopic", "TidyProposalItem"]],
    ],
    [
      ["packages/datum-studio/src/mcp-host/figure-quota.ts", ["figureQuotaOf", "figureQuotaLine", "readFigureQuota"]],
      ["packages/datum-studio/src/mcp-host/http-server.ts", ["missionControlKeyOk"]],
    ],
  )
})

describe("AC-A03.63b", () => {
  // Row 63b: desktop. 17 names with no outside reader lose `export`; 7 test seams stay exported and carry N9-071.
  a03SweepCases(
    [
      ["packages/desktop/src/main/datum-studio-host/mission-ipc.ts", ["REHOME_PATH", "REHOME_TIMEOUT_MS", "PLACE_OPTIONS", "RehomeBody", "RehomeOk", "RehomeResult", "PlaceFailure", "PlaceOptions", "placeMission"]],
      ["packages/desktop/src/main/external-url.ts", ["OPEN_OBSIDIAN_NOTE_IPC", "ObsidianNoteResult", "StagedObsidianApp", "resolveStagedObsidianApp", "ExecFileOutput", "verifyStagedObsidianSignature", "ObsidianNoteIpcDeps"]],
      ["packages/desktop/src/main/sidecar-env.ts", ["DEFAULT_PROJECT_DIR_KEY"]],
    ],
    [
      ["packages/desktop/src/main/datum-studio-host/mission-ipc.ts", ["TIDY_BATCH_MAX"]],
      ["packages/desktop/src/main/external-url.ts", ["resolveObsidianNoteURL", "OBSIDIAN_TEAM_ID"]],
      ["packages/desktop/src/main/onboarding.ts", ["defaultProjectPath"]],
      ["packages/desktop/src/main/proxy-bypass.ts", ["LOOPBACK_PROXY_BYPASS", "loopbackProxyBypassList"]],
      ["packages/desktop/src/main/sidecar-env.ts", ["launchDefaultProjectDir"]],
    ],
  )

  // C24: the mission client sends the key on every request since row 50a; the protocol comment no longer says "at initialize".
  test("protocol.ts describes the Mission Control key as sent on every request, not at initialize", async () => {
    const text = await Bun.file(path.join(repo, "packages/desktop/src/main/datum-studio-host/protocol.ts")).text()
    expect(text).not.toContain("at initialize")
    expect(text).toContain("on every request")
  })
})

describe("AC-A03.63c", () => {
  // Row 63c: app. 12 names with no outside reader lose `export` (10 from the list, plus Plural and MissionFileEntry,
  // added by 1.2.9 rows with no outside reader, C91 OP-60-1); 4 test seams stay exported and carry N9-071 (the 3 of the list
  // and `deliverablesDir`, 1.2.9 row 56).
  a03SweepCases(
    [
      ["packages/app/src/components/settings-skills.tsx", ["SkillScope", "SkillRow", "SkillDraftRow", "skillErrorCode", "useSettingsDirectory"]],
      ["packages/app/src/context/project-rehomed.ts", ["REHOMED_SESSION_KEYS", "moveRehomedSessionState"]],
      ["packages/app/src/pages/session/swarm/mission-command-model.ts", ["TidyLineView", "tidyCount", "DecisionOptionView", "Plural"]],
      ["packages/app/src/pages/session/swarm/mission-poll.ts", ["MissionFileEntry"]],
    ],
    [
      ["packages/app/src/context/project-rehomed.ts", ["projectRehomedPayload"]],
      ["packages/app/src/pages/home/home-controller.ts", ["addCheckedProjectFolders"]],
      ["packages/app/src/pages/session/swarm/mission-command-model.ts", ["moveErrorText"]],
      ["packages/app/src/pages/session/swarm/mission-poll.ts", ["deliverablesDir"]],
    ],
  )
})

describe("AC-A03.64", () => {
  // Row 64: the guard N9-084 (check-exports.ts) with its shrink-only baseline N9-085 (check-exports.baseline.json).
  // An export without a production reader outside its file is explained by the N9-071 marker (either form, C91
  // OP-60-3), by a baseline entry, or by living in the generated SDK (C10(g)). Shrink-only (01a AT-A03.64):
  // (1) a stale entry fails; (2) the entry count is pinned below; (3) every entry was exported at 1.2.9 BASE, so a new
  // 1.2.9 export can never be parked in the baseline. Raising BASELINE_MAX needs a C-decision.
  // Row 74a (C104, review F1): browser harnesses (test-browser/, *.render.*, *.fixture.*) now read as tests, which
  // admits 21 older names exported at BASE and drops 2 stale fixture entries: 4433 - 2 + 21 = 4452.
  const BASELINE_MAX = 4452
  const BASE = "d4282fcfd8"
  // Row 25 split route.ts (C31): names exported by the two new files were exported by route.ts at BASE.
  const route = "packages/datum-studio/vendor/src/lib/studio/engine/diagram/build"
  const MOVED: Record<string, string> = {
    [`${route}/route-ends.ts`]: `${route}/route.ts`,
    [`${route}/route-shape.ts`]: `${route}/route.ts`,
  }
  const GEN = /^packages\/sdk\/js\/src\/v2\/gen\//
  // Mutation target: a name row 61 un-exported (block AC-A03.61).
  const mutFile = "packages/datum-studio/vendor/src/lib/studio/engine/diagram/fit/text.ts"
  const mutDecl = "function subprocessBandMm(): number {"

  type Guard = typeof import("./check-exports")
  let loaded: Promise<Guard> | undefined
  // Dynamic import: at BASE the script is absent, so this block fails on import and the other blocks still run.
  const guard = () => (loaded ??= import("./check-exports"))
  let first: ReturnType<Guard["checkExports"]> | undefined
  const run = async () => {
    const g = await guard()
    first ??= g.checkExports({ repo, baseline: g.loadBaseline(repo) })
    return first
  }

  /** `git cat-file --batch` of `<rev>:<file>` for each file; null when the file does not exist at that revision. */
  function showAll(rev: string, files: readonly string[]): Map<string, string | null> {
    const out = spawnSync("git", ["cat-file", "--batch"], {
      cwd: repo,
      input: files.map((f) => `${rev}:${f}\n`).join(""),
      maxBuffer: 1 << 30,
    })
    if (out.status !== 0) throw new Error(`git cat-file failed (${out.status}): ${out.stderr}`)
    const buf = out.stdout as Buffer
    const res = new Map<string, string | null>()
    let at = 0
    for (const f of files) {
      const nl = buf.indexOf(10, at)
      const header = buf.subarray(at, nl).toString("utf8")
      at = nl + 1
      if (header.endsWith(" missing")) {
        res.set(f, null)
        continue
      }
      const size = Number(header.split(" ")[2])
      res.set(f, buf.subarray(at, at + size).toString("utf8"))
      at += size + 1
    }
    return res
  }

  test("0 unexplained exports at HEAD", async () => {
    const r = await run()
    expect(r.files).toBeGreaterThan(5000)
    expect(r.unexplained.map((u) => `${u.file}:${u.line} ${u.name}`)).toEqual([])
  }, 120_000)

  test("shrink-only (1): no stale baseline entry", async () => {
    const r = await run()
    expect(r.stale.map((s) => `${s.file} ${s.name}`)).toEqual([])
    expect(r.explainedByBaseline).toBe((await guard()).loadBaseline(repo).length)
  }, 120_000)

  test(`shrink-only (2): at most ${BASELINE_MAX} entries, sorted, no duplicate`, async () => {
    const entries = (await guard()).loadBaseline(repo)
    expect(entries.length).toBeLessThanOrEqual(BASELINE_MAX)
    const keys = entries.map((e) => `${e.file}\0${e.name}`)
    expect(new Set(keys).size).toBe(keys.length)
    const sorted = [...entries].sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )
    expect(entries).toEqual(sorted)
  })

  test(`shrink-only (3): every entry was exported at BASE ${BASE} (no 1.2.9 name in the baseline)`, async () => {
    const g = await guard()
    const entries = g.loadBaseline(repo)
    const files = [...new Set(entries.flatMap((e) => (MOVED[e.file] ? [e.file, MOVED[e.file]] : [e.file])))]
    const src = showAll(BASE, files)
    const names = new Map<string, Set<string>>()
    const at = (f: string) => {
      if (!names.has(f)) {
        const s = src.get(f)
        names.set(f, s == null ? new Set() : g.exportedNames(f, s))
      }
      return names.get(f)!
    }
    const fresh = entries.filter((e) => !at(e.file).has(e.name) && !(MOVED[e.file] && at(MOVED[e.file]).has(e.name)))
    expect(fresh.map((e) => `${e.file} ${e.name}`)).toEqual([])
  }, 120_000)

  test("the generated SDK is excluded, never baselined", async () => {
    const r = await run()
    expect(r.explainedByGenerated).toBeGreaterThan(0)
    expect((await guard()).loadBaseline(repo).filter((e) => GEN.test(e.file))).toEqual([])
    expect(r.unexplained.filter((u) => GEN.test(u.file))).toEqual([])
  }, 120_000)

  test("C91 OP-60-2: setup CLASSIFIED_WORDS and classificationWord carry the marker (one per form)", () => {
    const file = "packages/setup/src/vault/classified.ts"
    const lines = linesOf(file)
    const words = declLine(file, "CLASSIFIED_WORDS")
    expect(lines[words - 1].trim()).toBe(`/** ${MARKER} */`)
    const word = declLine(file, "classificationWord")
    expect(lines[word - 1].trim()).not.toBe(`/** ${MARKER} */`)
    expect(carriesMarker(file, word)).toBe(true)
  })

  test("mutation: re-adding one export that row 61 removed turns the guard red; the marker explains it again", async () => {
    const g = await guard()
    const baseline = g.loadBaseline(repo)
    const original = readFileSync(path.join(repo, mutFile), "utf8")
    expect(original.split("\n").filter((l) => l === mutDecl).length).toBe(1)
    const dir = mkdtempSync(path.join(os.tmpdir(), "a03-64-"))
    try {
      const copy = path.join(dir, "text.ts")
      writeFileSync(copy, original.replace(`\n${mutDecl}`, `\nexport ${mutDecl}`))
      const red = g.checkExports({ repo, baseline, replace: { [mutFile]: copy } })
      expect(red.unexplained.map((u) => `${u.file} ${u.name}`)).toEqual([`${mutFile} subprocessBandMm`])
      writeFileSync(copy, original.replace(`\n${mutDecl}`, `\n/**\n * Mutation.\n * ${MARKER}\n */\nexport ${mutDecl}`))
      const marked = g.checkExports({ repo, baseline, replace: { [mutFile]: copy } })
      expect(marked.unexplained).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // The working tree was never edited.
    expect(readFileSync(path.join(repo, mutFile), "utf8")).toBe(original)
  }, 120_000)

  test("row 75 (B10-12a): a new marked export in vault-mirror.ts is explained; a new unmarked one with no reader is unexplained", async () => {
    // Replaces the `keeps N export lines` pins: a legitimate new export must not fail, an unexplained one must.
    const file = "packages/opencode/src/memory/vault-mirror.ts"
    const g = await guard()
    const baseline = g.loadBaseline(repo)
    const original = readFileSync(path.join(repo, file), "utf8")
    const marked = ["row75Marked", "Probe"].join("")
    const bare = ["row75Unmarked", "Probe"].join("")
    expect(trackedWordHits(marked)).toEqual([])
    expect(trackedWordHits(bare)).toEqual([])
    const dir = mkdtempSync(path.join(os.tmpdir(), "a03-75-"))
    try {
      const copy = path.join(dir, "vault-mirror.ts")
      writeFileSync(copy, `${original}\n/**\n * Row 75 probe.\n * ${MARKER}\n */\nexport const ${marked} = 1\n`)
      const ok = g.checkExports({ repo, baseline, replace: { [file]: copy } })
      expect(ok.unexplained).toEqual([])
      writeFileSync(copy, `${original}\n/** Row 75 probe, no marker. */\nexport const ${bare} = 1\n`)
      const red = g.checkExports({ repo, baseline, replace: { [file]: copy } })
      expect(red.unexplained.map((u) => `${u.file} ${u.name}`)).toEqual([`${file} ${bare}`])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(readFileSync(path.join(repo, file), "utf8")).toBe(original)
  }, 120_000)

  test("mutation (row 74a, F1): a reader in a browser render harness does not explain an export; the marker does", async () => {
    // missionFilesScroll (1.2.9 row 57) is read outside its file only by a test-browser *.render.ts harness.
    const file = "packages/app/src/pages/session/swarm/mission-control.tsx"
    const name = "missionFilesScroll"
    const outside = [...new Set(trackedWordHits(name).map((h) => h.split(":")[0]))].filter((f) => f !== file)
    expect(outside.length).toBeGreaterThan(0)
    expect(outside.filter((f) => !/(^|\/)test-browser\/|\.render\.[a-z]+$/.test(f))).toEqual([])
    const g = await guard()
    const baseline = g.loadBaseline(repo)
    const original = readFileSync(path.join(repo, file), "utf8")
    const dir = mkdtempSync(path.join(os.tmpdir(), "a03-74a-"))
    try {
      // Copy without any N9-071 marker line (either form): the render harness alone must leave the export unexplained.
      const copy = path.join(dir, "mission-control.tsx")
      const bare = original
        .split("\n")
        .filter((l) => l.trim() !== `* ${MARKER}` && l.trim() !== `/** ${MARKER} */`)
        .join("\n")
      writeFileSync(copy, bare)
      const red = g.checkExports({ repo, baseline, replace: { [file]: copy } })
      const hit = red.unexplained.filter((u) => u.name === name)
      expect(hit.map((u) => `${u.file} ${u.name}`)).toEqual([`${file} ${name}`])
      expect(hit[0].testReaders).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // At HEAD the export carries the marker, and the working tree was never edited.
    expect(carriesMarker(file, declLine(file, name))).toBe(true)
    expect(readFileSync(path.join(repo, file), "utf8")).toBe(original)
  }, 120_000)
})
