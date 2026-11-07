// Row 127: the four mission control handlers against a fake ipcMain and fake windows (no module mocks; the file
// imports only electron types).
import { describe, expect, test } from "bun:test"
import type { IpcMainInvokeEvent } from "electron"
import { MISSION_CONTROL_IPC } from "../../preload/mission-control-channels"
import type { MissionControlPlatform } from "../../preload/types"
import { registerMissionControlHandlers, type MissionIpcDeps } from "./mission-ipc"

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
const RENDERER_URL = "oc://renderer/index.html"

function setup(client: MissionControlPlatform | undefined) {
  const handlers = new Map<string, Handler>()
  const logs: unknown[][] = []
  const sender = { mainFrame: { url: RENDERER_URL } }
  const win = { isDestroyed: () => false, webContents: sender }
  const deps: MissionIpcDeps = {
    ipcMain: { handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never,
    windowOf: (s) => (s === (sender as never) ? (win as never) : null),
    isRendererUrl: (url) => url === RENDERER_URL,
    client: () => client,
    log: (...a) => void logs.push(a),
  }
  registerMissionControlHandlers(deps)
  const event = (over: Partial<{ sender: object; senderFrame: object | null }> = {}) =>
    ({ sender, senderFrame: sender.mainFrame, ...over }) as unknown as IpcMainInvokeEvent
  return { handlers, logs, sender, event }
}

const recorder = () => {
  const calls: Array<[string, unknown]> = []
  const c: MissionControlPlatform = {
    list: async (i) => (calls.push(["list", i]), { ok: true, data: { items: [{ id: "m" }] as never } }),
    get: async (i) => (calls.push(["get", i]), { ok: false, code: "MISSION_NOT_FOUND", message: "x" }),
    answer: async (i) => (calls.push(["answer", i]), { ok: true, data: { decision: "U1", released: [] } }),
    instruct: async (i) => (calls.push(["instruct", i]), { ok: true, data: { seq: 1 } }),
  }
  return { c, calls }
}

describe("mission control ipc", () => {
  test("registers exactly the four channels of spec §3.1", () => {
    const { handlers } = setup(undefined)
    expect([...handlers.keys()].sort()).toEqual(["mission-control:answer", "mission-control:get", "mission-control:instruct", "mission-control:list"])
    expect(Object.values(MISSION_CONTROL_IPC).sort()).toEqual([...handlers.keys()].sort())
  })

  test("each channel goes to its own client method with the raw argument", async () => {
    const r = recorder()
    const { handlers, event } = setup(r.c)
    expect(await handlers.get(MISSION_CONTROL_IPC.list)!(event(), { directory: "/a" })).toEqual({ ok: true, data: { items: [{ id: "m" }] } })
    expect(await handlers.get(MISSION_CONTROL_IPC.get)!(event(), { mission: "m" })).toEqual({ ok: false, code: "MISSION_NOT_FOUND", message: "x" })
    await handlers.get(MISSION_CONTROL_IPC.answer)!(event(), { mission: "m", request: "D-1", option: "A" })
    await handlers.get(MISSION_CONTROL_IPC.instruct)!(event(), { mission: "m", text: "t" })
    expect(r.calls.map((c) => c[0])).toEqual(["list", "get", "answer", "instruct"])
  })

  test("host not running -> HOST_UNAVAILABLE", async () => {
    const { handlers, event } = setup(undefined)
    for (const ch of Object.values(MISSION_CONTROL_IPC))
      expect(await handlers.get(ch)!(event(), {})).toMatchObject({ ok: false, code: "HOST_UNAVAILABLE" })
  })

  test("foreign sender, sub-frame or non-renderer origin -> BAD_SENDER, no client call", async () => {
    const r = recorder()
    const { handlers, event, logs } = setup(r.c)
    const list = handlers.get(MISSION_CONTROL_IPC.list)!
    expect(await list(event({ sender: { mainFrame: { url: RENDERER_URL } } }), { directory: "/a" })).toMatchObject({ code: "BAD_SENDER" })
    expect(await list(event({ senderFrame: { url: RENDERER_URL } }), { directory: "/a" })).toMatchObject({ code: "BAD_SENDER" })
    expect(await list(event({ senderFrame: null }), { directory: "/a" })).toMatchObject({ code: "BAD_SENDER" })
    const s2 = setup(r.c)
    s2.sender.mainFrame.url = "https://evil.example/"
    expect(await s2.handlers.get(MISSION_CONTROL_IPC.list)!(s2.event(), { directory: "/a" })).toMatchObject({ code: "BAD_SENDER" })
    expect(r.calls).toHaveLength(0)
    expect(logs.length).toBeGreaterThan(0)
  })

  // Row 135 L2: get / answer / instruct only for a mission the same window listed for its project folder, and a get is
  // returned only when the mission's project folder is that folder.
  function scoped() {
    const calls: string[] = []
    const dirOf: Record<string, string> = { "2026-11-07_a": "/proj", "2026-11-07_b": "/proj", "2026-11-07_x": "/other" }
    const c: MissionControlPlatform = {
      list: async (i) => {
        calls.push(`list:${i.directory}`)
        const items = Object.keys(dirOf).filter((id) => dirOf[id] === i.directory).map((id) => ({ id }))
        return { ok: true, data: { items: items as never } }
      },
      get: async (i) => {
        calls.push(`get:${i.mission}`)
        return { ok: true, data: { mission: { id: i.mission, project: { dir: dirOf[i.mission] } } } as never }
      },
      answer: async (i) => (calls.push(`answer:${i.mission}`), { ok: true, data: { decision: "U1", released: [] } }),
      instruct: async (i) => (calls.push(`instruct:${i.mission}`), { ok: true, data: { seq: 1 } }),
    }
    return { c, calls, dirOf }
  }

  test("row 135 L2: a mission not listed for this window is refused before any host call", async () => {
    const r = scoped()
    const { handlers, event } = setup(r.c)
    const call = (ch: string, input: unknown) => handlers.get(ch)!(event(), input)
    // nothing listed yet
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-07_a" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    await call(MISSION_CONTROL_IPC.list, { directory: "/proj" })
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-07_a" })).toMatchObject({ ok: true })
    // a mission of another project, never listed by this window
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-07_x" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    expect(await call(MISSION_CONTROL_IPC.answer, { mission: "2026-11-07_x", request: "D-1", option: "A" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    expect(await call(MISSION_CONTROL_IPC.instruct, { mission: "2026-11-07_x", text: "go" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    expect(await call(MISSION_CONTROL_IPC.answer, { mission: "2026-11-07_b", request: "D-1", option: "A" })).toMatchObject({ ok: true })
    expect(await call(MISSION_CONTROL_IPC.instruct, { mission: "2026-11-07_b", text: "go" })).toMatchObject({ ok: true })
    expect(r.calls).toEqual(["list:/proj", "get:2026-11-07_a", "answer:2026-11-07_b", "instruct:2026-11-07_b"])
    // another window has its own scope
    const other = setup(r.c)
    expect(await other.handlers.get(MISSION_CONTROL_IPC.get)!(other.event(), { mission: "2026-11-07_a" })).toMatchObject({ code: "BAD_ARGUMENT" })
  })

  test("row 135 L2: a listed mission whose project folder changed is not returned; a new list replaces the scope", async () => {
    const r = scoped()
    const { handlers, event } = setup(r.c)
    const call = (ch: string, input: unknown) => handlers.get(ch)!(event(), input)
    await call(MISSION_CONTROL_IPC.list, { directory: "/proj" })
    r.dirOf["2026-11-07_a"] = "/other"
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-07_a" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    // the next list of /proj no longer has a: refused without a host call
    await call(MISSION_CONTROL_IPC.list, { directory: "/proj" })
    const before = r.calls.length
    expect(await call(MISSION_CONTROL_IPC.instruct, { mission: "2026-11-07_a", text: "go" })).toMatchObject({ code: "BAD_ARGUMENT" })
    expect(r.calls.length).toBe(before)
  })

  test("a throwing client becomes INTERNAL_ERROR (logged), never a rejection", async () => {
    const c = recorder().c
    c.list = async () => {
      throw new Error("boom")
    }
    const { handlers, event, logs } = setup(c)
    expect(await handlers.get(MISSION_CONTROL_IPC.list)!(event(), { directory: "/a" })).toMatchObject({ ok: false, code: "INTERNAL_ERROR" })
    expect(JSON.stringify(logs)).toContain("boom")
  })
})
