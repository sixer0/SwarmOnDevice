/**
 * Streamable-HTTP endpoint of the Studio MCP server (row 31, studio spec §9.1, U13).
 *
 * Bound to 127.0.0.1 only. A request is served only when ALL hold, else 401/403 with an empty body:
 * - remote address is 127.0.0.1 (IPv4 or IPv4-mapped IPv6);
 * - `Host` is exactly `127.0.0.1:<port>` (DNS rebinding);
 * - no `Origin` header (browsers);
 * - `Authorization: Bearer <token>` equals the per-launch token (HMAC digests + timingSafeEqual,
 *   contract/auth.ts `secretEquals`);
 * - the path is `/mcp` (404) and the body is at most 8 MiB (`MAX_MESSAGE_BYTES`, config.ts:33; 413).
 *
 * Sessions: an `initialize` POST without `Mcp-Session-Id` opens a session. It needs the bridge headers
 * `X-Studio-Caller-Cwd` (percent-encoded caller directory = the session's file root, spec §9.4) and
 * `X-Studio-Agent` (`claude`, `swarm`, ...). Each session has its own MCP server, McpSession, LocalStudioApi
 * and file root, so base-revision memory and file roots of Swarm and Claude never mix (spec §3.2).
 */
import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import { MAX_MESSAGE_BYTES } from "../../vendor/scripts/studio/mcp/config"
import { secretEquals } from "../../vendor/src/lib/studio/contract/auth"

export const MCP_PATH = "/mcp"
export const CALLER_CWD_HEADER = "x-studio-caller-cwd"
export const AGENT_HEADER = "x-studio-agent"
/** Row 188 (L47): optional; the caller's own session ref (Swarm `ses_...`), linked to mission writes that omit `session`. */
export const CALLER_SESSION_HEADER = "x-studio-caller-session"
/**
 * Row FX-4 (1.2.6, review M2 S2): the endpoint's node:http limits, explicit. The host runs in an Electron
 * utilityProcess (Node runtime), not Bun.serve. 0 = no limit: a silent `tools/call` (studio_render R17, 540 s) is
 * never cut by the server; `requestTimeout` 0 and socket `timeout` 0 hold it past 600 s (probe: 545 s with the client
 * idle cut removed). `headersTimeout` only bounds the arrival of the request headers.
 */
export const HOST_HTTP_TIMEOUTS = { requestTimeout: 0, headersTimeout: 30_000, timeout: 0 } as const
export const MAX_SESSIONS = 64
const AGENT_RE = /^[A-Za-z0-9_.-]{1,40}$/
const LOOPBACK = new Set(["127.0.0.1", "::ffff:127.0.0.1"])

export class SessionRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export interface SessionHandle {
  server: Server
  close(): Promise<void>
}

export interface EndpointOptions {
  /** 0 = ephemeral (production); tests pass a fixed port. */
  port: number
  token: string
  /** Build the session's server for (agent, raw caller-cwd header); throw SessionRefused to refuse. */
  openSession(i: { sessionId: string; agentId: string; callerCwd: string | null; callerSession?: string | null }): Promise<SessionHandle> | SessionHandle
  log: (rec: Record<string, unknown>) => void
}

export interface Endpoint {
  url: string
  port: number
  address: AddressInfo
  sessionCount(): number
  close(): Promise<void>
}

function deny(res: ServerResponse, status: number): void {
  res.writeHead(status, { "content-length": "0", connection: "close", "cache-control": "no-store" })
  // The request body (possibly 8 MiB+) is not read: drop the connection once the answer is out.
  res.end(() => res.socket?.destroy())
}

function rpcError(res: ServerResponse, status: number, message: string, code = -32000): void {
  const body = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null })
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body), "cache-control": "no-store" })
  res.end(body)
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    let over = false
    req.on("data", (c: Buffer) => {
      if (over) return
      n += c.length
      if (n > limit) {
        over = true
        resolve("too-large")
        return
      }
      chunks.push(c)
    })
    req.on("end", () => {
      if (!over) resolve(Buffer.concat(chunks))
    })
    req.on("error", reject)
  })
}

export function startEndpoint(opts: EndpointOptions): Promise<Endpoint> {
  interface Entry {
    transport: StreamableHTTPServerTransport
    handle: SessionHandle
  }
  const sessions = new Map<string, Entry>()
  let port = 0

  const authorized = (req: IncomingMessage): number => {
    if (!LOOPBACK.has(req.socket.remoteAddress ?? "")) return 403
    if (req.headers.host !== `127.0.0.1:${port}`) return 403
    if (req.headers.origin !== undefined) return 403
    const auth = req.headers.authorization ?? ""
    const m = /^Bearer ([^\s]+)$/.exec(auth)
    if (!m || !secretEquals(m[1], opts.token)) return 401
    return 0
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const status = authorized(req)
    if (status !== 0) {
      opts.log({ level: "warn", event: "request_refused", status, method: req.method })
      req.resume()
      return deny(res, status)
    }
    const pathname = (req.url ?? "").split("?")[0]
    if (pathname !== MCP_PATH) {
      req.resume()
      return deny(res, 404)
    }
    const method = req.method ?? ""
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      req.resume()
      res.setHeader("allow", "GET, POST, DELETE")
      return deny(res, 405)
    }
    const declared = Number(req.headers["content-length"] ?? "0")
    if (Number.isFinite(declared) && declared > MAX_MESSAGE_BYTES) {
      req.resume()
      return deny(res, 413)
    }
    let body: unknown
    if (method === "POST") {
      const raw = await readBody(req, MAX_MESSAGE_BYTES)
      if (raw === "too-large") return deny(res, 413)
      try {
        body = JSON.parse(raw.toString("utf8"))
      } catch {
        return rpcError(res, 400, "Parse error", -32700)
      }
    }
    const sidHeader = req.headers["mcp-session-id"]
    const sid = typeof sidHeader === "string" ? sidHeader : undefined
    if (sid !== undefined) {
      const entry = sessions.get(sid)
      if (!entry) return rpcError(res, 404, "Session not found")
      await entry.transport.handleRequest(req, res, body)
      return
    }
    if (method !== "POST" || !isInitializeRequest(body)) return rpcError(res, 400, "Bad Request: no valid session id")
    if (sessions.size >= MAX_SESSIONS) return rpcError(res, 503, "Too many DATUM Studio sessions")
    const agentRaw = req.headers[AGENT_HEADER]
    const agentId = typeof agentRaw === "string" ? agentRaw : ""
    if (!AGENT_RE.test(agentId)) return rpcError(res, 400, "X-Studio-Agent is required (1..40 of A-Z a-z 0-9 _ . -)")
    const cwdRaw = req.headers[CALLER_CWD_HEADER]
    const sessionId = randomUUID()
    let sessionHandle: SessionHandle
    try {
      const callerSessionRaw = req.headers[CALLER_SESSION_HEADER]
      sessionHandle = await opts.openSession({ sessionId, agentId, callerCwd: typeof cwdRaw === "string" ? cwdRaw : null, callerSession: typeof callerSessionRaw === "string" ? callerSessionRaw : null })
    } catch (e) {
      const st = e instanceof SessionRefused ? e.status : 500
      const msg = e instanceof SessionRefused ? e.message : "DATUM Studio could not open the session"
      opts.log({ level: st >= 500 ? "error" : "warn", event: "session_refused", agentId, status: st, message: msg, ...(st >= 500 && e instanceof Error ? { stack_trace: e.stack } : {}) })
      return rpcError(res, st, msg)
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, handle: sessionHandle })
        opts.log({ level: "info", event: "session_open", sessionId: id, agentId })
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
      },
    })
    transport.onclose = () => {
      if (sessions.delete(sessionId)) opts.log({ level: "info", event: "session_closed", sessionId })
      void sessionHandle.close().catch(() => undefined)
    }
    await sessionHandle.server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e))
      opts.log({ level: "error", event: "request_failed", message: err.message, stack_trace: err.stack })
      if (!res.headersSent) rpcError(res, 500, "Internal error", -32603)
      else res.end()
    })
  })
  http.requestTimeout = HOST_HTTP_TIMEOUTS.requestTimeout
  http.headersTimeout = HOST_HTTP_TIMEOUTS.headersTimeout
  http.timeout = HOST_HTTP_TIMEOUTS.timeout

  return new Promise((resolve, reject) => {
    http.once("error", reject)
    http.listen({ host: "127.0.0.1", port: opts.port, exclusive: true }, () => {
      http.off("error", reject)
      const address = http.address() as AddressInfo
      port = address.port
      resolve({
        url: `http://127.0.0.1:${port}${MCP_PATH}`,
        port,
        address,
        sessionCount: () => sessions.size,
        close: async () => {
          const all = [...sessions.values()]
          sessions.clear()
          await Promise.all(all.map((e) => e.transport.close().catch(() => undefined)))
          await Promise.all(all.map((e) => e.handle.close().catch(() => undefined)))
          await new Promise<void>((r) => {
            http.close(() => r())
            http.closeAllConnections()
          })
        },
      })
    })
  })
}
