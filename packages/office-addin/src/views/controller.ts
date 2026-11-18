// Pane controller (plan M8-05). Holds the pane's reactive state and runs the effects of the
// connection machine (state/machine.ts, FS §8.2 T1-T17) and of the chat (api/conversation.ts).
// The views render from it; nothing here touches the DOM.
//
// Write-back (M8-07): Insert and Replace only open the preview slot (`preview`), which the App
// renders through views/preview.tsx. That block reads and writes through `writePort` below; no
// code path in this file calls a host write itself (FR-47).
import { batch, createSignal } from "solid-js"
import {
  OFFICE_BODY_LIMIT_BYTES,
  OFFICE_CONTEXT_SELECTION,
  OFFICE_HOST_EXCEL,
  OFFICE_PAIR_POLL_MS,
  OFFICE_PERF_MARK_BUSY,
  OFFICE_PERF_MARK_SEND,
} from "../constants"
import type { HistoryEntry, OfficeApi } from "../api/client"
import { createConversation } from "../api/conversation"
import { performanceMarker, type Marker } from "../api/marks"
import { valuesToTsv } from "../excel"
import type { HostAdapter } from "../host/types"
import type { MessageKey, Params } from "../i18n"
import { initialState, reduce, type ConnectionEvent, type ConnectionState, type Effect } from "../state/machine"
import {
  bodyBytes,
  composePrompt,
  normaliseContext,
  sendBlocker,
  sessionTitle,
  writeText,
  type ContextScope,
  type OfficeHost,
} from "../state/prompt"
import { dropSession, lookupSession, recentChats, saveSession, type SessionSummary } from "../state/session"
import {
  acknowledgeDisclosure,
  deleteAllSessions,
  deleteToken,
  isDisclosureAcknowledged,
  readScope,
  readToken,
  writeScope,
  writeToken,
  type PaneStore,
} from "../state/storage"
import { initialStream, replies, type Reply, type StreamState } from "../state/stream"

export type Timers = {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (id: unknown) => void
  setTimeout: (fn: () => void, ms: number) => unknown
  clearTimeout: (id: unknown) => void
}

export const realTimers: Timers = {
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (id) => globalThis.clearInterval(id as ReturnType<typeof setInterval>),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof setTimeout>),
}

type PaneDeps = {
  api: OfficeApi
  store: PaneStore
  // Built after Office.onReady for a Word or Excel host.
  adapter: (host: OfficeHost) => HostAdapter
  // Reads Office.context.document.url on every call (FR-33, never cached).
  documentUrl: () => string | null | undefined
  // `typeof Office !== "undefined"` (T2).
  officePresent: () => boolean
  now?: () => number
  timers?: Timers
  mark?: Marker
  // Clipboard write for Copy (FR-57); resolves false when refused.
  clipboard?: (text: string) => Promise<boolean>
  // Diagnostics hook. The pane has no allow-listed log route (REG §7.3), so the shell decides.
  onError?: (source: string, detail: unknown) => void
}

export type Toast = { key: MessageKey; params?: Params; tone: "error" | "success" }

// Context tag of a sent user turn (FR-58).
export type TurnTag =
  | { kind: "none" }
  | { kind: "chars"; scope: ContextScope; count: number }
  | { kind: "cells"; scope: ContextScope; address: string; rows: number; cols: number }
  | { kind: "scope"; scope: ContextScope }

export type TurnEnd = "stopped" | "interrupted"

type LiveTurn = { id: number; text: string; tag?: TurnTag; replyStart: number; end?: TurnEnd }

export type HistoryItem =
  | { kind: "user"; id: string; text: string; tag: TurnTag }
  | { kind: "reply"; reply: Reply }

export type ThreadItem =
  | { kind: "user"; key: string; text: string; tag?: TurnTag }
  | { kind: "reply"; key: string; reply: Reply; streaming: boolean; end?: TurnEnd }
  | { kind: "waiting"; key: string }
  | { kind: "end"; key: string; end: TurnEnd }

export type PreviewRequest = { messageID: string; action: "insert" | "replace"; text: string }

const CONTEXT_PREFIX = /^\[Office context: (\w+) (selection|whole)\]\n/

// History (P5) to plain thread items: user turns show the instruction (the last text part) and
// a tag from the context part; assistant turns show their `text` parts only (FR-40, D5b).
function historyItems(entries: HistoryEntry[]): HistoryItem[] {
  return entries.flatMap((entry): HistoryItem[] => {
    const texts = entry.parts.flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
    if (entry.info.role === "user") {
      const context = texts.length > 1 ? texts[0] : undefined
      const match = context ? CONTEXT_PREFIX.exec(context) : null
      const scope = match?.[2] === "whole" ? "whole" : OFFICE_CONTEXT_SELECTION
      const tag: TurnTag = !context
        ? { kind: "none" }
        : match && match[1] !== OFFICE_HOST_EXCEL
          ? { kind: "chars", scope, count: context.length - match[0].length }
          : { kind: "scope", scope }
      return [{ kind: "user", id: entry.info.id, text: texts.at(-1) ?? "", tag }]
    }
    const info = entry.info
    return [
      {
        kind: "reply",
        reply: {
          messageID: info.id,
          text: texts.join(""),
          providerID: info.providerID,
          modelID: info.modelID,
          completed: true,
        },
      },
    ]
  })
}

type StatusTone = "grey" | "red" | "amber" | "green"
export type Status = { tone: StatusTone; pulse: boolean; label?: MessageKey }

// Header status (FR-55). Mapping: T2 (Office.js missing) keeps `loading` but stops the pulse (mockup S2).
export function statusOf(state: ConnectionState): Status {
  if (state.name === "loading") return { tone: "grey", pulse: !state.officeJsMissing, label: "office.status.loading" }
  if (state.name === "unavailable") return { tone: "red", pulse: false, label: "office.status.unreachable" }
  if (state.name === "unpaired") return { tone: "grey", pulse: false, label: "office.status.notConnected" }
  if (state.name === "pairing") return { tone: "amber", pulse: false, label: "office.status.waiting" }
  if (state.name === "denied") return { tone: "red", pulse: false, label: "office.status.declined" }
  if (state.name === "connected") return { tone: "green", pulse: false, label: "office.status.connected" }
  return { tone: "grey", pulse: false }
}

// FR-25 on the typed text alone (M8-06): Send is disabled once the instruction by itself would
// make the body exceed 2 MiB. A UTF-8 character is at most 3 bytes per UTF-16 unit (JSON escapes
// of control characters can reach 6), so short drafts skip the encode on every keystroke.
/** @internal test seam */
export function draftTooLarge(draft: string) {
  if (draft.length * 6 + 64 <= OFFICE_BODY_LIMIT_BYTES) return false
  return bodyBytes({ parts: [{ type: "text", text: draft }] }) > OFFICE_BODY_LIMIT_BYTES
}

// Copy label time (design §4.2): "Copied" for 2 s.
const COPIED_MS = 2000

// Sheet-qualified Excel address ("Sheet1!B2:E9") to the cells part shown in the tag.
const cells = (address: string) => address.slice(address.lastIndexOf("!") + 1)

export function createPaneController(deps: PaneDeps) {
  const now = deps.now ?? (() => Date.now())
  const timers = deps.timers ?? realTimers
  const mark = deps.mark ?? performanceMarker()
  const report = (source: string, detail: unknown) => deps.onError?.(source, detail)

  const [conn, setConn] = createSignal<ConnectionState>(initialState(now()))
  const [readOnly, setReadOnly] = createSignal(false)
  const [toast, setToast] = createSignal<Toast>()
  const [announcement, setAnnouncement] = createSignal("")
  const [stream, setStream] = createSignal<StreamState>(initialStream())
  const [history, setHistory] = createSignal<HistoryItem[]>([])
  const [turns, setTurns] = createSignal<LiveTurn[]>([])
  const [sending, setSending] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [scope, setScopeSignal] = createSignal<ContextScope>(readScope(deps.store))
  const [acknowledged, setAcknowledged] = createSignal(isDisclosureAcknowledged(deps.store))
  const [title, setTitle] = createSignal<string>()
  const [recent, setRecent] = createSignal<SessionSummary[]>([])
  const [preview, setPreview] = createSignal<PreviewRequest>()
  // messageID of the reply whose Copy label reads "Copied" (FR-57); one at a time.
  const [copied, setCopied] = createSignal<string>()
  // M8-07 (FR-48): true while the one confirmed write runs; Insert, Replace, Write and Send are
  // disabled meanwhile, Copy is not.
  const [writing, setWriting] = createSignal(false)

  const live = {
    adapter: undefined as HostAdapter | undefined,
    poll: undefined as unknown,
    toast: undefined as unknown,
    copy: undefined as unknown,
  }
  const counter = { turn: 0 }
  const restored = { id: undefined as string | undefined }

  const conversation = createConversation({
    api: deps.api,
    mark,
    onChange: setStream,
    onEffect: (effect) => {
      if (effect.type === "idle") announce("office.reply.done")
      if (effect.type === "error") showToast({ key: effect.key, tone: "error" })
    },
    onClose: (close) => {
      // T16: one immediate reconnect; a second failure is `streamLost`.
      if (conn().name !== "connected") return
      if (close.status === 401) return dispatch({ type: "apiError", status: 401 })
      conversation.connect().then((ok) => {
        if (!ok) dispatch({ type: "streamLost" })
      })
    },
  })

  // ---------- small helpers ----------

  const translateLater = { t: undefined as ((key: MessageKey, params?: Params) => string) | undefined }

  function announce(key: MessageKey, params?: Params) {
    const text = translateLater.t ? translateLater.t(key, params) : ""
    setAnnouncement("")
    setAnnouncement(text)
  }

  function showToast(next: Toast) {
    if (live.toast !== undefined) timers.clearTimeout(live.toast)
    live.toast = undefined
    setToast(next)
    // Errors stay until dismissed; success leaves after 4 s (design §7 S14).
    if (next.tone === "success") live.toast = timers.setTimeout(() => setToast(undefined), 4000)
  }

  function stopPolling() {
    if (live.poll !== undefined) timers.clearInterval(live.poll)
    live.poll = undefined
  }

  const lastTurn = () => turns().at(-1)
  const busy = () => sending() || (stream().status === "busy" && lastTurn()?.end === undefined)

  function endLastTurn(end: TurnEnd) {
    setTurns((list) => list.map((turn, index) => (index === list.length - 1 && !turn.end ? { ...turn, end } : turn)))
  }

  function clearChat() {
    batch(() => {
      conversation.select(undefined)
      setHistory([])
      setTurns([])
      setTitle(undefined)
      setPreview(undefined)
      setSending(false)
    })
    restored.id = undefined
  }

  // ---------- connection machine ----------

  function dispatch(event: ConnectionEvent) {
    const before = conn().name
    const step = reduce(conn(), event, now())
    setConn(step.state)
    const label = statusOf(step.state).label
    if (step.state.name !== before && label) announce(label)
    step.effects.forEach(run)
  }

  function run(effect: Effect) {
    if (effect.type === "startOfficeTimer") return
    if (effect.type === "checkHealth") {
      deps.api.health().then((health) => dispatch({ type: "health", ready: health.ready, token: !!readToken(deps.store) }))
      return
    }
    if (effect.type === "verifyToken") {
      deps.api.pairVerify().then((result) => dispatch({ type: "verify", status: result.status }))
      return
    }
    if (effect.type === "pairRequest") {
      deps.api
        .pairRequest(effect.host)
        .then((result) =>
          dispatch({ type: "pairResponse", status: result.status, requestId: result.requestId, code: result.code }),
        )
      return
    }
    if (effect.type === "startPolling") {
      stopPolling()
      const requestId = effect.requestId
      live.poll = timers.setInterval(() => {
        deps.api.pairStatus(requestId).then((result) => {
          if (result.state) dispatch({ type: "pairStatus", state: result.state, token: result.token })
        })
      }, effect.ms || OFFICE_PAIR_POLL_MS)
      return
    }
    if (effect.type === "stopPolling") return stopPolling()
    if (effect.type === "storeToken") {
      writeToken(deps.store, effect.token)
      return
    }
    if (effect.type === "deleteToken") return deleteToken(deps.store)
    if (effect.type === "deleteAllSessions") {
      deleteAllSessions(deps.store)
      clearChat()
      return
    }
    if (effect.type === "dropCurrentSession") {
      dropSession({ ...deps.store, documentUrl: deps.documentUrl })
      clearChat()
      return
    }
    if (effect.type === "restoreChat") {
      restoreChat()
      return
    }
    if (effect.type === "markInterrupted") {
      if (busy()) endLastTurn("interrupted")
      setSending(false)
      return
    }
    if (effect.type === "toast") showToast({ key: effect.key, tone: "error" })
  }

  // ---------- chats (FR-33..FR-35) ----------

  async function loadRecent() {
    const host = conn().host
    if (!host) return
    const result = await deps.api.listSessions()
    if (!result.ok) return report("listSessions", result)
    setRecent(recentChats(result.data, host))
  }

  async function open(sessionID: string, stored: boolean) {
    const session = await deps.api.getSession(sessionID)
    if (!session.ok) {
      dispatch({ type: "apiError", status: session.status, code: session.code, storedSession: stored })
      return false
    }
    const messages = await deps.api.messages(sessionID)
    if (!messages.ok) {
      dispatch({ type: "apiError", status: messages.status, code: messages.code, storedSession: stored })
      return false
    }
    batch(() => {
      clearChat()
      conversation.select(sessionID)
      setHistory(historyItems(messages.data))
      setTitle(session.data.title)
    })
    restored.id = stored ? sessionID : undefined
    return true
  }

  async function restoreChat() {
    loadRecent()
    const sessionID = await lookupSession({ ...deps.store, documentUrl: deps.documentUrl })
    if (!sessionID) return
    await open(sessionID, true)
  }

  // ---------- public actions ----------

  return {
    conn,
    readOnly,
    toast,
    announcement,
    stream,
    history,
    turns,
    busy,
    draft,
    setDraft,
    scope,
    acknowledged,
    title,
    recent,
    preview,
    sending,
    copied,
    writing,

    // M8-07 write port, used only by views/preview.tsx: the adapter for the user-initiated
    // preview read and the confirmed write, a single-write guard (FR-48) and the pane feedback.
    writePort: {
      adapter: () => live.adapter,
      // false when a write already runs, a reply streams or the document is read-only.
      begin() {
        if (writing() || busy() || readOnly()) return false
        setWriting(true)
        return true
      },
      end: () => setWriting(false),
      toast: (next: Toast) => showToast(next),
      announce: (key: MessageKey, params?: Params) => announce(key, params),
      report: (source: string, detail: unknown) => report(source, detail),
    },

    // The shell passes the active translator so announcements are already localised.
    useTranslate(t: (key: MessageKey, params?: Params) => string) {
      translateLater.t = t
    },

    // T1: page loaded; the shell starts the 1 s clock for T2 and the T13 clock half.
    start() {
      dispatch({ type: "load" })
      const clock = timers.setInterval(() => dispatch({ type: "tick", officePresent: deps.officePresent() }), 1000)
      return () => {
        timers.clearInterval(clock)
        stopPolling()
        conversation.close()
      }
    },

    // Office.onReady (T3). `readOnly` from Office.context.document.mode (FR-60, H-UI-2).
    officeReady(info: { host: string; readOnly: boolean }) {
      const known = info.host === "Word" || info.host === "Excel"
      const adapter = known ? deps.adapter(info.host as OfficeHost) : undefined
      live.adapter = adapter
      setReadOnly(info.readOnly)
      dispatch({ type: "officeReady", host: info.host, supported: adapter?.supported() === true })
    },

    retry: () => dispatch({ type: "retry" }),
    connect: () => dispatch({ type: "connect" }),
    dismissToast: () => setToast(undefined),

    setScope(next: ContextScope) {
      writeScope(deps.store, next)
      setScopeSignal(next)
    },

    acknowledge() {
      acknowledgeDisclosure(deps.store)
      setAcknowledged(true)
    },

    tooLarge: () => draftTooLarge(draft()),

    canSend: () =>
      conn().name === "connected" &&
      acknowledged() &&
      draft().trim() !== "" &&
      !busy() &&
      !writing() &&
      !draftTooLarge(draft()),

    // FR-34
    newChat() {
      if (busy()) return
      dropSession({ ...deps.store, documentUrl: deps.documentUrl })
      clearChat()
    },

    // FR-35: picking a recent chat behaves like FR-33 and becomes this document's chat.
    async pick(sessionID: string) {
      if (busy()) return
      const ok = await open(sessionID, false)
      if (ok) await saveSession({ ...deps.store, documentUrl: deps.documentUrl }, sessionID)
    },

    // Send (FR-23..FR-27, FR-38, AC-15): the user turn and the waiting text appear in the same
    // tick as the click; the context read runs after, at the user's action (FR-01).
    async send() {
      const host = conn().host
      const adapter = live.adapter
      const instruction = draft()
      if (!host || !adapter || conn().name !== "connected" || busy() || writing()) return
      if (sendBlocker({ instruction, acknowledged: acknowledged(), body: { parts: [] } }) !== undefined) return
      // FR-25 / design §5.3: above 2 MiB the toast shows and nothing is sent.
      if (draftTooLarge(instruction)) return showToast({ key: "office.error.tooLarge", tone: "error" })
      mark(OFFICE_PERF_MARK_SEND)
      const id = ++counter.turn
      batch(() => {
        setTurns((list) => [...list, { id, text: instruction, replyStart: replies(stream()).length }])
        setSending(true)
        setDraft("")
        setPreview(undefined)
      })
      mark(OFFICE_PERF_MARK_BUSY)

      const fail = (toastKey?: MessageKey) => {
        batch(() => {
          setTurns((list) => list.filter((turn) => turn.id !== id))
          setSending(false)
          setDraft(instruction)
        })
        if (toastKey) showToast({ key: toastKey, tone: "error" })
      }

      const chosen = scope()
      const read = await adapter.read(chosen)
      if (!read.ok) {
        report("read", read.detail)
        return fail(read.code)
      }
      const context = read.host === "Excel" ? valuesToTsv(read.values) : read.text
      const prompt = composePrompt({ host, scope: chosen, context, instruction })
      const blocker = sendBlocker({ instruction, acknowledged: acknowledged(), body: prompt.body })
      if (blocker === "office.error.tooLarge") return fail(blocker)
      if (blocker) return fail()
      const tag: TurnTag =
        prompt.tag === "none"
          ? { kind: "none" }
          : read.host === "Excel"
            ? { kind: "cells", scope: chosen, address: cells(read.address), rows: read.rowCount, cols: read.columnCount }
            : { kind: "chars", scope: chosen, count: normaliseContext(host, context).length }
      setTurns((list) => list.map((turn) => (turn.id === id ? { ...turn, tag } : turn)))

      const result = await conversation.send({ title: sessionTitle(instruction), host, parts: prompt.body.parts })
      setSending(false)
      if (!result.ok) {
        fail()
        dispatch({
          type: "apiError",
          status: result.status,
          code: result.code,
          storedSession: result.stage === "prompt" && restored.id !== undefined,
        })
        return
      }
      if (result.created) {
        setTitle(sessionTitle(instruction))
        await saveSession({ ...deps.store, documentUrl: deps.documentUrl }, result.sessionID)
        loadRecent()
      }
    },

    // FR-39: Stop keeps the text so far.
    async stop() {
      if (!busy()) return
      endLastTurn("stopped")
      setSending(false)
      const result = await conversation.abort()
      if (!result.ok) dispatch({ type: "apiError", status: result.status, code: result.code })
    },

    // FR-57: clipboard only, never the document. The label reads "Copied" for 2 s on the
    // injected timers (design §4.2).
    // M8-02b: Copy takes the same trimmed text as Insert/Replace (writeText).
    async copy(reply: { messageID: string; text: string }) {
      const text = writeText(reply.text)
      if (text === "") return false
      const ok = deps.clipboard ? await deps.clipboard(text) : false
      if (!ok) {
        report("copy", "clipboard refused")
        return false
      }
      if (live.copy !== undefined) timers.clearTimeout(live.copy)
      setCopied(reply.messageID)
      live.copy = timers.setTimeout(() => {
        live.copy = undefined
        setCopied(undefined)
      }, COPIED_MS)
      return true
    },

    // Records which reply and action asked for a preview; one at a time (FR-63). The preview block
    // (views/preview.tsx) makes the read. No write here.
    openPreview(request: PreviewRequest) {
      if (busy() || readOnly() || writing()) return
      setPreview(request)
    },
    closePreview: () => setPreview(undefined),

    // Thread = restored history, then the live turns with their replies (FR-38, FR-40, FR-64).
    thread(): ThreadItem[] {
      const past: ThreadItem[] = history().map((item) =>
        item.kind === "user"
          ? { kind: "user", key: `h-${item.id}`, text: item.text, tag: item.tag }
          : { kind: "reply", key: `h-${item.reply.messageID}`, reply: item.reply, streaming: false },
      )
      const seen = new Set(history().flatMap((item) => (item.kind === "reply" ? [item.reply.messageID] : [])))
      const all = replies(stream()).filter((reply) => !seen.has(reply.messageID))
      const list = turns()
      const working = busy()
      const present = list.flatMap((turn, index): ThreadItem[] => {
        const last = index === list.length - 1
        const mine = all.slice(turn.replyStart, list[index + 1]?.replyStart ?? all.length)
        const user: ThreadItem = { kind: "user", key: `t-${turn.id}`, text: turn.text, tag: turn.tag }
        const items = mine.map(
          (reply, at): ThreadItem => ({
            kind: "reply",
            key: `r-${reply.messageID}`,
            reply,
            streaming: last && working && at === mine.length - 1,
            end: at === mine.length - 1 ? turn.end : undefined,
          }),
        )
        const texted = mine.some((reply) => reply.text !== "")
        // FR-64: "Thinking" with the caret until the first assistant text of this turn.
        if (last && working && !texted) return [user, { kind: "waiting", key: `w-${turn.id}` }]
        if (turn.end && mine.length === 0) return [user, { kind: "end", key: `e-${turn.id}`, end: turn.end }]
        return [user, ...items]
      })
      return [...past, ...present]
    },
  }
}

export type PaneController = ReturnType<typeof createPaneController>
