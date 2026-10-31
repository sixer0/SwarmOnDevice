import type { AssistantMessage, Message, Part, ToolPart, UserMessage } from "@opencode-ai/sdk/v2"

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
  // Why this step counts as a problem. A shell command that exits non-zero completes normally as far as the tool is
  // concerned, so the exit code has to be read from its metadata.
  problem?: string
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
  if (tool === "read" || tool === "grep" || tool === "glob" || tool === "list") return "explore"
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

const problemOf = (part: ToolPart) => {
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
            detail:
              part.state.status === "completed" && problemOf(part)
                ? quiet(() => failureLine(text(part.state.status === "completed" ? part.state.output : "")))
                : undefined,
            running: part.state.status === "running" || part.state.status === "pending",
            start: time.start,
            end: time.end,
            files: changesOf(part),
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

export type MapFilter = "all" | "problems" | "edits" | "commands" | "agents"

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
  if (filter === "commands") return step.kind === "command"
  if (filter === "agents") return step.kind === "agent"
  return true
}

// The flat list the panel renders and the keyboard walks. `open` decides which chapters and files show their steps.
export function mapRows(input: {
  model: SessionMapModel
  filter: MapFilter
  query: string
  open: (id: string, chapter: MapChapter | undefined) => boolean
}): MapRow[] {
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

export type RunStripCell = {
  start: number
  steps: MapStep[]
  problem: boolean
  edit: boolean
  running: boolean
  fresh: boolean
}

// One cell per step until the strip runs out of width, then steps share a cell and the worst of them shows.
export function runStrip(steps: readonly MapStep[], cells: number, since?: number): RunStripCell[] {
  if (steps.length === 0 || cells <= 0) return []
  const width = Math.max(1, Math.ceil(steps.length / cells))
  return Array.from({ length: Math.ceil(steps.length / width) }, (_, index) => {
    const group = steps.slice(index * width, (index + 1) * width)
    return {
      start: index * width,
      steps: group,
      problem: group.some((step) => step.problem),
      edit: group.some((step) => step.kind === "edit"),
      running: group.some((step) => step.running),
      fresh: since !== undefined && group.some((step) => step.start > since),
    }
  })
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
