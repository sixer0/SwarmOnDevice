// Row M5-05 L2, stub-upstream half: the bridge runner over real TLS in front of a stub sidecar (l2-stub-sidecar.ts) on
// 127.0.0.1:55317, for the cases a real `opencode serve` cannot produce on demand:
// - SD-AC-6 response header allow-list (the stub adds Access-Control-*, Set-Cookie, www-authenticate, X-Foo, Vary);
// - SD-AC-7 upstream request header allow-list (the stub records what it receives);
// - CP-M5 M5-F2: an upstream 5xx is `503 SWARM_UNAVAILABLE` on every proxied route, upstream body never passed;
// - SD-AC-8 teardown: the upstream event stream is closed within 1 s of a client disconnect;
// - CP-M5 M5-F1: Disconnect (`pairings-cleared`) ends the downstream stream and aborts the upstream one;
// - I-BR-16 static over the built pane (`packages/office-addin/dist/pane`), CSP literal, no secrets in served files;
// - I-BR-15 through the full runner: a squatted 47317 gives `failed {code: "PORT_IN_USE"}`.
//
// SWARM_OFFICE_IT=1 and outside the command sandbox (binds ports), under `lock:l2-ports`. Tests run in order.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { readdir, readFile } from "node:fs/promises"
import net from "node:net"
import { join, resolve } from "node:path"
import { OFFICE_PANE_CSP } from "@swarm/office-addin/constants"
import {
  L2_BRIDGE_PORT,
  L2_ENABLED,
  L2_SIDECAR_PORT,
  L2_USERNAME,
  LISTENERS,
  assertPortsFree,
  bridgeRequest,
  createRunDir,
  createTestTls,
  eventType,
  openEvents,
  probePort,
  removeRunDir,
  runPassword,
  startBridge,
  waitFor,
  type Bridge,
  type ClientRequest,
  type ClientResponse,
  type RunDir,
  type SseStream,
  type TestTls,
} from "./l2-harness"
import { STUB_EVIL_HEADERS, STUB_LEAK_BODY, startStubSidecar, type StubSidecar } from "./l2-stub-sidecar"

const PANE_DIST = resolve(import.meta.dir, "../../../office-addin/dist/pane")
/** SD §9.4 / REG rev 3 §4.1 literal, written out here so a change to the constant is caught too. */
const CSP_LITERAL =
  "default-src 'self'; script-src 'self' https://officeapis.public.onecdn.static.microsoft; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"

/** SD §9.3 headers a client may see on a non-static response, plus what node:http itself writes. */
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "cache-control",
  "x-content-type-options",
  "cross-origin-resource-policy",
  "referrer-policy",
  "content-length",
  "date",
  "connection",
  "keep-alive",
  "transfer-encoding",
])
/** Added by the runtime's fetch (Bun here; undici in Electron), never copied from the client. */
const RUNTIME_REQUEST_HEADERS = new Set(["user-agent", "connection"])

let run: RunDir | undefined
let stub: StubSidecar | undefined
let bridge: Bridge | undefined
let tls: TestTls
let password = ""
let token = ""
let sessionID = ""
const streams: SseStream[] = []
const squatters: net.Server[] = []

const call = (request: ClientRequest) => bridgeRequest(tls, request)
const authed = (request: ClientRequest) => call({ ...request, token })

async function pair() {
  const requested = await call({ method: "POST", path: "/pair/request", body: { host: "Word" } })
  expect(requested.status).toBe(202)
  const { requestId } = requested.json() as { requestId: string }
  const approved = await waitFor(
    async () => {
      const body = (await call({ path: `/pair/status?requestId=${requestId}` })).json() as { state: string; token?: string }
      return body.state === "approved" ? body : undefined
    },
    10_000,
    "pair approved",
  )
  return approved.token ?? ""
}

/** Every proxied route once (P1-P7; P8 is a stream and checked separately). */
function proxiedRoutes(id: string): ClientRequest[] {
  return [
    { path: "/swarm/global/health" },
    { method: "POST", path: "/swarm/session", body: { title: "stub", host: "Word" } },
    { path: "/swarm/session?limit=20" },
    { path: `/swarm/session/${id}` },
    { path: `/swarm/session/${id}/message?limit=50` },
    { method: "POST", path: `/swarm/session/${id}/prompt_async`, body: { parts: [{ type: "text", text: "hi" }] } },
    { method: "POST", path: `/swarm/session/${id}/abort` },
  ]
}

function leaks(response: { text: string; headers: Record<string, string | string[] | undefined> }) {
  const everything = response.text + JSON.stringify(response.headers)
  return [password, String(L2_SIDECAR_PORT), STUB_LEAK_BODY, "stub=1", "realm"].filter((secret) => everything.includes(secret))
}

function squat(host: string) {
  return new Promise<net.Server>((done, fail) => {
    const server = net.createServer()
    server.once("error", fail)
    server.listen({ host, port: L2_BRIDGE_PORT, ipv6Only: host === "::1", exclusive: true }, () => {
      squatters.push(server)
      done(server)
    })
  })
}

async function unsquat() {
  await Promise.all(squatters.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))))
}

describe.skipIf(!L2_ENABLED)("office bridge L2 over a stub sidecar (SWARM_OFFICE_IT=1; ports 47317, 55317)", () => {
  beforeAll(async () => {
    await assertPortsFree()
    run = await createRunDir()
    password = runPassword()
    tls = await createTestTls(run)
    stub = startStubSidecar(L2_SIDECAR_PORT)
    const pane = await readdir(PANE_DIST).catch((): string[] => [])
    if (!pane.includes("index.html")) throw new Error(`built pane missing at ${PANE_DIST} (run \`bun run build\` in packages/office-addin)`)
    bridge = await startBridge({ run, tls, password, paneDir: PANE_DIST })
  }, 60_000)

  afterAll(async () => {
    streams.splice(0).forEach((stream) => stream.close())
    await unsquat()
    await bridge?.stop().catch(() => {})
    await stub?.stop().catch(() => {})
    await removeRunDir(run)
    expect(await probePort("127.0.0.1", L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
    expect(await probePort("::1", L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
    expect(await probePort("127.0.0.1", L2_SIDECAR_PORT)).toBe("ECONNREFUSED")
  }, 60_000)

  // ── I-BR-16 static (AC-39; ST-22 header half) ──

  test("I-BR-16 / -> 302 /pane/index.html; built pane served with the CSP literal; served files carry no secret", async () => {
    for (const listener of LISTENERS) {
      const root = await call({ path: "/", listener, csrf: false })
      expect(root.status).toBe(302)
      expect(root.headers.location).toBe("/pane/index.html")
    }
    expect(OFFICE_PANE_CSP).toBe(CSP_LITERAL)
    const page = await call({ path: "/pane/index.html?_host_Info=Word$Mac$16.01$en-US", csrf: false })
    expect(page.status).toBe(200)
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8")
    expect(page.headers["content-security-policy"]).toBe(CSP_LITERAL)
    expect(String(page.headers["content-security-policy"])).toContain("frame-ancestors 'none'")
    expect(Object.keys(page.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])

    // Every asset the page references is served with the CSP too, and no served byte holds a token, the password or a nonce.
    const assets = [...page.text.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((match) => `/pane/${match[1]}`)
    expect(assets.length).toBeGreaterThanOrEqual(1)
    const served: ClientResponse[] = [page]
    for (const path of assets) {
      const asset = await call({ path, csrf: false, listener: "127.0.0.1" })
      expect({ path, status: asset.status }).toEqual({ path, status: 200 })
      expect(asset.headers["content-security-policy"]).toBe(CSP_LITERAL)
      served.push(asset)
    }
    // The bundle holds the token prefix as a constant ("swo1_"); a real token is the prefix plus 43 base64url characters.
    for (const response of served) {
      expect({
        token: /swo1_[A-Za-z0-9_-]{20,}/.test(response.text),
        password: response.text.includes(password),
        // The bundled SDK names the header in its parameter descriptors (`key:"x-swarm-desktop-nonce"`, as the pane's
        // lint test allows); any other mention would be the pane handling the nonce.
        nonce: /x-swarm-desktop-nonce/i.test(response.text.replaceAll('key:"x-swarm-desktop-nonce"', "")),
      }).toEqual({ token: false, password: false, nonce: false })
    }
    // Directory and traversal requests stay 404.
    for (const path of ["/pane/", "/pane/assets", "/pane/../package.json", "/pane/%2e%2e/x.js"]) {
      const answer = await call({ path, csrf: false })
      expect({ path, status: answer.status }).toEqual({ path, status: 404 })
    }
  })

  test("pair against the stub (prerequisite for the proxied cases)", async () => {
    token = await pair()
    expect(token).toMatch(/^swo1_/)
    const created = await authed({ method: "POST", path: "/swarm/session", body: { title: "stub session", host: "Word" } })
    expect(created.status).toBe(200)
    sessionID = (created.json() as { id: string }).id
    expect(sessionID).toMatch(/^ses_/)
  })

  // ── SD-AC-6: response headers (U-BR-10 over the wire) ──

  test("SD-AC-6 upstream Access-Control-*, Set-Cookie, www-authenticate, X-Foo never reach the client; no password or sidecar port", async () => {
    const evil = Object.keys(STUB_EVIL_HEADERS)
    for (const listener of LISTENERS) {
      for (const request of proxiedRoutes(sessionID)) {
        const answer = await authed({ ...request, listener })
        expect({ path: request.path, ok: answer.status < 400 }).toEqual({ path: request.path, ok: true })
        const names = Object.keys(answer.headers)
        expect({ path: request.path, extra: names.filter((name) => !ALLOWED_RESPONSE_HEADERS.has(name)) }).toEqual({
          path: request.path,
          extra: [],
        })
        for (const name of evil) expect(answer.headers[name]).toBeUndefined()
        expect(answer.headers["x-content-type-options"]).toBe("nosniff")
        expect(answer.headers["cross-origin-resource-policy"]).toBe("same-origin")
        expect(answer.headers["referrer-policy"]).toBe("no-referrer")
        expect(answer.headers["cache-control"]).toBe("no-store")
        expect({ path: request.path, leaks: leaks(answer) }).toEqual({ path: request.path, leaks: [] })
      }
      const stream = await openEvents(tls, { token, listener })
      streams.push(stream)
      expect(stream.status).toBe(200)
      expect(Object.keys(stream.headers).filter((name) => !ALLOWED_RESPONSE_HEADERS.has(name))).toEqual([])
      expect(stream.headers["content-type"]).toBe("text/event-stream")
      expect(stream.headers["cache-control"]).toBe("no-cache, no-transform")
      expect(stream.headers["content-encoding"]).toBeUndefined()
      await stream.waitFor((frame) => eventType(frame) === "server.connected", 5_000, "server.connected")
      stream.close()
    }
    // Errors from the bridge itself carry the same set.
    const refused = await authed({ path: "/swarm/config" })
    expect(refused.status).toBe(404)
    expect(Object.keys(refused.headers).filter((name) => !ALLOWED_RESPONSE_HEADERS.has(name))).toEqual([])
  }, 60_000)

  // ── SD-AC-7: upstream request headers (U-BR-09 over the wire) ──

  test("SD-AC-7 the stub receives exactly the §9.2 header set even when the client sends Cookie, Authorization, X-Foo", async () => {
    const basic = `Basic ${Buffer.from(`${L2_USERNAME}:${password}`).toString("base64")}`
    const clientHeaders = {
      cookie: "client=1",
      authorization: "Basic Y2xpZW50OnNlY3JldA==",
      "x-foo": "client",
      "user-agent": "client-agent/1",
      "x-forwarded-for": "10.0.0.1",
      accept: "application/json",
    }
    for (const request of proxiedRoutes(sessionID)) {
      const before = stub!.requests.length
      const answer = await authed({ ...request, headers: clientHeaders })
      expect({ path: request.path, ok: answer.status < 400 }).toEqual({ path: request.path, ok: true })
      const seen = stub!.requests.slice(before)
      expect(seen.length).toBeGreaterThanOrEqual(1)
      for (const upstream of seen) {
        // A bodyless POST (P7) gets `Content-Length: 0` from the runtime's fetch; that is not a client header.
        const emptyLength = (pair: [string, string]) => pair[0] === "content-length" && pair[1] === "0"
        const names = upstream.headers
          .filter((pair) => !emptyLength(pair))
          .map((pair) => pair[0])
          .filter((name) => !RUNTIME_REQUEST_HEADERS.has(name))
        const hasBody = upstream.method === "POST" && upstream.path !== `/session/${sessionID}/abort`
        const expected = ["accept", "accept-encoding", "authorization", "host", ...(hasBody ? ["content-length", "content-type"] : [])]
        expect({ path: upstream.path, names: [...new Set(names)].sort() }).toEqual({ path: upstream.path, names: expected.sort() })
        const value = (name: string) => upstream.headers.filter((pair) => pair[0] === name).map((pair) => pair[1])
        expect(value("authorization")).toEqual([basic])
        expect(value("accept-encoding")).toEqual(["identity"])
        expect(value("host")).toEqual([`127.0.0.1:${L2_SIDECAR_PORT}`])
        expect(value("user-agent")).not.toContain("client-agent/1")
        if (hasBody) expect(value("content-type")).toEqual(["application/json"])
        // Forced directory = the bridge workspace; nothing from the client's query.
        expect(upstream.query.directory).toBe(bridge!.workspace)
      }
    }
    // Last-Event-ID is the one more client header that may pass, on P8.
    const before = stub!.requests.length
    const stream = await openEvents(tls, { token, headers: { "last-event-id": "evt_1", cookie: "client=1", "x-foo": "client" } })
    streams.push(stream)
    await stream.waitFor((frame) => eventType(frame) === "server.connected", 5_000, "server.connected")
    const event = stub!.requests.slice(before).find((item) => item.path === "/event")
    expect(event).toBeDefined()
    const names = event!.headers.map((pair) => pair[0]).filter((name) => !RUNTIME_REQUEST_HEADERS.has(name))
    expect([...new Set(names)].sort()).toEqual(["accept", "accept-encoding", "authorization", "host", "last-event-id"])
    expect(event!.query).toEqual({ directory: bridge!.workspace })
    stream.close()

    // `x-opencode-*` and `x-swarm-desktop-nonce` are refused 400 before the upstream (SC-28 reject rule).
    for (const header of ["x-opencode-directory", "x-swarm-desktop-nonce"]) {
      const count = stub!.requests.length
      const answer = await authed({ path: `/swarm/session/${sessionID}`, headers: { [header]: "/" } })
      expect({ header, status: answer.status }).toEqual({ header, status: 400 })
      expect(stub!.requests.length).toBe(count)
    }
  }, 60_000)

  // ── M5-F2: upstream 5xx -> 503 on every route ──

  test("M5-F2 upstream 500/502 -> 503 SWARM_UNAVAILABLE on P1-P8, upstream body never passed; health says down", async () => {
    for (const failure of [500, 502]) {
      stub!.failWith = failure
      for (const listener of LISTENERS) {
        for (const request of proxiedRoutes(sessionID)) {
          const answer = await authed({ ...request, listener })
          expect({ failure, path: request.path, status: answer.status, body: answer.text }).toEqual({
            failure,
            path: request.path,
            status: 503,
            body: '{"error":"SWARM_UNAVAILABLE"}',
          })
          expect(leaks(answer)).toEqual([])
          expect(Object.keys(answer.headers).filter((name) => !ALLOWED_RESPONSE_HEADERS.has(name))).toEqual([])
        }
        const stream = await openEvents(tls, { token, listener })
        expect(stream.status).toBe(503)
        await waitFor(() => (stream.ended ? true : undefined), 5_000, "P8 503 body end")
        stream.close()
        const health = await call({ path: "/bridge/health", listener })
        expect(health.status).toBe(200)
        expect(health.json()).toMatchObject({ swarm: "down" })
      }
    }
    stub!.failWith = undefined
    const back = await authed({ path: `/swarm/session/${sessionID}` })
    expect(back.status).toBe(200)
  }, 60_000)

  // ── SD-AC-8 teardown ──

  test("SD-AC-8 the upstream event stream is closed within 1 s of a client disconnect (both listeners)", async () => {
    for (const listener of LISTENERS) {
      const cancels = stub!.eventCancels.length
      const stream = await openEvents(tls, { token, listener })
      await stream.waitFor((frame) => eventType(frame) === "server.connected", 5_000, "server.connected")
      await waitFor(() => (stub!.openEvents() >= 1 ? true : undefined), 2_000, "upstream open")
      const closedAt = performance.now()
      stream.close()
      await waitFor(() => (stub!.eventCancels.length > cancels ? true : undefined), 2_000, "upstream cancel")
      expect(stub!.eventCancels.at(-1)! - closedAt).toBeLessThan(1_000)
    }
    await waitFor(() => (stub!.openEvents() === 0 ? true : undefined), 2_000, "no upstream stream left")
  })

  // ── M5-F1: Disconnect ends open streams, downstream and upstream ──

  test("M5-F1 pairings-cleared ends every open event stream (client sees the end, upstream aborted); the old token is 401", async () => {
    const opened = await Promise.all(LISTENERS.map((listener) => openEvents(tls, { token, listener })))
    streams.push(...opened)
    for (const stream of opened) await stream.waitFor((frame) => eventType(frame) === "server.connected", 5_000, "connected")
    await waitFor(() => (stub!.openEvents() === 2 ? true : undefined), 2_000, "two upstream streams")
    const cancels = stub!.eventCancels.length
    const clearedAt = performance.now()
    bridge!.send({ type: "pairings-cleared" })
    await waitFor(() => (opened.every((stream) => stream.ended) ? true : undefined), 2_000, "downstream streams ended")
    await waitFor(() => (stub!.eventCancels.length >= cancels + 2 ? true : undefined), 2_000, "upstream streams aborted")
    expect(performance.now() - clearedAt).toBeLessThan(2_000)
    expect(stub!.openEvents()).toBe(0)
    const again = await openEvents(tls, { token })
    expect(again.status).toBe(401)
    again.close()
  })

  // ── I-BR-15 through the full runner (AC-05; ST-08, ST-18) ──

  test("I-BR-15 runner: squatted 127.0.0.1:47317 or [::1]:47317 -> failed PORT_IN_USE, nothing left listening", async () => {
    streams.splice(0).forEach((stream) => stream.close())
    await bridge!.stop()
    bridge = undefined
    expect(await probePort("127.0.0.1", L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
    for (const host of ["127.0.0.1", "::1"]) {
      await squat(host)
      const failed = await startBridge({ run: run!, tls, password }).then(
        (started) => {
          bridge = started
          return "started"
        },
        (error: Error) => error.message,
      )
      expect(failed).toContain('"type":"failed"')
      expect(failed).toContain("PORT_IN_USE")
      await unsquat()
      expect(await probePort("127.0.0.1", L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
      expect(await probePort("::1", L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
    }
    // The bridge log of the failed starts holds no secret either.
    const log = await readFile(join(run!.logs, "bridge.log"), "utf8").catch(() => "")
    expect(log).not.toContain(password)
    expect(log).not.toContain("swo1_")
  }, 60_000)
})
