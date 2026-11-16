// Row M5-04 L2 harness (test strategy §7.1; register §10 test ports; decisions C39, C42, C45).
//
// Pieces, each started and stopped by the test file that uses them:
// - sidecar: a real `opencode serve` from source (`packages/opencode/src/index.ts`) on 127.0.0.1:55317, in its own
//   process group, with HOME/XDG pinned under the run dir, a per-run random password and OPENCODE_CONFIG_CONTENT that
//   points the only provider at the scripted LLM (l2-scripted-llm.ts). Never the installed Swarm app or its server.
// - bridge: the real utility-process runner (`runOfficeBridge` from src/main/office-bridge.ts) with its default
//   factory, i.e. `createOfficeBridgeFactory({ routes: createBridgeRoutes() })`, driven through a fake `parentPort`
//   with the same protocol messages main sends (`start`, `pair-decision`, `pairings-cleared`, `stop`).
// - TLS: a test CA and leaf from the production cert code (certs.ts `createCa` / `issueLeaf`), in memory plus `ca.pem`
//   in the run dir for curl. Nothing touches the keychain.
// - clients: `node:https` with `servername: "localhost"` and a `Host` header chosen per call, so a request can go to
//   either listener (127.0.0.1 or ::1) with the Host Office sends. Chain verification is done by curl (finding F-2,
//   see `requestOptions`).
//
// Secrets: the run password and pairing tokens stay in memory. Sidecar and bridge output go to files in the run dir,
// which afterAll removes.
import { spawn, type ChildProcess } from "node:child_process"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createWriteStream } from "node:fs"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { runOfficeBridge, type OfficeBridgeParentPort } from "../../src/main/office-bridge"
import { createCa, issueLeaf } from "../../src/main/office-addin/certs"
import type { BridgeCommand, BridgeMessage, LeafTls, PairRequest } from "../../src/main/office-bridge/protocol"

export const L2_BRIDGE_PORT = 47317
export const L2_SQUAT_PORT = 47318
export const L2_SIDECAR_PORT = 55317
export const L2_PORTS = [L2_BRIDGE_PORT, L2_SQUAT_PORT, L2_SIDECAR_PORT, 55318] as const
export const L2_ENABLED = process.env.SWARM_OFFICE_IT === "1"
export const L2_USERNAME = "opencode"

const OPENCODE_DIR = resolve(import.meta.dir, "../../../opencode")

// ── Run directory ──

export type RunDir = {
  /** realpath of the run dir (macOS $TMPDIR is under the /var -> /private/var symlink). */
  root: string
  /** The same dir as `tmpdir()` spells it (not realpathed); used by the C39 symlink check. */
  spelled: string
  home: string
  logs: string
}

export async function createRunDir(): Promise<RunDir> {
  const spelled = await mkdtemp(join(tmpdir(), "swo-it-"))
  const root = await realpath(spelled)
  const home = join(root, "home")
  const logs = join(root, "logs")
  for (const dir of [home, join(home, ".config"), join(home, ".local/share"), join(home, ".local/state"), join(home, ".cache"), logs])
    await mkdir(dir, { recursive: true })
  return { root, spelled, home, logs }
}

export async function removeRunDir(run: RunDir | undefined) {
  if (!run) return
  await rm(run.root, { recursive: true, force: true })
}

// ── Ports ──

/** "open" when something accepts on host:port, else the error code (ECONNREFUSED when nothing listens). */
export function probePort(host: string, port: number) {
  return new Promise<string>((done) => {
    const socket = net.connect({ host, port })
    socket.once("connect", () => {
      socket.destroy()
      done("open")
    })
    socket.once("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"))
  })
}

/** Fails fast when any L2 port is busy (C42: never collide with another agent's or the app's listeners). */
export async function assertPortsFree() {
  const busy = (
    await Promise.all(
      L2_PORTS.flatMap((port) => ["127.0.0.1", "::1"].map(async (host) => ({ port, host, state: await probePort(host, port) }))),
    )
  ).filter((entry) => entry.state === "open")
  if (busy.length > 0) throw new Error(`L2 ports busy: ${busy.map((entry) => `${entry.host}:${entry.port}`).join(", ")}`)
}

export async function waitFor<T>(check: () => Promise<T | undefined> | T | undefined, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await check()
    if (value !== undefined) return value
    await Bun.sleep(100)
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
}

// ── Sidecar ──

export type SidecarOptions = {
  run: RunDir
  password: string
  llmUrl: string
  /** Extra top-level opencode config merged over the scripted-provider config (I-BR-11 uses a permissive owner config). */
  config?: Record<string, unknown>
  /** M5-05/M6-02: env overrides over the §7.1 set; `undefined` removes a variable (sd1-profile loads project files). */
  env?: Record<string, string | undefined>
}

export type Sidecar = {
  readonly url: string
  readonly logPath: string
  /** Basic auth header value for direct sidecar calls (tests only; never logged). */
  readonly authorization: string
  /** Direct call on the sidecar, bypassing the bridge (I-BR-07 checks). */
  call(path: string, init?: RequestInit): Promise<Response>
  stop(): Promise<void>
}

function sidecarConfig(llmUrl: string, extra: Record<string, unknown> = {}) {
  return {
    formatter: false,
    lsp: false,
    model: "l2/scripted",
    small_model: "l2/scripted",
    provider: {
      l2: {
        name: "L2 scripted",
        id: "l2",
        env: [],
        npm: "@ai-sdk/openai-compatible",
        models: {
          scripted: {
            id: "scripted",
            name: "L2 scripted",
            attachment: false,
            reasoning: false,
            temperature: false,
            tool_call: true,
            release_date: "2025-01-01",
            limit: { context: 100000, output: 10000 },
            cost: { input: 0, output: 0 },
            options: {},
          },
        },
        options: { apiKey: "l2-not-a-key", baseURL: llmUrl },
      },
    },
    ...extra,
  }
}

/** Children still alive (process groups), killed synchronously if the test process exits early. */
const liveGroups = new Set<number>()
process.on("exit", () => {
  for (const pid of liveGroups) {
    try {
      process.kill(-pid, "SIGKILL")
    } catch {
      // already gone
    }
  }
})

function exited(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise<void>((done) => child.once("exit", () => done()))
}

/** SIGTERM to the whole group, SIGKILL after 5 s (strategy §7.1 cleanup). */
async function stopGroup(child: ChildProcess) {
  const pid = child.pid
  if (pid === undefined) return
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-pid, name)
    } catch {
      // group already gone
    }
  }
  signal("SIGTERM")
  const done = await Promise.race([exited(child).then(() => true), Bun.sleep(5_000).then(() => false)])
  if (!done) signal("SIGKILL")
  // Children of the group (if any) get the KILL too, even when the leader exited on TERM.
  signal("SIGKILL")
  await exited(child)
  liveGroups.delete(pid)
}

export async function startSidecar(options: SidecarOptions): Promise<Sidecar> {
  const { run, password } = options
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: run.home,
    OPENCODE_TEST_HOME: run.home,
    XDG_CONFIG_HOME: join(run.home, ".config"),
    XDG_DATA_HOME: join(run.home, ".local/share"),
    XDG_STATE_HOME: join(run.home, ".local/state"),
    XDG_CACHE_HOME: join(run.home, ".cache"),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(sidecarConfig(options.llmUrl, options.config)),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_PURE: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_AUTH_CONTENT: "{}",
    OPENCODE_SERVER_PASSWORD: password,
    no_proxy: "localhost,127.0.0.1,::1",
    NO_PROXY: "localhost,127.0.0.1,::1",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[name]
    if (value !== undefined) env[name] = value
  }
  const logPath = join(run.logs, "sidecar.log")
  const out = createWriteStream(logPath, { flags: "a" })
  const child = spawn(
    process.execPath,
    ["run", "./src/index.ts", "serve", "--hostname", "127.0.0.1", "--port", String(L2_SIDECAR_PORT)],
    { cwd: OPENCODE_DIR, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  )
  if (child.pid !== undefined) liveGroups.add(child.pid)
  child.stdout?.pipe(out)
  child.stderr?.pipe(out)

  const url = `http://127.0.0.1:${L2_SIDECAR_PORT}`
  const authorization = `Basic ${Buffer.from(`${L2_USERNAME}:${password}`).toString("base64")}`
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${url}${path}`, { ...init, headers: { authorization, ...(init.headers as Record<string, string> | undefined) } })

  const sidecar: Sidecar = {
    url,
    logPath,
    authorization,
    call,
    async stop() {
      await stopGroup(child)
      out.end()
    },
  }

  await waitFor(
    async () => {
      if (child.exitCode !== null) throw new Error(`sidecar exited early (${child.exitCode}); see ${logPath}`)
      const response = await call("/global/health").catch(() => undefined)
      return response?.status === 200 ? true : undefined
    },
    120_000,
    "sidecar /global/health",
  ).catch(async (error: unknown) => {
    await sidecar.stop()
    throw error
  })
  return sidecar
}

// ── TLS ──

export type TestTls = { ca: string; leaf: LeafTls; caPath: string }

export async function createTestTls(run: RunDir): Promise<TestTls> {
  const now = new Date()
  const ca = await createCa(now)
  const leaf = await issueLeaf(ca, now)
  const caPath = join(run.root, "ca.pem")
  await writeFile(caPath, ca.cert, { mode: 0o600 })
  return { ca: ca.cert, leaf, caPath }
}

// ── Bridge ──

export type DecisionMode = "allow" | "deny" | "manual"

export type BridgeLogLine = { level: string; source: string; message: string; context?: Record<string, unknown> }

export type Bridge = {
  readonly messages: BridgeMessage[]
  readonly pairRequests: PairRequest[]
  readonly logs: BridgeLogLine[]
  readonly logPath: string
  readonly userDataDir: string
  readonly workspace: string
  /** How the fake main answers `pair-request` (async, like the dialog). */
  decisions: DecisionMode
  send(command: BridgeCommand): void
  stop(): Promise<void>
}

export type BridgeOptions = {
  run: RunDir
  tls: TestTls
  password: string
  /** Defaults to `<run.root>/userData`. */
  userDataDir?: string
  decisions?: DecisionMode
  /** M5-05 (I-BR-16): copy this built pane (`packages/office-addin/dist/pane`) instead of the stub page. */
  paneDir?: string
}

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const userDataDir = options.userDataDir ?? join(options.run.root, "userData")
  const resourcesDir = join(options.run.root, "resources")
  await mkdir(userDataDir, { recursive: true })
  // A stub pane so the entry does not warn PANE_ROOT_MISSING (the built pane is M5-05 / I-BR-16's concern).
  await mkdir(join(resourcesDir, "office-addin", "pane"), { recursive: true })
  if (options.paneDir) await cp(options.paneDir, join(resourcesDir, "office-addin", "pane"), { recursive: true })
  if (!options.paneDir)
    await writeFile(join(resourcesDir, "office-addin", "pane", "index.html"), "<!doctype html><title>L2</title>\n")

  const logPath = join(options.run.logs, "bridge.log")
  const logFile = createWriteStream(logPath, { flags: "a" })
  const messages: BridgeMessage[] = []
  const pairRequests: PairRequest[] = []
  const logs: BridgeLogLine[] = []
  const listeners: ((event: { data: unknown }) => void)[] = []
  const state = { decisions: options.decisions ?? ("allow" as DecisionMode) }
  const send = (command: BridgeCommand) => listeners.forEach((listener) => listener({ data: command }))

  let stopped: () => void = () => {}
  const stoppedPromise = new Promise<void>((done) => (stopped = done))
  let fatal: () => void = () => {}
  const fatalPromise = new Promise<void>((done) => (fatal = done))

  const port: OfficeBridgeParentPort = {
    postMessage(message) {
      messages.push(message)
      if (message.type !== "pair-request") return
      pairRequests.push({ requestId: message.requestId, host: message.host, code: message.code })
      if (state.decisions === "manual") return
      const allow = state.decisions === "allow"
      // Main answers after the user clicks; never synchronously inside the request handler.
      setTimeout(() => send({ type: "pair-decision", requestId: message.requestId, allow }), 20)
    },
    on(_event, listener) {
      listeners.push(listener)
    },
  }

  runOfficeBridge(port, {
    log: (level, source, message, context) => {
      logs.push({ level, source, message, ...(context ? { context } : {}) })
      logFile.write(JSON.stringify({ level, source, message, ...(context ? { context } : {}) }) + "\n")
    },
    onStopped: () => stopped(),
    onFatal: () => fatal(),
  })

  send({
    type: "start",
    serverUrl: `http://127.0.0.1:${L2_SIDECAR_PORT}`,
    username: L2_USERNAME,
    password: options.password,
    userDataDir,
    resourcesDir,
    port: L2_BRIDGE_PORT,
    cert: options.tls.leaf.cert,
    key: options.tls.leaf.key,
  })

  const first = await Promise.race([
    waitFor(() => messages.find((message) => message.type === "ready" || message.type === "failed"), 15_000, "bridge ready"),
    fatalPromise.then(() => ({ type: "fatal" as const })),
  ])
  if (first.type !== "ready") throw new Error(`bridge did not start: ${JSON.stringify(first)}`)

  return {
    messages,
    pairRequests,
    logs,
    logPath,
    userDataDir,
    workspace: join(userDataDir, "office-addin", "workspace"),
    get decisions() {
      return state.decisions
    },
    set decisions(value: DecisionMode) {
      state.decisions = value
    },
    send,
    async stop() {
      send({ type: "stop" })
      await Promise.race([
        stoppedPromise,
        Bun.sleep(10_000).then(() => {
          throw new Error("bridge stop timed out")
        }),
      ])
      logFile.end()
    },
  }
}

// ── HTTPS client ──

export type Listener = "127.0.0.1" | "::1"
export const LISTENERS: readonly Listener[] = ["127.0.0.1", "::1"]

export type ClientResponse = {
  status: number
  headers: Record<string, string | string[] | undefined>
  text: string
  json(): unknown
}

export type ClientRequest = {
  method?: string
  path: string
  /** Connect address; default `::1` (the production path on this Mac, D2/C22). */
  listener?: Listener
  /** Host header; default `localhost:47317` (what Office sends). `null` asks for none, but Bun still adds one (use curl). */
  host?: string | null
  /** Adds `X-Swarm-Office: 1` unless false. */
  csrf?: boolean
  token?: string
  headers?: Record<string, string>
  /** JSON-serialised unless a string. */
  body?: unknown
  timeoutMs?: number
}

function requestOptions(tls: TestTls, request: ClientRequest) {
  const body = request.body === undefined ? undefined : typeof request.body === "string" ? request.body : JSON.stringify(request.body)
  const headers: Record<string, string> = {
    ...(request.host === null ? {} : { host: request.host ?? `localhost:${L2_BRIDGE_PORT}` }),
    ...(request.csrf === false ? {} : { "x-swarm-office": "1" }),
    ...(request.token === undefined ? {} : { "x-swarm-office-token": request.token }),
    ...(body === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) }),
    ...request.headers,
  }
  return {
    body,
    options: {
      host: request.listener ?? "::1",
      port: L2_BRIDGE_PORT,
      method: request.method ?? "GET",
      path: request.path,
      headers,
      ca: tls.ca,
      servername: "localhost",
      // Bun's TLS client (BoringSSL) refuses the production CA with UNSUPPORTED_CONSTRAINT_TYPE (its name constraints:
      // DNS localhost + loopback IP subtrees), while OpenSSL 3.5 (Node 26, `openssl verify`) and curl accept the same
      // chain (M5-04 finding F-2). Bun also returns no peer certificate, so pinning is not possible either. The request
      // tests therefore skip chain verification here; the chain and the name check are covered by curl in I-BR-03.
      rejectUnauthorized: false,
      agent: false as const,
      setHost: false,
    },
  }
}

export function bridgeRequest(tls: TestTls, request: ClientRequest) {
  const { body, options } = requestOptions(tls, request)
  return new Promise<ClientResponse>((done, fail) => {
    const req = https.request(options, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        done({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => JSON.parse(text) })
      })
      res.on("error", fail)
    })
    req.setTimeout(request.timeoutMs ?? 30_000, () => req.destroy(new Error(`request timed out: ${request.path}`)))
    req.on("error", fail)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// ── SSE client ──

export type SseFrame = { at: number; data: unknown; raw: string }

export type SseStream = {
  readonly status: number
  readonly headers: Record<string, string | string[] | undefined>
  readonly frames: SseFrame[]
  readonly ended: boolean
  waitFor(predicate: (frame: SseFrame) => boolean, timeoutMs: number, what: string): Promise<SseFrame>
  close(): void
}

/** Opens `/swarm/event` (P8) through the bridge and parses `data:` frames as JSON. */
export function openEvents(tls: TestTls, request: Omit<ClientRequest, "path" | "method" | "body">) {
  const { options } = requestOptions(tls, { ...request, path: "/swarm/event", headers: { accept: "text/event-stream", ...request.headers } })
  return new Promise<SseStream>((done, fail) => {
    const req = https.request(options, (res) => {
      const frames: SseFrame[] = []
      const state = { buffer: "", ended: false }
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        state.buffer += chunk
        const blocks = state.buffer.split("\n\n")
        state.buffer = blocks.pop() ?? ""
        for (const block of blocks) {
          const data = block
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n")
          if (data === "") continue
          const parsed = (() => {
            try {
              return JSON.parse(data) as unknown
            } catch {
              return data
            }
          })()
          frames.push({ at: performance.now(), data: parsed, raw: block })
        }
      })
      res.on("end", () => (state.ended = true))
      res.on("close", () => (state.ended = true))
      res.on("error", () => (state.ended = true))
      done({
        status: res.statusCode ?? 0,
        headers: res.headers,
        frames,
        get ended() {
          return state.ended
        },
        waitFor: (predicate, timeoutMs, what) =>
          waitFor(() => frames.find(predicate), timeoutMs, what),
        close: () => req.destroy(),
      })
    })
    req.on("error", fail)
    req.end()
  })
}

/** Event helpers over the opencode bus payload `{ type, properties }`. */
export function eventType(frame: SseFrame) {
  const data = frame.data
  if (typeof data !== "object" || data === null || !("type" in data)) return
  return typeof data.type === "string" ? data.type : undefined
}

export function eventProps(frame: SseFrame): Record<string, unknown> {
  const data = frame.data
  if (typeof data !== "object" || data === null || !("properties" in data)) return {}
  const props = data.properties
  return typeof props === "object" && props !== null ? (props as Record<string, unknown>) : {}
}

/** `session.idle`, or `session.status` with status idle, for one session. */
export function isIdle(sessionID: string) {
  return (frame: SseFrame) => {
    const type = eventType(frame)
    const props = eventProps(frame)
    if (props.sessionID !== sessionID) return false
    if (type === "session.idle") return true
    if (type !== "session.status") return false
    const status = props.status
    return typeof status === "object" && status !== null && "type" in status && status.type === "idle"
  }
}

// ── curl / openssl (I-BR-03) ──

export async function runTool(argv: string[], timeoutMs = 15_000) {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const exit = await child.exited
  clearTimeout(timer)
  return { exit, out, err }
}

/** Random password for one run; never printed. */
export function runPassword() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex")
}

// ── Raw TLS exchange (M5-05: header-first rejection, oversized bodies) ──

export type RawExchange = {
  /** Status code of the first response line, or 0 when none arrived. */
  status: number
  text: string
  /** ms from connect to the first response byte (or to the end when none arrived). */
  firstByteMs: number
  /** Bytes of `body` the socket accepted before the bridge answered or closed. */
  written: number
}

/**
 * Writes `head` (request line + headers + blank line, CRLF) and then, unless `body` is undefined, the body in 64 KiB
 * slices, over TLS without chain verification (finding F-2). Resolves when the server closes or `waitMs` passes after
 * the first response byte. Write errors after the answer (the bridge closing early) are expected and ignored.
 */
export function rawExchange(input: { head: string; body?: Uint8Array; listener?: Listener; waitMs?: number; timeoutMs?: number }) {
  return new Promise<RawExchange>((done) => {
    const started = performance.now()
    const state = { text: "", first: 0, written: 0, settled: false }
    const socket = tls.connect({
      host: input.listener ?? "::1",
      port: L2_BRIDGE_PORT,
      servername: "localhost",
      rejectUnauthorized: false,
    })
    const finish = () => {
      if (state.settled) return
      state.settled = true
      clearTimeout(timer)
      socket.destroy()
      const match = /^HTTP\/1\.[01] ([0-9]{3})/.exec(state.text)
      done({
        status: match ? Number(match[1]) : 0,
        text: state.text,
        firstByteMs: (state.first || performance.now()) - started,
        written: state.written,
      })
    }
    const timer = setTimeout(finish, input.timeoutMs ?? 15_000)
    socket.setEncoding("latin1")
    socket.on("data", (chunk: string) => {
      if (state.first === 0) {
        state.first = performance.now()
        setTimeout(finish, input.waitMs ?? 300)
      }
      state.text += chunk
    })
    socket.on("error", () => {})
    socket.on("close", finish)
    socket.once("secureConnect", async () => {
      socket.write(input.head)
      const body = input.body
      if (body === undefined) return
      for (let offset = 0; offset < body.byteLength && !state.settled && state.first === 0; offset += 65_536) {
        const slice = body.subarray(offset, Math.min(offset + 65_536, body.byteLength))
        const flushed = socket.write(slice)
        state.written += slice.byteLength
        if (!flushed)
          await new Promise<void>((resume) => {
            socket.once("drain", () => resume())
            socket.once("close", () => resume())
          })
      }
    })
  })
}
