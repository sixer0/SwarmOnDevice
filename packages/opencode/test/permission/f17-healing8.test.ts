// Swarm 1.1.1 F17 (healing loop 8, decisions P28-P30): what the consent still opened after gate 7's findings.
// - P30: an install opens only from npm's install root (the first folder upward with a manifest or a dependency folder)
//   when that root is inside the project with a manifest of its own, is no workspace, and nothing above the repository's
//   top holds a manifest. Replaces the CR6-1 and CR7-1 case patches.
// - S7-1: a data value (`{...}` or `[...]`) with a step back anywhere in it does not pass as inside.
// - S7-3: vitest's typechecker option and its worker node options are code.
// - S7-4: `--` ends options only for tools known to read it so; xcodebuild with one keeps 1.1.0.
// - G7-P1: inside one consented classify each path's real path is asked once.
// Each change may only keep a call at its 1.1.0 verdict, so every "keeps" case is compared with the no-consent answer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassLists } from "../../src/permission/bypass-lists"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { Reach } from "../../src/tool/reach"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { ARCHIVE_FIRST, answerOf } from "./consented-literals"
import { expectBareFrom } from "./install-fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const INSTALLS = ["npm install", "npm ci", "pnpm install", "yarn", "bun install"]
const BENIGN = JSON.stringify({ name: "p", scripts: { postinstall: "tsc --noEmit" } })
const PUSHES = JSON.stringify({ name: "p", scripts: { postinstall: "git push origin HEAD" } })

const temps: Awaited<ReturnType<typeof tmpdir>>[] = []
const temp = async () => {
  const made = await tmpdir()
  temps.push(made)
  return made.path
}

const write = (root: string, relative: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  fs.writeFileSync(path.join(root, relative), content)
}

async function gitInit(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  await $`git init -q && git config core.fsmonitor false && git config commit.gpgsign false`.cwd(dir).quiet()
  await $`git -c user.email=t@t.test -c user.name=T commit -q --allow-empty -m root`.cwd(dir).quiet()
}

const gitScope = (dir: string) => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext
const plainScope = (dir: string) => ({ directory: dir, worktree: "/", project: { vcs: undefined } }) as unknown as InstanceContext

/** No `package.json`, pnpm workspace file or `node_modules` in `from` or any folder above it (n46: the shared helper). */
const bareAbove = (from: string) => expectBareFrom(from, { nodeModules: true })

async function sh(command: string, cwd: string, scope: InstanceContext): Promise<Input> {
  const steps = await readSteps(command, cwd)
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}) },
    instance: scope,
    cwd,
    canUndo: true,
    folder: "clean",
  }
}

const base = (input: Input) => AutonomyTable.classify(input)
const root = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })
const opened = (verdict: Verdict): Verdict =>
  verdict.class === "A" ? verdict : { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: verdict.category }

// 1.1.3 (T9 G8, code review M2): the consented verdict and the agent's answer of each case, written out, not computed with
// `noWait`. A D or P the overlay keeps runs as the main agent's (`RUNS`, bypassed = its 1.1.0 category); a deletion or
// replacement nothing archives is redirected at once (`ARCHIVED`, ARCHIVE_FIRST).
const RUNS = (bypassed: string, destination?: string) =>
  ({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed, ...(destination && { destination }) }) as Verdict
const ARCHIVED = (bypassed: string) => ({ class: "X", decidedBy: "gate", category: "not_reversible", bypassed }) as Verdict
const CONSENTED: Record<string, readonly [Verdict, string | undefined]> = {
  "npm install": [RUNS("not_routine"), undefined],
  "npm ci": [RUNS("not_routine"), undefined],
  "pnpm install": [RUNS("not_routine"), undefined],
  "yarn": [RUNS("not_routine"), undefined],
  "bun install": [RUNS("not_routine"), undefined],
  "prettier --check '{\"a\":\"./../x\"}'": [RUNS("not_routine"), undefined],
  "prettier --check '[\"<rootDir>/../x\"]'": [RUNS("not_routine"), undefined],
  "prettier --check '{\"a\":\"b/c\",\"d\":\"e/f/../../../x\"}'": [RUNS("not_routine"), undefined],
  "prettier --check '[\"..\"]'": [RUNS("not_routine"), undefined],
  "vitest run --typecheck.checker x": [RUNS("not_routine"), undefined],
  "vitest run --typecheck.checker=x": [RUNS("not_routine"), undefined],
  "vitest run --TYPECHECK.CHECKER x": [RUNS("not_routine"), undefined],
  "vitest run --type-check.checker x": [RUNS("not_routine"), undefined],
  "vitest run --typecheck.check x": [RUNS("not_routine"), undefined],
  "vitest run --execArgv=--require=./x.js": [RUNS("not_routine"), undefined],
  "vitest run --exec-argv x": [RUNS("not_routine"), undefined],
  "vitest run --execArgv.0 x": [RUNS("not_routine"), undefined],
  "xcodebuild -- -xcconfig x.xcconfig build": [RUNS("not_routine"), undefined],
  "xcodebuild build -scheme A -- -project X.xcodeproj": [RUNS("not_routine"), undefined],
  "xcodebuild test -scheme A --": [RUNS("not_routine"), undefined],
  "npx tsc -p tsconfig.json": [RUNS("not_routine"), undefined],
  "bunx tsc -p tsconfig.json": [RUNS("not_routine"), undefined],
  "bun x tsc -p tsconfig.json": [RUNS("not_routine"), undefined],
  "bunx --package x tsc": [RUNS("not_routine"), undefined],
}
function consentedOf(command: string) {
  expect([command, Object.hasOwn(CONSENTED, command)]).toEqual([command, true])
  return CONSENTED[command]!
}

async function keeps(commands: readonly string[], cwd: string, scope: InstanceContext) {
  for (const command of commands) {
    const input = await sh(command, cwd, scope)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    // 1.1.3 (spec section 3, `noWait`; matrix rows 3, 8, 16-23, 31): the overlay keeps the 1.1.0 verdict, and under consent
    // that kept verdict no longer waits: a D or P runs as the main agent's, a deletion or replacement is redirected to the
    // archive method at once, an X stays.
    const [expected, answer] = consentedOf(command)
    expect([command, root(input)]).toEqual([command, expected])
    expect([command, answerOf(root(input))]).toEqual([command, answer])
    expect([command, subagent(input)]).toEqual([command, expected])
  }
}

async function opens(commands: readonly string[], cwd: string, scope: InstanceContext) {
  for (const command of commands) {
    const input = await sh(command, cwd, scope)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    expect([command, root(input)]).toEqual([command, opened(before)])
    expect([command, subagent(input)]).toEqual([command, opened(before)])
  }
}

beforeAll(async () => {
  await ScriptReader.prepare()
})

afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

describe("P30: an install opens only from an install root inside the project", () => {
  test("the project's own manifest at its top opens, from the top and from a folder below it", async () => {
    const dir = await temp()
    bareAbove(path.dirname(dir))
    await gitInit(dir)
    write(dir, "package.json", BENIGN)
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
    fs.mkdirSync(path.join(dir, "src"))
    for (const cwd of [dir, path.join(dir, "src")]) await opens(INSTALLS, cwd, gitScope(dir))
    // Without git as well.
    await opens(["npm install"], dir, plainScope(dir))
  })

  test("no manifest in the project, a dependency folder above it: npm installs there; keeps 1.1.0", async () => {
    const outer = await temp()
    bareAbove(path.dirname(outer))
    fs.mkdirSync(path.join(outer, "node_modules"))
    const dir = path.join(outer, "proj")
    await gitInit(dir)
    fs.mkdirSync(path.join(dir, "src"))
    for (const cwd of [dir, path.join(dir, "src")]) await keeps(INSTALLS, cwd, gitScope(dir))
    await keeps(INSTALLS, dir, plainScope(dir))
  })

  test("a manifest above the repository's top that lists the project as a workspace keeps 1.1.0", async () => {
    const outer = await temp()
    bareAbove(path.dirname(outer))
    write(outer, "package.json", JSON.stringify({ workspaces: ["proj"], scripts: { postinstall: "git push origin HEAD" } }))
    const dir = path.join(outer, "proj")
    await gitInit(dir)
    write(dir, "package.json", BENIGN)
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
    await keeps(INSTALLS, dir, gitScope(dir))
  })

  test("a pnpm workspace file alone above the repository's top keeps 1.1.0", async () => {
    for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
      const outer = await temp()
      bareAbove(path.dirname(outer))
      write(outer, name, "packages:\n  - proj\n")
      const dir = path.join(outer, "proj")
      await gitInit(dir)
      write(dir, "package.json", BENIGN)
      write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
      await keeps(INSTALLS, dir, gitScope(dir))
    }
  })

  test("no manifest and no dependency folder anywhere: npm would install in the folder itself; keeps 1.1.0", async () => {
    const dir = await temp()
    bareAbove(dir)
    await keeps(INSTALLS, dir, plainScope(dir))
    await gitInit(dir)
    await keeps(INSTALLS, dir, gitScope(dir))
  })

  test("a nested manifest that is no workspace: its own hooks decide", async () => {
    const dir = await temp()
    bareAbove(path.dirname(dir))
    await gitInit(dir)
    write(dir, "package.json", JSON.stringify({ name: "top" }))
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
    write(dir, "good/package.json", BENIGN)
    write(dir, "bad/package.json", PUSHES)
    fs.mkdirSync(path.join(dir, "good/src"), { recursive: true })
    await opens(INSTALLS, path.join(dir, "good"), gitScope(dir))
    await opens(["npm install"], path.join(dir, "good/src"), gitScope(dir))
    await keeps(INSTALLS, path.join(dir, "bad"), gitScope(dir))
  })

  test("a dependency folder with no manifest beside it inside the project is the root, and keeps 1.1.0", async () => {
    const dir = await temp()
    bareAbove(path.dirname(dir))
    await gitInit(dir)
    write(dir, "package.json", BENIGN)
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
    fs.mkdirSync(path.join(dir, "sub/node_modules"), { recursive: true })
    await keeps(["npm install"], path.join(dir, "sub"), gitScope(dir))
    // Near miss: the top itself still opens.
    await opens(["npm install"], dir, gitScope(dir))
  })

  test("the top's own manifest whose hook pushes keeps 1.1.0", async () => {
    const dir = await temp()
    bareAbove(path.dirname(dir))
    await gitInit(dir)
    write(dir, "package.json", PUSHES)
    await keeps(INSTALLS, dir, gitScope(dir))
  })
})

describe("S7-1, S7-3, S7-4: data values, vitest programs, the separator", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    for (const bin of ["prettier", "vitest", "jest"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
  })

  test("S7-1: a step back anywhere in a braced or bracketed value keeps 1.1.0", async () => {
    await keeps(
      [
        `prettier --check '{"a":"./../x"}'`,
        `prettier --check '["<rootDir>/../x"]'`,
        `prettier --check '{"a":"b/c","d":"e/f/../../../x"}'`,
        `prettier --check '[".."]'`,
      ],
      dir,
      gitScope(dir),
    )
    // Near misses: a data value with no step back, and a plain step back that stays inside.
    await opens([`prettier --check '{"a":"./b"}'`, "prettier --check src/../src/a.ts"], dir, gitScope(dir))
  })

  test("S7-3: vitest's typechecker and worker node options keep 1.1.0, in every spelling it folds", async () => {
    await keeps(
      [
        "vitest run --typecheck.checker x", "vitest run --typecheck.checker=x", "vitest run --TYPECHECK.CHECKER x",
        "vitest run --type-check.checker x", "vitest run --typecheck.check x", "vitest run --execArgv=--require=./x.js",
        "vitest run --exec-argv x", "vitest run --execArgv.0 x",
      ],
      dir,
      gitScope(dir),
    )
    // Near misses: typechecking with the default checker, and its other sub-options.
    await opens(["vitest run --typecheck", "vitest run --typecheck.enabled", "vitest run --typecheck.only"], dir, gitScope(dir))
  })

  test("S7-4: xcodebuild with a `--` keeps 1.1.0", async () => {
    await keeps(
      ["xcodebuild -- -xcconfig x.xcconfig build", "xcodebuild build -scheme A -- -project X.xcodeproj", "xcodebuild test -scheme A --"],
      dir,
      gitScope(dir),
    )
    await opens(["xcodebuild build -scheme A", "xcodebuild test -scheme A"], dir, gitScope(dir))
  })

  test("S7-4: the readers stop at `--` only for tools that end options there", () => {
    expect(BypassLists.selectsConfig("xcodebuild", ["build", "--", "-xcconfig", "x"], () => true)).toBe(true)
    expect(BypassLists.selectsConfig("tsc", ["--noEmit", "--", "-p", "x.json"], () => true)).toBe(false)
    expect(BypassLists.outputTargets("xcodebuild", ["build", "--", "-derivedDataPath", "x"])).toEqual(["x"])
    expect(BypassLists.outputTargets("cargo", ["build", "--", "--target-dir", "x"])).toEqual([])
    expect(BypassLists.endsOptionsAtSeparator("xcodebuild")).toBe(false)
  })
})

describe("n34: npx, bunx and bun x hold a package option alike", () => {
  test("a `-p` anywhere keeps 1.1.0 for all three", async () => {
    const dir = await temp()
    await gitInit(dir)
    write(dir, "tsconfig.json", "{}\n")
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
    await keeps(["npx tsc -p tsconfig.json", "bunx tsc -p tsconfig.json", "bun x tsc -p tsconfig.json", "bunx --package x tsc"], dir, gitScope(dir))
    // Near misses: the same program without it, and `npm exec`, which reads `-p` past its `--` as the program's.
    await opens(["npx tsc --noEmit", "bunx tsc --noEmit", "bun x tsc --noEmit", "npm exec tsc -- -p tsconfig.json"], dir, gitScope(dir))
  })
})

describe("G7-P1: a path's real path is asked once per consented classify", () => {
  test("a 40-file formatter call through npx asks at most once per distinct path; verdicts unchanged", async () => {
    const dir = await temp()
    await gitInit(dir)
    write(dir, "node_modules/.bin/prettier", "#!/bin/sh\n")
    const files = Array.from({ length: 40 }, (_, index) => `src/f${index}.ts`)
    for (const file of files) write(dir, file, "x\n")
    const command = `npx prettier --write -- ${files.join(" ")}`
    const input = await sh(command, dir, gitScope(dir))
    const asked: string[] = []
    const native = fs.realpathSync.native
    const spy = ((file: fs.PathLike, options?: unknown) => {
      asked.push(String(file))
      return (native as (file: fs.PathLike, options?: unknown) => string)(file, options)
    }) as typeof fs.realpathSync.native
    let verdict: Verdict
    const before = Reach.realpathLookups()
    fs.realpathSync.native = spy
    try {
      verdict = root(input)
    } finally {
      fs.realpathSync.native = native
    }
    const lookups = Reach.realpathLookups() - before
    const distinct = new Set(asked)
    console.log(`G7-P1: ${asked.length} realpath lookups for ${distinct.size} distinct paths (${lookups} counted by Reach)`)
    expect(asked.length).toBe(distinct.size)
    expect(lookups).toBe(asked.length)
    expect(verdict.class).toBe("A")
    expect(verdict).toEqual(opened(base(input)))
  })

  test("outside a scope each call still asks", async () => {
    // 1.1.1 F19 (n42): a consented classify resolves the file first, in this test itself, so the check does not rest on
    // which test ran before it; a memo that outlived that classify would answer the two asks after it without a lookup.
    const dir = await temp()
    await gitInit(dir)
    write(dir, "node_modules/.bin/prettier", "#!/bin/sh\n")
    write(dir, "src/a.ts", "x\n")
    const file = path.join(dir, "src/a.ts")
    const input = await sh("prettier --write src/a.ts", dir, gitScope(dir))
    const during = Reach.realpathLookups()
    expect(root(input).class).toBe("A")
    expect(Reach.realpathLookups()).toBeGreaterThan(during)
    const before = Reach.realpathLookups()
    Reach.real(file)
    Reach.real(file)
    expect(Reach.realpathLookups() - before).toBe(2)
  })
})
