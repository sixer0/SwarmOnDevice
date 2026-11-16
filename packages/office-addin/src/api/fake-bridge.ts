// In-memory bridge for the API tests: an injected fetch that records every request and
// answers like the bridge (REG §5, §7.3, §7.6). `/swarm/event` returns a live SSE body the
// test pushes frames into. Test-only; never imported by product code.

export type Recorded = {
  method: string
  path: string
  query: Record<string, string>
  headers: Record<string, string>
  body?: unknown
}

export type Route = { status: number; body?: unknown }

type Handler = (request: Recorded) => Route | undefined | Promise<Route | undefined>

const encoder = new TextEncoder()

export function fakeBridge(options: { handler?: Handler; eventStatus?: number; eventFails?: boolean } = {}) {
  const requests: Recorded[] = []
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const opened = { resolve: () => {} }
  const streamOpened = new Promise<void>((resolve) => {
    opened.resolve = resolve
  })

  async function fetch(request: Request) {
    const url = new URL(request.url)
    const text = await request.text()
    const entry: Recorded = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries([...request.headers.entries()].map(([key, value]) => [key.toLowerCase(), value])),
      body: text ? JSON.parse(text) : undefined,
    }
    requests.push(entry)

    if (entry.path === "/swarm/event") {
      if (options.eventFails) throw new TypeError("network")
      if (options.eventStatus) return Response.json({ error: "STREAM_LIMIT" }, { status: options.eventStatus })
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          streams.push(controller)
          opened.resolve()
        },
      })
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } })
    }

    const route = (await options.handler?.(entry)) ?? defaults(entry)
    if (route.status === 204) return new Response(null, { status: 204 })
    return Response.json(route.body ?? {}, { status: route.status })
  }

  function defaults(entry: Recorded): Route {
    if (entry.path === "/bridge/health") return { status: 200, body: { bridge: "ok", swarm: "ready" } }
    if (entry.path === "/pair/request") return { status: 202, body: { requestId: "req1", code: "4821", expiresAt: "2026-11-16T00:02:00Z" } }
    if (entry.path === "/pair/status") return { status: 200, body: { state: "pending" } }
    if (entry.path === "/pair/verify") return { status: entry.headers["x-swarm-office-token"] ? 204 : 401 }
    if (entry.method === "POST" && entry.path === "/swarm/session") return { status: 200, body: session("ses_new") }
    if (entry.method === "GET" && entry.path === "/swarm/session") return { status: 200, body: [session("ses_a")] }
    if (entry.path.endsWith("/prompt_async")) return { status: 204 }
    if (entry.path.endsWith("/abort")) return { status: 200, body: true }
    if (entry.path.endsWith("/message")) return { status: 200, body: [] }
    if (entry.path.startsWith("/swarm/session/")) return { status: 200, body: session(entry.path.split("/")[3] ?? "") }
    return { status: 404, body: { error: "ROUTE_NOT_ALLOWED" } }
  }

  return {
    fetch,
    requests,
    streamOpened,
    // Pushes one SSE frame to every open stream.
    push(frame: unknown) {
      const chunk = encoder.encode(`data: ${JSON.stringify(frame)}\n\n`)
      for (const controller of streams) {
        // A stream the pane already cancelled rejects new chunks; that is not an error here.
        try {
          controller.enqueue(chunk)
        } catch {
          continue
        }
      }
    },
    end() {
      for (const controller of streams.splice(0)) controller.close()
    },
  }
}

export function session(id: string) {
  return {
    id,
    slug: id,
    projectID: "p",
    directory: "/office",
    title: "t",
    version: "1",
    time: { created: 1, updated: 1 },
    metadata: { "swarm.origin": "office-addin", "swarm.office.host": "Word" },
  }
}

// Every key at any depth of a JSON value.
export function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep)
  if (typeof value !== "object" || value === null) return []
  return Object.entries(value).flatMap(([key, item]) => [key, ...keysDeep(item)])
}
