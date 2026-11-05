// Swarm 1.1.1 F12b (healing loop 5, decisions P20-P23): the undo-snapshot check and tool configuration under consent.
// - S4-2 (gate 4 G4-2): an edit of a compiler, bundler, test-runner, coverage, linter or formatter config, or a shell write
//   into one, keeps its 1.1.0 verdict under consent. Without consent nothing changes.
// - Perf P2: one batched snapshot check per classify, whatever the number of write targets.
// - m30: a stuck git cannot hold the classifier; a timeout counts as outside, so the call keeps 1.1.0.
// - m31: the sync and async snapshot checks give the same answer over one table of fixtures.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"
import { Reach } from "../../src/tool/reach"
import { Risk } from "../../src/tool/risk"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { answerOf } from "./consented-literals"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

const TOOL_CONFIGS = [
  "tsconfig.json", "tsconfig.build.json", "packages/a/tsconfig.base.json", "jsconfig.json", "vitest.config.json",
  "jest.config.json", "babel.config.json", "biome.json", "biome.jsonc", ".swcrc", ".nycrc.json", ".c8rc", "turbo.json",
  "nx.json", "ruff.toml", ".ruff.toml", "mypy.ini", ".coveragerc", ".flake8", "pyrightconfig.json", "rustfmt.toml",
  "clippy.toml", "rust-toolchain.toml", "go.work", ".golangci.yml", "Package.swift", "TSConfig.JSON",
]

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src"), { recursive: true })
  for (let index = 0; index < 40; index++) fs.writeFileSync(path.join(dir, `src/f${index}.ts`), "x\n")
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}\n")
  fs.writeFileSync(path.join(dir, "biome.json"), "{}\n")
  fs.writeFileSync(path.join(dir, "payload.txt"), "p\n")
  fs.writeFileSync(path.join(dir, ".gitignore"), "data.db\nlocal/\ndist/\n")
  fs.writeFileSync(path.join(dir, "data.db"), "rows\n")
  fs.mkdirSync(path.join(dir, "local"), { recursive: true })
  fs.writeFileSync(path.join(dir, "local/keep.bin"), "k\n")
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, "dist/out.js"), "o\n")
  fs.writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(2 * 1024 * 1024 + 1))
  fs.mkdirSync(path.join(dir, "nested"), { recursive: true })
  await $`git init -q`.cwd(path.join(dir, "nested")).quiet()
  fs.writeFileSync(path.join(dir, "nested/n.txt"), "n\n")
  await $`git add src tsconfig.json biome.json payload.txt .gitignore && git commit -q -m init`.cwd(dir).quiet()
  fs.writeFileSync(path.join(dir, "untracked.txt"), "u\n")
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

async function sh(command: string, extra: Partial<Input> = {}): Promise<Input> {
  const steps = await readSteps(command, dir)
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}) },
    instance,
    cwd: dir,
    canUndo: true,
    folder: "clean",
    ...extra,
  }
}

const edit = (file: string, editClass: Input["editClass"]): Input => ({
  permission: "edit",
  patterns: [file],
  metadata: { filepath: path.join(dir, file) },
  instance,
  cwd: dir,
  canUndo: true,
  editClass,
  folder: "clean",
})

const base = (input: Input) => AutonomyTable.classify(input)
const root = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })
const opened = (verdict: Verdict): Verdict =>
  verdict.class === "A" ? verdict : { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: verdict.category }

describe("S4-2: a tool's configuration is sensitive under consent only", () => {
  test("the names a compiler, bundler, test runner, coverage tool, linter or formatter reads", () => {
    for (const name of TOOL_CONFIGS) expect([name, Risk.toolConfig(name)]).toEqual([name, true])
    for (const name of ["src/a.ts", "README.md", "src/data.json", "config.ts", "docs/tsconfig.md", "src/project.ts"])
      expect([name, Risk.toolConfig(name)]).toEqual([name, false])
  })

  test("without consent nothing changes: `Risk.sensitive` and `ordinaryEdit` read these names as 1.1.0 did", () => {
    // None of these was sensitive in 1.1.0, so no 1.1.0 verdict reads the new list.
    for (const name of ["tsconfig.json", "jsconfig.json", "biome.json", "ruff.toml", "go.work", "turbo.json", "rustfmt.toml"])
      expect([name, Risk.sensitive(name), Risk.ordinaryEdit(name)]).toEqual([name, false, false])
    expect(Reach.sensitive(path.join(dir, "tsconfig.json"), instance)).toBe(false)
    expect(Reach.consentSensitive(path.join(dir, "tsconfig.json"), instance)).toBe(true)
    expect(Reach.consentSensitive(path.join(dir, "src/f0.ts"), instance)).toBe(false)
  })

  test("an edit of a tool's configuration keeps its 1.1.0 verdict, for the root and a subagent", () => {
    for (const file of ["tsconfig.json", "tsconfig.build.json", "biome.json", "vitest.config.json", "ruff.toml", "go.work", ".golangci.yml"]) {
      const input = edit(file, "not_ordinary")
      const before = base(input)
      expect([file, before]).toEqual([file, { class: "P", decidedBy: "agent", category: "edit-not-ordinary" }])
      // 1.1.3 (matrix row 8, spec section 3 rule 5): the kept P no longer waits for a decision; it runs as the main agent's.
      expect([file, root(input)]).toEqual([file, opened(before)])
      expect([file, subagent(input)]).toEqual([file, opened(before)])
    }
  })

  test("near miss: an edit that is not ordinary and not a tool's configuration is still the main agent's", () => {
    const input = edit("src/settings.yaml", "not_ordinary")
    expect(root(input)).toEqual(opened(base(input)))
  })

  test("a shell write into a tool's configuration keeps its 1.1.0 verdict; the same write into source opens", async () => {
    for (const command of ["cat payload.txt > tsconfig.json", "cat payload.txt >> biome.json", "prettier --write tsconfig.json", "prettier --write src/f0.ts tsconfig.json"]) {
      const input = await sh(command)
      const before = base(input)
      expect([command, before.class === "A"]).toEqual([command, false])
      // 1.1.3 (spec section 3 `noWait`; matrix rows 4, 8, 22, 31): the kept verdict no longer waits.
      // Literal (T9 G8): with Undo the replace is covered, so the D runs as the main agent's.
      const expected = { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "not_routine" }
      expect([command, root(input)] as unknown[]).toEqual([command, expected])
      expect([command, subagent(input)] as unknown[]).toEqual([command, expected])
      expect([command, answerOf(root(input))]).toEqual([command, undefined])
    }
    for (const command of ["cat payload.txt > src/f1.ts", "prettier --write src/f0.ts"]) {
      const input = await sh(command)
      expect([command, root(input)]).toEqual([command, opened(base(input))])
    }
  })
})

describe("Perf P2: one batched snapshot check per classify", () => {
  test("prettier on 40 named files asks git at most 3 times, and opens as before", async () => {
    const files = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`)
    const input = await sh(`prettier --write ${files.join(" ")}`)
    const before = Reach.snapshotGitCalls()
    const started = performance.now()
    const verdict = root(input)
    const ms = performance.now() - started
    expect(Reach.snapshotGitCalls() - before).toBeLessThanOrEqual(3)
    expect(verdict).toEqual(opened(base(input)))
    // 1.1.1 F15 (n32): the git counter above carries the contract; the timing is a log.
    console.log(`[F12b P2] 40 files consented ${ms.toFixed(1)} ms`)
  })

  test("one target outside the snapshot among 40 keeps the whole call at 1.1.0", async () => {
    const files = [...Array.from({ length: 39 }, (_, index) => `src/f${index}.ts`), "data.db"]
    const input = await sh(`prettier --write ${files.join(" ")}`)
    const before = base(input)
    expect(before.class === "A").toBe(false)
    // 1.1.3 (spec section 3 `noWait`; matrix rows 8, 22): the kept verdict no longer waits.
    expect(root(input)).toEqual({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: "not_routine" })
    expect(answerOf(root(input))).toBeUndefined()
  })

  test("inside one scope, the same paths are answered once", () => {
    const paths = [path.join(dir, "src/f0.ts"), path.join(dir, "src/f1.ts")]
    const calls = Reach.snapshotScope(() => {
      const before = Reach.snapshotGitCalls()
      expect(Reach.outsideSnapshotSync(dir, paths)).toBe(false)
      const first = Reach.snapshotGitCalls() - before
      expect(Reach.outsideSnapshotSync(dir, paths)).toBe(false)
      expect(Reach.outsideSnapshotSync(dir, [paths[0]!])).toBe(false)
      expect(Reach.outsideSnapshotSync(dir, [path.join(dir, "data.db")])).toBe(true)
      expect(Reach.outsideSnapshotSync(dir, [path.join(dir, "data.db"), paths[0]!])).toBe(true)
      return [first, Reach.snapshotGitCalls() - before]
    })
    expect(calls[0]).toBe(3)
    // The second and third questions are cached; data.db is asked once (it stops at the first question) and then reused.
    expect(calls[1]).toBe(4)
    // Outside a scope nothing is kept.
    const before = Reach.snapshotGitCalls()
    Reach.outsideSnapshotSync(dir, paths)
    Reach.outsideSnapshotSync(dir, paths)
    expect(Reach.snapshotGitCalls() - before).toBe(6)
  })

  test("deferred: every path asked inside is checked once afterwards, and any one outside says outside", () => {
    const inside = Reach.deferSnapshot(() => Reach.outsideSnapshotSync(dir, [path.join(dir, "src/f0.ts")]))
    expect(inside).toEqual({ value: false, outside: false })
    const outside = Reach.deferSnapshot(() => {
      Reach.outsideSnapshotSync(dir, [path.join(dir, "src/f0.ts")])
      return Reach.outsideSnapshotSync(dir, [path.join(dir, "data.db")])
    })
    expect(outside).toEqual({ value: false, outside: true })
    expect(Reach.deferSnapshot(() => Reach.outsideSnapshotSync(dir, [path.join(dir, "tsconfig.json")])).outside).toBe(true)
    expect(Reach.deferSnapshot(() => 1)).toEqual({ value: 1, outside: false })
  })

  // 1.1.1 F14 (G5-P2, m35): when the answer cannot matter (the call is not going to be opened), git is not asked.
  test("deferred, not needed: a value that will not open skips the batch", () => {
    const before = Reach.snapshotGitCalls()
    const skipped = Reach.deferSnapshot(
      () => {
        Reach.outsideSnapshotSync(dir, [path.join(dir, "data.db")])
        return false
      },
      (value) => value === true,
    )
    expect(skipped).toEqual({ value: false, outside: false })
    expect(Reach.snapshotGitCalls() - before).toBe(0)
    // Needed: the same paths are asked, and the one outside says so.
    const asked = Reach.deferSnapshot(
      () => {
        Reach.outsideSnapshotSync(dir, [path.join(dir, "data.db")])
        return true
      },
      (value) => value === true,
    )
    expect(asked).toEqual({ value: true, outside: true })
  })
})

// 1.1.1 F14 (G5-P1, G5-P2, m35): compound calls share one snapshot scope and the call-level S4-1 check asks no git.
describe("m35: compound calls ask git once per classify", () => {
  const files = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`)
  const count = async (command: string) => {
    const input = await sh(command)
    const expected = base(input)
    const before = Reach.snapshotGitCalls()
    const started = performance.now()
    const verdict = root(input)
    return { input, expected, verdict, ms: performance.now() - started, git: Reach.snapshotGitCalls() - before }
  }

  test("a formatter writing 40 files plus a read-only git step: at most 3 git spawns", async () => {
    // Warm the module and the file cache once, so the timing is of the classify alone.
    root(await sh(`prettier --write ${files.join(" ")} && git status`))
    for (const command of [
      `prettier --write ${files.join(" ")} && git status`,
      `prettier --write ${files.join(" ")} && tsc --noEmit`,
      "prettier --write src/f0.ts && prettier --write src/f0.ts",
    ]) {
      const { expected, verdict, ms, git } = await count(command)
      expect([command, verdict]).toEqual([command, opened(expected)])
      expect([command, git <= 3]).toEqual([command, true])
      console.log(`[F14 G5-P1] ${command.slice(0, 40)}... ${ms.toFixed(1)} ms, ${git} git`)
    }
  })

  test("a call that is not opened asks no git: a write beside a step the allowlist does not know", async () => {
    const plain = await count("tsc --noEmit > src/t.log && make")
    // 1.1.3 (matrix rows 8, 22): the kept verdict no longer waits; it runs as the main agent's.
    expect(plain.verdict).toEqual(opened(plain.expected))
    expect(plain.git).toBe(0)
    console.log(`[F14 G5-P2] tsc --noEmit > src/t.log && make: ${plain.ms.toFixed(1)} ms, ${plain.git} git`)
    // A step that is opened on its own still asks for itself (its overlay cannot see the step beside it), once.
    const step = await count(`prettier --write ${files.join(" ")} && make`)
    // 1.1.3 (matrix rows 8, 22): the kept verdict no longer waits; it runs as the main agent's.
    expect(step.verdict).toEqual(opened(step.expected))
    expect(step.git).toBeLessThanOrEqual(3)
    console.log(`[F14 G5-P2] prettier --write <40> && make: ${step.ms.toFixed(1)} ms, ${step.git} git`)
  })
})

describe("m31: the sync and async snapshot checks agree", () => {
  const cases: [string, boolean][] = [
    ["src/f0.ts", false],
    ["src/new.ts", false],
    ["untracked.txt", false],
    ["tsconfig.json", false],
    ["data.db", true],
    ["local/keep.bin", true],
    ["local/new.bin", true],
    ["dist/out.js", false],
    ["dist/new.js", false],
    ["big.bin", true],
    ["nested", true],
    [".", true],
    ["src", false],
  ]
  test("one table through both", async () => {
    for (const [file, expected] of cases) {
      const paths = [path.join(dir, file)]
      const sync = Reach.outsideSnapshotSync(dir, paths)
      const async = await Reach.outsideSnapshot(dir, paths)
      expect([file, sync, async]).toEqual([file, expected, expected])
    }
  })

  test("untracked only: the async form's option skips the ignored questions", async () => {
    expect(await Reach.outsideSnapshot(dir, [path.join(dir, "data.db")], { untrackedOnly: true })).toBe(false)
    expect(await Reach.outsideSnapshot(dir, [path.join(dir, "big.bin")], { untrackedOnly: true })).toBe(true)
  })

  test("no repository: both count everything as outside", async () => {
    const plain = fs.mkdtempSync(path.join(fixture.path, "..", "f12b-plain-"))
    try {
      expect(Reach.outsideSnapshotSync(plain, [path.join(plain, "a.ts")])).toBe(true)
      expect(await Reach.outsideSnapshot(plain, [path.join(plain, "a.ts")])).toBe(true)
    } finally {
      fs.rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe("m30: a stuck git cannot hold the classifier", () => {
  test("a git that sleeps 10 s: the sync check answers outside within 4 s, and the call keeps 1.1.0", async () => {
    const shim = fs.mkdtempSync(path.join(fixture.path, "..", "f12b-shim-"))
    fs.writeFileSync(path.join(shim, "git"), "#!/bin/sh\nexec sleep 10\n", { mode: 0o755 })
    const input = await sh("cat payload.txt > src/f2.ts")
    const saved = process.env.PATH
    process.env.PATH = `${shim}${path.delimiter}${saved}`
    try {
      const started = performance.now()
      expect(Reach.outsideSnapshotSync(dir, [path.join(dir, "src/f2.ts")])).toBe(true)
      const verdict = root(input)
      expect(performance.now() - started).toBeLessThan(4000)
      expect(verdict).toEqual(base(input))
    } finally {
      process.env.PATH = saved
      fs.rmSync(shim, { recursive: true, force: true })
    }
  }, 10_000)
})
