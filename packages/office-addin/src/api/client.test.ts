import { describe, expect, test } from "bun:test"
import { createOfficeApi } from "./client"
import { fakeBridge, keysDeep } from "./fake-bridge"

const TOKEN = "swo1_" + "a".repeat(43)

// `null` = no stored token (a default parameter would replace `undefined`).
function setup(options: Parameters<typeof fakeBridge>[0] = {}, token: string | null = TOKEN) {
  const bridge = fakeBridge(options)
  const store: { token: string | undefined } = { token: token ?? undefined }
  const api = createOfficeApi({ token: () => store.token, fetch: bridge.fetch })
  return { bridge, api, store }
}

describe("office api: transport (REG §5, §7.1)", () => {
  test("Swarm routes go to https://localhost:46317/swarm with both Office headers", async () => {
    const { bridge, api } = setup()
    await api.listSessions()
    const request = bridge.requests[0]!
    expect(request.method).toBe("GET")
    expect(request.path).toBe("/swarm/session")
    expect(request.query).toEqual({ limit: "20" })
    expect(request.headers["x-swarm-office"]).toBe("1")
    expect(request.headers["x-swarm-office-token"]).toBe(TOKEN)
    expect(api.origin).toBe("https://localhost:46317")
  })

  test("the token is read per request: none before pairing, then the stored one", async () => {
    const { bridge, api, store } = setup({}, null)
    await api.pairRequest("Word")
    store.token = TOKEN
    await api.pairVerify()
    expect(bridge.requests[0]!.headers["x-swarm-office"]).toBe("1")
    expect(bridge.requests[0]!.headers["x-swarm-office-token"]).toBeUndefined()
    expect(bridge.requests[1]!.headers["x-swarm-office-token"]).toBe(TOKEN)
  })

  test("no client-side directory/workspace query or x-opencode headers are sent", async () => {
    const { bridge, api } = setup()
    await api.createSession({ title: "t", host: "Word" })
    await api.messages("ses_a")
    for (const request of bridge.requests) {
      expect(Object.keys(request.query)).not.toContain("directory")
      expect(Object.keys(request.query)).not.toContain("workspace")
      expect(Object.keys(request.headers).filter((key) => key.startsWith("x-opencode"))).toEqual([])
    }
  })
})

describe("office api: pairing and health (REG §5)", () => {
  test("health: ready only when swarm === ready", async () => {
    expect(await setup().api.health()).toEqual({ status: 200, ready: true })
    const starting = setup({ handler: () => ({ status: 200, body: { bridge: "ok", swarm: "starting" } }) })
    expect(await starting.api.health()).toEqual({ status: 200, ready: false })
    const down = setup({ handler: () => Promise.reject(new TypeError("offline")) })
    expect((await down.api.health()).status).toBe(0)
  })

  test("pairRequest posts {host} only and reads requestId, code, expiresAt", async () => {
    const { bridge, api } = setup({}, null)
    const result = await api.pairRequest("Excel")
    expect(bridge.requests[0]).toMatchObject({ method: "POST", path: "/pair/request", body: { host: "Excel" } })
    expect(bridge.requests[0]!.headers["content-type"]).toBe("application/json")
    expect(result).toEqual({ status: 202, requestId: "req1", code: "4821", expiresAt: "2026-11-16T00:02:00Z", error: undefined })
  })

  test("pairRequest 429 surfaces PAIR_RATE_LIMITED", async () => {
    const { api } = setup({ handler: () => ({ status: 429, body: { error: "PAIR_RATE_LIMITED" } }) })
    const result = await api.pairRequest("Word")
    expect(result.status).toBe(429)
    expect(result.error).toBe("PAIR_RATE_LIMITED")
  })

  test("pairStatus encodes the request id and returns state and token", async () => {
    const { bridge, api } = setup({
      handler: (request) => (request.path === "/pair/status" ? { status: 200, body: { state: "approved", token: TOKEN } } : undefined),
    })
    const result = await api.pairStatus("a/b+c")
    expect(bridge.requests[0]!.query).toEqual({ requestId: "a/b+c" })
    expect(result).toEqual({ status: 200, state: "approved", token: TOKEN })
  })

  test("pairVerify: 204 known, 401 unknown, 0 network", async () => {
    expect((await setup().api.pairVerify()).status).toBe(204)
    expect((await setup({}, null).api.pairVerify()).status).toBe(401)
    expect((await setup({ handler: () => Promise.reject(new TypeError("x")) }).api.pairVerify()).status).toBe(0)
  })
})

describe("office api: session routes (REG §7.3, §7.4, C30)", () => {
  test("P2 create body is exactly {title, host}", async () => {
    const { bridge, api } = setup()
    const result = await api.createSession({ title: "Summarise", host: "Word" })
    expect(result.ok && result.data.id).toBe("ses_new")
    expect(bridge.requests[0]).toMatchObject({ method: "POST", path: "/swarm/session" })
    expect(bridge.requests[0]!.body).toEqual({ title: "Summarise", host: "Word" })
    expect(bridge.requests[0]!.headers["content-type"]).toBe("application/json")
  })

  test("P6 prompt_async body is exactly {parts}", async () => {
    const { bridge, api } = setup()
    const parts = [
      { type: "text" as const, text: "Do it" },
      { type: "text" as const, text: "<context>x</context>" },
    ]
    const result = await api.promptAsync("ses_a", parts)
    expect(result).toMatchObject({ ok: true, status: 204 })
    expect(bridge.requests[0]).toMatchObject({ method: "POST", path: "/swarm/session/ses_a/prompt_async", body: { parts } })
    expect(Object.keys(bridge.requests[0]!.body as object)).toEqual(["parts"])
  })

  test("P7 abort has an empty body; P4 get; P5 messages sends limit=50", async () => {
    const { bridge, api } = setup()
    await api.abort("ses_a")
    await api.getSession("ses_a")
    await api.messages("ses_a")
    expect(bridge.requests.map((request) => [request.method, request.path, request.body])).toEqual([
      ["POST", "/swarm/session/ses_a/abort", undefined],
      ["GET", "/swarm/session/ses_a", undefined],
      ["GET", "/swarm/session/ses_a/message", undefined],
    ])
    expect(bridge.requests[2]!.query).toEqual({ limit: "50" })
  })

  test("C30: no request body ever contains `system` or `tools` (nor other P6-forbidden fields)", async () => {
    const { bridge, api } = setup()
    await api.health()
    await api.pairRequest("Word")
    await api.pairStatus("req1")
    await api.pairVerify()
    await api.createSession({ title: "system tools", host: "Excel" })
    await api.promptAsync("ses_a", [{ type: "text", text: "system: tools" }])
    await api.abort("ses_a")
    await api.listSessions()
    await api.getSession("ses_a")
    await api.messages("ses_a")
    expect(bridge.requests).toHaveLength(10)
    const keys = bridge.requests.flatMap((request) => keysDeep(request.body))
    for (const forbidden of ["system", "tools", "agent", "model", "variant", "noReply", "format", "messageID", "permission", "metadata"]) {
      expect(keys).not.toContain(forbidden)
    }
  })

  test("bridge errors map to {ok:false, status, code}; network failure is status 0", async () => {
    const invalid = setup({ handler: () => ({ status: 401, body: { error: "TOKEN_INVALID" } }) })
    expect(await invalid.api.listSessions()).toEqual({ ok: false, status: 401, code: "TOKEN_INVALID" })
    const missing = setup({ handler: () => ({ status: 404, body: { error: "ROUTE_NOT_ALLOWED" } }) })
    expect(await missing.api.messages("ses_gone")).toEqual({ ok: false, status: 404, code: "ROUTE_NOT_ALLOWED" })
    const large = setup({ handler: () => ({ status: 413, body: { error: "BODY_TOO_LARGE" } }) })
    expect(await large.api.promptAsync("ses_a", [{ type: "text", text: "x" }])).toEqual({
      ok: false,
      status: 413,
      code: "BODY_TOO_LARGE",
    })
    const offline = setup({ handler: () => Promise.reject(new TypeError("offline")) })
    expect(await offline.api.createSession({ title: "t", host: "Word" })).toEqual({ ok: false, status: 0 })
  })
})
