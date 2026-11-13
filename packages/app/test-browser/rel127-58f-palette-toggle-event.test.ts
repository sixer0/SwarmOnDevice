import { afterEach, describe, expect, test } from "bun:test"
import { createGlobalEmitter } from "@solid-primitives/event-bus"
import { createRoot } from "solid-js"
import { createAutonomousToggle } from "@/components/settings-v2/general-controllers"

// 1.2.7 row 58f (U-10): the command palette's autonomy toggle keeps its own state. A mode changed from the CLI used to
// reach it only on a dialog change; now the server's `autonomy.mode.changed` makes it read the server again.

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const directory = "/work/proj"

const disposers: (() => void)[] = []
afterEach(() => disposers.splice(0).forEach((dispose) => dispose()))

function mount(start: boolean) {
  const server = { on: start, reads: 0 }
  const emitter = createGlobalEmitter<Record<string, { properties: Record<string, unknown> }>>()
  const controller = createRoot((dispose) => {
    disposers.push(dispose)
    return createAutonomousToggle({
      scope: () => ({ sessionID: "ses_a", directory }),
      read: async () => {
        server.reads++
        return { on: server.on, bypass: true }
      },
      write: async () => ({ on: server.on, bypass: true }),
      changed: () => {},
      failed: () => {},
      event: () => emitter as never,
    })
  })
  return { server, emitter, controller }
}

describe("row 58f: palette toggle follows autonomy.mode.changed", () => {
  test("the toggle's state updates when the event arrives", async () => {
    const { server, emitter, controller } = mount(true)
    await tick()
    expect(controller.accepting()).toBe(true)

    server.on = false
    emitter.emit("autonomy.mode.changed", { properties: { scope: "folder" } })
    await tick()
    expect(controller.accepting()).toBe(false)

    server.on = true
    emitter.emit("autonomy.mode.changed", { properties: { scope: "session", sessionID: "ses_a" } })
    await tick()
    expect(controller.accepting()).toBe(true)
  })

  test("without an event source nothing changes until the next read", async () => {
    const { server, controller } = mount(true)
    await tick()
    server.on = false
    await tick()
    expect(controller.accepting()).toBe(true)
  })
})
