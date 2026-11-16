import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { OFFICE_PANE_CSP, OFFICE_SESSION_RULESET } from "@swarm/office-addin/constants"
import type { BridgeLogLevel, PairDecision, PairRequest } from "./protocol"
import { composeBridgeRoutes, createBridgeRoutes, type RouteRequest } from "./routes"
import { createPairingStore, hashToken } from "./pairing-store"
import { bridgeDataPaths, bridgeExpectations, type BridgeDataPaths } from "./server"
import type { UpstreamInit } from "./upstream"

// Row W4-RC: routes composition. Server-delta spec §9.1 (admit first, then dispatch), §9.4 static, §9.5 SSE, §11
// pairing; C35 (lookup for /swarm/*), C37 (wiring, no-store on pairing), C38 (static only after admit).

const PORT = 47317
const HOST = `localhost:${PORT}`
const SECRET = "synthetic-password-never-logged"
const SESSION = "ses_0123456789abABCDEFGHIJKLMN"

class FakeResponse extends EventEmitter {
  status = 0
  headers: Record<string, string | number> = {}
  chunks: Uint8Array[] = []
  headersSent = false
  writableEnded = false
  destroyed = false
  socket = null
  setTimeout() {}
  writeHead(status: number, headers: Record<string, string | number>) {
    this.status = status
    this.headers = headers
    this.headersSent = true
  }
  flushHeaders() {}
  write(chunk: Uint8Array) {
    this.chunks.push(chunk)
    return true
  }
  end(chunk?: string | Uint8Array) {
    if (typeof chunk === "string") this.chunks.push(new TextEncoder().encode(chunk))
    if (chunk instanceof Uint8Array) this.chunks.push(chunk)
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
  json() {
    return JSON.parse(this.text()) as Record<string, unknown>
  }
  header(name: string) {
    const key = Object.keys(this.headers).find((item) => item.toLowerCase() === name.toLowerCase())
    return key === undefined ? undefined : String(this.headers[key])
  }
}

function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): RouteRequest {
  const all = { Host: HOST, ...headers, ...(body === undefined ? {} : { "Content-Length": String(Buffer.byteLength(body)) }) }
  const raw = Object.entries(all).flatMap((pair) => pair)
  return Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), {
    method,
    url,
    rawHeaders: raw,
    headers: { host: all.Host },
  })
}

const api = (extra: Record<string, string> = {}) => ({ "X-Swarm-Office": "1", ...extra })
const json = { "Content-Type": "application/json" }

type Call = { url: string; init: UpstreamInit }

type Hooks = {
  /** Runs before the routes are composed (seed `pairings.json`). */
  seed?: (paths: BridgeDataPaths) => Promise<void>
  /** Runs synchronously right after composition, while the store's initial load is still pending. */
  composed?: (routes: ReturnType<typeof composeBridgeRoutes>) => void
}

function harness(upstream: (call: Call) => Response | Promise<Response>, hooks: Hooks = {}) {
  const state = {
    dir: "",
    calls: [] as Call[],
    pairs: [] as PairRequest[],
    logs: [] as { level: BridgeLogLevel; message: string; context?: Record<string, unknown> }[],
    listeners: new Set<(decision: PairDecision) => void>(),
  }
  const build = async () => {
    state.dir = await mkdtemp(join(tmpdir(), "routes-test-"))
    const userData = join(state.dir, "user")
    const resources = join(state.dir, "resources")
    const paths = bridgeDataPaths(userData)
    await mkdir(paths.workspace, { recursive: true, mode: 0o700 })
    await chmod(paths.root, 0o700)
    await mkdir(join(resources, "office-addin", "pane"), { recursive: true })
    await writeFile(join(resources, "office-addin", "pane", "index.html"), "<!doctype html><title>pane</title>")
    await hooks.seed?.(paths)
    const routes = composeBridgeRoutes(
      {
        config: {
          serverUrl: "http://127.0.0.1:4096",
          username: "opencode",
          password: SECRET,
          userDataDir: userData,
          resourcesDir: resources,
          port: PORT,
          cert: "",
          key: "",
        },
        deps: {
          pairRequests: (pair) => state.pairs.push(pair),
          pairDecisions: {
            subscribe(listener) {
              state.listeners.add(listener)
              return () => state.listeners.delete(listener)
            },
          },
        },
        log: (level, _source, message, context) => state.logs.push({ level, message, context }),
        expectations: bridgeExpectations(PORT),
        paths,
      },
      {
        fetch: async (url, init) => {
          const call = { url, init }
          state.calls.push(call)
          return upstream(call)
        },
      },
    )
    hooks.composed?.(routes)
    return { routes, paths }
  }
  return { state, build }
}

async function send(routes: ReturnType<typeof composeBridgeRoutes>, req: RouteRequest) {
  const res = new FakeResponse()
  await routes.handle(req, res)
  return res
}

const officeSession = (workspace: string) => ({
  id: SESSION,
  directory: workspace,
  metadata: { "swarm.origin": "office-addin", "swarm.office.host": "Word" },
  permission: OFFICE_SESSION_RULESET,
})

/** Pairs a Word pane through the real pairing flow and returns its token. */
async function pair(h: ReturnType<typeof harness>, routes: ReturnType<typeof composeBridgeRoutes>) {
  const created = await send(routes, request("POST", "/pair/request", api(json), JSON.stringify({ host: "Word" })))
  expect(created.status).toBe(202)
  const requestId = String(created.json().requestId)
  for (const listener of h.state.listeners) listener({ requestId, allow: true })
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    const status = await send(routes, request("GET", `/pair/status?requestId=${requestId}`, api()))
    const body = status.json()
    if (body.state === "approved") return String(body.token)
    await Bun.sleep(5)
  }
  throw new Error("pairing not approved")
}

describe("office bridge routes composition", () => {
  const ctx = { h: harness(() => new Response("{}")), routes: undefined as ReturnType<typeof composeBridgeRoutes> | undefined }
  const upstreamReply = { fn: (_call: Call): Response | Promise<Response> => Response.json({ healthy: true }) }

  beforeEach(async () => {
    ctx.h = harness((call) => upstreamReply.fn(call))
    upstreamReply.fn = () => Response.json({ healthy: true })
    ctx.routes = (await ctx.h.build()).routes
  })

  afterEach(async () => {
    await ctx.routes?.stop()
    await rm(ctx.h.state.dir, { recursive: true, force: true })
  })

  const routes = () => {
    if (!ctx.routes) throw new Error("routes not built")
    return ctx.routes
  }

  test("admit runs first: a bad Host never reaches the static files, pairing or the upstream", async () => {
    const pane = await send(routes(), request("GET", "/pane/index.html", { Host: "evil.example:47317" }))
    expect(pane.status).toBe(421)
    expect(pane.json()).toEqual({ error: "HOST_REJECTED" })
    expect(pane.header("content-security-policy")).toBeUndefined()

    const origin = await send(routes(), request("GET", "/", { Origin: "https://evil.example" }))
    expect(origin.status).toBe(403)
    expect(origin.header("location")).toBeUndefined()
  })

  test("a request without X-Swarm-Office never reaches pairing, health or the upstream", async () => {
    const pairing = await send(routes(), request("POST", "/pair/request", json, JSON.stringify({ host: "Word" })))
    const health = await send(routes(), request("GET", "/bridge/health"))
    const proxy = await send(routes(), request("GET", "/swarm/global/health", { "X-Swarm-Office-Token": "swo1_x" }))
    const zero = await send(routes(), request("GET", "/swarm/event", { "X-Swarm-Office": "0" }))
    for (const res of [pairing, health, proxy, zero]) {
      expect(res.status).toBe(403)
      expect(res.json()).toEqual({ error: "CSRF_HEADER_MISSING" })
    }
    expect(ctx.h.state.pairs).toHaveLength(0)
    expect(ctx.h.state.calls).toHaveLength(0)
  })

  test("/ redirects to the pane page", async () => {
    const res = await send(routes(), request("GET", "/"))
    expect(res.status).toBe(302)
    expect(res.header("location")).toBe("/pane/index.html")
    expect(res.header("cache-control")).toBe("no-store")
  })

  test("the pane is served after admit, with the CSP; traversal and other methods are 404", async () => {
    const res = await send(routes(), request("GET", "/pane/index.html?_host_Info=Word"))
    expect(res.status).toBe(200)
    expect(res.text()).toContain("<title>pane</title>")
    expect(res.header("content-security-policy")).toBe(OFFICE_PANE_CSP)
    expect((await send(routes(), request("GET", "/pane/%2e%2e/secret.html"))).status).toBe(404)
    expect((await send(routes(), request("GET", "/pane/missing.html"))).status).toBe(404)
    expect((await send(routes(), request("POST", "/pane/index.html"))).status).toBe(404)
    expect(ctx.h.state.calls).toHaveLength(0)
  })

  test("pairing round trip: request, allow, token once, verify, then /swarm/* with the token", async () => {
    const token = await pair(ctx.h, routes())
    expect(token).toMatch(/^swo1_[A-Za-z0-9_-]{43}$/)
    expect(ctx.h.state.pairs).toHaveLength(1)
    expect(ctx.h.state.pairs[0].host).toBe("Word")

    const verify = await send(routes(), request("GET", "/pair/verify", api({ "X-Swarm-Office-Token": token })))
    expect(verify.status).toBe(204)
    expect(verify.header("cache-control")).toBe("no-store")

    const bad = await send(routes(), request("GET", "/pair/verify", api({ "X-Swarm-Office-Token": "swo1_unknown" })))
    expect(bad.status).toBe(401)

    const health = await send(routes(), request("GET", "/swarm/global/health", api({ "X-Swarm-Office-Token": token })))
    expect(health.status).toBe(200)
    expect(ctx.h.state.calls).toHaveLength(1)
    expect(ctx.h.state.calls[0].url.startsWith("http://127.0.0.1:4096/global/health?directory=")).toBe(true)
  })

  test("every pairing response carries Cache-Control: no-store and the token is never logged", async () => {
    const created = await send(routes(), request("POST", "/pair/request", api(json), JSON.stringify({ host: "Excel" })))
    expect(created.header("cache-control")).toBe("no-store")
    const status = await send(routes(), request("GET", `/pair/status?requestId=${String(created.json().requestId)}`, api()))
    expect(status.header("cache-control")).toBe("no-store")
    const limited = await send(routes(), request("POST", "/pair/request", api(json), JSON.stringify({ host: "Excel" })))
    expect(limited.status).toBe(429)
    expect(limited.header("cache-control")).toBe("no-store")
    for (const listener of ctx.h.state.listeners) listener({ requestId: String(created.json().requestId), allow: true })
    await Bun.sleep(20)
    const approved = await send(routes(), request("GET", `/pair/status?requestId=${String(created.json().requestId)}`, api()))
    const token = String(approved.json().token)
    expect(JSON.stringify(ctx.h.state.logs)).not.toContain(token)
    expect(JSON.stringify(ctx.h.state.logs)).not.toContain(SECRET)
  })

  test("/swarm/* without a paired token is 401 and the upstream is not called", async () => {
    const res = await send(routes(), request("GET", "/swarm/session", api({ "X-Swarm-Office-Token": "swo1_nope" })))
    expect(res.status).toBe(401)
    expect(res.json()).toEqual({ error: "TOKEN_INVALID" })
    expect(ctx.h.state.calls).toHaveLength(0)
  })

  test("proxy P2 forces the ruleset and metadata; a client permission field is refused", async () => {
    const token = await pair(ctx.h, routes())
    upstreamReply.fn = () => Response.json({ id: SESSION }, { headers: { "set-cookie": "a=b", "www-authenticate": "x" } })

    const refused = await send(
      routes(),
      request("POST", "/swarm/session", api({ ...json, "X-Swarm-Office-Token": token }), JSON.stringify({ host: "Word", permission: [] })),
    )
    expect(refused.status).toBe(400)
    expect(ctx.h.state.calls).toHaveLength(0)

    const res = await send(
      routes(),
      request("POST", "/swarm/session", api({ ...json, "X-Swarm-Office-Token": token }), JSON.stringify({ title: "Doc", host: "Word" })),
    )
    expect(res.status).toBe(200)
    expect(res.header("set-cookie")).toBeUndefined()
    expect(res.header("www-authenticate")).toBeUndefined()
    expect(ctx.h.state.calls).toHaveLength(1)
    const call = ctx.h.state.calls[0]
    expect(call.init.method).toBe("POST")
    expect(call.url.startsWith("http://127.0.0.1:4096/session?directory=")).toBe(true)
    expect(JSON.parse(new TextDecoder().decode(call.init.body))).toEqual({
      title: "Doc",
      permission: OFFICE_SESSION_RULESET,
      metadata: { "swarm.origin": "office-addin", "swarm.office.host": "Word" },
    })
    expect(call.init.headers["authorization"]).toBe(`Basic ${Buffer.from(`opencode:${SECRET}`).toString("base64")}`)
    expect(Object.keys(call.init.headers).some((name) => name.toLowerCase().startsWith("x-swarm"))).toBe(false)
  })

  test("P4 runs the ownership check through the upstream module", async () => {
    const token = await pair(ctx.h, routes())
    upstreamReply.fn = () => Response.json({ ...officeSession("/elsewhere") })
    const foreign = await send(routes(), request("GET", `/swarm/session/${SESSION}`, api({ "X-Swarm-Office-Token": token })))
    expect(foreign.status).toBe(404)
  })

  test("P8 is relayed as a byte stream over upstream.openEvents", async () => {
    const token = await pair(ctx.h, routes())
    upstreamReply.fn = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'))
            controller.close()
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream", "set-cookie": "a=b" } },
      )
    const res = await send(routes(), request("GET", "/swarm/event", api({ "X-Swarm-Office-Token": token })))
    expect(res.status).toBe(200)
    expect(res.header("content-type")).toBe("text/event-stream")
    expect(res.header("cache-control")).toBe("no-cache, no-transform")
    expect(res.header("set-cookie")).toBeUndefined()
    expect(res.text()).toBe('data: {"type":"server.connected"}\n\n')
    expect(res.writableEnded).toBe(true)
    const call = ctx.h.state.calls[0]
    expect(call.url.startsWith("http://127.0.0.1:4096/event?directory=")).toBe(true)
    expect(call.init.signal).toBeInstanceOf(AbortSignal)
  })

  test("unknown routes are 404 ROUTE_NOT_ALLOWED", async () => {
    const token = await pair(ctx.h, routes())
    const calls = ctx.h.state.calls.length
    const unknown = await send(routes(), request("GET", "/swarm/session/status", api({ "X-Swarm-Office-Token": token })))
    const patch = await send(routes(), request("PATCH", `/swarm/session/${SESSION}`, api({ "X-Swarm-Office-Token": token })))
    const other = await send(routes(), request("GET", "/nothing"))
    for (const res of [unknown, patch, other]) {
      expect(res.status).toBe(404)
      expect(res.json()).toEqual({ error: "ROUTE_NOT_ALLOWED" })
    }
    expect(ctx.h.state.calls).toHaveLength(calls)
  })

  test("/bridge/health reports the sidecar state from the P1 probe", async () => {
    const ready = await send(routes(), request("GET", "/bridge/health", api()))
    expect(ready.status).toBe(200)
    expect(ready.json()).toEqual({ bridge: "ok", swarm: "ready" })
    upstreamReply.fn = () => new Response("no", { status: 401, headers: { "www-authenticate": "Basic" } })
    const down = await send(routes(), request("GET", "/bridge/health", api()))
    expect(down.json()).toEqual({ bridge: "ok", swarm: "down" })
    upstreamReply.fn = () => Promise.reject(new Error("ECONNREFUSED"))
    const refused = await send(routes(), request("GET", "/bridge/health", api()))
    expect(refused.json()).toEqual({ bridge: "ok", swarm: "down" })
  })

  test("a body over the limit is 413 and nothing is dispatched", async () => {
    const big = JSON.stringify({ host: "Word", pad: "x".repeat(2 * 1024 * 1024) })
    const res = await send(routes(), request("POST", "/pair/request", api(json), big))
    expect(res.status).toBe(413)
    expect(ctx.h.state.pairs).toHaveLength(0)
  })

  test("each request logs exactly the five SC-33 fields", async () => {
    await send(routes(), request("GET", "/pane/index.html?secret=1"))
    const line = ctx.h.state.logs.find((entry) => entry.message.startsWith("method=GET route=pane"))
    expect(line?.context && Object.keys(line.context).sort()).toEqual(["durationMs", "host", "method", "route", "status"])
    expect(line?.message).not.toContain("secret")
  })

  test("pairingsCleared empties the store: a paired token stops working", async () => {
    const token = await pair(ctx.h, routes())
    routes().pairingsCleared()
    await Bun.sleep(20)
    const res = await send(routes(), request("GET", "/swarm/global/health", api({ "X-Swarm-Office-Token": token })))
    expect(res.status).toBe(401)
  })

  test("stop ends open streams and refuses new ones", async () => {
    const token = await pair(ctx.h, routes())
    upstreamReply.fn = (call) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": hi\n\n"))
            call.init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
          },
        }),
        { status: 200 },
      )
    const res = new FakeResponse()
    const open = routes().handle(request("GET", "/swarm/event", api({ "X-Swarm-Office-Token": token })), res)
    await Bun.sleep(20)
    expect(res.status).toBe(200)
    await routes().stop()
    await open
    expect(res.destroyed).toBe(true)
    const after = await send(routes(), request("GET", "/swarm/event", api({ "X-Swarm-Office-Token": token })))
    expect(after.status).toBe(503)
  })
})

test("createBridgeRoutes is a BridgeRoutesFactory", () => {
  expect(typeof createBridgeRoutes()).toBe("function")
})

const OLD_TOKEN = "swo1_" + "o".repeat(43)

async function seedOldPairing(paths: BridgeDataPaths) {
  const at = new Date().toISOString()
  const store = { version: 1, pairings: [{ host: "Word", hash: hashToken(OLD_TOKEN), createdAt: at, lastUsedAt: at }] }
  await writeFile(paths.pairings, JSON.stringify(store), { mode: 0o600 })
}

async function storedHosts(paths: BridgeDataPaths) {
  const store = JSON.parse(await readFile(paths.pairings, "utf8")) as { pairings: { host: string }[] }
  return store.pairings.map((entry) => entry.host)
}

describe("W4-RC-a: Disconnect during the initial store load (CP-M4 F-1)", () => {
  test("routes: a clear issued while load() is pending wins; the old token is rejected and never written back", async () => {
    const pending = { seen: false }
    const h = harness(() => Response.json({ healthy: true }), {
      seed: seedOldPairing,
      composed: (routes) => {
        routes.pairingsCleared()
        pending.seen = true
      },
    })
    const built = await h.build()
    expect(pending.seen).toBe(true)
    try {
      const old = await send(built.routes, request("GET", "/swarm/global/health", api({ "X-Swarm-Office-Token": OLD_TOKEN })))
      expect(old.status).toBe(401)
      expect(h.state.calls).toHaveLength(0)
      expect(await storedHosts(built.paths)).toEqual([])

      // The next store write (a new Excel pairing) must not bring the cleared Word entry back.
      const created = await send(built.routes, request("POST", "/pair/request", api(json), JSON.stringify({ host: "Excel" })))
      const requestId = String(created.json().requestId)
      for (const listener of h.state.listeners) listener({ requestId, allow: true })
      await Bun.sleep(20)
      const approved = await send(built.routes, request("GET", `/pair/status?requestId=${requestId}`, api()))
      expect(approved.json().state).toBe("approved")
      expect(await storedHosts(built.paths)).toEqual(["Excel"])
      const again = await send(built.routes, request("GET", "/pair/verify", api({ "X-Swarm-Office-Token": OLD_TOKEN })))
      expect(again.status).toBe(401)
      expect(await storedHosts(built.paths)).toEqual(["Excel"])
    } finally {
      await built.routes.stop()
      await rm(h.state.dir, { recursive: true, force: true })
    }
  })

  test("store: clear() during an unawaited load() wins; a later put does not resurrect the entry", async () => {
    const dir = await mkdtemp(join(tmpdir(), "routes-store-"))
    try {
      await chmod(dir, 0o700)
      await seedOldPairing({ root: dir, workspace: join(dir, "workspace"), pairings: join(dir, "pairings.json") })
      const store = createPairingStore({ dir, log: () => {} })
      const loading = store.load()
      await store.clear()
      await loading
      expect(store.lookup(OLD_TOKEN)).toBeUndefined()
      expect(await store.verify(OLD_TOKEN)).toBeUndefined()
      await store.put("Excel", "swo1_" + "n".repeat(43))
      expect(store.list().map((entry) => entry.host)).toEqual(["Excel"])
      const file = JSON.parse(await readFile(join(dir, "pairings.json"), "utf8")) as { pairings: { host: string }[] }
      expect(file.pairings.map((entry) => entry.host)).toEqual(["Excel"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test("I-3: /pair/request, /pair/status and /pair/verify answers all carry Cache-Control: no-store", async () => {
  const h = harness(() => Response.json({ healthy: true }))
  const built = await h.build()
  try {
    const token = await pair(h, built.routes)
    const created = await send(built.routes, request("POST", "/pair/request", api(json), JSON.stringify({ host: "Excel" })))
    const limited = await send(built.routes, request("POST", "/pair/request", api(json), JSON.stringify({ host: "Excel" })))
    const status = await send(built.routes, request("GET", `/pair/status?requestId=${String(created.json().requestId)}`, api()))
    const unknown = await send(built.routes, request("GET", `/pair/status?requestId=${"A".repeat(22)}`, api()))
    const verified = await send(built.routes, request("GET", "/pair/verify", api({ "X-Swarm-Office-Token": token })))
    const rejected = await send(built.routes, request("GET", "/pair/verify", api({ "X-Swarm-Office-Token": "swo1_bad" })))
    expect([created, limited, status, unknown, verified, rejected].map((res) => res.status)).toEqual([202, 429, 200, 200, 204, 401])
    for (const res of [created, limited, status, unknown, verified, rejected]) {
      expect(res.header("cache-control")).toBe("no-store")
      expect(res.header("x-content-type-options")).toBe("nosniff")
    }
  } finally {
    await built.routes.stop()
    await rm(h.state.dir, { recursive: true, force: true })
  }
})

describe("W4-RC-b: Disconnect and re-pair end open event streams (CP-M5 M5-F1)", () => {
  /** An upstream event body the test drives by hand; records the abort of each open. */
  function events() {
    const opened: { push: (text: string) => void; signal?: AbortSignal }[] = []
    const reply = (call: Call) => {
      if (!call.url.includes("/event?")) return Response.json({ healthy: true })
      const entry = { push: (_text: string) => {}, signal: call.init.signal }
      opened.push(entry)
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            entry.push = (text) => {
              if (call.init.signal?.aborted) return
              controller.enqueue(new TextEncoder().encode(text))
            }
            call.init.signal?.addEventListener("abort", () => controller.error(new Error("aborted")))
          },
        }),
        { status: 200 },
      )
    }
    return { opened, reply }
  }

  async function openStream(routes: ReturnType<typeof composeBridgeRoutes>, token: string) {
    const res = new FakeResponse()
    const done = routes.handle(request("GET", "/swarm/event", api({ "X-Swarm-Office-Token": token })), res)
    await Bun.sleep(20)
    return { res, done }
  }

  test("pairingsCleared ends an open stream at once; no frame is delivered after it", async () => {
    const upstream = events()
    const h = harness(upstream.reply)
    const built = await h.build()
    try {
      const token = await pair(h, built.routes)
      const stream = await openStream(built.routes, token)
      upstream.opened[0].push("data: before\n\n")
      await Bun.sleep(10)
      expect(stream.res.text()).toBe("data: before\n\n")

      built.routes.pairingsCleared()
      upstream.opened[0].push("data: after\n\n")
      await stream.done
      await Bun.sleep(10)
      expect(stream.res.destroyed).toBe(true)
      expect(upstream.opened[0].signal?.aborted).toBe(true)
      expect(stream.res.text()).not.toContain("after")
      const again = await send(built.routes, request("GET", "/swarm/event", api({ "X-Swarm-Office-Token": token })))
      expect(again.status).toBe(401)
    } finally {
      await built.routes.stop()
      await rm(h.state.dir, { recursive: true, force: true })
    }
  })

  test("a re-pair that replaces the host's token ends the old token's streams only", async () => {
    const upstream = events()
    const h = harness(upstream.reply)
    const built = await h.build()
    try {
      const word = await pair(h, built.routes)
      const excel = await (async () => {
        const created = await send(built.routes, request("POST", "/pair/request", api(json), JSON.stringify({ host: "Excel" })))
        const requestId = String(created.json().requestId)
        for (const listener of h.state.listeners) listener({ requestId, allow: true })
        await Bun.sleep(20)
        return String((await send(built.routes, request("GET", `/pair/status?requestId=${requestId}`, api()))).json().token)
      })()
      const oldWord = await openStream(built.routes, word)
      const excelStream = await openStream(built.routes, excel)

      const replacement = await pair(h, built.routes)
      expect(replacement).not.toBe(word)
      await oldWord.done
      upstream.opened[0].push("data: after\n\n")
      upstream.opened[1].push("data: excel\n\n")
      await Bun.sleep(10)
      expect(oldWord.res.destroyed).toBe(true)
      expect(oldWord.res.text()).not.toContain("after")
      expect(upstream.opened[0].signal?.aborted).toBe(true)
      expect(excelStream.res.destroyed).toBe(false)
      expect(excelStream.res.text()).toBe("data: excel\n\n")
      expect((await send(built.routes, request("GET", "/swarm/global/health", api({ "X-Swarm-Office-Token": word })))).status).toBe(401)
    } finally {
      await built.routes.stop()
      await rm(h.state.dir, { recursive: true, force: true })
    }
  })
})

describe("W4-RC-b: header stages run before the body is read (CP-M5 M5-F3)", () => {
  /** A request whose body records whether anything pulled it. */
  function unread(method: string, url: string, headers: Record<string, string>) {
    const state = { pulled: false }
    const size = 3 * 1024 * 1024
    const all = { Host: HOST, ...headers, "Content-Length": String(size) }
    const req = Object.assign(
      new Readable({
        read() {
          state.pulled = true
          this.push(Buffer.alloc(size, 0x61))
          this.push(null)
        },
      }),
      { method, url, rawHeaders: Object.entries(all).flatMap((pair) => pair), headers: { host: all.Host } },
    )
    return { req, state }
  }

  test("bad Host, bad Origin, missing CSRF, unknown token, unknown route and a GET with a body are refused unread", async () => {
    const h = harness(() => Response.json({ healthy: true }))
    const built = await h.build()
    try {
      const cases = [
        { req: unread("POST", "/pair/request", { ...api(json), Host: "evil.example:47317" }), status: 421 },
        { req: unread("POST", "/pair/request", { ...api(json), Origin: "https://evil.example" }), status: 403 },
        { req: unread("POST", "/pair/request", json), status: 403 },
        { req: unread("POST", "/swarm/session", api({ ...json, "X-Swarm-Office-Token": "swo1_nope" })), status: 401 },
        { req: unread("POST", "/swarm/nothing", api(json)), status: 401 },
        { req: unread("POST", "/bridge/health", api(json)), status: 404 },
        { req: unread("GET", "/bridge/health", api(json)), status: 400 },
      ]
      for (const item of cases) {
        const res = new FakeResponse()
        await built.routes.handle(item.req.req, res)
        expect(res.status).toBe(item.status)
        expect(item.req.state.pulled).toBe(false)
      }
      expect(h.state.pairs).toHaveLength(0)
      expect(h.state.calls).toHaveLength(0)
    } finally {
      await built.routes.stop()
      await rm(h.state.dir, { recursive: true, force: true })
    }
  })

  test("a POST to a body route that passes the header stages is read: small body admitted, 3 MiB answered 413", async () => {
    const h = harness(() => Response.json({ healthy: true }))
    const built = await h.build()
    try {
      const big = unread("POST", "/pair/request", api(json))
      const res = new FakeResponse()
      await built.routes.handle(big.req, res)
      expect(res.status).toBe(413)
      const ok = await send(built.routes, request("POST", "/pair/request", api(json), JSON.stringify({ host: "Word" })))
      expect(ok.status).toBe(202)
    } finally {
      await built.routes.stop()
      await rm(h.state.dir, { recursive: true, force: true })
    }
  })
})
