// Swarm 1.1.1 F15 (healing loop 7, decisions P26-P28): what the consent still opened after gate 6's findings.
// - S6-1, S6-2: the default-config exception holds only for an existing regular file that lands inside the project.
// - S6-3: a data value (`{...}` or `[...]`) with a backslash does not pass as inside.
// - S6-4: vitest's attachments, HTML coverage, module cache and JSON output options are output options.
// - CR6-1: an install from a folder with no manifest of its own installs at the one above; that keeps 1.1.0.
// - CR6-2: `npx`, `bunx` and `bun x` pass a `--` after the program's name on; both readings must pass.
// - n29, n30: a grep pattern is not a place; `selectsConfig` stops at `--`.
// Each change may only keep a call at its 1.1.0 verdict, so every "keeps" case is compared with the no-consent answer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassLists } from "../../src/permission/bypass-lists"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { ARCHIVE_FIRST, answerOf } from "./consented-literals"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let outside: Awaited<ReturnType<typeof tmpdir>>
let bare: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

const write = (root: string, relative: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true })
  fs.writeFileSync(path.join(root, relative), content)
}

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  outside = await tmpdir()
  bare = await tmpdir()
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet().nothrow()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  write(dir, "src/a.ts", "x\n")
  write(dir, "tsconfig.json", "{}\n")
  write(dir, "sub/tsconfig.json", "{}\n")
  write(dir, "mypy.ini", "[mypy]\n")
  // A folder named like a config file, which tsc would not read as one.
  fs.mkdirSync(path.join(dir, "dirconf/tsconfig.json"), { recursive: true })
  write(dir, ".gitignore", "local/\nnode_modules/\n-data.db\n")
  write(dir, "local/keep.txt", "k\n")
  write(dir, "-data.db", "rows\n")
  for (const bin of ["prettier", "tsc"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
  // Outside the project: a config file, a folder holding one, and a source file.
  write(outside.path, "tsconfig.json", "{}\n")
  write(outside.path, "mypy.ini", "[mypy]\n")
  write(outside.path, "proj/tsconfig.json", "{}\n")
  write(outside.path, "x.ts", "x\n")
  fs.symlinkSync(path.join(outside.path, "tsconfig.json"), path.join(dir, "linked.json"))
  fs.mkdirSync(path.join(dir, "lnk"))
  fs.symlinkSync(path.join(outside.path, "tsconfig.json"), path.join(dir, "lnk/tsconfig.json"))
  fs.symlinkSync(path.join(outside.path, "mypy.ini"), path.join(dir, "lnk/mypy.ini"))
  fs.symlinkSync(path.join(outside.path, "proj"), path.join(dir, "away"))
  // CR6-2: a folder with nothing ignored in it, so the whole folder alone is a target the snapshot covers.
  write(dir, "fmt/a.ts", "x\n")
  fs.symlinkSync(path.join(outside.path, "x.ts"), path.join(dir, "fmt/-link.ts"))
  // CR6-1: the repository top has a manifest whose hook pushes; the project folder `nomani` has none.
  write(dir, "package.json", JSON.stringify({ scripts: { postinstall: "git push origin HEAD" } }))
  fs.mkdirSync(path.join(dir, "nomani/src"), { recursive: true })
  await ScriptReader.prepare()
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
  await outside[Symbol.asyncDispose]()
  await bare[Symbol.asyncDispose]()
})

async function sh(command: string, cwd = dir, scope: InstanceContext = instance): Promise<Input> {
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
  "tsc -p missing/tsconfig.json": [RUNS("not_routine"), undefined],
  "tsc -p dirconf/tsconfig.json": [RUNS("not_routine"), undefined],
  "mypy --config-file missing/mypy.ini src": [RUNS("not_routine"), undefined],
  "tsc -b missing/tsconfig.json": [RUNS("not_routine"), undefined],
  "tsgo --project nowhere/tsconfig.json": [RUNS("not_routine"), undefined],
  "tsc -p lnk/tsconfig.json": [RUNS("not_routine"), undefined],
  "tsc -p away/tsconfig.json": [RUNS("not_routine"), undefined],
  "tsc -b away/tsconfig.json": [RUNS("not_routine"), undefined],
  "mypy --config-file lnk/mypy.ini src": [RUNS("not_routine"), undefined],
  "npm exec tsc -- -p lnk/tsconfig.json": [RUNS("not_routine"), undefined],
  "prettier --check '{\"a\":\"\\/x\"}'": [RUNS("not_routine"), undefined],
  "prettier --check '[\"\\/x\"]'": [RUNS("not_routine"), undefined],
  "prettier --check '{\"a\":\"\\\\x\"}'": [RUNS("not_routine"), undefined],
  "vitest run --attachmentsDir local": [RUNS("not_routine"), undefined],
  "vitest run --attachments-dir=local": [RUNS("not_routine"), undefined],
  "vitest run --ATTACHMENTS_DIR local": [RUNS("not_routine"), undefined],
  "vitest run --coverage.htmlDir local": [RUNS("not_routine"), undefined],
  "vitest run --experimental.fsModuleCachePath local": [RUNS("not_routine"), undefined],
  "vitest bench --outputJson local/b.json": [RUNS("not_routine"), undefined],
  "vitest run --experimental.vcsProvider ./x.js": [RUNS("not_routine"), undefined],
  "npm install": [RUNS("not_routine"), undefined],
  "npm ci": [RUNS("not_routine"), undefined],
  "yarn": [RUNS("not_routine"), undefined],
  "bun install": [RUNS("not_routine"), undefined],
  "pnpm install": [RUNS("not_routine"), undefined],
  "npx prettier --write -- -link.ts": [RUNS("not_routine"), undefined],
  "bunx prettier --write -- -link.ts": [RUNS("not_routine"), undefined],
  "bun x prettier --write -- -link.ts": [RUNS("not_routine"), undefined],
  "npx prettier --write -- -data.db": [RUNS("not_routine"), undefined],
  "bunx prettier --write -- -data.db": [RUNS("not_routine"), undefined],
}
function consentedOf(command: string) {
  expect([command, Object.hasOwn(CONSENTED, command)]).toEqual([command, true])
  return CONSENTED[command]!
}

async function keeps(commands: readonly string[], cwd = dir, scope = instance) {
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

async function opens(commands: readonly string[], cwd = dir, scope = instance) {
  for (const command of commands) {
    const input = await sh(command, cwd, scope)
    const before = base(input)
    expect([command, before.class === "A"]).toEqual([command, false])
    expect([command, root(input)]).toEqual([command, opened(before)])
    expect([command, subagent(input)]).toEqual([command, opened(before)])
  }
}

describe("S6-1, S6-2: the default-config exception needs a real file inside the project", () => {
  test("a default name that is missing, a folder, or inline text keeps 1.1.0", async () => {
    await keeps([
      "tsc -p missing/tsconfig.json", "tsc -p dirconf/tsconfig.json", "mypy --config-file missing/mypy.ini src",
      "tsc -b missing/tsconfig.json", "tsgo --project nowhere/tsconfig.json",
    ])
  })

  test("a default name reached through a link to outside keeps 1.1.0", async () => {
    await keeps([
      "tsc -p lnk/tsconfig.json", "tsc -p away/tsconfig.json", "tsc -b away/tsconfig.json", "mypy --config-file lnk/mypy.ini src",
      // 1.1.1 F17 (n33): through `npm exec`, which hands `-p` to the program, so the link is what keeps it (npx refuses
      // any `-p` before the config check is reached).
      "npm exec tsc -- -p lnk/tsconfig.json",
    ])
  })

  test("near misses: the real default file inside the project still opens", async () => {
    await opens([
      "tsc -p tsconfig.json", "tsc -p .", "tsc -p sub/tsconfig.json", "tsc -b sub/tsconfig.json", "mypy --config-file mypy.ini src",
      "npm exec tsc -- -p tsconfig.json",
    ])
  })

  test("selectsConfig: inline text never qualifies, and the file check decides", () => {
    const yes = () => true
    const no = () => false
    expect(BypassLists.selectsConfig("tsc", ["-p", "tsconfig.json"], no)).toBe(true)
    expect(BypassLists.selectsConfig("tsc", ["-p", "."], no)).toBe(true)
    expect(BypassLists.selectsConfig("tsc", ["-p", "tsconfig.json"], yes)).toBe(false)
    for (const value of ["a = 1 # x/mypy.ini", "x\n/mypy.ini", "'x'/mypy.ini"])
      expect([value, BypassLists.selectsConfig("mypy", ["--config-file", value], yes)]).toEqual([value, true])
    // The file asked about for tsc's `.` is its tsconfig.json.
    const asked: string[] = []
    BypassLists.selectsConfig("tsc", ["-p", "."], (file) => (asked.push(file), true))
    expect(asked).toEqual(["tsconfig.json"])
  })
})

describe("S6-3: a data value with a backslash is not read as inside", () => {
  test("escaped places inside braces or brackets keep 1.1.0", async () => {
    // 1.1.1 F17 (n35): each holds a backslash and no quote directly before a place, so only S6-3 keeps it.
    await keeps([String.raw`prettier --check '{"a":"\/x"}'`, String.raw`prettier --check '["\/x"]'`, String.raw`prettier --check '{"a":"\\x"}'`])
  })

  test("near miss: a data value with no backslash and no place still opens", async () => {
    await opens([`prettier --check '{"a":"b"}'`])
  })
})

describe("S6-4: vitest's other output options are output options", () => {
  test("into an ignored folder they keep 1.1.0, in every spelling the reader folds", async () => {
    await keeps([
      "vitest run --attachmentsDir local", "vitest run --attachments-dir=local", "vitest run --ATTACHMENTS_DIR local",
      "vitest run --coverage.htmlDir local", "vitest run --experimental.fsModuleCachePath local", "vitest bench --outputJson local/b.json",
    ])
  })

  test("a module that names changed files is code and keeps 1.1.0", async () => {
    await keeps(["vitest run --experimental.vcsProvider ./x.js"])
  })

  test("near miss: an attachments folder inside the snapshot opens", async () => {
    await opens(["vitest run --attachmentsDir out"])
  })
})

describe("CR6-1: an install from a folder with no manifest installs at the one above", () => {
  test("with git: the project folder has no manifest, the repository top has one", async () => {
    const scope = { directory: path.join(dir, "nomani"), worktree: dir, project: { vcs: "git" } } as InstanceContext
    for (const cwd of [scope.directory, path.join(scope.directory, "src")])
      await keeps(["npm install", "npm ci", "yarn", "bun install", "pnpm install"], cwd, scope)
  })

  test("without git: a manifest above the project folder keeps 1.1.0", async () => {
    const scope = { directory: path.join(dir, "nomani"), worktree: "/", project: { vcs: undefined } } as unknown as InstanceContext
    await keeps(["npm install", "npm ci", "yarn", "bun install", "pnpm install"], scope.directory, scope)
  })

  // 1.1.1 F17 (P30): superseded. With no manifest anywhere npm installs in the folder itself, which now keeps 1.1.0;
  // the near misses that open are in f17-healing8.
  test("with no manifest anywhere above, the install keeps 1.1.0 (F17, P30)", async () => {
    let up = path.dirname(bare.path)
    for (; path.dirname(up) !== up; up = path.dirname(up)) expect([up, fs.existsSync(path.join(up, "package.json"))]).toEqual([up, false])
    const scope = { directory: bare.path, worktree: "/", project: { vcs: undefined } } as unknown as InstanceContext
    await keeps(["npm install"], bare.path, scope)
  })
})

describe("CR6-2: a `--` after the program's name reaches the program", () => {
  test("a dash-led file past it that links outside keeps 1.1.0", async () => {
    const fmt = path.join(dir, "fmt")
    await keeps(["npx prettier --write -- -link.ts", "bunx prettier --write -- -link.ts", "bun x prettier --write -- -link.ts"], fmt)
    // Ignored, outside the snapshot: kept by both readings (the folder alone holds it too).
    await keeps(["npx prettier --write -- -data.db", "bunx prettier --write -- -data.db"])
  })

  test("near misses: a plain file past it opens; `npm exec` keeps its single reading", async () => {
    const fmt = path.join(dir, "fmt")
    await opens(["npx prettier --write -- a.ts", "bunx prettier --write -- a.ts", "bun x prettier --write -- a.ts"], fmt)
    await opens(["npm exec prettier -- --write src/a.ts"])
  })
})

describe("n29, n30: a pattern is not a place; options stop at `--`", () => {
  test("grep with a slash-led pattern joined to -e opens as before F14", async () => {
    await opens(["grep -e/usr/ -r src"])
  })

  test("selectsConfig does not read past `--`", () => {
    expect(BypassLists.selectsConfig("tsc", ["--noEmit", "--", "-p", "x.json"], () => true)).toBe(false)
    expect(BypassLists.selectsConfig("tsc", ["-p", "x.json", "--"], () => true)).toBe(true)
  })
})
