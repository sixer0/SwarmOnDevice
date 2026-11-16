// Row M5-05 L2: a stub sidecar on 127.0.0.1:55317 for the cases a real `opencode serve` cannot produce on demand
// (server-delta spec SD-AC-6, SD-AC-7, SD-AC-8 teardown; CP-M5 M5-F2 upstream 5xx; M5-F1 upstream abort).
//
// It speaks just enough of the opencode routes the bridge uses (REG §7.3 upstream paths) to pass the bridge's own
// checks: `POST /session` stores what the bridge sent (directory from `?directory=`, permission, metadata), so the
// ownership check (stage 14) accepts it. Every response carries headers the bridge must drop. Every request is recorded
// (method, path, query, headers in arrival order). `failWith` makes every route answer a 5xx with a leaky body.
// In-memory only; nothing is logged.

export const STUB_LEAK_BODY = "internal error at /Users/stub/secret/path sidecar-port-55317"

/** Headers the stub adds to every response; none may reach the bridge's client (SD-AC-6). */
export const STUB_EVIL_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "true",
  "set-cookie": "stub=1; Path=/",
  "www-authenticate": 'Basic realm="stub"',
  "x-foo": "bar",
  vary: "Origin",
  "x-accel-buffering": "no",
}

export type StubRecorded = {
  method: string
  path: string
  query: Record<string, string>
  /** Header names lowercased, values as received. */
  headers: [string, string][]
}

export type StubSidecar = {
  readonly requests: StubRecorded[]
  /** `performance.now()` of each `/event` stream cancel (the bridge aborted the upstream). */
  readonly eventCancels: number[]
  /** Open `/event` streams (opened, not yet cancelled or closed). */
  readonly openEvents: () => number
  /** When set, every route answers this status with STUB_LEAK_BODY. */
  failWith: number | undefined
  stop(): Promise<void>
}

const encoder = new TextEncoder()

function sessionId() {
  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
  const bytes = crypto.getRandomValues(new Uint8Array(26))
  return "ses_" + Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("")
}

export function startStubSidecar(port = 55317): StubSidecar {
  const requests: StubRecorded[] = []
  const eventCancels: number[] = []
  const sessions = new Map<string, Record<string, unknown>>()
  const state = { failWith: undefined as number | undefined, open: 0 }

  const json = (status: number, value: unknown) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...STUB_EVIL_HEADERS } })

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: [...request.headers.entries()].map(([name, value]) => [name.toLowerCase(), value]),
      })
      if (state.failWith !== undefined)
        return new Response(STUB_LEAK_BODY, { status: state.failWith, headers: { "content-type": "text/plain", ...STUB_EVIL_HEADERS } })

      const parts = url.pathname.split("/").filter((part) => part !== "")
      const directory = url.searchParams.get("directory") ?? ""
      if (request.method === "GET" && url.pathname === "/global/health") return json(200, { healthy: true, version: "stub" })
      if (request.method === "POST" && url.pathname === "/session") {
        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const id = sessionId()
        const session = {
          id,
          slug: "stub",
          projectID: "stub",
          directory,
          title: body.title ?? "New session - stub",
          version: "stub",
          time: { created: Date.now(), updated: Date.now() },
          permission: body.permission,
          metadata: body.metadata,
        }
        sessions.set(id, session)
        return json(200, session)
      }
      if (request.method === "GET" && url.pathname === "/session") return json(200, [...sessions.values()])
      if (parts[0] === "session" && parts[1] !== undefined) {
        const session = sessions.get(parts[1])
        if (!session) return json(404, { name: "NotFoundError", data: { message: "Session not found" } })
        if (request.method === "GET" && parts.length === 2) return json(200, session)
        if (request.method === "GET" && parts[2] === "message") return json(200, [])
        if (request.method === "POST" && parts[2] === "prompt_async")
          return new Response(null, { status: 204, headers: { ...STUB_EVIL_HEADERS } })
        if (request.method === "POST" && parts[2] === "abort") return json(200, true)
      }
      if (request.method === "GET" && url.pathname === "/event") {
        state.open += 1
        const flags = { closed: false }
        const close = () => {
          if (flags.closed) return
          flags.closed = true
          state.open -= 1
          eventCancels.push(performance.now())
        }
        request.signal.addEventListener("abort", close, { once: true })
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: "e0", type: "server.connected", properties: {} })}\n\n`))
            },
            cancel: close,
          }),
          {
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-cache, no-transform",
              "content-encoding": "identity",
              ...STUB_EVIL_HEADERS,
            },
          },
        )
      }
      return json(404, { name: "NotFoundError" })
    },
  })

  return {
    requests,
    eventCancels,
    openEvents: () => state.open,
    get failWith() {
      return state.failWith
    },
    set failWith(value: number | undefined) {
      state.failWith = value
    },
    async stop() {
      await server.stop(true)
    },
  }
}
