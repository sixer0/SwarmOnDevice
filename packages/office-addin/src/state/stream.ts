// Stream reducer for GET /swarm/event (FS FR-38, FR-38a, FR-40, FR-42; REG §7.7 rev 3;
// D5a-D5d, D9 of C22). Evidence of the shapes: test/evidence/m0/14_s4_capture_thinker.txt
// and test/spikes/sp_s4.md.
//
// - D5a: text arrives as `message.part.delta` {sessionID, messageID, partID, field, delta}
//   with field "text", keyed by partID. The part type comes from `message.part.updated`
//   (`part.type`), the role from `message.updated` (`info.role`).
// - D5b: only `text` parts of `assistant` messages are rendered. Reasoning, step-*, tool
//   parts and the user's own echoed text part are never rendered. Type and role may
//   arrive after a delta; the delta is kept and rendered once both are known.
// - D5c: every other event type is ignored before any other work.
// - D5d: frames for a session id not yet known are buffered until `sessionKnown`, then
//   replayed if they match. Nothing is dropped because the id was not known yet.
// - D9: the effect `firstText` is emitted once per turn, when the rendered assistant
//   text first grows (the first assistant `text` delta), never on the user echo.
//
// Frames are wire JSON and are narrowed at runtime; nothing here trusts their shape.
import { OFFICE_PERF_MARK_FIRST_TEXT } from "../constants"

type PartEntry = { messageID: string; type?: string; text: string }
type MessageEntry = { role?: string; providerID?: string; modelID?: string; completed: boolean }

export type StreamState = {
  sessionID?: string
  buffer: unknown[]
  messages: Record<string, MessageEntry>
  parts: Record<string, PartEntry>
  status: "idle" | "busy" | "error"
  firstText: boolean
  // Rendered length when the current turn started (D9 baseline).
  baseline: number
}

export type StreamEffect =
  | { type: "mark"; name: typeof OFFICE_PERF_MARK_FIRST_TEXT }
  | { type: "idle" }
  | { type: "error"; key: "office.error.generic" }

export type StreamEvent =
  | { type: "frame"; frame: unknown }
  // POST /swarm/session returned (or a restored session was selected).
  | { type: "sessionKnown"; sessionID: string }
  // Send clicked on the known session: busy, and a new firstText mark is due.
  | { type: "beginTurn" }

// Bounds memory if the create call never returns; far above one prompt's traffic.
export const STREAM_BUFFER_LIMIT = 10_000

const CONSUMED = new Set([
  "message.updated",
  "message.part.updated",
  "message.part.delta",
  "session.idle",
  "session.error",
  "session.created",
])

export function initialStream(): StreamState {
  return { buffer: [], messages: dict(), parts: dict(), status: "idle", firstText: true, baseline: 0 }
}

// Maps keyed by server ids (message and part ids) are null-prototype objects, so an id
// such as "__proto__" or "constructor" is an ordinary own key and never reads or
// writes Object.prototype (CP-M8 F-7). `put` copies; the state is never mutated.
function dict<T>(): Record<string, T> {
  return Object.create(null)
}

const put = <T>(entries: Record<string, T>, id: string, value: T) =>
  Object.assign(dict<T>(), entries, { [id]: value })

const own = <T>(entries: Record<string, T>, id: string) =>
  Object.prototype.hasOwnProperty.call(entries, id) ? entries[id] : undefined

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

// Frame type and session id, or undefined for a frame this reducer never consumes.
function header(frame: unknown) {
  const body = record(frame)
  const type = text(body?.type)
  if (!type || !CONSUMED.has(type)) return undefined
  const properties = record(body?.properties)
  const sessionID = text(properties?.sessionID)
  if (!properties || !sessionID) return undefined
  return { type, properties, sessionID }
}

const rendered = (state: StreamState, part: PartEntry) =>
  part.type === "text" && own(state.messages, part.messageID)?.role === "assistant"

export function renderedLength(state: StreamState) {
  return Object.values(state.parts)
    .filter((part) => rendered(state, part))
    .reduce((sum, part) => sum + part.text.length, 0)
}

function apply(state: StreamState, frame: { type: string; properties: Record<string, unknown> }): StreamState {
  if (frame.type === "message.updated") {
    const info = record(frame.properties.info)
    const id = text(info?.id)
    if (!info || !id) return state
    const time = record(info.time)
    const previous = own(state.messages, id)
    return {
      ...state,
      messages: put(state.messages, id, {
        role: text(info.role) ?? previous?.role,
        providerID: text(info.providerID) ?? previous?.providerID,
        modelID: text(info.modelID) ?? previous?.modelID,
        completed: typeof time?.completed === "number" || previous?.completed === true,
      }),
    }
  }

  if (frame.type === "message.part.updated") {
    const part = record(frame.properties.part)
    const id = text(part?.id)
    const messageID = text(part?.messageID)
    if (!part || !id || !messageID) return state
    const previous = own(state.parts, id) ?? { messageID, text: "" }
    const full = text(part.text)
    // A full `text` snapshot only replaces the accumulated deltas when it extends them.
    const next = full !== undefined && full.length > previous.text.length && full.startsWith(previous.text) ? full : previous.text
    return {
      ...state,
      parts: put(state.parts, id, { messageID, type: text(part.type) ?? previous.type, text: next }),
    }
  }

  if (frame.type === "message.part.delta") {
    const id = text(frame.properties.partID)
    const messageID = text(frame.properties.messageID)
    const delta = text(frame.properties.delta)
    if (frame.properties.field !== "text" || !id || !messageID || delta === undefined) return state
    const previous = own(state.parts, id) ?? { messageID, text: "" }
    return { ...state, parts: put(state.parts, id, { ...previous, text: previous.text + delta }) }
  }

  if (frame.type === "session.idle") return { ...state, status: "idle" }
  if (frame.type === "session.error") return { ...state, status: "error" }
  // session.created: only used to match buffered frames (REG §7.7 rev 3).
  return state
}

function step(state: StreamState, frame: { type: string; properties: Record<string, unknown> }) {
  const next = apply(state, frame)
  const effects: StreamEffect[] = []
  if (frame.type === "session.idle") effects.push({ type: "idle" })
  if (frame.type === "session.error") effects.push({ type: "error", key: "office.error.generic" })
  if (next.firstText || renderedLength(next) <= next.baseline) return { state: next, effects }
  return {
    state: { ...next, firstText: true },
    effects: [{ type: "mark", name: OFFICE_PERF_MARK_FIRST_TEXT } as const, ...effects],
  }
}

export function reduceStream(state: StreamState, event: StreamEvent): { state: StreamState; effects: StreamEffect[] } {
  if (event.type === "beginTurn") {
    return { state: { ...state, status: "busy", firstText: false, baseline: renderedLength(state) }, effects: [] }
  }

  if (event.type === "sessionKnown") {
    const start: StreamState = { ...state, sessionID: event.sessionID, buffer: [] }
    return state.buffer
      .flatMap((raw) => {
        const frame = header(raw)
        return frame && frame.sessionID === event.sessionID ? [frame] : []
      })
      .reduce(
        (acc, frame) => {
          const result = step(acc.state, frame)
          return { state: result.state, effects: [...acc.effects, ...result.effects] }
        },
        { state: start, effects: [] as StreamEffect[] } as { state: StreamState; effects: StreamEffect[] },
      )
  }

  const frame = header(event.frame)
  if (!frame) return { state, effects: [] }
  if (!state.sessionID) {
    const buffer = [...state.buffer, event.frame]
    return { state: { ...state, buffer: buffer.slice(-STREAM_BUFFER_LIMIT) }, effects: [] }
  }
  if (frame.sessionID !== state.sessionID) return { state, effects: [] }
  return step(state, frame)
}

export type Reply = {
  messageID: string
  text: string
  providerID?: string
  modelID?: string
  completed: boolean
}

// FR-40: one reply per assistant message, its `text` parts concatenated in arrival order.
export function replies(state: StreamState): Reply[] {
  return Object.entries(state.messages)
    .filter((entry) => entry[1].role === "assistant")
    .map((entry) => ({
      messageID: entry[0],
      text: Object.values(state.parts)
        .filter((part) => part.messageID === entry[0] && part.type === "text")
        .map((part) => part.text)
        .join(""),
      providerID: entry[1].providerID,
      modelID: entry[1].modelID,
      completed: entry[1].completed,
    }))
}
