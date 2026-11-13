// 1.2.7 U-1 (AC-U1, decision U2; register N7-083): Mission Control in a session window lists only the missions linked
// to that window's session or a subagent session of its run. The poll never lists by project folder alone: with no
// session ids there is no list call and the known-empty state shows, whose empty card carries the N7-021 line
// (session.mission.emptySession). Agent studio_mission_* tools are unchanged (UI-only change).
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dict as en } from "@/i18n/en"
import { createMissionPoller, type MissionControlState, type MissionSource } from "./mission-poll"

const MAIN_SES = "ses_0127a0000001Syn127Main0001"
const DIRECTORY = "/tmp/syn127-project"

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

const timers = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  now: () => 0,
}

/** Lists two missions for any input and records every list input. */
function recorder() {
  const inputs: unknown[] = []
  const source: MissionSource = {
    list: async (input) => {
      inputs.push(input)
      const item = (id: string) => ({ id, title: id, type: "research", status: "running", progress: { done: 1, total: 2 }, openRequests: [], updatedAt: "t1" })
      return { ok: true, data: { items: [item("2026-11-13_syn-one"), item("2026-11-13_syn-two")] as never } }
    },
    get: async () => ({ ok: false, code: "MISSION_NOT_FOUND", message: "x" }),
  }
  return { source, inputs }
}

function poll(sessions: () => readonly string[]) {
  const r = recorder()
  let state: MissionControlState | undefined
  const poller = createMissionPoller({ source: r.source, directory: () => DIRECTORY, sessions, lang: () => "en", onState: (s) => (state = s), timers })
  poller.setMode("live")
  return { r, poller, state: () => state! }
}

describe("1.2.7 U-1: the poll lists by the window's session ids only", () => {
  test("case A: no session ids -> no list call, 0 options, listed", async () => {
    const p = poll(() => [])
    await flush()
    expect(p.r.inputs).toHaveLength(0)
    expect(p.state().options.length).toBe(0)
    expect(p.state().listed).toBe(true)
    p.poller.dispose()
  })

  test("case B: a session id -> the list input is {directory, sessions}", async () => {
    const p = poll(() => [MAIN_SES])
    await flush()
    expect(p.r.inputs).toEqual([{ directory: DIRECTORY, sessions: [MAIN_SES] }])
    expect(p.state().options.length).toBe(2)
    p.poller.dispose()
  })

  test("the empty card carries the N7-021 line", () => {
    const src = readFileSync(new URL("./mission-control.tsx", import.meta.url), "utf8")
    expect(src).toMatch(/<p data-mission-empty-session[^>]*>\s*\{t\("session\.mission\.emptySession"\)\}/)
    expect((en as Record<string, string>)["session.mission.emptySession"]).toBeTruthy()
  })
})
