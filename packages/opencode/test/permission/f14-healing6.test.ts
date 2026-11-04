// Swarm 1.1.1 F14 (healing loop 6, decisions P20-P26): what the consent still opens after gate 5's findings.
// - G4-2 variant: an option that selects a config or project file, or gives config inline, keeps 1.1.0 (the tool's own
//   default config file excepted).
// - G4-4: jest-style option names are compared as its reader folds them (kebab, camel, snake, all-caps, mixed).
// - G5-1: a package manager's `--` before a local program's options does not hide them.
// - G5-2: an install in a workspace, or with a workspace, filter or folder option, keeps 1.1.0.
// - V5-3: a new branch made at HEAD is not a change of the tree.
// - G5-P3: a step past `MAX_STEP_WORDS` words keeps 1.1.0 without further reading, quickly.
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
import { Reach } from "../../src/tool/reach"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

const write = (relative: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
  fs.writeFileSync(path.join(dir, relative), content)
}

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet().nothrow()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  write("src/a.ts", "x\n")
  // 1.1.1 F15 (S6-1): the default config a near miss names must exist as a file.
  write("tsconfig.json", "{}\n")
  write("mypy.ini", "[mypy]\n")
  write("package.json", JSON.stringify({ scripts: { build: "tsc", test: "vitest run" } }))
  write(".gitignore", "data.db\nlocal/\nnode_modules/\n")
  write("data.db", "rows\n")
  write("local/keep.txt", "k\n")
  // The project's own programs, as `npm exec`, `npx` and `bunx` look them up.
  for (const bin of ["tsc", "prettier"]) write(`node_modules/.bin/${bin}`, "#!/bin/sh\n")
  // G5-2: a workspace root with clean hooks whose member pushes, a clean member, a pnpm workspace, a plain project.
  write("ws/package.json", JSON.stringify({ workspaces: ["pkgs/*"], scripts: { postinstall: "tsc" } }))
  write("ws/pkgs/a/package.json", JSON.stringify({ scripts: { postinstall: "git push" } }))
  write("ws/pkgs/b/package.json", JSON.stringify({ scripts: { postinstall: "tsc" } }))
  write("pws/package.json", JSON.stringify({ scripts: { postinstall: "tsc" } }))
  write("pws/pnpm-workspace.yaml", "packages:\n  - 'pkgs/*'\n")
  write("plain/package.json", JSON.stringify({ scripts: { postinstall: "tsc" } }))
  await ScriptReader.prepare()
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
})

async function sh(command: string, cwd = dir, extra: Partial<Input> = {}): Promise<Input> {
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

async function keeps(commands: readonly string[], cwd = dir) {
  for (const command of commands) {
    const input = await sh(command, cwd)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    expect([command, root(input)]).toEqual([command, before])
    expect([command, subagent(input)]).toEqual([command, before])
  }
}

async function opens(commands: readonly string[], cwd = dir) {
  for (const command of commands) {
    const input = await sh(command, cwd)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    expect([command, root(input)]).toEqual([command, opened(before)])
    expect([command, subagent(input)]).toEqual([command, opened(before)])
  }
}

describe("G4-2 variant: a config or project file chosen on the line, or config inline, keeps 1.1.0", () => {
  test("TypeScript compilers: project and build files, every spelling, response files, a build clean", async () => {
    await keeps([
      "tsc -p other.json", "tsc --project other.json", "tsc -project other.json", "tsc --Project=other.json", "tsc -P other.json",
      "tsc -b other.json", "tsc --build sub/other.json", "tsc -b --clean", "tsc @args.txt", "tsgo -p other.json", "tsgo --build x.json",
    ])
  })

  test("linters, formatters and type checkers: config files and inline config", async () => {
    await keeps([
      "ruff check --config other.toml src", "ruff check --config 'line-length = 100' src", "ruff format --config=x.toml src",
      "mypy --config-file other.ini src", "mypy --config other.ini src", "mypy --conf=other.ini src", "black --config other.toml src",
      "eslint --rule semi:2 src", "eslint --global x src", "eslint --parser-options ecmaVersion:2020 src", "eslint --env browser src",
      // 1.1.1 F15 (n27): inputs only `selectsConfig` holds (the allowlist itself passes them).
      "mypy --config-file sub/other.ini src", "swift test --package-path sub",
    ])
  })

  test("test runners, builders and managers: another root, manifest, module file, package folder or config", async () => {
    await keeps([
      "vitest run --root sub", "vitest run -r sub", "vitest run --configLoader runner", "jest --rootDir sub", "jest --roots sub",
      "cargo build --manifest-path sub/Cargo.toml", "go build -modfile other.mod ./...", "go test -C sub ./...",
      "swift build --package-path sub", "xcodebuild -project X.xcodeproj build", "uv sync --project sub", "poetry install -C sub",
      "bun test --config other.toml", "pnpm install --config.ignore-scripts=false", "npm install --config.foo=bar",
    ])
  })

  test("a place quoted inside a data value is not read as inside", async () => {
    await keeps([`prettier --check '{"a":"/etc/x"}'`, `prettier --check '["~/x"]'`])
  })

  test("near misses: the tool's own default config, and no config option, still open", async () => {
    await opens(["tsc -p tsconfig.json", "tsc -p .", "tsc --project ./tsconfig.json", "tsc -b", "tsc --noEmit", "tsgo -p tsconfig.json"])
    // (`ruff check --config ruff.toml` keeps 1.1.0 anyway: ruff may fix the words it is given, the config's name included.)
    await opens(["mypy --config-file mypy.ini src", "ruff check src", "eslint src", "prettier --check src"])
  })

  test("selectsConfig reads values joined, separate and shortened", () => {
    const file = () => true
    expect(BypassLists.selectsConfig("tsc", ["-p", "tsconfig.json"], file)).toBe(false)
    expect(BypassLists.selectsConfig("tsc", ["--PROJECT", "other.json"], file)).toBe(true)
    // ruff's default name passes this check (the call is then judged by ruff's in-place targets, which keep it anyway).
    expect(BypassLists.selectsConfig("ruff", ["check", "--config=ruff.toml"], file)).toBe(false)
    expect(BypassLists.selectsConfig("ruff", ["check", "--config"], file)).toBe(true)
    expect(BypassLists.selectsConfig("mypy", ["--config-f", "x.ini"], file)).toBe(true)
    expect(BypassLists.selectsConfig("jest", ["--config", "x.js"], file)).toBe(false)
  })
})

describe("G4-4: jest option names in every spelling its reader folds", () => {
  test("snake case, all capitals and mixed kebab of output and code-loading options keep 1.1.0", async () => {
    await keeps([
      "jest --output_file data.db", "jest --OUTPUT-FILE data.db", "jest --Output-File data.db", "jest --OUTPUTFILE=data.db",
      "jest --coverage_directory local", "jest --CACHE_DIRECTORY=local", "jest --setup_files x.ts", "jest --SETUP-FILES x.ts",
      "jest --Global-Setup x.ts", "jest --test_runner x", "jest --CONFIG x.js", "vitest run --output_file data.db", "vitest --SETUP_FILES x.ts",
    ])
  })

  test("near misses: inside the snapshot, and the runner's own options", async () => {
    await opens(["jest --output_file out.json", "jest --OUTPUT-FILE out.json", "jest --watch", "jest --coverage", "jest --ci"])
  })
})

describe("G5-1: a manager's `--` does not hide a local program's options", () => {
  test("an output or write option after the separator is judged", async () => {
    await keeps([
      "npm exec tsc -- --outDir local", "npm exec -- tsc --outDir local", "npx tsc -- --outDir local", "bunx tsc -- --outDir local",
      "npx prettier -- --write local/keep.txt", "npm exec prettier -- --write data.db", "npx tsc -- -p other.json",
    ])
  })

  test("near misses: the same calls writing inside the snapshot open", async () => {
    await opens(["npx tsc -- --outDir out", "npm exec tsc -- --noEmit", "npx prettier -- --write src/a.ts"])
  })

  test("past a `--` every word is a path the formatter writes", () => {
    expect(BypassLists.inPlaceTargets("prettier", ["--write", "--", "--check"])).toEqual(["--check"])
    expect(BypassLists.inPlaceTargets("black", ["--", "--check"])).toEqual(["--check"])
  })
})

describe("G5-2: installs in a workspace, or for other packages, keep 1.1.0", () => {
  test("a root that declares workspaces, its members, and a pnpm workspace", async () => {
    await keeps(["npm install", "yarn", "bun install", "npm ci"], path.join(dir, "ws"))
    await keeps(["npm install"], path.join(dir, "ws/pkgs/b"))
    await keeps(["pnpm install", "pnpm add zod"], path.join(dir, "pws"))
  })

  test("workspace, filter, recursive and folder options", async () => {
    await keeps(
      ["npm install -w a", "npm install --workspace=a", "npm ci --workspaces", "npm i -ws", "pnpm install -r", "pnpm install --filter a", "pnpm add zod -F a", "yarn add zod -W", "npm install --prefix sub"],
      path.join(dir, "plain"),
    )
  })

  test("near miss: a plain project with clean hooks still opens", async () => {
    await opens(["npm install", "pnpm install", "yarn", "bun install"], path.join(dir, "plain"))
  })
})

describe("V5-3: a new branch made at HEAD is no change of the tree", () => {
  test("changesTree", () => {
    for (const argv of [["git", "checkout", "-b", "feat"], ["git", "switch", "-c", "feat"], ["git", "switch", "--create", "feat", "-q"]])
      expect([argv, BypassScreen.changesTree(argv)]).toEqual([argv, false])
    for (const argv of [["git", "checkout", "-b", "feat", "main"], ["git", "switch", "-c", "feat", "origin/main"], ["git", "checkout", "feat"], ["git", "checkout", "-B", "feat"], ["git", "switch", "feat"]])
      expect([argv, BypassScreen.changesTree(argv)]).toEqual([argv, true])
  })

  test("through the table: a new branch beside a script opens; one with a start point keeps 1.1.0", async () => {
    await opens(["git checkout -b feat && npm run build", "git switch -c feat && npm test"])
    await keeps(["git checkout -b feat main && npm run build", "git switch -c feat origin/main && npm test"])
  })
})

describe("G5-P3: a step past MAX_STEP_WORDS keeps 1.1.0 without further reading", () => {
  const unknown = (n: number) => `frobnicate ${Array.from({ length: n }, (_, index) => `w${index}`).join(" ")}`

  test("2,000 words of an unknown program: the 1.1.0 verdict, read no further than the cap", async () => {
    const input = await sh(unknown(2000))
    const before = base(input)
    root(input)
    // 1.1.1 F15 (n32): counters carry the contract; the timing is a log, with a bound only against a hang.
    BypassScreen.counters.manifestReads = 0
    const git = Reach.snapshotGitCalls()
    const started = performance.now()
    const verdict = root(input)
    const ms = performance.now() - started
    expect(verdict).toEqual(before)
    expect(BypassScreen.unclear({ ...input, bypass: { caller: "root" } }, before)).toBe("unreadable")
    expect(BypassScreen.counters.manifestReads).toBe(0)
    expect(Reach.snapshotGitCalls() - git).toBe(0)
    expect(ms).toBeLessThan(2000)
    console.log(`[F14 G5-P3] 2,000 words consented ${ms.toFixed(2)} ms`)
  })

  test("a formatter over more files than the cap keeps 1.1.0; a short unknown call before a risky one still does", async () => {
    const files = Array.from({ length: BypassScreen.MAX_STEP_WORDS + 1 }, () => "src/a.ts")
    await keeps([`prettier --write ${files.join(" ")}`])
    const risky = await sh("frobnicate a b c d rm -rf src")
    expect(BypassScreen.unclear({ ...risky, bypass: { caller: "root" } }, base(risky))).toBe("unknown_then_risky")
  })
})
