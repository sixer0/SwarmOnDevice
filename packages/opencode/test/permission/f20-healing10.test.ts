// Swarm 1.1.1 F20 (healing loop 10, decision P34): the gate's overlapping checks consolidated, so whole classes close.
// - One physical resolver (`Reach.physical`) for every inside/outside decision, script screen included (CR9-4).
// - Redirect targets are judged where the system opens them, with consent and without (CR9-1, S9-1).
// - One interference rule over the marks of every part of a call, its scripts and an install's hooks (CR9-2, S9-3, S9-4).
// - A `cd` the shell may not take logically keeps 1.1.0 (S9-2); pytest's distributed-execution options keep 1.1.0 (S9-5).
// - The placeholder rule is jest's root-dir token only (CR9-3).
// Every "keeps" case is compared with the no-consent verdict; every redirect case also with the same write made plainly.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ScriptReader } from "../../src/permission/script-reader"
import { ScriptScreen } from "../../src/permission/script-screen"
import type { InstanceContext } from "../../src/project/instance-context"
import { Reach } from "../../src/tool/reach"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { expectBareFrom } from "./install-fixture"
import { ARCHIVE_FIRST, answerOf } from "./consented-literals"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

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
const all = (input: Input) => [base(input), root(input), subagent(input)]

// 1.1.3 (T9 G8, code review M2): the consented verdicts are stated literally, with the agent's answer text; nothing here
// computes them with the code under test (`noWait`, `destinationsOf`).
type Shape = { class: string; category?: string; bypassed?: string; destination?: string; answer?: string }
const RUNS = (bypassed: string): Shape => ({ class: "A", category: "by_main_agent", bypassed })
const REDIRECTED: Shape = { class: "X", category: "not_reversible", bypassed: "not_routine", answer: ARCHIVE_FIRST }
const shape = (verdict: Verdict): Shape => ({
  class: verdict.class,
  category: verdict.category,
  bypassed: verdict.bypassed,
  destination: verdict.destination,
  answer: answerOf(verdict),
})

async function keeps(commands: readonly string[], cwd: string, scope: InstanceContext, expected: Shape, except: Record<string, Shape> = {}) {
  for (const command of commands) {
    const input = await sh(command, cwd, scope)
    const kept = AutonomyTable.classifyBase(input)
    // 1.1.3 (spec section 3 rule 5; matrix rows 3, 8, 16-23, 31): the overlay keeps the 1.1.0 verdict, and under consent
    // that kept verdict no longer waits: a D or P runs as the main agent's, a deletion or replacement is redirected to the
    // archive method at once, an X stays. `expected` states it literally; `except` names the cases that differ.
    expect([command, kept.class]).not.toEqual([command, "A"])
    const want = except[command] ?? expected
    expect([command, shape(root(input))]).toEqual([command, want])
    expect([command, shape(subagent(input))]).toEqual([command, want])
  }
}

async function opens(commands: readonly string[], cwd: string, scope: InstanceContext) {
  for (const command of commands) {
    const input = await sh(command, cwd, scope)
    const verdict = root(input)
    // Which step's category a compound's opened verdict carries follows the tie-break of M1, not this row.
    expect([command, verdict.class, verdict.category]).toEqual([command, "A", opened(base(input)).category])
  }
}

beforeAll(() => ScriptReader.prepare())
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

describe("CR9-4: one physical resolver", () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    dir = await temp()
    outside = await temp()
    fs.mkdirSync(path.join(outside, "a/b"), { recursive: true })
    fs.mkdirSync(path.join(dir, "src"), { recursive: true })
    fs.symlinkSync(path.join(outside, "a/b"), path.join(dir, "lnk"))
    fs.symlinkSync("loop-b", path.join(dir, "loop-a"))
    fs.symlinkSync("loop-a", path.join(dir, "loop-b"))
  })

  test("Reach.physical follows each link before the next step back, and answers a loop with undefined", () => {
    const real = (file: string) => Reach.real(file)!
    expect(Reach.physical("lnk/../x", dir)).toBe(path.join(real(outside), "a/x"))
    expect(Reach.physical("missing/../x", dir)).toBe(path.join(real(dir), "x"))
    expect(Reach.physical(path.join(dir, "src/a.ts"), "/unused")).toBe(path.join(real(dir), "src/a.ts"))
    expect(Reach.physical("lnk/../../x", dir)).toBe(path.join(real(outside), "x"))
    expect(Reach.physical("loop-a/../x", dir)).toBeUndefined()
  })

  test("the script screen and the consent screen give the same landing", () => {
    const place = { roots: [dir], cwd: dir }
    // Beyond the folder through the link, by both: the script screen flags it.
    expect(ScriptScreen.flags('open("lnk/../x","w")', place)).toContain("outside_path")
    expect(ScriptScreen.flags('open("missing/../x","w")', place)).not.toContain("outside_path")
    expect(ScriptScreen.flags(`open("${path.join(dir, "src/a.ts")}","w")`, place)).not.toContain("outside_path")
    // 1.1.0's answer for a loop is kept: nothing is written through one.
    expect(ScriptScreen.flags('open("loop-a/x","w")', place)).not.toContain("outside_path")
  })

  test("the consent screen and the script screen have no resolver of their own", () => {
    const source = (name: string) => fs.readFileSync(path.join(import.meta.dir, "../../src/permission", name), "utf8")
    for (const name of ["bypass-screen.ts", "script-screen.ts"]) {
      expect([name, /\bfunction physical\b|\bconst physical\b/.test(source(name))]).toEqual([name, false])
      expect([name, source(name).includes("lstatSync(next)")]).toEqual([name, false])
    }
    expect(source("bypass-screen.ts")).toContain("Reach.realRoots(lexical)")
    expect(source("bypass-screen.ts")).not.toContain("redirectsBesideChange")
  })

  test("G9-P1: a word with no step back is resolved whole, not one name at a time", () => {
    const deep = path.join(dir, "src", ...Array.from({ length: 20 }, (_, index) => `d${index}`))
    fs.mkdirSync(deep, { recursive: true })
    const expected = path.join(Reach.real(deep)!, "x.ts")
    const before = Reach.realpathLookups()
    expect(Reach.physical(path.join(deep, "x.ts"), "/")).toBe(expected)
    // One question for the whole path and one for the missing file's folder: not one per name.
    expect(Reach.realpathLookups() - before).toBeLessThanOrEqual(2)
  })
})

describe("CR9-1, S9-1: a redirect is judged where the system opens it", () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    dir = await temp()
    outside = await temp()
    await gitInit(dir)
    fs.mkdirSync(path.join(outside, "a/b"), { recursive: true })
    write(dir, "src/a.ts", "x\n")
    write(dir, "node_modules/.bin/prettier", "#!/bin/sh\n")
    write(dir, "package.json", JSON.stringify({ name: "p", scripts: { logs: "prettier --check src/a.ts > lnk/../esc.txt" } }))
    fs.symlinkSync(path.join(outside, "a/b"), path.join(dir, "lnk"))
    // A link inside the project into the repository's own storage.
    fs.symlinkSync(path.join(dir, ".git/hooks"), path.join(dir, "hooks"))
    fs.symlinkSync("loop-b", path.join(dir, "loop-a"))
    fs.symlinkSync("loop-a", path.join(dir, "loop-b"))
  })

  test("the reading keeps every redirect target with a step back as written", async () => {
    const reading = await readSteps("prettier --check src/a.ts > lnk/../esc.txt", dir)
    expect(reading?.upward).toEqual([{ from: dir, to: "lnk/../esc.txt" }])
    expect((await readSteps("prettier --check src/a.ts > log.txt", dir))?.upward).toBeUndefined()
  })

  test("through a link and back up: the same verdict as the plain write to where it lands, with consent and without", async () => {
    const landing = path.join(Reach.real(outside)!, "a/esc.txt")
    for (const [via, plain] of [
      ["prettier --check src/a.ts > lnk/../esc.txt", `prettier --check src/a.ts > ${landing}`],
      ["prettier --check src/a.ts 2> lnk/../esc.txt", `prettier --check src/a.ts 2> ${landing}`],
      ["prettier --check src/a.ts >> lnk/../esc.txt", `prettier --check src/a.ts >> ${landing}`],
      // 1.1.0's own table judged this as an ordinary file of the project (a stricter-only fix of a 1.1.0 defect).
      ["cat src/a.ts > lnk/../esc.txt", `cat src/a.ts > ${landing}`],
      // Into the repository's own storage: as the plain write there.
      ["prettier --check src/a.ts > hooks/../config", "prettier --check src/a.ts > .git/config"],
    ]) {
      const one = await sh(via, dir, gitScope(dir))
      const two = await sh(plain, dir, gitScope(dir))
      expect([via, ...all(one)]).toEqual([via, ...all(two)])
      // 1.1.3 (matrix rows 4, 19, 22, 23): a write held there no longer waits; it runs as the main agent's, recorded with
      // the category it was held on (it was "not A" before 1.1.3).
      expect([via, root(one).class, root(one).category, root(one).bypassed === undefined]).toEqual([via, "A", "by_main_agent", false])
    }
  })

  test("a redirect with a step back inside a project script keeps 1.1.0", async () => {
    await keeps(["npm run logs"], dir, gitScope(dir), RUNS("not_routine"))
  })

  test("a link loop leaves the text to the rules that do not read it step by step", async () => {
    const input = await sh("prettier --check src/a.ts > loop-a/../x.txt", dir, gitScope(dir))
    // Unread, as any text the screen cannot read word by word: held under consent as unreadable. 1.1.3 (matrix row 22): that
    // hold no longer waits; it runs as the main agent's.
    for (const verdict of [root(input), subagent(input)]) expect([verdict.class, verdict.bypassed]).toEqual(["A", "unreadable_command"])
    expect(base(input).class).not.toBe("A")
  })

  test("near misses open: a plain redirect, one into a folder, a step back with no link", async () => {
    await opens(
      ["prettier --check src/a.ts > log.txt", "prettier --check src/a.ts > src/log.txt", "prettier --check src/a.ts > src/../log.txt"],
      dir,
      gitScope(dir),
    )
  })
})

describe("CR9-2, S9-3, S9-4: one interference rule", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    expectBareFrom(path.dirname(dir))
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    for (const bin of ["prettier", "vitest"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
    write(
      dir,
      "package.json",
      JSON.stringify({
        name: "p",
        scripts: {
          sw: "git checkout main",
          both: "git checkout main && prettier --check src/a.ts > log.txt",
          setup: "npm install && prettier --write src/a.ts",
          test: "vitest run",
          build: "tsc --noEmit",
        },
      }),
    )
  })

  test("a tree change made by a script, beside a redirect of the call or inside one script, keeps 1.1.0", async () => {
    await keeps(
      [
        "npm run sw && prettier --check src/a.ts > log.txt",
        "npm run sw; prettier --check src/a.ts >> log.txt",
        "npm run sw || prettier --check src/a.ts > log.txt",
        "(npm run sw) && prettier --check src/a.ts > log.txt",
        "{ npm run sw; prettier --check src/a.ts; } > log.txt",
        "npm run both",
      ],
      dir,
      gitScope(dir),
      RUNS("not_routine"),
    )
  })

  test("an install beside a write, in the call or in its scripts, keeps 1.1.0", async () => {
    await keeps(
      [
        "npm install && prettier --write src/a.ts",
        "npm install && vitest run > log.txt",
        "npm install && mkdir -p build",
        "mkdir -p build && npm install",
        "bun install && touch src/b.ts",
        "npm install && cp src/a.ts src/c.ts",
        "npm run setup",
      ],
      dir,
      gitScope(dir),
      RUNS("not_routine"), { "npm install && cp src/a.ts src/c.ts": REDIRECTED },
    )
  })

  test("near misses open: reads beside a change, a single step's redirect, an install beside tests, builds and scripts", async () => {
    await opens(
      [
        "npm run sw && git status",
        "vitest run > log.txt",
        "git status && prettier --check src/a.ts > log.txt",
        "npm install && npm test",
        "npm install && npm run build",
        "bun install && vitest run",
        "npm install && ls",
      ],
      dir,
      gitScope(dir),
    )
  })

  test("an install whose own hook writes keeps 1.1.0; one whose hooks only check opens (P24)", async () => {
    const writes = await temp()
    expectBareFrom(path.dirname(writes))
    await gitInit(writes)
    write(writes, "src/a.ts", "x\n")
    write(writes, "node_modules/.bin/prettier", "#!/bin/sh\n")
    write(writes, "package.json", JSON.stringify({ name: "w", scripts: { postinstall: "prettier --write src/a.ts" } }))
    await keeps(["npm install"], writes, gitScope(writes), RUNS("not_routine"))
    const checks = await temp()
    expectBareFrom(path.dirname(checks))
    await gitInit(checks)
    write(checks, "package.json", JSON.stringify({ name: "c", scripts: { postinstall: "tsc --noEmit" } }))
    await opens(["npm install"], checks, gitScope(checks))
  })
})

describe("S9-2: a `cd` the shell may not take logically", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    expectBareFrom(path.dirname(dir))
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    write(dir, "node_modules/.bin/vitest", "#!/bin/sh\n")
    write(dir, "package.json", JSON.stringify({ name: "p", scripts: { test: "vitest run", insrc: "cd srclink && vitest run" } }))
    fs.symlinkSync("src", path.join(dir, "srclink"))
  })

  test("the reading keeps every `cd` as written", async () => {
    expect((await readSteps("cd srclink/.. && vitest run", dir))?.chdirs).toEqual([{ from: dir, to: "srclink/.." }])
  })

  test("a folder that does not exist, or a link on the way, keeps 1.1.0, in a call and in a script", async () => {
    await keeps(
      ["cd missing && vitest run", "cd srclink && vitest run", "cd srclink/.. && vitest run", "cd srclink/.. && npm test", "npm run insrc"],
      dir,
      gitScope(dir),
      RUNS("not_routine"),
    )
  })

  test("near misses open: a real folder, a step back with no link", async () => {
    await opens(["cd src && vitest run", "cd src/.. && vitest run", "cd src && cd .. && npm test"], dir, gitScope(dir))
  })

  // 1.1.1 F21: a folder made by an earlier `mkdir` of the same call, exactly as the `cd` names it.
  test("F21: `mkdir` of the very folder, then `cd` into it, opens", async () => {
    write(dir, "node_modules/.bin/tsc", "#!/bin/sh\n")
    write(dir, "package.json", JSON.stringify({ name: "p", scripts: { test: "vitest run", build: "tsc --noEmit", insrc: "cd srclink && vitest run" } }))
    expect(fs.existsSync(path.join(dir, "build"))).toBe(false)
    await opens(
      ["mkdir -p build && cd build && npm run build", "mkdir out && cd out && vitest run", "mkdir -p out/deep && cd out/deep && npm test"],
      dir,
      gitScope(dir),
    )
  })

  test("F21: a different folder, a link or `..` on the way, a tree change in between, or outside the project keeps 1.1.0", async () => {
    const outside = path.join(path.dirname(dir), `f21-out-${path.basename(dir)}`)
    await keeps(
      [
        "mkdir -p other && cd build && npm run build",
        "mkdir -p build/sub && cd build && vitest run",
        "mkdir -p srclink/made && cd srclink/made && vitest run",
        "mkdir -p src/../made && cd src/../made && vitest run",
        "mkdir -p made && cd src/../made && vitest run",
        "mkdir -p build && git checkout -q HEAD && cd build && vitest run",
        "mkdir -p build && git stash && cd build && vitest run",
        "mkdir -p build && ln -s /etc build/x && cd build && vitest run",
        "cd build; mkdir -p build && cd build && vitest run",
        "mkdir -p -m 777 build && cd build && vitest run",
        `mkdir -p ${outside} && cd ${outside} && vitest run`,
      ],
      dir,
      gitScope(dir),
      RUNS("not_routine"),
    )
  })
})

describe("S9-5, CR9-3: pytest's distributed execution, and text that only looks like a placeholder", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    for (const bin of ["vitest", "jest"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
  })

  test("S9-5: execution environments, distribution and copies to them keep 1.1.0, in every spelling", async () => {
    await keeps(
      [
        "pytest --tx ssh=build@host//python=python3", "pytest --tx=popen//python=python2", "pytest --px socket=10.0.0.1:8888",
        "pytest --dist load -n 2", "pytest --dist=each", "pytest --distload", "pytest -d --tx popen", "pytest -vd",
        "pytest --rsyncdir src", "pytest --rsyncignore build", "pytest --t popen", "python3 -m pytest --tx popen",
      ],
      dir,
      gitScope(dir),
      RUNS("not_routine"),
    )
    await opens(["pytest", "pytest -q", "pytest -n auto", "pytest -x -q"], dir, gitScope(dir))
  })

  test("CR9-3: angle-bracketed text in messages and test-name filters opens; jest's root-dir token still keeps", async () => {
    await opens(
      [
        "git commit -m 'feat: add <Button> component'", "vitest run -t '<App> renders'", "jest -t '<Button>'", "git log --format='<%an>'",
      ],
      dir,
      gitScope(dir),
    )
    await keeps(["jest --roots '<rootDir>/../x'", "jest '--rootDir=<rootDir>/..'"], dir, gitScope(dir), RUNS("not_routine"))
  })
})
