// Swarm 1.1.1 F40 (healing loop 17, controller ruling P56): one test per gate-16 item. Security: G16-1 (a tree change
// beside a publish or deploy in the same call), G16-2 (a readme or licence file is a literal path), CR16-1 (tracked links
// inside a submodule), CR16-2 / V16-1 (git's message read in the C locale), CR16-3 (netlify's default functions folders).
// Nits n88 (fly.toml, vercel.json), n89 (.npmrc default registry and spaces), n91 (git failing inside a repository).
// Usability: item 7 (leading NAME=value read through for a short list of names), item 8 (`npm version` beside a
// publish). Classification only: no host is contacted, no command runs. Every file a test puts in the fixture home or the
// environment is taken away.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { BypassScreen } from "../../src/permission/bypass-screen"
import { OutwardConsent } from "../../src/permission/outward-consent"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { Reach } from "../../src/tool/reach"
import { Risk } from "../../src/tool/risk"
import { readSteps } from "../../src/tool/shell"
import { DeletionWords } from "../../src/tool/deletion"
import { tmpdir } from "../fixture/fixture"
import { IRREVERSIBLE_ARCHIVE, answerOf } from "./consented-literals"

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
const GIT = ["-c", "core.fsmonitor=false", "-c", "commit.gpgsign=false", "-c", "user.email=t@t.test", "-c", "user.name=T"]
const git = (dir: string, ...args: string[]) => $`git ${GIT} ${args}`.cwd(dir).quiet()
const project = async (files: Record<string, string>) => {
  const dir = await temp()
  await $`git init -q`.cwd(dir).quiet()
  await git(dir, "commit", "-q", "--allow-empty", "-m", "root")
  for (const [name, content] of Object.entries(files)) write(dir, name, content)
  return dir
}
/** The files committed and a second branch `other`, so a merge, a switch and a checkout of it are plain forms. */
const committed = async (dir: string) => {
  await git(dir, "add", "-A")
  await git(dir, "commit", "-q", "-m", "files")
  await git(dir, "branch", "other")
  return dir
}
const scope = (dir: string) => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext

async function sh(command: string, dir: string, top = dir): Promise<Input> {
  const reading = await readSteps(command, dir)
  // 1.1.1 F41 (V17-4): the label production gives (`parts()` in shell.ts skips assignments): the step's program words, past
  // any leading `NAME=value` words the reader keeps.
  const risky = reading?.steps
    .map((step) => Risk.classify([...DeletionWords.program(step.argv)]))
    .find((verdict) => verdict.kind === "risky")
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(reading ? { steps: reading } : {}), ...(risky && risky.kind === "risky" ? { risk: risky.risk } : {}) },
    instance: scope(top),
    cwd: dir,
    canUndo: true,
    folder: "clean",
  }
}
/**
 * A reading with leading `NAME=value` words put in front of its first step, also for words the shell's reader itself does
 * not keep (`PATH=`, a spaced value), so the consented screen is tested on its own.
 */
async function prefixed(prefix: string[], command: string, dir: string): Promise<Input> {
  const given = await sh(command, dir)
  const steps = given.metadata.steps as { v: 1; steps: { argv: string[]; cwds: string[] }[]; writes: string[] }
  const first = steps.steps[0]!
  return {
    ...given,
    patterns: [[...prefix, command].join(" ")],
    metadata: {
      ...given.metadata,
      command: [...prefix, command].join(" "),
      steps: { ...steps, steps: [{ ...first, argv: [...prefix, ...first.argv] }, ...steps.steps.slice(1)] },
    },
  }
}
const root = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "root" } })
const subagent = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "subagent" } })
const base = (given: Input) => AutonomyTable.classify(given)
/**
 * 1.1.3 (spec section 3 `noWait`; matrix rows 2, 15, 8, 22, 3, 24-27, 31): a call the overlay does not open no longer
 * waits. It is refused at once (X), or it runs as the main agent's with `bypassed` = the category it was held on, recording
 * where it sends as each case states it (G8). Before 1.1.3 this asserted "not A".
 */
const unopened = (verdict: AutonomyTable.Verdict) =>
  verdict.class === "X" || (verdict.class === "A" && verdict.category === "by_main_agent" && verdict.bypassed !== undefined)
const short = (verdict: Verdict) => [verdict.class, verdict.category, verdict.destination]
const label = (given: Input) => String(given.metadata.command)
/**
 * 1.1.3 (decision T9 G8): the consented verdict each case expects, written out: class, category, `bypassed`, destination,
 * and the words the agent is told (undefined when it runs). Spec section 3 rule 5 and T7 F1: a kept D/P runs as the main
 * agent's with `bypassed` = the category it was held on, recording where it sends when the call names it.
 */
type Want = readonly [cls: string, category: string | undefined, bypassed: string | undefined, destination: string | undefined, answer: string | undefined]
const RUNS = (bypassed: string, destination?: string): Want => ["A", "by_main_agent", bypassed, destination, undefined]
const IRREVERSIBLE: Want = ["X", "irreversible", undefined, undefined, IRREVERSIBLE_ARCHIVE]
type Wants = Want | Readonly<Record<string, Want>>
const shape = (verdict: Verdict): Want => [verdict.class, verdict.category, verdict.bypassed, verdict.destination, answerOf(verdict)]
function wanted(given: Input, wants: Wants): Want | undefined {
  return Array.isArray(wants) ? (wants as Want) : (wants as Readonly<Record<string, Want>>)[label(given)]
}
function expectOpens(given: Input, destination?: string) {
  for (const verdict of [root(given), subagent(given)])
    expect([label(given), short(verdict)]).toEqual([label(given), ["A", "by_main_agent", destination]])
}
function expectOpen(given: Input) {
  for (const verdict of [root(given), subagent(given)]) expect([label(given), verdict.class]).toEqual([label(given), "A"])
}
/** The send step of a call, read on its own (`OutwardConsent.sendForm`): "form" when it holds, "opens" when it opens. */
function formOf(given: Input) {
  const steps = (given.metadata.steps as { steps: { argv: string[] }[] } | undefined)?.steps ?? []
  const step = steps.find((item) => OutwardConsent.SEND_PROGRAMS.has(item.argv[0]!) && item.argv[0] !== "git")
  if (!step) return "none"
  const found = OutwardConsent.sendForm(step.argv[0]!, step.argv.slice(1), given.cwd, { instance: given.instance })
  return found === undefined ? "none" : "held" in found ? found.held : "opens"
}
/** Neither the root nor a subagent opens it, and the rule named held it: "form" (the publish's own reading) or "call". */
function expectHeld(given: Input, rule: "form" | "call", why: string, wants: Wants) {
  for (const verdict of [root(given), subagent(given)])
    expect([label(given), why, shape(verdict)] as unknown[]).toEqual([label(given), why, wanted(given, wants)])
  expect([label(given), why, formOf(given)]).toEqual([label(given), why, rule === "form" ? "form" : "opens"])
}
/**
 * The consent does not open the call: the overlay keeps it as it was in 1.1.0 (the reason may be the screen's own, P8).
 * 1.1.3 (spec section 3 `noWait`; matrix rows 2, 8, 22, 31): that kept verdict no longer waits.
 */
function expectKept(given: Input, wants: Wants) {
  const kept = base(given)
  expect([label(given), kept.class]).not.toEqual([label(given), "A"])
  for (const verdict of [root(given), subagent(given)]) expect([label(given), shape(verdict)] as unknown[]).toEqual([label(given), wanted(given, wants)])
}

const home = () => process.env.HOME || os.homedir()
const saved = new Map<string, string | undefined>()
const setEnv = (key: string, value: string) => {
  if (!saved.has(key)) saved.set(key, process.env[key])
  process.env[key] = value
}
const restoreEnv = () => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  saved.clear()
}

const PACKAGE = JSON.stringify({ name: "p", version: "1.0.0" })
const withScripts = (scripts: Record<string, string>) => JSON.stringify({ name: "p", version: "1.0.0", scripts })
const CRATE = '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n'
const PYPROJECT = '[project]\nname = "x"\nversion = "0.1.0"\n[build-system]\nrequires = ["hatchling"]\n'
const npmProject = (files: Record<string, string> = {}) => project({ "package.json": PACKAGE, ...files })
const crate = (files: Record<string, string> = {}) => project({ "Cargo.toml": CRATE, ...files })
const python = (files: Record<string, string> = {}) => project({ "pyproject.toml": PYPROJECT, "dist/x-0.1.0.tar.gz": "t", ...files })
const site = (files: Record<string, string> = {}) => project({ "dist/index.html": "x", ...files })
const NODE_PUBLISH = ["npm publish", "pnpm publish", "yarn npm publish", "bun publish"]
const NETLIFY = "netlify deploy --prod --no-build --dir dist"
const PUBLISHERS: [string, () => Promise<string>, string][] = [
  ["uv publish", () => python(), "pypi.org"],
  ["poetry publish", () => python(), "pypi.org"],
  ["twine upload dist/x-0.1.0.tar.gz", () => python(), "pypi.org"],
  ["cargo publish", () => crate(), "crates.io"],
  [NETLIFY, () => site(), "netlify"],
  ["firebase deploy --only hosting", () => site({ "firebase.json": '{"hosting":{"public":"dist"}}' }), "firebase"],
]

beforeAll(async () => {
  // The fixture home must be a test one: these tests write files into it.
  expect(path.resolve(home())).not.toBe(path.join("/Users", os.userInfo().username))
  await ScriptReader.prepare()
})
afterEach(() => restoreEnv())
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

/** 1.1.3 (T9 G8): the consented verdict of each call of the loop below, literally. */
const WANTS_1: Readonly<Record<string, Want>> = {
  "git merge other && uv publish": RUNS("not_routine"),
  "git merge other; uv publish": RUNS("not_routine"),
  "uv publish && git merge other": RUNS("not_routine"),
  "git merge --ff-only other && uv publish": RUNS("not_routine"),
  "git merge --ff-only other; uv publish": RUNS("not_routine"),
  "uv publish && git merge --ff-only other": RUNS("not_routine"),
  "git switch other && uv publish": RUNS("not_routine"),
  "git switch other; uv publish": RUNS("not_routine"),
  "uv publish && git switch other": RUNS("not_routine"),
  "git checkout other && uv publish": RUNS("not_routine"),
  "git checkout other; uv publish": RUNS("not_routine"),
  "uv publish && git checkout other": RUNS("not_routine"),
  "git stash pop && uv publish": RUNS("not_routine"),
  "git stash pop; uv publish": RUNS("not_routine"),
  "uv publish && git stash pop": RUNS("not_routine"),
  "git stash apply && uv publish": RUNS("not_routine"),
  "git stash apply; uv publish": RUNS("not_routine"),
  "uv publish && git stash apply": RUNS("not_routine"),
  "git merge other && poetry publish": RUNS("not_routine"),
  "git merge other; poetry publish": RUNS("not_routine"),
  "poetry publish && git merge other": RUNS("not_routine"),
  "git merge --ff-only other && poetry publish": RUNS("not_routine"),
  "git merge --ff-only other; poetry publish": RUNS("not_routine"),
  "poetry publish && git merge --ff-only other": RUNS("not_routine"),
  "git switch other && poetry publish": RUNS("not_routine"),
  "git switch other; poetry publish": RUNS("not_routine"),
  "poetry publish && git switch other": RUNS("not_routine"),
  "git checkout other && poetry publish": RUNS("not_routine"),
  "git checkout other; poetry publish": RUNS("not_routine"),
  "poetry publish && git checkout other": RUNS("not_routine"),
  "git stash pop && poetry publish": RUNS("not_routine"),
  "git stash pop; poetry publish": RUNS("not_routine"),
  "poetry publish && git stash pop": RUNS("not_routine"),
  "git stash apply && poetry publish": RUNS("not_routine"),
  "git stash apply; poetry publish": RUNS("not_routine"),
  "poetry publish && git stash apply": RUNS("not_routine"),
  "git merge other && twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "git merge other; twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "twine upload dist/x-0.1.0.tar.gz && git merge other": RUNS("outward_not_in_mission", "pypi.org"),
  "git merge --ff-only other && twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "git merge --ff-only other; twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "twine upload dist/x-0.1.0.tar.gz && git merge --ff-only other": RUNS("outward_not_in_mission", "pypi.org"),
  "git switch other && twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "git switch other; twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "twine upload dist/x-0.1.0.tar.gz && git switch other": RUNS("outward_not_in_mission", "pypi.org"),
  "git checkout other && twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "git checkout other; twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "twine upload dist/x-0.1.0.tar.gz && git checkout other": RUNS("outward_not_in_mission", "pypi.org"),
  "git stash pop && twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "git stash pop; twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "twine upload dist/x-0.1.0.tar.gz && git stash pop": RUNS("outward_not_in_mission", "pypi.org"),
  "git stash apply && twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "git stash apply; twine upload dist/x-0.1.0.tar.gz": RUNS("outward_not_in_mission", "pypi.org"),
  "twine upload dist/x-0.1.0.tar.gz && git stash apply": RUNS("outward_not_in_mission", "pypi.org"),
  "git merge other && cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "git merge other; cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "cargo publish && git merge other": RUNS("outward_not_in_mission", "crates.io"),
  "git merge --ff-only other && cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "git merge --ff-only other; cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "cargo publish && git merge --ff-only other": RUNS("outward_not_in_mission", "crates.io"),
  "git switch other && cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "git switch other; cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "cargo publish && git switch other": RUNS("outward_not_in_mission", "crates.io"),
  "git checkout other && cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "git checkout other; cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "cargo publish && git checkout other": RUNS("outward_not_in_mission", "crates.io"),
  "git stash pop && cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "git stash pop; cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "cargo publish && git stash pop": RUNS("outward_not_in_mission", "crates.io"),
  "git stash apply && cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "git stash apply; cargo publish": RUNS("outward_not_in_mission", "crates.io"),
  "cargo publish && git stash apply": RUNS("outward_not_in_mission", "crates.io"),
  "git merge other && netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "git merge other; netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "netlify deploy --prod --no-build --dir dist && git merge other": RUNS("outward_not_in_mission", "netlify"),
  "git merge --ff-only other && netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "git merge --ff-only other; netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "netlify deploy --prod --no-build --dir dist && git merge --ff-only other": RUNS("outward_not_in_mission", "netlify"),
  "git switch other && netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "git switch other; netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "netlify deploy --prod --no-build --dir dist && git switch other": RUNS("outward_not_in_mission", "netlify"),
  "git checkout other && netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "git checkout other; netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "netlify deploy --prod --no-build --dir dist && git checkout other": RUNS("outward_not_in_mission", "netlify"),
  "git stash pop && netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "git stash pop; netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "netlify deploy --prod --no-build --dir dist && git stash pop": RUNS("outward_not_in_mission", "netlify"),
  "git stash apply && netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "git stash apply; netlify deploy --prod --no-build --dir dist": RUNS("outward_not_in_mission", "netlify"),
  "netlify deploy --prod --no-build --dir dist && git stash apply": RUNS("outward_not_in_mission", "netlify"),
  "git merge other && firebase deploy --only hosting": RUNS("not_routine"),
  "git merge other; firebase deploy --only hosting": RUNS("not_routine"),
  "firebase deploy --only hosting && git merge other": RUNS("not_routine"),
  "git merge --ff-only other && firebase deploy --only hosting": RUNS("not_routine"),
  "git merge --ff-only other; firebase deploy --only hosting": RUNS("not_routine"),
  "firebase deploy --only hosting && git merge --ff-only other": RUNS("not_routine"),
  "git switch other && firebase deploy --only hosting": RUNS("not_routine"),
  "git switch other; firebase deploy --only hosting": RUNS("not_routine"),
  "firebase deploy --only hosting && git switch other": RUNS("not_routine"),
  "git checkout other && firebase deploy --only hosting": RUNS("not_routine"),
  "git checkout other; firebase deploy --only hosting": RUNS("not_routine"),
  "firebase deploy --only hosting && git checkout other": RUNS("not_routine"),
  "git stash pop && firebase deploy --only hosting": RUNS("not_routine"),
  "git stash pop; firebase deploy --only hosting": RUNS("not_routine"),
  "firebase deploy --only hosting && git stash pop": RUNS("not_routine"),
  "git stash apply && firebase deploy --only hosting": RUNS("not_routine"),
  "git stash apply; firebase deploy --only hosting": RUNS("not_routine"),
  "firebase deploy --only hosting && git stash apply": RUNS("not_routine"),
}
describe("G16-1: a tree change in the same call as a publish or deploy keeps the call at 1.1.0", () => {
  test("merge, fast-forward, switch, branch checkout, stash pop or apply, before or after the publish, hold the call", async () => {
    for (const [send, make, destination] of PUBLISHERS) {
      const here = await committed(await make())
      expectOpens(await sh(send, here), destination)
      expectOpen(await sh("git merge other", here))
      expectOpen(await sh("git switch other", here))
      for (const change of ["git merge other", "git merge --ff-only other", "git switch other", "git checkout other", "git stash pop", "git stash apply"])
        for (const call of [`${change} && ${send}`, `${change}; ${send}`, `${send} && ${change}`])
          expectHeld(await sh(call, here), "call", call, WANTS_1)
    }
  })

  test("inside a project script, and a publish hook that changes the tree, hold; the publish alone opens", async () => {
    const scripts = { ship: "git merge other && uv publish", plain: "uv publish" }
    const here = await committed(await python({ "package.json": withScripts(scripts) }))
    expectOpens(await sh("npm run plain", here), "pypi.org")
    for (const call of ["npm run ship", "git merge other && npm run plain"]) {
      const given = await sh(call, here)
      for (const verdict of [root(given), subagent(given)]) expect([call, unopened(verdict)]).toEqual([call, true])
    }
    const hooked = await committed(await npmProject({ "package.json": withScripts({ prepublishOnly: "git switch other" }) }))
    expectHeld(await sh("npm publish", hooked), "call", "hook switches", RUNS("outward_not_in_mission", "registry.npmjs.org"))
    const plainHook = await committed(await npmProject({ "package.json": withScripts({ prepublishOnly: "git status" }) }))
    expectOpens(await sh("npm publish", plainHook), "registry.npmjs.org")
  })

  test("P24: an install beside a publish still opens; a new branch at HEAD is no tree change", async () => {
    const here = await committed(await npmProject())
    expectOpens(await sh("npm install && npm publish", here), "registry.npmjs.org")
    const py = await committed(await python())
    expectOpens(await sh("git checkout -b release && uv publish", py), "pypi.org")
  })
})

describe("G16-2: a readme or licence file with glob characters is judged where its name lands", () => {
  test("cargo readme and license-file through a link whose name holds glob characters hold; a plain one opens", async () => {
    const outside = await temp()
    write(outside, "README.md", "s")
    write(outside, "LICENSE", "s")
    for (const key of ["readme", "license-file"]) {
      const here = await crate()
      fs.symlinkSync(outside, path.join(here, "d[1]"))
      const file = key === "readme" ? "README.md" : "LICENSE"
      write(here, "Cargo.toml", `${CRATE}${key} = "d[1]/${file}"\n`)
      expectHeld(await sh("cargo publish", here), "form", key, RUNS("outward"))
    }
    const plain = await crate({ "Cargo.toml": `${CRATE}readme = "doc[s]/R.md"\nlicense-file = "LICEN*"\n`, "doc[s]/R.md": "r", "LICEN*": "l" })
    expectOpens(await sh("cargo publish", plain), "crates.io")
  })

  test("pyproject readme, license file and poetry readme the same way; license-files stays a pattern", async () => {
    const outside = await temp()
    write(outside, "R.md", "s")
    const cases: [string, string][] = [
      ["uv", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme = "d[1]/R.md"')],
      ["uv", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme = { file = "d[1]/R.md", content-type = "text/markdown" }')],
      ["uv", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nlicense = { file = "d[1]/R.md" }')],
      ["poetry", PYPROJECT + '[tool.poetry]\nreadme = "d[1]/R.md"\n'],
    ]
    for (const [tool, pyproject] of cases) {
      const here = await python({ "pyproject.toml": pyproject })
      fs.symlinkSync(outside, path.join(here, "d[1]"))
      expectHeld(await sh(`${tool} publish`, here), "form", pyproject, RUNS("outward"))
    }
    const pattern = PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nlicense-files = ["LICEN[CS]E*"]')
    expectOpens(await sh("uv publish", await python({ "pyproject.toml": pattern })), "pypi.org")
  })
})

describe("CR16-1: a tracked link inside a submodule that lands outside holds the publish", () => {
  test("cargo and npm, with the submodule's link outside and inside", async () => {
    const outside = await temp()
    write(outside, "s.txt", "s")
    for (const [send, make, destination] of [
      ["cargo publish", () => crate(), "crates.io"],
      ["npm publish", () => npmProject(), "registry.npmjs.org"],
    ] as const) {
      for (const [target, opens] of [
        [path.join(outside, "s.txt"), false],
        ["../../inner.txt", true],
      ] as const) {
        const sub = await project({ "keep.txt": "k" })
        fs.symlinkSync(target, path.join(sub, "notes.txt"))
        await git(sub, "add", "-A")
        await git(sub, "commit", "-q", "-m", "link")
        const here = await make()
        write(here, "inner.txt", "i")
        await git(here, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor/sub")
        if (opens) expectOpens(await sh(send, here), destination)
        else expectHeld(await sh(send, here), "form", `${send} submodule link outside`, RUNS("outward"))
      }
    }
  })
})

describe("CR16-2 / V16-1 / n90: git's message is read in the C locale", () => {
  test("outside any repository, in Indonesian and German, a publish opens; inside one, a link outside still holds", async () => {
    const plain = await temp()
    write(plain, "package.json", PACKAGE)
    for (const [key, value] of [["LANG", "id_ID.UTF-8"], ["LC_ALL", "de_DE.UTF-8"], ["LANGUAGE", "id"]] as const) {
      setEnv(key, value)
      expect(Reach.trackedLinks(plain)).toEqual([])
      expectOpens(await sh("npm publish", plain), "registry.npmjs.org")
    }
    const outside = await temp()
    write(outside, "s.txt", "s")
    const here = await npmProject()
    fs.symlinkSync(path.join(outside, "s.txt"), path.join(here, "notes.txt"))
    await git(here, "add", "notes.txt")
    expectHeld(await sh("npm publish", here), "form", "tracked link outside, German", RUNS("outward"))
  })

  test("one helper: git's environment is the C locale, and only it reads git's failure text", () => {
    setEnv("LANG", "id_ID.UTF-8")
    setEnv("LANGUAGE", "id")
    const env = Reach.gitEnv()
    expect([env.LC_ALL, env.LANG, env.LANGUAGE]).toEqual(["C", "C", undefined])
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/tool/reach.ts"), "utf8")
    expect(source.match(/not a git repository/g)?.length).toBe(1)
    for (const file of fs.readdirSync(path.join(import.meta.dir, "../../src/permission")).filter((name) => name.endsWith(".ts")))
      expect([file, fs.readFileSync(path.join(import.meta.dir, "../../src/permission", file), "utf8").includes("not a git repository")]).toEqual([file, false])
  })

  test("n91: git failing inside a repository (a broken index) holds every publish that checks links", async () => {
    for (const [send, make] of [
      ["npm publish", () => npmProject()],
      ["cargo publish", () => crate()],
      ["uv publish", () => python()],
    ] as const) {
      const here = await make()
      await git(here, "add", "-A")
      fs.writeFileSync(path.join(here, ".git", "index"), "not an index")
      expect(Reach.trackedLinks(here)).toBeNull()
      expectHeld(await sh(send, here), "form", send, RUNS("outward"))
    }
  })
})

describe("CR16-3: netlify's default functions folders hold the deploy", () => {
  test("netlify/functions or netlify/edge-functions, in the step's folder or above it up to the top", async () => {
    expectOpens(await sh(NETLIFY, await site()), "netlify")
    for (const folder of ["netlify/functions/a.js", "netlify/edge-functions/a.ts"]) {
      expectHeld(await sh(NETLIFY, await site({ [folder]: "x" })), "form", folder, RUNS("outward"))
      const here = await site({ [folder]: "x", "web/dist/index.html": "x" })
      const given = await sh(NETLIFY, path.join(here, "web"), here)
      for (const verdict of [root(given), subagent(given)]) expect([folder, unopened(verdict)]).toEqual([folder, true])
    }
    expectHeld(await sh(NETLIFY, await site({ "netlify/functions": "" })), "form", "a file at the name", RUNS("outward"))
  })
})

describe("n88: fly.toml and vercel.json are consent-sensitive", () => {
  test("in the consent-only list, not in 1.1.0's sensitive list; a shell write to them keeps 1.1.0", async () => {
    for (const name of ["fly.toml", "vercel.json"]) {
      expect([name, Risk.toolConfig(name), Risk.sensitive(name)]).toEqual([name, true, false])
      const here = await site({ "alt.txt": "x" })
      expectKept(await sh(`cat alt.txt > ${name}`, here), RUNS("not_routine"))
    }
    expectOpen(await sh("cat alt.txt > notes.txt", await site({ "alt.txt": "x" })))
  })
})

describe("n89: .npmrc allows the default registry line and spaces around `=`", () => {
  test("these open for the npm family", async () => {
    for (const text of [
      "registry=https://registry.npmjs.org/\n",
      "registry=https://registry.npmjs.org\n",
      "registry = https://registry.npmjs.org/\n",
      "save-exact = true\nfund\t=\tfalse\n",
      "//registry.npmjs.org/:_authToken = ${NPM_TOKEN}\n//registry.npmjs.org/:always-auth = true\n",
    ])
      for (const command of NODE_PUBLISH) expectOpens(await sh(command, await npmProject({ ".npmrc": text })), "registry.npmjs.org")
  })

  test("these still hold", async () => {
    for (const text of [
      "registry=https://registry.npmjs.org/x/\n",
      "registry=http://registry.npmjs.org/\n",
      "registry=https://registry.npmjs.org//\n",
      "registry = https://npm.evil.example/\n",
      " save-exact=true\n",
      "save-exact=true \n",
      "save-exact = = true\n",
      "@corp:registry = https://registry.npmjs.org/\n",
    ])
      for (const command of NODE_PUBLISH) expectHeld(await sh(command, await npmProject({ ".npmrc": text })), "form", JSON.stringify(text), RUNS("outward"))
  })
})

/** 1.1.3 (T9 G8): the consented verdict of each call of the loop below, literally. */
const WANTS_2: Readonly<Record<string, Want>> = {
  "NODE_OPTIONS=--require=./x.js npm test": RUNS("unreadable_command"),
  "PATH=/tmp/x npm test": RUNS("unreadable_command"),
  "PATH=/tmp/x:$PATH npm test": RUNS("unreadable_command"),
  "CI=1 PATH=/tmp/x npm test": RUNS("unreadable_command"),
  "LD_PRELOAD=/tmp/x.so npm test": RUNS("unreadable_command"),
  "DYLD_INSERT_LIBRARIES=/tmp/x npm test": RUNS("unreadable_command"),
  "BASH_ENV=/tmp/x npm test": RUNS("unreadable_command"),
  "GIT_DIR=/tmp/x git status": RUNS("unreadable_command"),
  "npm_config_registry=https://npm.evil.example/ npm publish": RUNS("unreadable_command"),
  "PYTHONPATH=/tmp/x npm test": RUNS("unreadable_command"),
  "CI='a b' npm test": RUNS("unreadable_command"),
  "CI=$X npm test": RUNS("unreadable_command"),
  "CI=`x` npm test": RUNS("unreadable_command"),
  "CI=\"$HOME\" npm test": RUNS("unreadable_command"),
  "LC_NUMERIC=C npm test": RUNS("unreadable_command"),
  "DEBUG=app:* npm test": RUNS("unreadable_command"),
  "DEBUG=a;b npm test": RUNS("not_routine"),
  "CI=1 > out.txt npm test": RUNS("unreadable_command"),
  "CI=1": RUNS("unreadable_command"),
}
describe("usability item 7: leading NAME=value words from a short list are read through", () => {
  const SCRIPTS = withScripts({ test: "vitest run", build: "tsc" })
  test("CI=1 npm test and NODE_ENV=production npm run build open as the command alone does", async () => {
    const here = await npmProject({ "package.json": SCRIPTS })
    expectOpen(await sh("npm test", here))
    expectOpen(await sh("npm run build", here))
    for (const call of [
      "CI=1 npm test",
      "NODE_ENV=production npm run build",
      "CI=true FORCE_COLOR=0 NO_COLOR=1 TZ=UTC LANG=C LC_ALL=C TERM=dumb DEBUG=app:x,-y LANG=en_US.UTF-8 RUST_LOG=my_crate=debug npm test",
    ])
      expectOpen(await sh(call, here))
    expectOpen(await sh("RUST_BACKTRACE=1 RUST_LOG=debug cargo test", await crate()))
    expectOpen(await sh("PYTHONUNBUFFERED=1 CI=1 git status", here))
    expectOpens(await sh("CI=1 npm publish", await npmProject()), "registry.npmjs.org")
  })

  test("another name, or a value that is not plain, keeps the call's verdict", async () => {
    const here = await npmProject({ "package.json": SCRIPTS })
    for (const call of [
      "NODE_OPTIONS=--require=./x.js npm test",
      "PATH=/tmp/x npm test",
      "PATH=/tmp/x:$PATH npm test",
      "CI=1 PATH=/tmp/x npm test",
      "LD_PRELOAD=/tmp/x.so npm test",
      "DYLD_INSERT_LIBRARIES=/tmp/x npm test",
      "BASH_ENV=/tmp/x npm test",
      "GIT_DIR=/tmp/x git status",
      "npm_config_registry=https://npm.evil.example/ npm publish",
      "PYTHONPATH=/tmp/x npm test",
      "CI='a b' npm test",
      "CI=$X npm test",
      "CI=`x` npm test",
      'CI="$HOME" npm test',
      "LC_NUMERIC=C npm test",
      "DEBUG=app:* npm test",
      "DEBUG=a;b npm test",
      "CI=1 > out.txt npm test",
      "CI=1",
    ])
      expectKept(await sh(call, here), WANTS_2)
  })

  test("readThrough: the words and only the words", () => {
    expect(BypassScreen.readThrough(["CI=1", "NODE_ENV=test", "bun", "test"])).toEqual(["bun", "test"])
    expect(BypassScreen.readThrough(["CI=1", "PATH=/x", "bun", "test"])).toEqual(["CI=1", "PATH=/x", "bun", "test"])
    expect(BypassScreen.readThrough(["CI=1"])).toEqual(["CI=1"])
    expect(BypassScreen.readThrough(["bun", "CI=1"])).toEqual(["bun", "CI=1"])
  })

  test("in a compound call, as the shell's reader gives it (shell.ts seam, landed P57)", async () => {
    const here = await npmProject({ "package.json": SCRIPTS })
    expectOpen(await prefixed(["CI=1"], "npm test && npm run build", here))
    expectOpen(await prefixed(["NODE_ENV=production"], "npm run build && npm test", here))
    for (const prefix of [["NODE_OPTIONS=--require=./x.js"], ["PATH=/tmp/x"], ["CI=1", "LD_PRELOAD=/x"], ["CI=a b"]])
      expectKept(await prefixed(prefix, "npm test && npm run build", here), RUNS("unreadable_command"))
    // 1.1.1 F41 (V17-1, n93): the seam is in the tree, so the reader must keep the words.
    expect((await readSteps("CI=1 npm test && npm run build", here))?.steps.map((step) => step.argv)).toEqual([
      ["CI=1", "npm", "test"],
      ["npm", "run", "build"],
    ])
    expectOpen(await sh("CI=1 npm test && NODE_ENV=production npm run build", here))
    expectKept(await sh("NODE_OPTIONS=--require=./x.js npm test && npm run build", here), RUNS("unreadable_command"))
  })
})

describe("usability item 8: a plain npm version is no writer beside a publish", () => {
  test("npm version patch && npm publish opens in a clean project, and npm version alone opens", async () => {
    const here = await committed(await npmProject())
    expectOpen(await sh("npm version patch", here))
    expectOpens(await sh("npm version patch && npm publish", here), "registry.npmjs.org")
    for (const bump of ["minor", "major", "premajor", "preminor", "prepatch", "prerelease", "1.2.3"])
      expectOpens(await sh(`npm version ${bump} && npm publish`, here), "registry.npmjs.org")
    expectOpens(await sh('npm version patch -m "Release %s" --no-git-tag-version && npm publish', here), "registry.npmjs.org")
  })

  test("its hooks are screened like scripts; other forms keep 1.1.0", async () => {
    const writes = await committed(await npmProject({ "package.json": withScripts({ version: "cat alt.txt > notes.txt" }), "alt.txt": "a" }))
    expectOpen(await sh("npm version patch", writes))
    const held = await sh("npm version patch && npm publish", writes)
    for (const verdict of [root(held), subagent(held)]) expect(["a version hook that writes", unopened(verdict)]).toEqual(["a version hook that writes", true])
    const sends = await committed(await npmProject({ "package.json": withScripts({ preversion: "frobnicate --all" }) }))
    expectKept(await sh("npm version patch", sends), RUNS("not_routine"))
    const fine = await committed(await npmProject({ "package.json": withScripts({ preversion: "tsc --noEmit" }) }))
    expectOpens(await sh("npm version patch && npm publish", fine), "registry.npmjs.org")
    const here = await committed(await npmProject())
    for (const call of [
      "npm version from-git",
      "npm version patch --preid beta",
      "npm version patch --sign-git-tag",
      "npm version patch --workspaces",
      "npm version patch minor",
      "npm version 1.2",
      "pnpm version patch",
    ])
      // 1.1.3: not opened by the overlay, so not A before 1.1.3; now it runs or is refused at once (`unopened`).
      expect([call, unopened(root(await sh(call, here)))]).toEqual([call, true])
  })
})
