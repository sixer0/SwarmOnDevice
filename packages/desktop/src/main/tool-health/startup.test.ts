// TH-02 (1.2.6 row 91): spec 01c 11.6, the startup binding createToolHealth (N-185). Red class B at e363918a69.
import { afterEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SETUP_START_IDS } from "../setup-runner"
import { createToolHealth, type ToolHealthDeps } from "./startup"
import { readToolHealthState, toolHealthDir, toolHealthRecheckPath } from "./state"
import type { ProbeResult } from "./probe"
import type { ResolvedToolHealthComponent } from "./types"

const homes: string[] = []
function home() {
  const dir = mkdtempSync(join(tmpdir(), "th-startup-"))
  homes.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const OK: ProbeResult = { healthy: true, reason: "OK", detail: "ok" }
const DOWN: ProbeResult = { healthy: false, reason: "HTTP_UNREACHABLE", detail: "down" }

function comp(id: string, over: Partial<ResolvedToolHealthComponent> = {}): ResolvedToolHealthComponent {
  return {
    id,
    label: id,
    probe: { kind: "http", url: "http://127.0.0.1:1/", expectStatus: 200 },
    startup: "probe",
    consent: "auto",
    source: "user",
    ...over,
  }
}

function seed(h: string, ids: string[]) {
  mkdirSync(toolHealthDir(h), { recursive: true, mode: 0o700 })
  const components: Record<string, unknown> = {}
  for (const id of ids) components[id] = { lastStatus: "healthy", reason: "OK", detail: "", lastCheckedAt: 1, lastHealthyAt: 1, source: "user" }
  writeFileSync(join(toolHealthDir(h), "state.json"), JSON.stringify({ version: 1, updatedAt: 1, appVersion: "x", components }))
}

type Listener = (event: string, filename: string | null) => void

function base(h: string, over: Partial<ToolHealthDeps> = {}): ToolHealthDeps & { listeners: Listener[] } {
  const listeners: Listener[] = []
  return {
    home: h,
    platform: "darwin",
    isPackaged: true,
    appPath: "/tmp/app",
    log: () => undefined,
    defer: async () => undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 1))),
    watch: (_dir, listener) => {
      listeners.push(listener)
      return { close: () => undefined, on: () => undefined as never }
    },
    listeners,
    ...over,
  }
}

const tick = () => new Promise((r) => setTimeout(r, 5))

describe("TH-02 startup binding (01c 11.6)", () => {
  test("1: runStartup returns at once while a probe never resolves (the ready path is not blocked)", async () => {
    const h = home()
    const th = createToolHealth(base(h, { resolveRegistry: () => [comp("a")], probe: () => new Promise<ProbeResult>(() => undefined) }))
    let next = false
    const p = th.runStartup()
    next = true
    expect(next).toBe(true)
    const raced = await Promise.race([p.then(() => "done"), tick().then(() => "pending")])
    expect(raced).toBe("pending")
    th.stop()
  })

  test("2: two calls run the probes once and return the same promise", async () => {
    const h = home()
    let probes = 0
    const th = createToolHealth(base(h, { resolveRegistry: () => [comp("a")], probe: async () => (probes++, OK) }))
    const a = th.runStartup()
    const b = th.runStartup()
    expect(a).toBe(b)
    await a
    expect(probes).toBe(1)
    expect(readToolHealthState(h).state.components.a!.lastStatus).toBe("healthy")
  })

  test("3: the render-bridge probe waits for datumStudio.start()", async () => {
    const h = home()
    const order: string[] = []
    let release!: () => void
    const started = new Promise<void>((r) => (release = r))
    const th = createToolHealth(
      base(h, {
        resolveRegistry: () => [comp("render-bridge", { source: "shipped", probe: { kind: "process", check: "render-bridge" } })],
        datumStudio: {
          start: () => started.then(() => void order.push("started")),
          probeBridge: async () => (order.push("probed"), OK),
        },
      }),
    )
    const p = th.runStartup()
    await tick()
    expect(order).toEqual([])
    release()
    await p
    expect(order).toEqual(["started", "probed"])
  })

  test("3b: without a wired bridge probe the render bridge is not probed and not recorded", async () => {
    const h = home()
    const th = createToolHealth(
      base(h, {
        resolveRegistry: () => [comp("render-bridge", { source: "shipped", probe: { kind: "process", check: "render-bridge" } })],
        datumStudio: { start: async () => undefined },
      }),
    )
    await th.runStartup()
    expect(readToolHealthState(h).state.components["render-bridge"]).toBeUndefined()
  })

  test("4: stop() during a pass: no new revive starts and the in-flight child is not killed", async () => {
    const h = home()
    seed(h, ["a", "b"])
    const spawned: string[] = []
    let killed = 0
    let th!: ReturnType<typeof createToolHealth>
    th = createToolHealth(
      base(h, {
        resolveRegistry: () => [comp("a", { revive: { argv: ["/bin/sh", "a"] } }), comp("b", { revive: { argv: ["/bin/sh", "b"] } })],
        probe: async () => DOWN,
        spawn: ((_cmd: string, args: string[]) => {
          spawned.push(args[0]!)
          const child = new EventEmitter() as EventEmitter & { kill: () => void }
          child.kill = () => void killed++
          // never closes; stop() arrives while it runs
          setTimeout(() => th.stop(), 0)
          return child
        }) as never,
        sleep: () => new Promise((r) => setTimeout(r, 1)),
      }),
    )
    await Promise.race([th.runStartup(), new Promise((r) => setTimeout(r, 200))])
    await tick()
    expect(spawned.length).toBe(1)
    expect(killed).toBe(0)
  })

  test("5: recheck.json triggers one pass and is deleted; two writes during a pass give one follow-up pass", async () => {
    const h = home()
    let probes = 0
    let gate: (() => void) | undefined
    const deps = base(h, {
      resolveRegistry: () => [comp("tool-a")],
      probe: async () => {
        probes++
        if (probes === 2) await new Promise<void>((r) => (gate = r))
        return OK
      },
    })
    const th = createToolHealth(deps)
    await th.runStartup()
    await tick()
    expect(probes).toBe(1)
    expect(deps.listeners.length).toBe(1)
    const fire = () => deps.listeners[0]!("rename", "recheck.json")

    writeFileSync(toolHealthRecheckPath(h), JSON.stringify({ ids: ["tool-a"] }))
    fire()
    await tick()
    expect(existsSync(toolHealthRecheckPath(h))).toBe(false)
    expect(probes).toBe(2) // pass running, held at the gate
    writeFileSync(toolHealthRecheckPath(h), JSON.stringify({ ids: ["tool-a"] }))
    fire()
    await tick()
    writeFileSync(toolHealthRecheckPath(h), JSON.stringify({}))
    fire()
    await tick()
    deps.listeners[0]!("change", "state.json") // our own writes are ignored
    gate!()
    await tick()
    await tick()
    expect(probes).toBe(3)
    th.stop()
  })
})

describe("never installs (row 91 part of 01c section 7)", () => {
  test("compose-start only ever calls runner.start with runtime|searxng|firecrawl; no start verb -> SETUP_NO_START_VERB; busy -> SETUP_BUSY", async () => {
    expect([...SETUP_START_IDS]).toEqual(["runtime", "searxng", "firecrawl"])
    const calls: string[] = []
    const shipped = (id: string) =>
      comp(id, { source: "shipped", revive: { builtin: "compose-start" }, installedWhen: { setupComponent: id } })
    const run = async (runner: ToolHealthDeps["setupRunner"]) => {
      const h = home()
      mkdirSync(join(h, ".swarm", "setup"), { recursive: true })
      writeFileSync(
        join(h, ".swarm", "setup", "state.json"),
        JSON.stringify({ components: { searxng: { state: "healthy" } } }),
      )
      const th = createToolHealth(base(h, { resolveRegistry: () => [shipped("searxng")], probe: async () => DOWN, setupRunner: runner }))
      await th.runStartup()
      return readToolHealthState(h).state.components.searxng!
    }
    expect((await run(() => ({ busy: () => false }))).reason).toBe("SETUP_NO_START_VERB")
    expect((await run(() => undefined)).reason).toBe("SETUP_NO_START_VERB")
    expect((await run(() => ({ busy: () => true, start: async () => ({ kind: "ran", exitCode: 0, stdout: "", stderr: "" }) }))).reason).toBe("SETUP_BUSY")
    const missing = await run(() => ({
      start: async (id) => (calls.push(id), { kind: "ran", exitCode: 3, stdout: "", stderr: "START_CONTAINERS_MISSING" }),
    }))
    expect(missing.reason).toBe("START_CONTAINERS_MISSING")
    expect(calls).toEqual(["searxng"])
  })
})
