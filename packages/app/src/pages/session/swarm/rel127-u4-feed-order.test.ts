// Swarm 1.2.7 row 27, AC-U4 (N7-087; C6, R-5). The Mission Control feed is newest first, holds up to 50 entries
// (FEED_SIZE = MISSION_MESSAGES_TAIL), shows about 10 (FEED_VISIBLE_ROWS feed entries) and scrolls for the rest.
// Model half here; the DOM half (N7-125) runs in a child process like mission-deliverables.test.ts.
import { describe, expect, test } from "bun:test"
import { mergeFeed } from "./mission-command-model"
import * as missionModel from "./mission-model"
import { buildMission, type MissionFeedLine, type MissionGetWire } from "./mission-model"
import { fixture } from "./mission-deliverables.fixture"

// Namespace read: at the red base the name is absent, so the test fails on an assertion, not on the import.
const FEED_VISIBLE_ROWS = (missionModel as Record<string, unknown>).FEED_VISIBLE_ROWS as number | undefined

/** `count` synthetic messages, one minute apart, seq 1..count (seq 1 oldest). */
function withMessages(count: number): MissionGetWire {
  const wire = fixture()
  wire.messages = Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    at: new Date(Date.UTC(2026, 10, 13, 8, i)).toISOString(),
    from: "agent" as const,
    to: "controller" as const,
    kind: "report" as const,
    text: `report ${i + 1}`,
    row: "3",
  }))
  return wire
}

describe("1.2.7 U-4 mission feed (model)", () => {
  test("12 messages give 12 lines, newest first", () => {
    const vm = buildMission(withMessages(12), "en")
    expect(vm.feed.length).toBe(12)
    expect(vm.feed[0].key).toBe("m12")
    expect(vm.feed.at(-1)!.key).toBe("m1")
    expect(vm.feed.map((line) => line.key)).toEqual(Array.from({ length: 12 }, (_, i) => `m${12 - i}`))
  })

  test("60 messages give the 50 newest, newest first; FEED_SIZE 50, FEED_VISIBLE_ROWS 10", () => {
    const vm = buildMission(withMessages(60), "en")
    expect(vm.feed.length).toBe(50)
    expect(vm.feed[0].key).toBe("m60")
    expect(vm.feed.at(-1)!.key).toBe("m11")
    expect(missionModel.FEED_SIZE).toBe(50)
    expect(FEED_VISIBLE_ROWS).toBe(10)
  })

  test("an answered decision is a feed entry in time order, newest first", () => {
    const wire = withMessages(3)
    wire.requests = [
      {
        id: "D-1",
        question: "Ship?",
        options: [{ id: "A", label: "Ship", consequence: "now" }],
        status: "answered",
        createdAt: "2026-11-13T08:00:30.000Z",
        closedAt: "2026-11-13T08:01:30.000Z",
        answer: { option: "A", by: "user", decision: "U1" },
      },
    ]
    const vm = buildMission(wire, "en")
    expect(vm.feed.map((line) => line.key)).toEqual(["m3", "aD-1", "m2", "m1"])
  })

  test("mergeFeed keeps newest first with local lines merged", () => {
    const vm = buildMission(withMessages(3), "en")
    const local: MissionFeedLine[] = [
      { key: "l1", from: "owner", to: "controller", text: "older", at: "2026-11-13T08:00:30.000Z", local: true },
      { key: "l2", from: "owner", to: "controller", text: "newest", at: "2026-11-13T09:00:00.000Z", local: true },
    ]
    expect(mergeFeed(vm, local).map((line) => line.key)).toEqual(["l2", "m3", "m2", "l1", "m1"])
    expect(mergeFeed(buildMission(withMessages(55), "en"), local).length).toBe(50)
  })
})

describe("1.2.7 U-4 mission feed (DOM, N7-125)", () => {
  test("bounded scroll list of FEED_VISIBLE_ROWS entries, newest first, scrollbar not hidden", async () => {
    const run = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "./src/pages/session/swarm/rel127-u4-feed-order.render.ts",
      ],
      { cwd: new URL("../../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
    )
    const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    if (code !== 0) throw new Error(output)
    expect(output).toContain(" 0 fail")
    expect(output).toMatch(/ [1-9][0-9]* pass/)
  }, 60_000)
})
