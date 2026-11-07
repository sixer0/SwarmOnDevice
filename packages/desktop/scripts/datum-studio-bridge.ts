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
 * Exit codes: 0 stdin closed; 3 Swarm not running / endpoint gone / token rejected (prints START_SWARM_MESSAGE, spec
 * §9.5); 4 misconfigured bundle or environment.
 * Logging: one JSON record per line on stderr (timestamp, level, source, code, message, context). The MCP client keeps a
 * server's stderr in its own log (Claude Code's MCP log, Swarm's sidecar log), which is the durable copy.
 */
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"

const START_SWARM_MESSAGE =
  "DATUM Studio runs inside the Swarm app. Start Swarm, then reconnect this MCP server (Claude Code: /mcp)."
const EXIT_NOT_RUNNING = 3
const EXIT_MISCONFIGURED = 4
const DESCRIPTOR_FILE = "datum-studio.env"
const MAX_DESCRIPTOR_BYTES = 4096
const AGENT_RE = /^[A-Za-z0-9_.-]{1,40}$/
const TOKEN_RE = /^[A-Za-z0-9._~+/-]{32,512}$/
const SOURCE = "datum-studio-bridge"

type Json = Record<string, unknown>
type Endpoint = { url: string; token: string; pid: string }

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

function readEndpoint(state: string): Endpoint {
  const path = join(state, "swarm", DESCRIPTOR_FILE)
  let stat
  try {
    stat = statSync(path)
  } catch {
    throw new Fatal(EXIT_NOT_RUNNING, "HOST_NOT_RUNNING", "no DATUM Studio descriptor")
  }
  if (!stat.isFile() || stat.size > MAX_DESCRIPTOR_BYTES)
    throw new Fatal(EXIT_NOT_RUNNING, "DESCRIPTOR_INVALID", "the DATUM Studio descriptor is not a small regular file")
  // The token is a secret of this user: a descriptor others could read (or write) is not trusted.
  if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
    throw new Fatal(EXIT_NOT_RUNNING, "DESCRIPTOR_UNSAFE", "the DATUM Studio descriptor is not private to this user", {
      mode: (stat.mode & 0o777).toString(8),
    })
  const fields: Record<string, string> = {}
  for (const line of readFileSync(path, "utf8").split("\n")) {
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

  constructor(
    private readonly endpoint: Endpoint,
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

  private emit(message: unknown) {
    const record = message as Json
    // The protocol version the server chose rides on every later request (streamable-HTTP transport rule).
    const result = record?.result as Json | undefined
    if (result && typeof result.protocolVersion === "string" && result.serverInfo !== undefined)
      this.protocolVersion = result.protocolVersion
    process.stdout.write(JSON.stringify(message) + "\n")
  }

  private reply(message: Json, code: number, text: string) {
    if (isRequest(message)) this.emit({ jsonrpc: "2.0", id: message.id, error: { code, message: text } })
  }

  /** One message from stdin. Requests before the initialize answer wait for it (they need the session id). */
  handle(message: Json) {
    const isInit = message.method === "initialize"
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
      return await fetch(this.endpoint.url, { ...init, redirect: "error" })
    } catch (error) {
      throw new Fatal(EXIT_NOT_RUNNING, "HOST_UNREACHABLE", "the DATUM Studio endpoint does not answer", {
        error: error instanceof Error ? error.name : "unknown",
      })
    }
  }

  private async post(message: Json) {
    const response = await this.fetch({
      method: "POST",
      headers: this.headers({ "content-type": "application/json", accept: "application/json, text/event-stream" }),
      body: JSON.stringify(message),
    })
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

  private async forward(response: Response) {
    const type = response.headers.get("content-type") ?? ""
    if (type.includes("text/event-stream")) {
      await this.readEvents(response)
      return
    }
    const text = await response.text()
    if (text.trim() === "") return
    const body = JSON.parse(text) as unknown
    for (const item of Array.isArray(body) ? body : [body]) this.emit(item)
  }

  /** Server-sent events: each `message` event's data is one JSON-RPC message. */
  private async readEvents(response: Response) {
    if (!response.body) return
    const decoder = new TextDecoder()
    let buffer = ""
    let data: string[] = []
    let event = "message"
    const dispatch = () => {
      if (data.length > 0 && event === "message") {
        try {
          this.emit(JSON.parse(data.join("\n")))
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
      if (error instanceof Fatal) return this.fail(error)
    }
    if (!this.closing)
      this.fail(new Fatal(EXIT_NOT_RUNNING, "HOST_GONE", "the DATUM Studio endpoint closed the session stream"))
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
  const bridge = new Bridge(endpoint, agent, callerCwd)
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
