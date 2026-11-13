// Swarm 1.2.8 row 27 (AC-HU7, H-U7, N8-313, N8-392): `pgrep` is in the read class. With options only from `-l -f -a -i -x
// -n -o -q` and, with a value, `-u -U -g -G -P -t -d`, and name patterns as operands, it is class A for the root and runs
// for the read roles (`planner`, `data-collector`). Any other option, or `pkill`/`kill` in the same command, keeps the
// verdict it had. `mdls` on a project file runs for a read role; `mdls` on Swarm's state keeps the `APP_STATE_LOOKS` rule
// (PROBE line). HOME is a mkdtemp folder; the state folder is the test run's (preload); every file is synthetic.
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import * as osModule from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext
let home: string
let spies: { mockRestore(): void }[] = []
const state = () => path.join(process.env.XDG_STATE_HOME!, "swarm")

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  execFileSync("git", ["config", "--unset", "core.fsmonitor"], { cwd: dir })
  execFileSync("git", ["config", "--unset", "commit.gpgsign"], { cwd: dir })
  writeFileSync(path.join(dir, "a.md"), "x\n")
  home = mkdtempSync(path.join(os.tmpdir(), "hu7-"))
  spies = [spyOn(os, "homedir").mockReturnValue(home), spyOn(osModule, "homedir").mockReturnValue(home)]
  mkdirSync(state(), { recursive: true })
  writeFileSync(path.join(state(), "hu7-probe.txt"), "synthetic\n")
})
afterAll(async () => {
  for (const spy of spies) spy.mockRestore()
  rmSync(path.join(state(), "hu7-probe.txt"), { force: true })
  rmSync(home, { recursive: true, force: true })
  await fixture[Symbol.asyncDispose]()
})

const bash = (command: string, fields: Partial<Input> = {}): Input => ({
  permission: "bash",
  patterns: [command],
  metadata: { command, workdir: dir },
  instance,
  cwd: dir,
  canUndo: true,
  folder: "clean",
  ...fields,
})
const refusedFor = (command: string, agent: string) => AutonomyTable.readRoleRefuses(bash(command, { agent }), instance)
const root = (command: string) => AutonomyTable.classify(bash(command, { bypass: { caller: "root" } }))

const LISTS = [
  "pgrep -l swarm",
  "pgrep -fl opencode",
  "pgrep -f opencode",
  "pgrep -a -i swarm",
  "pgrep -x bun",
  "pgrep -n -l swarm",
  "pgrep -o swarm",
  "pgrep -q swarm",
  "pgrep -u 501 swarm",
  "pgrep -U 501 -l swarm",
  "pgrep -g 20 swarm",
  "pgrep -G 20 swarm",
  "pgrep -P 1 -l",
  "pgrep -t ttys001 zsh",
  "pgrep -d , -l swarm",
]

describe("H-U7: pgrep with the listed options is a read", () => {
  for (const command of LISTS)
    test(command, () => {
      expect({ command, planner: refusedFor(command, "planner"), collector: refusedFor(command, "data-collector") }).toEqual({
        command,
        planner: false,
        collector: false,
      })
      // A read: class A with no category, in the 1.1.0 layer and under consent alike.
      expect({ command, base: AutonomyTable.classify(bash(command)), consent: root(command) }).toEqual({
        command,
        base: { class: "A", decidedBy: "gate" },
        consent: { class: "A", decidedBy: "gate" },
      })
    })
})

// The verdicts these had at BASE (e1f9673772), pinned: the read roles refuse them; for the root the 1.1.0 layer holds
// them `not_routine` and the consented layer gives them to the main agent, or refuses a signal to a process not Swarm's.
const BASE_LAYER: Verdict = { class: "D", decidedBy: "gate", category: "not_routine" }
const MAIN: Verdict = { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "not_routine" }
describe("H-U7: any other option, or pkill/kill beside it, keeps the verdict it had", () => {
  const KEPT: [string, Verdict][] = [
    ["pgrep -v swarm", MAIN],
    ["pgrep -F pid.txt", MAIN],
    ["pgrep -S swarm", MAIN],
    ["pgrep --list-name swarm", MAIN],
    ["pgrep -l swarm && pkill swarm", { class: "X", decidedBy: "gate", category: "process_not_own", bypassed: "unreadable_command" }],
    ["pkill swarm", { class: "X", decidedBy: "gate", category: "process_not_own", bypassed: "process_not_own" }],
  ]
  for (const [command, consent] of KEPT)
    test(command, () => {
      expect({ command, planner: refusedFor(command, "planner"), collector: refusedFor(command, "data-collector") }).toEqual({
        command,
        planner: true,
        collector: true,
      })
      expect(AutonomyTable.classify(bash(command))).toEqual(BASE_LAYER)
      expect(root(command)).toEqual(consent)
    })
  test("pgrep -l swarm && kill 1234: still refused for the read roles and not a read for the root", () => {
    expect(refusedFor("pgrep -l swarm && kill 1234", "planner")).toBe(true)
    expect(root("pgrep -l swarm && kill 1234").class).not.toBe("A")
  })
})

describe("H-U7: mdls", () => {
  test("mdls on a project file runs for a read role and is a read for the root", () => {
    expect(refusedFor("mdls a.md", "planner")).toBe(false)
    expect(refusedFor("mdls -name kMDItemContentType a.md", "data-collector")).toBe(false)
    expect(root("mdls a.md").class).toBe("A")
  })
  test("PROBE: mdls on Swarm's state keeps the APP_STATE_LOOKS path rule", () => {
    const file = path.join(state(), "hu7-probe.txt")
    expect(refusedFor(`mdls ${file}`, "planner")).toBe(false)
    expect(root(`mdls ${file}`)).toEqual({ class: "A", decidedBy: "gate", category: "protected_read" })
    // A glob over the state folder is no literal name: refused as app state.
    expect(root(`mdls ${state()}/*`)).toEqual({ class: "X", decidedBy: "gate", category: "app_state" })
  })
})
