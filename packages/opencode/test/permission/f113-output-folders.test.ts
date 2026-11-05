// 1.1.3 decision T10: a project script whose deletions all target generated-output folders inside the project runs under
// consent; any other deletion in a script still gets ARCHIVE_FIRST (T9 G2). The folders, under the folder the script runs
// in: dist, build, out, .next, .nuxt, .turbo, .svelte-kit, coverage, target, .cache, tmp. The paths must stay inside the
// project once normalised: a `..`, a brace, an expansion, a glob in the folder's name, or a link on the way redirects.
// Each case states its expected verdict and the agent's answer text literally (no oracle computed by the code under test).

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import * as Texts from "../../src/permission/autonomy-texts"
import { ADMIN_RIGHTS, ARCHIVE_FIRST, CREDENTIAL_CHANGE, DELETE_COMPOUND, IRREVERSIBLE_ARCHIVE, OUTSIDE_WRITE, answerOf } from "./consented-literals"
import { ScriptReader } from "../../src/permission/script-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { readSteps } from "../../src/tool/shell"
import { tmpdir } from "../fixture/fixture"

type Input = AutonomyTable.Input
type Verdict = AutonomyTable.Verdict

let fixture: Awaited<ReturnType<typeof tmpdir>>
let outside: Awaited<ReturnType<typeof tmpdir>>
let dir: string
let instance: InstanceContext

const SCRIPTS: Record<string, string> = {
  // positive: every deletion targets an output folder of the folder the script runs in
  prebuild: "rm -rf dist",
  build: "tsc -p .",
  clean: "rimraf dist build coverage",
  "clean:all": "rm -rf dist build out .next .nuxt .turbo .svelte-kit coverage target .cache tmp",
  "clean:inside": "rm -rf ./dist/assets dist/*.map",
  "clean:npx": "npx rimraf .next",
  "clean:chain": "rm -rf dist && tsc -p .",
  "clean:sub": "npm run clean",
  "clean:dashdash": "rm -rf -- coverage",
  // negative: any other deletion
  wipe: "rm -rf src",
  up: "rm -rf dist/../src",
  mixed: "rm -rf dist src",
  brace: "rm -rf dist/{a,../../src}",
  glob: "rm -rf d*",
  dollar: "rm -rf $OUT",
  home: "rm -rf ~/dist",
  far: "rm -rf ../elsewhere/dist",
  absolute: "rm -rf /tmp/dist",
  find: "find dist -delete",
  xargs: "ls | xargs rm -rf",
  nested: "rm -rf src/dist",
  shred: "shred -u dist/a.js.map",
  "pre-wipe": "tsc -p .",
  "prepre-wipe": "rm -rf src",
  "clean:then": "rm -rf dist && rm -rf src",
  sudo: "sudo rm -rf dist",
}
// A package whose output folders are links: `build` points at the sources, `coverage/escape` out of the project.
const LINKED: Record<string, string> = {
  linked: "rm -rf build",
  inlink: "rm -rf coverage/escape",
  plain: "rm -rf dist",
}

beforeAll(async () => {
  await ScriptReader.prepare()
  fixture = await tmpdir({ git: true })
  outside = await tmpdir({ git: true })
  dir = fixture.path
  await $`git config --unset core.fsmonitor; git config --unset commit.gpgsign; true`.cwd(dir).quiet().nothrow()
  instance = { directory: dir, worktree: dir, project: { vcs: "git" } } as InstanceContext
  fs.mkdirSync(path.join(dir, "src/dist"), { recursive: true })
  fs.writeFileSync(path.join(dir, "src/a.ts"), "x\n")
  fs.mkdirSync(path.join(dir, "dist/assets"), { recursive: true })
  fs.writeFileSync(path.join(dir, "dist/a.js.map"), "m\n")
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: SCRIPTS }))
  const pkg = path.join(dir, "pkg")
  fs.mkdirSync(path.join(pkg, "src"), { recursive: true })
  fs.symlinkSync(path.join(pkg, "src"), path.join(pkg, "build"))
  fs.mkdirSync(path.join(pkg, "coverage"))
  fs.symlinkSync(outside.path, path.join(pkg, "coverage/escape"))
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ scripts: LINKED }))
  await $`git add -A && git -c user.email=a@b -c user.name=a commit -qm i`.cwd(dir).quiet().nothrow()
})

afterAll(async () => {
  await fixture[Symbol.asyncDispose]()
  await outside[Symbol.asyncDispose]()
})

async function sh(command: string, extra: Partial<Input> = {}): Promise<Input> {
  const cwd = extra.cwd ?? dir
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

const short = (verdict: Verdict) => ({
  class: verdict.class,
  category: verdict.category,
  ...(verdict.bypassed !== undefined && { bypassed: verdict.bypassed }),
})
const RUNS = { class: "A", category: "by_main_agent", bypassed: "not_routine" }
const REDIRECTED = { class: "X", category: "not_reversible", bypassed: "not_routine" }
const HELD = { class: "D", category: "not_routine" }

/** The 1.1.0 verdict without consent, and the consented verdict and answer text for the root and for a subagent. */
async function expectCase(command: string, without: object, consented: object, answer: string | undefined, extra: Partial<Input> = {}) {
  const input = await sh(command, extra)
  const root = AutonomyTable.classify({ ...input, bypass: { caller: "root" } })
  const subagent = AutonomyTable.classify({ ...input, bypass: { caller: "subagent" } })
  expect({
    command,
    without: short(AutonomyTable.classify(input)),
    root: short(root),
    subagent: short(subagent),
    rootAnswer: answerOf(root),
    subagentAnswer: answerOf(subagent),
  } as Record<string, unknown>).toEqual({ command, without, root: consented, subagent: consented, rootAnswer: answer, subagentAnswer: answer })
}

describe("T10: a script that deletes only generated-output folders inside the project runs", () => {
  test("prebuild: rm -rf dist runs, with Undo and without", async () => {
    await expectCase("npm run prebuild", HELD, RUNS, undefined)
    await expectCase("bun run prebuild", HELD, RUNS, undefined)
    await expectCase("npm run prebuild", HELD, RUNS, undefined, { canUndo: false })
    // `npm run build` runs its pre hook: a check (P `check`) that now runs as the main agent's instead of redirecting.
    await expectCase("npm run build", { class: "P", category: "check" }, { ...RUNS, bypassed: "check" }, undefined)
    await expectCase("npm run build", { class: "D", category: "no_undo" }, { ...RUNS, bypassed: "no_undo" }, undefined, { canUndo: false })
  })

  test("every listed folder, things inside one, rimraf through npx, a chain, a script run by name, and --", async () => {
    for (const name of ["clean", "clean:all", "clean:inside", "clean:npx", "clean:chain", "clean:sub", "clean:dashdash"])
      await expectCase(`npm run ${name}`, HELD, RUNS, undefined)
  })

  test("the output folders of a package's own folder count (the folder the script runs in)", async () => {
    await expectCase("npm run plain", HELD, RUNS, undefined, { cwd: path.join(dir, "pkg") })
  })

  test("the list is the one T10 names", () => {
    expect([...AutonomyTable.OUTPUT_FOLDERS].sort()).toEqual(
      [".cache", ".next", ".nuxt", ".svelte-kit", ".turbo", "build", "coverage", "dist", "out", "target", "tmp"],
    )
  })
})

describe("T10 negative: any other deletion in a script still gets ARCHIVE_FIRST", () => {
  test("a source folder, a `..` out of the output folder, a mix, a brace, a glob, an expansion, home, outside", async () => {
    for (const name of ["wipe", "up", "mixed", "brace", "glob", "dollar", "home", "far", "absolute", "nested"])
      for (const undo of [true, false]) await expectCase(`npm run ${name}`, HELD, REDIRECTED, ARCHIVE_FIRST, { canUndo: undo })
  })

  test("forms that are not a plain rm/rimraf of paths: find -delete, xargs; shred is irreversible", async () => {
    for (const name of ["find", "xargs"]) await expectCase(`npm run ${name}`, HELD, REDIRECTED, ARCHIVE_FIRST)
    await expectCase("npm run shred", HELD, { class: "X", category: "irreversible" }, IRREVERSIBLE_ARCHIVE)
  })

  test("one deleting step beside a clean one, or in a hook, still redirects", async () => {
    await expectCase("npm run clean:then", HELD, REDIRECTED, ARCHIVE_FIRST)
    await expectCase("npm run pre-wipe", HELD, REDIRECTED, ARCHIVE_FIRST)
  })

  test("an output folder that is a link, or a link inside one that leaves the project, redirects", async () => {
    const cwd = path.join(dir, "pkg")
    await expectCase("npm run linked", HELD, REDIRECTED, ARCHIVE_FIRST, { cwd })
    await expectCase("npm run inlink", HELD, REDIRECTED, ARCHIVE_FIRST, { cwd })
  })

  test("sudo rm -rf dist is refused for admin rights, not opened", async () => {
    await expectCase("npm run sudo", HELD, { class: "X", category: "admin_rights" }, ADMIN_RIGHTS)
  })

  test("the rule is for scripts only: a direct `rm -rf dist` keeps its own verdict, and -c text keeps G1", async () => {
    await expectCase(`bash -c "rm -rf dist"`, HELD, { ...REDIRECTED, bypassed: "unreadable_command" }, ARCHIVE_FIRST)
  })
})

describe("the literal answer texts match the texts the gate gives", () => {
  test("consented-literals.ts", () => {
    expect(Texts.ARCHIVE_FIRST_TEXT).toBe(ARCHIVE_FIRST)
    expect(Texts.IRREVERSIBLE_ARCHIVE_TEXT).toBe(IRREVERSIBLE_ARCHIVE)
    expect(Texts.DELETE_COMPOUND_TEXT).toBe(DELETE_COMPOUND)
    expect(Texts.OUTSIDE_WRITE_TEXT).toBe(OUTSIDE_WRITE)
    expect(Texts.consentedRefusalText("admin_rights")).toBe(ADMIN_RIGHTS)
    expect(Texts.consentedRefusalText("credential_change")).toBe(CREDENTIAL_CHANGE)
  })
})
