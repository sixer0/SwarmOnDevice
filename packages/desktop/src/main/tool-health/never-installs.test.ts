// TH-03 (1.2.6 row 92b): spec 01c 11.5. Web revive only through `swarm-setup start <id>` on the shared setup runner.
// Red class B at e363918a69 (web-revive.ts and the runner's start() do not exist there).
import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { PassThrough } from "node:stream"
import { createSetupRunner, SETUP_START_IDS as RUNNER_START_IDS } from "../setup-runner"
import type { ProbeResult } from "./probe"
import { createToolHealthRegistry, TOOL_HEALTH_SHIPPED_IDS } from "./registry"
import { createToolHealth, SETUP_START_IDS, type ToolHealthDeps } from "./startup"
import { readToolHealthState, toolHealthDir } from "./state"
import { reviveWebComponent, WEB_REVIVE_IDS, type WebReviveRunner } from "./web-revive"

const HELP_START = "Usage:\n  swarm-setup start <runtime|searxng|firecrawl>  start an installed, stopped component\n"
const HELP_OLD = "Usage:\n  swarm-setup install [component...] consent-first install\n  swarm-setup apply <stack>  re-render\n"
const DOWN: ProbeResult = { healthy: false, reason: "HTTP_UNREACHABLE", detail: "down" }
const OK: ProbeResult = { healthy: true, reason: "OK", detail: "ok" }

const homes: string[] = []
function home() {
  const dir = mkdtempSync(join(tmpdir(), "th-never-installs-"))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Reply = { stdout?: string; code?: number; hold?: Promise<void> }
// Records every spawn as [basename(binary), ...args]. `--help` answers `help`; other calls take the next reply.
function recordingSpawn(help: string, replies: Reply[] = [], onArgs?: (args: string[]) => void) {
  const argvs: string[][] = []
  const spawn = ((binary: string, args: string[]) => {
    argvs.push([basename(binary), ...args])
    onArgs?.(args)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 4242
    const reply = args[0] === "--help" ? { stdout: help, code: 0 } : (replies.shift() ?? { stdout: "RESULT OK\n", code: 0 })
    void (async () => {
      await new Promise((r) => setTimeout(r, 2))
      if (reply.hold) await reply.hold
      if (reply.stdout) child.stdout.write(Buffer.from(reply.stdout))
      child.stdout.end()
      child.stderr.end()
      setTimeout(() => child.emit("close", reply.code ?? 0, null), 2)
    })()
    return child
  }) as unknown as typeof import("node:child_process").spawn
  return { spawn, argvs }
}

function realRunner(h: string, spawn: ReturnType<typeof recordingSpawn>) {
  return createSetupRunner({
    dir: "/bundle/swarm-setup",
    logger: { log: () => undefined, error: () => undefined },
    env: { PATH: "/usr/bin:/bin" },
    accountHome: h,
    getuid: () => 501,
    spawn: spawn.spawn,
    readLock: () => new TextEncoder().encode("{}"),
    pollMs: 5,
  })
}

// Every shipped component previously healthy, setup state healthy for the three web ids.
function seedAll(h: string) {
  mkdirSync(toolHealthDir(h), { recursive: true, mode: 0o700 })
  const components: Record<string, unknown> = {}
  for (const id of TOOL_HEALTH_SHIPPED_IDS)
    components[id] = { lastStatus: "healthy", reason: "OK", detail: "", lastCheckedAt: 1, lastHealthyAt: 1, source: "shipped" }
  writeFileSync(join(toolHealthDir(h), "state.json"), JSON.stringify({ version: 1, updatedAt: 1, appVersion: "x", components }))
  mkdirSync(join(h, ".swarm", "setup"), { recursive: true })
  writeFileSync(
    join(h, ".swarm", "setup", "state.json"),
    JSON.stringify({ version: 1, components: { runtime: { state: "healthy" }, searxng: { state: "healthy" }, firecrawl: { state: "healthy" } } }),
  )
}

function deps(h: string, over: Partial<ToolHealthDeps>): ToolHealthDeps {
  return {
    home: h,
    platform: "darwin",
    isPackaged: false,
    appPath: "/tmp/app",
    log: () => undefined,
    defer: async () => undefined,
    // Re-probe spacing is fast; the revive timeout race (>= 10 s budgets) never fires inside a test.
    sleep: (ms) => (ms >= 10000 ? new Promise<void>(() => undefined) : new Promise<void>((r) => setTimeout(r, 1))),
    watch: () => ({ close: () => undefined, on: () => undefined as never }),
    ...over,
  }
}

const shippedOnly = (h: string) => () => createToolHealthRegistry({ home: h, platform: "darwin", isPackaged: false, appPath: "/tmp/app" }).map((c) => ({ ...c, source: "shipped" as const }))

describe("TH-03 never installs (01c 11.5)", () => {
  test("1: every shipped revive is [swarm-setup, start, runtime|searxng|firecrawl] or the in-process bridge call", async () => {
    const h = home()
    seedAll(h)
    const setup = recordingSpawn(HELP_START)
    const runner = realRunner(h, setup)
    const revived = new Set<string>()
    const argvSpawn = recordingSpawn(HELP_START)
    let bridgeRevives = 0
    // The bridge counts as previously healthy only when seen healthy in this launch: up at startup, down at re-check.
    let bridgeUp = true
    const th = createToolHealth(
      deps(h, {
        resolveRegistry: shippedOnly(h),
        setupRunner: () => runner,
        spawn: argvSpawn.spawn,
        // Down until revived; layout-runtime (no revive) stays down.
        probe: async (c) => (revived.has(c.id) || (c.id === "render-bridge" && bridgeUp) ? OK : DOWN),
        datumStudio: {
          start: async () => undefined,
          probeBridge: async () => DOWN,
          reviveBridge: async () => {
            bridgeRevives++
            revived.add("render-bridge")
          },
        },
      }),
    )
    // The runner's start marks the id revived once swarm-setup answered.
    const start = runner.start
    runner.start = async (id) => {
      const result = await start(id)
      if (result.kind === "ran" && result.exitCode === 0) revived.add(id)
      return result
    }
    await th.runStartup()
    bridgeUp = false
    await th.recheck(["render-bridge"])
    th.stop()
    const revives = setup.argvs.filter((a) => a[1] !== "--help")
    expect(revives.map((a) => a.join(" ")).sort()).toEqual([
      "swarm-setup start firecrawl",
      "swarm-setup start runtime",
      "swarm-setup start searxng",
    ])
    expect(setup.argvs.filter((a) => a[1] === "--help")).toEqual([["swarm-setup", "--help"]])
    expect(bridgeRevives).toBe(1)
    expect(argvSpawn.argvs).toEqual([])
    const state = readToolHealthState(h).state.components
    for (const id of ["runtime", "searxng", "firecrawl", "render-bridge"]) expect(state[id]?.lastStatus).toBe("revived")
  })

  test("1b: one id list for the runner, tool-health and the adapter", () => {
    expect([...SETUP_START_IDS]).toEqual(["runtime", "searxng", "firecrawl"])
    expect([...WEB_REVIVE_IDS]).toEqual([...RUNNER_START_IDS])
    const compose = createToolHealthRegistry({ home: "/h", platform: "darwin", isPackaged: false, appPath: "/a" })
      .filter((c) => c.revive && "builtin" in c.revive && c.revive.builtin === "compose-start")
      .map((c) => c.id)
    expect(compose).toEqual([...WEB_REVIVE_IDS])
  })

  test("2: no install/apply/remove/wire/up/pull/--force-recreate literal in tool-health sources", () => {
    const forbidden = new Set(["install", "apply", "remove", "wire", "up", "pull", "create", "--force-recreate"])
    const dir = import.meta.dir
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    expect(sources).toContain("web-revive.ts")
    for (const file of sources) {
      // Code only: comment lines may name the forbidden verbs to say they are never used.
      const text = readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .join("\n")
      const literals = [...text.matchAll(/"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`$\\]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "")
      const hits = literals.filter((l) => forbidden.has(l.trim()))
      expect({ file, hits }).toEqual({ file, hits: [] })
    }
    // The adapter builds no argv and spawns nothing: its only setup call is runner.start(id).
    const adapter = readFileSync(join(dir, "web-revive.ts"), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*\*)/.test(line))
      .join("\n")
    expect(adapter).not.toMatch(/child_process|spawn\(|argv/)
    expect([...adapter.matchAll(/runner\.(\w+)/g)].map((m) => m[1]).sort()).toEqual(["busy", "start"])
  })

  test("3: setup busy gives SETUP_BUSY and no retry in the pass", async () => {
    const run = async (runner: WebReviveRunner) => {
      const h = home()
      seedAll(h)
      const th = createToolHealth(
        deps(h, { resolveRegistry: () => shippedOnly(h)().filter((c) => c.id === "searxng" || c.id === "runtime"), setupRunner: () => runner, probe: async (c) => (c.id === "runtime" ? OK : DOWN) }),
      )
      await th.runStartup()
      th.stop()
      return readToolHealthState(h).state.components.searxng!
    }
    let calls = 0
    const busyFlag = await run({ busy: () => true, start: async () => (calls++, { kind: "ran", exitCode: 0, stdout: "", stderr: "" }) })
    expect([busyFlag.lastStatus, busyFlag.reason, calls]).toEqual(["revive_failed", "SETUP_BUSY", 0])
    const refused = await run({ busy: () => false, start: async () => (calls++, { kind: "refused", reason: "busy" }) })
    expect([refused.lastStatus, refused.reason, calls]).toEqual(["revive_failed", "SETUP_BUSY", 1])
    // swarm-setup's own lock (C13): RESULT REFUSED_CONCURRENCY.
    calls = 0
    const locked = await run({ start: async () => (calls++, { kind: "ran", exitCode: 1, stdout: "RESULT REFUSED_CONCURRENCY\n", stderr: "", result: "REFUSED_CONCURRENCY" }) })
    expect([locked.reason, calls]).toEqual(["SETUP_BUSY", 1])
  })

  test("3b: a revive during a person's install, through the real runner, is SETUP_BUSY and spawns no start", async () => {
    const h = home()
    seedAll(h)
    let release!: () => void
    const hold = new Promise<void>((r) => (release = r))
    const setup = recordingSpawn(HELP_START, [{ stdout: "RESULT OK\n", hold }])
    const runner = realRunner(h, setup)
    const install = runner.install(["node"])
    const th = createToolHealth(deps(h, { resolveRegistry: () => shippedOnly(h)().filter((c) => c.id === "firecrawl"), setupRunner: () => runner, probe: async () => DOWN }))
    await th.runStartup()
    th.stop()
    release()
    await install
    expect(readToolHealthState(h).state.components.firecrawl!.reason).toBe("SETUP_BUSY")
    expect(setup.argvs.some((a) => a[1] === "start")).toBe(false)
  })

  test("4: an older swarm-setup without the start verb gives SETUP_NO_START_VERB and is sent only --help", async () => {
    const h = home()
    seedAll(h)
    const setup = recordingSpawn(HELP_OLD)
    const runner = realRunner(h, setup)
    const th = createToolHealth(deps(h, { resolveRegistry: () => shippedOnly(h)().filter((c) => c.id === "runtime"), setupRunner: () => runner, probe: async () => DOWN }))
    await th.runStartup()
    th.stop()
    expect(readToolHealthState(h).state.components.runtime!.reason).toBe("SETUP_NO_START_VERB")
    expect(setup.argvs).toEqual([["swarm-setup", "--help"]])
  })

  test("5: RESULT refusal tokens map to tool-health reasons; anything else is REVIVE_EXIT", async () => {
    const opts = { log: () => undefined, secrets: () => [] as string[] }
    const ran = (stdout: string, code = 1) => ({ start: async () => ({ kind: "ran" as const, exitCode: code, stdout, stderr: "" }) })
    for (const token of ["START_NOT_INSTALLED", "RUNTIME_PROFILE_MISSING", "START_CONTAINERS_MISSING"])
      expect((await reviveWebComponent("searxng", ran(`start searxng: x\nRESULT ${token}\n`), opts)).reason as string).toBe(token)
    expect((await reviveWebComponent("searxng", ran("RESULT START_UNKNOWN_COMPONENT\n"), opts)).reason as string).toBe("REVIVE_EXIT")
    expect((await reviveWebComponent("searxng", ran("RESULT FAILED\n"), opts)).reason as string).toBe("REVIVE_EXIT")
    expect(await reviveWebComponent("searxng", ran("RESULT OK\n", 0), opts)).toEqual({ ok: true, detail: "swarm-setup start searxng ok" })
    expect((await reviveWebComponent("runtime", { start: async () => ({ kind: "refused", reason: "no_start_verb" }) }, opts)).reason as string).toBe("SETUP_NO_START_VERB")
    expect((await reviveWebComponent("runtime", { start: async () => ({ kind: "refused", reason: "spawn_failed" }) }, opts)).reason as string).toBe("REVIVE_EXIT")
    expect((await reviveWebComponent("runtime", undefined, opts)).reason as string).toBe("SETUP_NO_START_VERB")
    let called = false
    const r = await reviveWebComponent("render-bridge", { start: async () => ((called = true), { kind: "refused", reason: "x" }) }, opts)
    expect([r.ok, called]).toEqual([false, false])
  })
})
