// Row 183 (decision L36): the mission poll lists by {directory, sessions}: the session directory plus the current
// session and the sessions of its run (subagents), so a mission linked only to a child session is found even when its
// project folder is elsewhere. The ids come from the session store the Agents view already fills (discovered once per
// root, new subagents through session.created); the poll only reads them, it never fetches children itself.
import { describe, expect, test } from "bun:test"
import { createMissionPoller, MISSION_SESSIONS_MAX, missionSessionsOf, type MissionSource } from "./mission-poll"

const MAIN_SES = "ses_e46061bebffe0123456789AbCd"
const CHILD_SES = "ses_e46039e30ffe0123456789AbCd"

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const timers = () => {
  const pending = new Map<number, () => void>()
  let next = 1
  return {
    timers: {
      setTimeout: (fn: () => void) => (pending.set(next, fn), next++),
      clearTimeout: (id: unknown) => void pending.delete(id as number),
      now: () => 0,
    },
    async fire() {
      const all = [...pending]
      pending.clear()
      for (const [, fn] of all) fn()
      await flush()
    },
  }
}

function recorder() {
  const inputs: unknown[] = []
  const source: MissionSource = {
    list: async (input) => (inputs.push(input), { ok: true, data: { items: [] } }),
    get: async () => ({ ok: false, code: "MISSION_NOT_FOUND", message: "x" }),
  }
  return { source, inputs }
}

describe("row 183: missionSessionsOf", () => {
  test("current first, then the run's sessions, without duplicates or non-session ids", () => {
    expect(missionSessionsOf(CHILD_SES, [MAIN_SES, CHILD_SES])).toEqual([CHILD_SES, MAIN_SES])
    expect(missionSessionsOf(MAIN_SES, [MAIN_SES, CHILD_SES, "", "msg_x", "ses_a b"])).toEqual([MAIN_SES, CHILD_SES])
    expect(missionSessionsOf(undefined, [])).toEqual([])
  })

  test(`at most ${MISSION_SESSIONS_MAX} ids (main's own limit), the current one always kept`, () => {
    const tree = Array.from({ length: 80 }, (_, i) => `ses_${String(i).padStart(26, "0")}`)
    const got = missionSessionsOf(CHILD_SES, tree)
    expect(got).toHaveLength(MISSION_SESSIONS_MAX)
    expect(got[0]).toBe(CHILD_SES)
  })
})

describe("row 183: the poll passes the sessions to list", () => {
  test("live shape: directory + main and child session; a new subagent is in the next tick's list", async () => {
    const r = recorder()
    const clock = timers()
    let tree = [MAIN_SES, CHILD_SES]
    const poller = createMissionPoller({
      source: r.source,
      directory: () => "/Users/gsp-budi/Documents/Research",
      sessions: () => missionSessionsOf(MAIN_SES, tree),
      lang: () => "en",
      onState: () => {},
      timers: clock.timers,
    })
    poller.setMode("live")
    await flush()
    expect(r.inputs).toEqual([{ directory: "/Users/gsp-budi/Documents/Research", sessions: [MAIN_SES, CHILD_SES] }])
    tree = [...tree, "ses_e4600000000000000000000000"]
    await clock.fire()
    expect(r.inputs[1]).toEqual({ directory: "/Users/gsp-budi/Documents/Research", sessions: [MAIN_SES, CHILD_SES, "ses_e4600000000000000000000000"] })
    poller.dispose()
  })

  test("no sessions accessor or an empty list: the input is {directory} as before", async () => {
    for (const sessions of [undefined, () => [] as string[]]) {
      const r = recorder()
      const poller = createMissionPoller({ source: r.source, directory: () => "/repo", sessions, lang: () => "en", onState: () => {}, timers: timers().timers })
      poller.setMode("live")
      await flush()
      expect(r.inputs).toEqual([{ directory: "/repo" }])
      poller.dispose()
    }
  })

  test("the list input is a plain array (it crosses structured clone in the preload)", async () => {
    const r = recorder()
    const ids = [MAIN_SES]
    const poller = createMissionPoller({ source: r.source, directory: () => "/repo", sessions: () => ids, lang: () => "en", onState: () => {}, timers: timers().timers })
    poller.setMode("live")
    await flush()
    const sent = (r.inputs[0] as { sessions: string[] }).sessions
    expect(Array.isArray(sent) && Object.getPrototypeOf(sent) === Array.prototype).toBe(true)
    expect(sent).not.toBe(ids)
    poller.dispose()
  })
})
