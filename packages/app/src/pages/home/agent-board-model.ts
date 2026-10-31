import type {
  GlobalAgents,
  Part,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { canonicalPathKey } from "@/utils/path-key"

export const AGENT_BOARD_FINISHED_LIMIT = 6

type BoardNotification = { type: "turn-complete" | "error"; time: number; error?: unknown }

export type AgentBoardInput = {
  info: Record<string, Session | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  status: Record<string, SessionStatus | undefined>
  /** Sessions the notification store is consulted for: Home's recent session list. */
  recent: Session[]
  unseen: (sessionID: string) => readonly BoardNotification[]
  autoResponds: (request: PermissionRequest, directory: string) => boolean
  inScope: (directory: string) => boolean
}

export type AgentBoardNeed =
  | { kind: "permission"; key: string; request: PermissionRequest; session: Session; root: Session }
  | { kind: "question"; key: string; request: QuestionRequest; session: Session; root: Session }

export type AgentBoardRunning = { key: string; root: Session; status: SessionStatus }
export type AgentBoardFailed = { key: string; root: Session; error: unknown; time: number }
export type AgentBoardFinished = { key: string; root: Session; time: number }

export type AgentBoard = {
  needs: AgentBoardNeed[]
  running: AgentBoardRunning[]
  failed: AgentBoardFailed[]
  finished: AgentBoardFinished[]
  /** Session ids the board cannot place yet; the controller resolves them and the board recomputes. */
  missing: string[]
}

/** Stopping an agent is something the user just did, not a failure to report back to them. */
const isUserAbort = (notification: BoardNotification) =>
  notification.type === "error" &&
  typeof notification.error === "object" &&
  notification.error !== null &&
  "name" in notification.error &&
  notification.error.name === "MessageAbortedError"

const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A subagent's request belongs to the session the user actually started, so the board rolls it up to the root. */
function rootOf(info: AgentBoardInput["info"], sessionID: string) {
  const seen = new Set<string>()
  let current = info[sessionID]
  if (!current) return { missing: sessionID }
  while (current.parentID && !seen.has(current.id)) {
    seen.add(current.id)
    const parent: Session | undefined = info[current.parentID]
    if (!parent) return { missing: current.parentID }
    current = parent
  }
  return { session: info[sessionID]!, root: current }
}

export function buildAgentBoard(input: AgentBoardInput): AgentBoard {
  const missing = new Set<string>()
  const locate = (sessionID: string) => {
    const found = rootOf(input.info, sessionID)
    if ("missing" in found) {
      missing.add(found.missing!)
      return
    }
    if (!input.inScope(found.session.directory)) return
    return found
  }

  // Requests sort by id, which is time-ordered: the agent that has waited longest stays on top, and rows never
  // reshuffle under the keyboard when a newer request arrives.
  const needs = [
    ...Object.entries(input.permission).flatMap(([sessionID, requests]) =>
      (requests ?? []).flatMap((request): AgentBoardNeed[] => {
        const found = locate(sessionID)
        if (!found || input.autoResponds(request, found.session.directory)) return []
        return [{ kind: "permission", key: request.id, request, session: found.session, root: found.root }]
      }),
    ),
    ...Object.entries(input.question).flatMap(([sessionID, requests]) =>
      (requests ?? []).flatMap((request): AgentBoardNeed[] => {
        const found = locate(sessionID)
        if (!found) return []
        return [{ kind: "question", key: request.id, request, session: found.session, root: found.root }]
      }),
    ),
  ].sort((a, b) => byString(a.key, b.key))

  const waiting = new Set(needs.map((need) => need.root.id))

  const running = [
    ...new Map(
      Object.entries(input.status).flatMap(([sessionID, status]) => {
        if (!status || status.type === "idle") return []
        const found = locate(sessionID)
        if (!found || waiting.has(found.root.id)) return []
        // A retrying root says more than a busy child, so the root's own status wins when both are active.
        return [
          [found.root.id, { key: found.root.id, root: found.root, status: input.status[found.root.id] ?? status }],
        ] as const
      }),
    ).values(),
  ].sort((a, b) => byString(b.key, a.key))

  const active = new Set([...waiting, ...running.map((item) => item.key)])
  const settled = input.recent.flatMap((session) => {
    if (session.parentID || active.has(session.id) || !input.inScope(session.directory)) return []
    const unseen = input.unseen(session.id).filter((notification) => !isUserAbort(notification))
    const latest = unseen.at(-1)
    return latest ? [{ session, unseen, latest }] : []
  })

  return {
    needs,
    running,
    failed: settled.flatMap((item) => {
      const error = item.unseen.findLast((notification) => notification.type === "error")
      if (!error) return []
      return [{ key: item.session.id, root: item.session, error: error.error, time: error.time }]
    }),
    finished: settled
      .filter((item) => item.unseen.every((notification) => notification.type !== "error"))
      .map((item) => ({ key: item.session.id, root: item.session, time: item.latest.time }))
      .sort((a, b) => b.time - a.time),
    missing: [...missing],
  }
}

/** What a permission row shows: the literal command when the tool has one, otherwise what it wants to touch. */
export function permissionDetail(request: PermissionRequest) {
  const command = request.metadata?.command
  if (typeof command === "string" && command) return command
  return request.patterns.join("\n")
}

/** Only a single single-select question can be answered in one keypress; anything richer opens the session. */
export function inlineQuestion(request: QuestionRequest) {
  const question = request.questions.length === 1 ? request.questions[0] : undefined
  if (!question || question.multiple || question.options.length === 0) return
  return question
}

export type AgentActivityKey =
  | "ui.sessionTurn.status.runningCommands"
  | "ui.sessionTurn.status.makingEdits"
  | "ui.sessionTurn.status.searchingWeb"
  | "ui.sessionTurn.status.delegating"
  | "ui.sessionTurn.status.gatheringContext"
  | "ui.sessionTurn.status.thinking"

const TOOL_ACTIVITY: Record<string, AgentActivityKey> = {
  bash: "ui.sessionTurn.status.runningCommands",
  edit: "ui.sessionTurn.status.makingEdits",
  write: "ui.sessionTurn.status.makingEdits",
  apply_patch: "ui.sessionTurn.status.makingEdits",
  webfetch: "ui.sessionTurn.status.searchingWeb",
  websearch: "ui.sessionTurn.status.searchingWeb",
  task: "ui.sessionTurn.status.delegating",
  read: "ui.sessionTurn.status.gatheringContext",
  grep: "ui.sessionTurn.status.gatheringContext",
  glob: "ui.sessionTurn.status.gatheringContext",
  list: "ui.sessionTurn.status.gatheringContext",
}

/** The agent's current step, read off the newest part of its latest message. */
export function agentActivity(parts: readonly Part[] | undefined): AgentActivityKey | undefined {
  const part = parts?.findLast((item) => item.type === "tool" || item.type === "reasoning" || item.type === "text")
  if (!part) return
  if (part.type !== "tool") return "ui.sessionTurn.status.thinking"
  return TOOL_ACTIVITY[part.tool] ?? "ui.sessionTurn.status.thinking"
}

/**
 * Turns `GET /global/agents` into store writes. Without it a freshly opened app only knows what events say from now
 * on, so an agent already blocked on a permission looks idle. Entries the snapshot no longer lists are cleared only
 * for sessions in a directory it reports on: a session elsewhere (a remote workspace) is not this server's to declare
 * finished.
 */
export function agentSnapshotWrites(
  store: {
    info: AgentBoardInput["info"]
    permission: Record<string, PermissionRequest[] | undefined>
    question: Record<string, QuestionRequest[] | undefined>
    session_status: Record<string, SessionStatus | undefined>
  },
  snapshot: Pick<GlobalAgents, "instances">,
) {
  const directories = new Set(snapshot.instances.map((instance) => canonicalPathKey(instance.directory)))
  const permission = Map.groupBy(
    snapshot.instances.flatMap((instance) => instance.permission as PermissionRequest[]),
    (request) => request.sessionID,
  )
  const question = Map.groupBy(
    snapshot.instances.flatMap((instance) => instance.question as QuestionRequest[]),
    (request) => request.sessionID,
  )
  const status = new Map<string, SessionStatus>(
    snapshot.instances.flatMap((instance) => Object.entries(instance.status)),
  )
  const stale = (current: Record<string, unknown>, listed: Map<string, unknown>) =>
    Object.keys(current).filter((id) => {
      const directory = store.info[id]?.directory
      return !listed.has(id) && !!directory && directories.has(canonicalPathKey(directory))
    })
  const sorted = <T extends { id: string }>(requests: T[]) => requests.toSorted((a, b) => byString(a.id, b.id))

  return {
    permission: [
      ...stale(store.permission, permission).map((id) => [id, [] as PermissionRequest[]] as const),
      ...[...permission].map(([id, requests]) => [id, sorted(requests)] as const),
    ],
    question: [
      ...stale(store.question, question).map((id) => [id, [] as QuestionRequest[]] as const),
      ...[...question].map(([id, requests]) => [id, sorted(requests)] as const),
    ],
    status: [...status],
    clearStatus: stale(store.session_status, status),
  }
}

export function agentSnapshotSessions(snapshot: Pick<GlobalAgents, "instances">) {
  return [
    ...new Set(
      snapshot.instances.flatMap((instance) => [
        ...Object.keys(instance.status),
        ...instance.permission.map((request) => request.sessionID),
        ...instance.question.map((request) => request.sessionID),
      ]),
    ),
  ]
}
