// Row M5-04: L2 bridge integration, I-BR-01..I-BR-07 (test strategy §7.1/§7.2), plus the row's end-to-end checks
// (prompt streams text via P8, `tools`/`system` refused 400, PATCH /session blocked, abort), the C39 directory-compare
// check against a real `opencode serve`, and a cheap SD-1 probe (I-BR-20 proper is M6-02).
//
// Real processes: `opencode serve` (55317), scripted LLM (55318), the bridge runner with the composed routes (47317,
// 127.0.0.1 + ::1) and a test CA. Runs only with SWARM_OFFICE_IT=1 and outside the command sandbox (binds ports),
// under `lock:l2-ports`. Tests in this file share one sidecar and run in declaration order; the order matters for the
// pairing rate window (5 accepted per 60 s per bridge start) and for I-BR-06's `pairings-cleared`, which runs last.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, realpath, symlink } from "node:fs/promises"
import { join } from "node:path"
import { OFFICE_SESSION_RULESET } from "@swarm/office-addin/constants"
import {
  L2_BRIDGE_PORT,
  L2_ENABLED,
  LISTENERS,
  assertPortsFree,
  bridgeRequest,
  createRunDir,
  createTestTls,
  eventProps,
  eventType,
  isIdle,
  openEvents,
  probePort,
  removeRunDir,
  runPassword,
  runTool,
  startBridge,
  startSidecar,
  waitFor,
  type Bridge,
  type ClientRequest,
  type RunDir,
  type Sidecar,
  type SseStream,
  type TestTls,
} from "./l2-harness"
import { mentions, startScriptedLlm, systemText, type ScriptedLlm } from "./l2-scripted-llm"

const OFFICE_METADATA = { "swarm.origin": "office-addin", "swarm.office.host": "Word" }

let run: RunDir | undefined
let llm: ScriptedLlm | undefined
let sidecar: Sidecar | undefined
let bridge: Bridge | undefined
let tls: TestTls
let password = ""
let token = ""
let sessionID = ""
const streams: SseStream[] = []

const call = (request: ClientRequest) => bridgeRequest(tls, request)
const authed = (request: ClientRequest) => call({ ...request, token })

/** Pairs through the bridge (auto-allow) and returns the token. */
async function pair(host: "Word" | "Excel" = "Word") {
  const requested = await call({ method: "POST", path: "/pair/request", body: { host } })
  expect(requested.status).toBe(202)
  const { requestId } = requested.json() as { requestId: string }
  const approved = await waitFor(
    async () => {
      const status = await call({ path: `/pair/status?requestId=${requestId}` })
      const body = status.json() as { state: string; token?: string }
      return body.state === "approved" ? body : undefined
    },
    10_000,
    "pair approved",
  )
  return approved.token ?? ""
}

/** The session as the sidecar stores it, read directly (Basic auth), bypassing the bridge. */
async function upstreamSession(id: string, directory: string) {
  const response = await sidecar!.call(`/session/${id}?directory=${encodeURIComponent(directory)}`)
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

async function stopEverything() {
  streams.splice(0).forEach((stream) => stream.close())
  await bridge?.stop().catch(() => {})
  bridge = undefined
  await sidecar?.stop().catch(() => {})
  sidecar = undefined
  await llm?.stop().catch(() => {})
  llm = undefined
}

describe.skipIf(!L2_ENABLED)("office bridge L2 (SWARM_OFFICE_IT=1; ports 47317, 55317, 55318)", () => {
  beforeAll(async () => {
    await assertPortsFree()
    run = await createRunDir()
    password = runPassword()
    tls = await createTestTls(run)
    llm = startScriptedLlm()
    sidecar = await startSidecar({ run, password, llmUrl: llm.url })
    bridge = await startBridge({ run, tls, password })
  }, 150_000)

  afterAll(async () => {
    await stopEverything()
    await removeRunDir(run)
    // Leftover check (strategy §7.1): nothing listens on the bridge port after the suite.
    expect(await probePort("127.0.0.1", L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
    expect(await probePort("::1", L2_BRIDGE_PORT)).toBe("ECONNREFUSED")
  }, 60_000)

  // ── I-BR-04 pairing end to end (AC-07, AC-08, AC-09) ──

  test("I-BR-04 pairing round trip: 202 + code, pair-request to main, allow, token once then consumed, verify 204", async () => {
    const requested = await call({ method: "POST", path: "/pair/request", body: { host: "Word" } })
    expect(requested.status).toBe(202)
    expect(requested.headers["cache-control"]).toBe("no-store")
    const body = requested.json() as { requestId: string; code: string; expiresAt: string }
    expect(body.code).toMatch(/^[0-9]{4}$/)
    const seen = bridge!.pairRequests.at(-1)
    expect(seen).toEqual({ requestId: body.requestId, host: "Word", code: body.code })

    const first = await waitFor(
      async () => {
        const status = await call({ path: `/pair/status?requestId=${body.requestId}` })
        const parsed = status.json() as { state: string; token?: string }
        return parsed.state === "pending" ? undefined : { status, parsed }
      },
      10_000,
      "pair decision",
    )
    expect(first.status.status).toBe(200)
    expect(first.status.headers["cache-control"]).toBe("no-store")
    expect(first.parsed.state).toBe("approved")
    expect(first.parsed.token).toMatch(/^swo1_/)
    token = first.parsed.token ?? ""

    const again = await call({ path: `/pair/status?requestId=${body.requestId}` })
    expect(again.json()).toEqual({ state: "consumed" })

    for (const listener of LISTENERS) {
      const verified = await call({ path: "/pair/verify", token, listener })
      expect(verified.status).toBe(204)
      expect(verified.text).toBe("")
    }
  })

  test("I-BR-04 deny path: denied, no token", async () => {
    bridge!.decisions = "deny"
    const requested = await call({ method: "POST", path: "/pair/request", body: { host: "Excel" }, listener: "127.0.0.1" })
    expect(requested.status).toBe(202)
    const { requestId } = requested.json() as { requestId: string }
    const final = await waitFor(
      async () => {
        const parsed = (await call({ path: `/pair/status?requestId=${requestId}` })).json() as { state: string; token?: string }
        return parsed.state === "pending" ? undefined : parsed
      },
      10_000,
      "pair denied",
    )
    expect(final).toEqual({ state: "denied" })
    bridge!.decisions = "allow"
  })

  // ── I-BR-02 Host/Origin/CSRF matrix on both listeners (AC-38; ST-02, ST-05, ST-18) ──

  test("I-BR-02 Host/Origin/CSRF/token matrix: identical answers on 127.0.0.1 and ::1, no Access-Control-*", async () => {
    const cases: { name: string; request: ClientRequest; status: number; error: string }[] = [
      { name: "foreign Host", request: { path: "/swarm/session", host: `evil.example:${L2_BRIDGE_PORT}` }, status: 421, error: "HOST_REJECTED" },
      { name: "[::1] Host", request: { path: "/swarm/session", host: `[::1]:${L2_BRIDGE_PORT}` }, status: 421, error: "HOST_REJECTED" },
      { name: "production-port Host", request: { path: "/swarm/session", host: "localhost:46317" }, status: 421, error: "HOST_REJECTED" },
      { name: "foreign Host on static", request: { path: "/pane/index.html", host: "evil.example" }, status: 421, error: "HOST_REJECTED" },
      { name: "foreign Origin", request: { path: "/swarm/session", headers: { origin: "https://evil.example" } }, status: 403, error: "ORIGIN_REJECTED" },
      { name: "http Origin", request: { path: "/swarm/session", headers: { origin: `http://localhost:${L2_BRIDGE_PORT}` } }, status: 403, error: "ORIGIN_REJECTED" },
      { name: "null Origin", request: { path: "/swarm/session", headers: { origin: "null" } }, status: 403, error: "ORIGIN_REJECTED" },
      { name: "foreign Origin on static", request: { path: "/pane/index.html", headers: { origin: "https://evil.example" } }, status: 403, error: "ORIGIN_REJECTED" },
      { name: "OPTIONS preflight", request: { method: "OPTIONS", path: "/swarm/session", headers: { origin: `https://localhost:${L2_BRIDGE_PORT}`, "access-control-request-method": "POST" } }, status: 403, error: "ORIGIN_REJECTED" },
      { name: "no X-Swarm-Office", request: { path: "/swarm/session", csrf: false }, status: 403, error: "CSRF_HEADER_MISSING" },
      { name: "no X-Swarm-Office on pairing", request: { method: "POST", path: "/pair/request", csrf: false, body: { host: "Word" } }, status: 403, error: "CSRF_HEADER_MISSING" },
      { name: "no token", request: { path: "/swarm/session" }, status: 401, error: "TOKEN_INVALID" },
    ]
    for (const item of cases) {
      const answers = await Promise.all(LISTENERS.map((listener) => call({ ...item.request, listener })))
      for (const answer of answers) {
        expect({ name: item.name, status: answer.status, body: answer.json() }).toEqual({
          name: item.name,
          status: item.status,
          body: { error: item.error },
        })
        expect(Object.keys(answer.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])
      }
      expect(answers[0]!.text).toBe(answers[1]!.text)
    }
    // No pair-request reached main from the CSRF-less pairing call.
    expect(bridge!.pairRequests.length).toBe(2)

    // No Host header at all: Bun's node:https always adds one, so this case is sent by curl (`-H "Host:"` removes it).
    // HTTP/1.1 without Host is refused by node:http itself (`requireHostHeader`, 400 + close) before the pipeline runs;
    // admit's own 421 for a missing Host is reachable over HTTP/1.0, where Host is optional.
    const curl = Bun.which("curl")
    if (!curl) throw new Error("curl not found")
    for (const base of [`https://127.0.0.1:${L2_BRIDGE_PORT}`, `https://[::1]:${L2_BRIDGE_PORT}`]) {
      const args = ["-s", "-i", "--cacert", tls.caPath, "-H", "Host:", "-H", "X-Swarm-Office: 1", `${base}/swarm/session`]
      const http11 = await runTool([curl, ...args])
      expect(http11.exit).toBe(0)
      expect(http11.out).toMatch(/^HTTP\/1\.1 400 /)
      expect(http11.out.toLowerCase()).not.toContain("access-control-")
      const http10 = await runTool([curl, "--http1.0", ...args])
      expect(http10.exit).toBe(0)
      expect(http10.out).toMatch(/^HTTP\/1\.[01] 421 /)
      expect(http10.out).toContain('{"error":"HOST_REJECTED"}')
      expect(http10.out.toLowerCase()).not.toContain("access-control-")
    }
  })

  // ── I-BR-03 transport (AC-38; ST-05, ST-16) ──

  test("I-BR-03 plain HTTP gets no HTTP response, TLS 1.1 fails, a foreign name fails verification; the CA chain verifies for localhost", async () => {
    const curl = Bun.which("curl")
    if (!curl) throw new Error("curl not found")
    const plain = await runTool([curl, "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", `http://127.0.0.1:${L2_BRIDGE_PORT}/`])
    expect(plain.out).toBe("000")
    expect(plain.exit).not.toBe(0)

    const old = await runTool([curl, "-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", tls.caPath, "--tlsv1.0", "--tls-max", "1.1", `https://localhost:${L2_BRIDGE_PORT}/bridge/health`])
    expect(old.exit).not.toBe(0)
    const openssl = Bun.which("openssl")
    if (openssl) {
      const s11 = await runTool([openssl, "s_client", "-connect", `127.0.0.1:${L2_BRIDGE_PORT}`, "-tls1_1", "-servername", "localhost"])
      expect(s11.exit).not.toBe(0)
    }

    const evil = await runTool([curl, "-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", tls.caPath, "--resolve", `evil.example:${L2_BRIDGE_PORT}:127.0.0.1`, `https://evil.example:${L2_BRIDGE_PORT}/`])
    expect(evil.out).toBe("000")
    expect([51, 60]).toContain(evil.exit)

    // Positive control: the same CA verifies the leaf for localhost (so the failures above are the name / version).
    const good = await runTool([curl, "-s", "-o", "/dev/null", "-w", "%{http_code}", "--cacert", tls.caPath, "-H", "X-Swarm-Office: 1", `https://localhost:${L2_BRIDGE_PORT}/bridge/health`])
    expect(good).toMatchObject({ exit: 0, out: "200" })
  })

  // ── I-BR-07 session create (AC-14; ST-20) ──

  test("I-BR-07 P2 through the bridge forces deny-all + Office metadata; the sidecar stores them", async () => {
    const workspace = bridge!.workspace
    const created = await authed({ method: "POST", path: "/swarm/session", body: { title: "L2 Word session", host: "Word" } })
    expect(created.status).toBe(200)
    expect(created.headers["set-cookie"]).toBeUndefined()
    expect(created.headers["www-authenticate"]).toBeUndefined()
    const session = created.json() as { id: string }
    expect(session.id).toMatch(/^ses_/)
    sessionID = session.id

    const stored = await upstreamSession(sessionID, workspace)
    expect(stored.permission).toEqual(OFFICE_SESSION_RULESET)
    expect(stored.metadata).toEqual(OFFICE_METADATA)
    expect(stored.title).toBe("L2 Word session")
    // C39: the bridge compares `directory` by exact string. Here userData is already realpathed, so they must match.
    expect(stored.directory).toBe(workspace)

    // P4 through the bridge passes the ownership check and returns the same session.
    const read = await authed({ path: `/swarm/session/${sessionID}`, listener: "127.0.0.1" })
    expect(read.status).toBe(200)
    expect((read.json() as { id: string }).id).toBe(sessionID)
  })

  test("I-BR-07 a client-supplied permission, metadata or directory on P2 is refused 400 before the sidecar", async () => {
    const before = await sidecar!.call(`/session?directory=${encodeURIComponent(bridge!.workspace)}`).then((r) => r.json() as Promise<unknown[]>)
    for (const body of [
      { title: "x", host: "Word", permission: [{ permission: "*", pattern: "*", action: "allow" }] },
      { title: "x", host: "Word", metadata: { "swarm.origin": "other" } },
      { title: "x", host: "Word", directory: "/" },
    ]) {
      const answer = await authed({ method: "POST", path: "/swarm/session", body })
      expect(answer.status).toBe(400)
      expect(answer.json()).toEqual({ error: "FIELD_NOT_ALLOWED" })
    }
    const query = await authed({ method: "POST", path: "/swarm/session?directory=/", body: { title: "x", host: "Word" } })
    expect(query.status).toBe(400)
    const after = await sidecar!.call(`/session?directory=${encodeURIComponent(bridge!.workspace)}`).then((r) => r.json() as Promise<unknown[]>)
    expect(after.length).toBe(before.length)
  })

  // ── Prompt through P6, text streamed back through P8 ──

  test("P6 prompt streams text back through P8 (message.part.delta text frames, then idle)", async () => {
    llm!.reply = { chunks: ["Alpha ", "beta ", "gamma ", "delta ", "done"], delayMs: 100 }
    const stream = await openEvents(tls, { token })
    streams.push(stream)
    expect(stream.status).toBe(200)
    expect(stream.headers["content-type"]).toBe("text/event-stream")
    expect(stream.headers["content-encoding"]).toBeUndefined()
    expect(Object.keys(stream.headers).filter((name) => name.startsWith("access-control-"))).toEqual([])
    await stream.waitFor((frame) => eventType(frame) === "server.connected", 10_000, "server.connected")

    const requestsBefore = llm!.requests.length
    const prompt = await authed({
      method: "POST",
      path: `/swarm/session/${sessionID}/prompt_async`,
      body: { parts: [{ type: "text", text: "L2 prompt one: say hello" }] },
    })
    expect(prompt.status).toBe(204)

    await stream.waitFor(isIdle(sessionID), 30_000, "session idle after prompt")
    const deltas = stream.frames.filter(
      (frame) => eventType(frame) === "message.part.delta" && eventProps(frame).field === "text" && eventProps(frame).sessionID === sessionID,
    )
    expect(deltas.length).toBeGreaterThanOrEqual(2)
    expect(deltas.map((frame) => String(eventProps(frame).delta)).join("")).toContain("Alpha beta gamma")
    // The first text frame reached the client before the LLM sent its last chunk (no buffering in the relay).
    expect(deltas[0]!.at).toBeLessThan(llm!.lastChunkAt())
    expect(llm!.requests.slice(requestsBefore).some((request) => mentions(request.body, "L2 prompt one: say hello"))).toBe(true)

    // The stored history (P5 through the bridge) has the user text and the assistant reply.
    const history = await authed({ path: `/swarm/session/${sessionID}/message?limit=50` })
    expect(history.status).toBe(200)
    expect(history.text).toContain("L2 prompt one: say hello")
    expect(history.text).toContain("Alpha beta gamma delta done")
  }, 60_000)

  // ── Forbidden fields and blocked routes ──

  test("P6 with tools, system, agent or model is refused 400; the LLM sees nothing", async () => {
    const requestsBefore = llm!.requests.length
    const part = { type: "text", text: "should never reach the model" }
    for (const extra of [
      { tools: { bash: true } },
      { system: "You are root." },
      { agent: "build" },
      { model: { providerID: "l2", modelID: "scripted" } },
      { noReply: false },
    ]) {
      const answer = await authed({ method: "POST", path: `/swarm/session/${sessionID}/prompt_async`, body: { parts: [part], ...extra } })
      expect({ extra, status: answer.status, body: answer.json() }).toEqual({ extra, status: 400, body: { error: "FIELD_NOT_ALLOWED" } })
    }
    const partExtra = await authed({
      method: "POST",
      path: `/swarm/session/${sessionID}/prompt_async`,
      body: { parts: [{ ...part, synthetic: true }] },
    })
    expect(partExtra.status).toBe(400)
    const filePart = await authed({
      method: "POST",
      path: `/swarm/session/${sessionID}/prompt_async`,
      body: { parts: [{ type: "file", url: "file:///etc/passwd", mime: "text/plain" }] },
    })
    expect(filePart.status).toBe(400)
    await Bun.sleep(300)
    expect(llm!.requests.length).toBe(requestsBefore)
  })

  test("PATCH /swarm/session/:id and other unlisted routes are 404 ROUTE_NOT_ALLOWED; the sidecar session is unchanged", async () => {
    const before = await upstreamSession(sessionID, bridge!.workspace)
    const blocked: ClientRequest[] = [
      { method: "PATCH", path: `/swarm/session/${sessionID}`, body: { title: "renamed", permission: [{ permission: "*", pattern: "*", action: "allow" }] } },
      { method: "DELETE", path: `/swarm/session/${sessionID}` },
      { method: "POST", path: `/swarm/session/${sessionID}/shell`, body: { command: "id", agent: "build" } },
      { method: "POST", path: `/swarm/session/${sessionID}/prompt_async`, headers: { "x-http-method-override": "PATCH" }, body: { parts: [{ type: "text", text: "x" }] } },
      { path: "/swarm/config" },
      { path: "/swarm/global/event" },
    ]
    for (const request of blocked) {
      const answer = await authed(request)
      expect({ path: request.path, method: request.method, status: answer.status, body: answer.json() }).toEqual({
        path: request.path,
        method: request.method,
        status: 404,
        body: { error: "ROUTE_NOT_ALLOWED" },
      })
    }
    const after = await upstreamSession(sessionID, bridge!.workspace)
    expect(after.title).toBe(before.title)
    expect(after.permission).toEqual(OFFICE_SESSION_RULESET)
  })

  // ── Abort through P7 ──

  test("P7 abort during streaming: idle within 2 s, partial text kept", async () => {
    llm!.reply = { chunks: Array.from({ length: 40 }, (_, index) => `w${index} `), delayMs: 150 }
    const stream = await openEvents(tls, { token, listener: "127.0.0.1" })
    streams.push(stream)
    await stream.waitFor((frame) => eventType(frame) === "server.connected", 10_000, "server.connected")
    const prompt = await authed({
      method: "POST",
      path: `/swarm/session/${sessionID}/prompt_async`,
      body: { parts: [{ type: "text", text: "L2 prompt two: long answer" }] },
    })
    expect(prompt.status).toBe(204)
    const firstDeltaIndex = stream.frames.length
    await stream.waitFor(
      (frame) =>
        stream.frames.indexOf(frame) >= firstDeltaIndex &&
        eventType(frame) === "message.part.delta" &&
        eventProps(frame).sessionID === sessionID &&
        String(eventProps(frame).delta).includes("w2"),
      20_000,
      "third streamed chunk",
    )
    const idleBefore = stream.frames.length
    const aborted = await authed({ method: "POST", path: `/swarm/session/${sessionID}/abort` })
    expect(aborted.status).toBe(200)
    const abortedAt = performance.now()
    const idle = await stream.waitFor((frame) => stream.frames.indexOf(frame) >= idleBefore && isIdle(sessionID)(frame), 2_000, "idle after abort")
    expect(idle.at - abortedAt).toBeLessThan(2_000)

    const history = await authed({ path: `/swarm/session/${sessionID}/message` })
    expect(history.text).toContain("w0 w1 w2")
    expect(history.text).not.toContain("w39")
    stream.close()
  }, 60_000)

  // ── SD-1 probe (cheap I-BR-20 precursor; the full test is M6-02 sd1-profile.test.ts) ──

  test("SD-1 probe: the Office session's provider request has the date line and no workspace path; a direct non-Office session has the path", async () => {
    const office = llm!.requests.find((request) => mentions(request.body, "L2 prompt one: say hello"))
    expect(office).toBeDefined()
    const officeSystem = systemText(office!.body)
    expect(officeSystem).toContain(`Today's date: ${new Date().toDateString()}`)
    expect(officeSystem).not.toContain(bridge!.workspace)
    expect(officeSystem).not.toContain("<gsp_workflow>")
    expect(officeSystem).not.toContain("<env>")

    llm!.reply = { chunks: ["ok"], delayMs: 10 }
    const directory = bridge!.workspace
    const created = await sidecar!.call(`/session?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "L2 control" }),
    })
    expect(created.status).toBe(200)
    const control = (await created.json()) as { id: string }
    const prompted = await sidecar!.call(`/session/${control.id}/prompt_async?directory=${encodeURIComponent(directory)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: "L2 control prompt" }] }),
    })
    expect(prompted.status).toBe(204)
    const recorded = await waitFor(() => llm!.requests.find((request) => mentions(request.body, "L2 control prompt")), 20_000, "control request")
    expect(systemText(recorded.body)).toContain(directory)

    // The control session is not an Office session: the bridge hides it (ownership, stage 14).
    const hidden = await authed({ path: `/swarm/session/${control.id}` })
    expect(hidden.status).toBe(404)
    await sidecar!.call(`/session/${control.id}/abort?directory=${encodeURIComponent(directory)}`, { method: "POST" })
  }, 60_000)

  // ── I-BR-01 health across a sidecar restart (AC-13) ──

  test("I-BR-01 health ready -> sidecar killed: down + 503 -> restarted: ready, same token works", async () => {
    streams.splice(0).forEach((stream) => stream.close())
    const ready = await call({ path: "/bridge/health" })
    expect(ready.status).toBe(200)
    expect(ready.json()).toMatchObject({ swarm: "ready" })

    await sidecar!.stop()
    sidecar = undefined
    const down = await call({ path: "/bridge/health", listener: "127.0.0.1" })
    expect(down.status).toBe(200)
    expect(down.json()).toMatchObject({ swarm: "down" })
    const unavailable = await authed({ path: "/swarm/session" })
    expect(unavailable.status).toBe(503)
    expect(unavailable.json()).toEqual({ error: "SWARM_UNAVAILABLE" })

    sidecar = await startSidecar({ run: run!, password, llmUrl: llm!.url })
    const back = await waitFor(
      async () => {
        const health = (await call({ path: "/bridge/health" })).json() as { swarm: string }
        return health.swarm === "ready" ? health : undefined
      },
      15_000,
      "health ready again",
    )
    expect(back.swarm).toBe("ready")
    const list = await authed({ path: "/swarm/session?limit=20" })
    expect(list.status).toBe(200)
    expect((list.json() as { id: string }[]).map((session) => session.id)).toContain(sessionID)
  }, 150_000)

  // ── I-BR-05 rate limit (AC-07) ──

  test("I-BR-05 a second pending request gets 429; the sixth accepted request in 60 s gets 429", async () => {
    // Accepted so far in this bridge start: I-BR-04 allow + deny = 2.
    bridge!.decisions = "manual"
    const pending = await call({ method: "POST", path: "/pair/request", body: { host: "Word" } })
    expect(pending.status).toBe(202)
    const second = await call({ method: "POST", path: "/pair/request", body: { host: "Excel" }, listener: "127.0.0.1" })
    expect(second.status).toBe(429)
    expect(second.json()).toEqual({ error: "PAIR_RATE_LIMITED" })
    const { requestId } = pending.json() as { requestId: string }
    bridge!.send({ type: "pair-decision", requestId, allow: false })
    await waitFor(
      async () => ((await call({ path: `/pair/status?requestId=${requestId}` })).json() as { state: string }).state === "denied" || undefined,
      5_000,
      "manual deny",
    )

    bridge!.decisions = "deny"
    // Accepted: 3. Two more fill the window (5), the next is refused.
    for (const _ of [1, 2]) {
      const accepted = await call({ method: "POST", path: "/pair/request", body: { host: "Word" } })
      expect(accepted.status).toBe(202)
      const id = (accepted.json() as { requestId: string }).requestId
      await waitFor(
        async () => ((await call({ path: `/pair/status?requestId=${id}` })).json() as { state: string }).state === "denied" || undefined,
        5_000,
        "auto deny",
      )
    }
    const sixth = await call({ method: "POST", path: "/pair/request", body: { host: "Word" } })
    expect(sixth.status).toBe(429)
    expect(sixth.json()).toEqual({ error: "PAIR_RATE_LIMITED" })
    bridge!.decisions = "allow"
  }, 30_000)

  // ── I-BR-06 tokens (AC-12, AC-39); runs after everything that needs the token ──

  test("I-BR-06 no or wrong token 401; valid token 200; after pairings-cleared the old token is 401", async () => {
    for (const listener of LISTENERS) {
      const none = await call({ path: "/swarm/session", listener })
      expect(none.status).toBe(401)
      expect(none.json()).toEqual({ error: "TOKEN_INVALID" })
      const wrong = await call({ path: "/swarm/session", listener, token: `swo1_${"A".repeat(43)}` })
      expect(wrong.status).toBe(401)
      const valid = await authed({ path: "/swarm/session", listener })
      expect(valid.status).toBe(200)
    }
    bridge!.send({ type: "pairings-cleared" })
    await waitFor(async () => ((await authed({ path: "/swarm/session" })).status === 401 ? true : undefined), 5_000, "token revoked")
    for (const listener of LISTENERS) {
      const revoked = await authed({ path: "/swarm/session", listener })
      expect(revoked.status).toBe(401)
      const verify = await authed({ path: "/pair/verify", listener })
      expect(verify.status).toBe(401)
    }
  })

  // ── C39: exact-string `directory` compare vs a real opencode serve ──

  test("C39 finding: the sidecar stores the realpath of `directory`, not the string the bridge sent", async () => {
    // Bridge restarted on a userData path that goes through a symlink (as macOS $TMPDIR does: /var -> /private/var).
    await bridge!.stop()
    const real = join(run!.root, "userData-real")
    const link = join(run!.root, "userData-link")
    await mkdir(real, { recursive: true })
    await symlink(real, link)
    bridge = await startBridge({ run: run!, tls, password, userDataDir: link })
    token = await pair()
    const created = await authed({ method: "POST", path: "/swarm/session", body: { title: "C39", host: "Word" } })
    expect(created.status).toBe(200)
    const id = (created.json() as { id: string }).id
    sessionID = id
    const stored = await upstreamSession(id, bridge.workspace)
    expect(bridge.workspace).toBe(join(link, "office-addin", "workspace"))
    expect(stored.directory).toBe(await realpath(bridge.workspace))
    expect(stored.directory).not.toBe(bridge.workspace)
  }, 60_000)

  // C39 defect fixed by M2-01c (C54): the bridge resolves the workspace with realpath at start, so the forced
  // `?directory=` and the ownership compare use the form the sidecar stores.
  test("C39 desired: P4 on the bridge's own session under a symlinked userData answers 200", async () => {
    const read = await authed({ path: `/swarm/session/${sessionID}` })
    expect(read.status).toBe(200)
  })
})
