// Swarm 1.1.1 F41 (the last healing row, P58/P59): one test per gate-17 item. Security: G17-1 (`npm version`'s message
// flag), G17-2 (an assignment that changes the environment of the later steps), G17-3 / n95 (path-like locale, time-zone
// and terminal values). Code review: CR17-1 (a prefixed deletion in a loop or an `if`), CR17-2 (the rules that name a
// program skip leading assignments), CR17-3 (one allowlist). Verifier: V17-5 (`gh pr create` / `gh release create`
// beside a tree change). Performance: G17-P1 (a repeated step), G17-P2 (git's locale in the snapshot questions).
// Classification only: no host is contacted, no command runs.

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
import { BypassLists } from "../../src/permission/bypass-lists"
import { READ_THROUGH } from "../../src/tool/shell"
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

/**
 * The consent does not open it: the overlay keeps the 1.1.0 verdict (the reason may be the screen's own, P8). 1.1.3 (spec
 * section 3 `noWait`; matrix rows 2, 8, 22, 31): that kept verdict no longer waits, and records a destination only as
 * each case states it (G8).
 */
const kept = (given: Input, wants: Wants) => {
  const was = base(given)
  expect([label(given), was.class]).not.toEqual([label(given), "A"])
  for (const verdict of [root(given), subagent(given)]) expect([label(given), shape(verdict)] as unknown[]).toEqual([label(given), wanted(given, wants)])
}

describe("G17-2: under consent, an assignment of a name outside the harmless list keeps the call at 1.1.0", () => {
  test("home, search path, XDG, config and registry pointers, a local name, and a loop over an exported name", async () => {
    const here = await committed(await npmProject())
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
    expectOpens(await sh("CI=1; npm publish", here), "registry.npmjs.org")
    // An `export` is no step the consented screen reads (unchanged since F40).
    kept(await sh("export CI=1; npm publish", here), RUNS("unreadable_command"))
    for (const call of [
      "HOME=/tmp/elsewhere; npm publish",
      "HOME=/tmp/elsewhere\nnpm publish",
      "PATH=/tmp/elsewhere:/usr/bin; npm publish",
      "XDG_CONFIG_HOME=/tmp/elsewhere; npm publish",
      "NPM_CONFIG_USERCONFIG=/tmp/elsewhere/rc; npm publish",
      "npm_config_registry=https://example.test/; npm publish",
      "NODE_OPTIONS=--require=./x.js; npm publish",
      "f=1; npm publish",
      "for HOME in /tmp/elsewhere; do npm publish; done",
      "for PATH in /tmp/elsewhere; do npm publish; done",
      "for https_proxy in http://127.0.0.1:9; do npm publish; done",
    ]) {
      expect([call, (await readSteps(call, here))?.assigned?.length ?? 0]).not.toEqual([call, 0])
      kept(await sh(call, here), RUNS("outward_not_in_mission", "registry.npmjs.org"))
    }
    const crateHere = await committed(await crate())
    expectOpens(await sh("cargo publish", crateHere), "crates.io")
    for (const call of ["CARGO_HOME=/tmp/elsewhere; cargo publish", "HOME=/tmp/elsewhere; cargo publish"]) kept(await sh(call, crateHere), RUNS("outward_not_in_mission", "crates.io"))
  })

  test("a harmless name stays harmless only with a name for its value; development calls are unchanged", async () => {
    const here = await npmProject({ "package.json": withScripts({ test: "vitest run", build: "tsc" }) })
    expectOpen(await sh("CI=1; npm test && npm run build", here))
    expectOpen(await sh("TZ=Europe/Berlin; npm test && npm run build", here))
    expectOpen(await sh("for f in a b; do npm test; done", here))
    for (const call of ["TZ=/etc/localtime; npm test && npm run build", "export TZ=:/etc/passwd; npm test", "LANG=../../x; npm test"])
      kept(await sh(call, here), { "TZ=/etc/localtime; npm test && npm run build": RUNS("not_routine"), "export TZ=:/etc/passwd; npm test": RUNS("unreadable_command"), "LANG=../../x; npm test": RUNS("not_routine") })
  })

  test("once HOME is set in the text, `~` and `$HOME` are no longer the server's home", async () => {
    expect(await readSteps("ls ~/a && cat $HOME/b", "/tmp")).toBeDefined()
    expect(await readSteps("HOME=/tmp/x; ls ~/a", "/tmp")).toBeUndefined()
    expect(await readSteps("HOME=/tmp/x; cat $HOME/b", "/tmp")).toBeUndefined()
    expect(await readSteps("for HOME in /tmp/x; do ls ~; done", "/tmp")).toBeUndefined()
  })
})

/** 1.1.3 (T9 G8): the consented verdict of each call of the loop below, literally. */
const WANTS_1: Readonly<Record<string, Want>> = {
  "npm version patch -m --sign-git-tag && npm publish": RUNS("outward_not_in_mission", "registry.npmjs.org"),
  "npm version patch -m -s && npm publish": RUNS("outward_not_in_mission", "registry.npmjs.org"),
  "npm version patch --message --preid=beta && npm publish": RUNS("outward_not_in_mission", "registry.npmjs.org"),
  "npm version patch -m --include-workspace-root": RUNS("not_routine"),
  "npm version patch -m": RUNS("not_routine"),
  "npm version patch --message": RUNS("not_routine"),
}
describe("G17-1: npm version's message flag takes no option as its message", () => {
  test("a message that starts with `-`, or none, is not the plain form", async () => {
    const here = await committed(await npmProject())
    expectOpens(await sh('npm version patch --message "Release %s" && npm publish', here), "registry.npmjs.org")
    expectOpens(await sh('npm version patch -m "Release %s" && npm publish', here), "registry.npmjs.org")
    for (const call of [
      "npm version patch -m --sign-git-tag && npm publish",
      "npm version patch -m -s && npm publish",
      "npm version patch --message --preid=beta && npm publish",
      "npm version patch -m --include-workspace-root",
      "npm version patch -m",
      "npm version patch --message",
    ])
      kept(await sh(call, here), WANTS_1)
  })
})

describe("G17-3 / n95: locale, time-zone and terminal values are names, not paths", () => {
  test("bare and compound forms", async () => {
    const here = await npmProject({ "package.json": withScripts({ test: "vitest run", build: "tsc" }) })
    for (const prefix of ["TZ=Europe/Berlin", "LANG=en_US.UTF-8", "LC_ALL=C", "TERM=xterm-256color"]) {
      expectOpen(await sh(`${prefix} npm test`, here))
      expectOpen(await sh(`${prefix} npm test && npm run build`, here))
    }
    for (const prefix of ["TZ=/etc/localtime", "TZ=:/etc/passwd", "TZ=../../x", "LANG=../../x", "LANG=a/b", "LC_CTYPE=/tmp/x", "TERM=~/x", "LC_MESSAGES=:x"]) {
      kept(await sh(`${prefix} npm test`, here), RUNS("unreadable_command"))
      kept(await sh(`${prefix} npm test && npm run build`, here), RUNS("unreadable_command"))
    }
  })
})

describe("CR17-3: one source for the assignment allowlist", () => {
  test("the shell's reader keeps exactly what the consented screen reads through", async () => {
    expect(READ_THROUGH).toBe(BypassLists.SAFE_ASSIGNMENT)
    const names = [...BypassLists.SAFE_ASSIGNMENT.names, "PATH", "NODE_OPTIONS", "LC_NUMERIC", "HOME", "GIT_DIR"]
    const values = ["1", "production", "Europe/Berlin", "/etc/x", ":x", "../x", "a/b", "en_US.UTF-8", "app:x", "a,b=c", ""]
    for (const name of names)
      for (const value of values) {
        const word = `${name}=${value}`
        const read = (await readSteps(`${word} npm test && npm run build`, "/tmp")) !== undefined
        expect([word, read]).toEqual([word, BypassLists.SAFE_ASSIGNMENT.test(word)])
      }
  })
})

describe("CR17-1 / CR17-2: rules that name a program skip leading allowlisted assignments", () => {
  const same = async (prefixed: string, plain: string, dir: string) => {
    const [a, b] = [await sh(prefixed, dir), await sh(plain, dir)]
    expect([prefixed, short(base(a))]).toEqual([prefixed, short(base(b))])
    expect([prefixed, short(root(a))]).toEqual([prefixed, short(root(b))])
    expect([prefixed, short(subagent(a))]).toEqual([prefixed, short(subagent(b))])
  }
  test("a prefixed deletion in a loop or an if is refused like the plain form (CR17-1)", async () => {
    const here = await project({ "a.txt": "a", "b": "b" })
    for (const call of ["for f in a b; do CI=1 rm $f; done", "if true; then CI=1 rm a.txt; fi"]) {
      for (const verdict of [base(await sh(call, here)), root(await sh(call, here)), subagent(await sh(call, here))])
        expect([call, verdict.class, verdict.category]).toEqual([call, "X", "delete_compound"])
    }
    await same("for f in a b; do CI=1 rm $f; done", "for f in a b; do rm $f; done", here)
    await same("if true; then CI=1 rm a.txt; fi", "if true; then rm a.txt; fi", here)
  })
  test("git rm, tee and a project program behind a prefix are judged as the plain form (CR17-2)", async () => {
    const here = await project({ "a.txt": "a", "src/x.ts": "x" })
    const gitRm = base(await sh("CI=1 git rm -r src && echo ok", here))
    expect([gitRm.class, gitRm.category]).toEqual(["X", "delete_compound"])
    await same("CI=1 git rm -r src && echo ok", "git rm -r src && echo ok", here)
    const tee = base(await sh("CI=1 tee /etc/x < a.txt; echo ok", here))
    expect([tee.class, tee.category]).toEqual(["X", "outside_write"])
    await same("CI=1 tee /etc/x < a.txt; echo ok", "tee /etc/x < a.txt; echo ok", here)
    // Inside the project the prefix only adds a verdict: never looser than the plain form, and still what it was before F41.
    const RANK = { A: 0, P: 1, B: 2, D: 3, X: 4 } as const
    for (const [prefixed, plain] of [
      ["CI=1 tee out.txt < a.txt; echo ok", "tee out.txt < a.txt; echo ok"],
      ["echo a && CI=1 tee out.txt < a.txt", "echo a && tee out.txt < a.txt"],
      ["echo a && CI=1 sed -i '' s/a/b/ a.txt", "echo a && sed -i '' s/a/b/ a.txt"],
    ]) {
      const [a, b] = [await sh(prefixed!, here), await sh(plain!, here)]
      for (const judge of [base, root, subagent])
        expect([prefixed, RANK[judge(a).class] >= RANK[judge(b).class]]).toEqual([prefixed, true])
      expect([prefixed, short(base(a))]).toEqual([prefixed, ["D", "not_routine", undefined]])
    }
  })
})

describe("V17-5: gh pr create and gh release create count as a publish beside a tree change or a write", () => {
  test("held beside a merge or a write", async () => {
    const here = await committed(await npmProject())
    for (const call of [
      "git merge other && gh pr create --fill",
      "git merge other && gh release create v1 --notes x",
      "git switch other; gh pr create --fill",
      "gh release create v1 --notes x && git merge other",
      "cat alt.txt > notes.txt && gh pr create --fill",
    ]) {
      const given = await sh(call, here)
      for (const verdict of [root(given), subagent(given)]) expect([call, unopened(verdict)]).toEqual([call, true])
    }
  })
})

describe("G17-P1 / G17-P2", () => {
  test("a step repeated in a long compound gives the verdict it gives once", async () => {
    const here = await npmProject({ "package.json": withScripts({ test: "vitest run", build: "tsc" }) })
    const once = await sh("npm test && npm run build", here)
    const many = await sh(Array.from({ length: 150 }, () => "npm test && npm run build").join(" && "), here)
    expect(short(base(many))).toEqual(short(base(once)))
    expect(short(root(many))).toEqual(short(root(once)))
  })
  test("the snapshot questions run git with gitEnv, not the raw environment", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/tool/reach.ts"), "utf8")
    expect(source.includes("env: process.env")).toBe(false)
    expect(source.match(/env: gitEnv\(\)/g)?.length).toBe(3)
  })
})
