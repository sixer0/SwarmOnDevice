// Swarm 1.1.1 F12a (healing loop 5, decisions P20-P23): what the consent opens of scripts, installs and tool options.
// - S4-1: a step that can change the working tree or HEAD beside a step that runs a project script keeps 1.1.0.
// - S4-3: package-manager option shorthands are expanded before the other-folder check.
// - S4-4 / S4-5: output options in kebab case or camelCase, and combined short write options, are judged.
// - V4-1 (m32): an install opens only when the manifest's install lifecycle scripts pass the script check.
// - P1 (m28): one classify reads a manifest once and examines at most `MAX_SCRIPT_STEPS` script steps.
// - m25: `touch` and `mkdir` targets are resolved through links.
// - F12b routing: a redirect into a tool's config file keeps 1.1.0, with or without Undo.
// Each change may only keep a call at its 1.1.0 verdict.

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
import { ARCHIVE_FIRST, answerOf } from "./consented-literals"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let outside: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

// 1.1.1 F14 (n23): one more fan-out than the step budget allows (each level is read once: 3 texts of n steps).
const OVER = Math.floor(BypassScreen.MAX_SCRIPT_STEPS / 3) + 1

const SCRIPTS = {
  build: "tsc",
  lint: "eslint src",
  test: "vitest run",
  ci: "npm run build && npm run lint",
  // S4-1 inside a script and across its hooks
  swbuild: "git checkout dev && npm run build",
  stashbuild: "git stash pop && npm run build",
  merged: "git merge dev; npm test",
  swonly: "git switch dev",
  prechk: "git stash pop",
  chk: "npm run build",
  // fine: the change does not sit beside a script run
  tidy: "git switch dev && tsc",
}

const fan = (n: number) => ({
  scripts: {
    s0: Array.from({ length: n }, () => "npm run s1").join(" && "),
    s1: Array.from({ length: n }, () => "npm run s2").join(" && "),
    s2: Array.from({ length: n }, () => "tsc --noEmit").join(" && "),
  },
})

const write = (relative: string, content: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true })
  fs.writeFileSync(path.join(dir, relative), content)
}

beforeAll(async () => {
  fixture = await tmpdir({ git: true })
  outside = await tmpdir()
  dir = fixture.path
  await $`git config --unset core.fsmonitor && git config --unset commit.gpgsign`.cwd(dir).quiet().nothrow()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  write("src/a.ts", "x\n")
  write("package.json", JSON.stringify({ scripts: SCRIPTS }))
  write(".gitignore", "data.db\nlocal/\n")
  write("data.db", "rows\n")
  write("local/keep.txt", "k\n")
  // Install lifecycle fixtures: one folder per hook that runs something unrecognised, a clean one, and near misses.
  for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"])
    write(`hooks/${hook}/package.json`, JSON.stringify({ scripts: { [hook]: "frobnicate" } }))
  write("inst/clean/package.json", JSON.stringify({ scripts: { postinstall: "tsc", prepare: "tsc --noEmit" } }))
  write("inst/other/package.json", JSON.stringify({ scripts: { postbuild: "frobnicate", build: "tsc" } }))
  write("inst/none/package.json", JSON.stringify({ name: "none" }))
  write("inst/push/package.json", JSON.stringify({ scripts: { postinstall: "git push" } }))
  write("inst/number/package.json", JSON.stringify({ scripts: { prepare: 7 } }))
  write("inst/broken/package.json", "{ scripts: ")
  write("inst/switch/package.json", JSON.stringify({ scripts: { postinstall: "git switch dev && npm run build", build: "tsc" } }))
  for (const n of [3, 40]) write(`fan${n}/package.json`, JSON.stringify(fan(n)))
  write("fanOver/package.json", JSON.stringify(fan(OVER)))
  // m25: a link inside the project to a folder outside it.
  fs.symlinkSync(outside.path, path.join(dir, "outlink"))
  await ScriptReader.prepare()
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
  await outside[Symbol.asyncDispose]()
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

// 1.1.3 (T9 G8, code review M2): the consented verdict and the agent's answer of each case, written out, not computed with
// `noWait`. A D or P the overlay keeps runs as the main agent's (`RUNS`, bypassed = its 1.1.0 category); a deletion or
// replacement nothing archives is redirected at once (`ARCHIVED`, ARCHIVE_FIRST).
const RUNS = (bypassed: string, destination?: string) =>
  ({ class: "A", decidedBy: "agent", category: "by_main_agent", bypassed, ...(destination && { destination }) }) as Verdict
const ARCHIVED = (bypassed: string) => ({ class: "X", decidedBy: "gate", category: "not_reversible", bypassed }) as Verdict
const CONSENTED: Record<string, readonly [Verdict, string | undefined]> = {
  "npm run swbuild": [RUNS("not_routine"), undefined],
  "npm run stashbuild": [RUNS("not_routine"), undefined],
  "npm run merged": [RUNS("not_routine"), undefined],
  "npm run chk": [RUNS("not_routine"), undefined],
  "npm install": [RUNS("not_routine"), undefined],
  "git checkout dev && npm run build": [RUNS("not_routine"), undefined],
  "git switch dev; npm test": [RUNS("not_routine"), undefined],
  "npm run swonly && npm run build": [RUNS("not_routine"), undefined],
  "npm run build -ws": [RUNS("not_routine"), undefined],
  "npm run build --ws": [RUNS("not_routine"), undefined],
  "npm run build -iwr": [RUNS("not_routine"), undefined],
  "npm run build --iwr": [RUNS("not_routine"), undefined],
  "npm run build -sw": [RUNS("not_routine"), undefined],
  "npm test -ws": [RUNS("not_routine"), undefined],
  "npm test --workspaces=true": [RUNS("not_routine"), undefined],
  "npm run build -w pkg": [RUNS("not_routine"), undefined],
  "npm run build --prefix=sub": [RUNS("not_routine"), undefined],
  "pnpm run build --filter-prod x": [RUNS("not_routine"), undefined],
  "pnpm build -rs": [RUNS("not_routine"), undefined],
  "pnpm test -r": [RUNS("not_routine"), undefined],
  "npm run build --loglevel silent": [RUNS("not_routine"), undefined],
  "npm i -sg foo": [RUNS("not_routine"), undefined],
  "vitest run --output-file data.db": [RUNS("not_routine"), undefined],
  "vitest run --outputFile.json=data.db": [RUNS("not_routine"), undefined],
  "vitest run --output-file.junit=data.db": [RUNS("not_routine"), undefined],
  "vitest run --coverage.reports-directory=local": [RUNS("not_routine"), undefined],
  "jest --output-file data.db": [RUNS("not_routine"), undefined],
  "jest --coverage-directory local": [RUNS("not_routine"), undefined],
  "jest --cache-directory=local": [RUNS("not_routine"), undefined],
  "vitest --global-setup x.ts": [RUNS("not_routine"), undefined],
  "vitest --setup-files x.ts": [RUNS("not_routine"), undefined],
  "vitest --pool-options.threads=x": [RUNS("not_routine"), undefined],
  "jest --setup-files-after-env x.ts": [RUNS("not_routine"), undefined],
  "jest --test-runner x": [RUNS("not_routine"), undefined],
  "prettier -lw .": [RUNS("not_routine"), undefined],
  "prettier -wl data.db": [RUNS("not_routine"), undefined],
  "prettier -uw local": [RUNS("not_routine"), undefined],
  "npm i": [RUNS("not_routine"), undefined],
  "npm ci": [RUNS("not_routine"), undefined],
  "pnpm install": [RUNS("not_routine"), undefined],
  "pnpm add foo": [RUNS("not_routine"), undefined],
  "yarn": [RUNS("not_routine"), undefined],
  "yarn add foo": [RUNS("not_routine"), undefined],
  "bun install": [RUNS("not_routine"), undefined],
  "bun add foo": [RUNS("not_routine"), undefined],
  "npm run s0": [RUNS("not_routine"), undefined],
  "touch outlink/x": [RUNS("not_routine"), undefined],
  "mkdir -p outlink/new": [RUNS("not_routine"), undefined],
  "mkdir outlink/deep/new": [RUNS("not_routine"), undefined],
  "tsc --noEmit > vitest.config.ts": [RUNS("sensitive_file"), undefined],
  "tsc --noEmit > tsconfig.json": [RUNS("not_routine"), undefined],
}
function consentedOf(command: string) {
  expect([command, Object.hasOwn(CONSENTED, command)]).toEqual([command, true])
  return CONSENTED[command]!
}

async function keeps(commands: readonly string[], cwd = dir, extra: Partial<Input> = {}) {
  for (const command of commands) {
    const input = await sh(command, cwd, extra)
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

async function opens(commands: readonly string[], cwd = dir, extra: Partial<Input> = {}) {
  for (const command of commands) {
    const input = await sh(command, cwd, extra)
    const before = base(input)
    // 1.1.1 F14 (n24): a case that is A without consent proves nothing about the overlay.
    expect([command, before.class === "A"]).toEqual([command, false])
    const expected = opened(before)
    expect([command, root(input)]).toEqual([command, expected])
    expect([command, subagent(input)]).toEqual([command, expected])
  }
}

describe("S4-1: a change of the tree or HEAD beside a project script keeps 1.1.0", () => {
  test("inside a script, and across a script's hooks", async () => {
    await keeps(["npm run swbuild", "npm run stashbuild", "npm run merged", "npm run chk"])
    await opens(["npm run swonly", "npm run tidy", "npm run ci", "npm run build"])
  })

  test("an install whose lifecycle script switches the branch and then runs a script", async () => {
    await keeps(["npm install"], path.join(dir, "inst/switch"))
  })

  test("the whole call: sequenceKeeps sees a change beside a script run, before or after", async () => {
    for (const command of ["git checkout dev && npm run build", "git switch dev; npm test", "git stash pop && npm run build", "npm run build | git checkout dev", "npm run swonly && npm run build"])
      expect([command, BypassScreen.sequenceKeeps({ ...(await sh(command)), bypass: { caller: "root" } })]).toEqual([command, true])
    for (const command of ["npm run build && git status", "npm run build && npm run lint", "git switch dev && tsc", "npm install", "npm run build", "npm ci && npm test"])
      expect([command, BypassScreen.sequenceKeeps({ ...(await sh(command)), bypass: { caller: "root" } })]).toEqual([command, false])
  })

  // 1.1.1 F14 (V5-2, n22): the seam is in place, so this is a plain test: removing it fails here instead of skipping.
  test("the whole call, through the table", async () => {
    await keeps(["git checkout dev && npm run build", "git switch dev; npm test", "npm run swonly && npm run build"])
    // 1.1.1 P24: an install beside the tests is ordinary work and opens.
    await opens(["npm run build && git status", "npm ci && npm test"])
  })

  test("changesTree names the forms that change tracked files or HEAD, and no others", () => {
    for (const argv of [["git", "checkout", "x"], ["git", "-C", "a", "switch", "x"], ["git", "stash"], ["git", "stash", "pop"], ["git", "pull"], ["git", "reset", "--hard"], ["git", "rebase", "main"], ["git", "am", "p.patch"], ["git", "apply", "p.diff"]])
      expect([argv, BypassScreen.changesTree(argv)]).toEqual([argv, true])
    // 1.1.1 P24: an install fills the dependency folder, not the manifest's scripts.
    for (const argv of [["npm", "ci"], ["yarn"], ["pnpm", "add", "x"], ["bun", "install"], ["pip", "install", "x"], ["git", "status"], ["git", "stash", "list"], ["git", "stash", "show"], ["git", "commit", "-m", "x"], ["npm", "run", "build"], ["npm", "test"], ["tsc"]])
      expect([argv, BypassScreen.changesTree(argv)]).toEqual([argv, false])
  })
})

describe("S4-3: manager shorthands are the options they stand for", () => {
  test("npm and pnpm workspace and folder shorthands keep 1.1.0", async () => {
    await keeps([
      "npm run build -ws", "npm run build --ws", "npm run build -iwr", "npm run build --iwr", "npm run build -sw", "npm test -ws",
      "npm test --workspaces=true", "npm run build -w pkg", "npm run build --prefix=sub", "pnpm run build --filter-prod x", "pnpm build -rs",
      "pnpm test -r", "npm run build --loglevel silent", "npm i -sg foo",
    ])
  })

  test("near misses: the harmless options still open", async () => {
    await opens(["npm run -s build", "npm run build --silent", "npm run --if-present build", "bun run build --pretty", "npm run build -- --noEmit"])
  })

  test("expandManagerOptions reads as the managers' readers do", () => {
    expect(BypassLists.expandManagerOptions("npm", ["run", "-ws", "--ws", "-iwr", "-sw", "-C=x", "--silent"])).toEqual([
      "run", "--workspaces", "--workspaces", "--include-workspace-root", "--silent", "--workspace", "--prefix=x", "--silent",
    ])
    expect(BypassLists.expandManagerOptions("pnpm", ["-rs", "-F", "x", "--r"])).toEqual(["--recursive", "--silent", "--filter", "x", "--recursive"])
    // yarn and bun take no two-dash shorthand.
    expect(BypassLists.expandManagerOptions("yarn", ["--W", "-W"])).toEqual(["--W", "--ignore-workspace-root-check"])
  })
})

describe("S4-4 / S4-5: output and write options in every spelling", () => {
  test("kebab case and camelCase output options are judged, sub-options included", async () => {
    await keeps([
      "vitest run --output-file data.db", "vitest run --outputFile.json=data.db", "vitest run --output-file.junit=data.db",
      "vitest run --coverage.reports-directory=local", "jest --output-file data.db", "jest --coverage-directory local", "jest --cache-directory=local",
    ])
    await opens(["vitest run --output-file out.json", "vitest run --outputFile out.json", "jest --outputFile out.json"])
  })

  test("kebab-case spellings of options that load code keep 1.1.0", async () => {
    await keeps(["vitest --global-setup x.ts", "vitest --setup-files x.ts", "vitest --pool-options.threads=x", "jest --setup-files-after-env x.ts", "jest --test-runner x"])
  })

  test("combined short options with the write letter are a write", async () => {
    await keeps(["prettier -lw .", "prettier -wl data.db", "prettier -uw local"])
    await opens(["prettier -l src", "prettier -c .", "prettier -lw src"])
  })
})

describe("V4-1 (m32): an install opens only when its lifecycle scripts pass", () => {
  const forms = ["npm install", "npm i", "npm ci", "pnpm install", "pnpm add foo", "yarn", "yarn add foo", "bun install", "bun add foo"]

  test("every manager and every hook: an unrecognised hook keeps 1.1.0", async () => {
    for (const hook of ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"])
      await keeps(forms, path.join(dir, "hooks", hook))
  })

  test("a hook that pushes, a hook that is no text, a manifest that cannot be read keep 1.1.0", async () => {
    for (const folder of ["push", "number", "broken"]) await keeps(["npm install", "yarn"], path.join(dir, "inst", folder))
  })

  test("near misses: clean hooks, no install hook, no scripts at all", async () => {
    for (const folder of ["clean", "other", "none"]) await opens(forms, path.join(dir, "inst", folder))
  })
})

describe("P1 (m28): one classify reads each manifest once and is bounded", () => {
  test("npm run ci reads the manifest once", async () => {
    const input = await sh("npm run ci")
    BypassScreen.counters.manifestReads = 0
    expect(root(input).class).toBe("A")
    expect(BypassScreen.counters.manifestReads).toBe(1)
  })

  test("a wide fan-out: 3 and 40 open with one read, one past the step budget keeps 1.1.0", async () => {
    await opens(["npm run s0"], path.join(dir, "fan3"))
    const wide = await sh("npm run s0", path.join(dir, "fan40"))
    BypassScreen.counters.manifestReads = 0
    const started = performance.now()
    expect(root(wide)).toEqual(opened(base(wide)))
    const took = performance.now() - started
    expect(BypassScreen.counters.manifestReads).toBe(1)
    // Measured at about 5-15 ms here; the bound leaves room for a loaded machine (469 ms before F12a, gate-4 review P1).
    expect(took).toBeLessThan(150)
    await keeps(["npm run s0"], path.join(dir, "fanOver"))
    const over = await sh("npm run s0", path.join(dir, "fanOver"))
    const again = performance.now()
    root(over)
    expect(performance.now() - again).toBeLessThan(150)
  })
})

describe("m25: touch and mkdir targets through a link", () => {
  test("a link to outside keeps 1.1.0; a plain folder inside opens", async () => {
    await keeps(["touch outlink/x", "mkdir -p outlink/new", "mkdir outlink/deep/new"])
    const plain = await sh("mkdir -p src/new")
    expect(root(plain)).toEqual(opened(base(plain)))
  })
})

describe("F12b routing: a redirect into a tool's config keeps 1.1.0", () => {
  test("with Undo and without it", async () => {
    await keeps(["tsc --noEmit > vitest.config.ts", "tsc --noEmit > tsconfig.json"])
    // Without Undo the overlay keeps the call held (its held category can differ: the compound's tie-break, not F12a).
    // 1.1.3 (matrix rows 7, 22, spec section 3 rule 5): that hold no longer waits; it runs as the main agent's.
    const noUndo = await sh("tsc --noEmit > vitest.config.ts", dir, { canUndo: false })
    expect(base(noUndo).class).toBe("D")
    expect(root(noUndo)).toMatchObject({ class: "A", category: "by_main_agent" })
    expect(subagent(noUndo)).toMatchObject({ class: "A", category: "by_main_agent" })
    await opens(["tsc --noEmit > src/types.log"])
  })
})
