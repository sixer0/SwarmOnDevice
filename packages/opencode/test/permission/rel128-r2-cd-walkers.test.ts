// Swarm 1.2.8 row 27 (AC-R2 cd half, R-2, N8-312). PROBE ("may be green"): the same `cd X && Y` forms go through the
// table's `cd` walkers (at BASE `autonomy-table.ts:663,1861,2368,2410,2445,2680,2776,2901,4250`; after R-1 in
// `autonomy-parts/`). The walkers are not exported, so the probe compares what they decide through the public verdicts
// that read them: the shell's own reading (`readSteps`, its `cwds`), the read roles' check (`readRoleRefuses`, the read
// class walker), the root's consented verdict (routine, look, app-state and program walkers) and a coder subagent's. For
// every form all of them must land on one side, and the shell's reading must name the folder the shell would. HOME is a
// mkdtemp folder; every file is synthetic.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
  execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
  mkdirSync(path.join(dir, "sub", "deep"), { recursive: true })
  mkdirSync(path.join(dir, "my dir"), { recursive: true })
  for (const name of ["sub/s.md", "sub/deep/s.md", "my dir/s.md"]) writeFileSync(path.join(dir, name), "x\n")
  home = mkdtempSync(path.join(os.tmpdir(), "r2cd-"))
  writeFileSync(path.join(home, "s.md"), "x\n")
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

type Side = "runs" | "held"

async function input(command: string, agent: string | undefined, caller: "root" | "subagent"): Promise<AutonomyTable.Input> {
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, workdir: dir, steps: await readSteps(command, dir) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    agent,
    bypass: { caller },
  }
}

async function side(command: string, agent: string | undefined, caller: "root" | "subagent"): Promise<Side> {
  const call = await input(command, agent, caller)
  if (AutonomyTable.readRoleRefuses(call, instance)) return "held"
  const verdict = AutonomyTable.classify(call)
  if (verdict.class !== "A") return "held"
  if (verdict.bypassed === undefined || caller === "root") return "runs"
  return AutonomyTable.SUBAGENT_RUNS_LIKE_ROOT.has(verdict.bypassed) && !AutonomyTable.subagentSendsAnyway(call) ? "runs" : "held"
}

// Each form with the folder the shell runs the look in; undefined where the shell's folder is not known from the text.
const FORMS: [string, () => string | undefined][] = [
  ["cd sub && cat s.md", () => path.join(dir, "sub")],
  ["cd ./sub && cat s.md", () => path.join(dir, "sub")],
  ["cd sub/deep/.. && cat s.md", () => path.join(dir, "sub")],
  ["cd sub/deep && cat ../s.md", () => path.join(dir, "sub/deep")],
  ['cd "my dir" && cat s.md', () => path.join(dir, "my dir")],
  ["cd 'sub' && cat s.md", () => path.join(dir, "sub")],
  ["cd ~ && cat s.md", () => home],
  ["cd $HOME && cat s.md", () => home],
  ["cd && cat s.md", () => home],
  ["cd - && cat s.md", () => undefined],
  ["pushd sub && cat s.md", () => path.join(dir, "sub")],
]

describe("R-2 cd PROBE: the read-class walker and the table's walkers land a cd form on one side", () => {
  // Subagents only: the root's consented calls go to the main agent, a different rule from the walkers'.
  for (const [command] of FORMS)
    test(command, async () => {
      const found = {
        coder: await side(command, "coder", "subagent"),
        verifier: await side(command, "verifier", "subagent"),
        planner: await side(command, "planner", "subagent"),
        "data-collector": await side(command, "data-collector", "subagent"),
      }
      expect({ command, ...found }).toEqual({ command, verifier: found.coder, planner: found.coder, "data-collector": found.coder, coder: found.coder })
    })
})

describe("R-2 cd PROBE: the shell's reading the table takes names the folder the shell runs in", () => {
  for (const [command, folder] of FORMS)
    test(command, async () => {
      const reading = AutonomyTable.shellReading(await readSteps(command, dir), instance)
      const look = reading?.steps.find((step) => step.argv[0] === "cat")
      // Not taken, or no look in it: nothing names a wrong folder.
      if (look === undefined) return
      const expected = folder()
      expect({ command, cwds: look.cwds }).toEqual({ command, cwds: expected === undefined ? [] : [expected] })
    })
})

describe("R-2 cd PROBE: a write after a folder change is judged where it lands", () => {
  test("`pushd <home> && echo x > s.md` gets the verdict of `cd <home> && echo x > s.md`", async () => {
    const pushd = AutonomyTable.classify(await input(`pushd ${home} && echo x > s.md`, undefined, "root"))
    const cd = AutonomyTable.classify(await input(`cd ${home} && echo x > s.md`, undefined, "root"))
    expect({ pushd: pushd.class }).toEqual({ pushd: cd.class })
  })
})
