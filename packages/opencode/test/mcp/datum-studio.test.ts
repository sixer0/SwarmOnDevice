import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { DatumStudioMcp } from "../../src/mcp/datum-studio"
import { tmpdir } from "../fixture/fixture"

// Row 33: datum-studio is a built-in MCP entry of the Swarm app (Studio spec §9.3), resolved in config without any user
// file, pointing at the bundled launcher, which reaches the host endpoint through the descriptor (spec §9.1).

const STDIO = path.join(import.meta.dir, "../fixture/mcp-lifecycle-stdio.ts")
const NOT_RUNNING = "DATUM Studio runs inside the Swarm app. Start Swarm, then reconnect this MCP server (Claude Code: /mcp)."
const real = (file: string) => fs.realpathSync.native(file)

/** A fixture `<Resources>`: app.asar marker and, unless told otherwise, `datum-studio/datum-studio-launcher`. */
function resources(base: string, opts: { launcher?: string | false; mode?: number } = {}) {
  const res = path.join(base, "Swarm.app", "Contents", "Resources")
  fs.mkdirSync(path.join(res, "datum-studio"), { recursive: true })
  fs.writeFileSync(path.join(res, "app.asar"), "")
  if (opts.launcher !== false) {
    const launcher = path.join(res, "datum-studio", "datum-studio-launcher")
    fs.writeFileSync(launcher, opts.launcher ?? "#!/bin/sh\nexit 3\n")
    fs.chmodSync(launcher, opts.mode ?? 0o755)
  }
  return res
}

/**
 * Stands in for row 34's launcher in the two states spec §9.3 step 3 and §9.5 name: no descriptor under
 * $XDG_STATE_HOME/swarm -> the start-Swarm message and exit 3; a descriptor -> the stdio server (here the lifecycle
 * fixture). It records what it was started with, so the test sees STUDIO_AGENT_ID and that no token reached argv/env.
 */
function launcherScript(out: string) {
  return [
    "#!/bin/sh",
    `printf '%s\\n' "agent=$STUDIO_AGENT_ID" "state=$XDG_STATE_HOME" "argc=$#" > '${out}'`,
    'descriptor="$XDG_STATE_HOME/swarm/datum-studio.env"',
    'if [ ! -f "$descriptor" ]; then',
    `  echo '${NOT_RUNNING}' >&2`,
    "  exit 3",
    "fi",
    // Read the token from the descriptor (as the bridge does) and count env lines holding it: the value never sits here.
    `printf 'token_env=%s\\n' "$(env | grep -cF "$(sed -n 's/^TOKEN=//p' "$descriptor")")" >> '${out}'`,
    `exec '${process.execPath}' '${STDIO}'`,
    "",
  ].join("\n")
}

/**
 * Every config file under `dir`, with its bytes, so before/after equality proves no config was written. The one file left
 * out is the `.gitignore` that loading a config directory has always written (config.ts ensureGitignore, unchanged by
 * row 33); `noStudioText` checks that it, too, never carries the entry.
 */
function snapshot(dir: string): Record<string, string> {
  if (!fs.existsSync(dir)) return {}
  const files: Record<string, string> = {}
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || entry.name === ".gitignore") continue
    const file = path.join(entry.parentPath, entry.name)
    files[path.relative(dir, file)] = fs.readFileSync(file, "utf8")
  }
  return files
}

function noStudioText(dir: string) {
  expect(grepTree(dir, "datum-studio")).toEqual([])
}

function grepTree(dir: string, needle: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .filter((file) => fs.readFileSync(file).includes(needle))
}

type AppResult = {
  mcp?: Record<string, unknown>
  globalMcp?: Record<string, unknown>
  status?: Record<string, { status: string; error?: string }>
  tools?: Record<string, unknown>
}

type Fixture = { resources: string; xdg: string; project: string; withMcp?: boolean; entry?: string }

/** The real config (and MCP) services in a process that looks like the app's utility process from before it loads. */
function runInApp(input: Fixture) {
  const script = `
    Object.defineProperty(process, "type", { value: "utility", configurable: true, writable: true })
    Object.defineProperty(process, "resourcesPath", { value: ${JSON.stringify(input.resources)}, configurable: true, writable: true })
    ${input.entry ? `process.argv[1] = ${JSON.stringify(input.entry)}` : ""}
    const { Effect, Layer } = await import("effect")
    const { LayerNode } = await import("@opencode-ai/core/effect/layer-node")
    const { Config } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/config/config.ts"))})
    const { MCP } = await import(${JSON.stringify(path.join(import.meta.dir, "../../src/mcp/index.ts"))})
    const { provideInstance, testInstanceStoreLayer } = await import(${JSON.stringify(path.join(import.meta.dir, "../fixture/fixture.ts"))})
    const program = Effect.gen(function* () {
      const config = yield* Config.Service
      const out = { mcp: (yield* config.get()).mcp, globalMcp: (yield* config.getGlobal()).mcp }
      if (!${input.withMcp ? "true" : "false"}) return out
      const mcp = yield* MCP.Service
      const status = yield* mcp.status()
      const tools = Object.fromEntries(Object.entries(yield* mcp.tools()).map(([name, tool]) => [name, tool.source]))
      return { ...out, status, tools }
    }).pipe(
      provideInstance(${JSON.stringify(input.project)}),
      Effect.provide(Layer.mergeAll(LayerNode.compile(LayerNode.group([MCP.node, Config.node])), testInstanceStoreLayer)),
    )
    console.log("RESULT" + JSON.stringify(await Effect.runPromise(program)))
    process.exit(0)
  `
  const result = Bun.spawnSync([process.execPath, "-e", script], {
    cwd: path.join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      OPENCODE_TEST_HOME: path.join(input.xdg, "home"),
      XDG_CONFIG_HOME: path.join(input.xdg, "config"),
      XDG_DATA_HOME: path.join(input.xdg, "data"),
      XDG_STATE_HOME: path.join(input.xdg, "state"),
      XDG_CACHE_HOME: path.join(input.xdg, "cache"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  const line = stdout.split("\n").find((item) => item.startsWith("RESULT"))
  if (!line) throw new Error(stderr)
  return { result: JSON.parse(line.slice("RESULT".length)) as AppResult, stdout, stderr }
}

function xdgFixture(base: string) {
  const xdg = path.join(base, "xdg")
  for (const name of ["home", "config", "data", "state", "cache"]) fs.mkdirSync(path.join(xdg, name), { recursive: true })
  const project = path.join(base, "project")
  fs.mkdirSync(project)
  return { xdg, project, configDir: path.join(xdg, "config", "swarm"), stateDir: path.join(xdg, "state", "swarm") }
}

describe("DatumStudioMcp.resolve", () => {
  const touched: string[] = []
  const disk: DatumStudioMcp.Disk = {
    lstat: (file) => {
      touched.push(file)
      throw new Error("must not be called")
    },
    realpath: (file) => {
      touched.push(file)
      throw new Error("must not be called")
    },
  }

  test.each([
    ["the terminal CLI (no process type)", undefined, "/synthetic/Resources"],
    ["a renderer", "renderer", "/synthetic/Resources"],
    ["a utility process without resourcesPath", "utility", undefined],
  ])("%s is no-app with no disk call", (_name, type, resourcesPath) => {
    expect(DatumStudioMcp.resolve({ type, resourcesPath, disk })).toEqual({ kind: "no-app" })
    expect(touched).toEqual([])
    expect(DatumStudioMcp.builtin({ kind: "no-app" })).toEqual({})
  })

  test("a relative resourcesPath never names the launcher", () => {
    expect(DatumStudioMcp.resolve({ type: "utility", resourcesPath: "Contents/Resources" })).toEqual({
      kind: "failed",
      code: "missing",
    })
  })

  test("packaged app: <Resources>/datum-studio/datum-studio-launcher, spec §9.3 shape", async () => {
    await using tmp = await tmpdir()
    const res = resources(tmp.path)
    const launcher = path.join(real(res), "datum-studio", "datum-studio-launcher")
    const status = DatumStudioMcp.resolve({ type: "utility", resourcesPath: res })
    expect(status).toEqual({ kind: "available", launcher })
    expect(DatumStudioMcp.builtin(status)).toEqual({
      "datum-studio": { type: "local", command: [launcher], environment: { STUDIO_AGENT_ID: "swarm" } },
    })
  })

  test.each([
    ["no launcher", { launcher: false as const }, "missing"],
    ["launcher not executable", { mode: 0o644 }, "not_executable"],
  ])("%s gives no entry (%s)", async (_name, opts, code) => {
    await using tmp = await tmpdir()
    const status = DatumStudioMcp.resolve({ type: "utility", resourcesPath: resources(tmp.path, opts) })
    expect(status).toEqual({ kind: "failed", code: code as DatumStudioMcp.FailureCode })
    expect(DatumStudioMcp.builtin(status)).toEqual({})
  })

  test("a symlinked launcher or Studio folder is refused", async () => {
    await using tmp = await tmpdir()
    const res = resources(tmp.path, { launcher: false })
    const elsewhere = path.join(tmp.path, "elsewhere")
    fs.writeFileSync(elsewhere, "#!/bin/sh\n", { mode: 0o755 })
    fs.symlinkSync(elsewhere, path.join(res, "datum-studio", "datum-studio-launcher"))
    expect(DatumStudioMcp.resolve({ type: "utility", resourcesPath: res })).toEqual({ kind: "failed", code: "symlink" })

    const other = resources(path.join(tmp.path, "b"))
    const linked = path.join(tmp.path, "c", "Resources")
    fs.mkdirSync(linked, { recursive: true })
    fs.writeFileSync(path.join(linked, "app.asar"), "")
    fs.symlinkSync(path.join(other, "datum-studio"), path.join(linked, "datum-studio"))
    expect(DatumStudioMcp.resolve({ type: "utility", resourcesPath: linked })).toEqual({ kind: "failed", code: "symlink" })
  })

  test("unpackaged Electron: the row 36 stage next to out/main, judged from the entry script only", async () => {
    await using tmp = await tmpdir()
    const electronRes = path.join(tmp.path, "electron", "Resources")
    fs.mkdirSync(electronRes, { recursive: true })
    const desktop = path.join(tmp.path, "desktop")
    fs.mkdirSync(path.join(desktop, "out", "main"), { recursive: true })
    const entry = path.join(desktop, "out", "main", "sidecar.js")
    expect(DatumStudioMcp.resolve({ type: "utility", resourcesPath: electronRes, entry })).toEqual({
      kind: "failed",
      code: "missing",
    })
    fs.mkdirSync(path.join(desktop, ".datum-studio-stage"))
    fs.writeFileSync(path.join(desktop, ".datum-studio-stage", "datum-studio-launcher"), "#!/bin/sh\n", { mode: 0o755 })
    expect(DatumStudioMcp.resolve({ type: "utility", resourcesPath: electronRes, entry })).toEqual({
      kind: "available",
      launcher: path.join(real(desktop), ".datum-studio-stage", "datum-studio-launcher"),
    })
    expect(DatumStudioMcp.resolve({ type: "utility", resourcesPath: electronRes, entry: "/elsewhere/cli.js" })).toEqual({
      kind: "failed",
      code: "missing",
    })
  })
})

describe("datum-studio in the resolved config of the app", () => {
  test("listed as a built-in entry with no user config file written", async () => {
    await using tmp = await tmpdir()
    const res = resources(tmp.path)
    const fx = xdgFixture(tmp.path)
    const before = snapshot(path.join(fx.xdg, "config"))
    const { result } = runInApp({ resources: res, xdg: fx.xdg, project: fx.project })
    const launcher = path.join(real(res), "datum-studio", "datum-studio-launcher")
    const expected = { type: "local", command: [launcher], environment: { STUDIO_AGENT_ID: "swarm" } }
    expect(result.mcp?.["datum-studio"]).toEqual(expected)
    expect(result.globalMcp?.["datum-studio"]).toEqual(expected)
    expect(snapshot(path.join(fx.xdg, "config"))).toEqual(before)
    noStudioText(path.join(fx.xdg, "config"))
    expect(fs.existsSync(path.join(fx.project, "config.json"))).toBe(false)
  })

  test("the user's own entry wins: `enabled: false` turns it off, and the user file keeps its bytes", async () => {
    await using tmp = await tmpdir()
    const res = resources(tmp.path)
    const fx = xdgFixture(tmp.path)
    fs.mkdirSync(fx.configDir, { recursive: true })
    const text = JSON.stringify({
      mcp: { "datum-studio": { type: "local", command: ["/opt/own/datum-studio"], enabled: false } },
    })
    fs.writeFileSync(path.join(fx.configDir, "swarm.json"), text)
    const { result } = runInApp({ resources: res, xdg: fx.xdg, project: fx.project })
    expect(result.mcp?.["datum-studio"]).toMatchObject({ type: "local", command: ["/opt/own/datum-studio"], enabled: false })
    expect(result.globalMcp?.["datum-studio"]).toMatchObject({ command: ["/opt/own/datum-studio"], enabled: false })
    expect(fs.readFileSync(path.join(fx.configDir, "swarm.json"), "utf8")).toBe(text)
  })

  test("no launcher in the app: no entry, nothing written", async () => {
    await using tmp = await tmpdir()
    const res = resources(tmp.path, { launcher: false })
    const fx = xdgFixture(tmp.path)
    const { result } = runInApp({ resources: res, xdg: fx.xdg, project: fx.project })
    expect(result.mcp?.["datum-studio"]).toBeUndefined()
    expect(snapshot(path.join(fx.xdg, "config"))).toEqual({})
  })
})

describe("datum-studio through the launcher (spec §9.3, §9.5)", () => {
  test("host not running: the server is failed cleanly, nothing else changes", async () => {
    await using tmp = await tmpdir()
    const out = path.join(tmp.path, "launcher.out")
    const res = resources(tmp.path, { launcher: launcherScript(out) })
    const fx = xdgFixture(tmp.path)
    const { result } = runInApp({ resources: res, xdg: fx.xdg, project: fx.project, withMcp: true })
    expect(result.status?.["datum-studio"]?.status).toBe("failed")
    expect(Object.keys(result.tools ?? {}).filter((name) => name.startsWith("datum-studio_"))).toEqual([])
    expect(fs.readFileSync(out, "utf8")).toContain("agent=swarm\n")
  })

  test("host running: tools listed as datum-studio_<tool>, origin global; the token stays in the descriptor", async () => {
    await using tmp = await tmpdir()
    const out = path.join(tmp.path, "launcher.out")
    const res = resources(tmp.path, { launcher: launcherScript(out) })
    const fx = xdgFixture(tmp.path)
    const token = "5a".repeat(32)
    fs.mkdirSync(fx.stateDir, { recursive: true })
    fs.writeFileSync(
      path.join(fx.stateDir, "datum-studio.env"),
      `URL=http://127.0.0.1:1/mcp\nTOKEN=${token}\nPID=${process.pid}\n`,
      { mode: 0o600 },
    )
    const before = snapshot(path.join(fx.xdg, "config"))
    const run = runInApp({ resources: res, xdg: fx.xdg, project: fx.project, withMcp: true })
    expect(run.result.status?.["datum-studio"]).toEqual({ status: "connected" })
    expect(run.result.tools?.["datum-studio_current_directory"]).toEqual({
      server: "datum-studio",
      transport: "local",
      origin: "global",
    })
    // The launcher ran with the sidecar's state home, the Swarm caller id, no argument and no *TOKEN= variable.
    expect(fs.readFileSync(out, "utf8")).toBe(`agent=swarm\nstate=${path.join(fx.xdg, "state")}\nargc=0\ntoken_env=0\n`)
    expect(snapshot(path.join(fx.xdg, "config"))).toEqual(before)
    noStudioText(path.join(fx.xdg, "config"))
    // The token appears in no output and in no file but the descriptor itself.
    expect(run.stdout.includes(token) || run.stderr.includes(token)).toBe(false)
    expect(JSON.stringify(run.result).includes(token)).toBe(false)
    expect(grepTree(tmp.path, token)).toEqual([path.join(fx.stateDir, "datum-studio.env")])
  })
})
