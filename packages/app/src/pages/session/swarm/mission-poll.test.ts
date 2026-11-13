import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import type { MissionGetWire, MissionListItemWire } from "./mission-model"
import {
  BACKOFF_MS,
  DISCOVER_MS,
  LIVE_MS,
  BACKGROUND_MS,
  READ_TIMEOUT_MS,
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

// INTENT 1.2.7 U-1 (U2): the poll lists only by the window's session ids, so each poller here has one.
const SES = ["ses_poll0001"]

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
    sessions: () => SES,
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
    expect(last().unavailable).toBe(true) // row 180: HOST_UNAVAILABLE = Studio is not running
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
    expect(last().unavailable).toBe(false)
    expect(clock.pending()).toEqual([LIVE_MS])
  })

  test("empty list: no mission, no get", async () => {
    const { fake, poller, last } = setup(() => [])
    poller.setMode("live")
    await flush()
    expect(fake.calls).toEqual(["list:/repo"])
    expect(last()).toEqual({
      options: [],
      selected: undefined,
      mission: null,
      readFailed: false,
      listed: true,
      unavailable: false,
    })
  })

  test("row 136 L1: listed is false until the first list answers, and comes with the options", async () => {
    let answer = () => {}
    const source: MissionSource = {
      list: () => new Promise((resolve) => (answer = () => resolve({ ok: true, data: { items: [item("a", "running")] } }))),
      get: async (input) => ({ ok: true, data: getWire(input.mission) }),
    }
    const states: MissionControlState[] = []
    const poller = createMissionPoller({ source, directory: () => "/repo", sessions: () => SES, lang: () => "en", onState: (s) => states.push(s), timers: fakeTimers().timers })
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
    const poller = createMissionPoller({ source: fake.source, directory: () => "/repo", sessions: () => SES, lang: () => "en", onState: (s) => states.push(s), timers: clock.timers })
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
      sessions: () => SES,
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

  // Row 173 (F146b-1): in row 146b the window went hidden at ~04:41 (display off after the idle timeout, pmset log)
  // while the Agents view stayed open; the poll stopped and the view kept 17 %, 1/6 to the end of the mission.
  test("row 173: a hidden window with the Agents view open keeps reading (list + get), every 15 s", async () => {
    let updatedAt = "t1"
    const { clock, fake, poller, last } = setup(() => [item("m", "running", updatedAt)])
    poller.setMode(pollModeOf({ docVisible: true, watching: true, mapOpen: true }))
    await flush()
    expect(fake.calls).toEqual(["list:/repo", "get:m"])
    poller.setMode(pollModeOf({ docVisible: false, watching: true, mapOpen: true }))
    expect(clock.pending()).toEqual([BACKGROUND_MS])
    updatedAt = "t2"
    await clock.advance(BACKGROUND_MS)
    expect(fake.calls.slice(-2)).toEqual(["list:/repo", "get:m"])
    expect(last().mission?.id).toBe("m")
    // Back in view: read at once, then the 3 s cadence.
    poller.setMode(pollModeOf({ docVisible: true, watching: true, mapOpen: true }))
    await flush()
    expect(fake.calls.slice(-1)).toEqual(["list:/repo"])
    expect(clock.pending()).toEqual([LIVE_MS])
    poller.dispose()
  })

  test("row 173: a read that never answers does not stop the poll (timeout, back-off, recovery)", async () => {
    let hang = true
    const calls: string[] = []
    const source: MissionSource = {
      list: (input) => {
        calls.push(`list:${input.directory}`)
        if (hang) return new Promise(() => {})
        return Promise.resolve({ ok: true as const, data: { items: [item("m", "running")] } })
      },
      get: async (input) => {
        calls.push(`get:${input.mission}`)
        return { ok: true as const, data: getWire(input.mission) }
      },
    }
    const clock = fakeTimers()
    const states: MissionControlState[] = []
    const poller = createMissionPoller({ source, directory: () => "/repo", sessions: () => SES, lang: () => "en", onState: (s) => states.push(s), timers: clock.timers })
    poller.setMode("live")
    await flush()
    expect(calls).toEqual(["list:/repo"])
    await clock.advance(READ_TIMEOUT_MS)
    expect(states.at(-1)?.readFailed).toBe(true)
    hang = false
    await clock.advance(clock.pending()[0])
    expect(calls.slice(-2)).toEqual(["list:/repo", "get:m"])
    expect(states.at(-1)?.readFailed).toBe(false)
    expect(states.at(-1)?.mission?.id).toBe("m")
    expect(clock.pending()).toEqual([LIVE_MS])
    poller.dispose()
  })

  test("mode drops from live during a get: the late reply is not shown", async () => {
    const fake = gated(() => [item("a", "running")])
    const clock = fakeTimers()
    const states: MissionControlState[] = []
    const poller = createMissionPoller({ source: fake.source, directory: () => "/repo", sessions: () => SES, lang: () => "en", onState: (s) => states.push(s), timers: clock.timers })
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

// Row 165E (C192): the mission poll registers the deliverables found in the project as the directory's Studio outputs;
// the file tab renders a DATUM-named .html only when its path is registered.
describe("row 165E: registered Studio outputs", () => {
  test("a deliverable found in docs/<mission>/ under its DATUM name is registered for that directory only", async () => {
    const { registeredStudioOutputs, resetStudioOutputRegistry } = await import("../studio-output-registry")
    const { isStudioOutputPath } = await import("../file-preview-policy")
    resetStudioOutputRegistry()
    const HTML = "Laporan Kerja 012-GSP-KT-XI-2026 RevA.html"
    const OTHER = "Laporan 2026-11-02.html"
    const source: MissionSource = {
      list: async () => ({ ok: true, data: { items: [item("m-run", "running")] } }),
      get: async (input) => ({
        ok: true,
        data: {
          ...getWire(input.mission),
          deliverables: [
            {
              documentId: "d1",
              title: "Laporan Kerja",
              docKey: null,
              docRev: "A",
              outputs: [
                { fileId: "f1", format: "HTML", role: "PRIMARY", finalFileName: "012-GSP-KT-XI-2026_rev1_20261107T194129Z_293ba138.html", fileName: HTML, verified: true },
              ],
            },
          ],
        },
      }),
    }
    const poller = createMissionPoller({
      source,
      directory: () => "/repo",
      sessions: () => SES,
      lang: () => "en",
      // INTENT 1.2.7 U-2: the poll also lists docs/<m>/11_deliverables; this case is about the flat folder only.
      listFiles: async (path) => (path === "docs/m-run" ? [HTML, OTHER] : []),
      onState: () => {},
      timers: fakeTimers().timers,
    })
    poller.setMode("live")
    await flush()
    const registered = registeredStudioOutputs("/repo")
    expect([...registered]).toEqual([`docs/m-run/${HTML}`])
    expect(isStudioOutputPath(`docs/m-run/${HTML}`, registered)).toBe(true)
    // The user's own file next to it, DATUM-shaped but no deliverable: not registered, stays code view.
    expect(isStudioOutputPath(`docs/m-run/${OTHER}`, registered)).toBe(false)
    expect(isStudioOutputPath(`docs/m-run/${HTML}`, registeredStudioOutputs("/other"))).toBe(false)
    poller.dispose()
    resetStudioOutputRegistry()
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
  test("pollModeOf: live while the Agents view is visible; background while it is open in a hidden window", () => {
    expect(pollModeOf({ docVisible: true, watching: true, mapOpen: true })).toBe("live")
    expect(pollModeOf({ docVisible: true, watching: false, mapOpen: true })).toBe("discover")
    expect(pollModeOf({ docVisible: true, watching: false, mapOpen: false })).toBe("stopped")
    expect(pollModeOf({ docVisible: false, watching: true, mapOpen: true })).toBe("background")
    // INTENT 1.2.7 row 58d (F-6): hidden window, map open -> discover (list only), so the Agents entry is known.
    expect(pollModeOf({ docVisible: false, watching: false, mapOpen: true })).toBe("discover")
    expect(pollModeOf({ docVisible: false, watching: false, mapOpen: false })).toBe("stopped")
  })
})
