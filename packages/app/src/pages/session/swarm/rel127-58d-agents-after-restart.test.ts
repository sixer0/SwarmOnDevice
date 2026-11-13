// 1.2.7 row 58d (F-6 of the live session, AC-U1 context): after an app restart the session map comes back open, and
// the window may start hidden (behind another window, not yet focused). The Agents entry is offered only once the
// missions of the session are known (offersAgentsView, mission-control-layout.ts). A hidden window with the map open
// used to stop the poll ("stopped"), so the first list never ran and a one-agent session with missions offered no
// Agents entry until the window became visible. Now it lists at the discover cadence (list only, no get).
// The list input always carries the current session id, also before any lane (subagent) is known (U-1 kept).
import { describe, expect, test } from "bun:test"
import { offersAgentsView } from "./mission-control-layout"
import {
  createMissionPoller,
  DISCOVER_MS,
  missionSessionsOf,
  pollModeOf,
  type MissionControlState,
  type MissionSource,
} from "./mission-poll"

const SESSION = "ses_0158d0000001Syn127Restart1"
const DIRECTORY = "/tmp/syn127-project"

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

/** The store after the restart: one mission linked to SESSION, none for any other id. Records every call. */
function store() {
  const lists: Array<{ directory: string; sessions?: string[] }> = []
  let gets = 0
  const source: MissionSource = {
    list: async (input) => {
      lists.push(input)
      const linked = (input.sessions ?? []).includes(SESSION)
      const item = { id: "2026-11-13_syn-58d", title: "Syn 58d", type: "research", status: "running", progress: { done: 0, total: 1 }, openRequests: [], updatedAt: "t1" }
      return { ok: true, data: { items: (linked ? [item] : []) as never } }
    },
    get: async () => {
      gets++
      return { ok: false, code: "MISSION_NOT_FOUND", message: "x" }
    },
  }
  return { source, lists, gets: () => gets }
}

function fakeTimers() {
  const queue: Array<{ fn: () => void; ms: number }> = []
  return {
    queue,
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        queue.push({ fn, ms })
        return queue.length - 1
      },
      clearTimeout: () => {},
      now: () => 0,
    },
  }
}

/** A restarted window: a fresh poller, the persisted map open, the Agents filter not chosen, no lane known yet. */
function restart(docVisible: boolean) {
  const s = store()
  const t = fakeTimers()
  let state: MissionControlState | undefined
  const poller = createMissionPoller({
    source: s.source,
    directory: () => DIRECTORY,
    sessions: () => missionSessionsOf(SESSION, []),
    lang: () => "en",
    onState: (next) => (state = next),
    timers: t.timers,
  })
  poller.setMode(pollModeOf({ docVisible, watching: false, mapOpen: true }))
  return { s, t, poller, state: () => state }
}

describe("1.2.7 row 58d: the Agents view is offered after a restart for a session with missions", () => {
  test("the list input carries the current session id even before any lane is known", () => {
    expect(missionSessionsOf(SESSION, [])).toEqual([SESSION])
  })

  test("map open, window visible: the first list offers the Agents view (control)", async () => {
    const r = restart(true)
    await flush()
    expect(r.s.lists).toEqual([{ directory: DIRECTORY, sessions: [SESSION] }])
    expect(offersAgentsView(1, r.state()?.options.length ?? 0)).toBe(true)
    r.poller.dispose()
  })

  test("map open, window hidden: the missions are still listed, so the Agents view is offered", async () => {
    const r = restart(false)
    await flush()
    expect(r.s.lists).toEqual([{ directory: DIRECTORY, sessions: [SESSION] }])
    expect(r.state()?.listed).toBe(true)
    expect(offersAgentsView(1, r.state()?.options.length ?? 0)).toBe(true)
    // List only (no get) at the slow cadence while hidden.
    expect(r.s.gets()).toBe(0)
    expect(r.t.queue.at(-1)?.ms).toBe(DISCOVER_MS)
    r.poller.dispose()
  })

  test("map closed, window hidden: nothing to offer, no poll", async () => {
    expect(pollModeOf({ docVisible: false, watching: false, mapOpen: false })).toBe("stopped")
  })
})
