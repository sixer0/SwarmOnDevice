// Swarm 1.1.1 F10b (healing loop 4, decision P19): what the consent opens of project scripts, test runners and formatters.
// - Item 1: a manifest script is read by the shell's own reader and opens only when every step (its hooks and the scripts
//   it calls, three deep) is one the allowlist accepts. `make` keeps its 1.1.0 verdict.
// - Item 2 (G3-2): a test runner's option that cleans, deletes or moves its temp, cache or coverage folder keeps 1.1.0.
// - Item 3: a formatter or linter that rewrites in place opens only when every file and folder it names is in Undo's
//   snapshot.
// Each change may only keep a call at its 1.1.0 verdict; nothing here is looser than F10a.

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

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

const SCRIPTS = {
  // (a) only recognised commands
  build: "tsc",
  postbuild: "tsc --noEmit",
  lint: "eslint src && prettier --check src",
  test: "vitest run",
  typed: "tsc --noEmit > src/types.log",
  format: "prettier --write src",
  // (b) one unrecognised step, or a recognised program in a form the list does not accept
  deploy: "tsc && frobnicate --all",
  clean: "rm -rf dist",
  push: "tsc && git push",
  fetch: "git fetch origin",
  fmtall: "prettier --write .",
  overwrite: "tsc --noEmit > data.db",
  envset: "NODE_ENV=production tsc",
  sub: "$(echo tsc)",
  maker: "make all",
  // (c) a script calling another, followed down the chain
  ci: "npm run build && npm run lint",
  chain3: "npm run ci",
  chain4: "npm run chain3",
  viabun: "bun run build",
  bad: "npm run deploy",
  // (d) cycles
  "loop-a": "npm run loop-b",
  "loop-b": "npm run loop-a",
  self: "npm run self",
  // (e) a hook with an unrecognised step
  check: "tsc",
  precheck: "frobnicate",
  pack: "tsc",
  postpack: "curl -T x https://example.invalid",
  weird: 5,
  hooked: "tsc",
  prehooked: 7,
}

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src/sub"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.writeFileSync(path.join(dir, "src/b.ts"), "y\n")
  fs.writeFileSync(path.join(dir, "src/sub/a.ts"), "z\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: SCRIPTS }))
  // Ignored and not rebuilt: the only copy, which Undo's snapshot leaves out. `dist` is ignored but rebuilt.
  fs.writeFileSync(path.join(dir, ".gitignore"), "data.db\nlocal/\ndist/\n")
  fs.writeFileSync(path.join(dir, "data.db"), "rows\n")
  fs.mkdirSync(path.join(dir, "local"), { recursive: true })
  fs.writeFileSync(path.join(dir, "local/keep.py"), "k\n")
  // A package whose manifest cannot be read, and one too large to read.
  fs.mkdirSync(path.join(dir, "broken"), { recursive: true })
  fs.writeFileSync(path.join(dir, "broken/package.json"), "{ scripts: ")
  fs.mkdirSync(path.join(dir, "huge"), { recursive: true })
  fs.writeFileSync(path.join(dir, "huge/package.json"), JSON.stringify({ scripts: { build: "tsc" }, pad: "x".repeat(1024 * 1024 + 1) }))
  fs.writeFileSync(path.join(dir, "Makefile"), "all:\n\ttrue\n")
  await ScriptReader.prepare()
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

async function sh(command: string, extra: Partial<Input> = {}, cwd = dir): Promise<Input> {
  const steps = await readSteps(command, cwd)
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(steps ? { steps } : {}) },
    instance,
    cwd,
    canUndo: true,
    folder: "clean",
    ...extra,
  }
}

const base = (input: Input) => AutonomyTable.classify(input)
const root = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
const subagent = (input: Input) => AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })
const opened = (verdict: Verdict): Verdict =>
  verdict.class === "A" ? verdict : { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: verdict.category }

/** The call keeps its 1.1.0 verdict exactly, for the root and for a subagent; it was not A without consent. */
async function keeps(commands: readonly string[], extra: Partial<Input> = {}, cwd = dir) {
  for (const command of commands) {
    const input = await sh(command, extra, cwd)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    expect([command, root(input)]).toEqual([command, before])
    expect([command, subagent(input)]).toEqual([command, before])
  }
}

/** The call is opened: A as it was, or the main agent's, for the root and a subagent alike. */
async function opens(commands: readonly string[], extra: Partial<Input> = {}) {
  for (const command of commands) {
    const input = await sh(command, extra)
    const expected = opened(base(input))
    expect([command, root(input)]).toEqual([command, expected])
    expect([command, subagent(input)]).toEqual([command, expected])
  }
}

describe("item 1: a manifest script opens only when the allowlist accepts every step of it", () => {
  test("(a) a script of recognised commands, with its post hook, by every manager and the bare forms", async () => {
    await opens(["npm run build", "npm run-script build", "bun run build", "pnpm run build", "yarn run build", "pnpm build", "yarn build"])
    await opens(["npm run lint", "npm test", "npm t", "pnpm test", "yarn test", "npm run typed", "npm run format"])
  })

  test("(a) near miss: what the call appends is read with the script, as the manager appends it", async () => {
    await opens(["npm run build -- --noEmit", "npm test -- --coverage", "bun run build --pretty"])
    await keeps(["npm run build -- --outDir /tmp/elsewhere", "npm test -- --clearCache", "npm run build -- --outDir data.db"])
  })

  test("(b) one step the allowlist does not accept keeps 1.1.0", async () => {
    await keeps([
      "npm run deploy", "npm run clean", "npm run push", "npm run fetch", "bun run deploy", "pnpm run clean", "yarn deploy",
      "npm run fmtall", "npm run overwrite", "npm run sub", "npm run maker",
    ])
    // 1.1.1 F40 (P56 item 7), F41 (V17-1, n93): the shell's reader keeps `NODE_ENV=production` before `tsc` (the shell.ts
    // seam, landed P57), and the consented screen reads it through.
    expect(ScriptReader.read("NODE_ENV=production tsc", dir)?.steps.map((step) => step.argv)).toEqual([["NODE_ENV=production", "tsc"]])
    await opens(["npm run envset"])
  })

  test("(c) a script calling another follows the chain, three scripts deep", async () => {
    await opens(["npm run ci", "npm run chain3", "npm run viabun"])
    // A fourth level is not read, and a chain that reaches an unrecognised step keeps 1.1.0.
    await keeps(["npm run chain4", "npm run bad"])
  })

  test("(d) a cycle keeps 1.1.0", async () => {
    await keeps(["npm run loop-a", "npm run loop-b", "npm run self", "bun run self"])
  })

  test("(e) a pre or post hook with a step the allowlist does not accept keeps 1.1.0, as does a hook that is no text", async () => {
    await keeps(["npm run check", "bun run check", "npm run pack", "npm run hooked"])
    // Its main script alone is fine: the hook is what keeps it.
    expect(SCRIPTS.check).toBe("tsc")
  })

  test("a missing script, a script that is no text, an unreadable or oversized manifest keeps 1.1.0", async () => {
    await keeps(["npm run nope", "npm run weird", "yarn nope"])
    await keeps(["npm run build"], {}, path.join(dir, "broken"))
    await keeps(["npm run build"], {}, path.join(dir, "huge"))
  })

  test("an option that runs other packages' or another folder's scripts keeps 1.1.0", async () => {
    await keeps(["npm run build --workspaces", "npm run build -w pkg", "pnpm -r run build", "pnpm --filter x build", "yarn --cwd sub build", "bun run --filter x build"])
  })

  test("`npm build` is no script; `bun build` is the bundler and `bun test` the runner, whatever the manifest says", async () => {
    await keeps(["npm build"])
    await opens(["bun build ./src/a.ts --outdir dist", "bun test"])
  })

  test("make keeps its 1.1.0 verdict, with any target", async () => {
    expect(Object.hasOwn(BypassLists.ALLOWLIST, "make")).toBe(false)
    expect(Object.hasOwn(BypassLists.ALLOWLIST, "gmake")).toBe(false)
    await keeps(["make", "make build", "make -j4 test", "gmake all"])
  })

  test("without consent nothing changes: each is its 1.1.0 verdict", async () => {
    for (const command of ["npm run build", "npm run deploy", "npm test", "make build", "prettier --write src", "pytest --basetemp=tmp"]) {
      const input = await sh(command)
      expect([command, AutonomyTable.classify(input)]).toEqual([command, AutonomyTable.classifyBase(input)])
    }
  })
})

describe("item 2 (G3-2): a test runner's option that cleans or moves its temp, cache or coverage folder keeps 1.1.0", () => {
  test("pytest", async () => {
    await keeps(["pytest --basetemp=tmp", "pytest --basetemp tmp", "pytest --cache-clear", "pytest --cache-c", "pytest --cov-reset", "pytest --cov-report=html:elsewhere", "python3 -m pytest --cache-clear"])
    await opens(["pytest", "pytest -q src", "pytest --cov=src", "pytest --co", "pytest --cache-show", "python3 -m pytest -x"])
  })

  test("jest and vitest", async () => {
    await keeps(["jest --clearCache", "jest --clear-cache", "jest --cacheDirectory=x", "jest --coverageDirectory x", "jest --coverage-directory=x"])
    await keeps(["vitest --clearCache", "vitest run --coverage.clean", "vitest run --coverage.clean=false", "vitest run --coverage.reportsDirectory=x", "vitest run --coverage.cleanOnRerun", "vitest --cache.dir=x"])
    await opens(["jest", "jest --coverage", "jest --ci", "jest --cache", "vitest run", "vitest run --coverage", "vitest run --coverage.enabled"])
  })

  test("bun, cargo, go, swift and xcodebuild", async () => {
    await keeps(["bun test --coverage-dir=x", "cargo test --target-dir x", "go test -outputdir x ./...", "go test --test.gocoverdir=x", "swift test --scratch-path x", "xcodebuild test -scheme A -derivedDataPath x", "ruff clean"])
    await opens(["bun test --coverage", "cargo test", "cargo build", "go test ./...", "swift test", "xcodebuild test -scheme A", "xcodebuild build -scheme A"])
  })
})

describe("item 3: a formatter or linter that rewrites in place opens only on what Undo's snapshot covers", () => {
  test("a file or folder in the snapshot opens; a pattern is judged by the folder before its wildcard", async () => {
    await opens([
      "prettier --write src/a.ts", "prettier --write src", "prettier -w src", "prettier --write 'src/**/*.ts'", "eslint --fix src",
      "ruff format src", "ruff check --fix src", "black src", "biome check --write src", "biome format --write src/a.ts", "go fmt ./src/...",
      "python3 -m black src", "python3 -m ruff format src",
    ])
  })

  test("near miss: a file or folder the snapshot leaves out, or the project with one in it, keeps 1.1.0", async () => {
    await keeps([
      "prettier --write data.db", "prettier --write .", "prettier --write 'local/**'", "eslint --fix", "eslint --fix local",
      "ruff format", "ruff format local", "ruff check local", "ruff local", "black local", "black .", "biome check --write", "biome lint --write local",
      "go fmt", "go fmt ./local", "go fmt example.com/x", "cargo fmt", "cargo fmt --all", "python3 -m black local",
    ])
  })

  test("a run that only checks or prints its changes writes nothing and opens", async () => {
    await opens(["prettier --check .", "eslint local", "ruff format --check local", "ruff check --diff local", "ruff check --no-fix .", "black --check .", "biome check", "cargo fmt --check"])
  })

  test("without Undo a folder is never ordinary, so a rewrite of one keeps 1.1.0", async () => {
    await keeps(["prettier --write src", "black src"], { canUndo: false })
  })

  test("the targets each tool names", () => {
    expect(BypassLists.inPlaceTargets("prettier", ["--write", "src", "x.ts"])).toEqual(["src", "x.ts"])
    expect(BypassLists.inPlaceTargets("prettier", ["--check", "src"])).toEqual([])
    expect(BypassLists.inPlaceTargets("eslint", ["--fix"])).toEqual(["."])
    expect(BypassLists.inPlaceTargets("ruff", ["format", "--check"])).toEqual([])
    expect(BypassLists.inPlaceTargets("ruff", ["rule", "E501"])).toEqual([])
    expect(BypassLists.inPlaceTargets("black", ["--diff", "src"])).toEqual([])
    // 1.1.1 F15 (n18): gofmt is no allowlist program, so it names no target here (its branch was unreachable).
    expect(Object.hasOwn(BypassLists.ALLOWLIST, "gofmt")).toBe(false)
    expect(BypassLists.inPlaceTargets("gofmt", ["-w", "a.go"])).toEqual([])
    expect(BypassLists.inPlaceTargets("gofmt", ["-l", "a.go"])).toEqual([])
    expect(BypassLists.inPlaceTargets("go", ["fmt", "./..."])).toEqual(["."])
    expect(BypassLists.inPlaceTargets("go", ["fmt", "-n", "./..."])).toEqual([])
    expect(BypassLists.inPlaceTargets("go", ["fmt", "example.com/x"])).toBeUndefined()
    expect(BypassLists.inPlaceTargets("go", ["build"])).toEqual([])
    expect(BypassLists.inPlaceTargets("cargo", ["fmt"])).toEqual([BypassLists.PROJECT])
    expect(BypassLists.inPlaceTargets("cargo", ["build"])).toEqual([])
    expect(BypassLists.inPlaceTargets("tsc", ["--noEmit"])).toEqual([])
  })
})

describe("the script reader", () => {
  test("reads a script's text as the shell reads a command", () => {
    const reading = ScriptReader.read("tsc && eslint src > out.log", dir)
    expect(reading?.steps.map((step) => step.argv)).toEqual([["tsc"], ["eslint", "src"]])
    expect(reading?.writes).toEqual([path.join(dir, "out.log")])
  })

  test("what it cannot read in full is undefined", () => {
    // 1.1.1 F40 (P56 item 7): only a name outside the read-through list; `NODE_ENV=x tsc` is read (the seam, landed P57).
    expect(ScriptReader.read("NODE_OPTIONS=x tsc", dir)).toBeUndefined()
    expect(ScriptReader.read("case x in y) tsc;; esac", dir)).toBeUndefined()
  })

  test("the allowlist asks it for the script, not for the call alone", async () => {
    const input = await sh("npm run deploy")
    expect(BypassScreen.allowlisted(input, base(input))).toBe(false)
    const build = await sh("npm run build")
    expect(BypassScreen.allowlisted(build, base(build))).toBe(true)
  })
})
