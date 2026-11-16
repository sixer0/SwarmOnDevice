import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createSseRelay, SSE_RESPONSE_HEADERS, type OpenUpstream } from "./sse"

// Row M5-03 (plan M5-03). Server-delta spec §9.5 (P8): unbuffered byte passthrough, no compression, timeouts 0,
// teardown both ways; SC-31 (RC-5, C15 RM-26): at most 4 concurrent streams per token, the fifth gets
// `429 STREAM_LIMIT` (register rev 5 §7.6). ST-15 (stream half).

class FakeDownstream extends EventEmitter {
  status = 0
  headers: Record<string, string | number> = {}
  chunks: Uint8Array[] = []
  body = ""
  headersSent = false
  writableEnded = false
  destroyed = false
  flushed = false
  timeouts: number[] = []
  noDelay = false
  /** When false, write() reports backpressure until drain() is called. */
  accept = true
  socket = Object.assign(new EventEmitter(), {
    setTimeout: (ms: number) => this.timeouts.push(ms),
    setNoDelay: (value?: boolean) => {
      this.noDelay = value ?? true
    },
  })
  setTimeout(ms: number) {
    this.timeouts.push(ms)
  }
  writeHead(status: number, headers: Record<string, string | number>) {
    this.status = status
    this.headers = headers
    this.headersSent = true
  }
  flushHeaders() {
    this.flushed = true
  }
  write(chunk: Uint8Array) {
    this.chunks.push(chunk)
    return this.accept
  }
  drain() {
    this.accept = true
    this.emit("drain")
  }
  end(chunk?: string) {
    if (chunk) this.body += chunk
    this.writableEnded = true
    queueMicrotask(() => this.emit("close"))
  }
  destroy() {
    if (this.destroyed) return
    this.destroyed = true
    queueMicrotask(() => this.emit("close"))
  }
  text() {
    return Buffer.concat(this.chunks).toString("utf8")
  }
}

/** An upstream SSE body the test drives by hand, recording abort and cancel. */
function fakeUpstream(init: ResponseInit = { status: 200, headers: { "content-type": "text/event-stream" } }) {
  const state = {
    controller: undefined as ReadableStreamDefaultController<Uint8Array> | undefined,
    cancelled: false,
    signal: undefined as AbortSignal | undefined,
    pulls: 0,
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      state.controller = controller
    },
    pull() {
      state.pulls++
    },
    cancel() {
      state.cancelled = true
    },
  })
  const open: OpenUpstream = async (signal) => {
    state.signal = signal
    return new Response(body, init)
  }
  return {
    state,
    open,
    push: (text: string) => state.controller?.enqueue(new TextEncoder().encode(text)),
    close: () => state.controller?.close(),
    fail: () => state.controller?.error(new Error("upstream reset")),
  }
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))
const TOKEN = "swo1_" + "a".repeat(43)
const OTHER = "swo1_" + "b".repeat(43)

describe("P8 passthrough", () => {
  test("headers are the fixed SSE set, flushed at once; bytes pass unchanged; timeouts 0", async () => {
    const relay = createSseRelay()
    const upstream = fakeUpstream({
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "set-cookie": "a=b",
        "access-control-allow-origin": "*",
        "www-authenticate": "Basic",
        "content-encoding": "gzip",
        "x-foo": "1",
      },
    })
    const down = new FakeDownstream()
    const done = relay.relay({ token: TOKEN, response: down, openUpstream: upstream.open })
    await tick()
    expect(down.status).toBe(200)
    expect(down.flushed).toBe(true)
    expect(down.headers).toEqual({ ...SSE_RESPONSE_HEADERS })
    expect(down.headers["Content-Type"]).toBe("text/event-stream")
    expect(down.headers["Cache-Control"]).toBe("no-cache, no-transform")
    const names = Object.keys(down.headers).map((name) => name.toLowerCase())
    expect(names.filter((name) => name.startsWith("access-control-"))).toEqual([])
    expect(names).not.toContain("set-cookie")
    expect(names).not.toContain("www-authenticate")
    expect(names).not.toContain("content-encoding")
    expect(names).not.toContain("content-length")
    expect(names).not.toContain("x-foo")
    expect(down.timeouts).toEqual([0, 0])
    expect(down.noDelay).toBe(true)

    // Unbuffered: each upstream chunk reaches the client before the next one exists, split frames untouched.
    upstream.push('data: {"type":"server.connected"}\n\n')
    await tick()
    expect(down.chunks.length).toBe(1)
    upstream.push("data: {\"type\":\"message.part")
    await tick()
    upstream.push('.delta"}\n\n')
    await tick()
    expect(down.chunks.length).toBe(3)
    expect(down.text()).toBe('data: {"type":"server.connected"}\n\ndata: {"type":"message.part.delta"}\n\n')
    expect(relay.active(TOKEN)).toBe(1)

    upstream.close()
    expect(await done).toEqual({ kind: "ended", by: "upstream" })
    expect(down.writableEnded).toBe(true)
    expect(relay.active(TOKEN)).toBe(0)
  })

  test("backpressure: no further read until the client drains", async () => {
    const relay = createSseRelay()
    const upstream = fakeUpstream()
    const down = new FakeDownstream()
    down.accept = false
    const done = relay.relay({ token: TOKEN, response: down, openUpstream: upstream.open })
    await tick()
    upstream.push("data: 1\n\n")
    upstream.push("data: 2\n\n")
    await tick()
    expect(down.chunks.length).toBe(1)
    down.drain()
    await tick()
    expect(down.chunks.length).toBe(2)
    upstream.close()
    await done
  })
})

describe("teardown both ways", () => {
  test("client gone: upstream aborted and its body cancelled; slot released", async () => {
    const relay = createSseRelay()
    const upstream = fakeUpstream()
    const down = new FakeDownstream()
    const done = relay.relay({ token: TOKEN, response: down, openUpstream: upstream.open })
    await tick()
    upstream.push("data: 1\n\n")
    await tick()
    down.destroy() // the pane closed the connection
    expect(await done).toEqual({ kind: "ended", by: "client" })
    expect(upstream.state.signal?.aborted).toBe(true)
    expect(upstream.state.cancelled).toBe(true)
    expect(relay.active(TOKEN)).toBe(0)
  })

  test("client gone while the upstream is still opening: no headers written, upstream body cancelled", async () => {
    const relay = createSseRelay()
    const upstream = fakeUpstream()
    const gate = Promise.withResolvers<void>()
    const down = new FakeDownstream()
    const done = relay.relay({
      token: TOKEN,
      response: down,
      openUpstream: async (signal) => {
        await gate.promise
        return upstream.open(signal)
      },
    })
    down.destroy()
    await tick()
    gate.resolve()
    expect(await done).toEqual({ kind: "ended", by: "client" })
    expect(down.headersSent).toBe(false)
    expect(upstream.state.signal?.aborted).toBe(true)
    expect(upstream.state.cancelled).toBe(true)
    expect(relay.active(TOKEN)).toBe(0)
  })

  test("upstream ends: client ended; upstream fails mid-stream: client destroyed", async () => {
    const relay = createSseRelay()
    const ending = fakeUpstream()
    const a = new FakeDownstream()
    const first = relay.relay({ token: TOKEN, response: a, openUpstream: ending.open })
    await tick()
    ending.close()
    expect(await first).toEqual({ kind: "ended", by: "upstream" })
    expect(a.writableEnded).toBe(true)
    expect(a.destroyed).toBe(false)

    const failing = fakeUpstream()
    const b = new FakeDownstream()
    const second = relay.relay({ token: TOKEN, response: b, openUpstream: failing.open })
    await tick()
    failing.push("data: 1\n\n")
    await tick()
    failing.fail()
    expect(await second).toEqual({ kind: "ended", by: "upstream-error" })
    expect(b.destroyed).toBe(true)
    expect(relay.active(TOKEN)).toBe(0)
  })

  test("stop() ends every open stream, aborts every upstream and refuses new streams", async () => {
    const relay = createSseRelay()
    const ups = [fakeUpstream(), fakeUpstream()]
    const downs = [new FakeDownstream(), new FakeDownstream()]
    const runs = ups.map((upstream, index) =>
      relay.relay({ token: index === 0 ? TOKEN : OTHER, response: downs[index], openUpstream: upstream.open }),
    )
    await tick()
    relay.stop()
    expect(await Promise.all(runs)).toEqual([
      { kind: "ended", by: "stop" },
      { kind: "ended", by: "stop" },
    ])
    expect(downs.every((down) => down.destroyed)).toBe(true)
    expect(ups.every((upstream) => upstream.state.signal?.aborted && upstream.state.cancelled)).toBe(true)
    const late = new FakeDownstream()
    expect(await relay.relay({ token: TOKEN, response: late, openUpstream: fakeUpstream().open })).toEqual({
      kind: "rejected",
      status: 503,
      code: "SWARM_UNAVAILABLE",
    })
  })
})

describe("upstream failures map to 503 SWARM_UNAVAILABLE", () => {
  for (const status of [401, 404, 500]) {
    test(`upstream ${status}`, async () => {
      const relay = createSseRelay()
      const upstream = fakeUpstream({ status, headers: { "www-authenticate": "Basic realm=x" } })
      const down = new FakeDownstream()
      expect(await relay.relay({ token: TOKEN, response: down, openUpstream: upstream.open })).toEqual({
        kind: "rejected",
        status: 503,
        code: "SWARM_UNAVAILABLE",
      })
      expect(down.status).toBe(503)
      expect(JSON.parse(down.body)).toEqual({ error: "SWARM_UNAVAILABLE" })
      expect(Object.keys(down.headers).map((name) => name.toLowerCase())).not.toContain("www-authenticate")
      expect(upstream.state.cancelled).toBe(true)
      expect(relay.active(TOKEN)).toBe(0)
    })
  }

  test("openUpstream rejects (sidecar down)", async () => {
    const relay = createSseRelay()
    const down = new FakeDownstream()
    const result = await relay.relay({
      token: TOKEN,
      response: down,
      openUpstream: () => Promise.reject(new TypeError("connect ECONNREFUSED")),
    })
    expect(result).toEqual({ kind: "rejected", status: 503, code: "SWARM_UNAVAILABLE" })
    expect(relay.active(TOKEN)).toBe(0)
  })
})

describe("SC-31 stream cap: 4 per token, 429 STREAM_LIMIT", () => {
  test("the fifth stream of one token is refused; another token is not affected; a closed slot is reusable", async () => {
    const relay = createSseRelay()
    const ups = Array.from({ length: 4 }, () => fakeUpstream())
    const downs = ups.map(() => new FakeDownstream())
    const runs = ups.map((upstream, index) => relay.relay({ token: TOKEN, response: downs[index], openUpstream: upstream.open }))
    await tick()
    expect(relay.active(TOKEN)).toBe(4)

    let opened = false
    const fifth = new FakeDownstream()
    const refused = await relay.relay({
      token: TOKEN,
      response: fifth,
      openUpstream: async (signal) => {
        opened = true
        return fakeUpstream().open(signal)
      },
    })
    expect(refused).toEqual({ kind: "rejected", status: 429, code: "STREAM_LIMIT" })
    expect(opened).toBe(false) // no upstream connection is made for a refused stream
    expect(fifth.status).toBe(429)
    expect(JSON.parse(fifth.body)).toEqual({ error: "STREAM_LIMIT" })
    expect(fifth.headers["Cache-Control"]).toBe("no-store")
    expect(fifth.headers["X-Content-Type-Options"]).toBe("nosniff")
    expect(Object.keys(fifth.headers).some((name) => name.toLowerCase().startsWith("access-control-"))).toBe(false)

    const other = fakeUpstream()
    const otherRun = relay.relay({ token: OTHER, response: new FakeDownstream(), openUpstream: other.open })
    await tick()
    expect(relay.active(OTHER)).toBe(1)

    downs[0].destroy()
    await runs[0]
    expect(relay.active(TOKEN)).toBe(3)
    const reuse = fakeUpstream()
    const again = relay.relay({ token: TOKEN, response: new FakeDownstream(), openUpstream: reuse.open })
    await tick()
    expect(relay.active(TOKEN)).toBe(4)

    relay.stop()
    await Promise.all([...runs, otherRun, again])
    expect(relay.active(TOKEN)).toBe(0)
    expect(relay.active(OTHER)).toBe(0)
  })

  test("five concurrent opens before any upstream answers: exactly one is refused", async () => {
    const relay = createSseRelay()
    const gate = Promise.withResolvers<void>()
    const downs = Array.from({ length: 5 }, () => new FakeDownstream())
    const runs = downs.map((down) =>
      relay.relay({
        token: TOKEN,
        response: down,
        openUpstream: async (signal) => {
          await gate.promise
          return fakeUpstream().open(signal)
        },
      }),
    )
    await tick()
    expect(downs.filter((down) => down.status === 429).length).toBe(1)
    expect(relay.active(TOKEN)).toBe(4)
    gate.resolve()
    await tick()
    relay.stop()
    await Promise.all(runs)
    expect(relay.active(TOKEN)).toBe(0)
  })

  test("the cap is configurable and the default is OFFICE_STREAM_LIMIT (4)", async () => {
    const relay = createSseRelay({ limit: 1 })
    const run = relay.relay({ token: TOKEN, response: new FakeDownstream(), openUpstream: fakeUpstream().open })
    await tick()
    const second = new FakeDownstream()
    expect((await relay.relay({ token: TOKEN, response: second, openUpstream: fakeUpstream().open })).kind).toBe("rejected")
    relay.stop()
    await run
  })

  test("the relay keeps no raw token and the refusal log carries no token", async () => {
    const lines: string[] = []
    const relay = createSseRelay({ limit: 0, log: (...entry) => lines.push(JSON.stringify(entry)) })
    await relay.relay({ token: TOKEN, response: new FakeDownstream(), openUpstream: fakeUpstream().open })
    expect(lines.length).toBe(1)
    expect(lines.join("")).not.toContain(TOKEN)
    expect(lines.join("")).toContain("STREAM_LIMIT")
  })
})

describe("real loopback sockets (node:http)", () => {
  test("client abort closes the upstream within 1 s; upstream end ends the client", async () => {
    const relay = createSseRelay()
    const upstreams: ReturnType<typeof fakeUpstream>[] = []
    const server = http.createServer((_request, response) => {
      const upstream = fakeUpstream()
      upstreams.push(upstream)
      void relay.relay({ token: TOKEN, response, openUpstream: upstream.open })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/swarm/event`

    // 1. Client side closes first.
    const client = new AbortController()
    const response = await fetch(url, { signal: client.signal })
    expect(response.headers.get("content-type")).toBe("text/event-stream")
    expect(response.headers.get("content-encoding")).toBeNull()
    const reader = response.body!.getReader()
    upstreams[0].push("data: hello\n\n")
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: hello\n\n")
    const started = performance.now()
    client.abort()
    while (!upstreams[0].state.cancelled && performance.now() - started < 1000) await tick(10)
    expect(upstreams[0].state.signal?.aborted).toBe(true)
    expect(upstreams[0].state.cancelled).toBe(true)
    expect(performance.now() - started).toBeLessThan(1000)
    while (relay.active(TOKEN) > 0 && performance.now() - started < 1000) await tick(10)
    expect(relay.active(TOKEN)).toBe(0)

    // 2. Upstream side closes first.
    const second = await fetch(url)
    const text = second.text()
    while (upstreams.length < 2) await tick(5)
    upstreams[1].push("data: bye\n\n")
    upstreams[1].close()
    expect(await text).toBe("data: bye\n\n")
    while (relay.active(TOKEN) > 0) await tick(5)

    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})
