import { describe, expect, test } from "bun:test"
import { replies } from "../state/stream"
import { createOfficeApi } from "./client"
import { createConversation } from "./conversation"
import { fakeBridge, keysDeep, session, type Route } from "./fake-bridge"
import type { PerfMarkName } from "./marks"

// Frames modelled on test/evidence/m0/14_s4_capture_thinker.txt (run 1), the same shapes as
// the U-ST-13 reducer fixture in src/state/stream.test.ts, here replayed over the wire.
const SES = "ses_e1d246b1dffeMlpjURmi68LeBB"
const USER_MSG = "msg_user"
const ASSIST_MSG = "msg_assistant"
const TOKEN = "swo1_" + "b".repeat(43)

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
  ...Array.from({ length: 45 }, () => ({ id: "n", type: "plugin.added", properties: { name: "x" } })),
  { id: "n", type: "catalog.updated", properties: {} },
  { id: "n", type: "reference.updated", properties: {} },
  { id: "n", type: "integration.updated", properties: {} },
]
const REASONING = ["The", " user is simply", " asking me to reply with one word", " PONG, so", " I will answer", " with it."]

// Frames of the new session that arrive before POST /swarm/session returns (D5d).
const early = () => [
  frame("session.created", { sessionID: SES, info: { id: SES } }),
  frame("session.updated", { sessionID: SES, info: { id: SES } }),
  message(USER_MSG, "user"),
  part("prt_user", USER_MSG, "text", "Reply with the word PONG."),
  frame("session.status", { sessionID: SES, status: { type: "busy" } }),
]
const late = () => [
  message(ASSIST_MSG, "assistant"),
  message(USER_MSG, "user"),
  ...noise(),
  frame("message.updated", { sessionID: "ses_other", info: { id: "x", role: "assistant" } }),
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
async function until(check: () => boolean) {
  for (const _ of Array.from({ length: 200 })) {
    if (check()) return
    await tick()
  }
  throw new Error("condition not reached")
}

function setup(options: { handler?: (path: string, method: string) => Route | undefined | Promise<Route | undefined>; eventStatus?: number; eventFails?: boolean } = {}) {
  const marks: { name: PerfMarkName; text: string; requests: number }[] = []
  const effects: string[] = []
  const bridge = fakeBridge({
    eventStatus: options.eventStatus,
    eventFails: options.eventFails,
    handler: (request) => options.handler?.(request.path, request.method),
  })
  const api = createOfficeApi({ token: () => TOKEN, fetch: bridge.fetch })
  const conversation = createConversation({
    api,
    mark: (name) =>
      marks.push({
        name,
        text: replies(conversation.state())
          .map((reply) => reply.text)
          .join(""),
        requests: bridge.requests.length,
      }),
    onEffect: (effect) => effects.push(effect.type),
  })
  return { bridge, api, conversation, marks, effects }
}

const PARTS = [{ type: "text" as const, text: "Reply with the word PONG." }]

describe("conversation: subscribe before send, D5a-D5d, D9 (U-ST-13 over the wire)", () => {
  test("U-ST-13 replay: early session.created buffered, only assistant text rendered, firstText at the first assistant text delta", async () => {
    const ref: { push?: (frame: unknown) => void; seen?: () => number } = {}
    const ctx = setup({
      // The create call returns only after the early frames reached the pane (D5d).
      handler: async (path, method) => {
        if (method !== "POST" || path !== "/swarm/session") return undefined
        for (const item of early()) ref.push?.(item)
        // 3 of the 5 early frames are consumed types (session.created, message.updated,
        // message.part.updated) and are buffered; the other two are ignored (D5c).
        await until(() => (ref.seen?.() ?? 0) >= 3)
        return { status: 200, body: session(SES) }
      },
    })
    ref.push = ctx.bridge.push
    ref.seen = () => ctx.conversation.state().buffer.length

    const sending = ctx.conversation.send({ title: "PONG", host: "Word", parts: PARTS })
    await ctx.bridge.streamOpened
    ctx.bridge.push({ id: "c", type: "server.connected", properties: {} })
    const result = await sending

    expect(result).toEqual({ ok: true, sessionID: SES, created: true })
    // Subscribe before send: /swarm/event is the first request, before create and prompt.
    expect(ctx.bridge.requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "GET /swarm/event",
      "POST /swarm/session",
      `POST /swarm/session/${SES}/prompt_async`,
    ])
    expect(ctx.bridge.requests[0]!.headers["x-swarm-office-token"]).toBe(TOKEN)
    expect(ctx.bridge.requests[0]!.headers["x-swarm-office"]).toBe("1")
    // The early frames were buffered, then replayed: the user message is known by role.
    expect(ctx.conversation.state().messages[USER_MSG]?.role).toBe("user")
    expect(ctx.conversation.state().buffer).toEqual([])
    expect(ctx.conversation.state().status).toBe("busy")

    for (const item of late()) ctx.bridge.push(item)
    await until(() => ctx.conversation.state().status === "idle")

    const output = replies(ctx.conversation.state())
    expect(output).toEqual([
      { messageID: ASSIST_MSG, text: "PONG", providerID: "gsp-ai-tail", modelID: "thinker", completed: true },
    ])
    expect(output.map((reply) => reply.text).join("")).not.toContain("Reply with")
    expect(output.map((reply) => reply.text).join("")).not.toContain("user is simply")

    // REG §8.5: request is marked before prompt_async left (2 requests recorded at that
    // point), firstText exactly once, when the first assistant text delta ("PO") rendered.
    expect(ctx.marks).toEqual([
      { name: "swarm.office.request", text: "", requests: 2 },
      { name: "swarm.office.firstText", text: "PO", requests: 3 },
    ])
    expect(ctx.effects).toEqual(["idle"])
    ctx.conversation.close()
  })

  test("second send on the known session: no create, beginTurn again, firstText again", async () => {
    const ctx = setup()
    ctx.conversation.select(SES)
    const first = ctx.conversation.send({ title: "x", host: "Excel", parts: PARTS })
    await ctx.bridge.streamOpened
    ctx.bridge.push({ id: "c", type: "server.connected", properties: {} })
    expect(await first).toEqual({ ok: true, sessionID: SES, created: false })
    for (const item of [...early(), ...late()]) ctx.bridge.push(item)
    await until(() => ctx.conversation.state().status === "idle")

    const second = await ctx.conversation.send({ title: "x", host: "Excel", parts: PARTS })
    expect(second).toEqual({ ok: true, sessionID: SES, created: false })
    for (const item of [message("msg_a2", "assistant"), part("prt_t2", "msg_a2", "text"), delta("prt_t2", "msg_a2", "again")]) {
      ctx.bridge.push(item)
    }
    await until(() => ctx.marks.filter((mark) => mark.name === "swarm.office.firstText").length === 2)
    // One stream for both turns; never a create call.
    expect(ctx.bridge.requests.filter((request) => request.path === "/swarm/event")).toHaveLength(1)
    expect(ctx.bridge.requests.filter((request) => request.method === "POST" && request.path === "/swarm/session")).toHaveLength(0)
    expect(ctx.marks.map((mark) => mark.name)).toEqual([
      "swarm.office.request",
      "swarm.office.firstText",
      "swarm.office.request",
      "swarm.office.firstText",
    ])
    ctx.conversation.close()
  })

  test("C30: nothing the conversation sends carries `system` or `tools`", async () => {
    const ctx = setup()
    const sending = ctx.conversation.send({ title: "system", host: "Word", parts: [{ type: "text", text: "tools system" }] })
    await ctx.bridge.streamOpened
    ctx.bridge.push({ id: "c", type: "server.connected", properties: {} })
    await sending
    await ctx.conversation.abort()
    const bodies = ctx.bridge.requests.map((request) => request.body)
    expect(bodies).toEqual([undefined, { title: "system", host: "Word" }, { parts: [{ type: "text", text: "tools system" }] }, undefined])
    const keys = bodies.flatMap(keysDeep)
    expect(keys).not.toContain("system")
    expect(keys).not.toContain("tools")
    ctx.conversation.close()
  })
})

describe("conversation: failures", () => {
  test("stream refused (429 STREAM_LIMIT): nothing is sent", async () => {
    const ctx = setup({ eventStatus: 429 })
    const result = await ctx.conversation.send({ title: "x", host: "Word", parts: PARTS })
    expect(result).toEqual({ ok: false, stage: "stream", status: 429 })
    expect(ctx.bridge.requests.map((request) => request.path)).toEqual(["/swarm/event"])
  })

  test("stream network failure: status 0, nothing sent", async () => {
    const ctx = setup({ eventFails: true })
    expect(await ctx.conversation.send({ title: "x", host: "Word", parts: PARTS })).toEqual({ ok: false, stage: "stream", status: 0 })
    expect(ctx.bridge.requests).toHaveLength(1)
  })

  test("create fails: stage create, not busy, no prompt", async () => {
    const ctx = setup({
      handler: (path, method) => (method === "POST" && path === "/swarm/session" ? { status: 401, body: { error: "TOKEN_INVALID" } } : undefined),
    })
    const sending = ctx.conversation.send({ title: "x", host: "Word", parts: PARTS })
    await ctx.bridge.streamOpened
    ctx.bridge.push({ id: "c", type: "server.connected", properties: {} })
    expect(await sending).toEqual({ ok: false, stage: "create", status: 401, code: "TOKEN_INVALID" })
    expect(ctx.conversation.state().status).toBe("idle")
    expect(ctx.bridge.requests.some((request) => request.path.endsWith("/prompt_async"))).toBe(false)
    ctx.conversation.close()
  })

  test("prompt fails (404 for a stored session): stage prompt, not busy, no firstText pending", async () => {
    const ctx = setup({ handler: (path) => (path.endsWith("/prompt_async") ? { status: 404, body: { error: "ROUTE_NOT_ALLOWED" } } : undefined) })
    ctx.conversation.select("ses_gone")
    const sending = ctx.conversation.send({ title: "x", host: "Word", parts: PARTS })
    await ctx.bridge.streamOpened
    ctx.bridge.push({ id: "c", type: "server.connected", properties: {} })
    expect(await sending).toEqual({ ok: false, stage: "prompt", status: 404, code: "ROUTE_NOT_ALLOWED" })
    expect(ctx.conversation.state().status).toBe("idle")
    expect(ctx.conversation.state().firstText).toBe(true)
    ctx.conversation.close()
  })

  test("stream end reports onClose (T16 input); close() by the pane does not", async () => {
    const closes: unknown[] = []
    const bridge = fakeBridge()
    const api = createOfficeApi({ token: () => TOKEN, fetch: bridge.fetch })
    const conversation = createConversation({ api, mark: () => {}, onClose: (close) => closes.push(close) })
    const ready = conversation.connect()
    await bridge.streamOpened
    bridge.push({ id: "c", type: "server.connected", properties: {} })
    expect(await ready).toBe(true)
    bridge.end()
    await until(() => closes.length === 1)
    expect(closes).toEqual([{ status: 200, aborted: false }])

    const again = conversation.connect()
    await until(() => bridge.requests.length === 2)
    bridge.push({ id: "c", type: "server.connected", properties: {} })
    expect(await again).toBe(true)
    conversation.close()
    await tick()
    expect(closes).toHaveLength(1)
  })

  test("abort without a session sends nothing; with one posts P7", async () => {
    const ctx = setup()
    expect(await ctx.conversation.abort()).toEqual({ ok: false, status: 0 })
    ctx.conversation.select(SES)
    expect(await ctx.conversation.abort()).toMatchObject({ ok: true, status: 200 })
    expect(ctx.bridge.requests.map((request) => `${request.method} ${request.path}`)).toEqual([`POST /swarm/session/${SES}/abort`])
  })
})
