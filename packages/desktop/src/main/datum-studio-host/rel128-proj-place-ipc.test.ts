// 1.2.8 row 46 (N8-458; AC-PROJf main half, SR8-18 d, SR8-17 desktop mirror, AC-SEC05 main half): the `place` channel
// of Mission Control. Fake ipcMain, fake windows, a recording rehome caller and a recording client (no module mocks).
// Namespace imports, so the file loads at BASE (1.2.7, no `place` channel, no placeMission) and fails there on
// assertions (red run).
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
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
