// Mission control client in main (row 127; masterplan/01_specs_mission_control_ui.md §1-§3).
//
//   renderer -> preload window.api.missions -> ipc (mission-ipc.ts) -> MissionControlClient -> POST <host>/mcp
//
// - The Bearer token lives only in this closure (built in lifecycle.ts where the token is created). It is never part of
//   a result, an error message or a log line; host text is scrubbed of it anyway.
// - Allow-list: exactly four tools. Any other name throws TOOL_NOT_ALLOWED before a request is made. There is no
//   generic "call tool" channel; each public method builds its tool arguments itself (the renderer adds none).
// - Every argument is validated here (§3.3) before any host call: BAD_ARGUMENT, no request.
// - Dependency-free JSON-RPC over streamable HTTP, as the row 34 bridge (desktop/scripts/datum-studio-bridge.ts):
//   initialize -> keep mcp-session-id -> notifications/initialized -> tools/call; one re-initialise on 404.
// - No model call: the four tools are store reads/writes of the Studio host.
// No Electron import (bun tests run it directly).

import { mkdir } from "node:fs/promises"
import { isAbsolute } from "node:path"
import type {
  MissionControlPlatform,
  MissionControlResult,
  MissionGetWire,
  MissionListItemWire,
} from "../../preload/types"

export const MISSION_CONTROL_TOOLS = [
  "studio_mission_list",
  "studio_mission_get",
  "studio_mission_answer_decision",
  "studio_mission_update_row",
] as const
export type MissionControlTool = (typeof MISSION_CONTROL_TOOLS)[number]

export const MISSION_CONTROL_AGENT = "swarm"
/** N8-459 (1.2.8 SR8-05): header carrying the per-launch Mission Control key, sent on the initialize request only. */
export const MISSION_CONTROL_KEY_HEADER = "x-swarm-mission-control-key"
export const MISSION_CONTROL_ACTOR = "mission-control"
export const MISSION_CALL_TIMEOUT_MS = 5_000
export const MISSION_LIST_STATUSES = ["draft", "approved", "running", "paused", "done"] as const
export const MISSION_LIST_TAKE = 20
export const MISSION_GET_INCLUDE = ["rows", "decisions", "requests", "messages", "deliverables"] as const
/** G3 (row 126); 1.2.7 U-4 (N7-031): the newest 50 messages, the schema maximum (schemas.ts messagesTail). */
export const MISSION_MESSAGES_TAIL = 50
export const INSTRUCTION_MAX_CHARS = 2000
export const DIRECTORY_MAX_CHARS = 4096
/** Row 183 (L36): the current session and its subagent sessions, at most this many ids per list. */
export const MISSION_LIST_SESSIONS_MAX = 50

// §3.3 patterns (store/mission/validate.ts:66-69, MC:54).
export const MISSION_ID_RE = /^\d{4}-\d{2}-\d{2}[_-][a-z0-9][a-z0-9_-]{0,80}$/
export const REQUEST_ID_RE = /^D-[0-9]{1,5}$/
export const OPTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
export const ROW_ID_RE = /^[1-9][0-9]{0,3}[a-z]?$/
/** Row 183: an opencode session id (packages/opencode/src/id/id.ts: "ses_" + 12 hex + 14 base62). */
export const SESSION_ID_RE = /^ses_[A-Za-z0-9]{1,64}$/
const CONTROL_RE = /[\u0000-\u001f]/
const TEXT_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
const USER_DECISION_RE = /^U([0-9]{1,6})$/

export class MissionControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "MissionControlError"
  }
}

type Fail = { ok: false; code: string; message: string }
const fail = (code: string, message: string): Fail => ({ ok: false, code, message })
const bad = (message: string): Fail => fail("BAD_ARGUMENT", message)
type Parsed<T> = { ok: true; value: T } | Fail

function plain(input: unknown, keys: readonly string[], optional: readonly string[] = []): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  const proto = Object.getPrototypeOf(input)
  if (proto !== Object.prototype && proto !== null) return null
  const record = input as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (keys.includes(key)) continue
    // An optional key may be present with the value undefined (structured clone keeps it); any other key is refused.
    if (optional.includes(key)) continue
    return null
  }
  return record
}

const isString = (v: unknown): v is string => typeof v === "string"

// Row 185 (S186-02, L42): shape validation only. The directory and session ids are the renderer's choice; main does
// not check that they are the window's own session, so the mission-ipc.ts scope is a consistency check, not isolation.
// 1.2.7 U-1: the directory scopes the IPC basis only; the host list is filtered by the session ids alone.
export function parseListInput(input: unknown): Parsed<{ directory: string; sessions?: string[] }> {
  const r = plain(input, ["directory"], ["sessions"])
  if (!r) return bad("list takes {directory, sessions?}")
  const d = r.directory
  if (!isString(d) || d.length < 1 || d.length > DIRECTORY_MAX_CHARS) return bad("directory must be 1-4096 characters")
  if (CONTROL_RE.test(d)) return bad("directory has control characters")
  if (!isAbsolute(d)) return bad("directory must be absolute")
  if (r.sessions === undefined) return { ok: true, value: { directory: d } }
  // Row 183 (L36): the session ids whose linked missions are listed too.
  if (!Array.isArray(r.sessions) || r.sessions.length > MISSION_LIST_SESSIONS_MAX) return bad(`sessions must be an array of at most ${MISSION_LIST_SESSIONS_MAX} ids`)
  if (!r.sessions.every((id) => isString(id) && SESSION_ID_RE.test(id))) return bad("session id is not valid")
  return { ok: true, value: { directory: d, sessions: [...new Set(r.sessions as string[])] } }
}

function missionOf(r: Record<string, unknown>): string | null {
  return isString(r.mission) && MISSION_ID_RE.test(r.mission) ? r.mission : null
}

export function parseGetInput(input: unknown): Parsed<{ mission: string }> {
  const r = plain(input, ["mission"])
  if (!r) return bad("get takes {mission}")
  const mission = missionOf(r)
  if (!mission) return bad("mission id is not valid")
  return { ok: true, value: { mission } }
}

export function parseAnswerInput(input: unknown): Parsed<{ mission: string; request: string; option: string }> {
  const r = plain(input, ["mission", "request", "option"])
  if (!r) return bad("answer takes {mission, request, option}")
  const mission = missionOf(r)
  if (!mission) return bad("mission id is not valid")
  if (!isString(r.request) || !REQUEST_ID_RE.test(r.request)) return bad("request id is not valid")
  if (!isString(r.option) || !OPTION_ID_RE.test(r.option)) return bad("option id is not valid")
  return { ok: true, value: { mission, request: r.request, option: r.option } }
}

export function parseInstructInput(input: unknown): Parsed<{ mission: string; text: string; row?: string }> {
  const r = plain(input, ["mission", "text"], ["row"])
  if (!r) return bad("instruct takes {mission, text, row?}")
  const mission = missionOf(r)
  if (!mission) return bad("mission id is not valid")
  if (!isString(r.text)) return bad("text is required")
  const text = r.text.trim()
  if (text.length < 1 || text.length > INSTRUCTION_MAX_CHARS) return bad("text must be 1-2000 characters")
  if (TEXT_CONTROL_RE.test(text)) return bad("text has control characters")
  if (r.row !== undefined && (!isString(r.row) || !ROW_ID_RE.test(r.row))) return bad("row id is not valid")
  return { ok: true, value: { mission, text, ...(isString(r.row) ? { row: r.row } : {}) } }
}

/** The part of global fetch this client uses (tests pass a recorder). */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; redirect: "error" }) => Promise<Response>

export type MissionControlClientOptions = {
  /** `http://127.0.0.1:<port>/mcp` from the host's ready message. */
  url: string
  token: string
  /**
   * 1.2.8 SR8-05 (row 45c): the per-launch Mission Control key from lifecycle.ts. Sent as MISSION_CONTROL_KEY_HEADER on
   * each initialize request (so a re-initialise is attested too), never on other requests; scrubbed like the token.
   */
  missionControlKey?: string
  /** The folder main owns and sends as X-Studio-Caller-Cwd (created 0700 on first use, never a renderer path). */
  callerCwd: string
  /** False once the host stopped or exited: calls answer HOST_UNAVAILABLE without a request. */
  running?: () => boolean
  fetch?: FetchLike
  timeoutMs?: number
  log?: (level: "info" | "warn" | "error", source: string, message: string, context?: Record<string, unknown>) => void
}

export type MissionControlClient = MissionControlPlatform & {
  /** Low level, allow-listed. Exported for the tests of the allow-list; ipc never calls it. */
  callTool(name: string, args: Record<string, unknown>): Promise<MissionControlResult<Record<string, unknown>>>
}

type Json = Record<string, unknown>

/** `http://127.0.0.1:<port>/mcp` normalised, or null for anything else. */
export function loopbackMcpUrl(raw: string): string | null {
  try {
    const u = new URL(raw)
    if (u.protocol !== "http:" || u.hostname !== "127.0.0.1" || u.port === "" || u.pathname !== "/mcp" || u.username || u.password || u.search || u.hash) return null
    return u.href
  } catch {
    return null
  }
}

export function createMissionControlClient(opts: MissionControlClientOptions): MissionControlClient {
  // Loopback only (Studio spec §9.1): the Bearer token is never sent anywhere else. Checked here, refused per call
  // (HOST_UNAVAILABLE, no request) so a bad URL never fails the host start.
  const url = loopbackMcpUrl(opts.url)
  const token = opts.token
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init))
  const timeoutMs = opts.timeoutMs ?? MISSION_CALL_TIMEOUT_MS
  const log = opts.log ?? (() => undefined)
  let sessionId: string | undefined
  let protocolVersion: string | undefined
  let session: Promise<void> | undefined
  let nextId = 1
  let cwdReady: Promise<void> | undefined

  const missionKey = opts.missionControlKey
  const scrub = (text: string) => {
    let out = token ? text.split(token).join("[token]") : text
    if (missionKey) out = out.split(missionKey).join("[key]")
    return out
  }

  function headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-studio-agent": MISSION_CONTROL_AGENT,
      "x-studio-caller-cwd": encodeURIComponent(opts.callerCwd),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...extra,
    }
    if (sessionId) h["mcp-session-id"] = sessionId
    if (protocolVersion) h["mcp-protocol-version"] = protocolVersion
    return h
  }

  /**
   * One exchange under one TIMEOUT (spec §3.3; row 136 M1): the deadline covers the request, the headers AND the reply
   * body. The host sends SSE headers before the tool result (MCP SDK streamable HTTP), so a timer cleared after the
   * headers would let a hung tool call wait forever. On expiry the request is aborted and TIMEOUT is thrown even when the
   * body stream ignores the abort.
   */
  async function exchange<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort()
        reject(new MissionControlError("TIMEOUT", `DATUM Studio did not answer within ${timeoutMs} ms`))
      }, timeoutMs)
    })
    try {
      return await Promise.race([work(abort.signal), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  async function post(body: Json, signal: AbortSignal): Promise<Response> {
    // SR8-05: the key rides only on initialize, the request whose session the host attests.
    const extra: Record<string, string> = body.method === "initialize" && missionKey ? { [MISSION_CONTROL_KEY_HEADER]: missionKey } : {}
    try {
      return await doFetch(url!, { method: "POST", headers: headers(extra), body: JSON.stringify(body), signal, redirect: "error" })
    } catch (error) {
      if (signal.aborted) throw new MissionControlError("TIMEOUT", `DATUM Studio did not answer within ${timeoutMs} ms`)
      throw new MissionControlError("HOST_UNAVAILABLE", `DATUM Studio is not reachable (${error instanceof Error ? error.name : "error"})`)
    }
  }

  /** JSON body or a server-sent event stream; returns the JSON-RPC message answering `id`. */
  async function readReply(response: Response, id: number): Promise<Json> {
    const type = response.headers.get("content-type") ?? ""
    const text = await response.text()
    const messages: unknown[] = []
    if (type.includes("text/event-stream")) {
      let data: string[] = []
      const flush = () => {
        if (data.length > 0) {
          try {
            messages.push(JSON.parse(data.join("\n")))
          } catch {}
        }
        data = []
      }
      for (const raw of text.split("\n")) {
        const line = raw.replace(/\r$/, "")
        if (line === "") flush()
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
      }
      flush()
    } else if (text.trim() !== "") {
      try {
        const body = JSON.parse(text) as unknown
        messages.push(...(Array.isArray(body) ? body : [body]))
      } catch {
        throw new MissionControlError("HOST_PROTOCOL", "DATUM Studio answered with something that is not JSON")
      }
    }
    const reply = messages.find((m): m is Json => !!m && typeof m === "object" && (m as Json).id === id)
    if (!reply) throw new MissionControlError("HOST_PROTOCOL", "DATUM Studio did not answer the request")
    return reply
  }

  function statusError(status: number) {
    if (status === 401 || status === 403) return new MissionControlError("HOST_UNAVAILABLE", "DATUM Studio refused mission control")
    return new MissionControlError("HOST_ERROR", `DATUM Studio answered HTTP ${status}`)
  }

  async function ensureCwd() {
    cwdReady ??= mkdir(opts.callerCwd, { recursive: true, mode: 0o700 }).then(
      () => undefined,
      (error) => {
        cwdReady = undefined
        throw new MissionControlError("HOST_UNAVAILABLE", `mission control folder could not be created (${(error as NodeJS.ErrnoException).code ?? "error"})`)
      },
    )
    return cwdReady
  }

  async function initialize() {
    await ensureCwd()
    sessionId = undefined
    protocolVersion = undefined
    const id = nextId++
    await exchange(async (signal) => {
      const response = await post(
        {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "swarm-mission-control", version: "1" } },
        },
        signal,
      )
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw statusError(response.status)
      }
      const sid = response.headers.get("mcp-session-id")
      const reply = await readReply(response, id)
      const result = reply.result as Json | undefined
      if (!sid || !result) throw new MissionControlError("HOST_PROTOCOL", "DATUM Studio did not open a session")
      // A reply that arrives after the deadline must not set the session of a later initialize.
      if (signal.aborted) return
      sessionId = sid
      if (typeof result.protocolVersion === "string") protocolVersion = result.protocolVersion
    })
    await exchange(async (signal) => {
      const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, signal)
      await note.body?.cancel().catch(() => undefined)
      if (!note.ok) throw statusError(note.status)
    })
  }

  function ensureSession() {
    session ??= initialize().catch((error) => {
      session = undefined
      throw error
    })
    return session
  }

  async function rpcCall(name: MissionControlTool, args: Json, retried = false): Promise<Json> {
    await ensureSession()
    const id = nextId++
    const outcome = await exchange(async (signal): Promise<{ retry: true } | { retry: false; reply: Json }> => {
      const response = await post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, signal)
      if (response.status === 404 && !retried) {
        await response.body?.cancel().catch(() => undefined)
        return { retry: true }
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        throw statusError(response.status)
      }
      // Parsed inside the exchange: the TIMEOUT also covers the reply body (row 136 M1).
      return { retry: false, reply: await readReply(response, id) }
    })
    if (outcome.retry) {
      // The host lost the session (it restarted or closed it): open a new one once.
      session = undefined
      return rpcCall(name, args, true)
    }
    const reply = outcome.reply
    if (reply.error) {
      const e = reply.error as Json
      throw new MissionControlError("HOST_ERROR", isString(e.message) ? e.message : "DATUM Studio refused the call")
    }
    return (reply.result ?? {}) as Json
  }

  async function callTool(name: string, args: Json): Promise<MissionControlResult<Json>> {
    if (!(MISSION_CONTROL_TOOLS as readonly string[]).includes(name))
      throw new MissionControlError("TOOL_NOT_ALLOWED", `mission control does not call ${JSON.stringify(name).slice(0, 80)}`)
    if (!url) return fail("HOST_UNAVAILABLE", "the DATUM Studio endpoint is not a loopback /mcp URL")
    if (opts.running && !opts.running()) return fail("HOST_UNAVAILABLE", "DATUM Studio is not running")
    try {
      const result = await rpcCall(name as MissionControlTool, args)
      const structured = result.structuredContent as Json | undefined
      if (!structured || typeof structured !== "object") return fail("HOST_PROTOCOL", "DATUM Studio returned no structured result")
      if (structured.ok !== true) {
        const error = (structured.error ?? {}) as Json
        const code = isString(structured.code) ? structured.code : "HOST_ERROR"
        // `details` are dropped (spec §3.3); only code and message cross to the renderer.
        return fail(code, scrub(isString(error.message) ? error.message : "DATUM Studio refused the call"))
      }
      const { ok: _ok, tool: _tool, ...data } = structured
      return { ok: true, data }
    } catch (error) {
      if (error instanceof MissionControlError) {
        if (error.code !== "TIMEOUT") log("warn", "mission-control", scrub(error.message), { code: error.code, tool: name })
        return fail(error.code, scrub(error.message))
      }
      const err = error instanceof Error ? error : new Error(String(error))
      log("error", "mission-control", scrub(err.message), { tool: name, stack_trace: err.stack ? scrub(err.stack) : undefined })
      return fail("INTERNAL_ERROR", "mission control failed; details are in the Swarm log")
    }
  }

  const pick = <T>(data: Json, keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, data[k]])) as T

  async function list(input: unknown): Promise<MissionControlResult<{ items: MissionListItemWire[] }>> {
    const p = parseListInput(input)
    if (!p.ok) return p
    // 1.2.7 U-1 (U2): sessions only, never the project folder - the store's linked-session branch alone answers.
    // No session ids: an empty list without a host call, so a renderer that omits them never sees the whole project.
    const sessions = p.value.sessions ?? []
    if (sessions.length === 0) return { ok: true, data: { items: [] } }
    const r = await callTool("studio_mission_list", { status: [...MISSION_LIST_STATUSES], take: MISSION_LIST_TAKE, sessions })
    if (!r.ok) return r
    return { ok: true, data: { items: Array.isArray(r.data.items) ? (r.data.items as MissionListItemWire[]) : [] } }
  }

  async function get(input: unknown): Promise<MissionControlResult<MissionGetWire>> {
    const p = parseGetInput(input)
    if (!p.ok) return p
    const r = await callTool("studio_mission_get", { mission: p.value.mission, include: [...MISSION_GET_INCLUDE], messagesTail: MISSION_MESSAGES_TAIL })
    if (!r.ok) return r
    const data = pick<MissionGetWire>(r.data, ["mission", "derived", "requests", "messages", "deliverables"])
    return { ok: true, data: { ...data, requests: data.requests ?? [], messages: data.messages ?? [], deliverables: data.deliverables ?? [] } }
  }

  /** §2: next free user decision id among the mission's decisions (ids are mission-local). */
  async function nextUserDecision(mission: string): Promise<MissionControlResult<string>> {
    const r = await callTool("studio_mission_get", { mission, include: ["decisions"] })
    if (!r.ok) return r
    const decisions = ((r.data.mission as Json | undefined)?.decisions ?? []) as Array<{ id?: unknown }>
    let max = 0
    for (const d of decisions) {
      const m = isString(d?.id) ? USER_DECISION_RE.exec(d.id) : null
      if (m) max = Math.max(max, Number(m[1]))
    }
    return { ok: true, data: `U${max + 1}` }
  }

  async function answer(input: unknown): Promise<MissionControlResult<{ decision: string; released: string[] }>> {
    const p = parseAnswerInput(input)
    if (!p.ok) return p
    for (let attempt = 0; attempt < 2; attempt++) {
      const id = await nextUserDecision(p.value.mission)
      if (!id.ok) return id
      const r = await callTool("studio_mission_answer_decision", {
        mission: p.value.mission,
        request: p.value.request,
        option: p.value.option,
        by: "user",
        decisionId: id.data,
        actor: MISSION_CONTROL_ACTOR,
      })
      // R3: the agent recorded a decision at the same moment; re-read and retry once.
      if (!r.ok && r.code === "DECISION_ID_TAKEN" && attempt === 0) continue
      if (!r.ok) return r
      const decision = (r.data.decision ?? {}) as Json
      const released = Array.isArray(r.data.released) ? r.data.released.filter(isString) : []
      return { ok: true, data: { decision: isString(decision.id) ? decision.id : id.data, released } }
    }
    return fail("DECISION_ID_TAKEN", "the decision id was taken twice; try again")
  }

  async function instruct(input: unknown): Promise<MissionControlResult<{ seq: number }>> {
    const p = parseInstructInput(input)
    if (!p.ok) return p
    const message = { from: "owner", to: "controller", kind: "instruction", text: p.value.text, ...(p.value.row ? { row: p.value.row } : {}) }
    // No `rows`: an instruction never patches a row (spec §2).
    const r = await callTool("studio_mission_update_row", { mission: p.value.mission, messages: [message], actor: MISSION_CONTROL_ACTOR })
    if (!r.ok) return r
    const posted = Array.isArray(r.data.messages) ? (r.data.messages as Array<{ seq?: unknown }>) : []
    const seq = posted[0]?.seq
    if (typeof seq !== "number") return fail("HOST_PROTOCOL", "DATUM Studio did not return the stored message")
    return { ok: true, data: { seq } }
  }

  return { list, get, answer, instruct, callTool }
}
