/**
 * LocalStudioApi (row 31, studio spec §3.2): an in-process `HttpFetch` that routes `(method, path)` of the
 * kept MCP tools to local handlers ported from the Studio Next route bodies. It never opens a socket and
 * never calls `globalThis.fetch`; the MCP tools reach it through `ServerDeps.fetchImpl`
 * (vendor/scripts/studio/mcp/server.ts:37-40, tool-kit.ts `http()`, _http-client.ts:128-129).
 *
 * Checks, in order: origin = the configured base origin (anything else throws, i.e. "unreachable"; there is
 * no network fallback), method known, `x-internal-secret` = the per-process secret (HMAC + timingSafeEqual,
 * contract/auth.ts `secretEquals`; mismatch -> 401 without detail), route matched (404 / 405).
 * Unexpected handler errors become a generic 500 and are written to the persistent API log
 * (`<STUDIO_WORKSPACE_ROOT>/logs/api`, http/log.ts `apiLog`) with the stack trace; no stack reaches the tool.
 */
import { randomUUID } from "node:crypto"
import type { HttpFetch, HttpResponseLike } from "../../../vendor/scripts/studio/_http-client"
import { localStudioCaller, secretEquals } from "../../../vendor/src/lib/studio/contract/auth"
import { apiLog } from "../../../vendor/src/lib/studio/http/log"
import type { LocalMethod, RouteDef, RouteHandler } from "./types.ts"

export const LOCAL_API_SOURCE = "datum-studio.local-api"
const METHODS: ReadonlySet<string> = new Set(["GET", "POST", "HEAD", "PATCH"])

interface CompiledRoute {
  def: RouteDef
  re: RegExp
  keys: string[]
}

function compile(def: RouteDef): CompiledRoute {
  const keys: string[] = []
  const body = def.pattern
    .split("/")
    .map((seg) => {
      const m = /^\[([a-z]+)\]$/.exec(seg)
      if (m) {
        keys.push(m[1])
        return "([^/]+)"
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    })
    .join("/")
  return { def, re: new RegExp(`^${body}$`), keys }
}

export interface LocalStudioApiOptions {
  /** `config.baseUrl` of the session (normalizeBaseUrl form). Only this origin is served. */
  baseUrl: string
  /** Per-process random secret (`config.secret`); never logged. */
  secret: string
  /** The session agent id; every request runs as `localStudioCaller(agentId)`. */
  agentId: string
  routes: readonly RouteDef[]
  /** Row 50b (W-13): the session file root, handed to handlers as `rc.fileRoot` (R18 `path` reads). */
  fileRoot?: string
}

export interface LocalStudioApi {
  fetch: HttpFetch
  /** Number of requests served (tests, diagnostics). */
  served(): number
}

function jsonResponse(status: number, body: unknown, cid: string): Response {
  return Response.json(body, { status, headers: { "x-correlation-id": cid, "cache-control": "no-store" } })
}

function toLike(res: Response): HttpResponseLike {
  // Body read once; both readers share the same buffer.
  let buf: Promise<ArrayBuffer> | null = null
  const bytes = () => (buf ??= res.arrayBuffer())
  return {
    status: res.status,
    headers: { get: (n: string) => res.headers.get(n) },
    text: async () => new TextDecoder().decode(await bytes()),
    arrayBuffer: bytes,
  }
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  return reason instanceof Error ? reason : Object.assign(new Error("aborted"), { name: "AbortError" })
}

export function createLocalStudioApi(opts: LocalStudioApiOptions): LocalStudioApi {
  const origin = new URL(opts.baseUrl).origin
  const compiled = opts.routes.map(compile)
  const caller = localStudioCaller(opts.agentId)
  let count = 0

  const match = (pathname: string): { route: CompiledRoute; params: Record<string, string> } | null => {
    for (const r of compiled) {
      const m = r.re.exec(pathname)
      if (!m) continue
      const params: Record<string, string> = {}
      try {
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])))
      } catch {
        return null
      }
      return { route: r, params }
    }
    return null
  }

  const fetchImpl: HttpFetch = async (url, init) => {
    let target: URL
    try {
      target = new URL(url)
    } catch {
      throw new Error("LocalStudioApi: invalid request URL")
    }
    // No network fallback: a foreign origin is a programming error, reported as unreachable by the caller.
    if (target.origin !== origin) throw new Error(`LocalStudioApi serves only ${origin}`)
    count++
    const method = (init.method ?? "GET").toUpperCase()
    const cid = randomUUID()
    if (!METHODS.has(method)) return toLike(jsonResponse(405, { error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }, cid))
    const provided = init.headers["x-internal-secret"] ?? ""
    if (opts.secret === "" || provided === "" || !secretEquals(provided, opts.secret)) {
      return toLike(jsonResponse(401, { error: "Unauthorized", code: "UNAUTHORIZED" }, cid))
    }
    const hit = match(target.pathname)
    if (!hit) return toLike(jsonResponse(404, { error: "Route not found", code: "ROUTE_NOT_FOUND" }, cid))
    const handler: RouteHandler | undefined = hit.route.def.methods[method as LocalMethod]
    if (!handler) {
      const allow = Object.keys(hit.route.def.methods).join(", ")
      return toLike(new Response(JSON.stringify({ error: "Method not allowed", code: "METHOD_NOT_ALLOWED" }), { status: 405, headers: { allow, "content-type": "application/json", "x-correlation-id": cid } }))
    }
    const headers = new Headers()
    for (const [k, v] of Object.entries(init.headers)) if (k.toLowerCase() !== "x-internal-secret") headers.set(k, v)
    headers.set("x-correlation-id", cid)
    headers.set("x-studio-agent", opts.agentId)
    const req = new Request(target.toString(), { method, headers, ...(init.body !== undefined && method !== "GET" && method !== "HEAD" ? { body: init.body } : {}) })
    const run = (async () => {
      try {
        return await handler(req, { params: hit.params, agentId: opts.agentId, caller, ...(opts.fileRoot ? { fileRoot: opts.fileRoot } : {}) })
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e))
        apiLog({
          correlationId: cid,
          route: hit.route.def.pattern,
          method,
          source: LOCAL_API_SOURCE,
          level: "error",
          message: `unexpected ${err.name} in local route`,
          code: "INTERNAL",
          status: 500,
          stack_trace: err.stack,
          context: { routeId: hit.route.def.id, requester: caller.requester },
        })
        return jsonResponse(500, { error: "Internal error", correlationId: cid }, cid)
      }
    })()
    const signal = init.signal
    if (!signal) return toLike(await run)
    if (signal.aborted) throw abortError(signal)
    return toLike(
      await new Promise<Response>((resolve, reject) => {
        const onAbort = () => reject(abortError(signal))
        signal.addEventListener("abort", onAbort, { once: true })
        run.then(
          (r) => {
            signal.removeEventListener("abort", onAbort)
            resolve(r)
          },
          (e) => {
            signal.removeEventListener("abort", onAbort)
            reject(e)
          },
        )
      }),
    )
  }

  return { fetch: fetchImpl, served: () => count }
}
