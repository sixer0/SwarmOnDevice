// 1.1.1 F1a: the overlay's lists are one (KEPT_D, HARD_SCRIPT_FLAGS), a sensitive file stays the person's under consent,
// and a tie between two allowed steps prefers the one the overlay opened, whatever order the steps are written in. Every
// one of these only keeps or restores the 1.1.0 verdict.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { expectNoManifestAbove } from "./install-fixture"

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  // `GitGuard` refuses the fixture's quieting config; the guard is about a plain repository.
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  fs.mkdirSync(path.join(dir, ".husky"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, ".husky/pre-commit"), "bun test\n")
  // 1.1.1 F17 (P30): an install opens only from a manifest of the project's own; this one runs no hooks.
  // 1.1.1 F19 (n41): and only when nothing above the repository's top holds one, which this machine must give.
  expectNoManifestAbove(dir)
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n")
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

const instance = () => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext
const SUBAGENT = { caller: "subagent" } as const

async function bash(command: string, bypass?: AutonomyTable.Input["bypass"]) {
  const steps = await readSteps(command, dir)
  return AutonomyTable.classify({
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}) },
    instance: instance(),
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...(bypass && { bypass }),
  })
}

const edit = (file: string, editClass: AutonomyTable.EditClass, bypass?: AutonomyTable.Input["bypass"]) =>
  AutonomyTable.classify({
    permission: "edit",
    patterns: [file],
    metadata: { filepath: path.join(dir, file) },
    instance: instance(),
    cwd: dir,
    canUndo: true,
    folder: "clean",
    editClass,
    ...(bypass && { bypass }),
  })

describe("one list each", () => {
  test("KEPT_D carries sensitive_file beside the 1.1.0 categories, and the hard flags are the four", () => {
    expect([...AutonomyTable.KEPT_D].sort()).toEqual(
      [
        "outward",
        "outward_not_in_mission",
        "outside_folder",
        "script_unreadable",
        "outside_write_held",
        "system_service",
        "process_not_own",
        "unreadable_command",
        "sensitive_file",
      ].sort(),
    )
    expect([...AutonomyTable.HARD_SCRIPT_FLAGS].sort()).toEqual(["delete", "network", "outside_path", "sudo"])
  })
})

describe("a sensitive file under consent keeps its 1.1.0 verdict", () => {
  test("edit-not-ordinary and sensitive edits of a hook are never opened", () => {
    for (const editClass of ["not_ordinary", "sensitive"] as const) {
      const base = edit(".husky/pre-commit", editClass)
      const consented = edit(".husky/pre-commit", editClass, SUBAGENT)
      expect(consented).toEqual(base)
      expect(consented.bypassed).toBeUndefined()
    }
    expect(edit(".husky/pre-commit", "not_ordinary")).toMatchObject({ class: "P", category: "edit-not-ordinary" })
    expect(edit(".husky/pre-commit", "sensitive")).toMatchObject({ class: "D", category: "sensitive_file" })
  })

  test("the same edit of an ordinary file is still opened, so only the sensitive case changed", () => {
    const opened = edit("src/b.toml", "not_ordinary", SUBAGENT)
    expect(opened).toMatchObject({ class: "A", category: "by_main_agent", bypassed: "edit-not-ordinary" })
  })

  test("a shell write to a hook (tee, sed -i) stays held", async () => {
    for (const command of ["echo x | tee .husky/pre-commit", "sed -i '' 's/a/b/' .husky/pre-commit"]) {
      const base = await bash(command)
      expect(base.class).not.toBe("A")
      const consented = await bash(command, SUBAGENT)
      expect(consented.bypassed).toBeUndefined()
      expect(consented).toEqual(base)
    }
  })
})

describe("a tie between allowed steps prefers what the overlay opened (M1)", () => {
  test("both orders of a routine step and an opened step carry `bypassed`, so a subagent's call reaches the decider", async () => {
    // 1.1.1 F20 (P34, S9-4): `mkdir` beside an install is one install and one write, which keeps 1.1.0; `ls` reads only.
    for (const [first, second] of [
      ["ls", "bun install"],
      ["git add src/a.ts", "bun install"],
    ]) {
      for (const command of [`${first} && ${second}`, `${second} && ${first}`, `${first}; ${second}`, `${second}; ${first}`]) {
        const verdict = await bash(command, SUBAGENT)
        expect(verdict.class).toBe("A")
        expect(verdict.category).toBe("by_main_agent")
        expect(verdict.bypassed).toBeDefined()
      }
    }
  })

  test("without the consent the same texts are as in 1.1.0", async () => {
    for (const command of ["mkdir -p build && bun install", "bun install && mkdir -p build"])
      expect(await bash(command)).toMatchObject({ class: "D", category: "not_routine" })
  })
})
