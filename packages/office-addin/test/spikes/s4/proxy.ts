// Spike S4 (plan M0-05, blueprint row 34). THROWAWAY code: not the production bridge.
//
// A same-origin proxy in front of a Swarm dev sidecar. It serves the streaming pane at
// /pane/index.html and forwards exactly four register routes (00_register.md §7.3) under /swarm:
//   P2 POST /swarm/session                         -> /session
//   P6 POST /swarm/session/:id/prompt_async        -> /session/:id/prompt_async
//   P7 POST /swarm/session/:id/abort               -> /session/:id/abort
//   P8 GET  /swarm/event                           -> /event (unbuffered SSE)
// Everything else under /swarm is 404 ROUTE_NOT_ALLOWED.
//
// Secrets: the sidecar URL, username and password come from env vars only. They are never printed.
// Logging: one line per request with method, path (no query), status and duration. Never headers,
// bodies or the password.
import path from "node:path"
import { mkdirSync, appendFileSync } from "node:fs"

const env = {
  url: process.env.SWARM_S4_SIDECAR_URL,
  username: process.env.SWARM_S4_SIDECAR_USERNAME,
  password: process.env.SWARM_S4_SIDECAR_PASSWORD,
}
const missing = Object.entries({
  SWARM_S4_SIDECAR_URL: env.url,
  SWARM_S4_SIDECAR_USERNAME: env.username,
  SWARM_S4_SIDECAR_PASSWORD: env.password,
})
  .filter((entry) => !entry[1])
  .map((entry) => entry[0])
if (missing.length > 0 || !env.url || !env.username || !env.password) {
  console.error(
    `[s4-proxy] refusing to start: missing required env var(s): ${missing.join(", ")}. ` +
      "Set the sidecar URL, username and password in the environment (values are never printed).",
  )
  process.exit(2)
}

const port = Number(process.env.SWARM_S4_PORT ?? "46317")
const insecure = process.env.SWARM_S4_INSECURE_HTTP === "1"
const certPath = process.env.SWARM_S4_TLS_CERT
const keyPath = process.env.SWARM_S4_TLS_KEY
if (!insecure && (!certPath || !keyPath)) {
  console.error(
    "[s4-proxy] refusing to start: HTTPS needs SWARM_S4_TLS_CERT and SWARM_S4_TLS_KEY (the localhost leaf from spike S1/S2), " +
      "or set SWARM_S4_INSECURE_HTTP=1 for a local smoke on plain http.",
  )
  process.exit(2)
}

// Register §7.2, literal (OFFICE_SESSION_RULESET). Spike copy: row 42 owns the real constant.
const OFFICE_SESSION_RULESET = [
  { permission: "*", pattern: "*", action: "deny" },
  { permission: "bash", pattern: "*", action: "deny" },
  { permission: "edit", pattern: "*", action: "deny" },
  { permission: "webfetch", pattern: "*", action: "deny" },
  { permission: "websearch", pattern: "*", action: "deny" },
  { permission: "task", pattern: "*", action: "deny" },
  { permission: "external_directory", pattern: "*", action: "deny" },
]
const MAX_BODY = 2 * 1024 * 1024
const upstream = env.url.replace(/\/+$/, "")
const authorization = `Basic ${Buffer.from(`${env.username}:${env.password}`).toString("base64")}`
const workspace = process.env.SWARM_S4_WORKSPACE ?? path.join(process.env.TMPDIR ?? "/tmp", "swarm-s4-workspace")
mkdirSync(workspace, { recursive: true, mode: 0o700 })
const logFile = process.env.SWARM_S4_LOG
// Sessions created through this proxy. The production bridge does the upstream ownership check
// (register §7.2); the spike keeps an in-memory set instead.
const owned = new Set<string>()

const log = (method: string, pathname: string, status: number, started: number, note?: string) => {
  const line = `${new Date().toISOString()} ${method} ${pathname} ${status} ${Math.round(performance.now() - started)}ms${note ? ` ${note}` : ""}`
  console.log(line)
  if (logFile) appendFileSync(logFile, line + "\n")
}

const error = (status: number, code: string) => Response.json({ error: code }, { status })

const readJson = async (req: Request) => {
  if (!(req.headers.get("content-type") ?? "").startsWith("application/json")) return { ok: false as const, status: 400 }
  const text = await req.text()
  if (text.length > MAX_BODY) return { ok: false as const, status: 413 }
  if (text.length === 0) return { ok: true as const, value: {} as Record<string, unknown> }
  const value: unknown = await Promise.resolve()
    .then(() => JSON.parse(text))
    .catch(() => undefined)
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false as const, status: 400 }
  return { ok: true as const, value: value as Record<string, unknown> }
}

const target = (upstreamPath: string) => {
  const url = new URL(upstream + upstreamPath)
  url.searchParams.set("directory", workspace)
  return url
}

const forward = (req: Request, upstreamPath: string, body?: unknown) =>
  fetch(target(upstreamPath), {
    method: req.method,
    headers: {
      authorization,
      accept: req.headers.get("accept") ?? "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: req.signal,
  })
    .then((res) => {
      if (res.status === 401) return error(503, "SWARM_UNAVAILABLE")
      // Pass the body stream straight through. Bun does not buffer a ReadableStream body.
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "no-cache, no-transform",
          "x-accel-buffering": "no",
        },
      })
    })
    .catch(() => error(503, "SWARM_UNAVAILABLE"))

const handleSwarm = async (req: Request, pathname: string) => {
  if (req.headers.get("x-swarm-office") !== "1") return error(403, "CSRF_HEADER_MISSING")

  // P8
  if (req.method === "GET" && pathname === "/swarm/event") return forward(req, "/event")

  // P2
  if (req.method === "POST" && pathname === "/swarm/session") {
    const body = await readJson(req)
    if (!body.ok) return error(body.status, body.status === 413 ? "BODY_TOO_LARGE" : "FIELD_NOT_ALLOWED")
    if (Object.keys(body.value).some((key) => key !== "title" && key !== "host")) return error(400, "FIELD_NOT_ALLOWED")
    const title = body.value.title
    const host = body.value.host
    if (title !== undefined && (typeof title !== "string" || title.length > 200)) return error(400, "FIELD_NOT_ALLOWED")
    if (host !== undefined && host !== "Word" && host !== "Excel") return error(400, "FIELD_NOT_ALLOWED")
    const res = await forward(req, "/session", {
      ...(title === undefined ? {} : { title }),
      permission: OFFICE_SESSION_RULESET,
      metadata: { "swarm.origin": "office-addin", ...(host === undefined ? {} : { "swarm.office.host": host }) },
    })
    if (!res.ok) return res
    const created: unknown = await res.json()
    const id = created && typeof created === "object" && "id" in created ? created.id : undefined
    if (typeof id === "string") owned.add(id)
    return Response.json(created, { status: res.status })
  }

  const match = /^\/swarm\/session\/([A-Za-z0-9_-]+)\/(prompt_async|abort)$/.exec(pathname)
  if (req.method !== "POST" || !match) return error(404, "ROUTE_NOT_ALLOWED")
  if (!owned.has(match[1]!)) return error(404, "ROUTE_NOT_ALLOWED")

  // P7
  if (match[2] === "abort") {
    if ((await req.text()).length > 0) return error(400, "FIELD_NOT_ALLOWED")
    return forward(req, `/session/${match[1]}/abort`, {})
  }

  // P6: body is `parts` only, 1-2 items of exactly {type: "text", text: string} (register §7.4).
  const body = await readJson(req)
  if (!body.ok) return error(body.status, body.status === 413 ? "BODY_TOO_LARGE" : "FIELD_NOT_ALLOWED")
  if (Object.keys(body.value).some((key) => key !== "parts")) return error(400, "FIELD_NOT_ALLOWED")
  const parts = body.value.parts
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > 2) return error(400, "FIELD_NOT_ALLOWED")
  const valid = parts.every(
    (part: unknown) =>
      !!part &&
      typeof part === "object" &&
      Object.keys(part).every((key) => key === "type" || key === "text") &&
      "type" in part &&
      part.type === "text" &&
      "text" in part &&
      typeof part.text === "string",
  )
  if (!valid) return error(400, "FIELD_NOT_ALLOWED")
  return forward(req, `/session/${match[1]}/prompt_async`, { parts })
}

const bundle = await Bun.build({
  entrypoints: [path.join(import.meta.dir, "pane", "main.ts")],
  target: "browser",
  minify: false,
})
if (!bundle.success) {
  console.error("[s4-proxy] pane bundle failed")
  bundle.logs.forEach((entry) => console.error(String(entry)))
  process.exit(1)
}
const paneJs = await bundle.outputs[0]!.text()
const paneHtml = Bun.file(path.join(import.meta.dir, "pane", "index.html"))

// Register §4 binds both loopback families; WKWebView may resolve localhost to either.
const hostnames = (process.env.SWARM_S4_HOSTNAMES ?? "127.0.0.1,::1").split(",").filter(Boolean)
const servers = hostnames.map((hostname) =>
  Bun.serve({
  port,
  hostname,
  // SSE stays open between 10 s heartbeats; never let Bun close it as idle.
  idleTimeout: 0,
  ...(insecure ? {} : { tls: { cert: Bun.file(certPath!), key: Bun.file(keyPath!) } }),
  async fetch(req) {
    const started = performance.now()
    const pathname = new URL(req.url).pathname
    const origin = req.headers.get("origin")
    const self = `${insecure ? "http" : "https"}://localhost:${port}`
    const res = await (async () => {
      if (req.method === "OPTIONS") return error(403, "ORIGIN_REJECTED")
      if (origin && origin !== self && origin !== self.replace("localhost", "127.0.0.1")) return error(403, "ORIGIN_REJECTED")
      if (pathname === "/pane/index.html" || pathname === "/pane/" || pathname === "/pane")
        return new Response(paneHtml, { headers: { "content-type": "text/html; charset=utf-8" } })
      if (pathname === "/pane/main.js")
        return new Response(paneJs, { headers: { "content-type": "text/javascript; charset=utf-8" } })
      if (pathname.startsWith("/swarm/")) return handleSwarm(req, pathname)
      return error(404, "ROUTE_NOT_ALLOWED")
    })()
    const streaming = (res.headers.get("content-type") ?? "").startsWith("text/event-stream")
    if (!streaming || !res.body) {
      log(req.method, pathname, res.status, started)
      return res
    }
    // Log the SSE open now and its close (with total duration) when the stream ends or is cancelled.
    log(req.method, pathname, res.status, started, "stream-open")
    const reader = res.body.getReader()
    const closed = { value: false }
    const passthrough = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await reader.read().catch(() => ({ done: true as const, value: undefined }))
        if (next.done) {
          if (!closed.value) log(req.method, pathname, res.status, started, "stream-end")
          closed.value = true
          controller.close()
          return
        }
        controller.enqueue(next.value)
      },
      cancel() {
        closed.value = true
        log(req.method, pathname, res.status, started, "stream-cancel")
        return reader.cancel()
      },
    })
    return new Response(passthrough, { status: res.status, headers: res.headers })
  },
  }),
)

const stop = () => {
  servers.forEach((server) => server.stop(true))
  process.exit(0)
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
console.log(
  `[s4-proxy] listening on ${insecure ? "http" : "https"}://localhost:${port} [${hostnames.join(", ")}] (pane /pane/index.html, proxy /swarm/*)`,
)
