import type { GlobalAgents, PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { useQuery } from "@tanstack/solid-query"
import { type Accessor, batch, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { ServerConnection } from "@/context/server"
import { errorMessage } from "@/pages/layout/helpers"
import { canonicalPathKey } from "@/utils/path-key"
import { showToast } from "@/utils/toast"
import {
  AGENT_BOARD_FINISHED_LIMIT,
  agentActivity,
  agentSnapshotSessions,
  agentSnapshotWrites,
  buildAgentBoard,
  type AgentBoard,
  type AgentBoardNeed,
} from "./agent-board-model"
import type { HomeController } from "./home-controller"
import type { HomeSessionsController } from "./home-sessions-controller"

const AGENT_SNAPSHOT_INTERVAL_MS = 30_000
// Running rows read the agent's current step from its messages; past this many the cost is not worth the label.
const AGENT_ACTIVITY_SYNC_LIMIT = 8

type ServerContext = ReturnType<ReturnType<typeof useGlobal>["ensureServerCtx"]>

const [focusRequest, setFocusRequest] = createSignal(0)
/** Asks the board to put the keyboard on its first row, including a board Home is only about to mount. */
export const requestAgentBoardFocus = () => setFocusRequest((value) => value + 1)
export const agentBoardFocusRequest = focusRequest

/**
 * Keeps the session store honest about agents already running or blocked when this window opened. Shared through the
 * query cache, so Home and the titlebar cost one request. Returns null on a server without the route: the board still
 * works from live events there, it just cannot see the past.
 */
export function createAgentSnapshot(ctx: Accessor<ServerContext | undefined>) {
  return useQuery(() => ({
    queryKey: ["agent-snapshot", ctx()?.sdk.scope] as const,
    enabled: !!ctx(),
    retry: false,
    staleTime: 10_000,
    refetchInterval: AGENT_SNAPSHOT_INTERVAL_MS,
    queryFn: async (): Promise<GlobalAgents | null> => {
      const current = ctx()
      if (!current || (await current.sdk.protocol) !== "v1") return null
      const result = await current.sdk.client.global.agents({ throwOnError: false })
      if (result.response?.status === 404) return null
      if (!result.data) throw new Error(`Agent activity request failed: ${result.response?.status ?? "no response"}`)
      const session = current.sync.session
      const writes = agentSnapshotWrites(session.data, result.data)
      batch(() => {
        writes.permission.forEach(([id, list]) => session.set("permission", id, reconcile(list, { key: "id" })))
        writes.question.forEach(([id, list]) => session.set("question", id, reconcile(list, { key: "id" })))
        writes.status.forEach(([id, status]) => session.set("session_status", id, reconcile(status)))
        session.set(
          "session_status",
          produce((draft) => writes.clearStatus.forEach((id) => delete draft[id])),
        )
      })
      agentSnapshotSessions(result.data).forEach((id) => void session.resolve(id).catch(() => undefined))
      return result.data
    },
  }))
}

function createBoardState(input: {
  server: Accessor<ServerConnection.Any | undefined>
  context: Accessor<ServerContext | undefined>
  recent: Accessor<Session[]>
  inScope: (directory: string) => boolean
}) {
  const notification = useNotification()
  const permission = usePermission()
  const board = createMemo((): AgentBoard => {
    const ctx = input.context()
    const conn = input.server()
    if (!ctx || !conn) return { needs: [], running: [], failed: [], finished: [], missing: [] }
    const key = ServerConnection.key(conn)
    const session = ctx.sync.session.data
    return buildAgentBoard({
      info: session.info,
      permission: session.permission,
      question: session.question,
      status: session.session_status,
      recent: input.recent(),
      unseen: (id) => notification.ensureServerState(key).session.unseen(id),
      autoResponds: (request, directory) => permission.ensureServerState(key).autoResponds(request, directory),
      inScope: input.inScope,
    })
  })

  const asked = new Set<string>()
  createEffect(() => {
    const ctx = input.context()
    board()
      .missing.filter((id) => !asked.has(id))
      .forEach((id) => {
        asked.add(id)
        void ctx?.sync.session.resolve(id).catch(() => undefined)
      })
  })

  return board
}

/** The titlebar's view: how many agents are stuck waiting on the user, wherever the user currently is. */
export function createAgentAttention(conn: Accessor<ServerConnection.Any | undefined>) {
  const global = useGlobal()
  const context = createMemo(() => {
    const current = conn()
    return current ? global.ensureServerCtx(current) : undefined
  })
  createAgentSnapshot(context)
  const board = createBoardState({ server: conn, context, recent: () => [], inScope: () => true })
  return createMemo(() => board().needs.length)
}

export function createAgentBoardController(home: HomeController, sessions: HomeSessionsController) {
  const notification = useNotification()
  const language = useLanguage()
  const context = home.server.focusedContext
  const snapshot = createAgentSnapshot(context)

  const inScope = (directory: string) => {
    const project = home.project.selected()
    if (!project) return true
    const key = canonicalPathKey(directory)
    return [project.worktree, ...(project.sandboxes ?? [])].some((item) => canonicalPathKey(item) === key)
  }

  const live = createBoardState({
    server: home.server.focused,
    context,
    recent: () => sessions.data.records().map((record) => record.session),
    inScope,
  })

  // Rows keep their identity across updates: rebuilding them would drop keyboard focus on every status event.
  const [board, setBoard] = createStore<AgentBoard>({ needs: [], running: [], failed: [], finished: [], missing: [] })
  createEffect(() => setBoard(reconcile(live(), { key: "key" })))

  const [pending, setPending] = createStore<Record<string, boolean>>({})

  const fail = (cause: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: errorMessage(cause, language.t("common.requestFailed")),
    })

  /** One in flight per row. `settle` drops the row at once rather than waiting for the event to come back. */
  const act = (key: string, run: (ctx: ServerContext) => Promise<unknown>, settle?: (ctx: ServerContext) => void) => {
    const ctx = context()
    if (!ctx || pending[key]) return
    setPending(key, true)
    void run(ctx)
      .then(() => settle?.(ctx))
      .catch(fail)
      .finally(() => setPending(key, false))
  }

  const scoped = (ctx: ServerContext, directory: string) => ctx.sdk.createClient({ directory, throwOnError: true })

  const drop = {
    permission: (ctx: ServerContext, request: PermissionRequest) =>
      ctx.sync.session.set("permission", request.sessionID, (list = []) =>
        list.filter((item) => item.id !== request.id),
      ),
    question: (ctx: ServerContext, request: QuestionRequest) =>
      ctx.sync.session.set("question", request.sessionID, (list = []) => list.filter((item) => item.id !== request.id)),
  }

  const answerQuestion = (need: Extract<AgentBoardNeed, { kind: "question" }>, label: string) =>
    act(
      need.key,
      async (ctx) => {
        if ((await ctx.sdk.protocol) === "v1")
          return scoped(ctx, need.session.directory).question.reply({
            requestID: need.request.id,
            answers: [[label]],
          })
        return ctx.sdk.api.question.reply({
          sessionID: need.session.id,
          requestID: need.request.id,
          answers: [[label]],
        })
      },
      (ctx) => drop.question(ctx, need.request),
    )

  const markViewed = (sessionID: string) => {
    const conn = home.server.focused()
    if (conn) notification.ensureServerState(ServerConnection.key(conn)).session.markViewed(sessionID)
  }

  return {
    board,
    finishedVisible: () => board.finished.slice(0, AGENT_BOARD_FINISHED_LIMIT),
    pending: (key: string) => !!pending[key],
    status: {
      checking: () => snapshot.isLoading,
      failed: () => snapshot.isError,
      retrying: () => snapshot.isFetching,
      retry: () => void snapshot.refetch(),
    },
    activity: (sessionID: string) => {
      const data = context()?.sync.session.data
      const message = data?.message[sessionID]?.at(-1)
      return agentActivity(message ? data?.part[message.id] : undefined)
    },
    since: (root: Session) =>
      context()?.sync.session.data.message[root.id]?.findLast((message) => message.role === "user")?.time.created ??
      root.time.updated ??
      root.time.created,
    project: (directory: string) => {
      const key = canonicalPathKey(directory)
      return home.project
        .list()
        .find(
          (project) =>
            canonicalPathKey(project.worktree) === key ||
            project.sandboxes?.some((sandbox) => canonicalPathKey(sandbox) === key),
        )
    },
    server: () => home.selection.value().server,
    showProjectName: sessions.session.showProjectName,
    open: (root: Session) => sessions.session.open(root),
    syncActivity: (running: readonly { key: string }[]) => {
      const ctx = context()
      running.slice(0, AGENT_ACTIVITY_SYNC_LIMIT).forEach((item) => {
        void ctx?.sync.session.sync(item.key).catch(() => undefined)
      })
    },
    allow: (need: Extract<AgentBoardNeed, { kind: "permission" }>, reply: "once" | "always" | "reject") =>
      act(
        need.key,
        (ctx) =>
          ctx.sdk.api.permission.reply({
            sessionID: need.session.id,
            requestID: need.request.id,
            reply,
            location: { directory: need.session.directory },
          }),
        (ctx) => drop.permission(ctx, need.request),
      ),
    answer: answerQuestion,
    stop: (root: Session) =>
      act(root.id, async (ctx) => {
        if ((await ctx.sdk.protocol) === "v1") return scoped(ctx, root.directory).session.abort({ sessionID: root.id })
        return ctx.sdk.api.session.interrupt({ sessionID: root.id })
      }),
    dismiss: markViewed,
    clearFinished: () => batch(() => board.finished.forEach((item) => markViewed(item.key))),
  }
}

export type AgentBoardController = ReturnType<typeof createAgentBoardController>

/** Ticks once in a while so elapsed times stay honest without one timer per row. */
export function createMinuteClock() {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 30_000)
  onCleanup(() => clearInterval(timer))
  return now
}
