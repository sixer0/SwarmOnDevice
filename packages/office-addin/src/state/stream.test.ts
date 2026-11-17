import { describe, expect, test } from "bun:test"
import { initialStream, reduceStream, replies, type StreamEffect, type StreamEvent, type StreamState } from "./stream"

// Fixture modelled on test/evidence/m0/14_s4_capture_thinker.txt (run 1).
const SES = "ses_e1d246b1dffeMlpjURmi68LeBB"
const OTHER = "ses_other"
const USER_MSG = "msg_user"
const ASSIST_MSG = "msg_assistant"

const frame = (type: string, properties: Record<string, unknown>) => ({ id: `evt_${type}`, type, properties })
const delta = (partID: string, messageID: string, text: string) =>
  frame("message.part.delta", { sessionID: SES, messageID, partID, field: "text", delta: text })
const part = (id: string, messageID: string, type: string, text?: string) =>
  frame("message.part.updated", { sessionID: SES, part: { id, sessionID: SES, messageID, type, text }, time: 1 })
const message = (id: string, role: string, completed = false) =>
  frame("message.updated", {
    sessionID: SES,
    info: {
      id,
      sessionID: SES,
      role,
      ...(role === "assistant" ? { providerID: "gsp-ai-tail", modelID: "thinker" } : {}),
      time: completed ? { created: 1, completed: 2 } : { created: 1 },
    },
  })
const noise = () => [
  ...Array.from({ length: 36 }, () => ({ id: "n", type: "plugin.added", properties: { name: "x" } })),
  { id: "n", type: "catalog.updated", properties: {} },
  ...Array.from({ length: 9 }, () => ({ id: "n", type: "plugin.added", properties: {} })),
  { id: "n", type: "reference.updated", properties: {} },
  { id: "n", type: "integration.updated", properties: {} },
  { id: "n", type: "catalog.updated", properties: {} },
]

const REASONING = ["The", " user is simply", " asking me to reply with one word", " PONG, so", " I will answer", " with it."]

function capture() {
  return [
    { id: "c", type: "server.connected", properties: {} },
    frame("session.created", { sessionID: SES, info: { id: SES } }),
    frame("session.updated", { sessionID: SES, info: { id: SES } }),
    message(USER_MSG, "user"),
    part("prt_user", USER_MSG, "text", "Reply with the word PONG."),
    frame("session.status", { sessionID: SES, status: { type: "busy" } }),
    message(ASSIST_MSG, "assistant"),
    frame("session.diff", { sessionID: SES, diff: [] }),
    message(USER_MSG, "user"),
    ...noise(),
    part("prt_step", ASSIST_MSG, "step-start"),
    part("prt_reason", ASSIST_MSG, "reasoning", ""),
    ...REASONING.map((text) => delta("prt_reason", ASSIST_MSG, text)),
    part("prt_reason", ASSIST_MSG, "reasoning", REASONING.join("")),
    part("prt_text", ASSIST_MSG, "text", ""),
    delta("prt_text", ASSIST_MSG, "PO"),
    delta("prt_text", ASSIST_MSG, "NG"),
    part("prt_text", ASSIST_MSG, "text", "PONG"),
    part("prt_finish", ASSIST_MSG, "step-finish"),
    message(ASSIST_MSG, "assistant", true),
    frame("session.status", { sessionID: SES, status: { type: "idle" } }),
    frame("session.idle", { sessionID: SES }),
    { id: "h", type: "server.heartbeat", properties: {} },
  ]
}

function feed(events: StreamEvent[], start: StreamState = initialStream()) {
  return events.reduce(
    (acc, event) => {
      const result = reduceStream(acc.state, event)
      const marks = result.effects.filter((effect) => effect.type === "mark").map(() => acc.index)
      return {
        state: result.state,
        effects: [...acc.effects, ...result.effects],
        markAt: [...acc.markAt, ...marks],
        index: acc.index + 1,
      }
    },
    { state: start, effects: [] as StreamEffect[], markAt: [] as number[], index: 0 },
  )
}

const frames = (list: unknown[]): StreamEvent[] => list.map((item) => ({ type: "frame", frame: item }))

describe("stream reducer (U-ST-13, D5a-D5d, D9)", () => {
  test("U-ST-13 early session.created, user echo, reasoning, noise: only assistant text renders", () => {
    const all = capture()
    // Subscribe before send; Send begins the turn; session.created and a few more
    // frames arrive before POST /swarm/session returns (out of order, D5d).
    const early = all.slice(0, 6)
    const late = all.slice(6)
    const out = feed([
      { type: "beginTurn" },
      ...frames([frame("message.updated", { sessionID: OTHER, info: { id: "m", role: "assistant" } })]),
      ...frames(early),
      { type: "sessionKnown", sessionID: SES },
      ...frames(late),
    ])
    const result = replies(out.state)
    expect(result).toEqual([
      { messageID: ASSIST_MSG, text: "PONG", providerID: "gsp-ai-tail", modelID: "thinker", completed: true },
    ])
    // No user echo and no reasoning text anywhere in the rendered output.
    expect(result.map((reply) => reply.text).join("")).not.toContain("Reply with")
    expect(result.map((reply) => reply.text).join("")).not.toContain("user is simply")
    // Nothing from the early frames was lost: the user message seen before the
    // create response returned is known by role.
    expect(out.state.messages[USER_MSG]?.role).toBe("user")
    expect(out.state.buffer).toEqual([])
    expect(out.state.status).toBe("idle")
    expect(out.effects.filter((effect) => effect.type === "idle")).toHaveLength(1)
  })

  test("U-ST-13 / D9 firstText is marked once, at the first assistant text delta", () => {
    const all = capture()
    const events: StreamEvent[] = [{ type: "sessionKnown", sessionID: SES }, { type: "beginTurn" }, ...frames(all)]
    const out = feed(events)
    expect(out.markAt).toHaveLength(1)
    const firstAssistantText = events.findIndex(
      (event) =>
        event.type === "frame" &&
        JSON.stringify(event.frame).includes('"partID":"prt_text"') &&
        JSON.stringify(event.frame).includes("message.part.delta"),
    )
    expect(out.markAt[0]).toBe(firstAssistantText)
    expect(out.effects.find((effect) => effect.type === "mark")).toEqual({ type: "mark", name: "swarm.office.firstText" })
  })

  test("D5d buffered frames are replayed even when the id is learned late", () => {
    const out = feed([...frames(capture()), { type: "sessionKnown", sessionID: SES }])
    expect(replies(out.state)[0]?.text).toBe("PONG")
  })

  test("D5c unknown and other-session frames are ignored", () => {
    const start = feed([{ type: "sessionKnown", sessionID: SES }]).state
    const out = feed(
      frames([
        ...noise(),
        null,
        "garbage",
        { type: "message.part.delta" },
        frame("message.updated", { sessionID: OTHER, info: { id: "x", role: "assistant" } }),
        frame("message.part.delta", { sessionID: SES, messageID: "x", partID: "p", field: "metadata", delta: "zz" }),
      ]),
      start,
    )
    expect(Object.keys(out.state.messages)).toEqual([])
    expect(out.state.parts.p).toBeUndefined()
    expect(out.effects).toEqual([])
  })

  test("U-PR-06 reply = assistant text parts in order; role or type learned after the delta", () => {
    const out = feed([
      { type: "sessionKnown", sessionID: SES },
      { type: "beginTurn" },
      ...frames([
        delta("prt_a", ASSIST_MSG, "Hello "),
        part("prt_a", ASSIST_MSG, "text"),
        part("prt_tool", ASSIST_MSG, "tool"),
        delta("prt_tool", ASSIST_MSG, "TOOL"),
        part("prt_b", ASSIST_MSG, "text"),
        delta("prt_b", ASSIST_MSG, "world"),
      ]),
    ])
    expect(replies(out.state)).toEqual([])
    expect(out.markAt).toEqual([])
    const after = feed(frames([message(ASSIST_MSG, "assistant")]), out.state)
    expect(replies(after.state)[0]?.text).toBe("Hello world")
    expect(after.markAt).toEqual([0])
  })

  test("M8-02a ids __proto__ and constructor are plain keys (CP-M8 F-7)", () => {
    const out = feed([
      { type: "sessionKnown", sessionID: SES },
      { type: "beginTurn" },
      ...frames([
        // Unknown part id "constructor" before any update: must start from "", not Object.
        delta("constructor", "__proto__", "A"),
        message("__proto__", "assistant"),
        part("constructor", "__proto__", "text"),
        delta("constructor", "__proto__", "B"),
        message("constructor", "assistant"),
        part("__proto__", "constructor", "text", ""),
        delta("__proto__", "constructor", "C"),
        // A part id named like an Object.prototype member that was never announced.
        delta("toString", "constructor", "x"),
      ]),
    ])
    expect(replies(out.state)).toEqual([
      { messageID: "__proto__", text: "AB", providerID: "gsp-ai-tail", modelID: "thinker", completed: false },
      { messageID: "constructor", text: "C", providerID: "gsp-ai-tail", modelID: "thinker", completed: false },
    ])
    expect(Object.getPrototypeOf(out.state.messages)).toBeNull()
    expect(Object.getPrototypeOf(out.state.parts)).toBeNull()
    expect(Object.keys(out.state.messages)).toEqual(["__proto__", "constructor"])
    expect(new Map(Object.entries(out.state.parts)).get("toString")?.text).toBe("x")
    // Object.prototype was not touched.
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "role")).toBe(false)
    expect(({} as Record<string, unknown>).text).toBeUndefined()
    // Text becomes renderable when part "constructor" is typed `text` (event 4).
    expect(out.markAt).toEqual([4])
  })

  test("FR-42 session.error ends busy with office.error.generic; text kept", () => {
    const out = feed([
      { type: "sessionKnown", sessionID: SES },
      { type: "beginTurn" },
      ...frames([message(ASSIST_MSG, "assistant"), part("prt_a", ASSIST_MSG, "text"), delta("prt_a", ASSIST_MSG, "partial")]),
      ...frames([frame("session.error", { sessionID: SES, error: { name: "UnknownError" } })]),
    ])
    expect(out.state.status).toBe("error")
    expect(out.effects.at(-1)).toEqual({ type: "error", key: "office.error.generic" })
    expect(replies(out.state)[0]?.text).toBe("partial")
  })

  test("F-SG2-2 a Stop (MessageAbortedError) ends busy without an error banner; text kept", () => {
    const out = feed([
      { type: "sessionKnown", sessionID: SES },
      { type: "beginTurn" },
      ...frames([message(ASSIST_MSG, "assistant"), part("prt_a", ASSIST_MSG, "text"), delta("prt_a", ASSIST_MSG, "partial")]),
      ...frames([frame("session.error", { sessionID: SES, error: { name: "MessageAbortedError", data: {} } })]),
    ])
    expect(out.state.status).toBe("idle")
    expect(out.effects.some((e) => e.type === "error")).toBe(false)
    expect(replies(out.state)[0]?.text).toBe("partial")
  })

  test("a second turn marks firstText again only when new assistant text arrives", () => {
    const first = feed([{ type: "sessionKnown", sessionID: SES }, { type: "beginTurn" }, ...frames(capture())])
    const second = feed(
      [
        { type: "beginTurn" },
        ...frames([
          message("msg_a2", "assistant"),
          part("prt_t2", "msg_a2", "text"),
          delta("prt_t2", "msg_a2", "again"),
        ]),
      ],
      first.state,
    )
    expect(second.markAt).toEqual([3])
    expect(replies(second.state).map((reply) => reply.text)).toEqual(["PONG", "again"])
  })
})
