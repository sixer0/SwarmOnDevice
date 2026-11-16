// One pane chat: the event stream, the stream reducer and the send path together
// (plan M8-04; REG §7.7 rev 3 D5a-D5d, §8.5 D9; FS FR-38..FR-42).
//
// Send order (D5d): the event stream is open (first frame seen) before anything is sent;
// `beginTurn` is dispatched before `POST /swarm/session`, so frames of the new session that
// arrive before the create call returns are buffered by the reducer and replayed on
// `sessionKnown`. `swarm.office.request` is marked just before prompt_async leaves the pane;
// `swarm.office.firstText` is marked from the reducer's `mark` effect, i.e. at the first
// assistant `text` delta (D9).
import { OFFICE_PERF_MARK_REQUEST } from "../constants"
import type { OfficeHost, TextPart } from "../state/prompt"
import { initialStream, reduceStream, type StreamEffect, type StreamEvent, type StreamState } from "../state/stream"
import type { ApiFailure, OfficeApi } from "./client"
import { openEventStream, type EventStream, type StreamClose } from "./events"
import { performanceMarker, type Marker } from "./marks"

type SendInput = { title: string; host: OfficeHost; parts: TextPart[] }

type SendResult =
  // `created` = a new session was made by this send; the shell stores its id (FR-33).
  | { ok: true; sessionID: string; created: boolean }
  // `stage` says which call failed; `stream` = the event stream could not be opened.
  | (ApiFailure & { stage: "stream" | "create" | "prompt" })

type ConversationOptions = {
  api: OfficeApi
  mark?: Marker
  // Every reducer state change (render the replies from it).
  onChange?: (state: StreamState) => void
  // Reducer effects other than marks (`idle`, `error`), and stream closes (T16).
  onEffect?: (effect: StreamEffect) => void
  onClose?: (close: StreamClose) => void
}

// Ends a turn that never reached the server: not busy, no firstText mark pending.
const settled = (state: StreamState): StreamState => ({ ...state, status: "idle", firstText: true })

export function createConversation(options: ConversationOptions) {
  const mark = options.mark ?? performanceMarker()
  const current = { state: initialStream(), stream: undefined as EventStream | undefined }

  function set(state: StreamState) {
    current.state = state
    options.onChange?.(state)
  }

  function dispatch(event: StreamEvent) {
    const result = reduceStream(current.state, event)
    set(result.state)
    for (const effect of result.effects) {
      if (effect.type === "mark") mark(effect.name)
      if (effect.type !== "mark") options.onEffect?.(effect)
    }
  }

  // Opens the event stream once and reuses it while it is open.
  function open() {
    if (current.stream) return current.stream
    const stream = openEventStream(options.api, (frame) => dispatch({ type: "frame", frame }))
    current.stream = stream
    stream.closed.then((close) => {
      if (current.stream === stream) current.stream = undefined
      if (!close.aborted) options.onClose?.(close)
    })
    return stream
  }

  return {
    state: () => current.state,
    dispatch,
    // Resolves true when the first frame arrived (subscription live), false if it closed first.
    connect: () => open().ready,

    // A restored chat (FR-34) or a chat picked from Recent chats; undefined = a new chat.
    select(sessionID: string | undefined) {
      set(initialStream())
      if (sessionID) dispatch({ type: "sessionKnown", sessionID })
    },

    async send(input: SendInput): Promise<SendResult> {
      const stream = open()
      if (!(await stream.ready)) {
        const close = await stream.closed
        return { ok: false, stage: "stream", status: close.status }
      }

      dispatch({ type: "beginTurn" })

      const known = current.state.sessionID
      const created = known ? undefined : await options.api.createSession({ title: input.title, host: input.host })
      if (created && !created.ok) {
        set(initialStream())
        return { ...created, stage: "create" }
      }
      const sessionID = known ?? (created?.ok ? created.data.id : undefined)
      if (!sessionID) {
        set(initialStream())
        return { ok: false, stage: "create", status: 0 }
      }
      if (!known) dispatch({ type: "sessionKnown", sessionID })

      mark(OFFICE_PERF_MARK_REQUEST)
      const sent = await options.api.promptAsync(sessionID, input.parts)
      if (!sent.ok) {
        set(settled(current.state))
        return { ...sent, stage: "prompt" }
      }
      return { ok: true, sessionID, created: !known }
    },

    // Stop (FR-41): the server ends the turn with session.idle / session.error.
    abort() {
      const sessionID = current.state.sessionID
      if (!sessionID) return Promise.resolve({ ok: false, status: 0 } as ApiFailure)
      return options.api.abort(sessionID)
    },

    close() {
      current.stream?.close()
      current.stream = undefined
    },
  }
}

type Conversation = ReturnType<typeof createConversation>
