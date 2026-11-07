import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { MissionGetWire, MissionListItemWire } from "./mission-model"
import {
  BACKOFF_MS,
  DISCOVER_MS,
  LIVE_MS,
  createMissionControl,
  createMissionPoller,
  missionSourceOf,
  pollModeOf,
  type MissionControlState,
  type MissionSource,
} from "./mission-poll"

function fakeTimers() {
  let now = 0
  let next = 1
  const pending = new Map<number, { at: number; fn: () => void }>()
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        const id = next++
        pending.set(id, { at: now + ms, fn })
        return id
      },
      clearTimeout: (id: unknown) => void pending.delete(id as number),
      now: () => now,
    },
    pending: () => [...pending.values()].map((p) => p.at - now),
    async advance(ms: number) {
      now += ms
      for (const [id, p] of [...pending]) {
        if (p.at > now) continue
        pending.delete(id)
        p.fn()
      }
      await flush()
    },
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const item = (id: string, status: MissionListItemWire["status"], updatedAt = "t1"): MissionListItemWire => ({
  id,
  title: id,
  type: "research",
  status,
  progress: { done: 1, total: 2 },
  openRequests: [],
  updatedAt,
})

const getWire = (id: string): MissionGetWire => ({
  mission: { id, title: id, type: "research", status: "running", rows: [] },
  derived: { phases: [], waves: [], progress: { done: 1, total: 2 }, checkpoints: {} },
})

function fakeSource(items: () => MissionListItemWire[]) {
  const calls: string[] = []
  let failList = false
  const source: MissionSource = {
    list: async (input) => {
      calls.push(`list:${input.directory}`)
      if (failList) return { ok: false, code: "HOST_UNAVAILABLE", message: "down" }
      return { ok: true, data: { items: items() } }
    },
    get: async (input) => {
      calls.push(`get:${input.mission}`)
      return { ok: true, data: getWire(input.mission) }
    },
  }
  return { source, calls, setFail: (v: boolean) => (failList = v) }
}

function setup(items: () => MissionListItemWire[], directory = () => "/repo" as string | undefined) {
  const clock = fakeTimers()
  const fake = fakeSource(items)
  const states: MissionControlState[] = []
  const poller = createMissionPoller({
    source: fake.source,
    directory,
    lang: () => "en",
    listFiles: async () => [],
    onState: (s) => states.push(s),
    timers: clock.timers,
  })
  return { clock, fake, poller, states, last: () => states.at(-1)! }
}

describe("mission poller", () => {
  test("live: reads at once, every 3 s, get only on change; stops when hidden", async () => {
    let updatedAt = "t1"
    const { clock, fake, poller, last } = setup(() => [item("m-done", "done"), item("m-run", "running", updatedAt)])
    poller.setMode("live")
    await flush()
    expect(fake.calls).toEqual(["list:/repo", "get:m-run"])
    expect(last().selected).toBe("m-run")
    expect(last().mission?.id).toBe("m-run")
    expect(clock.pending()).toEqual([LIVE_MS])

    await clock.advance(LIVE_MS)
    expect(fake.calls).toEqual(["list:/repo", "get:m-run", "list:/repo"])

    updatedAt = "t2"
    await clock.advance(LIVE_MS)
    expect(fake.calls.slice(-2)).toEqual(["list:/repo", "get:m-run"])

    poller.setMode("stopped")
    expect(clock.pending()).toEqual([])
    const before = fake.calls.length
    await clock.advance(60_000)
    expect(fake.calls.length).toBe(before)
  })

  test("discover: list only every 15 s", async () => {
    const { clock, fake, poller } = setup(() => [item("m", "running")])
    poller.setMode("discover")
    await flush()
    expect(fake.calls).toEqual(["list:/repo"])
    expect(clock.pending()).toEqual([DISCOVER_MS])
    poller.setMode("live")
    await flush()
    expect(fake.calls).toEqual(["list:/repo", "list:/repo", "get:m"])
  })

  test("error: readFailed and back-off 3 -> 6 -> 12 -> 30 s, reset on success", async () => {
    const { clock, fake, poller, last } = setup(() => [item("m", "running")])
    fake.setFail(true)
    poller.setMode("live")
    await flush()
    expect(last().readFailed).toBe(true)
    const seen: number[] = []
    for (let i = 0; i < 5; i++) {
      seen.push(clock.pending()[0])
      await clock.advance(clock.pending()[0])
    }
    expect(seen).toEqual([...BACKOFF_MS, 30000])
    fake.setFail(false)
    await clock.advance(clock.pending()[0])
    expect(last().readFailed).toBe(false)
    expect(last().mission?.id).toBe("m")
    expect(clock.pending()).toEqual([LIVE_MS])
  })

  test("empty list: no mission, no get", async () => {
    const { fake, poller, last } = setup(() => [])
    poller.setMode("live")
    await flush()
    expect(fake.calls).toEqual(["list:/repo"])
    expect(last()).toEqual({ options: [], selected: undefined, mission: null, readFailed: false, listed: true })
  })

  test("row 136 L1: listed is false until the first list answers, and comes with the options", async () => {
    let answer = () => {}
    const source: MissionSource = {
      list: () => new Promise((resolve) => (answer = () => resolve({ ok: true, data: { items: [item("a", "running")] } }))),
      get: async (input) => ({ ok: true, data: getWire(input.mission) }),
    }
    const states: MissionControlState[] = []
    const poller = createMissionPoller({ source, directory: () => "/repo", lang: () => "en", onState: (s) => states.push(s), timers: fakeTimers().timers })
    poller.setMode("discover")
    await flush()
    expect(states.every((s) => !s.listed)).toBe(true)
    answer()
    await flush()
    const first = states.find((s) => s.listed)!
    expect(first.options.map((o) => o.id)).toEqual(["a"])
    poller.dispose()
  })

  test("row 136 L1: a failed list leaves listed false; no directory means known (no missions)", async () => {
    const failed = setup(() => [item("a", "running")])
    failed.fake.setFail(true)
    failed.poller.setMode("live")
    await flush()
    expect(failed.last().listed).toBe(false)
    failed.poller.dispose()
    const none = setup(() => [], () => undefined)
    none.poller.setMode("live")
    await flush()
    expect(none.last().listed).toBe(true)
    none.poller.dispose()
  })

  test("no directory: nothing is called", async () => {
    const { fake, poller, last } = setup(() => [item("m", "running")], () => undefined)
    poller.setMode("live")
    await flush()
    expect(fake.calls).toEqual([])
    expect(last().mission).toBeNull()
  })

  test("select reads the chosen mission at once and keeps it", async () => {
    const { clock, fake, poller, last } = setup(() => [item("a", "running"), item("b", "done")])
    poller.setMode("live")
    await flush()
    poller.select("b")
    await flush()
    expect(fake.calls.slice(-2)).toEqual(["list:/repo", "get:b"])
    await clock.advance(LIVE_MS)
    expect(last().selected).toBe("b")
  })

  // Row 136 M2: a read in flight must not overwrite a newer choice (repro /private/tmp/claude-501/row136/repro/select2.ts).
  function gated(items: () => MissionListItemWire[]) {
    const calls: string[] = []
    const held: Array<() => void> = []
    let hold = false
    const source: MissionSource = {
      list: async () => ({ ok: true, data: { items: items() } }),
      get: (input) => {
        calls.push(`get:${input.mission}`)
        return new Promise((resolve) => {
          const go = () => resolve({ ok: true, data: getWire(input.mission) })
          if (hold) held.push(go)
          else go()
        })
      },
    }
    return { source, calls, hold: (v: boolean) => (hold = v), release: () => held.splice(0).forEach((go) => go()) }
  }

  test("select during an in-flight get: the stale mission is dropped and the chosen one is read", async () => {
    let updatedAt = "t1"
    const fake = gated(() => [item("a", "running", updatedAt), item("b", "paused")])
    const clock = fakeTimers()
    const states: MissionControlState[] = []
    const poller = createMissionPoller({ source: fake.source, directory: () => "/repo", lang: () => "en", onState: (s) => states.push(s), timers: clock.timers })
    poller.setMode("live")
    await flush()
    expect(states.at(-1)!.mission?.id).toBe("a")
    fake.hold(true)
    updatedAt = "t2"
    poller.refresh()
    await flush()
    expect(fake.calls).toEqual(["get:a", "get:a"])
    poller.select("b")
    expect(states.at(-1)!.selected).toBe("b")
    fake.hold(false)
    fake.release()
    await flush()
    await flush()
    // Never shows a after the user chose b, and b is read right after the stale read.
    const afterSelect = states.slice(states.findIndex((s) => s.selected === "b"))
    expect(afterSelect.every((s) => s.selected === "b")).toBe(true)
    expect(afterSelect.some((s) => s.mission?.id === "a")).toBe(false)
    expect(fake.calls).toEqual(["get:a", "get:a", "get:b"])
    expect(states.at(-1)!.mission?.id).toBe("b")
    poller.dispose()
  })

  test("select during the file listing after a get: the stale mission is dropped", async () => {
    const fake = gated(() => [item("a", "running"), item("b", "paused")])
    const clock = fakeTimers()
    const states: MissionControlState[] = []
    let releaseFiles = () => {}
    let holdFiles = false
    const poller = createMissionPoller({
      source: fake.source,
      directory: () => "/repo",
      lang: () => "en",
      listFiles: () => (holdFiles ? new Promise<string[]>((resolve) => (releaseFiles = () => resolve([]))) : Promise.resolve([])),
      onState: (s) => states.push(s),
      timers: clock.timers,
    })
    holdFiles = true
    poller.setMode("live")
    await flush()
    poller.select("b")
    holdFiles = false
    releaseFiles()
    await flush()
    await flush()
    const afterSelect = states.slice(states.findIndex((s) => s.selected === "b"))
    expect(afterSelect.some((s) => s.mission?.id === "a" || s.selected === "a")).toBe(false)
    expect(states.at(-1)!.mission?.id).toBe("b")
    poller.dispose()
  })

  test("mode drops from live during a get: the late reply is not shown", async () => {
    const fake = gated(() => [item("a", "running")])
    const clock = fakeTimers()
    const states: MissionControlState[] = []
    const poller = createMissionPoller({ source: fake.source, directory: () => "/repo", lang: () => "en", onState: (s) => states.push(s), timers: clock.timers })
    fake.hold(true)
    poller.setMode("live")
    await flush()
    poller.setMode("discover")
    fake.hold(false)
    fake.release()
    await flush()
    expect(states.some((s) => s.mission !== null)).toBe(false)
    poller.dispose()
  })
})

describe("createMissionControl", () => {
  test("absent platform field: not available, nothing polls", () => {
    expect(missionSourceOf({})).toBeUndefined()
    expect(missionSourceOf({ missions: { list: () => {} } })).toBeUndefined()
    createRoot((dispose) => {
      const control = createMissionControl({
        source: undefined,
        directory: () => "/repo",
        lang: () => "en",
        watching: () => true,
        mapOpen: () => true,
      })
      expect(control.available).toBe(false)
      expect(control.state.mission).toBeNull()
      dispose()
    })
  })

  // createEffect does not run under the unit-test Solid build (probe in the row report), so the
  // reactive wiring is a one-line call of pollModeOf; the poller itself is tested above.
  test("pollModeOf: live only while the Agents view is visible", () => {
    expect(pollModeOf({ docVisible: true, watching: true, mapOpen: true })).toBe("live")
    expect(pollModeOf({ docVisible: true, watching: false, mapOpen: true })).toBe("discover")
    expect(pollModeOf({ docVisible: true, watching: false, mapOpen: false })).toBe("stopped")
    expect(pollModeOf({ docVisible: false, watching: true, mapOpen: true })).toBe("stopped")
  })
})
