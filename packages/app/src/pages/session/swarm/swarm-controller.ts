import type { PermissionRequest, QuestionRequest, Session } from "@opencode-ai/sdk/v2/client"
import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { useSDK } from "@/context/sdk"
import type { useServerSync } from "@/context/server-sync"
import type { useSync } from "@/context/sync"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"
import { showToast } from "@/utils/toast"
import type { MapStep } from "../map/session-map-model"
import {
  buildSwarm,
  defaultLane,
  sessionTree,
  swarmPulse,
  type SwarmLane,
  type SwarmModel,
  type SwarmOverlap,
  type SwarmWrite,
} from "./swarm-model"

const LANE_HISTORY_LIMIT = 2000
const HYDRATE_CONCURRENCY = 3
const TICK_MS = 1000

export function createSwarm(input: {
  sessionID: Accessor<string | undefined>
  sdk: ReturnType<typeof useSDK>
  sync: ReturnType<typeof useSync>
  serverSync: ReturnType<typeof useServerSync>
  openLane: (sessionID: string, step?: MapStep) => void
  draftToComposer: (text: string) => void
  // History is read and the model built only while someone is looking at the agents.
  watching: Accessor<boolean>
}) {
  const language = useLanguage()
  const session = () => input.serverSync().session
  const data = () => session().data

  const [view, setView] = createStore({
    selected: undefined as string | undefined,
    // The row the reader folded. Without it the selection is always open.
    folded: false,
    discoverFailed: false,
    loading: {} as Record<string, boolean | undefined>,
    failed: {} as Record<string, boolean | undefined>,
    pending: {} as Record<string, boolean | undefined>,
    draft: {} as Record<string, string | undefined>,
    sent: undefined as string | undefined,
  })

  const rootID = createMemo(() => {
    const id = input.sessionID()
    if (!id) return
    const info = data().info
    const seen = new Set([id])
    let current = info[id]
    while (current?.parentID && !seen.has(current.parentID)) {
      seen.add(current.parentID)
      const parent: Session | undefined = info[current.parentID]
      if (!parent) return current.parentID
      current = parent
    }
    return current?.id ?? id
  })

  // The chain up to the root may not be in the store when a child session was opened directly.
  createEffect(() => {
    const id = rootID()
    if (id && !data().info[id])
      void session()
        .resolve(id)
        .catch(() => undefined)
  })

  const laneIDs = createMemo(() => {
    const id = rootID()
    if (!id) return []
    return sessionTree(id, data().info)
      .map((item) => item.id)
      .filter((item) => !!data().info[item])
  })

  // ---- Discovery: who is in this run. Sessions started later arrive through session.created. ----------------------

  const discovered = new Set<string>()
  const discover = async (sessionID: string, deep: boolean): Promise<void> => {
    if ((await input.sdk().protocol) !== "v1") return
    const result = await input.sdk().client.session.children({ sessionID }, { throwOnError: true })
    const children = result.data ?? []
    batch(() => children.forEach((child) => session().remember(child)))
    if (deep) await Promise.all(children.map((child) => discover(child.id, deep)))
  }
  const discoverAll = (roots: readonly string[], deep: boolean) => {
    setView("discoverFailed", false)
    return Promise.all(roots.map((id) => discover(id, deep))).catch(() => {
      setView("discoverFailed", true)
    })
  }

  // Knowing there are agents at all takes only the direct children, once per root. Looking at them walks the whole tree.
  createEffect(
    on(rootID, (id) => {
      if (!id || discovered.has(id)) return
      discovered.add(id)
      void discoverAll([id], false)
    }),
  )

  const pulse = createMemo(() => {
    const id = rootID()
    if (!id) return { agents: 0, needs: 0 }
    const current = data()
    return swarmPulse({
      rootID: id,
      info: current.info,
      permission: current.permission,
      question: current.question,
    })
  })

  // ---- History: every lane reads its messages through the shared session cache, pinned while the view is open. ------

  const pinned = new Set<string>()
  const queue: string[] = []
  let hydrating = 0

  const readLane = async (id: string) => {
    setView("loading", id, true)
    setView("failed", id, false)
    try {
      await session().sync(id)
      while (session().history.more(id) && (data().message[id]?.length ?? 0) < LANE_HISTORY_LIMIT) {
        const before = data().message[id]?.length ?? 0
        await session().history.loadMore(id)
        if ((data().message[id]?.length ?? 0) <= before) break
      }
    } catch {
      setView("failed", id, true)
    } finally {
      setView("loading", id, false)
    }
  }

  const pump = () => {
    while (hydrating < HYDRATE_CONCURRENCY && queue.length > 0) {
      const id = queue.shift()!
      hydrating += 1
      void readLane(id).finally(() => {
        hydrating -= 1
        pump()
      })
    }
  }

  createEffect(() => {
    if (!input.watching()) return
    laneIDs().forEach((id) => {
      if (pinned.has(id)) return
      pinned.add(id)
      session().pin(id)
      queue.push(id)
    })
    pump()
  })

  const release = () => {
    queue.length = 0
    pinned.forEach((id) => session().unpin(id))
    pinned.clear()
  }
  onCleanup(release)

  createEffect(
    on(
      rootID,
      () => {
        release()
        setView({ selected: undefined, folded: false, sent: undefined })
        setView("failed", reconcile({}))
        setView("loading", reconcile({}))
      },
      { defer: true },
    ),
  )

  // ---- The model: rebuilt on a clock while agents run, not on every streamed token. --------------------------------

  const [now, setNow] = createSignal(Date.now())
  const active = createMemo(() => laneIDs().some((id) => (data().session_status[id]?.type ?? "idle") !== "idle"))
  createEffect(() => {
    if (!input.watching() || !active()) return
    const timer = setInterval(() => {
      if (document.visibilityState !== "hidden") setNow(Date.now())
    }, TICK_MS)
    onCleanup(() => {
      clearInterval(timer)
      // A run's last message update can land just after its status goes idle; the clock has to outlive it once.
      setTimeout(() => setNow(Date.now()), TICK_MS * 2)
    })
  })

  const version = createMemo(() =>
    laneIDs()
      .map((id) => {
        const current = data()
        const last = current.message[id]?.at(-1)
        return [
          id,
          current.session_status[id]?.type,
          current.permission[id]?.length,
          current.question[id]?.length,
          current.message[id]?.length,
          current.info[id]?.cost,
          current.info[id]?.title,
          last?.role === "assistant" ? (last.error?.name ?? last.time.completed) : undefined,
        ].join(":")
      })
      .join("|"),
  )

  const model = createMemo<SwarmModel | undefined>(() => {
    if (!input.watching()) return
    const id = rootID()
    if (!id) return
    version()
    const at = now()
    return untrack(() => {
      const current = data()
      if (!current.info[id]) return
      return buildSwarm({
        rootID: id,
        info: current.info,
        status: current.session_status,
        permission: current.permission,
        question: current.question,
        messages: (sessionID) => current.message[sessionID],
        parts: (messageID) => current.part[messageID] ?? [],
        now: Math.max(at, Date.now()),
      })
    })
  })

  // A task step names its child before the child's session.created has necessarily reached this window.
  createEffect(() => {
    const current = model()
    if (!current) return
    current.lanes.forEach((lane) =>
      lane.model.steps.forEach((step) => {
        const child = step.kind === "agent" ? step.metadata?.sessionId : undefined
        if (typeof child === "string" && !untrack(() => data().info[child]))
          void session()
            .resolve(child)
            .catch(() => undefined)
      }),
    )
  })

  const selectedLane = createMemo(() => {
    const lanes = model()?.lanes ?? []
    return (
      lanes.find((lane) => lane.id === view.selected) ??
      lanes.find((lane) => lane.id === defaultLane(lanes, input.sessionID()))
    )
  })

  // ---- Stepping in ----------------------------------------------------------------------------------------------------

  const fail = (cause: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: errorMessage(cause, language.t("common.requestFailed")),
    })

  const act = (key: string, run: () => Promise<unknown>, settle?: () => void) => {
    if (view.pending[key]) return
    setView("pending", key, true)
    void run()
      .then(() => settle?.())
      .catch(fail)
      .finally(() => setView("pending", key, false))
  }

  const allow = (lane: SwarmLane, request: PermissionRequest, reply: "once" | "always" | "reject") =>
    act(
      lane.id,
      () =>
        input.sdk().api.permission.reply({
          sessionID: lane.id,
          requestID: request.id,
          reply,
          location: { directory: lane.session.directory },
        }),
      () => session().set("permission", lane.id, (list = []) => list.filter((item) => item.id !== request.id)),
    )

  const answer = (lane: SwarmLane, request: QuestionRequest, label: string) =>
    act(
      lane.id,
      () => input.sdk().api.question.reply({ sessionID: lane.id, requestID: request.id, answers: [[label]] }),
      () => session().set("question", lane.id, (list = []) => list.filter((item) => item.id !== request.id)),
    )

  const canTell = (lane: SwarmLane) => ["running", "waiting", "needs", "retry"].includes(lane.status)

  const tell = (lane: SwarmLane) => {
    const text = view.draft[lane.id]?.trim()
    if (!text || !canTell(lane)) return
    const user = lane.lastUser
    act(
      lane.id,
      () =>
        input.sdk().api.session.prompt({
          sessionID: lane.id,
          agent: user?.agent ?? lane.agent,
          model: user?.model ? { providerID: user.model.providerID, modelID: user.model.modelID } : undefined,
          text,
        } as Parameters<ReturnType<typeof input.sdk>["api"]["session"]["prompt"]>[0]),
      () => {
        setView("draft", lane.id, "")
        setView("sent", lane.id)
      },
    )
  }

  const stop = (lane: SwarmLane) => act(lane.id, () => input.sdk().api.session.interrupt({ sessionID: lane.id }))

  // Looking away lets go of the history; looking again walks the tree for anything started since.
  createEffect(
    on(
      input.watching,
      (watching) => {
        if (!watching) {
          release()
          setView("loading", reconcile({}))
          return
        }
        const id = rootID()
        if (id) void discoverAll([id], true)
      },
      { defer: true },
    ),
  )

  /** Puts the shared-file problem in front of whoever can still act on it: the last writer, else the main agent. */
  const check = (overlap: SwarmOverlap, write: SwarmWrite) => {
    const current = model()
    if (!current) return
    const other = overlap.writes.findLast((item) => item.laneID !== write.laneID)
    const lane = current.lanes.find((item) => item.id === write.laneID)
    const otherTitle = current.lanes.find((item) => item.id === other?.laneID)?.title ?? ""
    const text = language.t("session.swarm.overlap.draft", { path: overlap.path, other: otherTitle })
    if (lane && canTell(lane)) {
      batch(() => {
        setView({ selected: lane.id, folded: false, sent: undefined })
        setView("draft", lane.id, text)
      })
      return
    }
    input.draftToComposer(text)
  }

  return {
    view,
    model,
    pulse,
    rootID,
    selectedLane,
    canTell,
    allow,
    answer,
    tell,
    stop,
    check,
    open: (lane: SwarmLane, step?: MapStep) => input.openLane(lane.id, step),
    /** The selected row is the open one, so picking it again folds it. */
    toggle: (id: string) => {
      const same = selectedLane()?.id === id
      setView({ selected: id, folded: same && !view.folded, sent: undefined })
    },
    setDraft: (id: string, value: string) => setView("draft", id, value),
    retry: () => {
      const id = rootID()
      if (id) void discoverAll([id], true)
      laneIDs()
        .filter((item) => view.failed[item])
        .forEach((item) => queue.push(item))
      pump()
    },
  }
}

export type SwarmController = ReturnType<typeof createSwarm>
