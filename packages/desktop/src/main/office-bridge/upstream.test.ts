// Unit tests for the upstream builder and response filter (plan M5-02): U-BR-09 (forwarded headers and request build),
// U-BR-10 (response headers), U-BR-12 (ownership decision), plus SC-35, P2/P3 rules and the 401 -> 503 mapping.
import { describe, expect, test } from "bun:test"
import { OFFICE_SESSION_RULESET } from "@swarm/office-addin/constants"
import { admit, type AdmitRequest } from "./admit"
import {
  buildUpstreamRequest,
  createUpstream,
  isOfficeSession,
  sidecarOrigin,
  type ProxyAdmission,
  type UpstreamFetch,
  type UpstreamInit,
  type UpstreamResult,
} from "./upstream"

const PORT = 46317
const TOKEN = "swo1_" + "a".repeat(43)
const SID = "ses_0123456789abABCDEFGHIJKLMN"
const SERVER = "http://127.0.0.1:4096"
const PASSWORD = "test-sidecar-pw"
const WORKSPACE = "/tmp/swarm-test-userdata/office-addin/workspace"
const AUTH = "Basic " + Buffer.from("opencode:" + PASSWORD).toString("base64")

const owned = (extra: Record<string, unknown> = {}) => ({
  id: SID,
  title: "t",
  directory: WORKSPACE,
  metadata: { "swarm.origin": "office-addin", "swarm.office.host": "Word" },
  permission: OFFICE_SESSION_RULESET.map((rule) => ({ ...rule })),
  ...extra,
})

type Call = { url: string; init: UpstreamInit }

/** A stub sidecar: `reply` picks the response per call; every call is recorded. */
function stub(reply: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = []
  const fetch: UpstreamFetch = async (url, init) => {
    const call = { url, init }
    calls.push(call)
    return reply(call, calls.length - 1)
  }
  return { calls, fetch }
}

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  })

const hostile = {
  "access-control-allow-origin": "*",
  "access-control-allow-credentials": "true",
  "set-cookie": "sid=1; Path=/",
  "www-authenticate": 'Basic realm="opencode"',
  "x-foo": "bar",
  vary: "Origin",
  "x-accel-buffering": "no",
  "cache-control": "public, max-age=600",
}

const upstream = (fetch: UpstreamFetch, serverUrl = SERVER) =>
  createUpstream({ serverUrl, username: "opencode", password: PASSWORD, workspace: WORKSPACE, fetch })

const base = { kind: "proxy" as const, token: TOKEN, tokenHost: "Word" as const, forward: {} }
const ADMISSIONS: ProxyAdmission[] = [
  { ...base, route: "P1" },
  { ...base, route: "P2", host: "Excel", title: "Budget" },
  { ...base, route: "P3", limit: 20 },
  { ...base, route: "P4", sessionID: SID },
  { ...base, route: "P5", sessionID: SID, limit: 50 },
  { ...base, route: "P6", sessionID: SID, parts: [{ type: "text", text: "hi" }] },
  { ...base, route: "P7", sessionID: SID },
  { ...base, route: "P8" },
]

/** Default upstream: ownership read returns an Office session, every other call echoes a JSON object. */
const ok = (call: Call) => {
  const path = new URL(call.url).pathname
  if (path === `/session/${SID}`) return json(owned(), { headers: hostile })
  if (path === "/session" && call.init.method === "GET") return json([owned()], { headers: hostile })
  if (path === "/event")
    return new Response("data: {}\n\n", { headers: { ...hostile, "content-type": "text/event-stream" } })
  if (path.endsWith("/prompt_async")) return new Response(null, { status: 204, headers: hostile })
  return json({ ok: true }, { headers: hostile })
}

const text = (result: UpstreamResult) =>
  result.kind === "buffered" ? new TextDecoder().decode(result.body) : "<stream>"

/** A well-formed pane request through admit(), with extra headers the pane might add or an attacker might set. */
async function admitted(target: string, method: string, headers: Record<string, string>, body?: unknown) {
  const raw = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body))
  const request: AdmitRequest = {
    method,
    target,
    headers: Object.entries({
      host: `localhost:${PORT}`,
      origin: `https://localhost:${PORT}`,
      "x-swarm-office": "1",
      "x-swarm-office-token": TOKEN,
      ...(raw ? { "content-type": "application/json", "content-length": String(raw.length) } : {}),
      ...headers,
    }),
    ...(raw ? { body: raw } : {}),
  }
  const admission = await admit(request, { port: PORT, verifyToken: (token) => (token === TOKEN ? "Word" : undefined) })
  if (admission.kind !== "proxy") throw new Error(`not proxied: ${JSON.stringify(admission)}`)
  return admission
}

describe("SC-35: upstream URL only from start", () => {
  test.each([
    ["http://127.0.0.1:4096", "http://127.0.0.1:4096"],
    ["http://127.0.0.1:4096/", "http://127.0.0.1:4096"],
  ])("accepts %s", (input, origin) => {
    expect(sidecarOrigin(input)).toBe(origin)
  })

  test.each([
    "https://127.0.0.1:4096",
    "http://localhost:4096",
    "http://[::1]:4096",
    "http://10.0.0.5:4096",
    "http://127.0.0.1",
    "http://user:pw@127.0.0.1:4096",
    "http://127.0.0.1:4096/api",
    "http://127.0.0.1:4096/?x=1",
    "http://127.0.0.1:4096/#f",
    "not a url",
    "",
  ])("rejects %s with 503 and never calls fetch", async (serverUrl) => {
    expect(sidecarOrigin(serverUrl)).toBeUndefined()
    const sidecar = stub(ok)
    const result = await upstream(sidecar.fetch, serverUrl).forward({ ...base, route: "P1" })
    expect(result.status).toBe(503)
    expect(text(result)).toBe('{"error":"SWARM_UNAVAILABLE"}')
    expect(sidecar.calls).toHaveLength(0)
  })

  test("every route targets the start origin, never follows redirects", () => {
    for (const admission of ADMISSIONS) {
      const request = buildUpstreamRequest(admission, { serverUrl: SERVER, username: "opencode", password: PASSWORD, workspace: WORKSPACE })
      expect(request).toBeDefined()
      expect(new URL(request?.url ?? "").origin).toBe(SERVER)
      expect(request?.init.redirect).toBe("error")
    }
  })
})

describe("U-BR-09: upstream request build (allow-listed headers, query, body)", () => {
  const config = { serverUrl: SERVER, username: "opencode", password: PASSWORD, workspace: WORKSPACE }

  test.each([
    ["P1", "GET", "/global/health", { directory: WORKSPACE }],
    ["P2", "POST", "/session", { directory: WORKSPACE }],
    ["P3", "GET", "/session", { directory: WORKSPACE, roots: "true", limit: "20" }],
    ["P4", "GET", `/session/${SID}`, { directory: WORKSPACE }],
    ["P5", "GET", `/session/${SID}/message`, { directory: WORKSPACE, limit: "50" }],
    ["P6", "POST", `/session/${SID}/prompt_async`, { directory: WORKSPACE }],
    ["P7", "POST", `/session/${SID}/abort`, { directory: WORKSPACE }],
    ["P8", "GET", "/event", { directory: WORKSPACE }],
  ])("%s -> %s %s with the bridge-built query", (route, method, path, query) => {
    const admission = ADMISSIONS.find((item) => item.route === route)
    if (!admission) throw new Error(route)
    const request = buildUpstreamRequest(admission, config)
    const url = new URL(request?.url ?? "")
    expect(request?.init.method).toBe(method as "GET" | "POST")
    expect(url.pathname).toBe(path)
    expect(Object.fromEntries(url.searchParams)).toEqual(query)
  })

  test("header set is exactly the allow-list; Basic auth from start; identity encoding", () => {
    for (const admission of ADMISSIONS) {
      const request = buildUpstreamRequest(admission, config)
      const headers = request?.init.headers ?? {}
      const hasBody = admission.route === "P2" || admission.route === "P6"
      expect(Object.keys(headers).sort()).toEqual(
        ["accept", "accept-encoding", "authorization", ...(hasBody ? ["content-type"] : [])].sort(),
      )
      expect(headers.authorization).toBe(AUTH)
      expect(headers["accept-encoding"]).toBe("identity")
      expect(headers.accept).toBe(admission.route === "P8" ? "text/event-stream" : "application/json")
      if (hasBody) expect(headers["content-type"]).toBe("application/json")
    }
  })

  test("Accept and Last-Event-ID are the only client headers forwarded", () => {
    const request = buildUpstreamRequest(
      { ...base, route: "P8", forward: { accept: "text/event-stream", lastEventId: "42" } },
      config,
    )
    expect(request?.init.headers).toEqual({
      authorization: AUTH,
      accept: "text/event-stream",
      "accept-encoding": "identity",
      "last-event-id": "42",
    })
  })

  test("end to end through admit: nonce-free, cookie-free, no Office headers upstream", async () => {
    const admission = await admitted("/swarm/session/" + SID + "/message?limit=50", "GET", {
      cookie: "sid=steal",
      "x-forwarded-for": "10.0.0.1",
      "user-agent": "Office",
      authorization: "Basic ZXZpbA==",
      "accept-encoding": "gzip, br",
      accept: "application/json",
      "last-event-id": "7",
    })
    const sidecar = stub(ok)
    const result = await upstream(sidecar.fetch).forward(admission)
    expect(result.status).toBe(200)
    expect(sidecar.calls).toHaveLength(2)
    for (const call of sidecar.calls) {
      const names = Object.keys(call.init.headers)
      for (const banned of ["cookie", "x-swarm-office", "x-swarm-office-token", "x-swarm-desktop-nonce", "user-agent", "x-forwarded-for", "origin", "host", "content-length"])
        expect(names).not.toContain(banned)
      expect(names.some((name) => name.startsWith("x-opencode-"))).toBe(false)
      expect(call.init.headers.authorization).toBe(AUTH)
      expect(call.init.headers["accept-encoding"]).toBe("identity")
    }
    // The ownership read gets no client header at all.
    expect(sidecar.calls[0].init.headers).toEqual({ authorization: AUTH, accept: "application/json", "accept-encoding": "identity" })
    expect(sidecar.calls[1].init.headers["last-event-id"]).toBe("7")
  })

  test("P2 body is forced to title + ruleset + metadata, re-serialised", async () => {
    const admission = await admitted("/swarm/session", "POST", {}, { title: "Q3 plan", host: "Excel" })
    const sidecar = stub(ok)
    await upstream(sidecar.fetch).forward(admission)
    const body = JSON.parse(new TextDecoder().decode(sidecar.calls[0].init.body))
    expect(body).toEqual({
      title: "Q3 plan",
      permission: OFFICE_SESSION_RULESET,
      metadata: { "swarm.origin": "office-addin", "swarm.office.host": "Excel" },
    })
    expect(Object.keys(body)).toEqual(["title", "permission", "metadata"])
    expect(body).not.toHaveProperty("agent")
  })

  test("P2 without a title sends no title key", () => {
    const request = buildUpstreamRequest({ ...base, route: "P2", host: "Word" }, config)
    const body = JSON.parse(new TextDecoder().decode(request?.init.body))
    expect(Object.keys(body)).toEqual(["permission", "metadata"])
    expect(body.metadata).toEqual({ "swarm.origin": "office-addin", "swarm.office.host": "Word" })
  })

  test("P6 body is exactly { parts }, P7 and GET routes send no body", () => {
    const p6 = buildUpstreamRequest(
      { ...base, route: "P6", sessionID: SID, parts: [{ type: "text", text: "ctx" }, { type: "text", text: "ask" }] },
      config,
    )
    expect(new TextDecoder().decode(p6?.init.body)).toBe('{"parts":[{"type":"text","text":"ctx"},{"type":"text","text":"ask"}]}')
    for (const route of ["P1", "P3", "P4", "P5", "P7", "P8"]) {
      const admission = ADMISSIONS.find((item) => item.route === route)
      if (!admission) throw new Error(route)
      expect(buildUpstreamRequest(admission, config)?.init.body).toBeUndefined()
    }
  })

  test("password never appears in the URL", () => {
    for (const admission of ADMISSIONS)
      expect(buildUpstreamRequest(admission, config)?.url.includes(PASSWORD)).toBe(false)
  })
})

describe("U-BR-10: response headers (allow-list + security headers)", () => {
  const SECURITY = {
    "x-content-type-options": "nosniff",
    "cross-origin-resource-policy": "same-origin",
    "referrer-policy": "no-referrer",
  }

  test.each(ADMISSIONS.map((admission) => [admission.route, admission] as const))(
    "%s drops upstream CORS, Set-Cookie, www-authenticate and unknown headers",
    async (_route, admission) => {
      const result = await upstream(stub(ok).fetch).forward(admission)
      const names = Object.keys(result.headers)
      expect(names.some((name) => name.startsWith("access-control-"))).toBe(false)
      for (const dropped of ["set-cookie", "www-authenticate", "x-foo", "vary", "x-accel-buffering", "content-encoding"])
        expect(names).not.toContain(dropped)
      expect(result.headers).toMatchObject(SECURITY)
      if (result.kind === "stream") {
        expect(result.headers["content-type"]).toBe("text/event-stream")
        expect(result.headers["cache-control"]).toBe("no-cache, no-transform")
        expect(names).not.toContain("content-length")
        return
      }
      expect(result.headers["cache-control"]).toBe("no-store")
      if (result.status === 204) {
        expect(names).not.toContain("content-length")
        return
      }
      expect(result.headers["content-length"]).toBe(String(result.body.length))
      expect(result.headers["content-type"]).toBe("application/json")
      expect(names.sort()).toEqual(["content-length", "content-type", "cache-control", ...Object.keys(SECURITY)].sort())
    },
  )

  test("upstream 401 becomes 503 SWARM_UNAVAILABLE with no www-authenticate", async () => {
    for (const admission of ADMISSIONS) {
      const result = await upstream(
        stub(() => new Response("no", { status: 401, headers: hostile })).fetch,
      ).forward(admission)
      expect(result.status).toBe(503)
      expect(text(result)).toBe('{"error":"SWARM_UNAVAILABLE"}')
      expect(Object.keys(result.headers)).not.toContain("www-authenticate")
      expect(result.headers).toMatchObject(SECURITY)
    }
  })

  test("upstream 401 on the forward step (after a good ownership read) is also 503", async () => {
    const result = await upstream(stub((call, index) => (index === 0 ? ok(call) : new Response("", { status: 401 }))).fetch).forward(
      ADMISSIONS[5],
    )
    expect(result.status).toBe(503)
  })

  test("connect error and redirect rejection give 503", async () => {
    for (const admission of ADMISSIONS) {
      const result = await upstream(async () => {
        throw new TypeError("fetch failed")
      }).forward(admission)
      expect(result.status).toBe(503)
      expect(text(result)).toBe('{"error":"SWARM_UNAVAILABLE"}')
    }
  })

  test("other upstream statuses pass through with the filtered header set", async () => {
    const result = await upstream(stub(() => json({ name: "BadRequest" }, { status: 400, headers: hostile })).fetch).forward(
      ADMISSIONS[1],
    )
    expect(result.status).toBe(400)
    expect(Object.keys(result.headers)).not.toContain("access-control-allow-origin")
  })
})

describe("U-BR-12: ownership decision", () => {
  test("isOfficeSession: the owned shape passes", () => {
    expect(isOfficeSession(owned(), WORKSPACE)).toBe(true)
  })

  test.each([
    ["directory differs", owned({ directory: "/Users/someone/project" })],
    ["directory with trailing slash", owned({ directory: WORKSPACE + "/" })],
    ["origin metadata differs", owned({ metadata: { "swarm.origin": "app" } })],
    ["metadata missing", owned({ metadata: undefined })],
    ["permission missing", owned({ permission: undefined })],
    ["permission is the default (empty)", owned({ permission: [] })],
    ["permission with an allow", owned({ permission: [...OFFICE_SESSION_RULESET, { permission: "bash", pattern: "*", action: "allow" }] })],
    ["permission reordered", owned({ permission: [...OFFICE_SESSION_RULESET].reverse() })],
    ["rule with an extra key", owned({ permission: OFFICE_SESSION_RULESET.map((rule) => ({ ...rule, note: "x" })) })],
    ["rule action differs", owned({ permission: OFFICE_SESSION_RULESET.map((rule, i) => (i === 0 ? { ...rule, action: "ask" } : rule)) })],
    ["not an object", "ses"],
    ["null", null],
  ])("isOfficeSession rejects: %s", (_name, value) => {
    expect(isOfficeSession(value, WORKSPACE)).toBe(false)
  })

  const sessionRoutes = ADMISSIONS.filter((admission) => ["P4", "P5", "P6", "P7"].includes(admission.route))

  test.each(sessionRoutes.map((admission) => [admission.route, admission] as const))(
    "%s forwards for an owned session (ownership read first)",
    async (route, admission) => {
      const sidecar = stub(ok)
      const result = await upstream(sidecar.fetch).forward(admission)
      expect(result.status).toBe(route === "P6" ? 204 : 200)
      expect(new URL(sidecar.calls[0].url).pathname).toBe(`/session/${SID}`)
      expect(sidecar.calls[0].init.method).toBe("GET")
      // P4 answers from the ownership read; P5-P7 make one more call.
      expect(sidecar.calls).toHaveLength(route === "P4" ? 1 : 2)
    },
  )

  test.each(
    sessionRoutes.flatMap((admission) =>
      [
        ["directory", owned({ directory: "/elsewhere" })],
        ["origin", owned({ metadata: { "swarm.origin": "desktop" } })],
        ["ruleset", owned({ permission: [] })],
      ].map(([what, session]) => [admission.route, what, admission, session] as const),
    ),
  )("%s with a %s mismatch gives 404 and is never forwarded", async (_route, _what, admission, session) => {
    const sidecar = stub(() => json(session))
    const result = await upstream(sidecar.fetch).forward(admission)
    expect(result.status).toBe(404)
    expect(text(result)).toBe('{"error":"ROUTE_NOT_ALLOWED"}')
    expect(sidecar.calls).toHaveLength(1)
  })

  test("unknown session upstream (404) and unreadable body give 404; 5xx gives 503", async () => {
    const missing = await upstream(stub(() => json({ name: "NotFound" }, { status: 404 })).fetch).forward(ADMISSIONS[6])
    expect(missing.status).toBe(404)
    const garbled = await upstream(stub(() => new Response("{not json", { status: 200 })).fetch).forward(ADMISSIONS[6])
    expect(garbled.status).toBe(404)
    const down = await upstream(stub(() => new Response("", { status: 500 })).fetch).forward(ADMISSIONS[6])
    expect(down.status).toBe(503)
  })

  test("P3 is filtered to Office sessions only", async () => {
    const other = { ...owned({ id: "ses_zzzzzzzzzzzzzzzzzzzzzzzzzz", directory: "/Users/u/project", metadata: {} }) }
    const forged = owned({ id: "ses_yyyyyyyyyyyyyyyyyyyyyyyyyy", permission: [] })
    const sidecar = stub(() => json([owned(), other, forged]))
    const result = await upstream(sidecar.fetch).forward(ADMISSIONS[2])
    expect(result.status).toBe(200)
    const list = JSON.parse(text(result))
    expect(list.map((item: { id: string }) => item.id)).toEqual([SID])
    expect(result.kind === "buffered" && result.headers["content-length"]).toBe(String(new TextEncoder().encode(text(result)).length))
  })

  test("P3 with a non-array body gives 503", async () => {
    const result = await upstream(stub(() => json({ nope: true })).fetch).forward(ADMISSIONS[2])
    expect(result.status).toBe(503)
  })
})

describe("P8 opener for the SSE relay (M5-03 contract)", () => {
  const p8 = { ...base, route: "P8" as const, forward: { lastEventId: "9" } }

  test("GET /event?directory on the start URL, allow-listed headers, timeout disabled, signal passed", async () => {
    const sidecar = stub(ok)
    const controller = new AbortController()
    const response = await upstream(sidecar.fetch).openEvents(p8)(controller.signal)
    expect(response.status).toBe(200)
    expect(sidecar.calls).toHaveLength(1)
    const call = sidecar.calls[0]
    const url = new URL(call.url)
    expect(url.origin).toBe(SERVER)
    expect(url.pathname).toBe("/event")
    expect(Object.fromEntries(url.searchParams)).toEqual({ directory: WORKSPACE })
    expect(call.init.method).toBe("GET")
    expect(call.init.signal).toBe(controller.signal)
    expect(call.init.timeout).toBe(false)
    expect(call.init.redirect).toBe("error")
    expect(call.init.headers).toEqual({
      authorization: AUTH,
      accept: "text/event-stream",
      "accept-encoding": "identity",
      "last-event-id": "9",
    })
  })

  test("non-P8 requests carry no timeout override", () => {
    for (const admission of ADMISSIONS.filter((item) => item.route !== "P8"))
      expect(
        buildUpstreamRequest(admission, { serverUrl: SERVER, username: "opencode", password: PASSWORD, workspace: WORKSPACE })
          ?.init.timeout,
      ).toBeUndefined()
  })

  test("aborting the signal aborts the fetch", async () => {
    const seen: AbortSignal[] = []
    // Behaves like fetch: pending until the signal aborts, then rejects with the abort reason.
    const fetch: UpstreamFetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init.signal
        if (!signal) return reject(new Error("no signal"))
        seen.push(signal)
        signal.addEventListener("abort", () => reject(signal.reason), { once: true })
      })
    const controller = new AbortController()
    const pending = upstream(fetch).openEvents(p8)(controller.signal)
    controller.abort()
    await expect(pending).rejects.toHaveProperty("name", "AbortError")
    expect(seen).toHaveLength(1)
    expect(seen[0].aborted).toBe(true)
  })

  test("aborting tears down a real in-flight fetch body", async () => {
    const encoder = new TextEncoder()
    const fetch: UpstreamFetch = async (_url, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("data: {}\n\n"))
          init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true })
        },
      })
      return new Response(body, { headers: { "content-type": "text/event-stream" } })
    }
    const controller = new AbortController()
    const response = await upstream(fetch).openEvents(p8)(controller.signal)
    const reader = response.body?.getReader()
    if (!reader) throw new Error("no body")
    await reader.read()
    controller.abort()
    await expect(reader.read()).rejects.toHaveProperty("name", "AbortError")
  })

  test("rejects without calling fetch when the start URL is not the loopback sidecar", async () => {
    const sidecar = stub(ok)
    await expect(upstream(sidecar.fetch, "http://localhost:4096").openEvents(p8)(new AbortController().signal)).rejects.toThrow(
      "UPSTREAM_URL_REJECTED",
    )
    expect(sidecar.calls).toHaveLength(0)
  })
})
