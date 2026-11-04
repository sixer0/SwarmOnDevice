// Swarm 1.1.1 F22 (healing loop 11, decision P37): the physical-path consolidation finished, and the gate-10 comments.
// - A tool's own output option, a formatter's in-place target and a config file it names are judged where the system
//   opens them (`Reach.physical`), as redirects are since F20 (P37, S9-1).
// - The reader keeps each `cd` and each redirect with a `..` once (CR10-1). Since F25 (CR11-1) more distinct redirects
//   with a `..` than are judged leave the reading unread, and a reading with too many `cd`s is held with consent.
// - `mkdir` then `cd` inside a script of a project opened by a link name opens as it does at call level (CR10-2).
// - Each F21 guard has a case that turns into an opener when the guard is removed (CR10-3), and the invariant a link made
//   before the `mkdir` rests on is pinned (n56).
// - Counters for the three performance nits (G10-P1..P3).
// Every "keeps" case is compared with the no-consent verdict for the root and a subagent.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { Reach } from "../../src/tool/reach"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"
import { expectBareFrom } from "./install-fixture"

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

const input = (command: string, cwd: string, scope: InstanceContext, steps: unknown): Input => ({
  permission: "bash",
  patterns: [command],
  metadata: { command, ...(steps ? { steps } : {}) },
  instance: scope,
  cwd,
  canUndo: true,
  folder: "clean",
})

const sh = async (command: string, cwd: string, scope: InstanceContext) => input(command, cwd, scope, await readSteps(command, cwd))

const base = (given: Input) => AutonomyTable.classify(given)
const root = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "root" } })
const subagent = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "subagent" } })
const opened = (verdict: Verdict): Verdict =>
  verdict.class === "A" ? verdict : { class: "A", decidedBy: "agent", category: "by_main_agent", bypassed: verdict.category }

async function keeps(commands: readonly string[], cwd: string, scope: InstanceContext) {
  for (const command of commands) {
    const given = await sh(command, cwd, scope)
    const kept = AutonomyTable.classifyBase(given)
    expect([command, kept.class]).not.toEqual([command, "A"])
    expect([command, root(given)]).toEqual([command, kept])
    expect([command, subagent(given)]).toEqual([command, kept])
  }
}

async function opens(commands: readonly string[], cwd: string, scope: InstanceContext) {
  for (const command of commands) {
    const given = await sh(command, cwd, scope)
    const verdict = root(given)
    expect([command, verdict.class, verdict.category]).toEqual([command, "A", opened(base(given)).category])
  }
}

beforeAll(() => ScriptReader.prepare())
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

describe("P37 (S9-1): output options, in-place targets and named config files are judged where they land", () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    dir = await temp()
    outside = await temp()
    await gitInit(dir)
    fs.mkdirSync(path.join(outside, "a/b"), { recursive: true })
    fs.mkdirSync(path.join(dir, ".git/hooks"), { recursive: true })
    write(dir, "src/a.ts", "x\n")
    write(dir, "src/deep/b.ts", "x\n")
    write(dir, "tsconfig.json", "{}\n")
    for (const bin of ["eslint", "prettier", "tsc", "vitest"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
    // In-project links: one into the repository's own storage, one to a folder outside, one to a folder of the project.
    fs.symlinkSync(path.join(dir, ".git/hooks"), path.join(dir, "hk"))
    fs.symlinkSync(path.join(outside, "a/b"), path.join(dir, "ol"))
    fs.symlinkSync(path.join(dir, "src/deep"), path.join(dir, "sl"))
    fs.symlinkSync("loop-b", path.join(dir, "loop-a"))
    fs.symlinkSync("loop-a", path.join(dir, "loop-b"))
    // 1.1.1 F25 (CR11-4): links to folders inside an ignored folder, which Undo's snapshot leaves out. A step back through
    // one lands inside the project (so the argument check lets it through) but outside the snapshot: only the landing
    // check of the target itself keeps these.
    write(dir, ".gitignore", "local/\n")
    fs.mkdirSync(path.join(dir, "local/inner/deeper"), { recursive: true })
    fs.symlinkSync(path.join(dir, "local/inner"), path.join(dir, "ig"))
    fs.symlinkSync(path.join(dir, "local/inner/deeper"), path.join(dir, "ig2"))
  })

  test("an output option that steps back through a link into repository storage or out of the snapshot keeps 1.1.0", async () => {
    await keeps(
      [
        "eslint src -o hk/../config",
        "eslint src --output-file=hk/../config",
        "eslint src --output-file hk/../description",
        "eslint src -o ig/../report.txt",
        "tsc --outDir hk/../objects",
        "tsc --outDir ig/../build",
        "vitest run --outputFile=hk/../config",
        "vitest run --outputFile=ig/../r.json",
        "eslint src -o ig2/../r.txt",
      ],
      dir,
      gitScope(dir),
    )
  })

  test("an in-place target that steps back through a link into repository storage or out of the snapshot keeps 1.1.0", async () => {
    await keeps(
      [
        "prettier --write hk/../config",
        // The pattern's folder is judged where it lands (the glob arm of `targetOpens`).
        "prettier --write 'hk/../hooks/*.sh'",
        "prettier --write ig/../x.ts",
        "prettier --write 'ig/../inner/**/*.ts'",
        "eslint --fix hk/../config",
        "prettier --write src/a.ts hk/../description",
        "prettier --write ig2/../x.ts",
      ],
      dir,
      gitScope(dir),
    )
  })

  // 1.1.1 F25 (CR11-4): a step back through a link that leads out, or through a loop, is refused as an argument word
  // (`staysInside`) before the target checks are reached; these pin that check, not `targetOpens`.
  test("an argument word that steps back through a link out of the project, or through a loop, keeps 1.1.0", async () => {
    await keeps(
      [
        "eslint src -o ol/../report.txt",
        "tsc --outDir ol/../build",
        "vitest run --outputFile=ol/../r.json",
        "eslint src -o loop-a/../r.txt",
        "prettier --write ol/../x.ts",
        "prettier --write 'ol/../**/*.ts'",
        "prettier --write loop-a/../x.ts",
        "tsc -p ol/../tsconfig.json --noEmit",
      ],
      dir,
      gitScope(dir),
    )
  })

  test("a link made where a step back leads out is held as a write outside", async () => {
    const given = await sh("ln -s src/a.ts ol/../y", dir, gitScope(dir))
    expect(root(given).category).toBe("outside_write_held")
    expect(subagent(given).category).toBe("outside_write_held")
  })

  test("a config file named through a link and back up is judged where it lands", async () => {
    await keeps(["tsc -p hk/../tsconfig.json --noEmit", "tsc -p ig/../tsconfig.json --noEmit"], dir, gitScope(dir))
    await opens(["tsc -p tsconfig.json --noEmit", "tsc -p src/../tsconfig.json --noEmit"], dir, gitScope(dir))
  })

  test("near misses open: plain in-project targets, a step back with no link, a link whose step back stays inside", async () => {
    await opens(
      [
        "eslint src -o report.txt",
        "eslint src -o src/../report.txt",
        "tsc --outDir build",
        "vitest run --outputFile=out/r.json",
        "prettier --write src/a.ts",
        "prettier --write src/../src/a.ts",
        "prettier --write 'src/**/*.ts'",
        "prettier --write sl/../a.ts",
        "eslint src -o sl/../report.txt",
      ],
      dir,
      gitScope(dir),
    )
  })
})

describe("CR10-1: repeated places are read once, and an over-long list keeps the 1.1.0 reading", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    for (let index = 0; index < 201; index++) fs.mkdirSync(path.join(dir, `d${index}`), { recursive: true })
  })

  test("the reader keeps each `cd` and each redirect with a `..` once", async () => {
    const reading = await readSteps("cd src && cd .. && cd src && cd .. && ls", dir)
    expect(reading?.chdirs).toEqual([
      { from: dir, to: "src" },
      { from: path.join(dir, "src"), to: ".." },
    ])
    const twice = await readSteps("ls > src/../x.txt; ls > src/../x.txt; ls >> src/../x.txt", dir)
    expect(twice?.upward).toEqual([{ from: dir, to: "src/../x.txt" }])
  })

  test("a `cd` the text repeats 201 times is two places: the 1.1.0 answer stands without consent", async () => {
    const command = `${"cd src && cd .. && ".repeat(201)}ls`
    const given = await sh(command, dir, gitScope(dir))
    expect((given.metadata.steps as { chdirs: unknown[] }).chdirs).toHaveLength(2)
    const without = input(command, dir, gitScope(dir), { ...(given.metadata.steps as object), chdirs: undefined })
    expect(base(given)).toEqual(base(without))
    expect(base(given).class).toBe("A")
  })

  // 1.1.1 F25 (CR11-1): with consent such a reading is held, never given 1.1.0's A (rule 3b).
  test("more distinct `cd`s than are judged: 1.1.0's reading without consent, held with it", async () => {
    const command = `${Array.from({ length: 201 }, (_, index) => `cd d${index} && cd .. && `).join("")}ls`
    const given = await sh(command, dir, gitScope(dir))
    expect((given.metadata.steps as { chdirs: unknown[] }).chdirs.length).toBeGreaterThan(400)
    const without = input(command, dir, gitScope(dir), { ...(given.metadata.steps as object), chdirs: undefined })
    expect(base(given)).toEqual(base(without))
    expect(AutonomyTable.shellReading(given.metadata.steps, gitScope(dir))?.complete).toBe(false)
    expect(AutonomyTable.classifyBase(given).class).toBe("A")
    expect([root(given).class, root(given).category]).toEqual(["D", "unreadable_command"])
    expect([subagent(given).class, subagent(given).category]).toEqual(["D", "unreadable_command"])
  })

  // 1.1.1 F25 (CR11-1): a landing is a safety fact in both modes, so this reading is unread, as before F22.
  test("more distinct redirects with a `..` than are judged: unread, and held with consent", async () => {
    const command = `ls ${Array.from({ length: 401 }, (_, index) => `> src/../o${index}.txt`).join(" ")}`
    const given = await sh(command, dir, gitScope(dir))
    expect((given.metadata.steps as { upward: unknown[] }).upward.length).toBe(401)
    expect(AutonomyTable.shellReading(given.metadata.steps, gitScope(dir))).toBeUndefined()
    expect(base(given).class).not.toBe("A")
    expect([root(given).class, root(given).category]).toEqual(["D", "unreadable_command"])
  })
})

describe("CR10-2: `mkdir` then `cd` in a script of a project opened by a link name", () => {
  let real: string
  let named: string
  beforeAll(async () => {
    const holder = await temp()
    real = path.join(holder, "real")
    named = path.join(holder, "named")
    await gitInit(real)
    fs.symlinkSync(real, named)
    expectBareFrom(holder)
    write(real, "src/a.ts", "x\n")
    for (const bin of ["tsc", "vitest"]) write(real, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
    write(
      real,
      "package.json",
      JSON.stringify({
        name: "p",
        scripts: { mb: "mkdir -p build && cd build && tsc --noEmit", ml: "mkdir -p build && cd ../x && tsc --noEmit" },
      }),
    )
  })

  test("opens from the name as given and from the real path, as the same text at call level does", async () => {
    for (const at of [named, real]) {
      await opens(["npm run mb", "mkdir -p build && cd build && tsc --noEmit"], at, gitScope(at))
    }
  })

  test("a script `cd` the rule does not take still keeps 1.1.0", async () => {
    await keeps(["npm run ml"], named, gitScope(named))
  })
})

describe("CR10-3, n56: each F21 guard has a case that opens without it", () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    dir = await temp()
    outside = await temp()
    expectBareFrom(path.dirname(dir))
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    for (const bin of ["prettier", "vitest"]) write(dir, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
    fs.mkdirSync(path.join(dir, "made"), { recursive: true })
    fs.symlinkSync(path.join(dir, "made"), path.join(dir, "lnk"))
  })

  test("the controls open: the same calls without the `cd`, and the plain F21 form", async () => {
    await opens(
      [
        "mkdir -p build && prettier --write src/a.ts && vitest run",
        "mkdir -pv build && vitest run",
        "prettier --write src/a.ts && mkdir -p build && vitest run",
        "mkdir -p build && ls && cd build && vitest run",
        "ls && mkdir -p build && cd build && vitest run",
        // P35: a step before the `mkdir` that cannot make a link does not hold it.
        "prettier --write src/a.ts && mkdir -p build && cd build && vitest run",
        "mkdir -p a && vitest run && mkdir -p build && cd build && vitest run",
      ],
      dir,
      gitScope(dir),
    )
  })

  test("a step that writes between the `mkdir` and the `cd` keeps 1.1.0", async () => {
    await keeps(["mkdir -p build && prettier --write src/a.ts && cd build && vitest run"], dir, gitScope(dir))
  })

  test("a `mkdir` form other than the exact two keeps 1.1.0", async () => {
    await keeps(["mkdir -pv build && cd build && vitest run", "mkdir -p build build && cd build && vitest run"], dir, gitScope(dir))
  })

  // n56: `madeBefore` does not look before the `mkdir`; what keeps these is that no program that makes a link is allowlisted.
  // With `ln` or `cp` allowlisted, these would open (checked by mutation), so this pins the invariant.
  test("a link made before the `mkdir` keeps 1.1.0", async () => {
    await keeps(
      [
        "cp -R lnk build; mkdir -p build && cd build && vitest run",
        "ln -s made build; mkdir -p build && cd build && prettier --write x.ts",
        `ln -s ${outside} build; mkdir -p build && cd build && prettier --write x.ts`,
        `ln -s ${outside} build && mkdir -p build && cd build && vitest run`,
      ],
      dir,
      gitScope(dir),
    )
  })
})

describe("G10-P1..P3: counters", () => {
  let dir: string
  beforeAll(async () => {
    dir = await temp()
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    write(dir, "node_modules/.bin/vitest", "#!/bin/sh\n")
  })

  test("G10-P1: a deep word with a step back near its end asks once per run of names, not once per name", () => {
    const names = Array.from({ length: 35 }, (_, index) => `n${index}`)
    fs.mkdirSync(path.join(dir, ...names), { recursive: true })
    // Written out, not joined: `path.join` would take the `..` away.
    const word = `${path.join(dir, ...names)}/../x.ts`
    const before = Reach.realpathLookups()
    expect(Reach.physical(word, "/")).toBe(path.join(Reach.real(path.join(dir, ...names.slice(0, -1)))!, "x.ts"))
    // The run before the `..` once, the run after it (a missing file and its folder): not one per name.
    expect(Reach.realpathLookups() - before).toBeLessThanOrEqual(4)
  })

  test("G10-P2: the project's real folders are worked out once per reading, not once per landing", async () => {
    const outside = await temp()
    fs.mkdirSync(path.join(outside, "a/b"), { recursive: true })
    fs.symlinkSync(path.join(outside, "a/b"), path.join(dir, "ol"))
    fs.mkdirSync(path.join(dir, "src/deep"), { recursive: true })
    fs.symlinkSync(path.join(dir, "src/deep"), path.join(dir, "sl"))
    const count = 20
    const reading = await readSteps(`ls ${Array.from({ length: count }, (_, index) => `> sl/../o${index}.txt`).join(" ")}`, dir)
    const before = Reach.realpathLookups()
    const found = AutonomyTable.shellReading(reading, gitScope(dir))
    const asked = Reach.realpathLookups() - before
    expect(found?.writes).toContain(path.join(dir, "src/o0.txt"))
    // Per landing: the link's run, the landing's file (and its folder), the tidied path (and its folder); the two roots once.
    expect(asked).toBeLessThanOrEqual(count * 6 + 2)
  })

  test("G10-P3: a `cd` repeated 100 times asks whether a name is a link once per name in a classify", async () => {
    const given = await sh(`${"cd src && cd .. && ".repeat(100)}vitest run`, dir, gitScope(dir))
    const before = Reach.lstatLookups()
    root(given)
    expect(Reach.lstatLookups() - before).toBeLessThanOrEqual(2)
  })
})

describe("n50, n51, n55: one spelling of the checks", () => {
  test("Reach.upward and Reach.respell", () => {
    expect(["..", "a/..", "../a", "a/../b", "/a/..", "a/b/../"].map(Reach.upward)).toEqual([true, true, true, true, true, true])
    expect(["a..b", "...", "a/...", "..a", "a/b"].map(Reach.upward)).toEqual([false, false, false, false, false])
    expect(Reach.respell("/p/x/y", [["/p/x", "/r/x"]])).toBe("/r/x/y")
    expect(Reach.respell("/p/x", [["/p/x", "/r/x"]])).toBe("/r/x")
    expect(Reach.respell("/p/xy", [["/p/x", "/r/x"]])).toBe("/p/xy")
    expect(Reach.respell("/p/x", [["/", "/r"]])).toBe("/p/x")
  })

  test("no permission module asks the file system about links or real paths itself (the script screen's file read aside)", () => {
    const source = (name: string) => fs.readFileSync(path.join(import.meta.dir, "../../src/permission", name), "utf8")
    const asks = /\b(realpathSync|readlinkSync|lstatSync)\b/g
    expect(source("bypass-screen.ts").match(asks)).toBeNull()
    expect(source("bypass-lists.ts").match(asks)).toBeNull()
    // `ScriptScreen.file` takes the real path of an existing file it reads, and of the folder it is judged from.
    expect(source("script-screen.ts").match(asks)).toEqual(["realpathSync", "realpathSync"])
  })
})
