/**
 * datum-studio-bridge (row 34; Studio spec §9.1-§9.5; U13: Studio is hosted only inside Swarm).
 *
 * Bundled by row 36 (`bun build --target=bun`) to <Res>/datum-studio/server/datum-studio-bridge.js and started by
 * <Res>/datum-studio/datum-studio-launcher on the bundled Bun (<Res>/swarm-cli/swarm, BUN_BE_BUN=1), cwd = server/.
 *
 * It is a pipe, with no tool logic: newline-delimited JSON-RPC on stdin/stdout (the MCP stdio transport) <-> the
 * streamable-HTTP endpoint the running app hosts on 127.0.0.1 (row 31, `http://127.0.0.1:<port>/mcp`). Every request
 * carries `Authorization: Bearer <TOKEN>`, `X-Studio-Agent` and `X-Studio-Caller-Cwd` (percent-encoded), the row 31
 * contract. It has no dependency: the desktop package does not resolve @modelcontextprotocol/sdk, and a dependency-free
 * file keeps the bundle small (row 34 decision D34-1).
 *
 * Token handling: read at start from <DATUM_STUDIO_STATE>/swarm/datum-studio.env (0600, owned by this user, written by
 * the app, row 111). It lives only in this process's memory and the Authorization header. It is never printed, logged,
 * put in argv or the environment, and no error text that could hold it is echoed.
 *
 * Reconnect (row 54b, M-02 / SEC-14): when the endpoint stops answering (a request fails to connect, or the session
 * stream ends) the bridge re-reads the descriptor once (`BRIDGE_RECONNECT_ATTEMPTS`). A descriptor that is a link, not a
 * regular file, not 0600 or not owned by this user is refused `DESCRIPTOR_UNSAFE`; a non-loopback URL is refused. If the
 * descriptor names a new endpoint, the bridge replays the client's `initialize` there (its answer is not echoed), sends
 * `notifications/initialized`, reopens the session stream and retries the failed request once. The change is logged with
 * the new port and PID only. An unchanged descriptor, or a second change, ends the bridge as before (exit 3).
 *
 * Exit codes: 0 stdin closed; 3 Swarm not running / endpoint gone / token rejected (prints START_SWARM_MESSAGE, spec
 * §9.5); 4 misconfigured bundle or environment.
 * Logging: one JSON record per line on stderr (timestamp, level, source, code, message, context). The MCP client keeps a
 * server's stderr in its own log (Claude Code's MCP log, Swarm's sidecar log), which is the durable copy.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { BRIDGE_FETCH_OPTIONS } from "./datum-studio-bridge-transport"

const START_SWARM_MESSAGE =
  "DATUM Studio runs inside the Swarm app. Start Swarm, then reconnect this MCP server (Claude Code: /mcp)."
const EXIT_NOT_RUNNING = 3
const EXIT_MISCONFIGURED = 4
const DESCRIPTOR_FILE = "datum-studio.env"
const MAX_DESCRIPTOR_BYTES = 4096
const AGENT_RE = /^[A-Za-z0-9_.-]{1,40}$/
const TOKEN_RE = /^[A-Za-z0-9._~+/-]{32,512}$/
const SOURCE = "datum-studio-bridge"
/** Row 54b (M-02, register N-051): how many times one bridge process follows a changed descriptor. */
export const BRIDGE_RECONNECT_ATTEMPTS = 1

type Json = Record<string, unknown>
type Endpoint = { url: string; token: string; pid: string }
type Sink = (message: unknown) => void

class Fatal extends Error {
  constructor(
    readonly exitCode: number,
    readonly code: string,
    message: string,
    readonly context: Json = {},
  ) {
    super(message)
  }
}

function log(level: "info" | "warn" | "error", code: string, message: string, context: Json = {}) {
  process.stderr.write(
    JSON.stringify({ timestamp: new Date().toISOString(), level, source: SOURCE, code, message, context }) + "\n",
  )
}

const LINKED = () =>
  new Fatal(EXIT_NOT_RUNNING, "DESCRIPTOR_UNSAFE", "the DATUM Studio descriptor is a link, not the file Swarm wrote")

/** The descriptor's text, read without following a link (SEC-14): lstat first, then open O_NOFOLLOW and fstat the fd. */
function readDescriptor(path: string) {
  let link
  try {
    link = lstatSync(path)
  } catch {
    throw new Fatal(EXIT_NOT_RUNNING, "HOST_NOT_RUNNING", "no DATUM Studio descriptor")
  }
  if (link.isSymbolicLink()) throw LINKED()
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw LINKED()
    throw new Fatal(EXIT_NOT_RUNNING, "HOST_NOT_RUNNING", "no DATUM Studio descriptor")
  }
  try {
    const stat = fstatSync(fd)
    // Swapped between lstat and open: not the file that was checked.
    if (stat.ino !== link.ino || stat.dev !== link.dev) throw LINKED()
    if (!stat.isFile() || stat.size > MAX_DESCRIPTOR_BYTES)
      throw new Fatal(EXIT_NOT_RUNNING, "DESCRIPTOR_INVALID", "the DATUM Studio descriptor is not a small regular file")
    // The token is a secret of this user: a descriptor others could read (or write) is not trusted.
    if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
      throw new Fatal(EXIT_NOT_RUNNING, "DESCRIPTOR_UNSAFE", "the DATUM Studio descriptor is not private to this user", {
        mode: (stat.mode & 0o777).toString(8),
      })
    return readFileSync(fd, "utf8")
  } finally {
    closeSync(fd)
  }
}

function readEndpoint(state: string): Endpoint {
  const fields: Record<string, string> = {}
  for (const line of readDescriptor(join(state, "swarm", DESCRIPTOR_FILE)).split("\n")) {
    const at = line.indexOf("=")
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1).replace(/\r$/, "")
  }
  const url = fields.URL ?? ""
  const token = fields.TOKEN ?? ""
  const pid = fields.PID ?? ""
  let parsed: URL | undefined
  try {
    parsed = new URL(url)
  } catch {}
  // Loopback only (spec §9.1): the Bearer token is never sent anywhere else.
  if (!parsed || parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || parsed.port === "")
    throw new Fatal(EXIT_NOT_RUNNING, "DESCRIPTOR_INVALID", "the DATUM Studio descriptor has no loopback URL")
  if (!TOKEN_RE.test(token) || !/^[0-9]+$/.test(pid))
    throw new Fatal(EXIT_NOT_RUNNING, "DESCRIPTOR_INVALID", "the DATUM Studio descriptor is incomplete")
  return { url: parsed.href, token, pid }
}

function isRequest(message: Json) {
  return typeof message.method === "string" && message.id !== undefined && message.id !== null
}

class Bridge {
  private sessionId: string | undefined
  private protocolVersion: string | undefined
  private initialized: Promise<void> | undefined
  private getStream = false
  private closing = false
  private readonly inflight = new Set<Promise<void>>()
  /** Row 54b: the client's initialize, replayed on a new endpoint; the generation counts endpoint swaps. */
  private initMessage: Json | undefined
  private generation = 0
  private reconnects = 0
  private reconnecting: Promise<void> | undefined

  constructor(
    private endpoint: Endpoint,
    private readonly state: string,
    private readonly agent: string,
    private readonly callerCwd: string,
  ) {}

  private headers(extra: Record<string, string>) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.endpoint.token}`,
      "x-studio-agent": this.agent,
      "x-studio-caller-cwd": encodeURIComponent(this.callerCwd),
      ...extra,
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId
    if (this.protocolVersion) headers["mcp-protocol-version"] = this.protocolVersion
    return headers
  }

  /** The protocol version the server chose rides on every later request (streamable-HTTP transport rule). */
  private noteProtocol(message: unknown) {
    const result = (message as Json)?.result as Json | undefined
    if (result && typeof result.protocolVersion === "string" && result.serverInfo !== undefined)
      this.protocolVersion = result.protocolVersion
  }

  private emit(message: unknown) {
    this.noteProtocol(message)
    process.stdout.write(JSON.stringify(message) + "\n")
  }

  private reply(message: Json, code: number, text: string) {
    if (isRequest(message)) this.emit({ jsonrpc: "2.0", id: message.id, error: { code, message: text } })
  }

  /** One message from stdin. Requests before the initialize answer wait for it (they need the session id). */
  handle(message: Json) {
    const isInit = message.method === "initialize"
    if (isInit) this.initMessage = message
    const run = async () => {
      if (!isInit && this.initialized) await this.initialized.catch(() => undefined)
      await this.post(message)
    }
    const task = run().catch((error: unknown) => {
      if (!(error instanceof Fatal)) this.reply(message, -32603, "the DATUM Studio bridge could not forward this message")
      this.fail(error)
    })
    if (isInit) this.initialized = task
    this.inflight.add(task)
    void task.finally(() => this.inflight.delete(task))
  }

  private async fetch(init: { method: string; headers: Record<string, string>; body?: string }) {
    try {
      // FX-4 (S2): no Bun idle cut at 300 s; the slow-call bounds are the host's 540 s and the client's 600 s.
      return await fetch(this.endpoint.url, { ...init, redirect: "error", ...BRIDGE_FETCH_OPTIONS } as RequestInit)
    } catch (error) {
      throw new Fatal(EXIT_NOT_RUNNING, "HOST_UNREACHABLE", "the DATUM Studio endpoint does not answer", {
        error: error instanceof Error ? error.name : "unknown",
      })
    }
  }

  /** A connection failure on the current endpoint: follow a changed descriptor once (row 54b). */
  private reconnect(cause: Fatal, generation: number): Promise<void> {
    // Another request already moved to a newer endpoint (or is doing so): just retry there.
    if (generation !== this.generation) return this.reconnecting ?? Promise.resolve()
    if (this.closing || this.reconnects >= BRIDGE_RECONNECT_ATTEMPTS) return Promise.reject(cause)
    this.reconnects += 1
    this.reconnecting = this.switchEndpoint(cause)
    return this.reconnecting
  }

  private async switchEndpoint(cause: Fatal) {
    const next = readEndpoint(this.state)
    if (next.url === this.endpoint.url && next.token === this.endpoint.token && next.pid === this.endpoint.pid) throw cause
    log("warn", "BRIDGE_RECONNECT", "the DATUM Studio endpoint changed; reconnecting once", {
      port: new URL(next.url).port,
      pid: next.pid,
    })
    this.endpoint = next
    this.generation += 1
    this.sessionId = undefined
    this.protocolVersion = undefined
    this.getStream = false
    if (!this.initMessage) return
    // Re-open the session on the new host with the client's own initialize; its answer stays inside the bridge.
    const init = this.initMessage
    const response = await this.fetch({
      method: "POST",
      headers: this.headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
      body: JSON.stringify(init),
    })
    this.checkFatal(response.status)
    if (!response.ok) {
      await response.body?.cancel()
      throw new Fatal(EXIT_NOT_RUNNING, "RECONNECT_FAILED", "the new DATUM Studio endpoint refused the session", {
        status: response.status,
      })
    }
    const sid = response.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid
    await this.forward(response, (message) => this.noteProtocol(message))
    const ready = await this.fetch({
      method: "POST",
      headers: this.headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    })
    this.checkFatal(ready.status)
    await ready.body?.cancel()
    void this.openGetStream()
  }

  private async post(message: Json, retried = false): Promise<void> {
    if (this.reconnecting) await this.reconnecting.catch(() => undefined)
    const generation = this.generation
    let response: Response
    try {
      response = await this.fetch({
        method: "POST",
        headers: this.headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
        body: JSON.stringify(message),
      })
    } catch (error) {
      if (retried || !(error instanceof Fatal) || error.code !== "HOST_UNREACHABLE") throw error
      await this.reconnect(error, generation)
      return this.post(message, true)
    }
    this.checkFatal(response.status)
    if (message.method === "initialize" && response.ok) {
      const sid = response.headers.get("mcp-session-id")
      if (sid) this.sessionId = sid
    }
    if (response.status === 202) {
      await response.body?.cancel()
      if (message.method === "notifications/initialized") void this.openGetStream()
      return
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      let error: Json | undefined
      try {
        error = (JSON.parse(text) as Json).error as Json | undefined
      } catch {}
      log("warn", "HTTP_ERROR", "the DATUM Studio endpoint refused a message", {
        status: response.status,
        method: message.method,
      })
      this.reply(
        message,
        typeof error?.code === "number" ? error.code : -32603,
        typeof error?.message === "string" ? error.message : `DATUM Studio endpoint answered HTTP ${response.status}`,
      )
      return
    }
    await this.forward(response)
  }

  /** 401/403: token rotated (Swarm restarted) or refused; 404 on a session: the host lost it (restart). */
  private checkFatal(status: number) {
    if (status === 401 || status === 403)
      throw new Fatal(EXIT_NOT_RUNNING, "TOKEN_REJECTED", "the DATUM Studio endpoint refused this bridge", { status })
    if (status === 404 && this.sessionId)
      throw new Fatal(EXIT_NOT_RUNNING, "SESSION_GONE", "the DATUM Studio session ended on the Swarm side")
  }

  private async forward(response: Response, sink: Sink = (message) => this.emit(message)) {
    const type = response.headers.get("content-type") ?? ""
    if (type.includes("text/event-stream")) {
      await this.readEvents(response, sink)
      return
    }
    const text = await response.text()
    if (text.trim() === "") return
    const body = JSON.parse(text) as unknown
    for (const item of Array.isArray(body) ? body : [body]) sink(item)
  }

  /** Server-sent events: each `message` event's data is one JSON-RPC message. */
  private async readEvents(response: Response, sink: Sink = (message) => this.emit(message)) {
    if (!response.body) return
    const decoder = new TextDecoder()
    let buffer = ""
    let data: string[] = []
    let event = "message"
    const dispatch = () => {
      if (data.length > 0 && event === "message") {
        try {
          sink(JSON.parse(data.join("\n")))
        } catch {
          log("warn", "SSE_PARSE", "an event from the DATUM Studio endpoint was not JSON")
        }
      }
      data = []
      event = "message"
    }
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true })
      let at: number
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, "")
        buffer = buffer.slice(at + 1)
        if (line === "") dispatch()
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""))
        else if (line.startsWith("event:")) event = line.slice(6).trim()
      }
    }
    dispatch()
  }

  /**
   * The standalone GET stream carries server-initiated messages. It also tells the bridge at once when Swarm quits:
   * an open stream that ends while stdin is still open means the host is gone (spec §9.5). 405 = not offered.
   */
  private async openGetStream() {
    if (this.getStream || !this.sessionId) return
    this.getStream = true
    const generation = this.generation
    let cause = new Fatal(EXIT_NOT_RUNNING, "HOST_GONE", "the DATUM Studio endpoint closed the session stream")
    try {
      const response = await this.fetch({ method: "GET", headers: this.headers({ accept: "text/event-stream" }) })
      if (response.status === 405 || !response.ok) {
        await response.body?.cancel()
        if (response.status !== 405) this.checkFatal(response.status)
        return
      }
      await this.readEvents(response)
    } catch (error) {
      if (this.closing) return
      if (error instanceof Fatal && error.code !== "HOST_UNREACHABLE") return this.fail(error)
      if (error instanceof Fatal) cause = error
    }
    if (this.closing || generation !== this.generation) return
    // Swarm restarted: follow the new descriptor once (row 54b), otherwise end as before (spec §9.5).
    await this.reconnect(cause, generation).catch((error: unknown) => this.fail(error))
  }

  fail(error: unknown) {
    if (this.closing) return
    if (error instanceof Fatal) return exit(error)
    log("error", "BRIDGE_FAILED", error instanceof Error ? error.message.replaceAll(this.endpoint.token, "[token]") : "unknown", {
      stack_trace: error instanceof Error ? error.stack?.replaceAll(this.endpoint.token, "[token]") : undefined,
    })
  }

  /** stdin closed: end the session on the host (best effort, 2 s), then exit 0. */
  async close() {
    if (this.closing) return
    this.closing = true
    if (this.sessionId) {
      const done = fetch(this.endpoint.url, { method: "DELETE", headers: this.headers({}) }).then(
        (r) => r.body?.cancel(),
        () => undefined,
      )
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 2000))])
    }
    process.exit(0)
  }
}

function exit(error: Fatal): never {
  if (error.exitCode === EXIT_NOT_RUNNING) process.stderr.write(START_SWARM_MESSAGE + "\n")
  log("error", error.code, error.message, error.context)
  process.exit(error.exitCode)
}

function main() {
  // Loopback only: a proxy from the caller's environment must never see the token (launcher unsets these too).
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"])
    delete process.env[name]
  const state = process.env.DATUM_STUDIO_STATE ?? ""
  const agent = process.env.STUDIO_AGENT_ID || "claude"
  const callerCwd = process.env.DATUM_STUDIO_CALLER_CWD ?? ""
  if (!AGENT_RE.test(agent)) exit(new Fatal(EXIT_MISCONFIGURED, "CONFIG_INVALID", "STUDIO_AGENT_ID is not 1..40 of A-Za-z0-9_.-"))
  if (!callerCwd.startsWith("/")) exit(new Fatal(EXIT_MISCONFIGURED, "CONFIG_INVALID", "DATUM_STUDIO_CALLER_CWD is not absolute"))
  if (!state.startsWith("/")) exit(new Fatal(EXIT_NOT_RUNNING, "HOST_NOT_RUNNING", "no Swarm state directory"))

  let endpoint: Endpoint
  try {
    endpoint = readEndpoint(state)
  } catch (error) {
    if (error instanceof Fatal) exit(error)
    throw error
  }
  const bridge = new Bridge(endpoint, state, agent, callerCwd)
  log("info", "BRIDGE_START", "bridge started", { agent, pid: endpoint.pid })

  let pending = ""
  process.stdin.on("data", (chunk: Buffer | string) => {
    pending += chunk.toString()
    let at: number
    while ((at = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, at).replace(/\r$/, "")
      pending = pending.slice(at + 1)
      if (line.trim() === "") continue
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        log("warn", "STDIN_PARSE", "a line on stdin was not JSON")
        continue
      }
      for (const message of Array.isArray(parsed) ? parsed : [parsed])
        if (message && typeof message === "object") bridge.handle(message as Json)
    }
  })
  process.stdin.on("end", () => void bridge.close())
  process.on("SIGTERM", () => void bridge.close())
  process.on("SIGINT", () => void bridge.close())
}

main()
