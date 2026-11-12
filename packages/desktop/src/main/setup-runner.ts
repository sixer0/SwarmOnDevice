import { spawn as nodeSpawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs"
import { userInfo } from "node:os"
import { isAbsolute, join } from "node:path"

// Runs the bundled swarm-setup (a `bun --compile` Mach-O, so not utilityProcess) from the main
// process. No shell, stdin closed, never as root, one run at a time. The consent gate stays inside
// swarm-setup: this module only turns the ids a person ticked into the one non-interactive form
// swarm-setup accepts, and reports its output as printed. Kept free of `electron` imports so the
// unit tests can load it; the IPC layer supplies the directory and the logger.

export const SETUP_DIR_NAME = "swarm-setup"
export const SETUP_BINARY_NAME = "swarm-setup"
export const SETUP_LOCK_NAME = "tools.lock.json"
export const SETUP_POLL_MS = 1000
// The one desktop copy of the state.json reading rule; onboarding.ts imports it (senior 1).
export const SETUP_STATE_MAX_BYTES = 262144
// Same ids and order as COMPONENT_IDS in packages/setup/src/constants.ts, which desktop does not import at
// runtime. setup-runner.test.ts fails if they drift.
export const SETUP_COMPONENT_IDS = ["runtime", "node", "graft", "rtk", "obsidian", "searxng", "firecrawl"] as const
// Per stream. The dry-run consent screen is tens of KB; anything past this is cut. The cut is logged and kept
// in SetupRun.truncated; the renderer receives the kept bytes only, without a marker.
export const SETUP_OUTPUT_MAX_BYTES = 1024 * 1024
// G-U14 Q2: recorded as `mode: app` in consent.log. Passed only when the bundled swarm-setup lists
// the flag in its usage text, so an older binary never sees an unknown flag (it would refuse).
export const SETUP_APP_MODE_ARGS = ["--consent-mode", "app"] as const
// 1.2.6 row 92b (TH-03, N-153): the only ids `swarm-setup start` accepts, and the only verb tool-health may reach.
// Same set as STARTABLE_COMPONENTS in packages/setup/src/estate/start.ts; setup-runner.test.ts fails if they drift.
export const SETUP_START_IDS = ["runtime", "searxng", "firecrawl"] as const
export const SETUP_START_VERB = "start"

// Same values as STATES in packages/setup/src/constants.ts; setup-runner.test.ts fails if they drift.
export const SETUP_STATE_VALUES: ReadonlySet<string> = new Set([
  "absent",
  "downloaded",
  "verified",
  "installed",
  "configured",
  "healthy",
  "failed",
  "skipped",
  "BLOCKED_BY_NETWORK",
])

export type SetupComponentId = (typeof SETUP_COMPONENT_IDS)[number]
export type SetupStartId = (typeof SETUP_START_IDS)[number]
export type SetupComponentStates = Partial<Record<SetupComponentId, string>>

export type SetupStep = { id: SetupComponentId; token: string; message?: string }

export type SetupRun = {
  kind: "ran"
  args: string[]
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  truncated: boolean
  result?: string
  steps: SetupStep[]
  wire: string[]
  states: SetupComponentStates
}

export type SetupRefusal = {
  kind: "refused"
  // `cancelled` comes from the IPC layer: the person pressed Cancel in main's native confirmation (C80 F1).
  // `no_start_verb` (row 92b): the bundled swarm-setup's usage text lists no `start` verb (an older binary).
  reason:
    | "root"
    | "busy"
    | "cancelled"
    | "nothing_selected"
    | "unknown_component"
    | "lock_unreadable"
    | "spawn_failed"
    | "no_start_verb"
  message?: string
  ids?: string[]
}

export type SetupResult = SetupRun | SetupRefusal

type Logger = {
  log(message: string, meta?: Record<string, unknown>): void
  error(message: string, meta?: Record<string, unknown>): void
}

type SpawnLike = typeof nodeSpawn

export type SetupRunnerDeps = {
  dir: string
  logger: Logger
  env?: NodeJS.ProcessEnv
  accountHome?: string
  getuid?: () => number | undefined
  spawn?: SpawnLike
  readLock?: (path: string) => Uint8Array
  pollMs?: number
}

export function setupDir(input: { packaged: boolean; resourcesPath: string; devRoot: string }) {
  return input.packaged
    ? join(input.resourcesPath, SETUP_DIR_NAME)
    : join(input.devRoot, "../../resources", SETUP_DIR_NAME)
}

// consent.ts expectedTokenValue: `<id>@<first 12 hex of sha256(tools.lock.json bytes)>`.
export function lockSha12(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12)
}

// Fail closed: one id outside the register refuses the whole request instead of being dropped.
export function tickedIds(ticked: readonly string[]) {
  const unknown = ticked.filter((id) => !(SETUP_COMPONENT_IDS as readonly string[]).includes(id))
  if (unknown.length > 0) return { ok: false as const, unknown: [...new Set(unknown)] }
  return { ok: true as const, ids: SETUP_COMPONENT_IDS.filter((id) => ticked.includes(id)) }
}

export function previewArgs() {
  return ["install", "--dry-run"]
}

// A token exists only for a ticked id; nothing else can turn into consent.
export function installArgs(ids: readonly SetupComponentId[], sha12: string, appMode: boolean) {
  return [
    "install",
    ...ids,
    "--non-interactive",
    ...ids.flatMap((id) => ["--terms-token", `${id}=${id}@${sha12}`]),
    ...(appMode ? SETUP_APP_MODE_ARGS : []),
  ]
}

export function supportsAppConsentMode(helpText: string) {
  return /^\s+--consent-mode app\b/m.test(helpText)
}

// Row 92b: start-only, one id, no flags. Nothing else is ever built for a revive (01c 4.7, 11.5).
export function startArgs(id: SetupStartId) {
  return [SETUP_START_VERB, id]
}

export function isSetupStartId(id: string): id is SetupStartId {
  return (SETUP_START_IDS as readonly string[]).includes(id)
}

// Feature detection, same pattern as supportsAppConsentMode: the usage line `  swarm-setup start <...>`.
export function supportsStartVerb(helpText: string) {
  return /^\s+swarm-setup start </m.test(helpText)
}

// HOME comes from the account. Only inside OPENCODE_TEST_ONBOARDING=1 may an absolute
// OPENCODE_TEST_SETUP_HOME replace it (same discipline as onboarding-test-root.ts).
// F4: the child sees only what swarm-setup and its downloads need, never the whole Electron main env
// (NODE_OPTIONS, DYLD_*, ELECTRON_*, launcher variables). HOME is always the resolved setup HOME. The two
// onboarding test variables pass only in onboarding test mode.
export const SETUP_ENV_ALLOW = [
  "PATH",
  "USER",
  "LANG",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const
const SETUP_TEST_ENV = ["OPENCODE_TEST_ONBOARDING", "OPENCODE_TEST_SETUP_HOME"] as const

export function setupChildEnv(env: NodeJS.ProcessEnv, home: string) {
  const allowed = [...SETUP_ENV_ALLOW, ...(env.OPENCODE_TEST_ONBOARDING === "1" ? SETUP_TEST_ENV : [])] as readonly string[]
  const kept = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && (allowed.includes(entry[0]) || entry[0].startsWith("LC_")),
  )
  return { ...Object.fromEntries(kept), HOME: home }
}

export function resolveSetupHome(env: NodeJS.ProcessEnv, accountHome: string) {
  const fixture = env.OPENCODE_TEST_SETUP_HOME
  if (env.OPENCODE_TEST_ONBOARDING === "1" && fixture !== undefined && isAbsolute(fixture)) return fixture
  return accountHome
}

export function setupStateFile(home: string) {
  return join(home, ".swarm", "setup", "state.json")
}

// Reads only components.<id>.state, and only register values. Missing, oversized, unreadable or
// malformed files give an empty record; no other string from the file leaves this function.
export function readSetupComponentStates(home: string): SetupComponentStates {
  let parsed: unknown
  try {
    const fd = openSync(setupStateFile(home), "r")
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > SETUP_STATE_MAX_BYTES) return {}
      parsed = JSON.parse(readFileSync(fd, "utf8"))
    } finally {
      closeSync(fd)
    }
  } catch {
    return {}
  }
  // F7: own properties only, so a polluted Object.prototype cannot supply components or states.
  const components = ownField(parsed, "components")
  if (!components || typeof components !== "object") return {}
  const states: SetupComponentStates = {}
  for (const id of SETUP_COMPONENT_IDS) {
    const state = ownField(ownField(components, id), "state")
    if (typeof state === "string" && SETUP_STATE_VALUES.has(state)) states[id] = state
  }
  return states
}

// The offer rule (row 226): which ids state.json records as `healthy`, in register order.
export function readHealthySetupComponents(home: string) {
  const states = readSetupComponentStates(home)
  return SETUP_COMPONENT_IDS.filter((id) => states[id] === "healthy")
}

function ownField(value: unknown, key: string) {
  if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
  return (value as Record<string, unknown>)[key]
}

// The `step <id>: <TOKEN>[ — message]`, `wire...` and `RESULT <TOKEN>` lines swarm-setup prints.
export function parseSetupOutput(stdout: string) {
  const steps: SetupStep[] = []
  const wire: string[] = []
  let result: string | undefined
  for (const line of stdout.split("\n")) {
    const step = /^step (\w+): ([A-Z_]+)(?: — (.*))?$/.exec(line)
    if (step && (SETUP_COMPONENT_IDS as readonly string[]).includes(step[1]!)) {
      steps.push({ id: step[1] as SetupComponentId, token: step[2]!, ...(step[3] ? { message: step[3] } : {}) })
      continue
    }
    if (line.startsWith("wire")) wire.push(line)
    const end = /^RESULT ([A-Z_]+)$/.exec(line)
    if (end) result = end[1]
  }
  return { steps, wire, result }
}

export function createSetupRunner(deps: SetupRunnerDeps) {
  const env = deps.env ?? process.env
  const home = resolveSetupHome(env, deps.accountHome ?? userInfo().homedir)
  const binary = join(deps.dir, SETUP_BINARY_NAME)
  const lockPath = join(deps.dir, SETUP_LOCK_NAME)
  const spawn = deps.spawn ?? nodeSpawn
  const getuid = deps.getuid ?? (() => (typeof process.getuid === "function" ? process.getuid() : undefined))
  const readLock = deps.readLock ?? ((path: string) => new Uint8Array(readFileSync(path)))
  const pollMs = deps.pollMs ?? SETUP_POLL_MS
  let running = false
  let current: { pid?: number; args: string[] } | undefined
  let help: Promise<string | undefined> | undefined

  function refuse(reason: SetupRefusal["reason"], extra: Omit<SetupRefusal, "kind" | "reason"> = {}): SetupRefusal {
    deps.logger.error("swarm-setup run refused", { reason, ...extra })
    return { kind: "refused", reason, ...extra }
  }

  function exec(args: string[], onProgress?: (states: SetupComponentStates) => void) {
    deps.logger.log("swarm-setup started", { binary, args })
    return new Promise<SetupResult>((resolve) => {
      // Buffers are decoded once at the end, so a multi-byte character split across chunks survives.
      const out = { chunks: { stdout: [] as Buffer[], stderr: [] as Buffer[] }, bytes: { stdout: 0, stderr: 0 }, truncated: false }
      let last = ""
      const emit = () => {
        if (!onProgress) return
        const states = readSetupComponentStates(home)
        const key = JSON.stringify(states)
        if (key === last) return
        last = key
        onProgress(states)
      }
      const timer = onProgress ? setInterval(emit, pollMs) : undefined
      const child = spawn(binary, args, {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: setupChildEnv(env, home),
        cwd: home,
        windowsHide: true,
      })
      const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
        const room = SETUP_OUTPUT_MAX_BYTES - out.bytes[stream]
        if (room <= 0) {
          out.truncated = true
          return
        }
        const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
        if (kept.length < chunk.length) out.truncated = true
        out.bytes[stream] += kept.length
        out.chunks[stream].push(kept)
      }
      current = { pid: child.pid, args }
      child.stdout?.on("data", collect("stdout"))
      child.stderr?.on("data", collect("stderr"))
      let settled = false
      child.on("error", (error) => {
        if (settled) return
        settled = true
        current = undefined
        if (timer) clearInterval(timer)
        resolve(refuse("spawn_failed", { message: error.message }))
      })
      child.on("close", (code, signal) => {
        if (settled) return
        settled = true
        current = undefined
        if (timer) clearInterval(timer)
        emit()
        const stdout = Buffer.concat(out.chunks.stdout).toString("utf8")
        const stderr = Buffer.concat(out.chunks.stderr).toString("utf8")
        const parsed = parseSetupOutput(stdout)
        const run: SetupRun = {
          kind: "ran",
          args,
          exitCode: code,
          signal: signal ?? null,
          stdout,
          stderr,
          truncated: out.truncated,
          ...parsed,
          states: readSetupComponentStates(home),
        }
        const meta = { args, exitCode: code, signal, result: parsed.result, steps: parsed.steps, truncated: out.truncated }
        if (code === 0) deps.logger.log("swarm-setup finished", meta)
        else deps.logger.error("swarm-setup finished", { ...meta, stderr: stderr.slice(0, 4096) })
        resolve(run)
      })
    })
  }

  async function exclusive(work: () => Promise<SetupResult>) {
    if (getuid() === 0) return refuse("root")
    if (running) return refuse("busy")
    running = true
    try {
      return await work()
    } finally {
      running = false
    }
  }

  // The bundled binary's usage text, read once per runner (it cannot change while the app runs).
  function helpText() {
    help ??= exec(["--help"]).then((r) => (r.kind === "ran" && r.exitCode === 0 ? r.stdout : undefined))
    return help
  }

  async function probeAppMode() {
    const text = await helpText()
    return text !== undefined && supportsAppConsentMode(text)
  }

  return {
    home,
    busy: () => running,
    // Senior 16 (decision in implementation/245): no timeout and no kill. Stopping swarm-setup mid-install can
    // leave a half-written component, so a run still going at quit is left to finish and only its PID is logged;
    // the next launch then sees REFUSED_CONCURRENCY from swarm-setup's own lock until it ends.
    dispose: () => {
      if (current) deps.logger.error("swarm-setup still running at quit, left to finish", current)
    },
    state: () => readSetupComponentStates(home),
    preview: () => exclusive(() => exec(previewArgs())),
    install: (ticked: readonly string[], onProgress?: (states: SetupComponentStates) => void) =>
      exclusive(async () => {
        const selection = tickedIds(ticked)
        if (!selection.ok) return refuse("unknown_component", { ids: selection.unknown })
        if (selection.ids.length === 0) return refuse("nothing_selected")
        let sha12: string
        try {
          sha12 = lockSha12(readLock(lockPath))
        } catch (error) {
          return refuse("lock_unreadable", { message: error instanceof Error ? error.message : String(error) })
        }
        return exec(installArgs(selection.ids, sha12, await probeAppMode()), onProgress)
      }),
    // Row 92b (TH-03): the tool-health web revive. Shares the one-run-at-a-time lock, so a revive during a
    // person's install is refused `busy`. The verb is start-only (swarm-setup never installs, pulls or recreates
    // on it); an older binary without it is refused `no_start_verb` and never sent another verb.
    start: (id: SetupStartId) =>
      exclusive(async () => {
        if (!isSetupStartId(id)) return refuse("unknown_component", { ids: [String(id)] })
        const text = await helpText()
        if (text === undefined || !supportsStartVerb(text)) return refuse("no_start_verb")
        return exec(startArgs(id))
      }),
  }
}

export type SetupRunner = ReturnType<typeof createSetupRunner>
