// Row 183 (decision L36): Mission Control lists by {directory, sessions?}: the session directory (row 181: that folder
// or one inside it) plus the missions linked to the current session or its subagent sessions. Here, without a host:
// - parseListInput: `sessions` is optional; at most 50 opencode session ids (ses_ + 1-64 alphanumerics), duplicates
//   dropped; anything else is BAD_ARGUMENT with no host call;
// - the client passes `sessions` to studio_mission_list only when there are any (the arguments are otherwise as before);
// - the ipc scope (row 135 L2): a listed mission is returned by get when its project folder is the listed folder or a
//   folder inside it (the row 181 shape), or when it is linked (client swarm) to one of the listed sessions.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMainInvokeEvent } from "electron"
import { MISSION_CONTROL_IPC } from "../../preload/mission-control-channels"
import type { MissionControlPlatform } from "../../preload/types"
import { createMissionControlClient, MISSION_LIST_SESSIONS_MAX, parseListInput, type FetchLike } from "./mission-client"
import { registerMissionControlHandlers, withinDirectory, type MissionIpcDeps } from "./mission-ipc"

const SCRATCH = join(tmpdir(), "row183")
mkdirSync(SCRATCH, { recursive: true })
const dir = mkdtempSync(join(SCRATCH, "unit-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const SESSION_DIR = "/Users/gsp-budi/Documents/Research"
const MAIN_SES = "ses_e46061bebffe0123456789AbCd"
const CHILD_SES = "ses_e46039e30ffe0123456789AbCd"

describe("row 183: parseListInput takes optional sessions", () => {
  test("directory alone is unchanged; sessions are kept in order without duplicates", () => {
    expect(parseListInput({ directory: SESSION_DIR })).toEqual({ ok: true, value: { directory: SESSION_DIR } })
    expect(parseListInput({ directory: SESSION_DIR, sessions: undefined })).toEqual({ ok: true, value: { directory: SESSION_DIR } })
    expect(parseListInput({ directory: SESSION_DIR, sessions: [MAIN_SES, CHILD_SES, MAIN_SES] })).toEqual({
      ok: true,
      value: { directory: SESSION_DIR, sessions: [MAIN_SES, CHILD_SES] },
    })
    expect(parseListInput({ directory: SESSION_DIR, sessions: [] })).toEqual({ ok: true, value: { directory: SESSION_DIR, sessions: [] } })
  })

  const many = Array.from({ length: MISSION_LIST_SESSIONS_MAX + 1 }, (_, i) => `ses_${String(i).padStart(26, "0")}`)
  const bad: unknown[] = [
    "ses_x",
    { 0: MAIN_SES },
    many,
    [""],
    ["ses_"],
    ["msg_e46061bebffe0123456789AbCd"],
    ["ses_../../etc"],
    ["ses_a b"],
    [`ses_${"a".repeat(65)}`],
    [42],
    [null],
  ]
  test.each(bad.map((v) => [JSON.stringify(v).slice(0, 60), v]))("sessions %s -> BAD_ARGUMENT", (_n, sessions) => {
    expect(parseListInput({ directory: SESSION_DIR, sessions })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
  })

  test("exactly the maximum is accepted; the directory rules still apply with sessions", () => {
    expect(parseListInput({ directory: SESSION_DIR, sessions: many.slice(0, MISSION_LIST_SESSIONS_MAX) }).ok).toBe(true)
    expect(parseListInput({ directory: "rel", sessions: [MAIN_SES] })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    expect(parseListInput({ sessions: [MAIN_SES] })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
  })
})

describe("row 183: the client passes sessions to studio_mission_list", () => {
  function fakeHost() {
    const args: Array<Record<string, unknown>> = []
    let n = 0
    const fetch: FetchLike = async (_url, init) => {
      const body = JSON.parse(init.body ?? "{}") as Record<string, any>
      if (body.method === "initialize") {
        const msg = { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake" }, capabilities: {} } }
        return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json", "mcp-session-id": `s${++n}` } })
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      args.push(body.params.arguments)
      const msg = { jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "x" }], structuredContent: { ok: true, tool: body.params.name, items: [], nextCursor: null } } }
      return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } })
    }
    return { fetch, args }
  }

  test("sessions present -> passed; absent or empty -> the arguments of before", async () => {
    const host = fakeHost()
    const c = createMissionControlClient({ url: "http://127.0.0.1:47999/mcp", token: "f".repeat(64), callerCwd: join(dir, "mc"), fetch: host.fetch })
    expect((await c.list({ directory: SESSION_DIR, sessions: [MAIN_SES, CHILD_SES] })).ok).toBe(true)
    expect((await c.list({ directory: SESSION_DIR })).ok).toBe(true)
    expect((await c.list({ directory: SESSION_DIR, sessions: [] })).ok).toBe(true)
    const base = { projectDir: SESSION_DIR, status: ["draft", "approved", "running", "paused", "done"], take: 20 }
    expect(host.args).toEqual([{ ...base, sessions: [MAIN_SES, CHILD_SES] }, base, base])
    // a bad sessions value never reaches the host
    expect(await c.list({ directory: SESSION_DIR, sessions: ["nope"] } as never)).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    expect(host.args).toHaveLength(3)
  })
})

describe("row 183: the ipc get scope accepts a subfolder and a linked session", () => {
  type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  const RENDERER_URL = "oc://renderer/index.html"
  const missions: Record<string, { dir: string; sessions: Array<{ client: string; ref: string }>; listed: boolean }> = {
    "2026-11-08_live-sub": { dir: `${SESSION_DIR}/gsp-situational-awareness-system`, sessions: [{ client: "swarm", ref: CHILD_SES }], listed: true },
    "2026-11-08_elsewhere": { dir: "/elsewhere/one", sessions: [{ client: "swarm", ref: MAIN_SES }], listed: true },
    "2026-11-08_claude": { dir: "/elsewhere/two", sessions: [{ client: "claude", ref: CHILD_SES }], listed: true },
    "2026-11-08_sibling": { dir: `${SESSION_DIR}x/sub`, sessions: [], listed: true },
  }
  function setup() {
    const handlers = new Map<string, Handler>()
    const sender = { mainFrame: { url: RENDERER_URL } }
    const win = { isDestroyed: () => false, webContents: sender }
    const client: MissionControlPlatform = {
      list: async () => ({ ok: true, data: { items: Object.keys(missions).filter((id) => missions[id].listed).map((id) => ({ id })) as never } }),
      get: async (i) => ({ ok: true, data: { mission: { id: i.mission, project: { dir: missions[i.mission].dir }, sessions: missions[i.mission].sessions } } as never }),
      answer: async () => ({ ok: true, data: { decision: "U1", released: [] } }),
      instruct: async () => ({ ok: true, data: { seq: 1 } }),
    }
    const deps: MissionIpcDeps = {
      ipcMain: { handle: (channel: string, h: Handler) => void handlers.set(channel, h) } as never,
      windowOf: (s) => (s === (sender as never) ? (win as never) : null),
      isRendererUrl: (url) => url === RENDERER_URL,
      client: () => client,
      log: () => {},
    }
    registerMissionControlHandlers(deps)
    const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
    return (ch: string, input: unknown) => handlers.get(ch)!(event, input)
  }

  test("live shape: listed by directory + sessions; get returns the subfolder mission and the linked one", async () => {
    const call = setup()
    await call(MISSION_CONTROL_IPC.list, { directory: SESSION_DIR, sessions: [MAIN_SES, CHILD_SES] })
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-08_live-sub" })).toMatchObject({ ok: true })
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-08_elsewhere" })).toMatchObject({ ok: true })
    // a link of another client is not this window's session; /Researchx is not inside /Research
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-08_claude" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-08_sibling" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
  })

  test("listed without sessions: a session-linked mission elsewhere is not returned; the subfolder one is", async () => {
    const call = setup()
    await call(MISSION_CONTROL_IPC.list, { directory: SESSION_DIR })
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-08_live-sub" })).toMatchObject({ ok: true })
    expect(await call(MISSION_CONTROL_IPC.get, { mission: "2026-11-08_elsewhere" })).toMatchObject({ ok: false, code: "BAD_ARGUMENT" })
  })
})

describe("row 185 (S186-01): the window access check uses the store's narrow-folder rule", () => {
  const HOME = "/Users/someone"
  test("'/', the home folder and ~/Documents match exactly only", () => {
    expect(withinDirectory("/Users/x/ProjB", "/", HOME)).toBe(false)
    expect(withinDirectory("/", "/", HOME)).toBe(true)
    expect(withinDirectory(`${HOME}/ProjB`, HOME, HOME)).toBe(false)
    expect(withinDirectory(`${HOME}/ProjB`, `${HOME}/`, HOME)).toBe(false)
    expect(withinDirectory(HOME, `${HOME}/`, HOME)).toBe(true)
    expect(withinDirectory(`${HOME}/Documents/ProjB`, `${HOME}/Documents`, HOME)).toBe(false)
    expect(withinDirectory(`${HOME}/Documents`, `${HOME}/Documents`, HOME)).toBe(true)
  })

  test("a 4-segment folder keeps the subfolder rule; traversal and siblings still refused", () => {
    const dir = "/Users/gsp-budi/Documents/Research"
    expect(withinDirectory(`${dir}/gsp-situational-awareness-system`, dir, HOME)).toBe(true)
    expect(withinDirectory(`${dir}x/sub`, dir, HOME)).toBe(false)
    expect(withinDirectory(`${dir}/../../etc`, dir, HOME)).toBe(false)
    // the real home folder (pinned under TMPDIR in tests) is exact only, whatever its depth
    expect(withinDirectory(`${homedir()}/sub`, homedir())).toBe(false)
    expect(withinDirectory(`${homedir()}/Documents/sub`, `${homedir()}/Documents`)).toBe(false)
    // other suites re-point HOME (sometimes to a shallow folder), so the depth case passes its home explicitly
    const deep = "/var/folders/x/T/r185home/home"
    expect(withinDirectory(`${deep}/Documents/Research/sub`, `${deep}/Documents/Research`, deep)).toBe(true)
  })
})
