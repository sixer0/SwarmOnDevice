// Swarm 1.2.7 row 58a (C91), live findings F-1..F-3 of row 58 (AC-U4 / AC-U5).
// F-1 (model, here): messages that share one time (a batch written in one store job) show newest first, in
// mission-model (buildMission) and after mergeFeed. F-2 / F-3 (structure): the render half in
// rel127-f1f3-feed-decision.render.ts runs in a child process (browser conditions + Solid JSX transform). happy-dom
// has no layout, so it pins the structure; the real sizes are re-measured live after the rebuild.
import { describe, expect, test } from "bun:test"
import { mergeFeed } from "./mission-command-model"
import { buildMission, type MissionFeedLine, type MissionGetWire } from "./mission-model"
import { fixture } from "./mission-deliverables.fixture"

const BATCH_AT = "2026-11-13T08:00:00.000Z"

/** `count` messages written in one job (one time, seq 1..count), then `later` messages one minute apart each. */
function batch(count: number, later = 0, order: "asc" | "desc" = "asc"): MissionGetWire {
  const wire = fixture()
  const messages = [
    ...Array.from({ length: count }, (_, i) => ({ seq: i + 1, at: BATCH_AT, text: `msg ${String(i + 1).padStart(2, "0")}` })),
    ...Array.from({ length: later }, (_, i) => ({
      seq: count + i + 1,
      at: new Date(Date.UTC(2026, 10, 13, 8, i + 1)).toISOString(),
      text: `msg ${count + i + 1} separate job`,
    })),
  ].map((msg) => ({ ...msg, from: "agent" as const, to: "controller" as const, kind: "report" as const, row: "3" }))
  wire.messages = order === "asc" ? messages : messages.reverse()
  return wire
}

const keys = (lines: MissionFeedLine[]) => lines.map((line) => line.key)
const newestFirst = (top: number, bottom: number) => Array.from({ length: top - bottom + 1 }, (_, i) => `m${top - i}`)

describe("1.2.7 row 58a F-1: equal times keep newest first", () => {
  test("26 messages of one job: buildMission and mergeFeed both show msg 26 first, msg 01 last", () => {
    const vm = buildMission(batch(26), "en")
    expect(keys(vm.feed)).toEqual(newestFirst(26, 1))
    // the live failure: mergeFeed reversed the already newest-first ties, so msg 01 was on top
    const shown = mergeFeed(vm, [])
    expect(shown[0].text).toBe("msg 26")
    expect(shown.at(-1)!.text).toBe("msg 01")
    expect(keys(shown)).toEqual(newestFirst(26, 1))
  })

  test("the live case: a batch of 26, then two separate jobs -> msg 28, msg 27, msg 26 ... msg 01", () => {
    const shown = mergeFeed(buildMission(batch(26, 2), "en"), [])
    expect(keys(shown)).toEqual(newestFirst(28, 1))
  })

  test("the wire order does not matter: messages sent newest first still give seq order within a time", () => {
    const shown = mergeFeed(buildMission(batch(5, 0, "desc"), "en"), [])
    expect(keys(shown)).toEqual(newestFirst(5, 1))
  })

  test("local lines with equal times: the one written last shows first, above store lines of that time", () => {
    const vm = buildMission(batch(3), "en")
    const local: MissionFeedLine[] = [
      { key: "l1", from: "controller", to: "owner", text: "why 1", at: BATCH_AT, local: true },
      { key: "l2", from: "controller", to: "owner", text: "why 2", at: BATCH_AT, local: true },
    ]
    expect(keys(mergeFeed(vm, local))).toEqual(["l2", "l1", "m3", "m2", "m1"])
  })

  test("a full batch of 60 in one job keeps the 50 newest (FEED_SIZE), newest first", () => {
    const shown = mergeFeed(buildMission(batch(60), "en"), [])
    expect(shown.length).toBe(50)
    expect(shown[0].key).toBe("m60")
    expect(shown.at(-1)!.key).toBe("m11")
  })
})

describe("1.2.7 row 58a F-2 / F-3 (DOM structure)", () => {
  test("one scroll container for the feed; decision actions outside the body, kept in the panel, wrapping", async () => {
    const run = Bun.spawn(
      [
        process.execPath,
        "test",
        "--conditions=browser",
        "--preload",
        "./happydom.ts",
        "./src/pages/session/swarm/rel127-f1f3-feed-decision.render.ts",
      ],
      { cwd: new URL("../../../../", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
    )
    const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
    if (code !== 0) throw new Error(output)
    expect(output).toContain(" 0 fail")
    expect(output).toMatch(/ [1-9][0-9]* pass/)
  }, 60_000)
})
