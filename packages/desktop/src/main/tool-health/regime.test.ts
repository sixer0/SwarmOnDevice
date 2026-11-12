// TH-02 / SEC-05 / SEC-16 (1.2.6 row 91): spec 01c 11.4, the D6 decision table with fake probes, a fake clock and
// fake revives. Red class B at e363918a69 (the module is new).
import { describe, expect, test } from "bun:test"
import type { ProbeResult } from "./probe"
import { ReviveQueue, RegimeMemory, runToolHealthPass, type RegimeDeps, type ReviveOutcome, type ToolHealthPassRequest } from "./regime"
import type { ToolHealthState } from "./state"
import { REVIVE_WAIT_MS, type ResolvedToolHealthComponent } from "./types"

const OK: ProbeResult = { healthy: true, reason: "OK", detail: "GET http://127.0.0.1:1/ -> 200" }
const DOWN: ProbeResult = { healthy: false, reason: "HTTP_UNREACHABLE", detail: "connection failed (ECONNREFUSED)" }

function comp(id: string, over: Partial<ResolvedToolHealthComponent> = {}): ResolvedToolHealthComponent {
  return {
    id,
    label: `Tool ${id}`,
    probe: { kind: "http", url: "http://127.0.0.1:1/", expectStatus: 200 },
    revive: { argv: ["/bin/true"] },
    startup: "probe",
    consent: "auto",
    source: "user",
    reviveTimeoutMs: 10000,
    ...over,
  }
}

function emptyState(): ToolHealthState {
  return { version: 1, updatedAt: 0, appVersion: "1.2.6", components: {} }
}

function seeded(ids: string[]): ToolHealthState {
  const s = emptyState()
  for (const id of ids)
    s.components[id] = { lastStatus: "healthy", reason: "OK", detail: "", lastCheckedAt: 1, lastHealthyAt: 1, source: "user" }
  return s
}

type Harness = {
  deps: RegimeDeps
  clock: { now: number }
  revives: string[]
  logs: { level: string; message: string; context?: Record<string, unknown> }[]
  probes: string[]
}

/** `script[id]`: probe results in order (the last one repeats). */
function harness(script: Record<string, ProbeResult[]>, over: Partial<RegimeDeps> & { reviveResult?: (id: string) => Promise<ReviveOutcome> } = {}): Harness {
  const clock = { now: 1_000_000 }
  const revives: string[] = []
  const probes: string[] = []
  const logs: Harness["logs"] = []
  const seen: Record<string, number> = {}
  const deps: RegimeDeps = {
    platform: "darwin",
    now: () => clock.now,
    sleep: (ms) =>
      new Promise((resolve) =>
        setTimeout(() => {
          clock.now += ms
          resolve()
        }, 0),
      ),
    probe: async (c) => {
      probes.push(c.id)
      const list = script[c.id] ?? [OK]
      const i = seen[c.id] ?? 0
      seen[c.id] = i + 1
      return list[Math.min(i, list.length - 1)]!
    },
    revive: (c) =>
      c.revive
        ? async () => {
            revives.push(c.id)
            return over.reviveResult ? over.reviveResult(c.id) : { ok: true }
          }
        : undefined,
    isInstalled: () => true,
    setupState: () => undefined,
    log: (level, message, context) => logs.push({ level, message, context }),
    stopped: () => false,
    ...over,
  }
  return { deps, clock, revives, logs, probes }
}

async function pass(
  h: Harness,
  components: ResolvedToolHealthComponent[],
  state: ToolHealthState,
  request: ToolHealthPassRequest = { trigger: "startup" },
  memory = new RegimeMemory(),
  queue = new ReviveQueue(),
) {
  const results = await runToolHealthPass({ components, request, state, memory, queue, deps: h.deps })
  return Object.fromEntries(results.map((r) => [r.id, r]))
}

describe("TH-02 decision table (01c 6.2, 11.4)", () => {
  test("1: healthy stub is never revived; lastHealthyAt set", async () => {
    const h = harness({ a: [OK] })
    const state = emptyState()
    const r = await pass(h, [comp("a")], state)
    expect(r.a!.status).toBe("healthy")
    expect(h.revives).toEqual([])
    expect(state.components.a!.lastHealthyAt).toBe(h.clock.now)
  })

  test("2: dead + installed + previously healthy + auto: revived once", async () => {
    const h = harness({ a: [DOWN, OK] })
    const state = seeded(["a"])
    const r = await pass(h, [comp("a")], state)
    expect(r.a!.status).toBe("revived")
    expect(r.a!.reason).toBe("REVIVED")
    expect(h.revives).toEqual(["a"])
    expect(state.components.a!.lastReviveAt).toBeDefined()
  })

  test("3: dead + never healthy: no revive, skipped_never_healthy", async () => {
    const h = harness({ a: [DOWN] })
    const r = await pass(h, [comp("a")], emptyState())
    expect(r.a!.status).toBe("skipped_never_healthy")
    expect(r.a!.reason).toBe("NEVER_HEALTHY")
    expect(h.revives).toEqual([])
  })

  test("4: not installed: no probe, no revive, skipped_not_installed, no error", async () => {
    const h = harness({ flux3: [DOWN] }, { isInstalled: () => false })
    const r = await pass(h, [comp("flux3", { installedWhen: { path: "/nowhere/.venv/bin/python" } })], seeded(["flux3"]))
    expect(r.flux3!.status).toBe("skipped_not_installed")
    expect(r.flux3!.reason).toBe("NOT_INSTALLED")
    expect(h.probes).toEqual([])
    expect(h.revives).toEqual([])
    expect(h.logs.some((l) => l.level === "error")).toBe(false)
  })

  test("5 / SEC-05: consent manual: no revive at startup nor by an agent re-check; a person re-check revives it", async () => {
    const memory = new RegimeMemory()
    const state = seeded(["m"])
    const c = comp("m", { consent: "manual" })
    const h = harness({ m: [DOWN, DOWN, DOWN, OK] })
    expect((await pass(h, [c], state, { trigger: "startup" }, memory)).m!.reason).toBe("CONSENT_MANUAL")
    expect((await pass(h, [c], state, { trigger: "agent", ids: ["m"] }, memory)).m!.reason).toBe("CONSENT_MANUAL")
    expect(state.components.m!.lastStatus).toBe("dead")
    expect(h.revives).toEqual([])
    const r = await pass(h, [c], state, { trigger: "person", ids: ["m"] }, memory)
    expect(r.m!.status).toBe("revived")
    expect(h.revives).toEqual(["m"])
  })

  test("6: startup off: not probed at startup, probed on a re-check naming it", async () => {
    const h = harness({ o: [OK] })
    const c = comp("o", { startup: "off" })
    expect(await pass(h, [c], emptyState())).toEqual({})
    expect(h.probes).toEqual([])
    const r = await pass(h, [c], emptyState(), { trigger: "agent", ids: ["o"] })
    expect(r.o!.status).toBe("healthy")
  })

  test("7: REVIVE_MAX_PER_LAUNCH; a re-check grants one more; two re-checks inside REVIVE_WAIT_MS give one revive", async () => {
    const memory = new RegimeMemory()
    const state = seeded(["a"])
    const h = harness({ a: [DOWN, OK, DOWN, DOWN, OK, DOWN] })
    expect((await pass(h, [comp("a")], state, { trigger: "startup" }, memory)).a!.status).toBe("revived")
    h.clock.now += REVIVE_WAIT_MS + 1
    expect((await pass(h, [comp("a")], state, { trigger: "startup" }, memory)).a!.reason).toBe("REVIVE_LIMIT")
    expect((await pass(h, [comp("a")], state, { trigger: "agent", ids: ["a"] }, memory)).a!.status).toBe("revived")
    // second re-check right after: spacing blocks it
    expect((await pass(h, [comp("a")], state, { trigger: "agent", ids: ["a"] }, memory)).a!.reason).toBe("REVIVE_LIMIT")
    expect(h.revives).toEqual(["a", "a"])
  })

  test("8: requires: runtime revived first, then searxng judged; runtime revive failed -> REQUIRES_DOWN, no searxng revive", async () => {
    const order: string[] = []
    const ok = harness({ runtime: [DOWN, OK], searxng: [OK] })
    const probe = ok.deps.probe
    ok.deps.probe = async (c) => {
      order.push(c.id)
      return probe(c)
    }
    const comps = [comp("runtime"), comp("searxng", { requires: ["runtime"] })]
    const r = await pass(ok, comps, seeded(["runtime", "searxng"]))
    expect(r.runtime!.status).toBe("revived")
    expect(r.searxng!.status).toBe("healthy")
    expect(order.indexOf("searxng")).toBeGreaterThan(order.lastIndexOf("runtime"))

    const bad = harness(
      { runtime: [DOWN], searxng: [DOWN] },
      { reviveResult: async () => ({ ok: false, reason: "RUNTIME_PROFILE_MISSING", detail: "no profile" }) },
    )
    const r2 = await pass(bad, comps, seeded(["runtime", "searxng"]))
    expect(r2.runtime!.status).toBe("revive_failed")
    expect(r2.runtime!.reason).toBe("RUNTIME_PROFILE_MISSING")
    expect(r2.searxng!.reason).toBe("REQUIRES_DOWN")
    expect(bad.revives).toEqual(["runtime"])
  })

  test("9: bootstrap: no record and setup state healthy counts as previously healthy; a record without lastHealthyAt does not", async () => {
    const c = comp("searxng", { source: "shipped", installedWhen: { setupComponent: "searxng" } })
    const h = harness({ searxng: [DOWN, OK] }, { setupState: () => "healthy" })
    expect((await pass(h, [c], emptyState())).searxng!.status).toBe("revived")
    const h2 = harness({ searxng: [DOWN] }, { setupState: () => "healthy" })
    const state = emptyState()
    state.components.searxng = { lastStatus: "dead", reason: "HTTP_UNREACHABLE", detail: "", lastCheckedAt: 1, source: "shipped" }
    expect((await pass(h2, [c], state)).searxng!.status).toBe("skipped_never_healthy")
    expect(h2.revives).toEqual([])
  })

  test("9b: user components get no bootstrap; internal components count only when healthy earlier in this launch", async () => {
    const h = harness({ u: [DOWN] }, { setupState: () => "healthy" })
    expect((await pass(h, [comp("u", { installedWhen: { path: "/x" } })], emptyState())).u!.status).toBe("skipped_never_healthy")
    const memory = new RegimeMemory()
    const bridge = comp("render-bridge", { source: "shipped" })
    const state = seeded(["render-bridge"]) // a record from an earlier launch does not count for internal components
    const h2 = harness({ "render-bridge": [DOWN, OK, DOWN, OK] })
    expect((await pass(h2, [bridge], state, { trigger: "startup" }, memory))["render-bridge"]!.status).toBe("skipped_never_healthy")
    expect((await pass(h2, [bridge], state, { trigger: "agent", ids: ["render-bridge"] }, memory))["render-bridge"]!.status).toBe("healthy")
    h2.clock.now += REVIVE_WAIT_MS + 1
    expect((await pass(h2, [bridge], state, { trigger: "agent", ids: ["render-bridge"] }, memory))["render-bridge"]!.status).toBe("revived")
  })

  test("10: revives are serial across components", async () => {
    let inFlight = 0
    let max = 0
    const h = harness(
      { a: [DOWN, OK], b: [DOWN, OK] },
      {
        reviveResult: async () => {
          inFlight++
          max = Math.max(max, inFlight)
          for (let i = 0; i < 5; i++) await Promise.resolve()
          inFlight--
          return { ok: true }
        },
      },
    )
    const r = await pass(h, [comp("a"), comp("b")], seeded(["a", "b"]))
    expect(r.a!.status).toBe("revived")
    expect(r.b!.status).toBe("revived")
    expect(max).toBe(1)
  })

  test("12: a failing revive gives its reason; a revive that never turns healthy gives REVIVE_TIMEOUT", async () => {
    const fail = harness({ a: [DOWN] }, { reviveResult: async () => ({ ok: false, reason: "REVIVE_EXIT", detail: "exit 3: boom" }) })
    expect((await pass(fail, [comp("a")], seeded(["a"]))).a!.reason).toBe("REVIVE_EXIT")
    const slow = harness({ a: [DOWN] })
    const r = await pass(slow, [comp("a", { reviveTimeoutMs: 6000 })], seeded(["a"]))
    expect(r.a!.status).toBe("revive_failed")
    expect(r.a!.reason).toBe("REVIVE_TIMEOUT")
  })

  test("platform exclusion: not judged, not recorded", async () => {
    const h = harness({ runtime: [DOWN] }, { platform: "linux" })
    const state = emptyState()
    expect(await pass(h, [comp("runtime", { platforms: ["darwin"] })], state)).toEqual({})
    expect(state.components.runtime).toBeUndefined()
  })

  test("BRIDGE_NOT_STARTED is dead with no revive", async () => {
    const h = harness({ "render-bridge": [{ healthy: false, reason: "BRIDGE_NOT_STARTED", detail: "no handle" }] })
    const r = await pass(h, [comp("render-bridge", { source: "shipped" })], emptyState())
    expect(r["render-bridge"]!.status).toBe("dead")
    expect(r["render-bridge"]!.reason).toBe("BRIDGE_NOT_STARTED")
    expect(h.revives).toEqual([])
  })

  test("stop(): no new revive starts once stopped", async () => {
    let stopped = false
    const h = harness({ a: [DOWN] }, { stopped: () => stopped })
    h.deps.probe = async () => {
      stopped = true
      return DOWN
    }
    const r = await pass(h, [comp("a")], seeded(["a"]))
    expect(h.revives).toEqual([])
    expect(r.a!.status).toBe("dead")
  })
})

describe("SEC-16 / SEC-15: detail and log are scrubbed", () => {
  test("revive output with TOKEN=abc123def456 is masked in detail and log; an injected token never appears", async () => {
    const token = "f00dfeedcafe0123456789abcdef0123456789abcdef0123456789abcdef0123"
    const h = harness(
      { a: [{ healthy: false, reason: "HTTP_UNREACHABLE", detail: `down token=${token}` }] },
      {
        secrets: () => [token],
        reviveResult: async () => ({ ok: false, reason: "REVIVE_EXIT", detail: "exit 1: TOKEN=abc123def456" }),
      },
    )
    const state = seeded(["a"])
    const r = await pass(h, [comp("a")], state)
    expect(r.a!.detail).not.toContain("abc123def456")
    expect(state.components.a!.detail).not.toContain("abc123def456")
    expect(state.components.a!.detail.length).toBeLessThanOrEqual(300)
    const all = JSON.stringify({ state, logs: h.logs })
    expect(all).not.toContain("abc123def456")
    expect(all).not.toContain(token)
    expect(all).toContain("[hidden:")
  })
})
