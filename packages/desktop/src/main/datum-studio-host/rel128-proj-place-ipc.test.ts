// 1.2.8 row 46 (N8-458; AC-PROJf main half, SR8-18 d, SR8-17 desktop mirror, AC-SEC05 main half): the `place` channel
// of Mission Control. Fake ipcMain, fake windows, a recording rehome caller and a recording client (no module mocks).
// Namespace imports, so the file loads at BASE (1.2.7, no `place` channel, no placeMission) and fails there on
// assertions (red run).
import { describe, expect, test } from "bun:test"
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { IpcMainInvokeEvent } from "electron"
import * as channelsModule from "../../preload/mission-control-channels"
import * as ipcModule from "./mission-ipc"
import * as clientModule from "./mission-client"

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
type Result = { ok: boolean; code?: string; message?: string; data?: Record<string, unknown> }
const RENDERER_URL = "oc://renderer/index.html"
const MISSION = "2026-11-14_test-dems-report"
const ROOT = "/srv/swarm/Documents/Default Project"
const SESSION = "ses_0123456789abcdefABCDEFGHIJ"
const PLACE_CHANNEL = "mission-control:place"
const ipc = ipcModule as unknown as Record<string, any>
const channels = (channelsModule as unknown as { MISSION_CONTROL_IPC: Record<string, string> }).MISSION_CONTROL_IPC

type Req = { id: string; status: string; topic?: string; options: Array<Record<string, unknown>> }
const placementRequest = (over: Partial<Req> = {}): Req => ({
  id: "D-1",
  status: "open",
  topic: "project-placement",
  options: [
    { id: "join", label: "Join DEMS (crafted label)", consequence: "x", group: "DEMS", groupKind: "product" },
    { id: "new", label: "New group", consequence: "x", group: "Kemenkeu", groupKind: "institution" },
    { id: "root", label: "Keep", consequence: "x" },
  ],
  ...over,
})

function world(opts: { request?: Req; answer?: Result; dry?: Result; move?: Result; place?: Result; back?: Result } = {}) {
  const calls: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const request = opts.request ?? placementRequest()
  const client = {
    list: async () => (calls.push("list"), { ok: true, data: { items: [{ id: MISSION }] } }),
    get: async () => (
      calls.push("get"),
      {
        ok: true,
        data: {
          mission: { id: MISSION, project: { dir: ROOT }, sessions: [{ client: "swarm", ref: SESSION }, { client: "claude", ref: "x" }] },
          derived: {},
          requests: [request],
          messages: [],
          deliverables: [],
        },
      }
    ),
    answer: async (i: unknown) => (calls.push("answer"), bodies.push({ answer: i }), opts.answer ?? { ok: true, data: { decision: "U1", released: [] } }),
    instruct: async () => (calls.push("instruct"), { ok: true, data: { seq: 1 } }),
    setProjectDir: async (i: unknown) => (calls.push("place"), bodies.push({ place: i }), opts.place ?? { ok: true, data: { mission: MISSION } }),
  }
  const rehome = async (body: Record<string, unknown>) => {
    const kind = body.dryRun ? "rehome:dry" : body.compensates ? "rehome:back" : "rehome"
    calls.push(kind)
    bodies.push({ [kind]: body })
    if (kind === "rehome:dry") return opts.dry ?? { ok: true, data: { planned: { folder: true, notes: 1, sessions: 1, createsGroup: false } } }
    if (kind === "rehome:back") return opts.back ?? { ok: true, data: { journalId: "j2" } }
    return opts.move ?? { ok: true, data: { journalId: "j1", moved: { folder: true, notes: 1, sessions: 1 } } }
  }
  const handlers = new Map<string, Handler>()
  const logs: unknown[][] = []
  const sender = { mainFrame: { url: RENDERER_URL } }
  const win = { isDestroyed: () => false, webContents: sender }
  ipc.registerMissionControlHandlers({
    ipcMain: { handle: (channel: string, h: Handler) => void handlers.set(channel, h) },
    windowOf: (s: unknown) => (s === sender ? win : null),
    isRendererUrl: (url: string) => url === RENDERER_URL,
    client: () => client,
    rehome,
    log: (...a: unknown[]) => void logs.push(a),
  })
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  const call = async (channel: string, input: unknown) => {
    const h = handlers.get(channel)
    if (!h) return { ok: false, code: "NO_CHANNEL" } as Result
    return (await h(event, input)) as Result
  }
  /** list first: the window's scope then holds the mission (row 135 L2). */
  const place = async (option: string, request = "D-1") => {
    await call(channels.list ?? "mission-control:list", { directory: ROOT, sessions: [SESSION] })
    calls.length = 0
    bodies.length = 0
    return call(PLACE_CHANNEL, { mission: MISSION, request, option })
  }
  return { calls, bodies, handlers, logs, place, call }
}

describe("1.2.8 row 46 AC-PROJf: mission-control:place in main", () => {
  test("the channel is registered (N8-144) and the client allows studio_mission_place", () => {
    expect(channels.place).toBe(PLACE_CHANNEL)
    const { handlers } = world()
    expect(handlers.has(PLACE_CHANNEL)).toBe(true)
    expect((clientModule.MISSION_CONTROL_TOOLS as readonly string[]).includes("studio_mission_place")).toBe(true)
  })

  test("an ANSWERED request is refused: no answer, no move, no place", async () => {
    const w = world({ request: placementRequest({ status: "answered" }) })
    const r = await w.place("join")
    expect(`${r.ok} ${r.code}`).toBe("false PLACE_DECISION_UNANSWERED")
    expect(w.calls).toEqual(["get"])
  })

  test("an open request: preflight, then answer -> rehome -> studio_mission_place, in that order", async () => {
    const w = world()
    const r = await w.place("join")
    expect(r.ok).toBe(true)
    expect(r.data).toEqual({ decision: "U1", group: "DEMS" })
    expect(w.calls).toEqual(["get", "rehome:dry", "answer", "rehome", "place"])
    const move = w.bodies.find((b) => b.rehome)!.rehome as Record<string, unknown>
    expect(move).toEqual({ missionId: MISSION, from: ROOT, to: `${ROOT}/DEMS`, sessions: [SESSION], approvalRef: "D-1" })
    expect(w.bodies.find((b) => b.place)!.place).toEqual({ mission: MISSION, projectDir: `${ROOT}/DEMS`, decision: "D-1" })
    expect(w.bodies.find((b) => b.answer)!.answer).toEqual({ mission: MISSION, request: "D-1", option: "join" })
  })

  test("new: the move carries the group kind for the marker; the group comes from the option field, not the label", async () => {
    const w = world()
    expect((await w.place("new")).ok).toBe(true)
    const move = w.bodies.find((b) => b.rehome)!.rehome as Record<string, unknown>
    expect(`${move.to} ${move.groupKind}`).toBe(`${ROOT}/Kemenkeu institution`)
  })

  test("SR8-18(d): a failed answer recording stops before any move", async () => {
    const w = world({ answer: { ok: false, code: "DECISION_ID_TAKEN", message: "x" } })
    const r = await w.place("join")
    expect(`${r.ok} ${r.code}`).toBe("false DECISION_ID_TAKEN")
    expect(w.calls).toEqual(["get", "rehome:dry", "answer"])
  })

  test("a preflight refusal records no answer and moves nothing", async () => {
    const w = world({ dry: { ok: false, code: "REHOME_TARGET_EXISTS", message: "x" } })
    const r = await w.place("join")
    expect(`${r.ok} ${r.code}`).toBe("false REHOME_TARGET_EXISTS")
    expect(w.calls).toEqual(["get", "rehome:dry"])
  })

  test("a failed place reverses the move with compensates (01d §7.4)", async () => {
    const w = world({ place: { ok: false, code: "SESSION_NOT_ATTESTED", message: "x" } })
    const r = await w.place("join")
    expect(`${r.ok} ${r.code}`).toBe("false REHOME_ROLLED_BACK")
    expect(w.calls).toEqual(["get", "rehome:dry", "answer", "rehome", "place", "rehome:back"])
    const back = w.bodies.find((b) => b["rehome:back"])!["rehome:back"] as Record<string, unknown>
    expect(`${back.from} ${back.to} ${back.compensates}`).toBe(`${ROOT}/DEMS ${ROOT} j1`)
    const failed = world({ place: { ok: false, code: "X", message: "x" }, back: { ok: false, code: "REHOME_BUSY", message: "y" } })
    expect((await failed.place("join")).code).toBe("REHOME_ROLLBACK_FAILED")
    expect(failed.logs.some((l) => l[0] === "error")).toBe(true)
  })

  test("root, an unknown option, an ordinary decision and SR8-17 group names are refused before anything runs", async () => {
    expect((await world().place("root")).code).toBe("BAD_ARGUMENT")
    expect((await world().place("other")).code).toBe("BAD_ARGUMENT")
    const plain = world({ request: placementRequest({ topic: undefined }) })
    expect((await plain.place("join")).code).toBe("BAD_ARGUMENT")
    for (const group of ["DEMS​", "DEMS.", " DEMS", "docs", "Docs", "a/b", "..", ".hidden", "x".repeat(61), "é", "A B"]) {
      const w = world({ request: placementRequest({ options: [{ id: "join", label: "Join", consequence: "x", group }] }) })
      const r = await w.place("join")
      expect(`${JSON.stringify(group)} ${r.code} ${w.calls.join(",")}`).toBe(`${JSON.stringify(group)} BAD_ARGUMENT get`)
    }
    const missing = world()
    expect((await missing.place("join", "D-9")).code).toBe("PLACE_DECISION_UNANSWERED")
  })

  test("SR8-17 drift: the desktop mirror equals the host rule and the opencode pattern", async () => {
    const host = await import("../../../../datum-studio/src/store/mission/validate.ts")
    const samples = ["DEMS", "Kemenkeu", "Research 2026", "DEMS​", "DEMS.", " DEMS", "docs", "DOCS", "a/b", "a\\b", ".x", "x".repeat(60), "x".repeat(61), "é", "é", "A B", "‮abc", ""]
    for (const name of samples) expect(`${JSON.stringify(name)} ${ipc.groupNameOk?.(name)}`).toBe(`${JSON.stringify(name)} ${host.groupNameOk(name)}`)
    const oc = readFileSync(join(import.meta.dir, "..", "..", "..", "..", "opencode", "src", "project", "rehome.ts"), "utf8")
    expect(oc.includes(`GROUP_NAME_PATTERN = ${String(ipc.GROUP_NAME_PATTERN)}`)).toBe(true)
  })
})

describe("1.2.8 row 46: the rehome caller (nonce header, local server only)", () => {
  const record = () => {
    const seen: Array<{ url: string; headers: Record<string, string>; body: string }> = []
    const fetch = async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, headers: init.headers, body: init.body })
      return new Response(JSON.stringify({ journalId: "j1", moved: { folder: true, notes: 0, sessions: 1 } }), { status: 200 })
    }
    return { seen, fetch }
  }
  const body = { missionId: MISSION, from: ROOT, to: `${ROOT}/DEMS`, sessions: [SESSION], approvalRef: "D-1" }
  const server = async () => ({ url: "http://127.0.0.1:4096", username: "opencode", password: "pw" })

  test("sends the desktop nonce, the directory and Basic auth to the local server's /project/rehome", async () => {
    const r = record()
    const call = ipc.createRehomeCaller({ server, nonce: () => "n".repeat(43), fetch: r.fetch })
    expect((await call(body)).ok).toBe(true)
    expect(r.seen.length).toBe(1)
    const sent = r.seen[0]!
    expect(sent.url).toBe("http://127.0.0.1:4096/project/rehome")
    expect(sent.headers["x-swarm-desktop-nonce"]).toBe("n".repeat(43))
    expect(decodeURIComponent(sent.headers["x-opencode-directory"]!)).toBe(ROOT)
    expect(sent.headers.authorization).toBe(`Basic ${Buffer.from("opencode:pw").toString("base64")}`)
    expect(JSON.parse(sent.body)).toEqual(body)
  })

  test("no nonce held, or a server that is not loopback: refused without a request", async () => {
    const r = record()
    expect((await ipc.createRehomeCaller({ server, nonce: () => undefined, fetch: r.fetch })(body)).code).toBe("HOST_UNAVAILABLE")
    const remote = async () => ({ url: "https://example.com", username: "opencode", password: "pw" })
    expect((await ipc.createRehomeCaller({ server: remote, nonce: () => "n".repeat(43), fetch: r.fetch })(body)).code).toBe("HOST_UNAVAILABLE")
    expect(r.seen.length).toBe(0)
  })

  test("a 409 refusal keeps its register code", async () => {
    const fetch = async () =>
      new Response(JSON.stringify({ name: "RehomeRefusedError", data: { code: "REHOME_BUSY", message: "busy" } }), { status: 409 })
    const r = await ipc.createRehomeCaller({ server, nonce: () => "n".repeat(43), fetch })(body)
    expect(`${r.ok} ${r.code}`).toBe("false REHOME_BUSY")
  })

  test("row 24b (C128): a session-active refusal with detail 'lives in another folder' carries that detail; busy keeps the route text", async () => {
    const refuse = (detail: string) => async () =>
      new Response(
        JSON.stringify({ name: "RehomeRefusedError", data: { code: "REHOME_SESSION_ACTIVE", message: "A session or terminal of this mission is still running.", detail } }),
        { status: 409 },
      )
    const call = (detail: string) => ipc.createRehomeCaller({ server, nonce: () => "n".repeat(43), fetch: refuse(detail) })(body)
    const elsewhere = await call(`session ${SESSION} lives in another folder`)
    expect(elsewhere.ok).toBe(false)
    if (!elsewhere.ok) expect(`${elsewhere.code} ${elsewhere.message}`).toBe(`REHOME_SESSION_ACTIVE session ${SESSION} lives in another folder`)
    const busy = await call(`session ${SESSION} busy`)
    if (!busy.ok) expect(`${busy.code} ${busy.message}`).toBe("REHOME_SESSION_ACTIVE A session or terminal of this mission is still running.")
    expect(busy.ok).toBe(false)
  })
})

describe("1.2.8 row 46 AC-SEC05 main half: place goes through the attested client", () => {
  test("setProjectDir calls studio_mission_place on a session opened with the Mission Control key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r46-"))
    try {
      const KEY = "a".repeat(64)
      const calls: Array<{ headers: Record<string, string>; body: Record<string, unknown> }> = []
      const fetch = async (_url: string, init: { headers: Record<string, string>; body?: string }) => {
        const b = JSON.parse(init.body ?? "{}") as Record<string, unknown>
        calls.push({ headers: init.headers, body: b })
        if (b.method === "initialize")
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18" } }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "s1" },
          })
        if (b.method === "notifications/initialized") return new Response(null, { status: 202 })
        const msg = { jsonrpc: "2.0", id: b.id, result: { structuredContent: { ok: true, tool: "studio_mission_place", mission: { id: MISSION } } } }
        return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } })
      }
      const c = clientModule.createMissionControlClient({
        url: "http://127.0.0.1:47999/mcp",
        token: "f".repeat(64),
        missionControlKey: KEY,
        callerCwd: join(dir, "mc"),
        fetch: fetch as never,
      }) as unknown as Record<string, any>
      expect(typeof c.setProjectDir).toBe("function")
      const r = await c.setProjectDir({ mission: MISSION, projectDir: `${ROOT}/DEMS`, decision: "D-1" })
      expect(r.ok).toBe(true)
      const tool = calls.find((x) => x.body.method === "tools/call")!
      expect((tool.body.params as { name: string }).name).toBe("studio_mission_place")
      expect(calls.find((x) => x.body.method === "initialize")!.headers["x-swarm-mission-control-key"]).toBe(KEY)
      expect((await c.setProjectDir({ mission: MISSION, projectDir: "relative/DEMS", decision: "D-1" })).code).toBe("BAD_ARGUMENT")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// 1.2.8 row 46b (N8-458 tidy + retry cases; AC-PROJg main half; C98 retry; C8 OP-4 batches of 200; U1 tidy old missions).

const HOLDER = "2026-11-14_project-tidy"
const tidyRequest = (proposal: Array<Record<string, unknown>>, over: Partial<Req> & { answer?: unknown } = {}) => ({
  id: "D-2",
  status: "open",
  topic: "project-tidy",
  options: [
    { id: "approve", label: "Approve", consequence: "x" },
    { id: "decline", label: "Decline", consequence: "x" },
  ],
  proposal,
  ...over,
})

type Missions = Map<string, { dir: string; sessions?: Array<{ client: string; ref: string }> }>
/** Several missions; `get` is the store read. `rehome` may be replaced (the disk test). */
function tidyWorld(opts: {
  request: Record<string, unknown>
  missions: Missions
  answer?: Result
  rehome?: (body: Record<string, unknown>) => Promise<Result>
  place?: (i: Record<string, unknown>) => Result
  groupMarker?: (dir: string) => boolean
}) {
  const calls: string[] = []
  const bodies: Array<Record<string, unknown>> = []
  const missionsOf = () => [...opts.missions.keys()].map((id) => ({ id }))
  const client = {
    list: async () => ({ ok: true, data: { items: missionsOf() } }),
    get: async (i: { mission: string }) => {
      calls.push(`get:${i.mission}`)
      const m = opts.missions.get(i.mission)
      if (!m) return { ok: false, code: "NOT_FOUND", message: "x" }
      return {
        ok: true,
        data: {
          mission: { id: i.mission, project: { dir: m.dir }, sessions: m.sessions ?? [] },
          derived: {},
          requests: i.mission === HOLDER ? [opts.request] : [],
          messages: [],
          deliverables: [],
        },
      }
    },
    answer: async (i: unknown) => (calls.push("answer"), bodies.push({ answer: i }), opts.answer ?? { ok: true, data: { decision: "U2", released: [] } }),
    instruct: async () => ({ ok: true, data: { seq: 1 } }),
    setProjectDir: async (i: Record<string, unknown>) => {
      calls.push(`place:${i.mission}`)
      bodies.push({ place: i })
      const r = opts.place?.(i) ?? { ok: true, data: { mission: i.mission } }
      if (r.ok) opts.missions.get(i.mission as string)!.dir = i.projectDir as string
      return r
    },
  }
  const rehome =
    opts.rehome ??
    (async (body: Record<string, unknown>) => {
      const kind = body.dryRun ? "dry" : body.compensates ? "back" : "move"
      calls.push(`${kind}:${body.missionId}`)
      bodies.push({ [kind]: body })
      return { ok: true, data: { journalId: `j-${body.missionId}` } } as Result
    })
  const handlers = new Map<string, Handler>()
  const logs: unknown[][] = []
  const sender = { mainFrame: { url: RENDERER_URL } }
  const win = { isDestroyed: () => false, webContents: sender }
  ipc.registerMissionControlHandlers({
    ipcMain: { handle: (channel: string, h: Handler) => void handlers.set(channel, h) },
    windowOf: (s: unknown) => (s === sender ? win : null),
    isRendererUrl: (url: string) => url === RENDERER_URL,
    client: () => client,
    rehome,
    groupMarker: opts.groupMarker,
    log: (...a: unknown[]) => void logs.push(a),
  })
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
  const call = async (channel: string, input: unknown) => {
    const h = handlers.get(channel)
    if (!h) return { ok: false, code: "NO_CHANNEL" } as Result
    return (await h(event, input)) as Result
  }
  const approve = async (option = "approve", request = "D-2", mission = HOLDER) => {
    await call(channels.list ?? "mission-control:list", { directory: ROOT, sessions: [SESSION] })
    calls.length = 0
    bodies.length = 0
    return call(PLACE_CHANNEL, { mission, request, option })
  }
  return { calls, bodies, logs, approve, call }
}

const ids = (n: number, prefix = "m") => Array.from({ length: n }, (_, i) => `2026-10-${String((i % 28) + 1).padStart(2, "0")}_${prefix}-${i}`)
const rootMissions = (list: string[], extra: Array<[string, string]> = []): Missions =>
  new Map<string, { dir: string; sessions?: Array<{ client: string; ref: string }> }>([
    [HOLDER, { dir: ROOT }],
    ...list.map((id) => [id, { dir: ROOT }] as [string, { dir: string }]),
    ...extra.map(([id, dir]) => [id, { dir }] as [string, { dir: string }]),
  ])

describe("1.2.8 row 46b AC-PROJg: one tidy list, approved once (main)", () => {
  test("approve: every listed mission with a group is preflighted, then ONE answer, then move + place per item in list order", async () => {
    const [a, b, c, d] = ids(4)
    const w = tidyWorld({
      request: tidyRequest([
        { mission: a, group: "Lumen", groupKind: "product" },
        { mission: b, group: null },
        { mission: c, group: "Dinas Contoh", groupKind: "institution" },
      ]),
      missions: rootMissions([a!, b!, c!, d!]),
    })
    const r = await w.approve()
    expect(`${r.ok} ${JSON.stringify(r.data)}`).toBe(`true ${JSON.stringify({ decision: "U2", moved: 2, total: 2 })}`)
    expect(w.calls.filter((x) => !x.startsWith("get:"))).toEqual([`dry:${a}`, `dry:${c}`, "answer", `move:${a}`, `place:${a}`, `move:${c}`, `place:${c}`])
    expect(w.calls.filter((x) => x === "answer").length).toBe(1)
    // only listed missions with a group move: b (group null) and d (not listed) never reach the move route
    expect(w.calls.some((x) => x.endsWith(`:${b}`) && !x.startsWith("get:"))).toBe(false)
    expect(w.calls.some((x) => x.endsWith(`:${d}`))).toBe(false)
    const placeA = w.bodies.find((x) => x.place && (x.place as Record<string, unknown>).mission === a)!.place
    expect(placeA).toEqual({ mission: a, projectDir: `${ROOT}/Lumen`, decision: "D-2", tidyMission: HOLDER })
    const moveC = w.bodies.find((x) => x.move && (x.move as Record<string, unknown>).missionId === c)!.move
    expect(moveC).toEqual({ missionId: c, from: ROOT, to: `${ROOT}/Dinas Contoh`, sessions: [], approvalRef: "D-2", groupKind: "institution" })
    expect(w.bodies.find((x) => x.answer)!.answer).toEqual({ mission: HOLDER, request: "D-2", option: "approve" })
  })

  test("one dry-run refusal among 3 items: zero moves, no answer recorded, the refusal names that mission", async () => {
    const [a, b, c] = ids(3)
    const w = tidyWorld({
      request: tidyRequest([a, b, c].map((m) => ({ mission: m, group: "Lumen", groupKind: "product" }))),
      missions: rootMissions([a!, b!, c!]),
      rehome: async (body) => {
        if (body.dryRun) return body.missionId === b ? { ok: false, code: "REHOME_TARGET_EXISTS", message: "x" } : { ok: true, data: {} }
        throw new Error("no move may run")
      },
    })
    const r = (await w.approve()) as Result & { mission?: string; moved?: number }
    expect(`${r.ok} ${r.code} ${r.mission} ${r.moved}`).toBe(`false REHOME_TARGET_EXISTS ${b} undefined`)
    expect(w.calls.includes("answer")).toBe(false)
    expect(w.calls.some((x) => x.startsWith("place:"))).toBe(false)
  })

  test("a fault on item 2: item 1 moved, item 2 rolled back by the primitive, item 3 untouched; stop names item 2", async () => {
    const [a, b, c] = ids(3)
    const missions = rootMissions([a!, b!, c!])
    const w = tidyWorld({
      request: tidyRequest([a, b, c].map((m) => ({ mission: m, group: "Lumen", groupKind: "product" }))),
      missions,
      rehome: async (body) => {
        const kind = body.dryRun ? "dry" : "move"
        w.calls.push(`${kind}:${body.missionId}`)
        if (kind === "move" && body.missionId === b) return { ok: false, code: "REHOME_ROLLED_BACK", message: "folder" }
        return { ok: true, data: { journalId: `j-${body.missionId}` } }
      },
    })
    const r = (await w.approve()) as Result & { mission?: string; moved?: number; total?: number }
    expect(`${r.ok} ${r.code} ${r.mission} ${r.moved}/${r.total}`).toBe(`false REHOME_ROLLED_BACK ${b} 1/3`)
    expect(w.calls.filter((x) => !x.startsWith("get:") && !x.startsWith("dry:"))).toEqual(["answer", `move:${a}`, `place:${a}`, `move:${b}`])
    expect(`${missions.get(a!)!.dir} | ${missions.get(b!)!.dir} | ${missions.get(c!)!.dir}`).toBe(`${ROOT}/Lumen | ${ROOT} | ${ROOT}`)
  })

  test("a failed place on item 2 reverses that move (compensates) and stops", async () => {
    const [a, b, c] = ids(3)
    const w = tidyWorld({
      request: tidyRequest([a, b, c].map((m) => ({ mission: m, group: "Lumen" }))),
      missions: rootMissions([a!, b!, c!]),
      place: (i) => (i.mission === b ? { ok: false, code: "PLACE_DECISION_UNANSWERED", message: "x" } : { ok: true }),
    })
    const r = (await w.approve()) as Result & { mission?: string; moved?: number }
    expect(`${r.code} ${r.mission} ${r.moved}`).toBe(`REHOME_ROLLED_BACK ${b} 1`)
    expect(w.calls.filter((x) => x.startsWith("back:"))).toEqual([`back:${b}`])
    expect(w.calls.some((x) => x.endsWith(`:${c}`) && (x.startsWith("move:") || x.startsWith("place:")))).toBe(false)
  })

  test("refused before anything: answered, decline, a listed mission outside the root, the tidy mission itself, bad group, duplicates", async () => {
    const [a, b] = ids(2)
    const cases: Array<[string, Record<string, unknown>, Missions, string, string]> = [
      ["answered", tidyRequest([{ mission: a, group: "Lumen" }], { status: "answered", answer: { option: "approve", by: "user", decision: "U1", attested: true } }), rootMissions([a!]), "approve", "PLACE_DECISION_UNANSWERED"],
      ["decline", tidyRequest([{ mission: a, group: "Lumen" }]), rootMissions([a!]), "decline", "BAD_ARGUMENT"],
      ["outside root", tidyRequest([{ mission: a, group: "Lumen" }, { mission: b, group: "Lumen" }]), rootMissions([a!], [[b!, `${ROOT}/Lumen`]]), "approve", "REHOME_OUTSIDE_ROOT"],
      ["holder listed", tidyRequest([{ mission: HOLDER, group: "Lumen" }]), rootMissions([]), "approve", "BAD_ARGUMENT"],
      ["bad group", tidyRequest([{ mission: a, group: "docs" }]), rootMissions([a!]), "approve", "BAD_ARGUMENT"],
      ["duplicate", tidyRequest([{ mission: a, group: "Lumen" }, { mission: a, group: "X" }]), rootMissions([a!]), "approve", "BAD_ARGUMENT"],
      ["empty", tidyRequest([]), rootMissions([]), "approve", "BAD_ARGUMENT"],
    ]
    for (const [name, request, missions, option, code] of cases) {
      const w = tidyWorld({ request, missions })
      const r = await w.approve(option)
      const ran = w.calls.filter((x) => !x.startsWith("get:"))
      expect(`${name}: ${r.ok} ${r.code} ${ran.join(",")}`).toBe(`${name}: false ${code} `)
    }
  })

  test("C8 OP-4: 201 root missions go in two requests (200 + 1), each approved once; a 201-item list is refused", async () => {
    const all = ids(201, "t")
    const missions = rootMissions(all)
    const first = tidyWorld({ request: tidyRequest(all.slice(0, 200).map((m) => ({ mission: m, group: "Lumen" }))), missions })
    const r1 = await first.approve()
    expect(`${r1.ok} ${(r1.data as { moved?: number }).moved}`).toBe("true 200")
    expect(first.calls.filter((x) => x === "answer").length).toBe(1)
    const second = tidyWorld({ request: tidyRequest([{ mission: all[200], group: "Lumen" }], { id: "D-3" }), missions })
    const r2 = await second.approve("approve", "D-3")
    expect(`${r2.ok} ${(r2.data as { moved?: number }).moved}`).toBe("true 1")
    expect([...missions.values()].filter((m) => m.dir === `${ROOT}/Lumen`).length).toBe(201)
    expect(ipc.TIDY_BATCH_MAX).toBe(200)
    const tooMany = tidyWorld({ request: tidyRequest(all.map((m) => ({ mission: m, group: "Lumen" }))), missions: rootMissions(all) })
    const r3 = await tooMany.approve()
    expect(`${r3.ok} ${r3.code} ${tooMany.calls.filter((x) => !x.startsWith("get:")).length}`).toBe("false BAD_ARGUMENT 0")
  })
})

describe("1.2.8 row 46b AC-PROJg: a refusal leaves the disk unchanged (syn128 Default Project)", () => {
  const FIXTURE = join(import.meta.dir, "..", "..", "..", "..", "datum-studio", "test", "fixtures", "syn128")
  const hashTree = (dir: string) => {
    const h = createHash("sha256")
    const walk = (d: string) => {
      for (const name of readdirSync(d).sort()) {
        const p = join(d, name)
        const st = lstatSync(p)
        h.update(`${p.slice(dir.length)}|${st.isDirectory() ? "d" : "f"}|`)
        if (st.isDirectory()) walk(p)
        else h.update(readFileSync(p))
      }
    }
    walk(dir)
    return h.digest("hex")
  }
  /** A disk-backed stand-in for POST /project/rehome: preflight (target exists, unmarked group) and a real rename. */
  const diskRehome = (fault?: string) => async (body: Record<string, unknown>): Promise<Result> => {
    const from = body.from as string
    const to = body.to as string
    const id = body.missionId as string
    if (existsSync(to) && !existsSync(join(to, ".swarm", "group.json"))) return { ok: false, code: "REHOME_TARGET_EXISTS", message: "unmarked folder" }
    if (existsSync(join(to, "docs", id))) return { ok: false, code: "REHOME_TARGET_EXISTS", message: "x" }
    if (body.dryRun) return { ok: true, data: { planned: {} } }
    if (id === fault) return { ok: false, code: "REHOME_ROLLED_BACK", message: "folder" }
    mkdirSync(join(to, ".swarm"), { recursive: true })
    if (!existsSync(join(to, ".swarm", "group.json")))
      writeFileSync(join(to, ".swarm", "group.json"), JSON.stringify({ version: 1, name: to.split("/").pop(), kind: body.groupKind ?? "theme", created: 1 }))
    mkdirSync(join(to, "docs"), { recursive: true })
    if (existsSync(join(from, "docs", id))) renameSync(join(from, "docs", id), join(to, "docs", id))
    return { ok: true, data: { journalId: `j-${id}` } }
  }

  test("U1 tidy of the 21 old root missions: a refusal on the 3rd listed one (unmarked 'Arsip Lama') moves nothing; then the clean list moves exactly the listed ones", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "r46b-"))
    try {
      const manifest = JSON.parse(readFileSync(join(FIXTURE, "default_project_missions.json"), "utf8")) as {
        missions: Array<{ id: string; projectDir: string; expectedGroup: string; groupKind?: string }>
      }
      const root = join(tmp, "Documents", "Default Project")
      mkdirSync(join(tmp, "Documents"), { recursive: true })
      cpSync(join(FIXTURE, "default_project"), root, { recursive: true })
      const atRoot = manifest.missions.filter((m) => m.projectDir === ".")
      expect(atRoot.length).toBe(21)
      const missions: Missions = new Map([[HOLDER, { dir: root }]])
      for (const m of manifest.missions) missions.set(m.id, { dir: m.projectDir === "." ? root : join(root, m.projectDir) })
      const proposal = atRoot.map((m) => ({ mission: m.id, group: m.expectedGroup, groupKind: m.groupKind ?? "theme" }))
      const bad = proposal.map((item, i) => (i === 2 ? { ...item, group: "Arsip Lama" } : item))

      const before = hashTree(root)
      const refusedWorld = tidyWorld({ request: tidyRequest(bad), missions, rehome: diskRehome() })
      await refusedWorld.call(channels.list!, { directory: root, sessions: [] })
      const out = (await refusedWorld.call(PLACE_CHANNEL, { mission: HOLDER, request: "D-2", option: "approve" })) as Result & { mission?: string }
      expect(`${out.ok} ${out.code} ${out.mission}`).toBe(`false REHOME_TARGET_EXISTS ${atRoot[2]!.id}`)
      expect(refusedWorld.calls.includes("answer")).toBe(false)
      expect(hashTree(root)).toBe(before)

      // the listed-only rule: 'stays' lines and the mission already in Lumen do not move
      const kept = proposal.map((item, i) => (i % 5 === 0 ? { ...item, group: null } : item))
      const okWorld = tidyWorld({ request: tidyRequest(kept), missions, rehome: diskRehome() })
      await okWorld.call(channels.list!, { directory: root, sessions: [] })
      const done = await okWorld.call(PLACE_CHANNEL, { mission: HOLDER, request: "D-2", option: "approve" })
      const moving = kept.filter((k) => k.group !== null)
      expect(`${done.ok} ${(done.data as { moved?: number }).moved}`).toBe(`true ${moving.length}`)
      const left = readdirSync(join(root, "docs")).sort()
      expect(left).toEqual(kept.filter((k) => k.group === null).map((k) => k.mission).sort())
      for (const k of moving) expect(existsSync(join(root, k.group!, "docs", k.mission))).toBe(true)
      expect(existsSync(join(root, "Lumen", "docs", "2026-08-20_lumen-design-palette"))).toBe(true)
      expect(existsSync(join(root, "Arsip Lama", ".swarm"))).toBe(false)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  test("a fault on item 2 on disk: item 1 moved, item 2 and item 3 still at the root", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "r46b-"))
    try {
      const root = join(tmp, "Default Project")
      cpSync(join(FIXTURE, "default_project"), root, { recursive: true })
      const three = ["2026-09-01_lumen-onboarding-flow", "2026-09-02_lumen-release-checklist", "2026-09-03_lumen-pricing-page-copy"]
      const missions: Missions = new Map([[HOLDER, { dir: root }], ...three.map((m) => [m, { dir: root }] as [string, { dir: string }])])
      const w = tidyWorld({ request: tidyRequest(three.map((m) => ({ mission: m, group: "Lumen" }))), missions, rehome: diskRehome(three[1]) })
      await w.call(channels.list!, { directory: root, sessions: [] })
      const r = (await w.call(PLACE_CHANNEL, { mission: HOLDER, request: "D-2", option: "approve" })) as Result & { mission?: string; moved?: number }
      expect(`${r.code} ${r.mission} ${r.moved}`).toBe(`REHOME_ROLLED_BACK ${three[1]} 1`)
      expect(three.map((m) => existsSync(join(root, "Lumen", "docs", m)))).toEqual([true, false, false])
      expect(three.map((m) => existsSync(join(root, "docs", m)))).toEqual([false, true, true])
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe("1.2.8 row 46b C98: retry an answered placement whose move did not finish", () => {
  const answered = (over: Record<string, unknown> = {}) =>
    placementRequest({ status: "answered", ...({ answer: { option: "join", by: "user", decision: "U1", via: "swarm-mission-control", attested: true, ...over } } as object) })
  function placeWorld(request: Req, dir = ROOT, marker = false, move?: Result) {
    const calls: string[] = []
    const bodies: Array<Record<string, unknown>> = []
    const client = {
      list: async () => ({ ok: true, data: { items: [{ id: MISSION }] } }),
      get: async () => (
        calls.push("get"),
        { ok: true, data: { mission: { id: MISSION, project: { dir }, sessions: [{ client: "swarm", ref: SESSION }] }, derived: {}, requests: [request] } }
      ),
      answer: async () => (calls.push("answer"), { ok: true, data: { decision: "U9", released: [] } }),
      instruct: async () => ({ ok: true, data: { seq: 1 } }),
      setProjectDir: async (i: unknown) => (calls.push("place"), bodies.push({ place: i }), { ok: true, data: {} }),
    }
    const handlers = new Map<string, Handler>()
    const sender = { mainFrame: { url: RENDERER_URL } }
    ipc.registerMissionControlHandlers({
      ipcMain: { handle: (channel: string, h: Handler) => void handlers.set(channel, h) },
      windowOf: (s: unknown) => (s === sender ? { isDestroyed: () => false, webContents: sender } : null),
      isRendererUrl: (url: string) => url === RENDERER_URL,
      client: () => client,
      groupMarker: () => marker,
      rehome: async (body: Record<string, unknown>) => {
        const kind = body.dryRun ? "rehome:dry" : body.compensates ? "rehome:back" : "rehome"
        calls.push(kind)
        bodies.push({ [kind]: body })
        return kind === "rehome" && move ? move : ({ ok: true, data: { journalId: "j1", replayed: true } } as Result)
      },
      log: () => {},
    })
    const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent
    const go = async (option = "join") => {
      await handlers.get(channels.list ?? "mission-control:list")!(event, { directory: ROOT, sessions: [SESSION] })
      calls.length = 0
      return (await handlers.get(PLACE_CHANNEL)!(event, { mission: MISSION, request: "D-1", option })) as Result
    }
    return { calls, bodies, go }
  }

  test("answered by the person (attested), mission still at the root: rehome then studio_mission_place, no second answer", async () => {
    const w = placeWorld(answered())
    const r = await w.go()
    expect(`${r.ok} ${JSON.stringify(r.data)}`).toBe(`true ${JSON.stringify({ decision: "U1", group: "DEMS" })}`)
    expect(w.calls).toEqual(["get", "rehome", "place"])
    expect(w.bodies.find((b) => b.rehome)!.rehome).toEqual({ missionId: MISSION, from: ROOT, to: `${ROOT}/DEMS`, sessions: [SESSION], approvalRef: "D-1" })
  })

  test("a mission already in its marked group is a no-op (idempotent)", async () => {
    const w = placeWorld(answered(), `${ROOT}/DEMS`, true)
    const r = await w.go()
    expect(`${r.ok} ${(r.data as { replayed?: boolean }).replayed}`).toBe("true true")
    expect(w.calls).toEqual(["get"])
  })

  test("the retry's move failing is reported with its code; the request stays answered (no answer call)", async () => {
    const w = placeWorld(answered(), ROOT, false, { ok: false, code: "REHOME_BUSY", message: "busy" })
    const r = await w.go()
    expect(`${r.ok} ${r.code}`).toBe("false REHOME_BUSY")
    expect(w.calls).toEqual(["get", "rehome"])
  })

  test("S-6: an answer an agent recorded (not attested, or by controller), or another option, is never retried", async () => {
    for (const over of [{ attested: false }, { attested: undefined }, { by: "controller" }, { option: "new" }]) {
      const w = placeWorld(answered(over))
      const r = await w.go("join")
      expect(`${JSON.stringify(over)} ${r.code} ${w.calls.join(",")}`).toBe(`${JSON.stringify(over)} PLACE_DECISION_UNANSWERED get`)
    }
    // the person answered root: nothing to move (root never reaches the move route)
    const root = placeWorld(answered({ option: "root" }))
    expect(`${(await root.go("root")).code} ${root.calls.join(",")}`).toBe("BAD_ARGUMENT get")
  })
})

describe("1.2.8 row 46b: setProjectDir names the tidy mission (01d §7.3 tidyMission)", () => {
  test("tidyMission is sent to studio_mission_place; a malformed one is refused without a call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r46b-"))
    try {
      const sent: Array<Record<string, unknown>> = []
      const fetch = async (_url: string, init: { body?: string }) => {
        const b = JSON.parse(init.body ?? "{}") as Record<string, unknown>
        if (b.method === "initialize")
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18" } }), {
            status: 200,
            headers: { "content-type": "application/json", "mcp-session-id": "s1" },
          })
        if (b.method === "notifications/initialized") return new Response(null, { status: 202 })
        sent.push((b.params as { arguments: Record<string, unknown> }).arguments)
        const msg = { jsonrpc: "2.0", id: b.id, result: { structuredContent: { ok: true, tool: "studio_mission_place", mission: { id: MISSION } } } }
        return new Response(JSON.stringify(msg), { status: 200, headers: { "content-type": "application/json" } })
      }
      const c = clientModule.createMissionControlClient({
        url: "http://127.0.0.1:47999/mcp",
        token: "f".repeat(64),
        missionControlKey: "a".repeat(64),
        callerCwd: join(dir, "mc"),
        fetch: fetch as never,
      }) as unknown as Record<string, any>
      expect((await c.setProjectDir({ mission: MISSION, projectDir: `${ROOT}/Lumen`, decision: "D-2", tidyMission: HOLDER })).ok).toBe(true)
      expect(sent.length).toBe(1)
      expect(sent[0]).toEqual({ mission: MISSION, projectDir: `${ROOT}/Lumen`, decision: "D-2", tidyMission: HOLDER })
      expect((await c.setProjectDir({ mission: MISSION, projectDir: `${ROOT}/Lumen`, decision: "D-2", tidyMission: "../x" })).code).toBe("BAD_ARGUMENT")
      expect(sent.length).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
