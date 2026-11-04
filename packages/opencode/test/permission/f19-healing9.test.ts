// Swarm 1.1.1 F19 (healing loop 9, decision P32): two general rules and what gate 8 still found.
// - Principle 1 (S8-1 class): every consented check starts from the step's folder by its real path, so manifests, install
//   roots, scripts, workspaces and inside-the-project checks are the ones the managers and tools see.
// - Principle 2 (S8-3 class): beside a step that changes the tree or HEAD, any other step that writes, runs a project
//   script, installs, or names an output or config file keeps the call at 1.1.0. Read-only steps beside it still open.
// - S8-2: options that start a network listener (inspector, API, UI, standalone, browser) keep 1.1.0.
// - S8-4: cargo with a `--` keeps 1.1.0.
// - G7-1 variant: a tool's placeholder token in a path word keeps 1.1.0.
// - n40, G8-P1: the separator lists are pinned to the option tables; workspace answers are asked once per folder.
// Each change may only keep a call at its 1.1.0 verdict, so every "keeps" case is compared with the no-consent answer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassLists } from "../../src/permission/bypass-lists"
import { BypassScreen } from "../../src/permission/bypass-screen"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { expectBareFrom } from "./install-fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const BENIGN = JSON.stringify({ name: "p", scripts: { postinstall: "tsc --noEmit", build: "tsc --noEmit" } })
const PUSHES = JSON.stringify({ name: "q", scripts: { postinstall: "git push origin HEAD", build: "git push origin HEAD" } })

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

async function keeps(commands: readonly string[], cwd: string, scope: InstanceContext) {
  for (const command of commands) {
    const input = await sh(command, cwd, scope)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    expect([command, root(input)]).toEqual([command, before])
    expect([command, subagent(input)]).toEqual([command, before])
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

describe("principle 1 (S8-1): the step's folder by its real path", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    bareAbove(path.dirname(dir))
    await gitInit(dir)
    write(dir, "package.json", BENIGN)
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
    // A folder under a manifest of its own whose hooks and scripts push, and one under a manifest whose hooks pass.
    write(dir, "other/package.json", PUSHES)
    fs.mkdirSync(path.join(dir, "other/sub"), { recursive: true })
    write(dir, "good/package.json", BENIGN)
    fs.mkdirSync(path.join(dir, "good/sub"), { recursive: true })
    fs.symlinkSync(path.join(dir, "other/sub"), path.join(dir, "lnk"))
    fs.symlinkSync(path.join(dir, "good/sub"), path.join(dir, "clean"))
  })

  test("a folder reached through a link to a folder under another manifest is judged by that manifest", async () => {
    // From the link itself, and through a `cd` into it.
    await keeps(["npm install", "bun install", "npm run build", "pnpm run build"], path.join(dir, "lnk"), gitScope(dir))
    await keeps(["cd lnk && npm install", "cd lnk && npm run build"], dir, gitScope(dir))
  })

  test("near miss: a link to a folder under a manifest whose hooks pass opens", async () => {
    await opens(["npm install", "npm run build"], path.join(dir, "clean"), gitScope(dir))
    // 1.1.1 F20 (P34, S9-2): a `cd` through a link keeps 1.1.0 (a shell set to resolve links lands elsewhere).
    await keeps(["cd clean && npm install"], dir, gitScope(dir))
    // And the project's own folder, as before.
    await opens(["npm install", "npm run build"], dir, gitScope(dir))
  })

  test("a step back after a link inside the project goes up from where the link leads", async () => {
    const outside = await temp()
    fs.mkdirSync(path.join(outside, "a/b"), { recursive: true })
    write(outside, "a/x.ts", "x\n")
    write(dir, "src/a.ts", "x\n")
    write(dir, "node_modules/.bin/prettier", "#!/bin/sh\n")
    fs.symlinkSync(path.join(outside, "a/b"), path.join(dir, "out"))
    await keeps(["prettier --check out/../x.ts"], dir, gitScope(dir))
    // Near miss: a step back that stays inside by both readings.
    await opens(["prettier --check src/../src/a.ts"], dir, gitScope(dir))
  })
})

describe("principle 2 (S8-3): a change of the tree beside a step that writes", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    bareAbove(path.dirname(dir))
    await gitInit(dir)
    write(dir, "package.json", BENIGN)
    write(dir, "src/a.ts", "x\n")
    write(dir, "tsconfig.json", "{}\n")
    for (const bin of ["tsc", "prettier", "eslint"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
  })

  test("a write, an output option, a config file, an in-place rewrite, a script or an install beside it keeps 1.1.0", async () => {
    await keeps(
      [
        "git checkout main && prettier --write src/a.ts",
        "prettier --write src/a.ts && git switch main",
        "git stash && tsc --outDir build",
        "git merge topic && tsc -p tsconfig.json",
        "git checkout main && mkdir -p build",
        "git checkout main && touch src/b.ts",
        "git checkout main && eslint --fix src",
        "git checkout main && npm run build",
        "git switch main && npm install",
        "git checkout main && echo done > out.txt",
        "git checkout main && cp src/a.ts src/c.ts",
        "git checkout main && sed -i '' s/x/y/ src/a.ts",
        "git checkout main; tee out.txt < src/a.ts",
      ],
      dir,
      gitScope(dir),
    )
  })

  test("near miss: read-only steps beside a change of the tree, and the same writes without one, still open", async () => {
    await opens(
      [
        "git checkout main && git status",
        "git switch main && ls src && cat src/a.ts",
        "git stash && git checkout main && git stash pop",
        "git checkout main && prettier --check src/a.ts",
        "git checkout main && tsc --noEmit",
      ],
      dir,
      gitScope(dir),
    )
    await opens(["git status && prettier --write src/a.ts", "git status && tsc --outDir build", "git status && mkdir -p build"], dir, gitScope(dir))
  })
})

describe("S8-2, S8-4, G7-1: listeners, cargo's separator, placeholder tokens", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    for (const bin of ["vitest", "jest", "prettier"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
  })

  test("S8-2: vitest's and bun test's listener options keep 1.1.0, in every spelling", async () => {
    await keeps(
      [
        "vitest run --inspect", "vitest run --inspect=0.0.0.0:9229", "vitest run --inspect-brk", "vitest run --inspectBrk=9230",
        "vitest run --api", "vitest run --api.host=0.0.0.0", "vitest run --api.port 51204", "vitest run --api.allowExec",
        "vitest --ui", "vitest --standalone", "vitest run --browser", "vitest run --browser.api.host 0.0.0.0",
        "vitest run --API.HOST=0.0.0.0", "npx vitest run --inspect=0.0.0.0",
        "bun test --inspect", "bun test --inspect=0.0.0.0:6499", "bun test --inspect-brk", "bun test --inspect-wait=6499",
      ],
      dir,
      gitScope(dir),
    )
    // Near misses: the plain runs.
    await opens(["vitest run", "bun test", "vitest run --coverage"], dir, gitScope(dir))
  })

  test("S8-4: cargo with a `--` keeps 1.1.0", async () => {
    await keeps(["cargo clippy -- -o x", "cargo test -- --nocapture", "cargo fmt -- --emit files", "cargo check --"], dir, gitScope(dir))
    await opens(["cargo clippy", "cargo test", "cargo check"], dir, gitScope(dir))
  })

  test("G7-1 variant: a placeholder token in a path word keeps 1.1.0", async () => {
    await keeps(
      ["jest --modulePaths '<rootDir>/../x'", "jest '--prettierPath=<rootDir>/../x'", "jest '--modulePaths=<rootDir>'"],
      dir,
      gitScope(dir),
    )
    // 1.1.1 F20 (CR9-3): only jest expands its root-dir token; to prettier `<rootDir>` is a folder name like any other.
    await opens(["jest --modulePaths src", "prettier --check src/a.ts", "prettier --check '<rootDir>/src'"], dir, gitScope(dir))
  })
})

describe("n40: the separator lists and the option tables", () => {
  test("every program of the output and config tables ends its options at `--` or is listed as reading past it", () => {
    const programs = new Set([...Object.keys(BypassLists.OUTPUT_OPTIONS), ...Object.keys(BypassLists.CONFIG_OPTIONS)])
    for (const program of programs) {
      const ends = BypassLists.SEPARATOR_ENDS_OPTIONS.has(program)
      const past = BypassLists.READS_PAST_SEPARATOR.includes(program)
      expect([program, ends !== past]).toEqual([program, true])
    }
    for (const program of BypassLists.READS_PAST_SEPARATOR) expect(BypassLists.endsOptionsAtSeparator(program)).toBe(false)
  })

  test("in-place targets read past `--` as files for a tool that ends its options there", () => {
    expect(BypassLists.inPlaceTargets("prettier", ["--", "--write", "x"])).toEqual([])
    expect(BypassLists.inPlaceTargets("prettier", ["--write", "--", "--check", "x"])).toEqual(["--check", "x"])
    expect(BypassLists.inPlaceTargets("touch", ["--", "-x"])).toEqual(["-x"])
  })
})

describe("G8-P1: workspace answers are asked once per folder per classify", () => {
  test("six installs from one folder in one script ask each folder once", async () => {
    const dir = await temp()
    bareAbove(path.dirname(dir))
    await gitInit(dir)
    const install = "npm install"
    write(dir, "package.json", JSON.stringify({ name: "p", scripts: { setup: Array(6).fill(install).join(" && ") } }))
    const input = await sh("npm run setup", dir, gitScope(dir))
    const asks = BypassScreen.counters.workspaceAsks
    const folders = BypassScreen.counters.workspaceFolders
    expect(root(input)).toEqual(opened(base(input)))
    const asked = BypassScreen.counters.workspaceAsks - asks
    const computed = BypassScreen.counters.workspaceFolders - folders
    // One folder (the project's top) per classify that read the script, asked six times there.
    expect(computed).toBeGreaterThan(0)
    expect(asked).toBe(6 * computed)
  })
})
