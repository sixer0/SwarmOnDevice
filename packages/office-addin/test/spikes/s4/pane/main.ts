// Spike S4 streaming pane (plan M0-05). THROWAWAY code.
// Uses @opencode-ai/sdk/v2/client (subpath only, register §7.1) against the same-origin proxy.
// Served by proxy.ts at /pane/index.html, so location.origin is https://localhost:46317 in Office
// and baseUrl resolves to https://localhost:46317/swarm (register §7.1).
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"

const PROMPT = "Reply with the word PONG."
const t0 = performance.now()
const client = createOpencodeClient({
  baseUrl: `${location.origin}/swarm`,
  headers: { "X-Swarm-Office": "1" },
})

const el = (id: string) => document.getElementById(id)!
const reply = el("reply")
const logBox = el("log")
const status = el("status")
const sendButton = el("send") as HTMLButtonElement
const abortButton = el("abort") as HTMLButtonElement
const capture: string[] = []
// partID -> current text, in arrival order, for the session under test only.
const parts = new Map<string, string>()
const state = { sessionID: "", firstTextAt: 0, sentAt: 0, stream: undefined as AbortController | undefined }

// Capture holds event types, timings and booleans only; never message text (spike evidence rule).
const record = (line: string) => {
  const entry = `${new Date().toISOString()} +${Math.round(performance.now() - t0)}ms ${line}`
  capture.push(entry)
  logBox.textContent += entry + "\n"
  logBox.scrollTop = logBox.scrollHeight
}

const render = () => {
  reply.textContent = [...parts.values()].join("")
}

const connect = async () => {
  state.stream?.abort()
  const controller = new AbortController()
  state.stream = controller
  status.textContent = "connecting"
  const sub = await client.event.subscribe(undefined, {
    signal: controller.signal,
    sseMaxRetryAttempts: 1,
    onSseError: (err) => record(`stream-error ${err instanceof Error ? err.name : "unknown"}`),
  })
  status.textContent = "stream open"
  sendButton.disabled = false
  for await (const event of sub.stream) {
    const sessionID = "sessionID" in event.properties ? event.properties.sessionID : undefined
    const mine = !!state.sessionID && sessionID === state.sessionID
    const base = `event ${event.type}${sessionID ? (mine ? " [this session]" : " [other session]") : ""}`
    if (event.type === "message.part.delta" && mine) {
      record(`${base} field=${event.properties.field} part=${event.properties.partID} len=${event.properties.delta.length}`)
      if (event.properties.field !== "text") continue
      if (!state.firstTextAt) {
        state.firstTextAt = performance.now()
        record(`first-text-delta after ${Math.round(state.firstTextAt - state.sentAt)}ms from send`)
      }
      parts.set(event.properties.partID, (parts.get(event.properties.partID) ?? "") + event.properties.delta)
      render()
      continue
    }
    if (event.type === "message.part.updated" && mine) {
      const part = event.properties.part
      record(`${base} part.type=${part.type} part=${part.id}`)
      if (part.type !== "text") continue
      if (!state.firstTextAt && part.text.length > 0) {
        state.firstTextAt = performance.now()
        record(`first-text-update after ${Math.round(state.firstTextAt - state.sentAt)}ms from send`)
      }
      parts.set(part.id, part.text)
      render()
      continue
    }
    if (event.type === "message.updated" && mine) {
      const info = event.properties.info
      // OI-1 option A input: do assistant messages carry providerID/modelID?
      const ids =
        info.role === "assistant"
          ? ` hasProviderID=${typeof info.providerID === "string" && info.providerID.length > 0} hasModelID=${typeof info.modelID === "string" && info.modelID.length > 0} providerID=${info.providerID} modelID=${info.modelID} completed=${!!info.time.completed} error=${info.error?.name ?? "none"}`
          : ""
      record(`${base} role=${info.role}${ids}`)
      continue
    }
    if ((event.type === "session.idle" || event.type === "session.error") && mine) {
      abortButton.disabled = true
      status.textContent = event.type
    }
    record(base)
  }
  record("stream closed")
  status.textContent = "stream closed"
}

el("connect").addEventListener("click", () => {
  connect().catch((err) => {
    record(`connect-failed ${err instanceof Error ? err.name : "unknown"}`)
    status.textContent = "Could not connect to Swarm. Check that the proxy and the sidecar are running."
  })
})

sendButton.addEventListener("click", async () => {
  parts.clear()
  render()
  state.firstTextAt = 0
  const created = await client.session.create({ title: "Office S4 spike" })
  if (!created.data) {
    record(`session.create failed status=${created.response?.status ?? "network"}`)
    status.textContent = "Could not create a session."
    return
  }
  state.sessionID = created.data.id
  record(`session created ${state.sessionID}`)
  state.sentAt = performance.now()
  const sent = await client.session.promptAsync({
    sessionID: state.sessionID,
    parts: [{ type: "text", text: PROMPT }],
  })
  record(`prompt_async status=${sent.response?.status ?? "network"}`)
  if (sent.error) {
    status.textContent = "Could not send the prompt."
    return
  }
  abortButton.disabled = false
  status.textContent = "waiting for reply"
})

abortButton.addEventListener("click", async () => {
  if (!state.sessionID) return
  const res = await client.session.abort({ sessionID: state.sessionID })
  record(`abort status=${res.response?.status ?? "network"}`)
  abortButton.disabled = true
})

el("copy").addEventListener("click", () => {
  navigator.clipboard
    .writeText(capture.join("\n"))
    .then(() => record("capture copied"))
    .catch(() => record("capture copy failed; select the log text instead"))
})

// Inside Office, wait for the host; outside Office (local smoke in a browser) Office is undefined.
const office = (globalThis as { Office?: { onReady: () => Promise<{ host: unknown; platform: unknown }> } }).Office
if (office) office.onReady().then((info) => record(`office ready host=${String(info.host)} platform=${String(info.platform)}`))
record(`pane loaded baseUrl=${location.origin}/swarm`)
