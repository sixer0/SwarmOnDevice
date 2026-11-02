import { createEffect, createMemo, on, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { PermissionRequest, QuestionRequest, Todo } from "@opencode-ai/sdk/v2"
import { useParams } from "@solidjs/router"
import { showToast } from "@/utils/toast"
import { replyHeld } from "@/utils/permission-reply"
import { useServerSync } from "@/context/server-sync"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { useSync } from "@/context/sync"
import {
  sessionMovedOnRequests,
  sessionPermissionRequest,
  sessionQuestionRequest,
  type MovedOnRequest,
} from "./session-request-tree"

export const todoState = (input: {
  count: number
  done: boolean
  live: boolean
}): "hide" | "clear" | "open" | "close" => {
  if (input.count === 0) return "hide"
  if (!input.live) return "clear"
  if (!input.done) return "open"
  return "close"
}

export const todoDockAtBoundary = (state: ReturnType<typeof todoState>) => state === "open"

const idle = { type: "idle" as const }

/**
 * Whether a request is holding the agent right now, so it takes the prompt position and alerts once. A request the agent
 * carried on without does not, and neither does one autonomous mode put aside for a decision later.
 */
export const asksNow = (request: { movedOnAt?: number; deferred?: true }) => !request.movedOnAt && !request.deferred

/** What the "went on without you" dock lists. Decisions put aside have one place, the Activity filter. */
export function composerMovedOn(...input: Parameters<typeof sessionMovedOnRequests>) {
  return sessionMovedOnRequests(...input).filter((item) => item.kind !== "permission" || !item.request.deferred)
}

export function createSessionComposerController(options?: { closeMs?: number | (() => number) }) {
  const params = useParams()
  const sdk = useSDK()
  const sync = useSync()
  const serverSync = useServerSync()
  const language = useLanguage()

  const [answering, setAnswering] = createStore({ id: undefined as string | undefined })

  // The server-wide store, not this directory's session list: that list has no subagents until they are opened.
  const movedOn = createMemo(() => {
    const data = serverSync().session.data
    return composerMovedOn(
      () => Object.values(data.info).filter((item) => !!item),
      data.permission,
      data.question,
      params.id,
    )
  })

  // A request the agent carried on without no longer blocks anything, so it leaves the prompt position. Its own full
  // question dock comes back only when the user chooses to answer it.
  const questionRequest = createMemo((): QuestionRequest | undefined => {
    return sessionQuestionRequest(
      sync().data.session,
      sync().data.question,
      params.id,
      (item) => !item.movedOnAt || item.id === answering.id,
    )
  })

  const permissionRequest = createMemo((): PermissionRequest | undefined => {
    return sessionPermissionRequest(sync().data.session, sync().data.permission, params.id, asksNow)
  })

  const blocked = createMemo(() => {
    const id = params.id
    if (!id) return false
    return !!permissionRequest() || !!questionRequest()
  })

  const todos = createMemo((): Todo[] => {
    const id = params.id
    if (!id) return []
    return serverSync().session.data.todo[id] ?? []
  })

  const done = createMemo(
    () => todos().length > 0 && todos().every((todo) => todo.status === "completed" || todo.status === "cancelled"),
  )

  const live = createMemo(() => sync().data.session_working(params.id ?? "") || blocked())

  const [store, setStore] = createStore({
    sessionID: params.id,
    responding: undefined as string | undefined,
    dock: todos().length > 0 && !done() && live(),
    closing: false,
    opening: false,
  })

  const permissionResponding = createMemo(() => {
    const perm = permissionRequest()
    if (!perm) return false
    return store.responding === perm.id
  })

  const respond = (id: string, send: () => Promise<unknown>) => {
    if (store.responding === id) return
    setStore("responding", id)
    send()
      .catch((err: unknown) => {
        const description = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description })
      })
      .finally(() => {
        setStore("responding", (current) => (current === id ? undefined : current))
      })
  }

  const decide = (response: "once" | "always" | "reject") => {
    const perm = permissionRequest()
    if (!perm) return
    respond(perm.id, () => replyHeld(sdk().api, { request: perm, reply: response }))
  }

  const allowMovedOn = (request: PermissionRequest) =>
    respond(request.id, () => replyHeld(sdk().api, { request, reply: "once" }))

  const leaveMovedOn = (item: MovedOnRequest) =>
    respond(item.request.id, () =>
      item.kind === "permission"
        ? replyHeld(sdk().api, { request: item.request, reply: "reject" })
        : sdk().api.question.reject({ sessionID: item.request.sessionID, requestID: item.request.id }),
    )

  let timer: number | undefined
  let raf: number | undefined

  const closeMs = () => {
    const value = options?.closeMs
    if (typeof value === "function") return Math.max(0, value())
    if (typeof value === "number") return Math.max(0, value)
    return 400
  }

  const scheduleClose = () => {
    if (timer) window.clearTimeout(timer)
    timer = window.setTimeout(() => {
      setStore({ dock: false, closing: false })
      timer = undefined
    }, closeMs())
  }

  // Keep stale turn todos from reopening if the model never clears them.
  const clear = () => {
    const id = params.id
    if (!id) return
    sync().set("todo", id, [])
  }

  createEffect(
    on(
      () => [params.id, todos().length, done(), live()] as const,
      ([id, count, complete, active], previous) => {
        if (raf) cancelAnimationFrame(raf)
        raf = undefined

        const next = todoState({
          count,
          done: complete,
          live: active,
        })

        if (!previous || previous[0] !== id) {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ sessionID: id, dock: todoDockAtBoundary(next), closing: false, opening: false })
          if (next === "clear") clear()
          return
        }

        if (next === "hide") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          setStore({ dock: false, closing: false, opening: false })
          return
        }

        if (next === "clear") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          clear()
          return
        }

        if (next === "open") {
          if (timer) window.clearTimeout(timer)
          timer = undefined
          const hidden = !store.dock || store.closing
          setStore({ dock: true, closing: false })
          if (hidden) {
            setStore("opening", true)
            raf = requestAnimationFrame(() => {
              setStore("opening", false)
              raf = undefined
            })
            return
          }
          setStore("opening", false)
          return
        }

        setStore({ dock: true, opening: false, closing: true })
        if (!timer) scheduleClose()
      },
    ),
  )

  onCleanup(() => {
    if (!timer) return
    window.clearTimeout(timer)
  })

  onCleanup(() => {
    if (!raf) return
    cancelAnimationFrame(raf)
  })

  return {
    blocked,
    questionRequest,
    permissionRequest,
    permissionResponding,
    decide,
    movedOn,
    responding: (id: string) => store.responding === id,
    allowMovedOn,
    leaveMovedOn,
    answerMovedOn: (id: string) => setAnswering("id", id),
    todos,
    dock: () =>
      store.sessionID === params.id
        ? store.dock
        : todoDockAtBoundary(todoState({ count: todos().length, done: done(), live: live() })),
    closing: () => store.sessionID === params.id && store.closing,
    opening: () => store.sessionID === params.id && store.opening,
  }
}

export type SessionComposerController = ReturnType<typeof createSessionComposerController>
