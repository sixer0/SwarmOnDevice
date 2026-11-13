// The four mission control IPC handlers (row 127; masterplan/01_specs_mission_control_ui.md §3). ipc.ts registers
// them with the real ipcMain and BrowserWindow lookup; this file imports only electron types, so bun tests it
// without mocking modules (the setup-tools-ipc.ts pattern).
//
// Sender rule (spec §3.3 "sender"; the same check as setup-tools-ipc.ts assertSender and set-native-translations):
// the sender is the main frame of a live window main created, on the renderer origin (windows.ts isRendererUrl).
// A refused sender gets {ok:false, code:"BAD_SENDER"} and no host call.
// Every handler answers a MissionControlResult and never throws to the renderer.

import { lstatSync } from "node:fs"
import { homedir } from "node:os"
import { posix } from "node:path"
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from "electron"
import { MISSION_CONTROL_IPC } from "../../preload/mission-control-channels"
import type { MissionControlPlatform, MissionControlResult, ServerReadyData } from "../../preload/types"
import { MISSION_CONTROL_AGENT, MISSION_ID_RE, parseAnswerInput, SESSION_ID_RE, type MissionControlClient } from "./mission-client"

export type MissionIpcDeps = {
  ipcMain: Pick<IpcMain, "handle">
  windowOf: (sender: WebContents) => Pick<BrowserWindow, "isDestroyed" | "webContents"> | null
  isRendererUrl: (url: string | undefined) => boolean
  /**
   * The running host's client, or undefined while DATUM Studio is not running. 1.2.8 row 46: the real client also has
   * `setProjectDir` (mission-client.ts), which the `place` channel needs.
   */
  client: () => (MissionControlPlatform & Partial<Pick<MissionControlClient, "setProjectDir">>) | undefined
  /** 1.2.8 row 46 (01d §6, §7): POST /project/rehome on the local server with this launch's desktop nonce (ipc.ts). */
  rehome?: Rehome
  /** 1.2.8 row 46b: test seam for the retry no-op check; default reads `<dir>/.swarm/group.json`. */
  groupMarker?: (dir: string) => boolean
  log: (level: "warn" | "error", message: string, context?: Record<string, unknown>) => void
}

const unavailable: MissionControlResult<never> = { ok: false, code: "HOST_UNAVAILABLE", message: "DATUM Studio is not running" }

function senderOk(deps: MissionIpcDeps, event: IpcMainInvokeEvent) {
  const win = deps.windowOf(event.sender)
  return !!(
    win &&
    !win.isDestroyed() &&
    win.webContents === event.sender &&
    event.senderFrame &&
    event.senderFrame === event.sender.mainFrame &&
    deps.isRendererUrl(event.senderFrame.url)
  )
}

// Row 135 L2 (C150): per window, the missions it listed and the project folder each was listed for. get / answer /
// instruct take only those ids, and a get is returned only when the mission's project folder is still that folder, so a
// renderer reaches the missions of its session's project and no others. Kept per sender webContents, dropped with it.
// Row 183 (L36): the basis of a listed id is the list's folder plus its sessions; a get is returned when the mission's
// project folder is that folder or one inside it (row 181, the store's rule), or the mission is linked (client swarm,
// the client's MCP agent) to one of those sessions.
// Row 185 (S186-02, L42): the folder and the session ids come from the renderer and are checked for shape only, not
// for belonging to this window's own session. This scope keeps a window consistent with what it listed; it is NOT
// window isolation, and a compromised renderer can choose another folder or session (it already has the server API).
type Basis = { directory: string; sessions: string[] }
type Scope = Map<string, Basis>
const OUT_OF_SCOPE: MissionControlResult<never> = { ok: false, code: "BAD_ARGUMENT", message: "mission is not in this session's project" }

const missionOf = (input: unknown) =>
  input && typeof input === "object" && typeof (input as { mission?: unknown }).mission === "string"
    ? (input as { mission: string }).mission
    : undefined

/** After an ok list: the listed ids replace this folder's ids in the scope. */
function remember(scope: Scope, input: unknown, result: MissionControlResult<unknown>) {
  if (!result.ok) return
  const { directory, sessions } = input as { directory: string; sessions?: unknown }
  const basis: Basis = { directory, sessions: Array.isArray(sessions) ? sessions.filter((s): s is string => typeof s === "string") : [] }
  const items = (result.data as { items?: Array<{ id?: unknown }> }).items ?? []
  for (const [id, known] of [...scope]) if (known.directory === directory) scope.delete(id)
  for (const item of items) if (typeof item?.id === "string") scope.set(item.id, basis)
}

/** Same value as datum-studio mission-store.ts PROJECT_PREFIX_MIN_SEGMENTS (row 185, S186-01). */
export const PROJECT_PREFIX_MIN_SEGMENTS = 4

/**
 * Row 183: the mission's project folder is the listed folder or a folder inside it (mission-store.ts projectDirScope).
 * Row 185 (S186-01, L42): the "inside it" part only for a narrow folder - not '/', not the home folder or a folder
 * directly in it ('~/Documents'), and at least PROJECT_PREFIX_MIN_SEGMENTS segments deep - the store's rule.
 */
export function withinDirectory(dir: string, directory: string, home: string = homedir()) {
  if (dir === directory) return true
  if (!dir.startsWith("/") || !directory.startsWith("/")) return false
  const exact = posix.resolve("/", directory)
  if (dir === exact) return true
  if (exact === "/" || exact.split("/").filter(Boolean).length < PROJECT_PREFIX_MIN_SEGMENTS) return false
  const h = home.startsWith("/") ? posix.resolve("/", home) : null
  if (h !== null && (exact === h || posix.dirname(exact) === h)) return false
  return dir.startsWith(`${exact}/`) && !`${dir}/`.includes("/../") && !`${dir}/`.includes("/./")
}

function stillInScope(data: unknown, basis: Basis) {
  const mission = (data as { mission?: { project?: { dir?: unknown }; sessions?: unknown } }).mission
  const dir = mission?.project?.dir
  if (typeof dir === "string" && withinDirectory(dir, basis.directory)) return true
  const links = Array.isArray(mission?.sessions) ? (mission.sessions as Array<{ client?: unknown; ref?: unknown }>) : []
  return links.some((l) => l?.client === MISSION_CONTROL_AGENT && typeof l.ref === "string" && basis.sessions.includes(l.ref))
}

// ---------------------------------------------------------------------------------------------------------------
// 1.2.8 row 46 (AC-PROJf; 01d §4, §6, §7; SR8-05, SR8-17, SR8-18 d): the placement of a mission on the person's click.
//
// Main is the one place holding both the desktop nonce (the rehome route's person proof) and the attested Mission Control
// client (studio_mission_place's person proof), and it is out of the agent's reach. One IPC per click runs, in order:
//   1. studio_mission_get: the request is OPEN, topic project-placement, the option is join or new of that request and
//      its `group` passes the group-name rule (an answered request is refused: only a click on an open one moves).
//   2. POST /project/rehome dryRun (preflight). A refusal returns here: no answer is recorded, nothing moves.
//   3. The answer, by user, through the client's `answer` (attested session). SR8-18(d): a failed recording stops here,
//      before any move.
//   4. POST /project/rehome (the move; the primitive rolls itself back on a fault).
//   5. studio_mission_place (projectDir = the group folder). If it fails, the move is reversed with `compensates`
//      (01d §7.4): REHOME_ROLLED_BACK when the reverse worked, REHOME_ROLLBACK_FAILED when it did not.

/** The rehome route's person-proof header (OC server/desktop-nonce.ts, row 38b). */
export const DESKTOP_NONCE_HEADER = "x-swarm-desktop-nonce"
export const REHOME_PATH = "/project/rehome"
/** A move copies a mission folder and memory stores; longer than a store call (mission-client.ts 5 s). */
export const REHOME_TIMEOUT_MS = 60_000
export const PLACEMENT_TOPIC = "project-placement"
/** Options of a placement request that move something; `root` is answered through the ordinary `answer` channel. */
export const PLACE_OPTIONS = ["join", "new"] as const

/** Desktop mirror of opencode project/rehome.ts and datum-studio validate.ts (N8-150 + SR8-17); drift test N8-458. */
export const GROUP_NAME_PATTERN = /^[^./\\][^/\\]{0,59}$/
export const RESERVED_GROUP_NAMES = ["docs"] as const
export function groupNameOk(name: unknown): name is string {
  if (typeof name !== "string" || !GROUP_NAME_PATTERN.test(name)) return false
  if (name.normalize("NFC") !== name) return false
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(name)) return false
  if (name.trim() !== name || name.endsWith(".")) return false
  return !RESERVED_GROUP_NAMES.some((reserved) => reserved === name.toLowerCase())
}

export type RehomeBody = {
  missionId: string
  from: string
  to: string
  sessions: string[]
  approvalRef: string
  dryRun?: boolean
  compensates?: string
  groupKind?: string
}
export type RehomeOk = { journalId?: string; replayed?: boolean; planned?: Record<string, unknown>; moved?: Record<string, unknown> }
/** A refusal carries the route's register code (N8-135..N8-141, N8-449, N8-450) or HOST_UNAVAILABLE. */
export type RehomeResult = { ok: true; data: RehomeOk } | { ok: false; code: string; message: string; journal?: string }
export type Rehome = (body: RehomeBody) => Promise<RehomeResult>

type RehomeFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "error" }) => Promise<Response>

/** `http://127.0.0.1:<port>` of the local sidecar, or null: the nonce is never sent anywhere else. */
function loopbackServer(raw: string) {
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.port === "" || u.username || u.password || u.search || u.hash) return null
    return u.origin
  } catch {
    return null
  }
}

/** The rehome caller ipc.ts hands to the handlers: local sidecar only, nonce header, Basic auth, bounded time. */
export function createRehomeCaller(opts: {
  server: () => Promise<ServerReadyData>
  nonce: () => string | undefined
  fetch?: RehomeFetch
  timeoutMs?: number
}): Rehome {
  const doFetch: RehomeFetch = opts.fetch ?? ((u, init) => fetch(u, init))
  const timeoutMs = opts.timeoutMs ?? REHOME_TIMEOUT_MS
  const unavailable = (message: string): RehomeResult => ({ ok: false, code: "HOST_UNAVAILABLE", message })
  return async (body) => {
    const nonce = opts.nonce()
    if (!nonce) return unavailable("the local Swarm server was not started by this app; nothing was moved")
    const data = await opts.server()
    const origin = loopbackServer(data.url)
    if (!origin) return unavailable("moves run only on this app's local Swarm server; nothing was moved")
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(body.from),
      [DESKTOP_NONCE_HEADER]: nonce,
    }
    if (data.password) headers.authorization = `Basic ${Buffer.from(`${data.username ?? "opencode"}:${data.password}`).toString("base64")}`
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), timeoutMs)
    try {
      const response = await doFetch(`${origin}${REHOME_PATH}`, { method: "POST", headers, body: JSON.stringify(body), signal: abort.signal, redirect: "error" })
      const text = await response.text()
      let json: Record<string, unknown> = {}
      try {
        json = text ? (JSON.parse(text) as Record<string, unknown>) : {}
      } catch {}
      if (response.ok) return { ok: true, data: json as RehomeOk }
      const err = (json.data ?? {}) as { code?: unknown; message?: unknown; journal?: unknown }
      if (response.status === 409 && typeof err.code === "string")
        return {
          ok: false,
          code: err.code,
          message: typeof err.message === "string" ? err.message : err.code,
          ...(typeof err.journal === "string" ? { journal: err.journal } : {}),
        }
      if (response.status === 403) return unavailable("the local Swarm server refused the move (desktop check); nothing was moved")
      return { ok: false, code: "HOST_ERROR", message: `the local Swarm server answered HTTP ${response.status}` }
    } catch (error) {
      if (abort.signal.aborted) return { ok: false, code: "TIMEOUT", message: `the move did not answer within ${timeoutMs} ms` }
      return unavailable(`the local Swarm server is not reachable (${error instanceof Error ? error.name : "error"})`)
    } finally {
      clearTimeout(timer)
    }
  }
}

type PlaceData = { decision: string; group: string; replayed?: true }
/** 1.2.8 row 46b: the tidy result; `moved` + `total` count the listed missions that have a group. */
type TidyData = { decision: string; moved: number; total: number }
/** 1.2.8 row 46b: a tidy refusal or stop names its mission; `moved` is present once the answer was recorded. */
export type PlaceFailure = { ok: false; code: string; message: string; mission?: string; moved?: number; total?: number }
type WireAnswer = { option?: unknown; by?: unknown; decision?: unknown; attested?: unknown }
type WireRequest = {
  id?: unknown
  status?: unknown
  topic?: unknown
  options?: Array<{ id?: unknown; group?: unknown; groupKind?: unknown }>
  proposal?: unknown
  answer?: WireAnswer
}
type WireMission = { project?: { dir?: unknown }; sessions?: unknown }
const refused = (reason: string): MissionControlResult<never> => ({ ok: false, code: "PLACE_DECISION_UNANSWERED", message: reason })
const badArg = (message: string): MissionControlResult<never> => ({ ok: false, code: "BAD_ARGUMENT", message })

/** 1.2.8 row 46b (01d §5): the tidy request topic; options approve / decline (N8-147), `proposal` 1..200 (N8-148, C49). */
export const TIDY_TOPIC = "project-tidy"
/** C8 OP-4: a tidy list moves at most this many missions; more go in a second request, approved once on its own. */
export const TIDY_BATCH_MAX = 200

export type PlaceOptions = {
  /** Unscoped read of a listed tidy item (the proposal comes from the store, not from the renderer). */
  getItem?: (mission: string) => Promise<MissionControlResult<unknown>>
  /** True when `<dir>/.swarm/group.json` exists: the mission already sits in a marked group (retry no-op). */
  groupMarker?: (dir: string) => boolean
}

const defaultGroupMarker = (dir: string) => {
  try {
    return lstatSync(posix.join(dir, ".swarm", "group.json")).isFile()
  } catch {
    return false
  }
}

const folderOk = (dir: unknown): dir is string =>
  typeof dir === "string" && dir.startsWith("/") && posix.normalize(dir) === dir && dir !== "/" && !dir.endsWith("/")

const swarmSessions = (mission: WireMission | undefined) => {
  const links = Array.isArray(mission?.sessions) ? (mission.sessions as Array<{ client?: unknown; ref?: unknown }>) : []
  return [
    ...new Set(links.filter((l) => l?.client === MISSION_CONTROL_AGENT && typeof l.ref === "string" && SESSION_ID_RE.test(l.ref)).map((l) => l.ref as string)),
  ]
}

/**
 * 1.2.8 row 46b (C98): an answer the person recorded in Mission Control (by user, from the attested session). Only such
 * an answer may be retried; an answer an agent recorded itself (S-6, F16) never moves anything.
 */
const personAnswer = (req: WireRequest) => req.answer?.by === "user" && req.answer.attested === true

/**
 * The move, then the store update (01d §7.2 steps 4-6, §7.4): shared by placement, its retry and every tidy item.
 * The primitive rolls itself back on a fault; a failed `studio_mission_place` reverses the move with `compensates`.
 */
async function moveAndPlace(
  base: RehomeBody,
  rehome: Rehome,
  place: () => Promise<MissionControlResult<Record<string, unknown>>>,
): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const moved = await rehome(base)
  if (!moved.ok) return { ok: false, code: moved.code, message: moved.journal ?? moved.message }
  const placed = await place()
  if (placed.ok) return { ok: true }
  const journalId = moved.data.journalId
  if (typeof journalId !== "string") return { ok: false, code: "REHOME_ROLLBACK_FAILED", message: placed.message }
  const back = await rehome({ missionId: base.missionId, from: base.to, to: base.from, sessions: base.sessions, approvalRef: base.approvalRef, compensates: journalId })
  if (back.ok) return { ok: false, code: "REHOME_ROLLED_BACK", message: placed.message }
  return { ok: false, code: "REHOME_ROLLBACK_FAILED", message: back.journal ?? journalId }
}

/**
 * Row 46 steps 1-5 for a placement, and (1.2.8 row 46b) the tidy list and the retry of an answered placement.
 * `get` is the caller's scoped get (OUT_OF_SCOPE already applied).
 */
export async function placeMission(
  input: unknown,
  get: (mission: string) => Promise<MissionControlResult<unknown>>,
  client: Pick<MissionControlPlatform, "answer"> & Partial<Pick<MissionControlClient, "setProjectDir">>,
  rehome: Rehome | undefined,
  opts: PlaceOptions = {},
): Promise<MissionControlResult<PlaceData | TidyData> | PlaceFailure> {
  const p = parseAnswerInput(input)
  if (!p.ok) return { ok: false, code: p.code, message: p.message }
  const { mission, request, option } = p.value
  const setProjectDir = client.setProjectDir
  if (!rehome || typeof setProjectDir !== "function") return unavailable
  const got = await get(mission)
  if (!got.ok) return got
  const data = got.data as { mission?: WireMission; requests?: unknown }
  const req = (Array.isArray(data.requests) ? (data.requests as WireRequest[]) : []).find((r) => r?.id === request)
  if (!req) return refused("the placement request is not in this mission")
  if (req.topic === TIDY_TOPIC) return tidyMissions({ mission, request, option, req, holder: data.mission, client, setProjectDir, rehome, opts })
  if (req.topic !== PLACEMENT_TOPIC) return badArg("only a placement request moves a mission")
  // C98 (row 46b): an answered placement whose move did not finish is retried from the move, never re-answered.
  const retry = req.status === "answered" && personAnswer(req) && req.answer?.option === option
  // S-6: an agent may have answered it itself; only a click on an OPEN request (or the person's own answer) moves anything.
  if (req.status !== "open" && !retry) return refused("the placement request is already answered; nothing was moved")
  if (!(PLACE_OPTIONS as readonly string[]).includes(option)) return badArg("only join or new move a mission")
  const chosen = (req.options ?? []).find((o) => o?.id === option)
  if (!chosen) return badArg("option is not one of the request's options")
  if (!groupNameOk(chosen.group)) return badArg("the group name is not valid")
  const from = data.mission?.project?.dir
  if (!folderOk(from)) return badArg("the mission's project folder is not valid")
  // Retry no-op: the mission already sits in that marked group (its place step finished after all).
  if (retry && posix.basename(from) === chosen.group && (opts.groupMarker ?? defaultGroupMarker)(from))
    return { ok: true, data: { decision: String(req.answer?.decision ?? ""), group: chosen.group, replayed: true } }
  const to = posix.join(from, chosen.group)
  if (posix.dirname(to) !== from) return badArg("the group name is not valid")
  const sessions = swarmSessions(data.mission)
  const groupKind = option === "new" && typeof chosen.groupKind === "string" ? { groupKind: chosen.groupKind } : {}
  const base: RehomeBody = { missionId: mission, from, to, sessions, approvalRef: request, ...groupKind }
  const place = () => setProjectDir({ mission, projectDir: to, decision: request })

  if (retry) {
    // The rehome route replays a complete journal for the same (mission, from, to, approvalRef): idempotent.
    const done = await moveAndPlace(base, rehome, place)
    if (!done.ok) return done
    return { ok: true, data: { decision: String(req.answer?.decision ?? ""), group: chosen.group } }
  }
  const dry = await rehome({ ...base, dryRun: true })
  if (!dry.ok) return { ok: false, code: dry.code, message: dry.message }
  const answered = await client.answer({ mission, request, option })
  // SR8-18(d): no recorded answer, no move.
  if (!answered.ok) return answered
  const done = await moveAndPlace(base, rehome, place)
  if (!done.ok) return done
  return { ok: true, data: { decision: answered.data.decision, group: chosen.group } }
}

type TidyItem = { mission: string; group: string; groupKind?: string }

/**
 * 1.2.8 row 46b (AC-PROJg; 01d §5, §7.2; C8 OP-4; U1 "tidy existing missions too"): approve of an OPEN project-tidy
 * request moves exactly the listed missions that have a group, in list order.
 *   1. The list: 1..TIDY_BATCH_MAX items, no duplicate, not the tidy mission itself, every group passes the group-name
 *      rule, and every listed mission (read from the store) sits in the tidy mission's folder (the root) exactly.
 *   2. Preflight every move (dryRun). Any refusal: nothing moves and no answer is recorded (disk unchanged).
 *   3. The answer `approve`, by user, once.
 *   4. Each item: move, then studio_mission_place with `tidyMission`. The first failure stops the loop: that item is
 *      rolled back (by the primitive or by the compensating move), earlier items stay moved, later ones are untouched.
 * `decline` goes through the ordinary `answer` channel; this path refuses it.
 */
async function tidyMissions(a: {
  mission: string
  request: string
  option: string
  req: WireRequest
  holder: WireMission | undefined
  client: Pick<MissionControlPlatform, "answer">
  setProjectDir: MissionControlClient["setProjectDir"]
  rehome: Rehome
  opts: PlaceOptions
}): Promise<MissionControlResult<TidyData> | PlaceFailure> {
  const { mission, request, option, req, rehome } = a
  if (req.status !== "open") return refused("the tidy request is already answered; nothing was moved")
  if (option !== "approve") return badArg("only approve moves the listed missions")
  if (!(req.options ?? []).some((o) => o?.id === "approve")) return badArg("option is not one of the request's options")
  const getItem = a.opts.getItem
  if (!getItem) return unavailable
  const root = a.holder?.project?.dir
  if (!folderOk(root)) return badArg("the tidy mission's project folder is not valid")
  const proposal = Array.isArray(req.proposal) ? (req.proposal as Array<{ mission?: unknown; group?: unknown; groupKind?: unknown }>) : []
  if (proposal.length < 1 || proposal.length > TIDY_BATCH_MAX) return badArg(`a tidy list holds 1 to ${TIDY_BATCH_MAX} missions`)
  const seen = new Set<string>()
  const items: TidyItem[] = []
  for (const line of proposal) {
    const id = typeof line?.mission === "string" && MISSION_ID_RE.test(line.mission) ? line.mission : undefined
    if (!id || seen.has(id) || id === mission) return badArg("the tidy list is not valid")
    seen.add(id)
    if (line.group === null) continue // stays at the root
    if (!groupNameOk(line.group)) return { ok: false, code: "BAD_ARGUMENT", message: "the group name is not valid", mission: id }
    items.push({ mission: id, group: line.group, ...(typeof line.groupKind === "string" ? { groupKind: line.groupKind } : {}) })
  }
  const bases: RehomeBody[] = []
  for (const item of items) {
    const got = await getItem(item.mission)
    if (!got.ok) return { ...got, mission: item.mission }
    const listed = (got.data as { mission?: WireMission }).mission
    if (listed?.project?.dir !== root)
      return { ok: false, code: "REHOME_OUTSIDE_ROOT", message: "the mission is no longer in the Default Project root", mission: item.mission }
    const to = posix.join(root, item.group)
    if (posix.dirname(to) !== root) return { ok: false, code: "BAD_ARGUMENT", message: "the group name is not valid", mission: item.mission }
    bases.push({
      missionId: item.mission,
      from: root,
      to,
      sessions: swarmSessions(listed),
      approvalRef: request,
      ...(item.groupKind ? { groupKind: item.groupKind } : {}),
    })
  }
  for (const base of bases) {
    const dry = await rehome({ ...base, dryRun: true })
    if (!dry.ok) return { ok: false, code: dry.code, message: dry.message, mission: base.missionId }
  }
  const answered = await a.client.answer({ mission, request, option })
  // SR8-18(d): no recorded answer, no move.
  if (!answered.ok) return answered
  let moved = 0
  for (const base of bases) {
    const done = await moveAndPlace(base, rehome, () =>
      a.setProjectDir({ mission: base.missionId, projectDir: base.to, decision: request, tidyMission: mission }),
    )
    if (!done.ok) return { ...done, mission: base.missionId, moved, total: bases.length }
    moved++
  }
  return { ok: true, data: { decision: answered.data.decision, moved, total: bases.length } }
}

export function registerMissionControlHandlers(deps: MissionIpcDeps) {
  const scopes = new WeakMap<object, Scope>()
  const scopeOf = (sender: object) => {
    const known = scopes.get(sender)
    if (known) return known
    const scope: Scope = new Map()
    scopes.set(sender, scope)
    return scope
  }
  const channels = Object.entries(MISSION_CONTROL_IPC) as Array<[keyof MissionControlPlatform, string]>
  for (const [method, channel] of channels) {
    deps.ipcMain.handle(channel, async (event: IpcMainInvokeEvent, input: unknown) => {
      if (!senderOk(deps, event)) {
        deps.log("warn", "mission control call from an unexpected sender refused", { channel })
        return { ok: false, code: "BAD_SENDER", message: "mission control is only available to the Swarm window" }
      }
      const client = deps.client()
      if (!client) return unavailable
      try {
        const scope = scopeOf(event.sender)
        const mission = method === "list" ? undefined : missionOf(input)
        // A missing or malformed id is left to the client's own check (BAD_ARGUMENT, no host call).
        if (mission !== undefined && !scope.has(mission)) return OUT_OF_SCOPE
        // 1.2.8 row 46: the placement runs in main (placeMission); its read is the scoped get below.
        if ((method as string) === "place") {
          const scopedGet = async (id: string) => {
            const got = await client.get({ mission: id })
            const basis = scope.get(id)
            if (got.ok && (!basis || !stillInScope(got.data, basis))) return OUT_OF_SCOPE
            return got
          }
          // 1.2.8 row 46b: tidy items are read unscoped; the list comes from the store and each item must sit at the root.
          const placed = await placeMission(input, scopedGet, client, deps.rehome, { getItem: (id) => client.get({ mission: id }), groupMarker: deps.groupMarker })
          if (!placed.ok)
            deps.log(placed.code === "REHOME_ROLLBACK_FAILED" ? "error" : "warn", "mission placement refused or failed", { channel, code: placed.code })
          return placed
        }
        // The client validates `input` itself (§3.3) before any host call.
        const result = await (client[method] as (input: unknown) => Promise<MissionControlResult<unknown>>)(input)
        if (method === "list") remember(scope, input, result)
        if (method === "get" && mission !== undefined && result.ok) {
          const basis = scope.get(mission)
          if (!basis || !stillInScope(result.data, basis)) return OUT_OF_SCOPE
        }
        return result
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        deps.log("error", "mission control handler failed", { channel, message: err.message, stack_trace: err.stack })
        return { ok: false, code: "INTERNAL_ERROR", message: "mission control failed; details are in the Swarm log" }
      }
    })
  }
}
