import type {
  AssistantMessage,
  Message,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { buildSessionMap, relativePath, type MapStep, type SessionMapModel } from "../map/session-map-model"

// A run with subagents is a tree of sessions working at the same time, but every surface shows one session. This module
// reduces that tree to what a person needs to oversee it: one row per agent on a shared clock, what each one costs, and
// where two agents touched the same file. Pure, so it can be rebuilt once a second while agents run.

export type SwarmLaneStatus = "needs" | "running" | "waiting" | "retry" | "failed" | "stopped" | "done" | "unread"

export type SwarmSegmentKind = "problem" | "blocked" | "edit" | "command" | "agent" | "explore" | "other"

export type SwarmSegment = {
  id: string
  kind: SwarmSegmentKind
  start: number
  end: number
  running: boolean
  label: string
  count: number
  step: MapStep
}

export type SwarmLane = {
  id: string
  session: Session
  parentID?: string
  depth: number
  title: string
  agent?: string
  status: SwarmLaneStatus
  // Why the agent failed or is retrying, in the server's words.
  detail?: string
  // Children this agent is blocked on while status is "waiting".
  waitingOn: number
  current?: MapStep
  start: number
  end: number
  workMs: number
  cost: number
  model: SessionMapModel
  segments: SwarmSegment[]
  told?: string
  outcome?: string
  permission?: PermissionRequest
  question?: QuestionRequest
  lastUser?: UserMessage
}

export type SwarmWrite = { laneID: string; at: number; step: MapStep; blind: boolean }

export type SwarmOverlap = { path: string; writes: SwarmWrite[]; blind: boolean }

export type SwarmTotals = {
  agents: number
  needs: number
  active: number
  failed: number
  problems: number
  cost: number
}

export type SwarmModel = {
  lanes: SwarmLane[]
  overlaps: SwarmOverlap[]
  axis: SwarmAxis
  totals: SwarmTotals
}

export type SwarmInput = {
  rootID: string
  info: Record<string, Session | undefined>
  status: Record<string, SessionStatus | undefined>
  permission: Record<string, readonly PermissionRequest[] | undefined>
  question: Record<string, readonly QuestionRequest[] | undefined>
  messages: (sessionID: string) => readonly Message[] | undefined
  parts: (messageID: string) => readonly Part[]
  now: number
  // Requests the app answers by itself are nobody's to answer here.
  autoResponds?: (request: PermissionRequest, directory: string) => boolean
}

const SUBAGENT_SUFFIX = / \(@[^)]+ subagent\)$/

export function laneTitle(session: Pick<Session, "title">) {
  return session.title.replace(SUBAGENT_SUFFIX, "")
}

/** Every session under a root, parents before children, oldest sibling first. A cycle or orphan cannot hang this. */
export function sessionTree(rootID: string, info: Record<string, Session | undefined>) {
  const children = new Map<string, Session[]>()
  Object.values(info).forEach((session) => {
    if (!session?.parentID || session.time.archived) return
    const list = children.get(session.parentID)
    if (list) list.push(session)
    else children.set(session.parentID, [session])
  })
  const seen = new Set<string>()
  const result: { id: string; depth: number }[] = []
  const walk = (id: string, depth: number) => {
    if (seen.has(id)) return
    seen.add(id)
    result.push({ id, depth })
    ;(children.get(id) ?? [])
      .sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
      .forEach((child) => walk(child.id, depth + 1))
  }
  walk(rootID, 0)
  return result
}

const segmentKind = (step: MapStep, blocked: boolean): SwarmSegmentKind => {
  // A failed task is the child's failure and its lane says so. Painting the parent's whole wait red would shout over it.
  if (step.kind === "agent") return "agent"
  if (step.problem) return "problem"
  // A tool waiting on a person is not running, however long the bar gets.
  if (blocked && step.running) return "blocked"
  if (step.kind === "edit") return "edit"
  if (step.kind === "command") return "command"
  if (step.kind === "explore") return "explore"
  return "other"
}

type Interval = readonly [number, number]

export function mergeIntervals(intervals: readonly Interval[], tolerance = 0) {
  const sorted = intervals.filter(([start, end]) => end >= start).toSorted((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  sorted.forEach(([start, end]) => {
    const last = merged.at(-1)
    if (last && start - last[1] <= tolerance) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  })
  return merged
}

const span = (intervals: readonly Interval[]) => intervals.reduce((total, [start, end]) => total + (end - start), 0)

const childSessionOf = (step: MapStep) => {
  const id = step.metadata?.sessionId
  return typeof id === "string" ? id : undefined
}

function laneStatus(input: {
  session: Session
  status: SessionStatus | undefined
  permission?: PermissionRequest
  question?: QuestionRequest
  messages: readonly Message[] | undefined
  waitingOn: number
}): Pick<SwarmLane, "status" | "detail"> {
  const request = input.permission ?? input.question
  if ((input.permission && !input.permission.movedOnAt) || (input.question && !input.question.movedOnAt))
    return { status: "needs" }
  if (input.status?.type === "retry") return { status: "retry", detail: input.status.message }
  if (input.status?.type === "busy") return { status: input.waitingOn > 0 ? "waiting" : "running" }
  // The agent moved on from this and has since stopped, so what is left is a decision for the person.
  if (request) return { status: "needs" }
  if (!input.messages) return { status: "unread" }
  const last = input.messages.findLast((message): message is AssistantMessage => message.role === "assistant")
  const failure = last?.error
  if (failure?.name === "MessageAbortedError") return { status: "stopped" }
  if (failure) {
    const data = failure.data as { message?: unknown } | undefined
    return { status: "failed", detail: typeof data?.message === "string" ? data.message : failure.name }
  }
  return { status: "done" }
}

function buildLane(input: SwarmInput, id: string, depth: number): SwarmLane {
  const session = input.info[id]!
  const messages = input.messages(id)
  const directory = session.directory
  const model = buildSessionMap({ messages: messages ?? [], parts: input.parts })
  const permissions = (input.permission[id] ?? []).filter((request) => !input.autoResponds?.(request, directory))
  // A request that is really holding the agent comes before any it moved on from.
  const permission = permissions.find((request) => !request.movedOnAt) ?? permissions[0]
  const question = input.question[id]?.find((request) => !request.movedOnAt) ?? input.question[id]?.[0]
  const assistants = (messages ?? []).filter((message): message is AssistantMessage => message.role === "assistant")

  const waitingOn = model.steps.filter(
    (step) =>
      step.kind === "agent" &&
      step.running &&
      (() => {
        const child = childSessionOf(step)
        return !child || (input.status[child]?.type ?? "idle") !== "idle"
      })(),
  ).length

  const end = (at: number | undefined) => at ?? input.now
  const segments = model.steps.map(
    (step): SwarmSegment => ({
      id: step.id,
      kind: segmentKind(step, !!permission || !!question),
      start: step.start,
      end: step.running ? input.now : end(step.end ?? step.start),
      running: step.running,
      label: step.label,
      count: 1,
      step,
    }),
  )

  const busy = (input.status[id]?.type ?? "idle") !== "idle"
  const replies = assistants.map(
    (message): Interval => [
      message.time.created,
      message.time.completed ?? (busy ? input.now : (assistants.at(-1)?.time.created ?? message.time.created)),
    ],
  )
  const waits = segments.filter((segment) => segment.kind === "agent").map((s): Interval => [s.start, s.end])
  const active = mergeIntervals(replies)
  const workMs = Math.max(0, span(active) - span(mergeIntervals(waits)))

  const latestUser = (messages ?? []).findLast((message): message is UserMessage => message.role === "user")
  const firstChapter = model.chapters[0]
  const lastChapter = model.chapters.at(-1)

  // The server rolls cost up per session; before its first update the messages are the better number.
  const fromMessages = assistants.reduce((total, message) => total + (message.cost ?? 0), 0)

  const current =
    model.steps.findLast((step) => step.running && step.kind !== "agent") ?? model.steps.findLast((s) => s.running)
  const starts = [
    ...active.map(([start]) => start),
    ...segments.map((segment) => segment.start),
    ...(messages?.length ? [] : [session.time.created]),
  ]
  const ends = [
    ...active.map(([, last]) => last),
    ...segments.map((segment) => segment.end),
    ...(messages?.length ? [] : [session.time.created]),
  ]

  return {
    id,
    session,
    parentID: session.parentID,
    depth,
    title: laneTitle(session),
    agent: session.agent ?? latestUser?.agent,
    ...laneStatus({ session, status: input.status[id], permission, question, messages, waitingOn }),
    waitingOn,
    current,
    start: Math.min(...starts),
    end: Math.max(...ends),
    workMs,
    cost: Math.max(session.cost ?? 0, fromMessages),
    model,
    segments,
    told: firstChapter?.prompt || undefined,
    outcome: lastChapter?.outcome?.text,
    permission,
    question,
    lastUser: latestUser,
  }
}

// ---- Time axis ----------------------------------------------------------------------------------------------------

export type SwarmAxis = {
  start: number
  end: number
  x: (at: number) => number
}

// A session can have turns days apart. Nothing happened in those gaps, so they are drawn as a fixed sliver.
const GAP_MS = 2 * 60_000
const GAP_SHARE = 0.03

export function buildAxis(intervals: readonly Interval[]): SwarmAxis {
  const sections = mergeIntervals(intervals, GAP_MS)
  if (sections.length === 0) {
    return { start: 0, end: 0, x: () => 0 }
  }
  const wallMs = span(sections)
  const gaps = sections.length - 1
  // A floor keeps a zero-length section (one instant step) from dividing by zero and gives it some width.
  const floor = Math.max(1000, wallMs * 0.02)
  const lengths = sections.map(([start, end]) => Math.max(end - start, floor))
  const lengthTotal = lengths.reduce((total, value) => total + value, 0)
  const usable = 1 - GAP_SHARE * gaps
  let cursor = 0
  const placed = sections.map(([start, end], index) => {
    const width = (lengths[index]! / lengthTotal) * usable
    const left = cursor
    cursor += width + GAP_SHARE
    return { start, end, left, width, scale: width / Math.max(end - start, 1) }
  })

  const x = (at: number) => {
    const first = placed[0]!
    if (at <= first.start) return first.left
    for (const section of placed) {
      if (at <= section.end) {
        if (at >= section.start) return section.left + Math.min((at - section.start) * section.scale, section.width)
        // Inside a gap: stay at the left edge of the section that follows.
        return section.left
      }
    }
    const last = placed.at(-1)!
    return last.left + last.width
  }

  return { start: sections[0]![0], end: sections.at(-1)![1], x }
}

// Priority for a cell that stands for several steps: a failure must never be hidden by the passing steps around it.
const KIND_RANK: Record<SwarmSegmentKind, number> = {
  problem: 6,
  blocked: 5,
  edit: 4,
  command: 3,
  agent: 2,
  explore: 1,
  other: 0,
}

/** Steps closer than `minWidth` of the chart become one cell, so a 500-step lane stays a few hundred elements at most. */
export function coalesceSegments(segments: readonly SwarmSegment[], x: (at: number) => number, minWidth = 0.004) {
  const cells: (SwarmSegment & { left: number; right: number })[] = []
  segments
    .toSorted((a, b) => a.start - b.start)
    .forEach((segment) => {
      const left = x(segment.start)
      const right = x(segment.end)
      const last = cells.at(-1)
      if (last && left - last.left < minWidth) {
        last.right = Math.max(last.right, right)
        last.end = Math.max(last.end, segment.end)
        last.count += 1
        last.running = last.running || segment.running
        if (KIND_RANK[segment.kind] > KIND_RANK[last.kind]) {
          last.kind = segment.kind
          last.label = segment.label
          last.step = segment.step
        }
        return
      }
      cells.push({ ...segment, left, right })
    })
  return cells
}

// ---- Shared files -------------------------------------------------------------------------------------------------

const readsPath = (step: MapStep, path: string, directory: string) => {
  if (step.tool !== "read") return false
  const value = step.input?.filePath
  return typeof value === "string" && relativePath(value, directory) === path
}

/**
 * Files changed by more than one agent. A `write` replaces the whole file, so one made after another agent's change,
 * with no read of the file in between, may have thrown that change away. `edit` and patches have to match the current
 * text and fail otherwise, so they are not called blind.
 */
export function findOverlaps(lanes: readonly SwarmLane[]): SwarmOverlap[] {
  const byPath = new Map<string, SwarmWrite[]>()
  lanes.forEach((lane) => {
    lane.model.steps.forEach((step) => {
      step.files.forEach((file) => {
        const path = relativePath(file.path, lane.session.directory)
        const write: SwarmWrite = { laneID: lane.id, at: step.end ?? step.start, step, blind: false }
        const list = byPath.get(path)
        if (list) list.push(write)
        else byPath.set(path, [write])
      })
    })
  })
  const laneByID = new Map(lanes.map((lane) => [lane.id, lane]))
  const overlaps: SwarmOverlap[] = []
  byPath.forEach((writes, path) => {
    if (new Set(writes.map((write) => write.laneID)).size < 2) return
    const ordered = writes.toSorted((a, b) => a.at - b.at)
    ordered.forEach((write, index) => {
      if (write.step.tool !== "write") return
      const previous = ordered.slice(0, index).findLast((other) => other.laneID !== write.laneID)
      if (!previous) return
      const lane = laneByID.get(write.laneID)!
      write.blind = !lane.model.steps.some(
        (step) =>
          step.id !== write.step.id &&
          (step.end ?? step.start) >= previous.at &&
          step.start <= write.step.start &&
          readsPath(step, path, lane.session.directory),
      )
    })
    overlaps.push({ path, writes: ordered, blind: ordered.some((write) => write.blind) })
  })
  return overlaps.sort((a, b) => Number(b.blind) - Number(a.blind) || b.writes.at(-1)!.at - a.writes.at(-1)!.at)
}

// ---- The whole picture --------------------------------------------------------------------------------------------

export function buildSwarm(input: SwarmInput): SwarmModel {
  const lanes = sessionTree(input.rootID, input.info).flatMap(({ id, depth }) =>
    input.info[id] ? [buildLane(input, id, depth)] : [],
  )
  const axis = buildAxis(
    lanes.flatMap((lane): Interval[] => [
      [lane.start, lane.end],
      ...lane.segments.map((segment): Interval => [segment.start, segment.end]),
    ]),
  )
  return {
    lanes,
    axis,
    overlaps: findOverlaps(lanes),
    totals: {
      agents: lanes.length,
      needs: lanes.filter((lane) => lane.status === "needs").length,
      active: lanes.filter((lane) => ["running", "retry", "waiting"].includes(lane.status)).length,
      failed: lanes.filter((lane) => lane.status === "failed").length,
      problems: lanes.reduce((total, lane) => total + lane.model.counts.problems, 0),
      cost: lanes.reduce((total, lane) => total + lane.cost, 0),
    },
  }
}

// ---- Whether this session has subagents, and whether one is stuck. No messages are read, so it stays on for every session.

export function swarmPulse(input: Pick<SwarmInput, "rootID" | "info" | "permission" | "question" | "autoResponds">) {
  const tree = sessionTree(input.rootID, input.info).filter(({ id }) => !!input.info[id])
  const stuck = (id: string) =>
    (input.permission[id] ?? []).some(
      (request) => !request.movedOnAt && !input.autoResponds?.(request, input.info[id]!.directory),
    ) || (input.question[id] ?? []).some((request) => !request.movedOnAt)
  return { agents: tree.length, needs: tree.filter(({ id }) => stuck(id)).length }
}

/** The order a keyboard walks the lanes, and where it starts: whoever is stuck first, otherwise where the reader is. */
export function defaultLane(lanes: readonly SwarmLane[], currentID: string | undefined) {
  return (
    lanes.find((lane) => lane.status === "needs")?.id ?? lanes.find((lane) => lane.id === currentID)?.id ?? lanes[0]?.id
  )
}
