// Swarm 1.1.1 F38 (healing loop 15, refinement of F36 / P52): the fail-closed manifest and environment checks are
// narrowed so ordinary projects are not held (D-F36-3, D-F36-5), and every gap class F36 closed still holds. Classification
// only: no host is contacted, no command runs. Every file a test puts in the fixture home or the environment is taken away.
// 1.1.1 F39 (n86, P54): each hold also checks that the publish's own reading (`sendForm`) held it; the cases V15-1..V15-3
// opened (a token-only `.npmrc`, `CARGO_REGISTRY_TOKEN`, registry tables outside `tool` in pyproject) moved to f39.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { OutwardConsent } from "../../src/permission/outward-consent"
import type { InstanceContext } from "../../src/project/instance-context"
import { Risk } from "../../src/tool/risk"
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
function expectOpens(given: Input, destination: string) {
  for (const verdict of [root(given), subagent(given)])
    expect([label(given), short(verdict)]).toEqual([label(given), ["A", "by_main_agent", destination]])
}
/** Neither the root nor a subagent opens it, and the rule that held it is the publish's own reading (`form`). */
function expectNotOpen(given: Input, why = "") {
  for (const verdict of [root(given), subagent(given)])
    expect([label(given), why, verdict.class === "A", verdict.destination]).toEqual([label(given), why, false, undefined])
  const steps = (given.metadata.steps as { steps: { argv: string[] }[] } | undefined)?.steps ?? []
  const step = steps.find((item) => OutwardConsent.SEND_PROGRAMS.has(item.argv[0]!))!
  const found = OutwardConsent.sendForm(step.argv[0]!, step.argv.slice(1), given.cwd, { instance: given.instance })
  expect([label(given), why, found]).toEqual([label(given), why, { held: "form" }])
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


const destinationOf = (command: string) => (PLAIN.find(([plain]) => plain === command) ?? [])[2]!
const NODE_PUBLISH = ["npm publish", "pnpm publish", "yarn npm publish", "bun publish"]

describe("F38 / D-F36-5: an otherwise clean project with ordinary manifests opens", () => {
  test("package.json: a backslash anywhere opens (JSON.parse decodes it as every npm-family tool does)", async () => {
    const manifest = '{"name":"p","version":"1.0.0","description":"a \\u0022quoted\\u0022 word","scripts":{"x":"echo \\"a\\" \\\\ b"}}'
    const here = await project({ "package.json": manifest })
    for (const command of NODE_PUBLISH) expectOpens(await sh(command, here), "registry.npmjs.org")
  })

  test("pyproject.toml: quoted keys, backslashes and destination words outside the checked tables open", async () => {
    for (const pyproject of [
      PYPROJECT + '[project.urls]\n"Bug Tracker" = "https://x.test/issues"\nRepository = "https://x.test/source"\n',
      PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\ndescription = "a \\"quoted\\" registry index"'),
      PYPROJECT + '[project.optional-dependencies]\n"dev-tools" = ["pytest"]\n[project."entry-points".x]\ny = "z"\n',
      PYPROJECT + '[dependency-groups]\ndev = ["pytest", { include-group = "lint" }]\nlint = ["ruff"]\n',
      PYPROJECT + "[tool.ruff]\nline-length = 100\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n",
      // A header-looking line inside a multi-line string is prose: the reader walks the string.
      PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme-text = """\n[tool.uv]\npublish-url = "https://pypi.evil.example/"\n"""'),
    ])
      for (const tool of ["uv", "poetry"]) expectOpens(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject })), "pypi.org")
  })

  test("Cargo.toml: plain [package] metadata, target tables, dependency registries and publish = true open", async () => {
    for (const manifest of [
      '[package]\nname = "x"\nversion = "0.1.0"\nrepository = "https://github.com/x/source"\nhomepage = "https://x.test/"\nlicense = "MIT"\nauthors = ["A <a@x.test>"]\n',
      CRATE + "[target.'cfg(unix)'.dependencies]\nlibc = \"0.2\"\n",
      CRATE + '[target."x86_64-unknown-linux-gnu".dev-dependencies]\nfoo = "1"\n',
      // D-F38-3: a dependency's registry is where it comes from, not where this package goes.
      CRATE.replace('serde = { version = "1" }', 'serde = { version = "1", registry = "corp" }\n[dependencies.other]\nversion = "1"\nregistry-index = "sparse+https://x.test/"'),
      '[package]\nname = "x"\nversion = "0.1.0"\npublish = true\ndescription = "say \\"hi\\" to the registry"\n',
      CRATE + '[package.metadata.docs.rs]\nall-features = true\n',
      CRATE + '[features]\ndefault = ["std"]\nstd = []\n[profile.release]\nlto = true\n',
    ])
      expectOpens(await sh("cargo publish", await project({ "Cargo.toml": manifest })), "crates.io")
  })

  test("environment variables that do not name a destination open", async () => {
    const cases: [string, string, string][] = [
      ["npm publish", "npm_config_cache", "/tmp/x"],
      ["npm publish", "npm_config_user_agent", "npm/10"],
      ["npm publish", "npm_config_node_gyp", "/x/node-gyp"],
      ["pnpm publish", "pnpm_config_verify_store_integrity", "true"],
      ["yarn npm publish", "YARN_ENABLE_TELEMETRY", "0"],
      ["bun publish", "BUN_CONFIG_NO_CACHE", "1"],
      ["cargo publish", "CARGO_TARGET_DIR", "/tmp/x"],
      ["uv publish", "UV_CACHE_DIR", "/tmp/x"],
      ["uv publish", "UV_PUBLISH_USERNAME", "u"],
      ["poetry publish", "POETRY_PYPI_TOKEN_PYPI", "x"],
      ["poetry publish", "POETRY_VIRTUALENVS_IN_PROJECT", "true"],
      ["twine upload dist/x-0.1.0.tar.gz", "TWINE_USERNAME", "u"],
      ["twine upload dist/x-0.1.0.tar.gz", "TWINE_PASSWORD", "p"],
    ]
    for (const [command, key, value] of cases) {
      setEnv(key, value)
      expectOpens(await sh(command, await make((PLAIN.find(([plain]) => plain === command) ?? [])[1]!)), destinationOf(command))
      delete process.env[key]
    }
  })

  test("D-F36-3: the config pointers `npm run` exports open while the files they name are absent, and hold once present", async () => {
    const here = await npmProject()
    const places = await temp()
    setEnv("npm_config_userconfig", path.join(places, "user.npmrc"))
    setEnv("npm_config_globalconfig", path.join(places, "etc", "npmrc"))
    setEnv("npm_config_prefix", places)
    setEnv("npm_config_local_prefix", here)
    for (const command of NODE_PUBLISH) expectOpens(await sh(command, here), "registry.npmjs.org")
    for (const file of ["user.npmrc", "etc/npmrc"]) {
      write(places, file, "registry=https://npm.evil.example/\n")
      for (const command of NODE_PUBLISH) expectNotOpen(await sh(command, here), file)
      fs.rmSync(path.join(places, file))
    }
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
    // A pointer npm would resolve itself (`~`, relative) holds.
    setEnv("npm_config_userconfig", "~/.npmrc")
    expectNotOpen(await sh("npm publish", here), "tilde")
  })
})

describe("F38: each gap class F36 closed still holds", () => {
  test("package.json: publishConfig with any key in any spelling, a duplicate; a file JSON.parse rejects", async () => {
    for (const manifest of [
      // An empty publishConfig opens (f33), but not when a second or an escaped spelling could be read instead of it.
      '{"name":"p","publishConfig":{"registry":"https://npm.evil.example/"},"publishConfig":{}}',
      '{"name":"p","publish\\u0043onfig":{"registry":"https://npm.evil.example/"},"publishConfig":{}}',
      JSON.stringify({ name: "p", version: "1.0.0", publishConfig: { registry: "https://npm.evil.example/" } }),
      '{"name":"p","version":"1.0.0","publish\\u0043onfig":{"registry":"https://npm.evil.example/"}}',
      '{"name":"p","version":"1.0.0",}',
      '["p"]',
    ])
      for (const command of NODE_PUBLISH) expectNotOpen(await sh(command, await project({ "package.json": manifest })), manifest)
  })

  test("rule 2(a): a table header written with a quote or an escape holds", async () => {
    for (const [tool, pyproject] of [
      ["uv", PYPROJECT + '["tool".uv]\nnative-tls = true\n'],
      ["uv", PYPROJECT + '["t\\u006fol".uv]\nnative-tls = true\n'],
      ["uv", PYPROJECT + "[tool.'uv']\nnative-tls = true\n"],
      ["poetry", PYPROJECT + '[tool."poetry"]\nname = "x"\n'],
      // A key before any header names its own table the same way.
      ["uv", '"tool".uv.native-tls = true\n' + PYPROJECT],
    ] as const)
      expectNotOpen(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject })), pyproject)
    for (const manifest of ['["package"]\nname = "x"\nversion = "0.1.0"\n', "['p\\u0061ckage']\nname = \"x\"\nversion = \"0.1.0\"\n", CRATE + '["workspace"]\n'])
      expectNotOpen(await sh("cargo publish", await project({ "Cargo.toml": manifest })), manifest)
  })

  test("rule 2(b): an escaped or quoted key, an escape, an inline table or a destination word in a checked table holds", async () => {
    for (const [tool, pyproject] of [
      ["uv", PYPROJECT + '[tool.uv]\n"publish\\u002durl" = "https://pypi.evil.example/"\n'],
      ["uv", PYPROJECT + '[tool.uv]\n"native-tls" = true\n'],
      ["uv", PYPROJECT + '[tool.uv]\nkeyring-provider = "\\u0073ubprocess"\n'],
      ["uv", PYPROJECT + "[tool.uv]\npublish-url = \"https://pypi.evil.example/\"\n"],
      ["uv", PYPROJECT + "[tool.uv]\ncheck-url = \"https://pypi.evil.example/simple/\"\n"],
      ["uv", PYPROJECT + '[[tool.uv.index]]\nname = "corp"\n'],
      ["uv", PYPROJECT + "[tool.uv]\nsettings = { a = 1 }\n"],
      ["uv", PYPROJECT + "[tool]\nuv.publish-url = \"https://pypi.evil.example/\"\n"],
      ["uv", 'tool.uv.publish-url = "https://pypi.evil.example/"\n' + PYPROJECT],
      ["uv", PYPROJECT + '[tool.uv]\nx = """\n[project]\n"""\npublish-url = "https://pypi.evil.example/"\n'],
      ["poetry", PYPROJECT + '[[tool.poetry.source]]\nname = "corp"\n'],
      ["poetry", PYPROJECT + '[tool.poetry]\nname = "x"\npackages = [{ include = "x" }]\n'],
      ["uv", PYPROJECT + "[tool.uv\n"],
    ] as const)
      expectNotOpen(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject })), pyproject)
  })

  // 1.1.1 F39 (n86): `[patch]` holds only in an inline table or under a quoted key; a plain `[patch.crates-io.foo]`
  // opens, as a published crate drops `[patch]` (asserted at the end).
  test("Cargo.toml: publish lists, quoted package keys, metadata, workspace, and patch tables with inline or quoted entries hold", async () => {
    for (const manifest of [
      '[package]\nname = "x"\nversion = "0.1.0"\npublish = ["corp"]\n',
      '[package]\nname = "x"\nversion = "0.1.0"\npublish = false\n',
      '[package]\nname = "x"\nversion = "0.1.0"\npublish.workspace = true\n',
      '[package]\nname = "x"\nversion = "0.1.0"\n"publish" = true\n',
      '[package]\nname = "x"\nversion = "0.1.0"\n"pub\\u006cish" = ["corp"]\n',
      CRATE + '[package.metadata.x]\nrepository = "https://x.test/"\n',
      '[package]\nname = "x"\nversion = "0.1.0"\nmetadata = { a = 1 }\n',
      'package = { name = "x", version = "0.1.0" }\n',
      '[package]\nname = "x"\nversion = "0.1.0"\n[workspace]\n',
      CRATE + '[workspace.package]\nversion = "1"\n',
      CRATE + '[patch.crates-io]\nfoo = { path = "../foo" }\n',
      CRATE + '[replace]\n"foo:0.1.0" = { path = "../foo" }\n',
      '[dependencies]\nserde = "1"\n',
    ])
      expectNotOpen(await sh("cargo publish", await project({ "Cargo.toml": manifest })), manifest)
    expectOpens(await sh("cargo publish", await project({ "Cargo.toml": CRATE + '[patch.crates-io.foo]\npath = "../foo"\n' })), "crates.io")
  })

  test("registry environment variables hold, by name", async () => {
    const cases: [string, string][] = [
      ["npm publish", "npm_config_registry"],
      ["npm publish", "NPM_CONFIG_REGISTRY"],
      ["npm publish", "npm_config_@corp:registry"],
      ["npm publish", "npm_config_replace_registry_host"],
      ["pnpm publish", "pnpm_config_registry"],
      ["yarn npm publish", "YARN_NPM_REGISTRY_SERVER"],
      ["yarn npm publish", "YARN_NPM_SCOPES"],
      ["yarn npm publish", "YARN_NPM_PUBLISH_REGISTRY"],
      ["yarn npm publish", "YARN_RC_FILENAME"],
      ["yarn npm publish", "npm_config_registry"],
      ["bun publish", "BUN_CONFIG_REGISTRY"],
      ["bun publish", "NPM_CONFIG_REGISTRY"],
      ["cargo publish", "CARGO_REGISTRY_DEFAULT"],
      ["cargo publish", "CARGO_REGISTRIES_CORP_INDEX"],
      ["uv publish", "UV_INDEX"],
      ["uv publish", "UV_INDEX_URL"],
      ["uv publish", "UV_DEFAULT_INDEX"],
      ["uv publish", "UV_EXTRA_INDEX_URL"],
      ["uv publish", "UV_PUBLISH_URL"],
      ["uv publish", "UV_PUBLISH_CHECK_URL"],
      ["uv publish", "UV_PUBLISH_INDEX"],
      ["uv publish", "UV_CONFIG_FILE"],
      ["uv publish", "UV_PROJECT"],
      ["poetry publish", "POETRY_REPOSITORIES_CORP_URL"],
      ["twine upload dist/x-0.1.0.tar.gz", "TWINE_REPOSITORY"],
      ["twine upload dist/x-0.1.0.tar.gz", "TWINE_REPOSITORY_URL"],
      ["twine upload dist/x-0.1.0.tar.gz", "TWINE_CONFIG_FILE"],
    ]
    for (const [command, key] of cases) {
      const here = await make((PLAIN.find(([plain]) => plain === command) ?? [])[1]!)
      setEnv(key, "x")
      expectNotOpen(await sh(command, here), key)
      delete process.env[key]
      expectOpens(await sh(command, here), destinationOf(command))
    }
  })

  test("rule 4: config-file presence still holds (an .npmrc line outside the allowlist, an empty uv.toml)", async () => {
    expectNotOpen(await sh("npm publish", await npmProject({ ".npmrc": "//registry.npmjs.org/:_authToken=x\ncafile=/x\n" })))
    expectNotOpen(await sh("uv publish", await python({ "uv.toml": "" })))
  })
})
