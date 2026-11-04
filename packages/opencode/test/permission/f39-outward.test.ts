// Swarm 1.1.1 F39 (healing loop 16, controller ruling P54): one test per gate-15 item. Security: G15-1 (a write beside a
// publish or deploy in the same call), G15-2 (other netlify config formats), G15-3 (yarn 1 config locations), CR15-1
// (files a package carries by name must land inside the project), CR15-2 (tracked links under the package). Usability:
// V15-1 (a strict line allowlist for `.npmrc`, a plain `netlify.toml`), V15-2 (pyproject: only uv and poetry tables are
// looked into), V15-3 (CARGO_REGISTRY_TOKEN). Nits n82, n83, n84, n85. Each hold also says which rule held it: "form"
// (the publish's own reading holds it) or "call" (the publish alone opens, the call around it does not). Classification
// only: no host is contacted, no command runs. Every file a test puts in the fixture home or the environment is taken away.

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { $ } from "bun"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import { OutwardConsent } from "../../src/permission/outward-consent"
import { ScriptReader } from "../../src/permission/script-reader"
import { TomlReader } from "../../src/permission/toml-reader"
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
/** The send step of a call, read on its own (`OutwardConsent.sendForm`): "form" when it holds, "opens" when it opens. */
function formOf(given: Input) {
  const steps = (given.metadata.steps as { steps: { argv: string[] }[] } | undefined)?.steps ?? []
  const step = steps.find((item) => OutwardConsent.SEND_PROGRAMS.has(item.argv[0]!) && item.argv[0] !== "git")
  if (!step) return "none"
  const found = OutwardConsent.sendForm(step.argv[0]!, step.argv.slice(1), given.cwd, { instance: given.instance })
  return found === undefined ? "none" : "held" in found ? found.held : "opens"
}
/**
 * Neither the root nor a subagent opens it, and the rule that held it is the one named: "form" (the publish's own
 * reading), "call" (the publish alone opens; the call around it keeps 1.1.0).
 */
function expectHeld(given: Input, rule: "form" | "call", why = "") {
  for (const verdict of [root(given), subagent(given)])
    expect([label(given), why, verdict.class === "A", verdict.destination]).toEqual([label(given), why, false, undefined])
  expect([label(given), why, formOf(given)]).toEqual([label(given), why, rule === "form" ? "form" : "opens"])
}

const home = () => process.env.HOME || os.homedir()
const config = () => process.env.XDG_CONFIG_HOME || path.join(home(), ".config")
const placed: string[] = []
const saved = new Map<string, string | undefined>()
const atHome = (relative: string, content: string) => {
  write(home(), relative, content)
  placed.push(path.join(home(), relative))
}
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
const CRATE = '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2021"\n'
const PYPROJECT = '[project]\nname = "x"\nversion = "0.1.0"\n[build-system]\nrequires = ["hatchling"]\n'
const npmProject = (files: Record<string, string> = {}) => project({ "package.json": PACKAGE, ...files })
const crate = (files: Record<string, string> = {}) => project({ "Cargo.toml": CRATE, ...files })
const python = (files: Record<string, string> = {}) => project({ "pyproject.toml": PYPROJECT, "dist/x-0.1.0.tar.gz": "t", ...files })
const site = (files: Record<string, string> = {}) => project({ "dist/index.html": "x", ...files })
const NODE_PUBLISH = ["npm publish", "pnpm publish", "yarn npm publish", "bun publish"]
const NETLIFY = "netlify deploy --prod --no-build --dir dist"

beforeAll(async () => {
  // The fixture home must be a test one: these tests write files into it.
  expect(path.resolve(home())).not.toBe(path.join("/Users", os.userInfo().username))
  await ScriptReader.prepare()
})
afterEach(() => {
  for (const file of placed.splice(0)) fs.rmSync(file, { force: true, recursive: true })
  restoreEnv()
})
afterAll(async () => {
  for (const made of temps) await made[Symbol.asyncDispose]()
})

describe("G15-1: a file written in the same call as a publish or deploy keeps the call at 1.1.0", () => {
  test("a redirect beside a publish or deploy, before or after it, holds the call; the publish alone opens", async () => {
    const cases: [string, () => Promise<string>, string][] = [
      ["uv publish", () => python(), "pypi.org"],
      ["poetry publish", () => python(), "pypi.org"],
      ["npm publish", () => npmProject(), "registry.npmjs.org"],
      ["cargo publish", () => crate(), "crates.io"],
      [NETLIFY, () => site(), "netlify"],
      ["firebase deploy --only hosting", () => site({ "firebase.json": '{"hosting":{"public":"dist"}}' }), "firebase"],
    ]
    for (const [send, make, destination] of cases) {
      const here = await make()
      write(here, "alt.txt", "a")
      expectOpens(await sh(send, here), destination)
      for (const call of [`cat alt.txt > notes.txt && ${send}`, `${send}; cat alt.txt > notes.txt`, `cat alt.txt > notes.txt\n${send}`])
        expectHeld(await sh(call, here), "call", call)
    }
  })

  // 1.1.1 F40 (n92): the two mechanisms are pinned apart. The name: a shell write of each config file alone keeps its
  // verdict (`Reach.consentSensitive`), while the same write to an ordinary name opens. The call: a write of an ordinary
  // name beside a publish holds (the redirect test above). The test after this one holds through either.
  test("n92: a shell write of each publish or deploy config name, alone, does not open; an ordinary name does", async () => {
    const alt = { "alt.txt": "x = 1\n" }
    const writes: [string, () => Promise<string>][] = [
      ["cat alt.txt > uv.toml", () => python(alt)],
      ["cat alt.txt > poetry.toml", () => python(alt)],
      ["cat alt.txt > netlify.toml", () => site(alt)],
      ["cat alt.txt > netlify.yml", () => site(alt)],
      ["cat alt.txt > .netlify/state.json", () => site({ ...alt, ".netlify/.keep": "" })],
      ["cat alt.txt > firebase.json", () => site(alt)],
      ["cat alt.txt > .firebaserc", () => site(alt)],
    ]
    for (const [call, make] of writes) {
      const given = await sh(call, await make())
      for (const verdict of [root(given), subagent(given)]) expect([call, verdict.class === "A"]).toEqual([call, false])
    }
    const plain = await sh("cat alt.txt > notes.txt", await site(alt))
    for (const verdict of [root(plain), subagent(plain)]) expect(verdict.class).toBe("A")
  })

  test("the config files a publish or deploy reads, written beside it, hold (by the name and by the call)", async () => {
    const alt = { "alt.txt": "x = 1\n" }
    const cases: [string, () => Promise<string>][] = [
      ["cat alt.txt > uv.toml && uv publish", () => python(alt)],
      ["cat alt.txt > poetry.toml && poetry publish", () => python(alt)],
      [`cat alt.txt > netlify.toml && ${NETLIFY}`, () => site(alt)],
      [`cat alt.txt > netlify.yml && ${NETLIFY}`, () => site(alt)],
      [`cat alt.txt > .netlify/state.json && ${NETLIFY}`, () => site({ ...alt, ".netlify/.keep": "" })],
      ["cat alt.txt > firebase.json && firebase deploy --only hosting", () => site(alt)],
      ["cat alt.txt > .firebaserc && firebase deploy --only hosting", () => site(alt)],
    ]
    for (const [call, make] of cases) expectHeld(await sh(call, await make()), "call", call)
  })

  test("inside a project script: a write and a publish in one script hold; the publish alone opens", async () => {
    const scripts = { ship: "cat alt.txt > notes.txt && uv publish", plain: "uv publish" }
    const here = await python({ "package.json": JSON.stringify({ name: "p", version: "1.0.0", scripts }), "alt.txt": "a" })
    expectOpens(await sh("npm run plain", here), "pypi.org")
    const given = await sh("npm run ship", here)
    for (const verdict of [root(given), subagent(given)]) expect(verdict.class === "A").toBe(false)
  })

  test("the publish and deploy config names are consent-sensitive, and 1.1.0's sensitive list is unchanged", () => {
    const names = [
      "uv.toml", "poetry.toml", "netlify.toml", "netlify.yml", "netlify.yaml", "netlify.json", "firebase.json", ".firebaserc",
      ".netlify/state.json", ".npmrc", ".yarnrc", ".yarnrc.yml", "bunfig.toml", ".cargo/config", ".cargo/config.toml", ".pypirc",
      "pip.conf",
    ]
    for (const name of names) expect([name, Risk.toolConfig(name) || Risk.sensitive(name)]).toEqual([name, true])
    for (const name of ["uv.toml", "poetry.toml", "netlify.toml", "netlify.json", "firebase.json", ".firebaserc", ".netlify/state.json"])
      expect([name, Risk.sensitive(name)]).toEqual([name, false])
  })
})

describe("G15-2: any netlify config other than netlify.toml holds the deploy", () => {
  test("netlify.yml, .yaml and .json, in the folder or above it up to the top", async () => {
    for (const name of ["netlify.yml", "netlify.yaml", "netlify.json"]) {
      expectHeld(await sh(NETLIFY, await site({ [name]: "" })), "form", name)
      const here = await site({ [name]: "", "web/dist/index.html": "x" })
      const given = { ...(await sh(NETLIFY, path.join(here, "web"))), instance: scope(here) }
      for (const verdict of [root(given), subagent(given)]) expect([name, verdict.class === "A"]).toEqual([name, false])
    }
  })
})

describe("G15-3: yarn 1's user and system config locations hold yarn", () => {
  test("each user location, the config pointer variable; a yarn global folder alone opens", async () => {
    const here = await npmProject()
    expectOpens(await sh("yarn npm publish", here), "registry.npmjs.org")
    for (const file of [".config/yarn/config", ".yarn/config"]) {
      atHome(file, "registry https://npm.evil.example/\n")
      expectHeld(await sh("yarn npm publish", here), "form", file)
      expectOpens(await sh("npm publish", here), "registry.npmjs.org")
      for (const made of placed.splice(0)) fs.rmSync(made, { force: true })
    }
    // `~/.config/yarn` as a file is a config file; as a folder (yarn's global packages) it is none.
    fs.rmSync(path.join(home(), ".config/yarn"), { recursive: true, force: true })
    atHome(".config/yarn", "registry https://npm.evil.example/\n")
    expectHeld(await sh("yarn npm publish", here), "form", "config/yarn file")
    for (const made of placed.splice(0)) fs.rmSync(made, { force: true })
    atHome(".config/yarn/global/package.json", "{}")
    placed.push(path.join(home(), ".config/yarn"))
    expectOpens(await sh("yarn npm publish", here), "registry.npmjs.org")
    const xdg = await temp()
    setEnv("XDG_CONFIG_HOME", xdg)
    write(xdg, "yarn/config", "")
    expectHeld(await sh("yarn npm publish", here), "form", "xdg")
    restoreEnv()
    setEnv("yarn_config", "/x/yarnrc")
    expectHeld(await sh("yarn npm publish", here), "form", "yarn_config")
  })
})

describe("CR15-1: the files a package carries by name land inside the project", () => {
  test("cargo: readme, license-file, include and exclude", async () => {
    const outside = await temp()
    write(outside, "secret.txt", "s")
    const linked = await crate({ "README.md": "r" })
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(linked, "notes.md"))
    expectHeld(await sh("cargo publish", await crate({ "Cargo.toml": CRATE + 'readme = "/etc/hosts"\n' })), "form", "abs readme")
    expectHeld(await sh("cargo publish", await crate({ "Cargo.toml": CRATE + 'license-file = "../x.txt"\n' })), "form", "up license")
    for (const manifest of [
      CRATE + 'include = ["../outside/**"]\n',
      CRATE + 'include = ["src/**", "../*"]\n',
      CRATE + 'include = ["//etc/*"]\n',
      CRATE + 'exclude = ["../x"]\n',
      CRATE + "readme.workspace = true\n",
      CRATE + 'readme = { workspace = true }\n',
      CRATE + 'include = "src"\n',
    ])
      expectHeld(await sh("cargo publish", await crate({ "Cargo.toml": manifest })), "form", manifest)
    fs.writeFileSync(path.join(linked, "Cargo.toml"), CRATE + 'readme = "notes.md"\n')
    expectHeld(await sh("cargo publish", linked), "form", "readme through a link")
    for (const manifest of [
      CRATE + 'readme = "README.md"\nlicense-file = "LICENSE"\n',
      CRATE + "readme = false\n",
      CRATE + 'include = ["src/**/*", "/Cargo.toml", "README.md"]\nexclude = ["/ci", "!keep", "*.png"]\n',
    ])
      expectOpens(await sh("cargo publish", await crate({ "Cargo.toml": manifest, "README.md": "r", LICENSE: "l" })), "crates.io")
  })

  test("pyproject: project readme, license file and license-files; poetry readme, include, exclude and packages", async () => {
    for (const [tool, pyproject] of [
      ["uv", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme = "/etc/hosts"')],
      ["poetry", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme = { file = "../x.md", content-type = "text/markdown" }')],
      ["poetry", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nlicense = { file = "/etc/hosts" }')],
      ["poetry", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nlicense-files = ["../*"]')],
      ["poetry", PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme.file = "/etc/hosts"')],
      ["poetry", PYPROJECT + '[tool.poetry]\nreadme = "../R.md"\n'],
      ["poetry", PYPROJECT + '[tool.poetry]\nreadme = ["README.md", "/etc/hosts"]\n'],
      ["poetry", PYPROJECT + '[tool.poetry]\ninclude = ["../x"]\n'],
      ["poetry", PYPROJECT + '[tool.poetry]\nexclude = ["/etc"]\n'],
      ["poetry", PYPROJECT + '[tool.poetry]\npackages = [{ include = "x" }]\n'],
    ] as const)
      expectHeld(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject })), "form", pyproject)
    for (const pyproject of [
      PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme = "README.md"\nlicense = { text = "MIT" }'),
      PYPROJECT.replace('version = "0.1.0"', 'version = "0.1.0"\nreadme = { file = "README.md", content-type = "text/markdown" }\nlicense = "MIT"\nlicense-files = ["LICEN[CS]E*"]'),
      PYPROJECT + '[tool.poetry]\nreadme = "README.md"\ninclude = ["CHANGELOG.md"]\nlicense = "MIT"\n',
    ])
      for (const tool of ["uv", "poetry"]) expectOpens(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject, "README.md": "r" })), "pypi.org")
  })
})

describe("CR15-2: a tracked link under the package folder that lands outside holds the publish", () => {
  test("cargo, npm, uv, poetry and twine", async () => {
    const outside = await temp()
    write(outside, "secret.txt", "s")
    const cases: [string, () => Promise<string>, string][] = [
      ["cargo publish", () => crate(), "crates.io"],
      ["npm publish", () => npmProject(), "registry.npmjs.org"],
      ["uv publish", () => python(), "pypi.org"],
      ["poetry publish", () => python(), "pypi.org"],
      ["twine upload dist/x-0.1.0.tar.gz", () => python(), "pypi.org"],
    ]
    for (const [command, make, destination] of cases) {
      const here = await make()
      write(here, "inner.txt", "i")
      fs.symlinkSync(path.join(here, "inner.txt"), path.join(here, "ok.txt"))
      await $`git add ok.txt inner.txt`.cwd(here).quiet()
      expectOpens(await sh(command, here), destination)
      fs.mkdirSync(path.join(here, "docs"))
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(here, "docs", "notes.txt"))
      // Untracked, it keeps the earlier behaviour (documented in coder_execution_f39.md).
      expectOpens(await sh(command, here), destination)
      await $`git add docs/notes.txt`.cwd(here).quiet()
      expectHeld(await sh(command, here), "form", command)
    }
  })
})

describe("V15-1: .npmrc lines are judged by a strict allowlist", () => {
  test("the lines `npm login` and an NPM_TOKEN setup write, comments and neutral keys open", async () => {
    for (const text of [
      "//registry.npmjs.org/:_authToken=npm_AbC123\n",
      "//registry.npmjs.org/:_authToken=${NPM_TOKEN}\n//registry.npmjs.org/:always-auth=true\n",
      "# comment\n; also a comment\n\n   \nsave-exact=true\r\nsave-prefix=~\nengine-strict=true\npackage-lock=false\nfund=false\naudit=false\n",
      "legacy-peer-deps=true\nprogress=false\nloglevel=warn\nauto-install-peers=true\nstrict-peer-dependencies=false\n",
    ]) {
      atHome(".npmrc", text)
      const here = await npmProject({ ".npmrc": text })
      for (const command of NODE_PUBLISH) expectOpens(await sh(command, here), "registry.npmjs.org")
      for (const made of placed.splice(0)) fs.rmSync(made, { force: true })
    }
  })

  test("anything else holds: other keys, hosts, spellings, quotes, spaces, sections, escapes and odd files", async () => {
    for (const text of [
      "registry=https://npm.evil.example/\n",
      "@corp:registry=https://npm.evil.example/\n",
      "//npm.evil.example/:_authToken=x\n",
      "//registry.npmjs.org/:_authToken=${OTHER}\n",
      "//registry.npmjs.org/:_authToken=a b\n",
      "//registry.npmjs.org/:_password=x\n",
      // 1.1.1 F40 (n89): spaces around `=` open now (f40-outward.test.ts); a space before the key still holds.
      " save-exact=true\n",
      '"save-exact"=true\n',
      'save-exact="true"\n',
      "save-exact=${X}\n",
      "save\\-exact=true\n",
      "[section]\n",
      "save-exact=true\rregistry=https://npm.evil.example/\n",
      "# c\rregistry=https://npm.evil.example/\n",
      "\uFEFFsave-exact=true\n",
      "prefix=/tmp/x\n",
      "userconfig=/tmp/x\n",
      "save-exact[]=true\n",
    ])
      for (const command of NODE_PUBLISH) expectHeld(await sh(command, await npmProject({ ".npmrc": text })), "form", JSON.stringify(text))
    const linked = await npmProject()
    write(linked, "real.npmrc", "save-exact=true\n")
    fs.symlinkSync(path.join(linked, "real.npmrc"), path.join(linked, ".npmrc"))
    expectHeld(await sh("npm publish", linked), "form", "link")
    const folder = await npmProject()
    fs.mkdirSync(path.join(folder, ".npmrc"))
    expectHeld(await sh("npm publish", folder), "form", "folder")
  })

  test("a global npmrc beside node on PATH, and the userconfig pointer npm run exports, by the same lines", async () => {
    const here = await npmProject()
    const prefix = await temp()
    write(prefix, "bin/node", "")
    setEnv("PATH", `${path.join(prefix, "bin")}${path.delimiter}${process.env.PATH ?? ""}`)
    write(prefix, "etc/npmrc", "//registry.npmjs.org/:_authToken=x\n")
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
    write(prefix, "etc/npmrc", "registry=https://npm.evil.example/\n")
    expectHeld(await sh("npm publish", here), "form", "global")
    restoreEnv()
    write(prefix, "user.npmrc", "//registry.npmjs.org/:_authToken=x\n")
    setEnv("npm_config_userconfig", path.join(prefix, "user.npmrc"))
    expectOpens(await sh("npm publish", here), "registry.npmjs.org")
    write(prefix, "user.npmrc", "registry=https://npm.evil.example/\n")
    expectHeld(await sh("npm publish", here), "form", "pointer")
  })

  test("yarn and bun rc files keep the presence rule", async () => {
    expectHeld(await sh("yarn npm publish", await npmProject({ ".yarnrc.yml": "nodeLinker: node-modules\n" })), "form")
    expectHeld(await sh("bun publish", await npmProject({ "bunfig.toml": "" })), "form")
  })
})

describe("V15-1: netlify.toml opens with [build] command and publish, [[redirects]] and [[headers]] of plain lines", () => {
  test("the usual site file opens", async () => {
    for (const toml of [
      '[build]\ncommand = "npm run build"\npublish = "dist"\n',
      '[build]\n  publish = "dist"\n  command = "vite build"\n\n[[redirects]]\n  from = "/*"\n  to = "/index.html"\n  status = 200\n  force = false\n',
      '[[headers]]\n  for = "/*"\n  [headers.values]\n    X-Frame-Options = "DENY"\n    Cache-Control = \'public, max-age=0\'\n[[headers]]\n  for = "/assets/*"\n',
      "# only a comment\n",
    ])
      expectOpens(await sh(NETLIFY, await site({ "netlify.toml": toml })), "netlify")
  })

  test("anything else holds", async () => {
    for (const toml of [
      '[build]\nbase = "web"\npublish = "dist"\n',
      '[build]\ncommand = "make"\n[build.environment]\nNODE_VERSION = "20"\n',
      '[build]\npublish = "../outside"\n',
      '[build]\npublish = "dist"\n[build]\ncommand = "make"\n',
      '[[build]]\npublish = "dist"\n',
      'publish = "dist"\n',
      '[[plugins]]\npackage = "@netlify/plugin-x"\n',
      '[context.production]\ncommand = "make"\n',
      '[functions]\ndirectory = "fn"\n',
      '[[redirects]]\nfrom = "/a"\nto = "/b"\nconditions = { Role = ["admin"] }\n',
      '[[redirects]]\n"from" = "/a"\n',
      '[[redirects]]\nfrom = """/a"""\n',
      '[[redirects]]\nstatus = 1.5\n',
      '[[redirects]]\nheaders.X = "y"\n',
      '[redirects]\nfrom = "/a"\n',
      '[headers.values]\nX = "y"\n',
      '[[headers]]\nfor = "/*"\n[headers.values]\nX = "y"\n[headers.values]\nZ = "w"\n',
      '[build]\ncommand = "echo \\u0041"\n',
      '[build]\ncommand = "make"\n[[redirects]]\nfrom = "/a"\n[dev]\nport = 1\n',
    ])
      expectHeld(await sh(NETLIFY, await site({ "netlify.toml": toml })), "form", toml)
  })
})

describe("V15-2: pyproject is looked into only in the tool.uv and tool.poetry tables", () => {
  test("other tool tables open whatever their words and escapes say", async () => {
    for (const pyproject of [
      PYPROJECT + "[tool.black]\nline-length = 88\ninclude = '\\.pyi?$'\n",
      PYPROJECT + '[tool.coverage.run]\nsource = ["src"]\nbranch = true\n',
      PYPROJECT + '[tool.mypy]\nplugins = { x = 1 }\n',
    ])
      for (const tool of ["uv", "poetry"]) expectOpens(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject })), "pypi.org")
  })

  test("uv and poetry tables, and a quoted or escaped key or header anywhere under tool, still hold", async () => {
    for (const pyproject of [
      PYPROJECT + '[tool.uv]\npublish-url = "https://pypi.evil.example/"\n',
      PYPROJECT + '[tool.uv.sources]\nx = { path = "x" }\n',
      PYPROJECT + '[tool.poetry]\nrepository = "https://x.test/"\n',
      PYPROJECT + '[[tool.poetry.source]]\nname = "corp"\n',
      PYPROJECT + '[tool.black]\n"include" = "x"\n',
      PYPROJECT + '[tool."black"]\nline-length = 88\n',
      PYPROJECT + '[tool]\n"u\\u0076" = { publish-url = "https://pypi.evil.example/" }\n',
    ])
      for (const tool of ["uv", "poetry"]) expectHeld(await sh(`${tool} publish`, await python({ "pyproject.toml": pyproject })), "form", pyproject)
  })
})

describe("V15-3 / n82 / n83: environment", () => {
  test("V15-3: CARGO_REGISTRY_TOKEN opens; the credential-provider variables still hold", async () => {
    const here = await crate()
    setEnv("CARGO_REGISTRY_TOKEN", "x")
    expectOpens(await sh("cargo publish", here), "crates.io")
    for (const key of ["CARGO_REGISTRY_CREDENTIAL_PROVIDER", "CARGO_REGISTRY_GLOBAL_CREDENTIAL_PROVIDERS", "CARGO_REGISTRIES_CRATES_IO_TOKEN"]) {
      setEnv(key, "x")
      expectHeld(await sh("cargo publish", here), "form", key)
      delete process.env[key]
    }
  })

  test("n82: npm_config_workspace and npm_config_workspaces hold", async () => {
    const here = await npmProject()
    for (const key of ["npm_config_workspace", "npm_config_workspaces", "npm_config_include_workspace_root"]) {
      setEnv(key, "true")
      for (const command of NODE_PUBLISH) expectHeld(await sh(command, here), "form", key)
      delete process.env[key]
    }
  })

  test("n83: a relative CARGO_HOME, XDG_CONFIG_HOME, POETRY_CONFIG_DIR or VIRTUAL_ENV is taken from the step's folder", async () => {
    const cases: [string, string, string, () => Promise<string>][] = [
      ["cargo publish", "CARGO_HOME", "ch/config.toml", () => crate()],
      ["uv publish", "XDG_CONFIG_HOME", "xdg/uv/uv.toml", () => python()],
      ["poetry publish", "POETRY_CONFIG_DIR", "pc/config.toml", () => python()],
      ["twine upload dist/x-0.1.0.tar.gz", "VIRTUAL_ENV", "venv/pip.conf", () => python()],
    ]
    for (const [command, key, file, make] of cases) {
      const here = await make()
      write(here, file, "")
      setEnv(key, file.split("/")[0]!)
      expectHeld(await sh(command, here), "form", key)
      restoreEnv()
    }
  })
})

describe("n84 / n85: stale comments and the TOML reader's surface", () => {
  test("n84: no comment names a function that does not exist or a registry the person named", () => {
    const source = fs.readFileSync(path.join(import.meta.dir, "../../src/permission/outward-consent.ts"), "utf8")
    for (const stale of ["publishSettings", "manifestPlain", "default registry or one the person named", "or to one the person named"])
      expect([stale, source.includes(stale)]).toEqual([stale, false])
    const reader = fs.readFileSync(path.join(import.meta.dir, "../../src/permission/toml-reader.ts"), "utf8").split("\n").slice(0, 6).join("\n")
    for (const gone of ["uv.toml", "poetry.toml", "bunfig.toml", ".cargo/config.toml"]) expect([gone, reader.includes(gone)]).toEqual([gone, false])
  })

  test("n85: one key mechanism (no `quoted`), an array-table flag, and inline tables read for CR15-1", () => {
    const found = TomlReader.entries('[[a]]\nb = 1\n[c]\nd = { "e" = 1 }\n')!
    expect(found.map((entry) => [entry.path.join("/"), entry.table, entry.array, entry.key])).toEqual([
      ["a", true, true, "a"],
      ["a/b", false, false, "b"],
      ["c", true, false, "c"],
      ["c/d", false, false, "d"],
    ])
    expect(found.some((entry) => "quoted" in entry)).toBe(false)
    expect(TomlReader.table('{ file = "R.md", content-type = "text/markdown" }')?.map((pair) => [pair.path.join("/"), pair.raw])).toEqual([
      ["file", '"R.md"'],
      ["content-type", '"text/markdown"'],
    ])
    expect(TomlReader.table('{ file = "R.md" ')).toBeUndefined()
  })
})
