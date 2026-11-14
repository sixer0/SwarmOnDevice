// Swarm 1.2.8 row 27 (AC-HU4b, H-U4b, N8-314): one verdict per documented read command across the roles. Under the
// person's consent each read command lands on the same side ("runs" = class A or P that runs, versus "held/refused") for
// `planner`, `data-collector`, `verifier` and `coder`. Writes, redirects, `find -delete` and git that changes the repository
// keep their per-role verdicts. Pure: the gate's role check (`readRoleRefuses`), the table (`classify`) and the subagent
// overlay rule (`SUBAGENT_RUNS_LIKE_ROOT` less `subagentSendsAnyway`) as `Permission.ask` applies them (index.ts role check
// first, then the overlay). HOME is a mkdtemp folder; every file and repository is synthetic.
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
// A second repository outside the project, vetted the way the project's is (no hook-running keys).
let other: string
let spies: { mockRestore(): void }[] = []

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  // The fixture sets keys `GitGuard` refuses (as rel127-u4-read-class.test.ts does), so git looks are vetted here.
  execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
  execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
  mkdirSync(path.join(dir, "docs"), { recursive: true })
  for (const name of ["a.md", "b.md", "x.zip", "x.pdf", "f.txt", "docs/c.md"]) writeFileSync(path.join(dir, name), "x\n")
  other = mkdtempSync(path.join(os.tmpdir(), "hu4b-other-"))
  execFileSync("git", ["init", "-q"], { cwd: other })
  writeFileSync(path.join(other, "f.txt"), "x\n")
  home = mkdtempSync(path.join(os.tmpdir(), "hu4b-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  rmSync(home, { recursive: true, force: true })
  rmSync(other, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

const ROLES = ["planner", "data-collector", "verifier", "coder"] as const

/** The side a subagent's shell call lands on under consent, as `Permission.ask` decides it. */
async function side(command: string, agent: string) {
  const input: AutonomyTable.Input = {
    permission: "bash",
    patterns: [command],
    metadata: { command, workdir: dir, steps: await readSteps(command, dir) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    agent,
    bypass: { caller: "subagent" },
  }
  if (AutonomyTable.readRoleRefuses(input, instance)) return "held"
  const verdict = AutonomyTable.classify(input)
  if (verdict.class === "P") return "runs"
  if (verdict.class !== "A") return "held"
  if (verdict.bypassed === undefined) return "runs"
  // The overlay: a subagent's opened call runs like the root's only in a local category; otherwise the main agent's
  // "cannot tell" refuses it.
  return AutonomyTable.SUBAGENT_RUNS_LIKE_ROOT.has(verdict.bypassed) && !AutonomyTable.subagentSendsAnyway(input) ? "runs" : "held"
}

const sides = async (command: string) =>
  Object.fromEntries(await Promise.all(ROLES.map(async (role) => [role, await side(command, role)] as const)))

// 01a AT-HU4b list, each in the project folder with synthetic files. `<dir>` is a project subfolder and a vetted
// repository outside the project (the pair blueprint row 27 names).
const READ_COMMANDS: (() => string)[] = [
  () => "ls -la",
  () => "cat a.md",
  () => "head -n 5 a.md",
  () => "tail -n 5 a.md",
  () => "find . -name '*.md'",
  () => "wc -l a.md",
  () => "stat a.md",
  () => "file a.md",
  () => "du -sh .",
  () => "shasum -a 256 f.txt",
  () => "md5 f.txt",
  () => "pdftotext x.pdf -",
  () => "unzip -l x.zip",
  () => "git log --oneline -5",
  () => "git show HEAD --stat",
  () => "git diff",
  () => "git -C docs status",
  () => `git -C ${other} status`,
  () => `git -C ${other} log --oneline -3`,
  () => `cd ${other} && git status`,
  () => "graft ask 'where is the gate' --no-refresh",
  () => "mdls a.md",
  () => "pgrep -l swarm",
  () => "pgrep -fl opencode",
]

describe("H-U4b: a documented read command lands on one side for every role", () => {
  for (const [index, command] of READ_COMMANDS.entries())
    test(`read command ${index + 1}`, async () => {
      const found = await sides(command())
      expect({ command: command(), ...found }).toEqual({ command: command(), ...Object.fromEntries(ROLES.map((role) => [role, "runs"])) })
    })
})

describe("H-U4b: writes keep their per-role verdicts (the read roles are refused)", () => {
  const writes: (() => string)[] = [
    () => "rm a.md",
    () => "echo x > b.md",
    () => "cat a.md > b.md",
    () => "find . -name '*.md' -delete",
    () => "git commit -m x --allow-empty",
    () => `git -C ${other} commit -m x --allow-empty`,
    () => `git -C ${other} reset --hard`,
    () => "pgrep -l swarm && pkill swarm",
  ]
  for (const [index, command] of writes.entries())
    test(`write ${index + 1}`, async () => {
      const found = await sides(command())
      expect({ command: command(), planner: found.planner, "data-collector": found["data-collector"] }).toEqual({
        command: command(),
        planner: "held",
        "data-collector": "held",
      })
    })
})
