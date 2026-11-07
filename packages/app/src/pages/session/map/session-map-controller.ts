import { persisted, Persist } from "@/utils/persist"
import type { Message, Part } from "@opencode-ai/sdk/v2"
import { createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import {
  buildSessionMap,
  mapRows,
  nextProblem,
  sinceYouLooked,
  type MapChapter,
  type MapFilter,
  type MapStep,
} from "./session-map-model"

export type MapTarget = { turnID: string; partID?: string; error?: boolean }

const SEEN_LIMIT = 200
const SEARCH_DEBOUNCE = 150

export function createSessionMap(input: {
  sessionID: Accessor<string | undefined>
  messages: Accessor<readonly Message[]>
  parts: (messageID: string) => readonly Part[]
  revertMessageID: Accessor<string | undefined>
  historyMore: Accessor<boolean>
  historyLoading: Accessor<boolean>
  loadOlder: () => Promise<void>
  reveal: (target: MapTarget) => void
  visibleTurn: Accessor<string | undefined>
}) {
  const [store, setStore] = persisted(
    Persist.global("session-map"),
    // `wide` (row 133b, C175): the user widened the Activity pane for mission control; remembered across launches.
    createStore({ open: false, seen: {} as Record<string, number>, wide: false }),
  )
  const model = createMemo(() =>
    buildSessionMap({
      messages: input.messages(),
      parts: input.parts,
      revertMessageID: input.revertMessageID(),
      quiet: untrack,
    }),
  )

  const [view, setView] = createStore({
    filter: "all" as MapFilter,
    draft: "",
    query: "",
    selected: undefined as string | undefined,
    problem: undefined as string | undefined,
    hydrating: false,
    hydrateError: false,
  })
  const [expanded, setExpanded] = createStore<Record<string, boolean | undefined>>({})
  const [since, setSince] = createSignal<number>()

  const lastChapterID = createMemo(() => model().chapters.at(-1)?.id)
  const isOpen = (id: string, chapter: MapChapter | undefined) => expanded[id] ?? chapter?.id === lastChapterID()
  const rows = createMemo(() => mapRows({ model: model(), filter: view.filter, query: view.query, open: isOpen }))
  const fresh = createMemo(() => sinceYouLooked(model(), since()))

  const markSeen = (id: string) => {
    setStore(
      "seen",
      produce((seen) => {
        seen[id] = Date.now()
        const ids = Object.keys(seen)
        if (ids.length <= SEEN_LIMIT) return
        ids
          .sort((a, b) => seen[a]! - seen[b]!)
          .slice(0, ids.length - SEEN_LIMIT)
          .forEach((old) => delete seen[old])
      }),
    )
  }

  createEffect(
    on(input.sessionID, (id, previous) => {
      if (previous) markSeen(previous)
      setExpanded(reconcile({}))
      // Opening one agent of a run from the agents list keeps the list; the page leaves it once there are no agents.
      setView({
        filter: untrack(() => view.filter) === "agents" ? "agents" : "all",
        draft: "",
        query: "",
        selected: undefined,
        problem: undefined,
        hydrateError: false,
      })
      setSince(id ? untrack(() => store.seen[id]) : undefined)
    }),
  )

  const onVisibility = () => {
    const id = input.sessionID()
    if (!id) return
    if (document.visibilityState === "hidden") markSeen(id)
    else setSince(store.seen[id])
  }
  document.addEventListener("visibilitychange", onVisibility)
  onCleanup(() => {
    document.removeEventListener("visibilitychange", onVisibility)
    const id = input.sessionID()
    if (id) markSeen(id)
  })

  // Counts and search only mean something over the whole session, so older pages are read as soon as they are needed.
  // Each page goes through the timeline's own loader, which keeps the reader's scroll position.
  const hydrate = async () => {
    if (view.hydrating) return
    const id = input.sessionID()
    setView({ hydrating: true, hydrateError: false })
    try {
      while (input.sessionID() === id && input.historyMore()) {
        const before = input.messages().length
        await input.loadOlder()
        if (input.sessionID() !== id || input.messages().length > before) continue
        if (!input.historyLoading()) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    } catch {
      if (input.sessionID() === id) setView("hydrateError", true)
    } finally {
      setView("hydrating", false)
    }
  }

  createEffect(() => {
    if (store.open && input.sessionID() && input.historyMore() && !untrack(() => view.hydrateError)) void hydrate()
  })

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(searchTimer))
  const search = (value: string) => {
    setView("draft", value)
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => setView("query", value), SEARCH_DEBOUNCE)
  }

  const openStep = (step: MapStep) => {
    setExpanded(step.turnID, true)
    setView({ selected: step.id, problem: step.problem ? step.id : view.problem })
    input.reveal({ turnID: step.turnID, partID: step.partID, error: step.kind === "error" })
  }

  const problem = async (direction: 1 | -1) => {
    await hydrate()
    const step = nextProblem(model(), direction, { stepID: view.problem, turnID: input.visibleTurn() })
    if (!step) return false
    openStep(step)
    return true
  }

  return {
    model,
    rows,
    fresh,
    since,
    view,
    search,
    problem,
    openStep,
    hydrate,
    opened: () => store.open,
    open: () => setStore("open", true),
    close: () => setStore("open", false),
    wide: () => store.wide === true,
    setWide: (wide: boolean) => setStore("wide", wide),
    dismissFresh: () => setSince(undefined),
    setFilter: (filter: MapFilter) => setView({ filter, selected: undefined }),
    select: (id: string | undefined) => setView("selected", id),
    setExpanded: (id: string, open: boolean) => setExpanded(id, open),
    openChapter: (chapter: MapChapter) => {
      setExpanded(chapter.id, true)
      setView("selected", chapter.id)
      input.reveal({ turnID: chapter.id })
    },
    openOutcome: (chapter: MapChapter) => {
      if (!chapter.outcome) return
      input.reveal({ turnID: chapter.id, partID: chapter.outcome.partID })
    },
    visibleTurn: input.visibleTurn,
  }
}

export type SessionMapController = ReturnType<typeof createSessionMap>
