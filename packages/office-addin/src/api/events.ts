// Event subscription for GET /swarm/event (P8; REG §7.7 rev 3, D5c/D5d of C22).
//
// The stream is opened through the SDK (`client.event.subscribe`) with no automatic retry:
// FS T16 allows one immediate reconnect, which the shell runs when `closed` resolves.
// `ready` resolves when the first frame arrives (the server sends `server.connected` first,
// X-STREAM), so a caller that awaits it has a live subscription before it sends (D5d).
// Frames are handed over raw; the stream reducer narrows them and ignores unknown types.
import { asGlobalFetch, type OfficeApi } from "./client"

export type StreamClose = {
  // HTTP status of the /swarm/event response (401 TOKEN_INVALID, 429 STREAM_LIMIT, 503 ...),
  // or 0 when no response arrived. 200 means the stream was open and then ended.
  status: number
  // True when the caller closed the stream.
  aborted: boolean
}

export type EventStream = {
  ready: Promise<boolean>
  closed: Promise<StreamClose>
  close: () => void
}

export function openEventStream(api: OfficeApi, onFrame: (frame: unknown) => void): EventStream {
  const controller = new AbortController()
  const seen = { status: 0, frames: 0 }
  const ready = { resolve: (_value: boolean) => {} }
  const readyPromise = new Promise<boolean>((resolve) => {
    ready.resolve = resolve
  })

  // Records the stream response status; the SDK only reports "SSE failed" as text.
  const fetch = async (request: Request) => {
    const response = await api.fetch(request)
    seen.status = response.status
    return response
  }

  async function run() {
    const subscription = await api.client.event.subscribe(undefined, {
      signal: controller.signal,
      sseMaxRetryAttempts: 1,
      fetch: asGlobalFetch(fetch),
    })
    for await (const frame of subscription.stream) {
      seen.frames++
      if (seen.frames === 1) ready.resolve(true)
      onFrame(frame)
    }
  }

  const closed = run()
    .catch(() => undefined)
    .then(() => {
      ready.resolve(false)
      return { status: seen.status, aborted: controller.signal.aborted }
    })

  return {
    ready: readyPromise,
    closed,
    close: () => controller.abort(),
  }
}
