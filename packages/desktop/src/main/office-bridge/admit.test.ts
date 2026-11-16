// Unit tests for admit() (row 58, plan M5-01): U-BR-01..U-BR-08, U-BR-11 and the ST-14 table (security spec).
import { describe, expect, test } from "bun:test"
import { admit, headerPairs, type AdmitRequest } from "./admit"

const PORT = 46317
const TOKEN = "swo1_" + "a".repeat(43)
const SID = "ses_0123456789abABCDEFGHIJKLMN"

const verified: string[] = []
const config = {
  port: PORT,
  verifyToken: (token: string) => {
    verified.push(token)
    return token === TOKEN ? ("Word" as const) : undefined
  },
}

type Opts = {
  method?: string
  headers?: Record<string, string>
  omit?: string[]
  extra?: [string, string][]
  body?: unknown
  raw?: string
}

/** A well-formed pane request; `omit` removes default headers, `extra` appends (duplicates allowed). */
function req(target: string, opts: Opts = {}): AdmitRequest {
  const text = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body))
  const defaults: Record<string, string> = {
    host: `localhost:${PORT}`,
    origin: `https://localhost:${PORT}`,
    "x-swarm-office": "1",
    "x-swarm-office-token": TOKEN,
    ...(text === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(text)) }),
    ...opts.headers,
  }
  const headers = Object.entries(defaults)
    .filter((pair) => !(opts.omit ?? []).includes(pair[0]))
    .map((pair) => [pair[0], pair[1]] as const)
  return {
    method: opts.method ?? (text === undefined ? "GET" : "POST"),
    target,
    headers: [...headers, ...(opts.extra ?? [])],
    body: text === undefined ? undefined : new TextEncoder().encode(text),
  }
}

const code = async (request: AdmitRequest) => {
  const result = await admit(request, config)
  return result.kind === "reject" ? `${result.status} ${result.code}` : `${result.kind}`
}

describe("U-BR-01 Host", () => {
  test("accepted values", async () => {
    expect(await code(req("/swarm/global/health"))).toBe("proxy")
    expect(await code(req("/swarm/global/health", { headers: { host: `127.0.0.1:${PORT}` } }))).toBe("proxy")
  })
  test.each(["evil.example", "localhost", "localhost:46318", "[::1]:46317", "", "LOCALHOST:46317"])("rejects %p", async (host) => {
    expect(await code(req("/swarm/global/health", { headers: { host } }))).toBe("421 HOST_REJECTED")
  })
  test("missing or duplicate Host", async () => {
    expect(await code(req("/", { omit: ["host"] }))).toBe("421 HOST_REJECTED")
    expect(await code(req("/", { extra: [["Host", "evil.example"]] }))).toBe("421 HOST_REJECTED")
  })
  test("Host is checked before OPTIONS and Origin", async () => {
    expect(await code(req("/", { method: "OPTIONS", headers: { host: "evil.example", origin: "null" } }))).toBe(
      "421 HOST_REJECTED",
    )
  })
})

describe("U-BR-02 Origin and OPTIONS", () => {
  test("absent or exact origin passes", async () => {
    expect(await code(req("/swarm/global/health", { omit: ["origin"] }))).toBe("proxy")
  })
  test.each(["null", "http://localhost:46317", "https://localhost:46317.evil", "https://127.0.0.1:46317", "https://evil.example"])(
    "rejects origin %p",
    async (origin) => {
      expect(await code(req("/swarm/global/health", { headers: { origin } }))).toBe("403 ORIGIN_REJECTED")
    },
  )
  test.each(["/", "/pane/index.html", "/swarm/session", "/pair/request", "/bridge/health", "/nope"])("OPTIONS %p", async (path) => {
    expect(await code(req(path, { method: "OPTIONS" }))).toBe("403 ORIGIN_REJECTED")
  })
})

describe("static branch", () => {
  test("root redirects, pane files pass through without CSRF or token", async () => {
    expect(await admit(req("/", { omit: ["x-swarm-office", "x-swarm-office-token"] }), config)).toEqual({
      kind: "static",
      action: "redirect",
      location: "/pane/index.html",
    })
    expect(await admit(req("/pane/icons/icon-32.png?_host_Info=Word$Mac", { method: "HEAD", omit: ["origin"] }), config)).toEqual({
      kind: "static",
      action: "file",
      path: "icons/icon-32.png",
      head: true,
    })
  })
  test.each(["/pane/../secret", "/pane/%2e%2e/x", "/pane//index.html", "/pane/", "/pane", "/pane/a\\b"])("rejects %p", async (path) => {
    expect(await code(req(path))).toBe("404 ROUTE_NOT_ALLOWED")
  })
  test("non-GET on static paths", async () => {
    expect(await code(req("/pane/index.html", { method: "POST" }))).toBe("404 ROUTE_NOT_ALLOWED")
  })
  test("unknown top-level path", async () => {
    expect(await code(req("/favicon.ico"))).toBe("404 ROUTE_NOT_ALLOWED")
  })
})

describe("U-BR-03 CSRF header", () => {
  test.each([undefined, "0", "true", " 1"])("value %p on /pair/request gives 403 and no verifier call", async (value) => {
    verified.length = 0
    const request = req("/pair/request", {
      body: { host: "Word" },
      omit: value === undefined ? ["x-swarm-office"] : [],
      headers: value === undefined ? {} : { "x-swarm-office": value },
    })
    expect(await code(request)).toBe("403 CSRF_HEADER_MISSING")
    expect(verified).toEqual([])
  })
  test.each(["/swarm/session", "/pair/status?requestId=abc", "/bridge/health", "/pair/verify"])("required on %p", async (path) => {
    expect(await code(req(path, { omit: ["x-swarm-office"] }))).toBe("403 CSRF_HEADER_MISSING")
  })
  test("duplicate header is refused", async () => {
    expect(await code(req("/bridge/health", { extra: [["X-Swarm-Office", "1"]] }))).toBe("403 CSRF_HEADER_MISSING")
  })
})

describe("U-BR-04 token", () => {
  test.each(["/swarm/global/health", "/swarm/session", "/swarm/event", "/pair/verify"])("missing or unknown on %p", async (path) => {
    expect(await code(req(path, { omit: ["x-swarm-office-token"] }))).toBe("401 TOKEN_INVALID")
    expect(await code(req(path, { headers: { "x-swarm-office-token": "swo1_wrong" } }))).toBe("401 TOKEN_INVALID")
    expect(await code(req(path, { extra: [["X-Swarm-Office-Token", TOKEN]] }))).toBe("401 TOKEN_INVALID")
  })
  test("local routes need no token", async () => {
    const omit = ["x-swarm-office-token"]
    expect(await admit(req("/pair/request", { body: { host: "Excel" }, omit }), config)).toEqual({
      kind: "local",
      route: "pair-request",
      host: "Excel",
    })
    expect(await admit(req("/pair/status?requestId=AAAAAAAAAAAAAAAAAAAAAA", { omit }), config)).toEqual({
      kind: "local",
      route: "pair-status",
      requestId: "AAAAAAAAAAAAAAAAAAAAAA",
    })
    expect(await admit(req("/bridge/health", { omit }), config)).toEqual({ kind: "local", route: "health" })
  })
  test("pair/verify with a valid token", async () => {
    expect(await admit(req("/pair/verify"), config)).toEqual({ kind: "local", route: "pair-verify", host: "Word", token: TOKEN })
  })
  test("async verifier is awaited", async () => {
    const result = await admit(req("/swarm/event"), { port: PORT, verifyToken: async () => "Excel" as const })
    expect(result.kind === "proxy" && result.tokenHost).toBe("Excel")
  })
  test("local route inputs are validated", async () => {
    expect(await code(req("/pair/request", { body: { host: "PowerPoint" } }))).toBe("400 FIELD_NOT_ALLOWED")
    expect(await code(req("/pair/request", { body: { host: "Word", extra: 1 } }))).toBe("400 FIELD_NOT_ALLOWED")
    expect(await code(req("/pair/request", { method: "POST" }))).toBe("400 FIELD_NOT_ALLOWED")
    expect(await code(req("/pair/status?requestId=../x"))).toBe("400 FIELD_NOT_ALLOWED")
    expect(await code(req("/pair/status?requestId=AAAAAAAAAAAAAAAAAAAAAA&x=1"))).toBe("400 FIELD_NOT_ALLOWED")
    expect(await code(req("/pair/request"))).toBe("404 ROUTE_NOT_ALLOWED")
    expect(await code(req("/pair/other"))).toBe("404 ROUTE_NOT_ALLOWED")
  })
})

describe("U-BR-05 route table", () => {
  const allowed: [string, string, unknown][] = [
    ["GET", "/swarm/global/health", undefined],
    ["POST", "/swarm/session", { host: "Word" }],
    ["GET", "/swarm/session", undefined],
    ["GET", `/swarm/session/${SID}`, undefined],
    ["GET", `/swarm/session/${SID}/message`, undefined],
    ["POST", `/swarm/session/${SID}/prompt_async`, { parts: [{ type: "text", text: "hi" }] }],
    ["POST", `/swarm/session/${SID}/abort`, undefined],
    ["GET", "/swarm/event", undefined],
  ]
  test.each(allowed)("%s %s admitted", async (method, path, body) => {
    const result = await admit(req(path, { method, body }), config)
    expect(result.kind).toBe("proxy")
  })
  test("routes carry the parsed input", async () => {
    expect(await admit(req(`/swarm/session/${SID}/message?limit=50`, { headers: { accept: "application/json" } }), config)).toEqual({
      kind: "proxy",
      route: "P5",
      sessionID: SID,
      limit: 50,
      token: TOKEN,
      tokenHost: "Word",
      forward: { accept: "application/json" },
    })
    const event = await admit(req("/swarm/event", { headers: { "last-event-id": "7" } }), config)
    expect(event.kind === "proxy" && event.forward).toEqual({ lastEventId: "7" })
  })

  // REG §7.5 blocked routes, each with a valid token and CSRF header.
  const blocked: [string, string][] = [
    ["PATCH", `/swarm/session/${SID}`],
    ["POST", `/swarm/session/${SID}/message`],
    ["POST", `/swarm/session/${SID}/shell`],
    ["POST", `/swarm/session/${SID}/command`],
    ["POST", `/swarm/session/${SID}/fork`],
    ["POST", `/swarm/session/${SID}/revert`],
    ["POST", `/swarm/session/${SID}/permissions/per_x`],
    ["POST", "/swarm/permission/x/reply"],
    ["POST", "/swarm/question/x/reply"],
    ["GET", "/swarm/question"],
    ["PATCH", `/swarm/session/${SID}/message/msg_x/part/prt_x`],
    ["DELETE", `/swarm/session/${SID}`],
    ["GET", "/swarm/config"],
    ["PATCH", "/swarm/config"],
    ["GET", "/swarm/global/config"],
    ["GET", "/swarm/global/event"],
    ["GET", "/swarm/pty"],
    ["POST", "/swarm/pty"],
    ["GET", "/swarm/doc"],
    ["GET", "/swarm/api/session"],
    ["GET", "/swarm"],
    ["HEAD", "/swarm/global/health"],
    ["POST", "/swarm/global/health"],
    ["GET", `/swarm/session/${SID}/prompt_async`],
  ]
  test.each(blocked)("REG 7.5: %s %s gives 404", async (method, path) => {
    expect(await code(req(path, { method, headers: { "content-length": "0" } }))).toBe("404 ROUTE_NOT_ALLOWED")
  })
})

describe("ST-14 table (SC-27..SC-30)", () => {
  const body = { parts: [{ type: "text", text: "x" }] }
  const cases: [string, AdmitRequest, string][] = [
    ["..%2F in session path", req("/swarm/session/..%2Fconfig"), "404 ROUTE_NOT_ALLOWED"],
    ["encoded slash after id", req(`/swarm/session/${SID}%2Fshell`, { method: "POST" }), "404 ROUTE_NOT_ALLOWED"],
    ["dot segment", req(`/swarm/session/${SID}/../../config`), "404 ROUTE_NOT_ALLOWED"],
    ["encoded dot segment", req("/swarm/%2e%2e/config"), "404 ROUTE_NOT_ALLOWED"],
    ["double slash", req("/swarm//session"), "404 ROUTE_NOT_ALLOWED"],
    ["trailing slash", req("/swarm/session/"), "404 ROUTE_NOT_ALLOWED"],
    ["case variant", req("/swarm/SESSION"), "404 ROUTE_NOT_ALLOWED"],
    ["case variant prefix", req("/SWARM/session"), "404 ROUTE_NOT_ALLOWED"],
    ["matrix param", req("/swarm/session;x"), "404 ROUTE_NOT_ALLOWED"],
    ["backslash", req("/swarm\\session"), "404 ROUTE_NOT_ALLOWED"],
    ["percent-encoded letter", req("/swarm/%73ession"), "404 ROUTE_NOT_ALLOWED"],
    ["bad session id", req("/swarm/session/not-a-session"), "404 ROUTE_NOT_ALLOWED"],
    ["absolute-form target", req("http://localhost:46317/swarm/session"), "404 ROUTE_NOT_ALLOWED"],
    ["fragment", req("/swarm/session#x"), "404 ROUTE_NOT_ALLOWED"],
    ["?directory", req("/swarm/session?directory=/tmp"), "400 FIELD_NOT_ALLOWED"],
    ["?workspace", req("/swarm/event?workspace=wrk_x"), "400 FIELD_NOT_ALLOWED"],
    ["?auth_token", req("/swarm/global/health?auth_token=abc"), "400 FIELD_NOT_ALLOWED"],
    ["?directory on P8", req("/swarm/event?directory=%2Ftmp"), "400 FIELD_NOT_ALLOWED"],
    ["limit 0", req("/swarm/session?limit=0"), "400 FIELD_NOT_ALLOWED"],
    ["limit 51", req("/swarm/session?limit=51"), "400 FIELD_NOT_ALLOWED"],
    ["limit +5", req("/swarm/session?limit=+5"), "400 FIELD_NOT_ALLOWED"],
    ["duplicate limit", req("/swarm/session?limit=5&limit=6"), "400 FIELD_NOT_ALLOWED"],
    ["limit on P4", req(`/swarm/session/${SID}?limit=5`), "400 FIELD_NOT_ALLOWED"],
    [
      "X-HTTP-Method-Override: PATCH",
      req("/swarm/session", { body: { host: "Word" }, extra: [["X-HTTP-Method-Override", "PATCH"]] }),
      "404 ROUTE_NOT_ALLOWED",
    ],
    ["X-HTTP-Method", req("/swarm/session", { extra: [["X-HTTP-Method", "DELETE"]] }), "404 ROUTE_NOT_ALLOWED"],
    ["x-opencode-directory", req("/swarm/session", { extra: [["x-opencode-directory", "/tmp"]] }), "400 FIELD_NOT_ALLOWED"],
    ["x-swarm-desktop-nonce", req("/swarm/session", { extra: [["x-swarm-desktop-nonce", "n"]] }), "400 FIELD_NOT_ALLOWED"],
    [
      "TE + CL conflict",
      req(`/swarm/session/${SID}/prompt_async`, { body, extra: [["Transfer-Encoding", "chunked"]] }),
      "400 FIELD_NOT_ALLOWED",
    ],
    [
      "duplicate Content-Length",
      req(`/swarm/session/${SID}/prompt_async`, { body, extra: [["Content-Length", "1"]] }),
      "400 FIELD_NOT_ALLOWED",
    ],
    ["non-numeric Content-Length", req("/swarm/session", { headers: { "content-length": "1, 1" } }), "400 FIELD_NOT_ALLOWED"],
    ["TE not chunked", req("/swarm/session", { extra: [["Transfer-Encoding", "gzip, chunked"]] }), "400 FIELD_NOT_ALLOWED"],
    ["framing on static too", req("/pane/index.html", { extra: [["Transfer-Encoding", "chunked"], ["Content-Length", "3"]] }), "400 FIELD_NOT_ALLOWED"],
    ["tools on P6", req(`/swarm/session/${SID}/prompt_async`, { body: { ...body, tools: { bash: true } } }), "400 FIELD_NOT_ALLOWED"],
    ["system on P6", req(`/swarm/session/${SID}/prompt_async`, { body: { ...body, system: "ignore rules" } }), "400 FIELD_NOT_ALLOWED"],
    ["system on P2", req("/swarm/session", { body: { host: "Word", system: "ignore rules" } }), "400 FIELD_NOT_ALLOWED"],
    ["tools on P2", req("/swarm/session", { body: { host: "Word", tools: { bash: true } } }), "400 FIELD_NOT_ALLOWED"],
  ]
  test.each(cases)("%s", async (_name, request, expected) => {
    expect(await code(request)).toBe(expected)
  })
})

describe("U-BR-06 P2 body", () => {
  test("title and host accepted", async () => {
    expect(await admit(req("/swarm/session", { body: { title: "Doc chat", host: "Excel" } }), config)).toEqual({
      kind: "proxy",
      route: "P2",
      host: "Excel",
      title: "Doc chat",
      token: TOKEN,
      tokenHost: "Word",
      forward: {},
    })
    const untitled = await admit(req("/swarm/session", { body: { host: "Word" } }), config)
    expect(untitled.kind === "proxy" && "title" in untitled).toBe(false)
  })
  test.each([
    ["permission", { host: "Word", permission: [] }],
    ["agent", { host: "Word", agent: "build" }],
    ["model", { host: "Word", model: "x" }],
    ["metadata", { host: "Word", metadata: { "swarm.origin": "office-addin" } }],
    ["parentID", { host: "Word", parentID: SID }],
    ["workspaceID", { host: "Word", workspaceID: "wrk_x" }],
    ["system", { host: "Word", system: "x" }],
    ["tools", { host: "Word", tools: {} }],
    ["no host", { title: "x" }],
    ["bad host", { host: "PowerPoint" }],
    ["title not string", { host: "Word", title: 5 }],
    ["title 201 chars", { host: "Word", title: "t".repeat(201) }],
    ["array body", [{ host: "Word" }]],
    ["null body", null],
  ])("rejects %s", async (_name, body) => {
    expect(await code(req("/swarm/session", { body }))).toBe("400 FIELD_NOT_ALLOWED")
  })
  test("title of exactly 200 chars is accepted", async () => {
    expect(await code(req("/swarm/session", { body: { host: "Word", title: "t".repeat(200) } }))).toBe("proxy")
  })
  test.each(["__proto__", "constructor"])("%s counts as unknown key", async (key) => {
    expect(await code(req("/swarm/session", { raw: `{"host":"Word","${key}":{"x":1}}`, method: "POST" }))).toBe(
      "400 FIELD_NOT_ALLOWED",
    )
  })
  test("invalid JSON", async () => {
    expect(await code(req("/swarm/session", { raw: "{host:", method: "POST" }))).toBe("400 FIELD_NOT_ALLOWED")
  })
})

describe("U-BR-07 P6 body", () => {
  const path = `/swarm/session/${SID}/prompt_async`
  const part = { type: "text" as const, text: "hello" }
  test("1 or 2 text parts", async () => {
    const two = await admit(req(path, { body: { parts: [part, { type: "text", text: "ctx" }] } }), config)
    expect(two.kind === "proxy" && two.route === "P6" && two.parts).toEqual([part, { type: "text" as const, text: "ctx" }])
  })
  test.each([
    ["tools", { parts: [part], tools: { bash: true } }],
    ["system", { parts: [part], system: "x" }],
    ["agent", { parts: [part], agent: "build" }],
    ["model", { parts: [part], model: { providerID: "x", modelID: "y" } }],
    ["variant", { parts: [part], variant: "high" }],
    ["noReply", { parts: [part], noReply: true }],
    ["format", { parts: [part], format: { type: "json_schema" } }],
    ["messageID", { parts: [part], messageID: "msg_x" }],
    ["file part", { parts: [{ type: "file", url: "file:///etc/passwd", mime: "text/plain" }] }],
    ["agent part", { parts: [{ type: "agent", name: "build" }] }],
    ["subtask part", { parts: [{ type: "subtask", prompt: "x" }] }],
    ["extra part key id", { parts: [{ ...part, id: "prt_x" }] }],
    ["extra part key synthetic", { parts: [{ ...part, synthetic: true }] }],
    ["part text not string", { parts: [{ type: "text", text: 1 }] }],
    ["0 parts", { parts: [] }],
    ["3 parts", { parts: [part, part, part] }],
    ["parts not array", { parts: part }],
    ["no parts", {}],
  ])("rejects %s", async (_name, body) => {
    expect(await code(req(path, { body }))).toBe("400 FIELD_NOT_ALLOWED")
  })
  test("__proto__ inside a part", async () => {
    expect(await code(req(path, { method: "POST", raw: '{"parts":[{"type":"text","text":"x","__proto__":{}}]}' }))).toBe(
      "400 FIELD_NOT_ALLOWED",
    )
  })
  test("P7 accepts empty or {} only; GET routes take no body", async () => {
    expect(await code(req(`/swarm/session/${SID}/abort`, { body: {} }))).toBe("proxy")
    expect(await code(req(`/swarm/session/${SID}/abort`, { body: { force: true } }))).toBe("400 FIELD_NOT_ALLOWED")
    expect(await code(req(`/swarm/session/${SID}`, { method: "GET", body: {} }))).toBe("400 FIELD_NOT_ALLOWED")
  })
})

describe("U-BR-08 query", () => {
  test("P3 limit 1..50, P5 limit only", async () => {
    const p3 = await admit(req("/swarm/session?limit=20"), config)
    expect(p3.kind === "proxy" && p3.route === "P3" && p3.limit).toBe(20)
    expect(await code(req("/swarm/session?limit=1"))).toBe("proxy")
    expect(await code(req("/swarm/session?limit=50"))).toBe("proxy")
    expect(await code(req(`/swarm/session/${SID}/message?limit=50`))).toBe("proxy")
    expect(await code(req(`/swarm/session/${SID}/message?limit=5&roots=true`))).toBe("400 FIELD_NOT_ALLOWED")
    expect(await code(req("/swarm/session?roots=true"))).toBe("400 FIELD_NOT_ALLOWED")
  })
})

describe("U-BR-11 content type and size", () => {
  test("body without application/json gives 400", async () => {
    const text = req("/pair/request", { body: { host: "Word" }, headers: { "content-type": "text/plain" } })
    expect(await code(text)).toBe("400 FIELD_NOT_ALLOWED")
    const form = req("/pair/request", { raw: "host=Word", headers: { "content-type": "application/x-www-form-urlencoded" } })
    expect(await code(form)).toBe("400 FIELD_NOT_ALLOWED")
    const missing = req("/swarm/session", { body: { host: "Word" }, omit: ["content-type"] })
    expect(await code(missing)).toBe("400 FIELD_NOT_ALLOWED")
    const charset = req("/swarm/session", { body: { host: "Word" }, headers: { "content-type": "application/json; charset=utf-8" } })
    expect(await code(charset)).toBe("400 FIELD_NOT_ALLOWED")
  })
  test("over 2 MiB gives 413", async () => {
    const big = "x".repeat(2 * 1024 * 1024)
    expect(await code(req(`/swarm/session/${SID}/prompt_async`, { body: { parts: [{ type: "text", text: big }] } }))).toBe(
      "413 BODY_TOO_LARGE",
    )
    expect(await code(req("/swarm/session", { headers: { "content-length": String(2 * 1024 * 1024 + 1), "content-type": "application/json" } }))).toBe(
      "413 BODY_TOO_LARGE",
    )
    expect(await code({ ...req("/swarm/session", { body: { host: "Word" } }), bodyOverflow: true })).toBe("413 BODY_TOO_LARGE")
  })
  test("exactly at the limit passes the size stage", async () => {
    const parts = { parts: [{ type: "text", text: "" }] }
    const pad = 2 * 1024 * 1024 - JSON.stringify(parts).length
    expect(await code(req(`/swarm/session/${SID}/prompt_async`, { body: { parts: [{ type: "text", text: "y".repeat(pad) }] } }))).toBe(
      "proxy",
    )
  })
  test("invalid UTF-8 body gives 400", async () => {
    const request = req("/swarm/session", { body: { host: "Word" } })
    expect(await code({ ...request, body: new Uint8Array([0x7b, 0xff, 0x7d]) })).toBe("400 FIELD_NOT_ALLOWED")
  })
})

describe("headerPairs", () => {
  test("pairs Node rawHeaders and keeps duplicates", () => {
    expect(headerPairs(["Host", "a", "Content-Length", "1", "content-length", "2"])).toEqual([
      ["Host", "a"],
      ["Content-Length", "1"],
      ["content-length", "2"],
    ])
  })
})
