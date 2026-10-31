import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { requestGoto } from "../../src/fleet/registry"
import { createFleetState, type FleetStateInput } from "../../src/fleet/state"

let dir: string
let stops: (() => void)[] = []
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "fleet-state-"))
})
afterEach(() => {
  stops.forEach((stop) => stop())
  stops = []
  rmSync(dir, { recursive: true, force: true })
})

const session = (id: string) => ({ id, title: id, directory: "/w", time: { created: 1, updated: Date.now() } })
const reply = {
  info: { id: "m", role: "assistant", time: { created: 1, completed: 2 } },
  parts: [{ type: "text", text: "done" }],
}

/** A real client boundary: only what the server would answer, nothing about how the state uses it. */
function harness(server: { instances: unknown[]; list: unknown[]; fail?: boolean }) {
  const handlers = new Map<string, (event: unknown) => void>()
  let blocked = 0
  const gotos: string[] = []
  const input = {
    directory: dir,
    state: { path: { directory: "/w" } } as TuiPluginApi["state"],
    event: {
      on(type: string, handler: (event: unknown) => void) {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
    } as unknown as TuiPluginApi["event"],
    client: {
      global: {
        agents: async () => {
          if (server.fail) throw new Error("connection refused")
          return { data: { instances: server.instances } }
        },
      },
      session: {
        list: async () => ({ data: server.list }),
        get: async (query: { sessionID: string }) => ({ data: session(query.sessionID) }),
        messages: async () => ({ data: [reply] }),
      },
    } as unknown as TuiPluginApi["client"],
    onNewlyBlocked: () => (blocked += 1),
    onGoto: (id: string) => gotos.push(id),
  } satisfies FleetStateInput
  const fleet = createFleetState(input)
  stops.push(() => fleet.dispose())
  return { fleet, blocked: () => blocked, gotos, emit: (type: string, event: unknown) => handlers.get(type)?.(event) }
}

const settle = (check: () => boolean) =>
  Bun.sleep(1).then(async () => {
    const end = Date.now() + 3000
    while (!check() && Date.now() < end) await Bun.sleep(5)
    expect(check()).toBe(true)
  })

const published = () => JSON.parse(readFileSync(path.join(dir, `${process.pid}.json`), "utf8"))
const permission = (id: string, sessionID: string) => ({
  id,
  sessionID,
  permission: "bash",
  patterns: ["rm x"],
  metadata: {},
  always: [],
})

test("a session only listed from the shared database shows here but is not published as this pane's", async () => {
  const instance = { directory: "/w", status: { mine: { type: "busy" } }, permission: [], question: [] }
  const { fleet } = harness({ instances: [instance], list: [session("mine"), session("other-pane")] })
  await settle(() => fleet.rows().length === 2)
  expect(published().agents.map((agent: { sessionID: string }) => agent.sessionID)).toEqual(["mine"])
})

test("only a request that appears after the first load counts as newly blocked", async () => {
  const instance = { directory: "/w", status: {}, permission: [permission("p1", "s1")], question: [] }
  const server = { instances: [instance], list: [session("s1")] }
  const { fleet, blocked, emit } = harness(server)
  await settle(() => fleet.rows().length === 1)
  expect(blocked()).toBe(0)
  instance.permission.push(permission("p2", "s2"))
  emit("permission.asked", { properties: { sessionID: "s2" } })
  await settle(() => blocked() === 1)
})

test("an answered request leaves at once and comes back if the answer fails", async () => {
  const instance = { directory: "/w", status: {}, permission: [permission("p1", "s1")], question: [] }
  const { fleet } = harness({ instances: [instance], list: [session("s1")] })
  await settle(() => fleet.rows().length === 1)
  fleet.hide("p1")
  expect(fleet.rows()).toEqual([])
  fleet.unhide("p1")
  expect(fleet.rows().length).toBe(1)
})

test("a server failure is reported without losing the last known rows, and clears on recovery", async () => {
  const instance = { directory: "/w", status: { s1: { type: "busy" } }, permission: [], question: [] }
  const server = { instances: [instance], list: [session("s1")], fail: false }
  const { fleet } = harness(server)
  await settle(() => fleet.rows().length === 1)
  server.fail = true
  fleet.refresh()
  await settle(() => fleet.error() === "connection refused")
  expect(fleet.rows().length).toBe(1)
  server.fail = false
  fleet.refresh()
  await settle(() => fleet.error() === undefined)
})

test("another Swarm can ask this one to show a session", async () => {
  const { gotos } = harness({ instances: [], list: [] })
  requestGoto(dir, process.pid, "ses_9")
  await settle(() => gotos.includes("ses_9"))
})
