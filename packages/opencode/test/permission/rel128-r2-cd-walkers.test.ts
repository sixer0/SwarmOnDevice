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
  // 1.2.8 row 27a (G1-01): the reviewer's probe fixture: a file a shell may read its commands from, a folder under home.
  writeFileSync(path.join(dir, "a.md"), "x\n")
  mkdirSync(path.join(home, "x"))
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

// 1.2.8 row 27a (G1-01 HIGH, C106). Row 27 read a first piece `lookWords` refused by splitting it on spaces, and `cdTarget`
// refused no shell operator, so `cd sub;./run.sh && ls` was read as a move into a folder named `sub;./run.sh` and the line
// became A `protected_read` decided by the gate, for read roles, coder and root, mode on and off. Each verdict below is the
// one BASE e1f9673772 gives (copied from a run of the same calls on a `git archive` of BASE); red at ca5040628d..50f5bdf8b3.
type Expected = Pick<AutonomyTable.Verdict, "class" | "decidedBy" | "category" | "bypassed">
const MAIN_AGENT = (bypassed: AutonomyTable.Verdict["bypassed"]): Expected => ({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed })
const NOT_REVERSIBLE: Expected = { class: "X", decidedBy: "gate", category: "not_reversible", bypassed: "not_routine" }
const NOT_ROUTINE: Expected = { class: "D", decidedBy: "gate", category: "not_routine" }
const FILE_OP: Expected = { class: "A", decidedBy: "gate", category: "file-op" }
// [command, verdict with consent (mode on), verdict without (mode off)]
const SPLIT_OPERANDS: [string, Expected, Expected][] = [
  // The five commands of the gate's probe (gateway_check/01_gate_m1.md G1-01).
  ["cd sub;./run.sh && ls", MAIN_AGENT("not_routine"), NOT_ROUTINE],
  ["cd sub;make && ls", MAIN_AGENT("not_routine"), NOT_ROUTINE],
  ["cd sub;sh<a.md && ls", NOT_REVERSIBLE, NOT_ROUTINE],
  ["cd ~/x;id && ls", MAIN_AGENT("not_routine"), NOT_ROUTINE],
  ["cd sub|sh && ls", NOT_REVERSIBLE, NOT_ROUTINE],
  // The rest of the refused set: `&`, `>`, `(`/`)`, and the home forms the new helper reads followed by an operator.
  ["cd sub&./run.sh && ls", MAIN_AGENT("not_routine"), NOT_ROUTINE],
  ["cd sub>a.md && ls", FILE_OP, FILE_OP],
  ["cd sub(x) && ls", MAIN_AGENT("unreadable_command"), NOT_ROUTINE],
  ["cd sub;touch${IFS}zz && ls", MAIN_AGENT("unreadable_command"), NOT_ROUTINE],
  ["cd $HOME;id && ls", MAIN_AGENT("not_routine"), NOT_ROUTINE],
  ["cd ${HOME}/x;id && ls", MAIN_AGENT("not_routine"), NOT_ROUTINE],
  ["cd $HOME/x|sh && ls", NOT_REVERSIBLE, NOT_ROUTINE],
]
const CALLERS: [string | undefined, "root" | "subagent"][] = [
  [undefined, "root"],
  ["coder", "subagent"],
  ["planner", "subagent"],
]

describe("27a G1-01: a cd operand the shell would split names no folder; every verdict equals BASE", () => {
  for (const [command, on, off] of SPLIT_OPERANDS)
    for (const [agent, caller] of CALLERS)
      for (const mode of ["on", "off"] as const)
        test(`${command} | ${agent ?? "root"} | mode ${mode}`, async () => {
          const call = await input(command, agent, caller)
          if (mode === "off") delete (call as { bypass?: unknown }).bypass
          const verdict = AutonomyTable.classify(call)
          expect({
            command,
            readClass: AutonomyTable.isReadOnlyShell(command, dir, instance),
            roleRefuses: AutonomyTable.readRoleRefuses(call, instance),
            verdict: { class: verdict.class, decidedBy: verdict.decidedBy, category: verdict.category, bypassed: verdict.bypassed },
          }).toEqual({
            command,
            readClass: false,
            roleRefuses: agent === "planner",
            verdict: { decidedBy: undefined, category: undefined, bypassed: undefined, ...(mode === "on" ? on : off) },
          })
        })
})

describe("27a G1-01: the exact home forms keep row 27's read (red at BASE, green at row 27 and after)", () => {
  for (const command of ["cd $HOME && ls", "cd ${HOME}/x && ls"])
    test(command, async () => {
      const call = await input(command, "planner", "subagent")
      expect({ command, readClass: AutonomyTable.isReadOnlyShell(command, dir, instance), roleRefuses: AutonomyTable.readRoleRefuses(call, instance) }).toEqual({
        command,
        readClass: true,
        roleRefuses: false,
      })
    })
})

// 1.2.8 row 27b (G1-12, G1-13, C115). Pins of what the walkers decide today, no verdict change. Per form: the read class,
// whether the planner is refused (root and coder never are), and the verdict with consent (mode on) and without (off).
const OUTSIDE_READ: Expected = { class: "A", decidedBy: "gate", category: "outside_read" }
const PROTECTED_READ: Expected = { class: "A", decidedBy: "gate", category: "protected_read" }
type Pin = [command: string, readClass: boolean, plannerRefused: boolean, on: Expected, off: Expected]

// G1-12: `lookWords` drops quotes, so a quoted `$HOME` or `~` is read as the home folder (the shell moves into a folder
// of that literal name). Every verdict below equals BASE e1f9673772 (the re-review's `rr37a` probe, BASE = HEAD), except
// the last form, marked.
const QUOTED_HOME: Pin[] = [
  ['cd "$HOME";id && ls', false, true, MAIN_AGENT("not_routine"), NOT_ROUTINE],
  ['cd "$HOME" && ls', false, true, OUTSIDE_READ, OUTSIDE_READ],
  ['cd "${HOME}" && ls', false, true, OUTSIDE_READ, OUTSIDE_READ],
  ["cd '$HOME' && ls", true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd '$HOME' && cat s.md", true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd '$HOME' && cat .ssh/id_rsa", true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd '${HOME}'/x && ls", false, true, PROTECTED_READ, PROTECTED_READ],
  ["cd '~' && cat s.md", true, false, PROTECTED_READ, PROTECTED_READ],
  ['cd "~" && ls', true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd '$HOME' && ls ../..", true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd '~' && cat .ssh/id_rsa", true, false, PROTECTED_READ, PROTECTED_READ],
  ['cd "~" && cat .ssh/id_rsa', true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd '$HOME' && cat .env", true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd '$HOME' && cat ../.env", true, false, PROTECTED_READ, PROTECTED_READ],
  // Not BASE: BASE gave read class with the planner allowed. Since row 27 it is not read class and the planner is
  // refused, as for the unquoted `cd $HOME 2>/dev/null && ls` at BASE and HEAD (the stricter side; same verdict).
  ["cd '$HOME' 2>/dev/null && ls", false, true, PROTECTED_READ, PROTECTED_READ],
]

// G1-13: `homeCdWords` reads `cd` only. `pushd $HOME` and `chdir $HOME` name no folder in the read class, so the planner
// is refused them (the stricter side), while `cd $HOME` and `pushd ~` (read by `lookWords`) are reads it may run. These
// are HEAD's verdicts (row 27 and 27a); BASE gave all four D `not_routine` without consent except `cd $HOME && ls`.
const HOME_WALKS: Pin[] = [
  ["pushd $HOME && ls", false, true, OUTSIDE_READ, OUTSIDE_READ],
  ["chdir $HOME && ls", false, true, OUTSIDE_READ, OUTSIDE_READ],
  ["pushd ~ && ls", true, false, PROTECTED_READ, PROTECTED_READ],
  ["cd $HOME && ls", true, false, PROTECTED_READ, PROTECTED_READ],
]

for (const [title, pins] of [
  ["27b G1-12: a quoted home folder is read as home, as at BASE", QUOTED_HOME],
  ["27b G1-13: cd, pushd and chdir to home keep today's verdicts", HOME_WALKS],
] as const)
  describe(title, () => {
    for (const [command, readClass, plannerRefused, on, off] of pins)
      for (const [agent, caller] of CALLERS)
        for (const mode of ["on", "off"] as const)
          test(`${command} | ${agent ?? "root"} | mode ${mode}`, async () => {
            const call = await input(command, agent, caller)
            if (mode === "off") delete (call as { bypass?: unknown }).bypass
            const verdict = AutonomyTable.classify(call)
            expect({
              command,
              readClass: AutonomyTable.isReadOnlyShell(command, dir, instance),
              roleRefuses: AutonomyTable.readRoleRefuses(call, instance),
              verdict: { class: verdict.class, decidedBy: verdict.decidedBy, category: verdict.category, bypassed: verdict.bypassed },
            }).toEqual({
              command,
              readClass,
              roleRefuses: agent === "planner" && plannerRefused,
              verdict: { decidedBy: undefined, category: undefined, bypassed: undefined, ...(mode === "on" ? on : off) },
            })
          })
  })
