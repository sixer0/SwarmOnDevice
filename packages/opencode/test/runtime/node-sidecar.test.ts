// The packaged app runs this server on Node (`script/build-node.ts`), and every other test runs it on Bun, where a call to
// the `Bun` global works. So this builds what the app builds and looks at it from outside Bun.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { AutonomyTable } from "../../src/permission/autonomy-table"
import type { InstanceContext } from "../../src/project/instance-context"

const packageDir = path.resolve(import.meta.dir, "../..")
const electron = path.resolve(packageDir, "../desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const node = Bun.which("node")
const runtimes: [name: string, command: string | null, env: Record<string, string>][] = [
  ["node", node, {}],
  ["electron --run-as-node", fs.existsSync(electron) ? electron : null, { ELECTRON_RUN_AS_NODE: "1" }],
]

// What is left of the global in the server's bundle, as line text with the guarded uses taken out. Each one here fails on
// the app's server when it is reached. This list only ever gets shorter.
const STILL_ON_THE_PACKAGED_PATH = ["Bun.hash", "Bun.spawn"]

const INSTALLS = ["bun install --frozen-lockfile", "npm ci --ignore-scripts", "pnpm install --frozen-lockfile --ignore-scripts"]
const COMMANDS = [...INSTALLS, "bun install", "npm install", "bun install --frozen-lockfile --cwd x", "bun test", "git push"]

const KEPT_OUT = ["jsonc-parser", "@lydell/node-pty"]
const packageRoot = (name: string) => {
  // Each is a dependency of a package this one is built from, and not always of this one.
  const from = fs.existsSync(path.join(packageDir, "node_modules", name)) ? packageDir : path.resolve(packageDir, "../core")
  let dir = path.dirname(Bun.resolveSync(name, from))
  while (!fs.existsSync(path.join(dir, "package.json"))) dir = path.dirname(dir)
  return dir
}

let work: string
let repo: string
let bundle: string

const git = (...args: string[]) => {
  const out = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  })
  if (out.status !== 0) throw new Error(`git ${args[0]}: ${out.stderr}`)
}

beforeAll(async () => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "node-sidecar-")))
  repo = path.join(work, "repo")
  fs.mkdirSync(repo)
  git("init", "-q", "-b", "main")
  for (const lockfile of ["bun.lock", "package-lock.json", "pnpm-lock.yaml"]) fs.writeFileSync(path.join(repo, lockfile), "lock\n")
  fs.writeFileSync(path.join(repo, "package.json"), "{}\n")
  git("add", ".")
  git("commit", "-qm", "init")

  // The packages kept out of the bundle are found from where it runs.
  for (const name of KEPT_OUT) {
    fs.mkdirSync(path.dirname(path.join(work, "node_modules", name)), { recursive: true })
    fs.symlinkSync(packageRoot(name), path.join(work, "node_modules", name))
  }
  // In a process of its own. On Bun 1.3.14 a second `Bun.build` in one process fails reading files the first one read (EISDIR,
  // EBADF, "Unexpected reading file"), and `bun test` runs every file in one process, with plugin/azure.test.ts building too.
  const built = spawnSync(process.execPath, [path.join(packageDir, "test/fixture/node-runtime-build.ts"), work], {
    cwd: packageDir,
    encoding: "utf8",
    timeout: 150_000,
  })
  if (built.status !== 0) throw new Error(`build: ${built.stderr.slice(-2000)}`)
  bundle = path.join(work, "src/node.js")
}, 180_000)

afterAll(() => fs.rmSync(work, { recursive: true, force: true }))

const entry = () =>
  [path.join(work, "test/fixture/node-runtime-entry.js"), path.join(work, "fixture/node-runtime-entry.js"), path.join(work, "node-runtime-entry.js")].find(
    (file) => fs.existsSync(file),
  )!

const runOn = (command: string, env: Record<string, string>) => {
  const home = path.join(work, "home")
  fs.mkdirSync(home, { recursive: true })
  const out = spawnSync(command, [entry(), JSON.stringify({ repo, commands: COMMANDS })], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_STATE_HOME: path.join(home, "state"),
      TMPDIR: work,
      ...env,
    },
  })
  const line = out.stdout.trim().split("\n").at(-1) ?? ""
  if (out.status !== 0 || !line.startsWith("{")) throw new Error(`exit ${out.status}: ${out.stderr.slice(-2000)}`)
  return JSON.parse(line) as {
    hasBun: boolean
    routine: Record<string, string | null>
    git: { out?: string; failed?: string }
    orphan: { ended?: number; failed?: string }
  }
}

describe("the server built for the packaged app", () => {
  for (const [name, command, env] of runtimes) {
    describe(name, () => {
      let result: ReturnType<typeof runOn> | undefined
      const ran = () => (result ??= runOn(command!, env))

      test.skipIf(!command)("has no Bun global, or the rest proves nothing", () => expect(ran().hasBun).toBe(false), 90_000)

      test.skipIf(!command)("reads a repository with the git tool", () => {
        expect(ran().git).toEqual({ out: expect.stringContaining("## main") })
      })

      test.skipIf(!command)("answers the install rows as Bun does", () => {
        const instance = { directory: repo, worktree: repo, project: { vcs: "git" } } as InstanceContext
        const onBun = Object.fromEntries(COMMANDS.map((item) => [item, AutonomyTable.routine(item, repo, instance) ?? null]))
        expect(ran().routine).toEqual(onBun)
        for (const install of INSTALLS) expect(ran().routine[install]).toBe("check")
      })

      test.skipIf(!command)("ends a command the last server left behind", () => {
        expect(ran().orphan).toEqual({ ended: 1 })
      })
    })
  }

  test("calls no more of the Bun global than is on the list", () => {
    const code = fs.readFileSync(bundle, "utf8")
    const uses = new Set<string>()
    for (const line of code.split("\n")) {
      if (line.includes("typeof Bun")) continue
      for (const match of line.matchAll(/(?<![\w$.])Bun\.[\w$]+/g)) uses.add(match[0])
    }
    expect([...uses].sort()).toEqual(STILL_ON_THE_PACKAGED_PATH)
  })
})
