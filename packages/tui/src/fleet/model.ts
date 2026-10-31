import type {
  GlobalAgentsInstance,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
} from "@opencode-ai/sdk/v2"

export type FleetState = "waiting" | "failed" | "running" | "done"

export type FleetPending =
  | {
      kind: "permission"
      id: string
      label: string
      description?: string
      /** Diff or extra lines worth reading before deciding. */
      detail: string[]
      always: string[]
    }
  | {
      kind: "question"
      id: string
      label: string
      options: string[]
      /** One question with single-choice options can be answered by a number key; anything else needs the session. */
      answerable: boolean
    }

export type FleetAgent = {
  sessionID: string
  parentID?: string
  title: string
  directory: string
  state: FleetState
  since: number
  activity?: string
  tail: string[]
  error?: string
  pending?: FleetPending
}

/** What one Swarm process publishes for the others on this machine. */
export type FleetEntry = {
  version: 1
  pid: number
  host: string
  directory: string
  /** The attach URL. Absent for the private in-process server every plain `swarm` runs. */
  server?: string
  tmux?: { socket: string; pane: string }
  updated: number
  agents: FleetAgent[]
}

export type FleetRow = FleetAgent & {
  key: string
  where:
    | { kind: "here" }
    /** `pane` is set only when this client can actually switch to it: same tmux server, known pane. */
    | { kind: "peer"; pid: number; pane?: string; otherTmux: boolean }
}

export type FleetHistory = {
  lines: string[]
  error?: string
  updated: number
  hasReply: boolean
  /** The last step never finished. With no process running it, whatever was driving it died or was quit. */
  unfinished?: boolean
}

const DONE_WINDOW = 30 * 60 * 1000
export const FAILED_WINDOW = 8 * 60 * 60 * 1000
const DONE_LIMIT = 5
const TAIL_LINES = 8
const LINE_WIDTH = 160
const DETAIL_LINES = 30

const INTERRUPTED = "Stopped before finishing: the Swarm running it was closed"

const clip = (text: string, width = LINE_WIDTH) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > width ? line.slice(0, width - 1) + "…" : line
}

const asText = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined)

export function describePermission(request: PermissionRequest): FleetPending {
  const command = asText(request.metadata?.command)
  const file = asText(request.metadata?.filepath)
  const target = command ?? file ?? request.patterns.join(" ")
  const diff = asText(request.metadata?.diff)
  return {
    kind: "permission",
    id: request.id,
    // The literal command or path: a person cannot approve what the row does not show.
    label: request.permission === "bash" ? `$ ${target}` : clip(`${request.permission.replaceAll("_", " ")} ${target}`.trim()),
    description: asText(request.metadata?.description),
    detail: diff ? diffBody(diff) : [],
    always: request.always,
  }
}

/** The path is already on screen: skip the Index/---/+++ header and show the changed lines. */
function diffBody(diff: string) {
  const lines = diff.split("\n")
  const start = lines.findIndex((line) => line.startsWith("@@"))
  return lines
    .slice(start < 0 ? 0 : start)
    .filter((line, index, all) => line.length > 0 || index < all.length - 1)
    .slice(0, DETAIL_LINES)
    .map((line) => line.slice(0, LINE_WIDTH))
}

export function describeQuestion(request: QuestionRequest): FleetPending {
  const first = request.questions[0]
  return {
    kind: "question",
    id: request.id,
    label: clip(first?.question ?? "Question"),
    options: (first?.options ?? []).map((option) => clip(option.label, 60)),
    answerable: request.questions.length === 1 && !first?.multiple && (first?.options.length ?? 0) > 0,
  }
}

function toolLine(part: Extract<Part, { type: "tool" }>) {
  const input = part.state.input as Record<string, unknown> | undefined
  const target =
    asText(input?.command) ??
    asText(input?.filePath) ??
    asText(input?.pattern) ??
    asText(input?.description) ??
    asText(part.state.status === "running" || part.state.status === "completed" ? part.state.title : undefined)
  const mark = part.state.status === "error" ? "✕ " : part.state.status === "running" ? "… " : ""
  return clip(`${mark}${part.tool}${target ? " " + target : ""}`)
}

/** Turns stored messages into the few lines a person glances at: what the agent last did and said. */
export function summarizeHistory(
  messages: ReadonlyArray<{ info: Message; parts: ReadonlyArray<Part> }>,
  updated: number,
): FleetHistory {
  const lines = messages.flatMap((message) =>
    message.parts.flatMap((part) => {
      if (part.type === "tool") return [toolLine(part)]
      if (part.type !== "text" || part.synthetic) return []
      const text = clip(part.text.split("\n").find((line) => line.trim()) ?? "")
      if (!text) return []
      return [message.info.role === "user" ? `> ${text}` : text]
    }),
  )
  const last = messages.findLast((message) => message.info.role === "assistant")?.info
  const error = last?.role === "assistant" ? last.error : undefined
  return {
    lines: lines.slice(-TAIL_LINES),
    error: error && error.name !== "MessageAbortedError" ? errorText(error) : undefined,
    updated,
    hasReply: last !== undefined,
    unfinished: last?.role === "assistant" && !error && last.time.completed === undefined,
  }
}

function errorText(error: { name: string; data?: unknown }) {
  const data = error.data as { message?: unknown } | undefined
  return clip(asText(data?.message) ?? error.name)
}

/** Everything one server knows, as rows a person can act on. Subagents roll up unless one is blocked on the user. */
export function collectAgents(input: {
  instances: ReadonlyArray<GlobalAgentsInstance>
  sessions: ReadonlyMap<string, Session>
  history: ReadonlyMap<string, FleetHistory>
  errors?: ReadonlyMap<string, { message: string; time: number }>
  firstSeen?: Map<string, number>
  now: number
}): FleetAgent[] {
  const pendingBySession = new Map<string, { pending: FleetPending; directory: string }>()
  // Requests the agent moved on from. While it works they say nothing about it. Once it stops they are decisions left over.
  const skippedBySession = new Map<string, { pending: FleetPending; directory: string }>()
  const busy = new Map<string, { directory: string; retry?: string }>()
  input.instances.forEach((instance) => {
    const hold = (sessionID: string, movedOn: boolean, pending: () => FleetPending) => {
      const held = movedOn ? skippedBySession : pendingBySession
      if (!held.has(sessionID)) held.set(sessionID, { pending: pending(), directory: instance.directory })
    }
    instance.permission.forEach((request) =>
      hold(request.sessionID, !!request.movedOnAt, () => describePermission(request)),
    )
    instance.question.forEach((request) =>
      hold(request.sessionID, !!request.movedOnAt, () => describeQuestion(request)),
    )
    Object.entries(instance.status).forEach(([sessionID, status]) => {
      if (status.type === "idle") return
      busy.set(sessionID, {
        directory: instance.directory,
        retry: status.type === "retry" ? `retrying: ${clip(status.message, 80)}` : undefined,
      })
    })
  })

  const ids = new Set([
    ...pendingBySession.keys(),
    ...skippedBySession.keys(),
    ...busy.keys(),
    ...input.sessions.keys(),
  ])
  const agents = [...ids].flatMap((sessionID): FleetAgent[] => {
    const session = input.sessions.get(sessionID)
    const running = busy.get(sessionID)
    const pending = pendingBySession.get(sessionID) ?? (running ? undefined : skippedBySession.get(sessionID))
    const history = input.history.get(sessionID)
    const directory = pending?.directory ?? running?.directory ?? session?.directory
    if (!directory) return []
    if (session?.parentID && !pending) return []
    const updated = session?.time.updated ?? input.now
    const base = {
      sessionID,
      parentID: session?.parentID,
      title: session?.title ?? sessionID,
      directory,
      tail: history?.lines ?? [],
    }
    const firstSeen = (key: string) => {
      const known = input.firstSeen?.get(key)
      if (known !== undefined) return known
      input.firstSeen?.set(key, input.now)
      return input.now
    }
    if (pending) {
      return [{ ...base, state: "waiting", since: firstSeen(pending.pending.id), pending: pending.pending }]
    }
    if (running) {
      return [{ ...base, state: "running", since: firstSeen(`busy:${sessionID}`), activity: running.retry ?? history?.lines.at(-1) }]
    }
    input.firstSeen?.delete(`busy:${sessionID}`)
    const seenError = input.errors?.get(sessionID)
    const error = history?.error ?? seenError?.message ?? (history?.unfinished ? INTERRUPTED : undefined)
    if (error && input.now - updated < FAILED_WINDOW) {
      return [{ ...base, state: "failed", since: updated, activity: error, error }]
    }
    if (error || !history?.hasReply || input.now - updated >= DONE_WINDOW) return []
    return [{ ...base, state: "done", since: updated, activity: history.lines.at(-1) }]
  })

  const done = agents
    .filter((agent) => agent.state === "done")
    .toSorted((a, b) => b.since - a.since)
    .slice(0, DONE_LIMIT)
  return [...agents.filter((agent) => agent.state !== "done"), ...done]
}

const ACTIVITY: Record<FleetState, number> = { waiting: 3, running: 2, failed: 1, done: 0 }
const ORDER: Record<FleetState, number> = { waiting: 0, failed: 1, running: 2, done: 3 }

/** Waiting longest comes first, because that is the agent losing the most time. Everything else is newest first. */
function compareRows(a: FleetRow, b: FleetRow) {
  if (ORDER[a.state] !== ORDER[b.state]) return ORDER[a.state] - ORDER[b.state]
  if (a.state === "waiting") return a.since - b.since || a.key.localeCompare(b.key)
  return b.since - a.since || a.key.localeCompare(b.key)
}

export function mergeRows(input: {
  local: ReadonlyArray<FleetAgent>
  peers: ReadonlyArray<FleetEntry>
  self: { server?: string; tmuxSocket?: string }
}): FleetRow[] {
  const best = new Map<string, FleetRow>()
  // Sessions live in one shared database, so a second pane on the same project lists this session too, but only the
  // process running it knows it is busy. The most active report is the true one; on a tie the row you can act on wins.
  const offer = (row: FleetRow) => {
    const current = best.get(row.sessionID)
    if (!current || ACTIVITY[row.state] > ACTIVITY[current.state]) best.set(row.sessionID, row)
  }
  input.local.forEach((agent) => offer({ ...agent, key: agent.sessionID, where: { kind: "here" } }))
  input.peers
    // Two TUIs attached to one server see the same agents, and this one can already act on them directly.
    .filter((peer) => !peer.server || peer.server !== input.self.server)
    .forEach((peer) => {
      const sameTmux = peer.tmux !== undefined && peer.tmux.socket === input.self.tmuxSocket
      peer.agents.forEach((agent) =>
        offer({
          ...agent,
          key: `${peer.pid}:${agent.sessionID}`,
          where: {
            kind: "peer",
            pid: peer.pid,
            pane: sameTmux ? peer.tmux?.pane : undefined,
            otherTmux: peer.tmux !== undefined && !sameTmux,
          },
        }),
      )
    })
  return [...best.values()].toSorted(compareRows)
}

export function summarize(rows: ReadonlyArray<Pick<FleetAgent, "state">>) {
  const count = (state: FleetState) => rows.filter((row) => row.state === state).length
  return { waiting: count("waiting"), failed: count("failed"), running: count("running"), done: count("done") }
}

/** The next blocked agent after the one you are on, oldest wait first, wrapping round. */
export function nextWaiting(rows: ReadonlyArray<FleetRow>, currentKey?: string) {
  const waiting = rows.filter((row) => row.state === "waiting")
  if (waiting.length === 0) return undefined
  const index = waiting.findIndex((row) => row.key === currentKey || row.sessionID === currentKey)
  const next = waiting[(index + 1) % waiting.length]
  return next.key === currentKey || next.sessionID === currentKey ? undefined : next
}

export const GROUP_TITLE: Record<FleetState, string> = {
  waiting: "Needs you",
  failed: "Failed",
  running: "Running",
  done: "Finished",
}

export type FleetLine =
  | { type: "gap" }
  | { type: "header"; state: FleetState; count: number }
  | { type: "row"; row: FleetRow }

/** Only a blocked agent takes a second line, for the command being asked about. Everything else stays one quiet line. */
export const lineHeight = (line: FleetLine) => (line.type === "row" && line.row.state === "waiting" ? 2 : 1)

export function toLines(rows: ReadonlyArray<FleetRow>): FleetLine[] {
  const groups = (["waiting", "failed", "running", "done"] as const).flatMap((state) => {
    const group = rows.filter((row) => row.state === state)
    return group.length > 0 ? [{ state, group }] : []
  })
  return groups.flatMap(({ state, group }, index): FleetLine[] => [
    ...(index > 0 ? [{ type: "gap" } as const] : []),
    { type: "header", state, count: group.length },
    ...group.map((row): FleetLine => ({ type: "row", row })),
  ])
}

/** The slice of lines to draw so the selected row stays on screen, however small the tmux pane is. */
export function windowLines(lines: ReadonlyArray<FleetLine>, selectedKey: string | undefined, height: number) {
  const selected = Math.max(
    0,
    lines.findIndex((line) => line.type === "row" && line.row.key === selectedKey),
  )
  const budget = Math.max(2, height)
  // Grow upward from the selection first so its group header stays visible when there is room, then fill downward.
  let start = selected
  let used = lines[selected] ? lineHeight(lines[selected]) : 0
  const reserve = Math.floor(budget / 2)
  while (start > 0 && used + lineHeight(lines[start - 1]) <= Math.max(reserve, lineHeight(lines[selected] ?? lines[0]))) {
    start -= 1
    used += lineHeight(lines[start])
  }
  let end = selected + 1
  while (end < lines.length && used + lineHeight(lines[end]) <= budget) {
    used += lineHeight(lines[end])
    end += 1
  }
  while (start > 0 && used + lineHeight(lines[start - 1]) <= budget) {
    start -= 1
    used += lineHeight(lines[start])
  }
  // A gap at the very top of the list only wastes a row in a short pane.
  const first = lines[start]?.type === "gap" ? start + 1 : start
  return { start: first, end, lines: lines.slice(first, end) }
}

export function age(since: number, now: number) {
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h`
}

export function whereLabel(row: FleetRow) {
  if (row.where.kind === "here") return ""
  if (row.where.pane) return row.where.pane
  return row.where.otherTmux ? "other tmux" : "other terminal"
}

/** A `#(swarm fleet --tmux)` status-line segment. Empty when nothing is happening, so it takes no room. */
export function tmuxSegment(rows: ReadonlyArray<Pick<FleetAgent, "state">>) {
  const counts = summarize(rows)
  return [
    counts.waiting > 0 ? `#[fg=red,bold]▲${counts.waiting} need you#[default]` : "",
    counts.failed > 0 ? `#[fg=red]✕${counts.failed}#[default]` : "",
    counts.running > 0 ? `●${counts.running}` : "",
  ]
    .filter(Boolean)
    .join(" ")
}
