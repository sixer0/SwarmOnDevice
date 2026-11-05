// Swarm 1.1.1 F36 (healing loop 15): a publish's registry configuration is judged by presence, not parsed (controller
// ruling P52). One regression test per finding of gate 14 (security G14-1..G14-5, G14-7; code review CR14-1, CR14-2,
// CR14-4, CR14-5, CR14-7, CR14-8, G14-P1, n75); CR14-3 is tested in `autonomy-bypass-gate.test.ts`. Classification only:
// no host is contacted, no command runs. Every file a test puts in the fixture home or the environment is taken away.
// 1.1.1 F38 narrowed the rules (D-F36-3, D-F36-5): the over-held cases left this file for f38-outward.test.ts, where they open.
// 1.1.1 F39 (P54) opened a few more (V15-1: an allowlisted `.npmrc`, `[build] command`, `[[redirects]]`; V15-3), tested in f39.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { OutwardConsent } from "../../src/permission/outward-consent"
import { OutwardKnown } from "../../src/permission/outward-known"
import { TomlReader } from "../../src/permission/toml-reader"
import type { InstanceContext } from "../../src/project/instance-context"
import { Risk } from "../../src/tool/risk"
import { readSteps } from "../../src/tool/shell"
import { ADMIN_RIGHTS, ARCHIVE_FIRST, CREDENTIAL_CHANGE, DELETE_COMPOUND, IRREVERSIBLE_ARCHIVE, OUTSIDE_WRITE, answerOf } from "./consented-literals"
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
const project = async (files: Record<string, string>) => {
  const dir = await temp()
  await $`git init -q`.cwd(dir).quiet()
  await $`git -c core.fsmonitor=false -c commit.gpgsign=false -c user.email=t@t.test -c user.name=T commit -q --allow-empty -m root`.cwd(dir).quiet()
  for (const [name, content] of Object.entries(files)) write(dir, name, content)
  return dir
}
const scope = (dir: string) => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext

async function sh(command: string, dir: string): Promise<Input> {
  const reading = await readSteps(command, dir)
  const risky = reading?.steps.map((step) => Risk.classify([...step.argv])).find((verdict) => verdict.kind === "risky")
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(reading ? { steps: reading } : {}), ...(risky && risky.kind === "risky" ? { risk: risky.risk } : {}) },
    instance: scope(dir),
    cwd: dir,
    canUndo: true,
    folder: "clean",
  }
}
const root = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "root" } })
const subagent = (given: Input) => AutonomyTable.classify({ ...given, bypass: { caller: "subagent" } })
const short = (verdict: Verdict) => [verdict.class, verdict.category, verdict.destination]
const label = (given: Input) => String(given.metadata.command)

/** 1.1.3 (T9 G8): a literal consented verdict per case: class, category, `bypassed`, destination, and the agent's answer. */
type Want = { verdict: [string, string, string | undefined, string | undefined]; answer: string | undefined }
const RUNS = (bypassed: string, destination?: string): Want => ({ verdict: ["A", "by_main_agent", bypassed, destination], answer: undefined })
const REFUSED = (category: string, bypassed: string | undefined, answer: string): Want => ({ verdict: ["X", category, bypassed, undefined], answer })
function expectWant(label: string, verdict: Verdict, want: Want) {
  expect([label, verdict.class, verdict.category, verdict.bypassed, verdict.destination, answerOf(verdict)]).toEqual([label, ...want.verdict, want.answer])
}
function expectOpens(given: Input, destination: string) {
  for (const verdict of [root(given), subagent(given)])
    expect([label(given), short(verdict)]).toEqual([label(given), ["A", "by_main_agent", destination]])
}
function expectNotOpen(given: Input, why: string, want: Want) {
  for (const verdict of [root(given), subagent(given)]) expectWant(`${label(given)} ${why}`.trim(), verdict, want)
}

const home = () => process.env.HOME || os.homedir()
const config = () => process.env.XDG_CONFIG_HOME || path.join(home(), ".config")
const placed: string[] = []
const envSet: string[] = []
const atHome = (relative: string, content: string) => {
  write(home(), relative, content)
  placed.push(path.join(home(), relative))
}
const atConfig = (relative: string, content: string) => {
  write(config(), relative, content)
  placed.push(path.join(config(), relative))
}
const setEnv = (key: string, value: string) => {
  process.env[key] = value
  envSet.push(key)
}

const PACKAGE = JSON.stringify({ name: "p", version: "1.0.0" })
const CRATE = '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n[dependencies]\nserde = { version = "1" }\n'
const PYPROJECT = '[project]\nname = "x"\nversion = "0.1.0"\ndependencies = [\n  "requests",\n]\n[build-system]\nrequires = ["hatchling"]\n'
const npmProject = (files: Record<string, string> = {}) => project({ "package.json": PACKAGE, ...files })
const crate = (files: Record<string, string> = {}) => project({ "Cargo.toml": CRATE, ...files })
const python = (files: Record<string, string> = {}) => project({ "pyproject.toml": PYPROJECT, "dist/x-0.1.0.tar.gz": "t", ...files })

/** Every plain publish, with the project kind it needs and where it is recorded. */
const PLAIN = [
  ["npm publish", "node", "registry.npmjs.org"],
  ["pnpm publish", "node", "registry.npmjs.org"],
  ["yarn npm publish", "node", "registry.npmjs.org"],
  ["bun publish", "node", "registry.npmjs.org"],
  ["cargo publish", "cargo", "crates.io"],
  ["uv publish", "python", "pypi.org"],
  ["poetry publish", "python", "pypi.org"],
  ["twine upload dist/x-0.1.0.tar.gz", "python", "pypi.org"],
] as const
const make = (kind: "node" | "cargo" | "python", files: Record<string, string> = {}) =>
  kind === "node" ? npmProject(files) : kind === "cargo" ? crate(files) : python(files)

beforeAll(() => {
  // The fixture home must be a test one: these tests write files into it.
  expect(path.resolve(home())).not.toBe(path.join("/Users", os.userInfo().username))
})
afterEach(() => {
  for (const file of placed.splice(0)) fs.rmSync(file, { force: true })
  for (const key of envSet.splice(0)) delete process.env[key]
})
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

describe("P52: a plain publish opens when the tool has no registry configuration anywhere", () => {
  test("fixture home with no config: every plain publish opens", async () => {
    for (const [command, kind, destination] of PLAIN) expectOpens(await sh(command, await make(kind)), destination)
  })
})

describe("G14-1 / G14-3 / CR14-1 / P52: a registry-capable config file in the project holds, whatever it says", () => {
  test("each project file type, for the tools that read it", async () => {
    const cases: [string, "node" | "cargo" | "python", string, string][] = [
      // G14-1: npm decodes these spellings to the registry key; none is parsed any more.
      ["npm publish", "node", ".npmrc", '"registry"=https://npm.evil.example/\n'],
      ["npm publish", "node", ".npmrc", "registry[]=https://npm.evil.example/\r"],
      // 1.1.1 F39 (V15-1, P54): an `.npmrc` of only allowlisted lines opens (f39); any other line holds.
      ["pnpm publish", "node", ".npmrc", "always-auth=true\n"],
      ["pnpm publish", "node", "pnpm-workspace.yaml", "packages: []\n"],
      ["bun publish", "node", ".npmrc", "cafile=/x\n"],
      // G14-3: yarn files.
      ["yarn npm publish", "node", ".yarnrc.yml", '"npm\\x52egistryServer": "https://npm.evil.example/"\n'],
      ["yarn npm publish", "node", ".yarnrc", "network-timeout 600000\n"],
      ["yarn npm publish", "node", ".npmrc", "strict-ssl=false\n"],
      // CR14-1: an escaped quoted TOML key.
      ["bun publish", "node", "bunfig.toml", '[install]\n"\\u0072egistry" = "https://npm.evil.example/"\n'],
      ["cargo publish", "cargo", ".cargo/config.toml", '["\\u0072egistry"]\ndefault = "evil"\n'],
      ["cargo publish", "cargo", ".cargo/config", "[net]\nretry = 2\n"],
      ["uv publish", "python", "uv.toml", '"publish\\u002durl" = "https://pypi.evil.example/"\n'],
      ["poetry publish", "python", "poetry.toml", "[virtualenvs]\nin-project = true\n"],
      ["twine upload dist/x-0.1.0.tar.gz", "python", ".pypirc", "[distutils]\nindex-servers = pypi\n"],
    ]
    for (const [command, kind, file, content] of cases) expectNotOpen(await sh(command, await make(kind, { [file]: content })), file, RUNS("outward"))
  })

  test("a config file in a folder above the project holds too", async () => {
    const outer = await temp()
    const inner = path.join(outer, "proj")
    fs.mkdirSync(inner)
    await $`git init -q`.cwd(inner).quiet()
    write(inner, "package.json", PACKAGE)
    expectOpens(await sh("npm publish", inner), "registry.npmjs.org")
    write(outer, ".npmrc", "registry=https://npm.evil.example/\n")
    expectNotOpen(await sh("npm publish", inner), "", RUNS("outward"))
    write(inner, "Cargo.toml", CRATE)
    expectOpens(await sh("cargo publish", inner), "crates.io")
    write(outer, ".cargo/config.toml", "")
    expectNotOpen(await sh("cargo publish", inner), "", RUNS("outward"))
    // A workspace root above, by its manifest alone.
    fs.rmSync(path.join(outer, ".cargo"), { recursive: true })
    write(outer, "Cargo.toml", '[workspace]\nmembers = ["proj"]\n')
    expectNotOpen(await sh("cargo publish", inner), "", RUNS("outward"))
  })
})

describe("G14-1 / G14-4 / G14-5 / CR14-8 / P52: a config file in the user's locations holds", () => {
  test("each user file type, for the tools that read it", async () => {
    const cases: [string, "node" | "cargo" | "python", "home" | "config", string][] = [
      ["npm publish", "node", "home", ".npmrc"],
      ["pnpm publish", "node", "home", ".npmrc"],
      // G14-4 / CR14-8: pnpm's global rc.
      ["pnpm publish", "node", "config", "pnpm/rc"],
      ["pnpm publish", "node", "home", ".config/pnpm/rc"],
      ["pnpm publish", "node", "home", "Library/Preferences/pnpm/rc"],
      ["pnpm publish", "node", "home", "AppData/Local/pnpm/config/rc"],
      ["yarn npm publish", "node", "home", ".yarnrc.yml"],
      ["yarn npm publish", "node", "home", ".yarnrc"],
      ["bun publish", "node", "home", ".bunfig.toml"],
      ["bun publish", "node", "config", ".bunfig.toml"],
      ["cargo publish", "cargo", "home", ".cargo/config.toml"],
      ["cargo publish", "cargo", "home", ".cargo/config"],
      ["uv publish", "python", "config", "uv/uv.toml"],
      ["uv publish", "python", "home", ".config/uv/uv.toml"],
      ["poetry publish", "python", "config", "pypoetry/config.toml"],
      ["poetry publish", "python", "home", "Library/Application Support/pypoetry/config.toml"],
      // G14-5: twine's repository file in any spelling, and pip's config.
      ["twine upload dist/x-0.1.0.tar.gz", "python", "home", ".pypirc"],
      ["twine upload dist/x-0.1.0.tar.gz", "python", "config", "pip/pip.conf"],
      ["twine upload dist/x-0.1.0.tar.gz", "python", "home", ".pip/pip.conf"],
      ["twine upload dist/x-0.1.0.tar.gz", "python", "home", "Library/Application Support/pip/pip.conf"],
    ]
    for (const [command, kind, where, file] of cases) {
      const here = await make(kind)
      ;(where === "home" ? atHome : atConfig)(file, "[pypi]\r\nREPOSITORY = https://pypi.evil.example/\r\n")
      expectNotOpen(await sh(command, here), `${where}:${file}`, RUNS("outward"))
      for (const made of placed.splice(0)) fs.rmSync(made, { force: true })
      expectOpens(await sh(command, here), (PLAIN.find(([plain]) => plain === command) ?? [])[2]!)
    }
  })

  test("CARGO_HOME is read where it points; pnpm's rc does not hold npm", async () => {
    const here = await crate()
    const cargoHome = await temp()
    setEnv("CARGO_HOME", cargoHome)
    expectOpens(await sh("cargo publish", here), "crates.io")
    write(cargoHome, "config.toml", "")
    expectNotOpen(await sh("cargo publish", here), "", RUNS("outward"))
    const node = await npmProject()
    atConfig("pnpm/rc", "registry=https://npm.evil.example/\n")
    expectNotOpen(await sh("pnpm publish", node), "", RUNS("outward"))
    expectOpens(await sh("npm publish", node), "registry.npmjs.org")
  })
})

describe("P52: any listed environment variable holds", () => {
  test("each variable family, by name only", async () => {
    const cases: [string, "node" | "cargo" | "python", string][] = [
      ["npm publish", "node", "NPM_CONFIG_REGISTRY"],
      ["pnpm publish", "node", "pnpm_config_registry"],
      ["yarn npm publish", "node", "YARN_NPM_REGISTRY_SERVER"],
      ["yarn npm publish", "node", "npm_config_registry"],
      ["bun publish", "node", "BUN_CONFIG_REGISTRY"],
      ["cargo publish", "cargo", "CARGO_REGISTRY_DEFAULT"],
      ["cargo publish", "cargo", "CARGO_REGISTRIES_CORP_INDEX"],
      ["uv publish", "python", "UV_PUBLISH_URL"],
      ["poetry publish", "python", "POETRY_REPOSITORIES_CORP_URL"],
      ["twine upload dist/x-0.1.0.tar.gz", "python", "TWINE_REPOSITORY_URL"],
    ]
    for (const [command, kind, key] of cases) {
      const here = await make(kind)
      setEnv(key, "x")
      expectNotOpen(await sh(command, here), key, RUNS("outward"))
      delete process.env[key]
      expectOpens(await sh(command, here), (PLAIN.find(([plain]) => plain === command) ?? [])[2]!)
    }
  })
})

describe("P52 / CR14-1 / CR14-4 / G14-7: the root manifest must be plain", () => {
  test("package.json: no publishConfig key", async () => {
    for (const manifest of [
      JSON.stringify({ name: "p", version: "1.0.0", publishConfig: { tag: "next" } }),
      '{"name":"p","version":"1.0.0","publish\\u0043onfig":{"registry":"https://npm.evil.example/"}}',
    ])
      expectNotOpen(await sh("npm publish", await project({ "package.json": manifest })), manifest, RUNS("outward"))
  })

  test("pyproject.toml: no backslash, no quoted key, no destination word or inline table in a tool table", async () => {
    for (const [tool, pyproject] of [
      // CR14-1: an escaped quoted key.
      ["uv", PYPROJECT + '[tool.uv]\n"publish\\u002durl" = "https://pypi.evil.example/"\n'],
      ["uv", PYPROJECT + '[tool.uv]\n"publish-url" = "https://pypi.evil.example/"\n'],
      // CR14-4: uv's check-url.
      ["uv", PYPROJECT + '[tool.uv]\ncheck-url = "https://pypi.evil.example/simple/"\n'],
      ["uv", PYPROJECT + '[[tool.uv.index]]\nname = "corp"\n'],
      ["uv", PYPROJECT + "[tool.uv]\nsettings = { a = 1 }\n"],
      ["uv", 'tool = { uv = { publish-url = "https://pypi.evil.example/" } }\n' + PYPROJECT],
      ["poetry", PYPROJECT + '[[tool.poetry.source]]\nname = "corp"\n'],
      ["poetry", PYPROJECT + '[tool.poetry]\nname = "x"\npackages = [{ include = "x" }]\n'],
      ["uv", PYPROJECT + "[tool.uv\n"],
    ] as const)
      expectNotOpen(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject })), pyproject, RUNS("outward"))
    // Words in [project] (its URLs, its description) and plain tool tables do not hold.
    const plain = PYPROJECT + '[project.urls]\nRepository = "https://x.test/source"\n[tool.ruff]\nline-length = 100\n'
    expectOpens(await sh("uv publish", await python({ "pyproject.toml": plain })), "pypi.org")
  })

  test("Cargo.toml: plain package fields only, no workspace (an empty one too, G14-7), no quoted key", async () => {
    for (const manifest of [
      CRATE + '[package.metadata.x]\nrepository = "https://x.test/"\n',
      '[package]\nname = "x"\nversion = "0.1.0"\npublish = ["corp"]\n',
      '[package]\nname = "x"\nversion = "0.1.0"\n[workspace]\n',
      CRATE + '[patch.crates-io]\nfoo = { path = "\\u002e./foo" }\n',
      '[package]\nname = "x"\nversion = "0.1.0"\nmetadata = { a = 1 }\n',
      '["package"]\nname = "x"\nversion = "0.1.0"\n',
    ])
      expectNotOpen(await sh("cargo publish", await project({ "Cargo.toml": manifest })), manifest, RUNS("outward"))
    // A description with a destination word in it is prose: still plain.
    expectOpens(await sh("cargo publish", await project({ "Cargo.toml": CRATE.replace('edition', 'description = "an open source registry tool"\nedition') })), "crates.io")
  })
})

// 1.1.1 F39 (V15-1, P54): `[build] command` and `[[redirects]]` open now (f39); the rest of this list still holds.
describe("CR14-2 / P52: netlify.toml opens only as a [build] table with a plain publish", () => {
  test("only `[build] publish = \"<inside>\"`", async () => {
    const command = "netlify deploy --prod --no-build --dir dist"
    expectOpens(await sh(command, await project({ "dist/index.html": "x" })), "netlify")
    expectOpens(await sh(command, await project({ "dist/index.html": "x", "netlify.toml": '[build]\npublish = "dist"\n' })), "netlify")
    expectOpens(await sh(command, await project({ "dist/index.html": "x", "netlify.toml": '# site\n[build]\npublish = "dist" # out\n' })), "netlify")
    for (const toml of [
      // CR14-2: included_files inside an inline table.
      '[functions]\n"*" = { included_files = ["../../outside/**"] }\n',
      '[functions]\nmy-fn = { included_files = ["/etc/**"] }\n',
      '[build]\npublish = "../outside"\n',
      '[build]\n"publish" = "dist"\n',
      '[build]\npublish = "d\\u0069st"\n',
      'build = { publish = "dist" }\n',
      '[[build]]\npublish = "dist"\n',
      '[build]\npublish = "dist"\n[context.production]\n',
      '[build\npublish = "dist"\n',
    ])
      expectNotOpen(await sh(command, await project({ "dist/index.html": "x", "netlify.toml": toml })), toml, RUNS("outward"))
  })
})

describe("CR14-7: uv, poetry and twine upload files that land inside the project", () => {
  test("a dist entry that is a link out holds", async () => {
    const outside = await temp()
    write(outside, "secret.tar.gz", "s")
    const here = await python()
    fs.symlinkSync(path.join(outside, "secret.tar.gz"), path.join(here, "dist", "a-1.0.tar.gz"))
    for (const command of ["uv publish", "poetry publish", "twine upload dist/a-1.0.tar.gz"]) expectNotOpen(await sh(command, here), "", RUNS("outward"))
    // The form itself holds a twine file that lands outside, before the bypass screen looks at the word.
    expect(OutwardConsent.sendForm("twine", ["upload", "dist/a-1.0.tar.gz"], here, { instance: scope(here) })).toEqual({ held: "form" })
    expect(OutwardConsent.sendForm("twine", ["upload", "dist/*"], here, { instance: scope(here) })).toEqual({ held: "form" })
    fs.rmSync(path.join(here, "dist", "a-1.0.tar.gz"))
    expectOpens(await sh("uv publish", here), "pypi.org")
    expect(OutwardConsent.sendForm("twine", ["upload", "dist/*"], here, { instance: scope(here) })).toEqual({ destinations: ["pypi.org"], outputs: [] })
  })
})

describe("CR14-5: id and info are no bare-name endings", () => {
  test("code member names do not count; URLs still do", () => {
    expect(OutwardKnown.personHosts("rename session.id and user.id, see node.info")).toEqual([])
    expect(OutwardKnown.personHosts("see socket.io")).toEqual(["socket.io"])
    expect(OutwardKnown.personHosts("check https://example.id/ and https://status.example.info/x")).toEqual(["example.id", "status.example.info"])
    for (const ending of ["id", "info"]) expect([ending, OutwardKnown.WEB_TLDS.has(ending)]).toEqual([ending, false])
  })
})

describe("G14-P1: one classify reads a publish's form once", () => {
  test("the registry configuration is looked for once per classify", async () => {
    const here = await npmProject()
    const given = await sh("npm publish", here)
    for (const run of [root, subagent]) {
      const before = OutwardConsent.formCounters.settings
      expect(short(run(given))).toEqual(["A", "by_main_agent", "registry.npmjs.org"])
      expect(OutwardConsent.formCounters.settings - before).toBe(1)
    }
    // Outside a classify each call looks again.
    const before = OutwardConsent.formCounters.settings
    OutwardConsent.sendForm("npm", ["publish"], here)
    OutwardConsent.sendForm("npm", ["publish"], here)
    expect(OutwardConsent.formCounters.settings - before).toBe(2)
  })
})

describe("n75 / P52: dead parts are gone", () => {
  test("FormContext has no `known`; the per-tool registry readers are removed", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/permission/outward-consent.ts"), "utf8")
    const context = /export type FormContext = \{[^}]*\}/.exec(source)?.[0] ?? ""
    expect(context.includes("instance")).toBe(true)
    expect(context.includes("known")).toBe(false)
    for (const gone of ["nodeSettings", "cargoSettings", "pythonSettings", "twineSettings", "tomlSays"])
      expect([gone, source.includes(gone)]).toEqual([gone, false])
    expect(fs.readFileSync(path.join(import.meta.dir, "../../src/permission/bypass-screen.ts"), "utf8").includes("known: input.outward")).toBe(false)
  })

  // 1.1.1 F39 (n85): `quoted` is gone; the key as written (`key`) is the one mechanism.
  test("the reader keeps each key as written and lists table headers", () => {
    const found = TomlReader.entries('[a]\nb = 1\n["c"]\nd = { "e" = 1 }\nf.g = 2\n')
    expect(found?.map((entry) => [entry.path.join("/"), entry.key, entry.table])).toEqual([
      ["a", "a", true],
      ["a/b", "b", false],
      ["c", '"c"', true],
      ["c/d", "d", false],
      ["c/f/g", "f.g", false],
    ])
    expect(TomlReader.entries('x = { "y" = 1 }\nz = 1\n')?.map((entry) => entry.raw)).toEqual(['{ "y" = 1 }', "1"])
  })
})
