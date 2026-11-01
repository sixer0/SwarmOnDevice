import { afterEach, describe, expect, test } from "bun:test"
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createRoot, createSignal } from "solid-js"
import { AUTONOMY_CHANGED, createPromptAutonomy } from "@/components/prompt-input/autonomy"

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// The server's side of the wire: every assertion below is about what crossed it, and what the composer did with it.
function fakeServer(start: { on?: boolean; open?: number } = {}) {
  const server = {
    on: start.on ?? false,
    open: start.open ?? 0,
    failWrite: false,
    failRead: false,
    reads: [] as string[],
    writes: [] as Record<string, unknown>[],
  }
  const fetch = async (request: Request) => {
    const path = new URL(request.url).pathname
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
    if (request.method === "PUT") {
      if (server.failWrite) return json({ name: "AutonomyWriteError", data: { message: "no" } }, 500)
      const body = await request.json()
      server.writes.push(body)
      server.on = body.on
      return json({ on: server.on, externalChange: [] })
    }
    server.reads.push(path)
    if (server.failRead) return json({ name: "NotFoundError", data: { message: "no" } }, 404)
    if (path === "/autonomy/mode") return json({ on: server.on, externalChange: [] })
    return json({
      rootID: "root",
      on: server.on,
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
    client: createOpencodeClient({
      baseUrl: "http://server.test",
      fetch: fetch as typeof globalThis.fetch,
      throwOnError: true,
    }),
  }
}

function mount(start: { on?: boolean; open?: number } = {}, sessionID?: string) {
  const { server, client } = fakeServer(start)
  const emitter = createGlobalEmitter<Record<string, { properties: Record<string, unknown> }>>()
  const changed: boolean[] = []
  let failed = 0
  const [session, setSession] = createSignal(sessionID)
  return createRoot((dispose) => {
    disposers.push(dispose)
    const autonomy = createPromptAutonomy({
      sdk: () => ({ client, event: emitter }) as never,
      sessionID: session,
      onChanged: (on) => changed.push(on),
      onFailed: () => failed++,
    })
    return { server, autonomy, emitter, changed, failed: () => failed, setSession }
  })
}

const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
})

describe("autonomous mode in the composer", () => {
  test("in a session the click changes that session on the server, and the state comes back from it", async () => {
    const view = mount({ open: 2 }, "ses_1")
    await tick(5)
    expect(view.autonomy.on()).toBe(false)
    expect(view.server.reads).toEqual(["/session/ses_1/autonomy"])

    await view.autonomy.toggle()

    expect(view.server.writes).toEqual([{ on: true, sessionID: "ses_1" }])
    expect(view.autonomy.on()).toBe(true)
    expect(view.autonomy.waiting()).toBe(2)
    expect(view.changed).toEqual([true])

    await view.autonomy.toggle()
    expect(view.server.writes.at(-1)).toEqual({ on: false, sessionID: "ses_1" })
    expect(view.autonomy.on()).toBe(false)
    expect(view.changed).toEqual([true, false])
  })

  test("on a draft the click changes the folder, because there is no session to change", async () => {
    const view = mount()
    await tick(5)
    expect(view.server.reads).toEqual(["/autonomy/mode"])

    await view.autonomy.toggle()

    expect(view.server.writes).toEqual([{ on: true }])
    expect(view.autonomy.on()).toBe(true)
    expect(view.autonomy.waiting()).toBe(0)
  })

  test("a draft that becomes a session reads the session, and never shows the previous answer as its own", async () => {
    const view = mount({ on: true, open: 3 })
    await tick(5)
    expect(view.autonomy.waiting()).toBe(0)

    view.setSession("ses_1")
    expect(view.autonomy.on()).toBeUndefined()
    await tick(5)
    expect(view.autonomy.on()).toBe(true)
    expect(view.autonomy.waiting()).toBe(3)
  })

  test("a failed save says so and shows what the server still holds", async () => {
    const view = mount({}, "ses_1")
    await tick(5)
    view.server.failWrite = true

    await view.autonomy.toggle()

    expect(view.failed()).toBe(1)
    expect(view.changed).toEqual([])
    expect(view.autonomy.on()).toBe(false)
  })

  test("nothing is claimed before the server has answered, or when it never does", async () => {
    const { client, server } = fakeServer()
    server.failRead = true
    const emitter = createGlobalEmitter()
    const autonomy = createRoot((dispose) => {
      disposers.push(dispose)
      return createPromptAutonomy({
        sdk: () => ({ client, event: emitter }) as never,
        sessionID: () => "ses_1",
        onChanged: () => {},
        onFailed: () => {},
      })
    })
    expect(autonomy.on()).toBeUndefined()
    await tick(5)
    expect(autonomy.on()).toBeUndefined()

    await autonomy.toggle()
    expect(server.writes).toEqual([])
  })

  test("a failed refresh keeps the mode known, so the marker does not say it went off", async () => {
    const view = mount({ on: true, open: 1 }, "ses_1")
    await tick(5)
    view.server.failRead = true

    window.dispatchEvent(new Event(AUTONOMY_CHANGED))
    await tick(300)

    expect(view.server.reads.length).toBe(2)
    expect(view.autonomy.on()).toBe(true)
    expect(view.autonomy.waiting()).toBe(1)
  })

  test("the count follows held decisions from the server, and a burst reads it once", async () => {
    const view = mount({ on: true, open: 0 }, "ses_1")
    await tick(5)
    const before = view.server.reads.length

    view.emitter.emit("permission.asked", { properties: {} })
    await tick(300)
    expect(view.server.reads.length).toBe(before)

    view.server.open = 2
    view.emitter.emit("permission.asked", { properties: { deferred: true } })
    await tick(20)
    view.emitter.emit("permission.asked", { properties: { deferred: true } })
    await tick(300)
    expect(view.server.reads.length).toBe(before + 1)
    expect(view.autonomy.waiting()).toBe(2)

    view.server.open = 1
    view.emitter.emit("permission.replied", { properties: {} })
    await tick(300)
    expect(view.autonomy.waiting()).toBe(1)

    view.server.open = 0
    view.emitter.emit("autonomy.blocked", { properties: {} })
    await tick(300)
    expect(view.autonomy.waiting()).toBe(0)
  })

  test("a change made away from the composer reaches it", async () => {
    const view = mount({}, "ses_1")
    await tick(5)
    view.server.on = true

    window.dispatchEvent(new Event(AUTONOMY_CHANGED))
    await tick(300)

    expect(view.autonomy.on()).toBe(true)
  })
})

// The tray needs Solid's JSX compiler, and modules are shared across a test process: run alone, or it would see the
// components another file already compiled for React.
test("the tray renders the mode", async () => {
  const run = Bun.spawn(
    [
      process.execPath,
      "test",
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "./test-browser/prompt-autonomy-tray.render.ts",
    ],
    { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" },
  )
  const [output, code] = await Promise.all([new Response(run.stderr).text(), run.exited])
  if (code !== 0) throw new Error(output)
  expect(output).toContain(" 0 fail")
}, 30_000)
