import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { Session } from "@opencode-ai/sdk/v2"
import { Global } from "@opencode-ai/core/global"
import { hostname } from "node:os"
import { createEffect, createMemo, createRoot, createSignal } from "solid-js"
import { collectAgents, FAILED_WINDOW, mergeRows, summarizeHistory, type FleetAgent, type FleetEntry, type FleetHistory } from "./model"
import { fleetDirectory, publish, readPeers, takeGoto, tmuxContext, unpublish } from "./registry"
import { fleetHost } from "./host"

const RECONCILE_EVERY = 15_000
const HEARTBEAT_EVERY = 10_000
const PEERS_EVERY = 1_000
const HISTORY_LIMIT = 6
const SESSIONS_PER_DIRECTORY = 30

export type FleetStateInput = Pick<TuiPluginApi, "client" | "event" | "state"> & {
  /** Defaults to the machine's registry; tests point it elsewhere. */
  directory?: string
  /** Called once for each request that appears after the first load. */
  onNewlyBlocked: () => void
  onGoto: (sessionID: string) => void
}

export function createFleetState(input: FleetStateInput) {
  const dir = input.directory ?? fleetDirectory(Global.Path.state)
  const tmux = tmuxContext()
  const host = hostname()
  const sessions = new Map<string, Session>()
  const history = new Map<string, FleetHistory>()
  const staleHistory = new Set<string>()
  const errors = new Map<string, { message: string; time: number }>()
  const firstSeen = new Map<string, number>()
  const seenRequests = new Set<string>()
  // Every process can list every session from the shared database, but a pane can only speak for what it ran itself:
  // publishing the rest would send a jump to whichever pane happened to report the session first.
  const ran = new Set<string>()
  const timers: ReturnType<typeof setInterval>[] = []
  const unsubscribe: (() => void)[] = []

  const { rows, status, error, local, peers, setLocal, setPeers, setStatus, setError, hidden, setHidden, dispose } =
    createRoot((dispose) => {
      const [local, setLocal] = createSignal<FleetAgent[]>([])
      const [peers, setPeers] = createSignal<FleetEntry[]>([])
      const [status, setStatus] = createSignal<"loading" | "ready">("loading")
      const [error, setError] = createSignal<string>()
      const [hidden, setHidden] = createSignal<ReadonlySet<string>>(new Set())
      const rows = createMemo(() =>
        mergeRows({
          // A request just answered leaves at once; the refresh decides what the session is doing next.
          local: local().filter((agent) => !agent.pending || !hidden().has(agent.pending.id)),
          peers: peers(),
          self: { server: fleetHost.server(), tmuxSocket: tmux?.socket },
        }),
      )
      createEffect(() => fleetHost.setWaiting(rows().filter((row) => row.state === "waiting").length))
      return { rows, status, error, local, peers, setLocal, setPeers, setStatus, setError, hidden, setHidden, dispose }
    })

  let inFlight = false
  let again = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let lastPublished = ""
  let lastPublishedAt = 0
  let loaded = false

  function schedule(delay: number) {
    if (timer || disposed) return
    timer = setTimeout(() => {
      timer = undefined
      void refresh()
    }, delay)
  }

  async function loadHistory(session: Pick<Session, "id" | "time"> & { directory: string }) {
    const cached = history.get(session.id)
    if (cached && cached.updated === session.time.updated && !staleHistory.has(session.id)) return
    staleHistory.delete(session.id)
    const messages = await input.client.session
      .messages({ sessionID: session.id, directory: session.directory, limit: HISTORY_LIMIT })
      .catch(() => undefined)
    if (messages?.data) history.set(session.id, summarizeHistory(messages.data, session.time.updated))
  }

  async function refresh() {
    if (disposed) return
    if (inFlight) {
      again = true
      return
    }
    inFlight = true
    try {
      const now = Date.now()
      const agents = await input.client.global.agents({ throwOnError: true })
      const instances = agents.data.instances
      const directories = [...new Set([...instances.map((item) => item.directory), input.state.path.directory])].filter(Boolean)
      const listed = await Promise.all(
        directories.map((directory) =>
          input.client.session
            .list({ directory, roots: true, start: now - FAILED_WINDOW, limit: SESSIONS_PER_DIRECTORY })
            .then((result) => result.data ?? [])
            .catch(() => [] as Session[]),
        ),
      )
      const current = new Map(listed.flat().map((session) => [session.id, session]))
      // Running or blocked sessions the list did not return: subagents, and anything older than the window.
      const active = instances.flatMap((instance) => [
        ...Object.keys(instance.status).map((id) => ({ id, directory: instance.directory })),
        ...instance.permission.map((item) => ({ id: item.sessionID, directory: instance.directory })),
        ...instance.question.map((item) => ({ id: item.sessionID, directory: instance.directory })),
      ])
      await Promise.all(
        active.map(async (item) => {
          if (current.has(item.id)) return
          const known = sessions.get(item.id)
          if (known) {
            current.set(item.id, known)
            return
          }
          const found = await input.client.session
            .get({ sessionID: item.id, directory: item.directory })
            .catch(() => undefined)
          if (found?.data) current.set(item.id, found.data)
        }),
      )
      sessions.clear()
      current.forEach((session, id) => sessions.set(id, session))

      await Promise.all(
        [...current.values()]
          .filter((session) => !session.parentID || active.some((item) => item.id === session.id))
          .map((session) => loadHistory(session)),
      )
      ;[...history.keys()].filter((id) => !current.has(id)).forEach((id) => history.delete(id))

      active.forEach((item) => ran.add(item.id))
      const next = collectAgents({ instances, sessions, history, errors, firstSeen, now: Date.now() })
      const requests = next.flatMap((agent) => (agent.pending ? [agent.pending.id] : []))
      const fresh = requests.filter((id) => !seenRequests.has(id))
      seenRequests.clear()
      requests.forEach((id) => seenRequests.add(id))
      if (loaded && fresh.length > 0) input.onNewlyBlocked()
      loaded = true
      setHidden((items) => new Set([...items].filter((id) => requests.includes(id) && inFlightReplies.has(id))))
      setLocal(next)
      setError(undefined)
      publishNow(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStatus("ready")
      inFlight = false
      if (again) {
        again = false
        schedule(0)
      }
    }
  }

  const inFlightReplies = new Set<string>()

  function publishNow(all: FleetAgent[]) {
    const agents = all.filter((agent) => ran.has(agent.sessionID))
    const body = JSON.stringify(agents)
    const now = Date.now()
    if (body === lastPublished && now - lastPublishedAt < HEARTBEAT_EVERY) return
    lastPublished = body
    lastPublishedAt = now
    try {
      publish(dir, {
        version: 1,
        pid: process.pid,
        host,
        directory: input.state.path.directory,
        server: fleetHost.server(),
        tmux,
        updated: now,
        agents,
      })
    } catch (cause) {
      // Seeing other panes is a convenience: a read-only state directory must not disturb the session in this one.
      console.debug("fleet: could not publish", { cause })
    }
  }

  function readOthers() {
    const others = readPeers(dir, { self: process.pid, now: Date.now(), host })
    setPeers((current) => (JSON.stringify(current.map(comparable)) === JSON.stringify(others.map(comparable)) ? current : others))
    const goto = takeGoto(dir, process.pid)
    if (goto) input.onGoto(goto)
  }

  const markSession = (sessionID: string | undefined, delay: number) => {
    if (sessionID) staleHistory.add(sessionID)
    schedule(delay)
  }

  unsubscribe.push(
    input.event.on("permission.asked", (event) => markSession(event.properties.sessionID, 50)),
    input.event.on("question.asked", (event) => markSession(event.properties.sessionID, 50)),
    input.event.on("permission.replied", (event) => markSession(event.properties.sessionID, 100)),
    input.event.on("question.replied", (event) => markSession(event.properties.sessionID, 100)),
    input.event.on("question.rejected", (event) => markSession(event.properties.sessionID, 100)),
    input.event.on("session.status", (event) => {
      if (event.properties.status.type === "busy") {
        ran.add(event.properties.sessionID)
        errors.delete(event.properties.sessionID)
      }
      markSession(event.properties.sessionID, 150)
    }),
    input.event.on("session.error", (event) => {
      const sessionID = event.properties.sessionID
      const failure = event.properties.error
      if (sessionID && failure && failure.name !== "MessageAbortedError") {
        const data = failure.data as { message?: unknown } | undefined
        errors.set(sessionID, { message: typeof data?.message === "string" ? data.message : failure.name, time: Date.now() })
      }
      markSession(sessionID, 150)
    }),
    input.event.on("session.updated", () => schedule(500)),
    input.event.on("session.deleted", () => schedule(100)),
    // Tool calls move the "what is it doing" line. Text deltas arrive on another event, on purpose not watched here.
    input.event.on("message.part.updated", (event) => markSession(event.properties.part.sessionID, 800)),
  )

  timers.push(
    setInterval(() => void refresh(), RECONCILE_EVERY),
    setInterval(readOthers, PEERS_EVERY),
    setInterval(() => publishNow(local()), HEARTBEAT_EVERY),
  )
  readOthers()
  void refresh()

  return {
    rows,
    status,
    error,
    hide(requestID: string) {
      inFlightReplies.add(requestID)
      setHidden((items) => new Set(items).add(requestID))
    },
    unhide(requestID: string) {
      inFlightReplies.delete(requestID)
      setHidden((items) => new Set([...items].filter((id) => id !== requestID)))
    },
    settled(requestID: string) {
      inFlightReplies.delete(requestID)
      schedule(0)
    },
    refresh: () => schedule(0),
    dispose() {
      disposed = true
      timers.forEach(clearInterval)
      if (timer) clearTimeout(timer)
      unsubscribe.forEach((off) => off())
      unpublish(dir, process.pid)
      dispose()
    },
  }
}

export type FleetStore = ReturnType<typeof createFleetState>

/** A peer's heartbeat changes `updated` every 10s; that alone is no reason to redraw. */
const comparable = (entry: FleetEntry) => ({ ...entry, updated: 0 })
