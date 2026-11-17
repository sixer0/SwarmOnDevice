// MC-1 item 2 / MC-6 (1.3.3 row 9): which mission a session is working on, learned from its own Studio mission calls.
//
// Before this module no session code held a mission id: the only link was the session id sent to Studio in `_meta`
// (`McpCatalog.callerSessionMeta`). The session loop needs the other direction, cheaply and without a call to Studio:
// "does this session still have a running row?" (an empty final step is then continued, row 11) and "what must the
// summary carry over a compaction?" (mission id, running rows, held locks, knowledge list; rows 104, 105).
//
// How it is filled
// `observe` is called from `session/tools.ts` for every SUCCESSFUL call of a tool of the built-in datum-studio server
// (global origin only; a refusal throws before it gets there). It reads the call's arguments and the host's
// `structuredContent` (`{ok: true, tool, ...data}`, datum-studio `mcp-host/mission/tool-result.ts` `okResult`):
//
// | tool                        | read from                                         | effect                                   |
// |-----------------------------|---------------------------------------------------|------------------------------------------|
// | studio_mission_create       | result `id`, `knowledge.rows[]`                   | bind, no rows yet; matched knowledge     |
// | studio_mission_set_status   | result `id`, `to`                                 | done / cancelled: clear; else bind       |
// | studio_mission_update_row   | args `mission`, `rows[]`; result `results[]`,     | bind; rows, locks from applied patches;  |
// |                             | `knowledge.rows[]`                                | knowledge of the rows it started         |
// | studio_mission_get          | result `mission.{id,status,rows,locks}`           | refresh; closed: clear                   |
// | studio_mission_list         | result `items[].{id,status}`                      | only clears a bound mission shown closed |
//
// Rules
// - A result that does not match these shapes changes nothing. Nothing here throws on any input.
// - A dry run (`dryRun: true` in the arguments or in the result) wrote nothing, so it changes nothing.
// - A write to another mission moves the binding to it (the shape holds one mission per session; the session's last
//   write names the mission it is working on). A read never moves it: reading another mission is not working on it. A
//   read binds only a session that has no binding, which is how the binding comes back after a restart.
// - Locks are not released by a row reaching `done` (the store releases them on an explicit `release` and when the
//   mission closes), so a lock stays listed until one of those, or until a `get` shows it released.
// - `knowledge` (row 152, S3) comes from the host's replies: create lists the rows it matched (none running yet),
//   update_row the rows it started (replacing what create said for them), and a row that leaves `running` or closes
//   drops its entries. A `get` replaces the whole list with the running rows it shows, as before. It is what the
//   summary needs to resume the work.
//
// Scope
// - Per session id, never shared: a sub-agent session has its own binding, filled only by its own mission calls. It
//   does not inherit its parent's. The controller's running rows are the controller's to close; an inherited binding
//   would make the loop push a sub-agent that has just returned its answer to "continue or set the row's status".
// - In memory, in this process: it survives a compaction (same process, same session id) and not an app restart. It
//   is not stored: recovering it needs a call to Studio, and the agent's next mission call (the auto-continue line
//   asks for `studio_mission_get`) restores it.
// - Bounded: at most MAX_SESSIONS sessions, the least recently updated dropped first.
//
// This module has no imports and no side effects besides its own map, so the loop, the compaction and tests can all
// read it without a service.

/** Register section 4: the binding of one session. */
export type MissionBinding = {
  missionID: string
  /** Row ids this session set to `running`, or that a `get` showed running. */
  runningRows: string[]
  /** Resource names of the locks held (not released). */
  locks: string[]
  /** For running rows and rows matched at create not yet started: the library domain and the first file to read. Empty when unknown. */
  knowledge: Array<{ row: string; domain: string; firstFile: string }>
  /** `Date.now()` of the last change. */
  updatedAt: number
}

/** What a call did to the session's binding. */
export type Outcome = "set" | "cleared" | "none"

export type Observed = {
  sessionID: string
  /** The tool's own name on the server, without the server prefix: `studio_mission_get`. */
  tool: string
  /** The arguments that were sent. */
  args: unknown
  /** The MCP result (`{content, structuredContent}`); anything else changes nothing. */
  result: unknown
}

/** More sessions than this are never held; the least recently updated goes first. */
export const MAX_SESSIONS = 500
const MAX_ROWS = 200
const MAX_LOCKS = 64
const MAX_KNOWLEDGE = 25

const CLOSED = new Set(["done", "cancelled"])
const OPEN = new Set(["draft", "approved", "running", "paused"])

// Insertion order is the age order: every write re-inserts its session at the end.
const bindings = new Map<string, MissionBinding>()

type Rec = Record<string, unknown>

function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : []
}

function copy(binding: MissionBinding): MissionBinding {
  return {
    missionID: binding.missionID,
    runningRows: [...binding.runningRows],
    locks: [...binding.locks],
    knowledge: binding.knowledge.map((item) => ({ ...item })),
    updatedAt: binding.updatedAt,
  }
}

function put(sessionID: string, next: Omit<MissionBinding, "updatedAt">): Outcome {
  bindings.delete(sessionID)
  bindings.set(sessionID, {
    missionID: next.missionID,
    runningRows: [...new Set(next.runningRows)].slice(0, MAX_ROWS),
    locks: [...new Set(next.locks)].slice(0, MAX_LOCKS),
    knowledge: next.knowledge.slice(0, MAX_KNOWLEDGE),
    updatedAt: Date.now(),
  })
  while (bindings.size > MAX_SESSIONS) {
    const oldest = bindings.keys().next()
    if (oldest.done) break
    bindings.delete(oldest.value)
  }
  return "set"
}

/** The binding to continue from for a write to `missionID`: the current one when it is the same mission, else empty. */
function base(sessionID: string, missionID: string): Omit<MissionBinding, "updatedAt"> {
  const current = bindings.get(sessionID)
  if (current && current.missionID === missionID) return copy(current)
  return { missionID, runningRows: [], locks: [], knowledge: [] }
}

function drop(sessionID: string, missionID: string): Outcome {
  if (bindings.get(sessionID)?.missionID !== missionID) return "none"
  bindings.delete(sessionID)
  return "cleared"
}

function onCreate(sessionID: string, data: Rec): Outcome {
  const id = text(data.id)
  if (!id) return "none"
  // Row 152 (S3): the rows the host matched at create (none is running yet) are carried until they start or close.
  return put(sessionID, { missionID: id, runningRows: [], locks: [], knowledge: replyKnowledge(data.knowledge) })
}

function onSetStatus(sessionID: string, data: Rec): Outcome {
  const id = text(data.id)
  const to = text(data.to)
  if (!id || !to) return "none"
  if (CLOSED.has(to)) return drop(sessionID, id)
  if (!OPEN.has(to)) return "none"
  return put(sessionID, base(sessionID, id))
}

function onUpdateRow(sessionID: string, args: Rec, data: Rec): Outcome {
  const mission = text(args.mission)
  if (!mission || !Array.isArray(args.rows) || !Array.isArray(data.results)) return "none"
  // The host gives one result per patch that carries more than `id` and `checkpoint`, in order (mission-tools.ts
  // `rowPatches`); a checkpoint-only patch has no result. A result whose id differs from its patch means the shapes
  // no longer line up, and then nothing is read.
  const patches = args.rows
    .map((item) => rec(item))
    .filter((item): item is Rec => item !== undefined)
    .filter((item) => Object.keys(item).some((key) => key !== "id" && key !== "checkpoint"))
  const results = data.results.map((item) => rec(item))
  if (results.length !== patches.length) return "none"
  for (let i = 0; i < patches.length; i++) if (results[i]?.id !== patches[i].id) return "none"

  const next = base(sessionID, mission)
  const running = new Set(next.runningRows)
  const locks = new Set(next.locks)
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i]
    const id = text(patch.id)
    if (!id || results[i]?.ok !== true) continue
    const status = text(patch.status)
    if (status === "running") running.add(id)
    else if (status) running.delete(id)
    for (const name of texts(patch.acquire)) locks.add(name)
    for (const name of texts(patch.release)) locks.delete(name)
  }
  // Row 152 (S3): a row that left `running` (or closed) drops its knowledge; a row this call started takes the list the
  // reply gives for it (`knowledge.rows`, mission-tools.ts row 101), in place of what create said. Rows not yet started
  // keep what create listed.
  const left = new Set<string>()
  const started = new Set<string>()
  for (let i = 0; i < patches.length; i++) {
    const id = text(patches[i].id)
    const status = text(patches[i].status)
    if (!id || results[i]?.ok !== true || !status) continue
    if (status === "running") started.add(id)
    else left.add(id)
  }
  const fresh = replyKnowledge(data.knowledge).filter((item) => started.has(item.row))
  const listed = new Set(fresh.map((item) => item.row))
  return put(sessionID, {
    missionID: mission,
    runningRows: [...running],
    locks: [...locks],
    knowledge: [...next.knowledge.filter((item) => !left.has(item.row) && !listed.has(item.row)), ...fresh],
  })
}

/**
 * Row 152 (S3): the `knowledge.rows[]` of a create or update_row reply, as binding entries. Defensive: a row without a
 * string id, or a domain without both `domain` and `firstFile` strings, is skipped; anything else gives an empty list.
 * The mission title's hits (`knowledge.mission`, create only) belong to no row and are not read.
 */
function replyKnowledge(value: unknown): MissionBinding["knowledge"] {
  const rows = rec(value)?.rows
  if (!Array.isArray(rows)) return []
  const out: MissionBinding["knowledge"] = []
  for (const item of rows) {
    const entry = rec(item)
    const row = text(entry?.row)
    const domains = entry?.domains
    if (!row || !Array.isArray(domains)) continue
    for (const hit of domains) {
      const domain = text(rec(hit)?.domain)
      const firstFile = text(rec(hit)?.firstFile)
      if (domain && firstFile) out.push({ row, domain, firstFile })
    }
  }
  return out
}

function onGet(sessionID: string, args: Rec, data: Rec): Outcome {
  const mission = rec(data.mission)
  const id = text(mission?.id)
  const status = text(mission?.status)
  if (!mission || !id || !status) return "none"
  if (CLOSED.has(status)) return drop(sessionID, id)
  if (!OPEN.has(status)) return "none"
  const current = bindings.get(sessionID)
  if (current && current.missionID !== id) return "none"

  const next = base(sessionID, id)
  if (Array.isArray(mission.rows)) {
    const runningRows: string[] = []
    const knowledge: MissionBinding["knowledge"] = []
    for (const item of mission.rows) {
      const row = rec(item)
      const rowID = text(row?.id)
      if (!row || !rowID || row.status !== "running") continue
      runningRows.push(rowID)
      const domains = rec(row.knowledge)?.domains
      if (!Array.isArray(domains)) continue
      for (const entry of domains) {
        const domain = text(rec(entry)?.domain)
        const firstFile = text(rec(entry)?.firstFile)
        if (domain && firstFile) knowledge.push({ row: rowID, domain, firstFile })
      }
    }
    next.runningRows = runningRows
    next.knowledge = knowledge
  }
  if (Array.isArray(mission.locks)) {
    next.locks = mission.locks.flatMap((item) => {
      const lock = rec(item)
      const resource = text(lock?.resource)
      return lock && resource && lock.releasedAt === undefined ? [resource] : []
    })
  } else if (mission.locks === undefined && Array.isArray(mission.rows) && locksAsked(args)) {
    // The host leaves `locks` out when the mission has none (mission-tools.ts: `has("locks") && got.mission.locks`).
    next.locks = []
  }
  return put(sessionID, next)
}

/** Whether this `get` asked for locks: no `include` means the whole mission. */
function locksAsked(args: Rec): boolean {
  return args.include === undefined || args.include === null || (Array.isArray(args.include) && args.include.includes("locks"))
}

function onList(sessionID: string, data: Rec): Outcome {
  const current = bindings.get(sessionID)
  if (!current || !Array.isArray(data.items)) return "none"
  for (const item of data.items) {
    const entry = rec(item)
    if (entry?.id === current.missionID && typeof entry.status === "string" && CLOSED.has(entry.status))
      return drop(sessionID, current.missionID)
  }
  return "none"
}

/**
 * Read one successful Studio tool call and update the calling session's binding.
 * Call it only for tools of the built-in datum-studio server. Never throws.
 */
export function observe(input: Observed): Outcome {
  try {
    if (!text(input?.sessionID) || typeof input.tool !== "string" || !input.tool.startsWith("studio_mission_")) return "none"
    const result = rec(input.result)
    if (!result || result.isError === true) return "none"
    const data = rec(result.structuredContent)
    // `tool` in the envelope must be the tool that was called: a result of another shape is not parsed as this one.
    if (!data || data.ok !== true || data.tool !== input.tool) return "none"
    const args = rec(input.args) ?? {}
    if (args.dryRun === true || data.dryRun === true) return "none"
    switch (input.tool) {
      case "studio_mission_create":
        return onCreate(input.sessionID, data)
      case "studio_mission_set_status":
        return onSetStatus(input.sessionID, data)
      case "studio_mission_update_row":
        return onUpdateRow(input.sessionID, args, data)
      case "studio_mission_get":
        return onGet(input.sessionID, args, data)
      case "studio_mission_list":
        return onList(input.sessionID, data)
      default:
        return "none"
    }
  } catch {
    // Only reachable through a hostile getter on the result; the binding stays as it was.
    return "none"
  }
}

/** The session's binding (a copy), or undefined when the session has none. */
export function get(sessionID: string): MissionBinding | undefined {
  const binding = bindings.get(sessionID)
  return binding ? copy(binding) : undefined
}

/** Row 11: does this session have a mission with a running row? */
export function hasRunningRow(sessionID: string): boolean {
  return (bindings.get(sessionID)?.runningRows.length ?? 0) > 0
}

/** Forget one session's binding (a deleted session). */
export function clear(sessionID: string): void {
  bindings.delete(sessionID)
}

/** Forget every binding (tests). */
export function reset(): void {
  bindings.clear()
}

export * as MissionBinding from "./mission-binding"
