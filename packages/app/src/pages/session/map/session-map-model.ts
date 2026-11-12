import type {
  AssistantMessage,
  AutonomyArchive,
  AutonomyArchiveEntry,
  AutonomyAuditLine,
  Message,
  Part,
  ToolPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import { notRun } from "@opencode-ai/session-ui/part-mark"

// A long session is hundreds of tool calls in a virtualized transcript: the browser's find cannot see it and a failed
// command looks like a passing one. This module reduces the raw messages and parts to what a person reads instead.
// Everything here is pure so it can run over every part of a session on each tool state change.

export type MapStepKind = "edit" | "command" | "explore" | "agent" | "question" | "web" | "other" | "error" | "text"

export type MapFileChange = { path: string; added: number; removed: number }

export type MapStep = {
  id: string
  turnID: string
  messageID: string
  partID?: string
  kind: MapStepKind
  tool?: string
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  label: string
  // It stopped at the permission gate and never ran, so it says nothing about the work.
  notRun?: boolean
  // Why this step counts as a problem. A shell command that exits non-zero completes normally as far as the tool is
  // concerned, so the exit code has to be read from its metadata.
  problem?: string
  // What the tool printed, read only when asked: streaming output must not rebuild the model.
  output?: () => string
  // The line of output that says what went wrong, so a failure can be read without opening it.
  detail?: string
  running: boolean
  start: number
  end?: number
  files: MapFileChange[]
  haystack: () => string
}

export type MapChapter = {
  id: string
  index: number
  prompt: string
  compaction: boolean
  outcome?: { partID: string; messageID: string; text: string }
  start: number
  end?: number
  steps: MapStep[]
  problems: number
  files: number
  commands: number
  visibleSteps: number
}

export type MapFile = { path: string; added: number; removed: number; steps: MapStep[] }

export type SessionMapModel = {
  chapters: MapChapter[]
  steps: MapStep[]
  problems: MapStep[]
  files: MapFile[]
  counts: { problems: number; edits: number; commands: number; agents: number }
}

export type SessionMapInput = {
  messages: readonly Message[]
  parts: (messageID: string) => readonly Part[]
  revertMessageID?: string
  // The caller passes untrack here: streaming text and output must not rebuild the model on every delta.
  quiet?: <T>(read: () => T) => T
}

const SEARCH_LIMIT = 20_000

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

const text = (value: unknown) => (typeof value === "string" ? value : "")

const firstLine = (value: string) => value.trim().split("\n")[0]?.trim() ?? ""

const kindOf = (tool: string): MapStepKind => {
  if (tool === "bash" || tool === "shell") return "command"
  if (tool === "edit" || tool === "write" || tool === "patch" || tool === "apply_patch") return "edit"
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list" || tool === "git") return "explore"
  if (tool === "task") return "agent"
  if (tool === "question") return "question"
  if (tool === "webfetch" || tool === "websearch") return "web"
  return "other"
}

const labelOf = (part: ToolPart, kind: MapStepKind) => {
  const input = record(part.state.input)
  const title = "title" in part.state ? text(part.state.title) : ""
  if (kind === "command") return firstLine(text(input.command)) || title
  if (kind === "agent") return text(input.description) || title
  if (kind === "web") return text(input.url) || text(input.query) || title
  if (kind === "explore" || kind === "edit")
    return text(input.filePath) || text(input.pattern) || text(input.path) || title
  if (kind === "question") {
    const questions = Array.isArray(input.questions) ? input.questions : []
    return text(record(questions[0]).question) || title
  }
  return title || part.tool
}

const changesOf = (part: ToolPart): MapFileChange[] => {
  if (part.state.status !== "completed") return []
  const metadata = record(part.state.metadata)
  const input = record(part.state.input)
  if (part.tool === "edit") {
    const diff = record(metadata.filediff)
    const path = text(diff.file) || text(input.filePath)
    return path ? [{ path, added: Number(diff.additions) || 0, removed: Number(diff.deletions) || 0 }] : []
  }
  if (part.tool === "write") {
    const path = text(input.filePath)
    return path ? [{ path, added: text(input.content).split("\n").length, removed: 0 }] : []
  }
  if (part.tool === "patch" || part.tool === "apply_patch") {
    const files = Array.isArray(metadata.files) ? metadata.files : []
    return files.flatMap((file) => {
      const item = record(file)
      const path = text(item.relativePath) || text(item.filePath)
      return path ? [{ path, added: Number(item.additions) || 0, removed: Number(item.deletions) || 0 }] : []
    })
  }
  return []
}

const notRunOf = (part: ToolPart) => (part.state.status === "error" ? notRun(part.state.metadata) : undefined)

const problemOf = (part: ToolPart) => {
  // Stopped at the permission gate: it never ran, so there is nothing to investigate. What is waiting shows elsewhere.
  if (notRunOf(part)) return
  if (part.state.status === "error") return firstLine(text(part.state.error)) || part.tool
  if (part.state.status !== "completed") return
  const exit = record(part.state.metadata).exit
  if (typeof exit === "number" && exit !== 0) return `exit ${exit}`
}

export function failureLine(output: string) {
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const line = lines.find((item) => /\b(fail(ed|ure)?|error|exception|panic|fatal)\b/i.test(item)) ?? lines.at(-1)
  return line?.slice(0, 160)
}

const bounded = (value: string) =>
  value.length <= SEARCH_LIMIT ? value : value.slice(0, SEARCH_LIMIT / 2) + "\n" + value.slice(-SEARCH_LIMIT / 2)

const toolHaystack = (part: ToolPart) => {
  const state = part.state
  return [
    part.tool,
    JSON.stringify(state.input ?? {}),
    "title" in state ? text(state.title) : "",
    state.status === "completed" ? bounded(text(state.output)) : "",
    state.status === "error" ? text(state.error) : "",
    state.status === "running" || state.status === "completed" ? bounded(text(record(state.metadata).output)) : "",
  ]
    .join("\n")
    .toLowerCase()
}

const promptOf = (parts: readonly Part[]) =>
  parts
    .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    .join("\n")
    .trim()

const toolTime = (part: ToolPart, fallback: number) => {
  const state = part.state
  if (state.status === "pending") return { start: fallback }
  const time = state.time as { start: number; end?: number }
  return { start: time.start, end: time.end }
}

export function buildSessionMap(input: SessionMapInput): SessionMapModel {
  const quiet = input.quiet ?? (<T>(read: () => T) => read())
  const visible = input.messages.filter((message) => !input.revertMessageID || message.id < input.revertMessageID)
  const users = visible.filter((message): message is UserMessage => message.role === "user")
  const assistants = new Map<string, AssistantMessage[]>()
  visible.forEach((message) => {
    if (message.role !== "assistant") return
    const list = assistants.get(message.parentID)
    if (list) list.push(message)
    else assistants.set(message.parentID, [message])
  })

  const chapters = users.map((user, index): MapChapter => {
    const userParts = input.parts(user.id)
    const replies = assistants.get(user.id) ?? []
    let outcome: MapChapter["outcome"]
    const steps = replies.flatMap((message): MapStep[] => {
      const parts = input.parts(message.id).flatMap((part): MapStep[] => {
        if (part.type === "text") {
          if (part.synthetic || part.ignored) return []
          const body = quiet(() => part.text)
          if (!body?.trim()) return []
          outcome = { partID: part.id, messageID: message.id, text: body.trim() }
          return [
            {
              id: part.id,
              turnID: user.id,
              messageID: message.id,
              partID: part.id,
              kind: "text",
              label: firstLine(body),
              running: false,
              start: part.time?.start ?? message.time.created,
              end: part.time?.end,
              files: [],
              haystack: () => quiet(() => part.text).toLowerCase(),
            },
          ]
        }
        if (part.type !== "tool") return []
        const kind = kindOf(part.tool)
        const time = toolTime(part, message.time.created)
        return [
          {
            id: part.id,
            turnID: user.id,
            messageID: message.id,
            partID: part.id,
            kind,
            tool: part.tool,
            input: record(part.state.input),
            metadata: "metadata" in part.state ? record(part.state.metadata) : undefined,
            label: labelOf(part, kind),
            problem: problemOf(part),
            notRun: !!notRunOf(part),
            detail:
              part.state.status === "completed" && problemOf(part)
                ? quiet(() => failureLine(text(part.state.status === "completed" ? part.state.output : "")))
                : undefined,
            running: part.state.status === "running" || part.state.status === "pending",
            start: time.start,
            end: time.end,
            files: changesOf(part),
            output: () => quiet(() => (part.state.status === "completed" ? text(part.state.output) : "")),
            haystack: () => quiet(() => toolHaystack(part)),
          },
        ]
      })
      const failure = message.error
      if (!failure || failure.name === "MessageAbortedError") return parts
      const body = text(record(failure.data).message) || failure.name
      return [
        ...parts,
        {
          id: `error:${message.id}`,
          turnID: user.id,
          messageID: message.id,
          kind: "error",
          label: firstLine(body),
          problem: firstLine(body),
          running: false,
          start: message.time.completed ?? message.time.created,
          files: [],
          haystack: () => body.toLowerCase(),
        },
      ]
    })
    const shown = steps.filter((step) => step.kind !== "text")
    const end = replies.reduce<number | undefined>((latest, message) => {
      const value = message.time.completed
      if (value === undefined) return latest
      return latest === undefined ? value : Math.max(latest, value)
    }, undefined)
    return {
      id: user.id,
      index,
      prompt: quiet(() => promptOf(userParts)),
      compaction: userParts.some((part) => part.type === "compaction"),
      outcome,
      start: user.time.created,
      end,
      steps,
      problems: shown.filter((step) => step.problem).length,
      files: new Set(shown.flatMap((step) => step.files.map((file) => file.path))).size,
      commands: shown.filter((step) => step.kind === "command").length,
      visibleSteps: shown.length,
    }
  })

  const steps = chapters.flatMap((chapter) => chapter.steps.filter((step) => step.kind !== "text"))
  const files = new Map<string, MapFile>()
  steps.forEach((step) =>
    step.files.forEach((change) => {
      const entry = files.get(change.path)
      if (!entry) {
        files.set(change.path, { path: change.path, added: change.added, removed: change.removed, steps: [step] })
        return
      }
      entry.added += change.added
      entry.removed += change.removed
      entry.steps.push(step)
    }),
  )
  const problems = steps.filter((step) => step.problem)
  return {
    chapters,
    steps,
    problems,
    files: [...files.values()],
    counts: {
      problems: problems.length,
      edits: steps.filter((step) => step.kind === "edit").length,
      commands: steps.filter((step) => step.kind === "command").length,
      agents: steps.filter((step) => step.kind === "agent").length,
    },
  }
}

// "agents" and "decisions" are views of the panel, not filters over steps: each shows its own list instead.
export type MapFilter = "all" | "problems" | "edits" | "agents" | "decisions"

export type MapRow =
  | { type: "chapter"; id: string; chapter: MapChapter; open: boolean }
  | { type: "step"; id: string; step: MapStep; snippet?: string }
  | { type: "explored"; id: string; steps: MapStep[]; reads: number; searches: number }
  | { type: "file"; id: string; file: MapFile; open: boolean }
  | { type: "truncated"; id: string; total: number }

const RESULT_LIMIT = 200

const snippetOf = (haystack: string, query: string) => {
  const at = haystack.indexOf(query)
  if (at < 0) return
  const start = Math.max(0, at - 32)
  return (start > 0 ? "…" : "") + haystack.slice(start, at + query.length + 64).replace(/\s+/g, " ")
}

// Reads and searches are the noise of a long run. Runs of them fold into one line unless one of them failed.
const foldExplored = (steps: readonly MapStep[]) => {
  const rows: MapRow[] = []
  let run: MapStep[] = []
  const flush = () => {
    if (run.length === 0) return
    const first = run[0]!
    if (run.length === 1) rows.push({ type: "step", id: first.id, step: first })
    else
      rows.push({
        type: "explored",
        id: `explored:${first.id}`,
        steps: run,
        reads: run.filter((step) => step.tool === "read").length,
        searches: run.filter((step) => step.tool !== "read").length,
      })
    run = []
  }
  steps.forEach((step) => {
    if (step.kind === "text") return
    if (step.kind === "explore" && !step.problem) {
      run.push(step)
      return
    }
    flush()
    rows.push({ type: "step", id: step.id, step })
  })
  flush()
  return rows
}

const matchesFilter = (step: MapStep, filter: MapFilter) => {
  if (step.kind === "text") return false
  if (filter === "problems") return !!step.problem
  return true
}

// The flat list the panel renders and the keyboard walks. `open` decides which chapters and files show their steps.
export function mapRows(input: {
  model: SessionMapModel
  filter: MapFilter
  query: string
  open: (id: string, chapter: MapChapter | undefined) => boolean
}): MapRow[] {
  if (input.filter === "decisions") return []
  const query = input.query.trim().toLowerCase()
  if (query) return searchRows(input.model, input.filter, query)
  if (input.filter === "edits") {
    return input.model.files.flatMap((file): MapRow[] => {
      const open = input.open(`file:${file.path}`, undefined)
      return [
        { type: "file", id: `file:${file.path}`, file, open },
        ...(open ? file.steps.map((step): MapRow => ({ type: "step", id: `${file.path}:${step.id}`, step })) : []),
      ]
    })
  }
  if (input.filter === "all") {
    return input.model.chapters.flatMap((chapter): MapRow[] => {
      const open = input.open(chapter.id, chapter)
      return [{ type: "chapter", id: chapter.id, chapter, open }, ...(open ? foldExplored(chapter.steps) : [])]
    })
  }
  return input.model.chapters.flatMap((chapter): MapRow[] => {
    const steps = chapter.steps.filter((step) => matchesFilter(step, input.filter))
    if (steps.length === 0) return []
    return [
      { type: "chapter", id: chapter.id, chapter, open: true },
      ...steps.map((step): MapRow => ({ type: "step", id: step.id, step })),
    ]
  })
}

function searchRows(model: SessionMapModel, filter: MapFilter, query: string): MapRow[] {
  let total = 0
  const rows = model.chapters.flatMap((chapter): MapRow[] => {
    const promptHit = filter === "all" && chapter.prompt.toLowerCase().includes(query)
    const hits = chapter.steps.flatMap((step): MapRow[] => {
      if (filter === "edits" ? step.kind !== "edit" : filter !== "all" && !matchesFilter(step, filter)) return []
      const snippet = snippetOf(step.haystack(), query)
      if (snippet === undefined) return []
      total += 1
      if (total > RESULT_LIMIT) return []
      return [{ type: "step", id: step.id, step, snippet }]
    })
    if (hits.length === 0 && !promptHit) return []
    return [{ type: "chapter", id: chapter.id, chapter, open: true }, ...hits]
  })
  if (total > RESULT_LIMIT) rows.push({ type: "truncated", id: "truncated", total })
  return rows
}

export type SinceYouLooked = { steps: MapStep[]; problems: number; first: MapStep }

export function sinceYouLooked(model: SessionMapModel, since: number | undefined): SinceYouLooked | undefined {
  if (since === undefined) return
  const steps = model.steps.filter((step) => step.start > since)
  const first = steps[0]
  if (!first) return
  return { steps, problems: steps.filter((step) => step.problem).length, first }
}

// Moves through problems relative to where the reader is: the last problem visited, or else the turn on screen.
export function nextProblem(
  model: SessionMapModel,
  direction: 1 | -1,
  from: { stepID?: string; turnID?: string },
): MapStep | undefined {
  const list = model.problems
  if (list.length === 0) return
  const at = from.stepID ? list.findIndex((step) => step.id === from.stepID) : -1
  if (at >= 0) return list[(at + direction + list.length) % list.length]
  const order = new Map(model.chapters.map((chapter) => [chapter.id, chapter.index]))
  const turn = from.turnID ? (order.get(from.turnID) ?? -1) : -1
  if (turn < 0) return direction > 0 ? list[0] : list.at(-1)
  if (direction > 0) return list.find((step) => (order.get(step.turnID) ?? 0) >= turn) ?? list[0]
  return list.findLast((step) => (order.get(step.turnID) ?? 0) <= turn) ?? list.at(-1)
}

type DecisionLine = Extract<AutonomyAuditLine, { type: "decision" }>

export type DecisionEntry = {
  id: string
  sessionID: string
  messageID?: string
  directory: string
  at: number
  permission: string
  // Written by whatever the agent read, so an attacker can reach them. Shown as they are, never as Markdown or links.
  patterns: readonly string[]
  patternsTruncated: boolean
  // What else one answer to this covers, which is the actual edit or command when the line itself only names a folder.
  follows: DecisionLine["follows"]
  reason?: string
  category?: DecisionLine["category"]
  // "person", or the model that answered. The gate and the system are nobody a reader needs named here.
  by?: string
  outcome?: Extract<AutonomyAuditLine, { type: "outcome" }>["outcome"]
  // Only for what actually ran. "button" is a promise that Undo brings it back; "none" says it cannot.
  undo?: "button" | "none"
  // A class B line: a stop for a person, never held, so it reads "Stopped" rather than "Refused".
  stopped?: boolean
  // The category the call had before the main agent decided it under consent (category is then `by_main_agent`).
  bypassed?: DecisionLine["bypassed"]
  // How the line came about. `for_subagent` is the main agent deciding a subagent's call, and its reason says why.
  via?: DecisionLine["via"]
}

export type HeldCall = { tool: string; args: { name: string; value: string }[] }

export type DecisionNote = {
  id: string
  at: number
  note: "mode_on" | "mode_off" | "decider_unavailable" | "queue_full" | "bypass_on" | "report"
}

// One line of History: a decided or limited entry, or a note, in the order they happened.
export type HistoryItem =
  | { kind: "decided" | "limited"; id: string; at: number; entry: DecisionEntry }
  | { kind: "note"; id: string; at: number; note: DecisionNote }

export type DecisionGroups = {
  waiting: DecisionEntry[]
  decided: DecisionEntry[]
  limited: DecisionEntry[]
  notes: DecisionNote[]
}

const CLOSED_OUTCOMES: readonly string[] = ["approved_later", "rejected_later", "abandoned"]

// A snapshot brings files back. It cannot recall what left the machine, or reach what lives outside the worktree.
const BEYOND_UNDO: readonly (DecisionLine["category"] | undefined)[] = [
  "outside_folder",
  "outward",
  "not_reversible",
  "no_undo",
  "external_tool",
]

const NOTE_OF: Partial<Record<Extract<AutonomyAuditLine, { type: "marker" }>["marker"], DecisionNote["note"]>> = {
  mode_on: "mode_on",
  mode_off: "mode_off",
  decider_open: "decider_unavailable",
  decider_limit: "decider_unavailable",
  b0: "queue_full",
  bypass_on: "bypass_on",
  bypass_report: "report",
}

// The same reading as `openIn` on the server, so the groups' waiting list and the route's `open` count cannot differ.
const isWaiting = (line: DecisionLine, outcome: DecisionEntry["outcome"]) =>
  line.decision === "defer" &&
  (line.class === "D" || line.class === "P") &&
  line.category !== "queue_full" &&
  !(outcome && CLOSED_OUTCOMES.includes(outcome))

// Class X reaches this as a rejection by the gate, like a decider's. Class B stops for a person and is never held.
const isLimited = (line: DecisionLine, outcome: DecisionEntry["outcome"]) =>
  line.class === "B" ||
  outcome === "abandoned" ||
  line.category === "queue_full" ||
  (line.decision === "reject" && line.decidedBy !== "person")

const byOf = (line: DecisionLine, later?: string) => {
  if (later === "person" || line.decidedBy === "person") return "person"
  return line.decidedBy.startsWith("agent:") ? line.decidedBy.slice("agent:".length) : undefined
}

// The reason the server writes on a call let through by a person's "always in this session" (permission/index.ts).
const SESSION_REASON = 'a person\'s "always in this session"'

// What one answer to `answered` was good for: its own prompt, or one it named as following from it.
const covers = (answered: DecisionLine, line: DecisionLine) =>
  [{ permission: answered.permission, patterns: answered.patterns }, ...answered.follows].some(
    (item) =>
      item.permission === line.permission &&
      item.patterns.length === line.patterns.length &&
      item.patterns.every((pattern, index) => pattern === line.patterns[index]),
  )

// A revert only marks where the session went back to, so what it took away is everything from that message on.
export function decisionGroups(
  lines: readonly AutonomyAuditLine[],
  rootID: string,
  revertedAt: (sessionID: string) => string | undefined = () => undefined,
): DecisionGroups {
  const outcomes = new Map(lines.flatMap((line) => (line.type === "outcome" ? [[line.requestID, line] as const] : [])))
  // The answer, which a later "ran" or "failed" for the call the server then ran does not take back (row 260).
  const answers = new Map(
    lines.flatMap((line) =>
      line.type === "outcome" && CLOSED_OUTCOMES.includes(line.outcome) ? [[line.requestID, line.outcome] as const] : [],
    ),
  )
  const groups: DecisionGroups = { waiting: [], decided: [], limited: [], notes: [] }
  // Decided rows by the call they stand for, and the approvals a person gave later, oldest first.
  const calls = new Map<string, DecisionEntry>()
  const approved: { line: DecisionLine; entry: DecisionEntry }[] = []
  lines.forEach((line) => {
    if (line.type === "marker") {
      const note = NOTE_OF[line.marker]
      if (note) groups.notes.push({ id: `${line.seq}:${line.at}`, at: line.at, note })
      return
    }
    if (line.type !== "decision" || line.rootID !== rootID) return
    const later = outcomes.get(line.requestID)
    const answer = answers.get(line.requestID)
    const ran = line.decision === "allow" || answer === "approved_later"
    const reverted = revertedAt(line.sessionID)
    const taken = !!(ran && line.messageID && reverted && line.messageID >= reverted)
    const outcome = taken ? "undone" : later?.outcome
    const entry: DecisionEntry = {
      id: line.requestID,
      sessionID: line.sessionID,
      messageID: line.messageID,
      directory: line.directory,
      at: line.at,
      permission: line.permission,
      patterns: line.patterns,
      patternsTruncated: line.patternsTruncated,
      follows: line.follows,
      reason: line.reason,
      category: line.category,
      by: byOf(line, later?.by),
      outcome,
      ...(line.class === "B" && { stopped: true }),
      ...(line.bypassed && { bypassed: line.bypassed }),
      ...(line.via && { via: line.via }),
      undo:
        !ran || outcome === "undone"
          ? undefined
          : // A subagent's Undo can overwrite the root's later step on the same file with no warning (autonomy-revert.test.ts).
            line.sessionID === rootID && line.messageID && line.canUndo && !BEYOND_UNDO.includes(line.category)
            ? "button"
            : "none",
    }
    if (isWaiting(line, answer)) {
      groups.waiting.push(entry)
      return
    }
    if (isLimited(line, answer)) {
      groups.limited.push(entry)
      return
    }
    // One person's decision is one row (row 262). A grant line only carries out an answer already on screen: a follow-on
    // prompt of a call that has a row joins it, and a call let through by an earlier approval joins that approval's row.
    // A later call an "always in this session" let through keeps a row of its own, one per call.
    const call = line.callID ? `${line.sessionID}:${line.callID}` : undefined
    const into =
      line.via !== "grant"
        ? undefined
        : ((call ? calls.get(call) : undefined) ??
          (line.reason === SESSION_REASON
            ? undefined
            : approved.findLast((item) => item.line.sessionID === line.sessionID && covers(item.line, line))?.entry))
    if (call) calls.set(call, into ?? entry)
    if (!into) {
      groups.decided.push(entry)
      if (answer === "approved_later") approved.push({ line, entry })
      return
    }
    // The row keeps its own Undo. Only when it has none to give does it take one a folded line had, so no undoable step
    // is lost, and a step a revert already took reads as undone there too.
    if (into.undo !== "button" && into.outcome !== "undone" && (entry.undo === "button" || entry.outcome === "undone"))
      Object.assign(into, {
        messageID: entry.messageID,
        undo: entry.undo,
        ...(entry.outcome === "undone" && { outcome: "undone" }),
      })
  })
  // What waits longest comes first. Everything else reads as a log, latest on top.
  groups.decided.reverse()
  groups.limited.reverse()
  groups.notes.reverse()
  return groups
}

// Everything that no longer waits, as one log, latest on top. The groups stay as they are (rows 260 and 262); this only
// interleaves them, and on the same time keeps decided before limited before notes.
export function historyOf(groups: DecisionGroups): HistoryItem[] {
  const items: HistoryItem[] = [
    ...groups.decided.map((entry) => ({ kind: "decided" as const, id: entry.id, at: entry.at, entry })),
    ...groups.limited.map((entry) => ({ kind: "limited" as const, id: entry.id, at: entry.at, entry })),
    ...groups.notes.map((note) => ({ kind: "note" as const, id: note.id, at: note.at, note })),
  ]
  return items.sort((a, b) => b.at - a.at)
}

// Review P6, n36: a refresh re-reads the audit, so every item is a new object and a list keyed by identity would draw every
// row again. This hands back the previous object for an id whose content is the same, so only new or changed rows are
// drawn. The content is compared whole (plain data, built the same way each time), so a changed outcome, kind or Undo is
// never hidden behind a reused row. Used for the History items and for the Waiting entries.
export function reuseById<T extends { id: string }>(previous: readonly T[], next: T[]): T[] {
  if (previous.length === 0) return next
  const known = new Map(previous.map((item) => [item.id, item]))
  return next.map((item) => {
    const old = known.get(item.id)
    return old && JSON.stringify(old) === JSON.stringify(item) ? old : item
  })
}

// The call a held request's answer is good for, as the server sent it. Only there while the request is open, and it never
// goes in the audit file: a whole edit is more than a record of decisions should keep.
export function heldCall(metadata: Record<string, unknown> | undefined): HeldCall | undefined {
  const call = metadata?.call
  if (typeof call !== "object" || call === null) return
  const { tool, args } = call as { tool?: unknown; args?: unknown }
  if (typeof tool !== "string") return
  const fields = typeof args === "object" && args !== null ? Object.entries(args) : [["input", args] as const]
  return {
    tool,
    args: fields.map(([name, value]) => ({ name, value: typeof value === "string" ? value : JSON.stringify(value) })),
  }
}

// Every call a held entry stands for. An entry that grew lists them in `calls`; one that did not has only `call`.
export function heldCalls(metadata: Record<string, unknown> | undefined): HeldCall[] {
  const calls = metadata?.calls
  if (!Array.isArray(calls)) {
    const one = heldCall(metadata)
    return one ? [one] : []
  }
  return calls.flatMap((call) => {
    const one = heldCall({ call })
    return one ? [one] : []
  })
}

// What an "always in this session" on a held entry would cover, as the server named it (row 258). Empty, and no button,
// when the call offered no "always" or the entry came back from a restart.
export function heldAlways(metadata: Record<string, unknown> | undefined): string[] {
  const always = metadata?.sessionAlways
  if (!Array.isArray(always)) return []
  return always.filter((pattern): pattern is string => typeof pattern === "string" && pattern.length > 0)
}

export type ConsentItem = {
  id: string
  kind: "secret" | "sensitive" | "outside" | "destination"
  pattern: string
  files: readonly string[]
  named: boolean
  checked: boolean
  given: boolean
}

export type ConsentList = {
  id: string
  hash: string
  items: readonly ConsentItem[]
  dropped: number
}

// Shown while something on the list is still not allowed. Once all of it is, the decided lines say so instead.
export function consentShown(list: ConsentList | null | undefined): ConsentList | undefined {
  if (!list || list.items.length === 0) return
  return list.items.some((item) => !item.given) ? list : undefined
}

// What starts ticked: what the scan ticked, and what was already allowed. Ticks the person made since win.
export function consentTicked(list: ConsentList, ticks: Readonly<Record<string, boolean | undefined>>) {
  return new Set(list.items.flatMap((item) => (item.given || (ticks[item.id] ?? item.checked) ? [item.id] : [])))
}

// Only the items not yet allowed, in list order, on the list named by its hash. Nothing ticked sends nothing.
export function consentAllowInput(rootID: string, list: ConsentList, ticked: ReadonlySet<string>) {
  const ids = list.items.filter((item) => !item.given && ticked.has(item.id)).map((item) => item.id)
  if (ids.length === 0) return
  return { sessionID: rootID, hash: list.hash, ids }
}

// Shown while there is something in it, or while it is a link the server will not read or empty.
export function archiveShown(archive: AutonomyArchive | null | undefined): AutonomyArchive | undefined {
  if (!archive) return
  return archive.unsafe || archive.entries.length > 0 ? archive : undefined
}

// The paths moved instead of deleted, over every entry.
export function archiveCount(archive: AutonomyArchive) {
  return archive.entries.reduce((sum, entry) => sum + entry.count, 0)
}

// Exactly the entries the person was shown in the confirmation. An unsafe archive is never emptied from here.
export function archiveEmptyInput(rootID: string, entries: readonly AutonomyArchiveEntry[], unsafe: boolean) {
  if (unsafe || entries.length === 0) return
  return { sessionID: rootID, ids: entries.map((entry) => entry.id) }
}

// P-01c: a checkpoint the server can put back. The first `checkpointed` line names it (that line, written at creation,
// is what the route checks the manifest against), so a later line cannot change what is listed. Latest first.
export type CheckpointItem = { id: string; at: number; entries?: number; reverted: boolean }

export function checkpointsOf(lines: readonly AutonomyAuditLine[]): CheckpointItem[] {
  const found = new Map<string, CheckpointItem>()
  const reverted = new Set<string>()
  for (const line of lines) {
    if (line.type !== "outcome" || !line.checkpoint) continue
    if (line.outcome === "checkpointed" && line.manifestSha256 && !found.has(line.checkpoint))
      found.set(line.checkpoint, { id: line.checkpoint, at: line.at, entries: line.entries, reverted: false })
    if (line.outcome === "undone" && line.requestID === `revert_${line.checkpoint}`) reverted.add(line.checkpoint)
  }
  return [...found.values()].map((item) => ({ ...item, reverted: reverted.has(item.id) })).reverse()
}

// SEC-06: the two person-only routes want the per-launch nonce of the desktop app. Asked for on each click and never
// kept: without it (web build, a server the app did not start) nothing is added and the route refuses with 403.
export const DESKTOP_NONCE_HEADER = "x-swarm-desktop-nonce"
export type NonceSource = () => Promise<string | null | undefined>

type NonceBridge = { api?: { desktopNonce?: () => Promise<string | null> } }

// The preload's `window.api.desktopNonce` (row 38b); absent outside the desktop app.
export const desktopNonce: NonceSource = async () => {
  try {
    return (await (globalThis as NonceBridge).api?.desktopNonce?.()) ?? null
  } catch {
    return null
  }
}

export function nonceHeader(nonce: string | null | undefined): { [DESKTOP_NONCE_HEADER]?: string } {
  return nonce ? { [DESKTOP_NONCE_HEADER]: nonce } : {}
}

type WithNonce = { [DESKTOP_NONCE_HEADER]?: string }

// The route call is passed in, so a test can see exactly what is sent.
export async function sendCheckpointRevert<R>(
  send: (input: { sessionID: string; checkpointID: string } & WithNonce) => Promise<R>,
  nonce: NonceSource,
  rootID: string,
  checkpointID: string,
) {
  return send({ sessionID: rootID, checkpointID, ...nonceHeader(await nonce()) })
}

export async function sendArchiveEmpty<R>(
  send: (input: { sessionID: string; ids: string[] } & WithNonce) => Promise<R>,
  nonce: NonceSource,
  input: { sessionID: string; ids: string[] },
) {
  return send({ ...input, ...nonceHeader(await nonce()) })
}

const SIZE_UNITS = ["byte", "kilobyte", "megabyte", "gigabyte", "terabyte"] as const

// A size in the person's locale, decimal units as the system file browsers show them.
export function archiveSize(bytes: number, locale: string) {
  const step = Math.min(SIZE_UNITS.length - 1, bytes < 1000 ? 0 : Math.floor(Math.log10(bytes) / 3))
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: SIZE_UNITS[step],
    unitDisplay: "short",
    maximumFractionDigits: step === 0 ? 0 : 1,
  }).format(bytes / 1000 ** step)
}

// What goes into the composer when someone asks about a step: enough for the agent to know which one is meant.
export function stepReference(step: MapStep) {
  const name = step.tool ?? step.kind
  return step.problem ? `${name} \`${step.label}\` (${step.problem})` : `${name} \`${step.label}\``
}

export function relativePath(path: string, directory: string) {
  const root = directory.replace(/\/+$/, "")
  return root && path.startsWith(root + "/") ? path.slice(root.length + 1) : path
}

export function formatDuration(ms: number) {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
