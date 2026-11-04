// Swarm 1.1.1 F25 (healing loop 12, decision P40): stricter-only fixes from gate 11.
// - CR11-1 / V11-1: a redirect landing is never dropped. More distinct redirects with a `..` than are judged leave the
//   reading unread, as before F22; a long `cd` list still has every landing worked out. With consent an incomplete
//   reading is held, never given 1.1.0's A.
// - CR11-2: `tee` and `sed -i` targets with a `..` are judged where they land, in both modes, as redirects are.
// - Item 4: an in-place formatter other than prettier that walks a folder keeps 1.1.0 under consent when a link sits below
//   that folder, or when the folder is too large to look through.
// Each case is checked without consent and for the root agent and a subagent with it.

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

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

const temps: Awaited<ReturnType<typeof tmpdir>>[] = []
const temp = async () => {
  const made = await tmpdir()
  temps.push(made)
  return fs.realpathSync(made.path)
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
const short = (verdict: Verdict): (string | undefined)[] => [verdict.class, verdict.category]

/** Without consent, and for the root and a subagent with it. */
async function judged(command: string, dir: string) {
  const given = await sh(command, dir, gitScope(dir))
  return { given, without: short(base(given)), root: short(root(given)), subagent: short(subagent(given)) }
}

async function expectAll(command: string, dir: string, without: (string | undefined)[], consented: (string | undefined)[]) {
  const found = await judged(command, dir)
  const label = command.length > 80 ? `${command.slice(0, 40)}...${command.slice(-40)}` : command
  expect([label, found.without]).toEqual([label, without])
  expect([label, found.root]).toEqual([label, consented])
  expect([label, found.subagent]).toEqual([label, consented])
  return found
}

beforeAll(() => ScriptReader.prepare())
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

const pads = (count: number) => Array.from({ length: count }, (_, index) => `> src/../o${index}.txt`).join(" ")
const cdPairs = (count: number) => Array.from({ length: count }, (_, index) => `cd d${index} && cd .. && `).join("")

describe("CR11-1 / V11-1: a long list never drops a redirect landing", () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    dir = await temp()
    outside = await temp()
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    fs.mkdirSync(path.join(outside, "a"), { recursive: true })
    // A link that leads out of the project, written relative and absolute.
    fs.symlinkSync(path.relative(dir, path.join(outside, "a")), path.join(dir, "lnk"))
    fs.symlinkSync(path.join(outside, "a"), path.join(dir, "abslnk"))
    for (let index = 0; index < 201; index++) fs.mkdirSync(path.join(dir, `d${index}`), { recursive: true })
  })

  test("control: the plain write through the link is refused, and held with consent", async () => {
    await expectAll("cat src/a.ts > lnk/../esc.txt", dir, ["X", "outside_write"], ["D", "outside_write_held"])
  })

  test("up to 400 places the landing is judged: 399 harmless redirects, or 200 `cd` pairs, then the write", async () => {
    await expectAll(`cat src/a.ts ${pads(399)} > lnk/../esc.txt`, dir, ["X", "outside_write"], ["D", "outside_write_held"])
    await expectAll(`${cdPairs(200)}cat src/a.ts > lnk/../esc.txt`, dir, ["X", "outside_write"], ["D", "outside_write_held"])
  })

  test("more distinct redirects with a `..` than are judged: unread, never A, and held with consent", async () => {
    for (const command of [
      `cat src/a.ts ${pads(400)} > lnk/../esc.txt`,
      `cat src/a.ts ${pads(400)} > abslnk/../esc.txt`,
      `cat src/a.ts ${Array.from({ length: 401 }, (_, index) => `> lnk/../e${index}.txt`).join(" ")}`,
    ]) {
      const given = await sh(command, dir, gitScope(dir))
      expect(AutonomyTable.shellReading(given.metadata.steps, gitScope(dir))).toBeUndefined()
      const without = base(given)
      expect(without.class).not.toBe("A")
      expect(short(root(given))).toEqual(["D", "unreadable_command"])
      expect(short(subagent(given))).toEqual(["D", "unreadable_command"])
    }
  })

  test("more distinct `cd`s than are judged: every landing still counts, so the write is refused, and held with consent", async () => {
    for (const link of ["lnk", "abslnk"]) {
      const command = `${cdPairs(201)}cat src/a.ts > ${link}/../esc.txt`
      const found = await expectAll(command, dir, ["X", "outside_write"], ["D", "outside_write_held"])
      const reading = AutonomyTable.shellReading(found.given.metadata.steps, gitScope(dir))
      expect(reading?.complete).toBe(false)
      expect(reading?.writes).toContain(path.join(outside, "esc.txt"))
    }
  })

  test("a long `cd` list with nothing outside: 1.1.0's A without consent, held with it", async () => {
    await expectAll(`${cdPairs(201)}ls`, dir, ["A", undefined], ["D", "unreadable_command"])
    // A `cd` the text repeats is one place: the reading is complete and opens as before.
    const found = await judged(`${"cd src && cd .. && ".repeat(201)}ls`, dir)
    expect(found.without[0]).toBe("A")
    expect(found.root[0]).toBe("A")
  })
})

describe("CR11-2: `tee` and `sed -i` targets are judged where they land", () => {
  let dir: string
  let outside: string
  beforeAll(async () => {
    dir = await temp()
    outside = await temp()
    await gitInit(dir)
    write(dir, "src/a.ts", "x\n")
    write(dir, "src/deep/b.ts", "x\n")
    fs.mkdirSync(path.join(dir, ".git/hooks"), { recursive: true })
    fs.mkdirSync(path.join(outside, "a"), { recursive: true })
    write(outside, "a/v.ts", "x\n")
    write(outside, "v.ts", "x\n")
    fs.symlinkSync(path.join(outside, "a"), path.join(dir, "lnk"))
    fs.symlinkSync(path.join(dir, ".git/hooks"), path.join(dir, "hk"))
    fs.symlinkSync(path.join(dir, "src/deep"), path.join(dir, "sl"))
    fs.symlinkSync("loop-b", path.join(dir, "loop-a"))
    fs.symlinkSync("loop-a", path.join(dir, "loop-b"))
  })

  test("through a link that leads out: refused without consent, held with it", async () => {
    for (const command of [
      "cat src/a.ts | tee lnk/../esc.txt",
      "cat src/a.ts | tee -a lnk/../esc.txt",
      "tee lnk/../esc.txt < src/a.ts",
      "sed -i '' s/x/y/ lnk/../v.ts",
      "sed -i.bak s/x/y/ lnk/../v.ts",
      "cd lnk && cat ../src/a.ts | tee ../esc.txt",
    ]) {
      await expectAll(command, dir, ["X", "outside_write"], ["D", "outside_write_held"])
    }
  })

  test("a step back with no link, or a link whose step back stays inside, is judged as the place it reaches", async () => {
    const plain = await judged("cat src/a.ts | tee src/../t.txt", dir)
    expect(plain.without[0]).toBe("A")
    const inLink = await judged("cat src/a.ts | tee sl/../t.txt", dir)
    const same = await judged("cat src/a.ts | tee src/t.txt", dir)
    expect(inLink.without).toEqual(same.without)
  })

  test("into the repository's own storage through a link, or through a link loop: never A", async () => {
    for (const command of ["cat src/a.ts | tee hk/../config", "sed -i '' s/x/y/ hk/../config", "cat src/a.ts | tee loop-a/../x.txt"]) {
      const found = await judged(command, dir)
      expect([command, found.without[0]]).not.toEqual([command, "A"])
      expect([command, found.root[0]]).not.toEqual([command, "A"])
    }
  })
})

describe("item 4: a formatter that walks a folder with a link below it keeps 1.1.0 under consent", () => {
  let dir: string
  let plain: string
  let outside: string
  const formatters = ["eslint --fix src", "eslint --fix 'src/**/*.ts'", "biome check --write src", "black src", "ruff format src", "ruff check --fix src"]
  const setup = async (at: string) => {
    await gitInit(at)
    write(at, "src/a.ts", "x\n")
    write(at, "src/sub/b.ts", "x\n")
    write(at, "Cargo.toml", "[package]\nname = \"p\"\nversion = \"0.1.0\"\n")
    for (const bin of ["eslint", "prettier", "biome"]) write(at, `node_modules/.bin/${bin}`, "#!/bin/sh\n")
  }
  beforeAll(async () => {
    dir = await temp()
    plain = await temp()
    outside = await temp()
    await setup(dir)
    await setup(plain)
    write(outside, "o.ts", "x\n")
    fs.symlinkSync(outside, path.join(dir, "src/sub/out"))
  })

  test("with no link below, each opens", async () => {
    for (const command of [...formatters, "cargo fmt"]) {
      const found = await judged(command, plain)
      expect([command, found.root[0]]).toEqual([command, "A"])
    }
  })

  test("with a link below the folder, each keeps its 1.1.0 verdict, for the root and a subagent", async () => {
    for (const command of [...formatters, "cargo fmt"]) {
      const found = await judged(command, dir)
      expect([command, found.without[0]]).not.toEqual([command, "A"])
      expect([command, found.root]).toEqual([command, found.without])
      expect([command, found.subagent]).toEqual([command, found.without])
    }
  })

  test("prettier keeps its behaviour, and a file target is no folder walk", async () => {
    for (const command of ["prettier --write src", "prettier --write 'src/**/*.ts'", "eslint --fix src/a.ts", "black src/a.ts"]) {
      const found = await judged(command, dir)
      expect([command, found.root[0]]).toEqual([command, "A"])
    }
  })

  test("without consent nothing changes", async () => {
    for (const command of [...formatters, "cargo fmt"]) {
      const found = await judged(command, dir)
      expect([command, found.without]).toEqual([command, short(AutonomyTable.classifyBase(found.given))])
    }
  })

  test("Reach.linkBelow: a link anywhere below, too many entries, or nothing to walk", async () => {
    const at = await temp()
    write(at, "a/b/c.txt", "x\n")
    expect(Reach.linkBelow(at)).toBe(false)
    expect(Reach.linkBelow(path.join(at, "a/b/c.txt"))).toBe(false)
    expect(Reach.linkBelow(path.join(at, "missing"))).toBe(false)
    for (let index = 0; index < 12; index++) write(at, `many/f${index}`, "x\n")
    expect(Reach.linkBelow(path.join(at, "many"), 10)).toBe(true)
    expect(Reach.linkBelow(path.join(at, "many"), 12)).toBe(false)
    // `.git` is not walked.
    fs.mkdirSync(path.join(at, ".git"), { recursive: true })
    fs.symlinkSync(outside, path.join(at, ".git/out"))
    expect(Reach.linkBelow(at)).toBe(false)
    fs.symlinkSync(outside, path.join(at, "a/b/out"))
    expect(Reach.linkBelow(at)).toBe(true)
  })

  test("a folder over the cap keeps 1.1.0, and the walk is done once per classify", async () => {
    const big = await temp()
    await setup(big)
    for (let index = 0; index <= Reach.LINK_SCAN_CAP; index++) write(big, `src/gen/f${index}.ts`, "")
    const found = await judged("eslint --fix src", big)
    expect(found.root).toEqual(found.without)
    const given = await sh("eslint --fix src && biome check --write src", plain, gitScope(plain))
    const before = Reach.linkScanEntries()
    root(given)
    // Two formatters walk `src` (2 folders, 3 entries): looked through once.
    expect(Reach.linkScanEntries() - before).toBe(3)
  })
})
