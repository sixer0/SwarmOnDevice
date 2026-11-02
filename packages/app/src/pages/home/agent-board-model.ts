import type {
  GlobalAgents,
  PermissionRequest,
  QuestionRequest,
  Session,
  SessionStatus,
} from "@opencode-ai/sdk/v2/client"
import { canonicalPathKey } from "@/utils/path-key"

type BoardNotification = { type: "turn-complete" | "error"; time: number; error?: unknown }

export type AgentBoardInput = {
  info: Record<string, Session | undefined>
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  status: Record<string, SessionStatus | undefined>
  /** Sessions the notification store is consulted for: Home's recent session list. */
  recent: Session[]
  unseen: (sessionID: string) => readonly BoardNotification[]
  inScope: (directory: string) => boolean
}

export type AgentBoardNeed =
  | { kind: "permission"; key: string; request: PermissionRequest; session: Session; root: Session }
  | { kind: "question"; key: string; request: QuestionRequest; session: Session; root: Session }

export type AgentBoardRunning = { key: string; root: Session; status: SessionStatus }
export type AgentBoardFailed = { key: string; root: Session; error: unknown; time: number }

export type AgentBoard = {
  needs: AgentBoardNeed[]
  running: AgentBoardRunning[]
  failed: AgentBoardFailed[]
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
        // A decision autonomous mode put aside waits for nobody: its one place is the Activity filter.
        if (request.deferred) return []
        const found = locate(sessionID)
        if (!found) return []
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
    return unseen.length > 0 ? [{ session, unseen }] : []
  })

  return {
    needs,
    running,
    failed: settled.flatMap((item) => {
      const error = item.unseen.findLast((notification) => notification.type === "error")
      if (!error) return []
      return [{ key: item.session.id, root: item.session, error: error.error, time: error.time }]
    }),
    missing: [...missing],
  }
}

/** What a permission row shows: the literal command when the tool has one, otherwise what it wants to touch. */
export function permissionDetail(request: PermissionRequest) {
  const command = request.metadata?.command
  if (typeof command === "string" && command) return command
  return request.patterns.join("\n")
}

/** Why this request is the rare one worth reading: Undo cannot take it back. */
export function permissionRisk(request: PermissionRequest) {
  if (request.metadata?.risk === "remote") return "session.permission.leavesMachine" as const
  if (request.metadata?.risk === "irreversible") return "session.permission.cannotUndo" as const
  return undefined
}

/** Only a single single-select question can be answered in one keypress; anything richer opens the session. */
export function inlineQuestion(request: QuestionRequest) {
  const question = request.questions.length === 1 ? request.questions[0] : undefined
  if (!question || question.multiple || question.options.length === 0) return
  return question
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
  // What the store held when the request left. Anything that changed since is newer than the snapshot, and events win.
  before: AgentSnapshotBaseline = agentSnapshotBaseline(store),
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
  const settled = <T extends { id: string }>(
    current: Record<string, T[] | undefined>,
    listed: Map<string, T[]>,
    gone: string[],
  ) =>
    [...gone.map((id) => [id, [] as T[]] as const), ...listed].map(([id, requests]) => {
      const held = current[id] ?? []
      const answered = (request: T) => before.requests.has(request.id) && !held.some((item) => item.id === request.id)
      const arrived = held.filter(
        (item) => !before.requests.has(item.id) && !requests.some((request) => request.id === item.id),
      )
      return [
        id,
        [...requests.filter((request) => !answered(request)), ...arrived].toSorted((a, b) => byString(a.id, b.id)),
      ] as const
    })
  const moved = (id: string) => statusKey(store.session_status[id]) !== before.status.get(id)

  return {
    permission: settled(store.permission, permission, stale(store.permission, permission)),
    question: settled(store.question, question, stale(store.question, question)),
    status: [...status].filter(([id]) => !moved(id)),
    clearStatus: stale(store.session_status, status).filter((id) => !moved(id)),
  }
}

const statusKey = (status: SessionStatus | undefined) => (status ? JSON.stringify(status) : undefined)

export type AgentSnapshotBaseline = { requests: Set<string>; status: Map<string, string | undefined> }

/** Taken when a snapshot request leaves, so its answer can tell what happened while it was on the way. */
export function agentSnapshotBaseline(store: {
  permission: Record<string, PermissionRequest[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  session_status: Record<string, SessionStatus | undefined>
}): AgentSnapshotBaseline {
  return {
    requests: new Set(
      [...Object.values(store.permission), ...Object.values(store.question)].flatMap((list) =>
        (list ?? []).map((request) => request.id),
      ),
    ),
    status: new Map(Object.entries(store.session_status).map(([id, status]) => [id, statusKey(status)])),
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
