import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createRoot } from "solid-js"
import { createPromptAutonomy } from "@/components/prompt-input/autonomy"

// 1.2.7 row 58c (U-10, live finding F-5): the mode switched off from the CLI while a session window is open. The server
// now says so with `autonomy.mode.changed`; the composer's marker reads the server again when it hears it, with no
// reopen, no focus and no switch pressed in this window.

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

function fakeServer(start: { on: boolean; open?: number }) {
  const server = { on: start.on, open: start.open ?? 0, reads: 0 }
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })
    server.reads++
    if (path === "/autonomy/mode") return json({ on: server.on, externalChange: [], bypass: true })
    return json({
      rootID: "root",
      on: server.on,
      bypass: true,
      externalChange: [],
      open: server.open,
      lines: [],
      intact: true,
      problems: [],
      notFromHere: 0,
    })
  }
  return {
    server,
    client: createOpencodeClient({ baseUrl: "http://server.test", fetch: fetch as typeof globalThis.fetch }),
  }
}

const disposers: (() => void)[] = []
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()))

function mount(start: { on: boolean }, sessionID?: string) {
  const { server, client } = fakeServer(start)
  const emitter = createGlobalEmitter<Record<string, { properties: Record<string, unknown> }>>()
  return createRoot((dispose) => {
    disposers.push(dispose)
    const autonomy = createPromptAutonomy({
      sdk: () => ({ client, event: emitter }) as never,
      sessionID: () => sessionID,
      onChanged: () => {},
      onFailed: () => {},
      confirm: async () => true,
      language: () => "en",
    })
    return { server, autonomy, emitter }
  })
}

describe("58c: the marker follows a change made outside this window", () => {
  test("on, then switched off elsewhere: the marker goes once the server says so", async () => {
    const view = mount({ on: true }, "ses_1")
    await tick(5)
    expect(view.autonomy.on()).toBe(true)

    view.server.on = false
    view.emitter.emit("autonomy.mode.changed", { properties: { scope: "session", sessionID: "ses_1" } })
    await tick(300)
    expect(view.autonomy.on()).toBe(false)
  })

  test("off, then switched on elsewhere: the marker comes, a folder change counts too", async () => {
    const view = mount({ on: false }, "ses_1")
    await tick(5)
    expect(view.autonomy.on()).toBe(false)

    view.server.on = true
    view.emitter.emit("autonomy.mode.changed", { properties: { scope: "directory" } })
    await tick(300)
    expect(view.autonomy.on()).toBe(true)
  })

  test("a draft (no session yet) follows the folder", async () => {
    const view = mount({ on: true })
    await tick(5)
    expect(view.autonomy.on()).toBe(true)

    view.server.on = false
    view.emitter.emit("autonomy.mode.changed", { properties: { scope: "directory" } })
    await tick(300)
    expect(view.autonomy.on()).toBe(false)
  })

  test("a burst of notices reads the server once", async () => {
    const view = mount({ on: true }, "ses_1")
    await tick(5)
    const before = view.server.reads
    for (let i = 0; i < 5; i++) view.emitter.emit("autonomy.mode.changed", { properties: { scope: "directory" } })
    await tick(300)
    expect(view.server.reads - before).toBe(1)
  })
})
