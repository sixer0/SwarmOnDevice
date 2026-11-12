// TH-02 / SEC-05 / SEC-16 (1.2.6 row 91): createToolHealth (N-185), the startup binding of the tool-health regime.
//
// index.ts calls `void toolHealth.runStartup()` right after `void datumStudio.start()`; it is never awaited on the
// ready path, runs once per launch (a second call returns the same promise) and catches every error itself. After the
// startup pass it watches ~/.swarm/health for recheck.json (agent trigger) and `recheck()` serves the "Re-check Tools"
// menu item (person trigger). `stop()` (before-quit) lets no new probe or revive start; a child that already runs
// (`swarm-setup start`, a user argv) is never killed.
//
// Revive paths (the only ones; never installs, 01c section 7):
// - builtin `compose-start`  -> `setupRunner().start(id)` of the shared setup runner, id in runtime|searxng|firecrawl.
//   The runner verb is added by rows 92a/92b. Without it the result is `revive_failed` `SETUP_NO_START_VERB`.
// - builtin `render-bridge-restart` -> `datumStudio.reviveBridge()` (row 93, N-184). Without it: no revive.
// - user `argv` / `fallbackArgv` -> spawn, shell false, fixed env allow-list, cwd home, output scrubbed (SEC-16).
// The render-bridge probe is `datumStudio.probeBridge(timeoutMs)` (row 93). Without it the component is not probed in
// this build (logged once, not recorded), so no false "did not start" message appears.

import { spawn as nodeSpawn } from "node:child_process"
import { statSync } from "node:fs"
import { isAbsolute } from "node:path"
import { readSetupComponentStates } from "../setup-runner"
import { changedWatchedFiles, watchedFileChangedMessage } from "./flux"
import { runProbe, type ProbeResult } from "./probe"
import { takeRecheckRequest, watchRecheck, type RecheckWatcher, type WatchFn } from "./recheck"
import {
  ReviveQueue,
  RegimeMemory,
  runToolHealthPass,
  type ComponentResult,
  type ReviveOutcome,
  type ToolHealthLog,
  type ToolHealthPassRequest,
} from "./regime"
import { ensureToolHealthDir, readToolHealthState, scrubDetail, scrubOutput, writeToolHealthState, type ToolHealthState } from "./state"
import { PROBE_BODY_MAX_BYTES, type ResolvedToolHealthComponent, type ToolHealthContext } from "./types"
import { resolveToolHealthRegistry, userRegistryIssueMessage } from "./user-registry"

/** The only ids a `compose-start` revive may pass to `swarm-setup start` (N-153). */
export const SETUP_START_IDS = ["runtime", "searxng", "firecrawl"] as const
/** Setup states that count as installed for `installedWhen.setupComponent` (01c 6.2). */
export const INSTALLED_SETUP_STATES: ReadonlySet<string> = new Set(["healthy", "configured", "installed"])
/** Environment of a user revive argv (01c 3.3). PATH is fixed; the rest are copied from the parent when present. */
export const REVIVE_ENV_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
export const REVIVE_ENV_COPY = ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR"] as const
const SETUP_REFUSAL_CODES = ["START_NOT_INSTALLED", "RUNTIME_PROFILE_MISSING", "START_CONTAINERS_MISSING"] as const

/** What tool-health needs from the shared setup runner (setup-runner.ts; `start` lands with rows 92a/92b). */
export type ToolHealthSetupRunner = {
  busy?: () => boolean
  start?: (id: (typeof SETUP_START_IDS)[number]) => Promise<
    | { kind: "ran"; exitCode: number | null; stdout: string; stderr: string }
    | { kind: "refused"; reason: string; message?: string }
  >
}

/** What tool-health needs from createDatumStudio (start.ts). `probeBridge` / `reviveBridge` land with row 93. */
export type ToolHealthDatumStudio = {
  start: () => Promise<unknown>
  probeBridge?: (timeoutMs: number) => Promise<ProbeResult>
  reviveBridge?: () => Promise<unknown>
}

type SpawnLike = typeof nodeSpawn

export type ToolHealthDeps = ToolHealthContext & {
  appVersion?: string
  log: ToolHealthLog
  setupRunner?: () => ToolHealthSetupRunner | undefined
  datumStudio?: ToolHealthDatumStudio
  /** Values never written to state or log (SEC-15), e.g. the render-bridge token when the bridge owner exposes it. */
  secrets?: () => readonly string[]
  env?: NodeJS.ProcessEnv
  // Test seams.
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  defer?: () => Promise<void>
  fetch?: typeof fetch
  spawn?: SpawnLike
  watch?: WatchFn
  getuid?: () => number | undefined
  probe?: (component: ResolvedToolHealthComponent) => Promise<ProbeResult>
  resolveRegistry?: () => ResolvedToolHealthComponent[]
}

export type ToolHealth = {
  runStartup: () => Promise<void>
  /** Person trigger (menu "Re-check Tools"): every component, or the named ids; may revive `consent: "manual"`. */
  recheck: (ids?: string[]) => Promise<void>
  /** Agent trigger: reads recheck.json now (the watcher calls this too). */
  takeRequestFile: () => Promise<void>
  stop: () => void
  /** Last pass results (tests and logs). */
  lastResults: () => ComponentResult[]
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.())
}

/** Runs one argv (no shell, env allow-list, cwd home). Never throws. */
export function runReviveArgv(
  argv: readonly string[],
  opts: { home: string; env: NodeJS.ProcessEnv; spawn?: SpawnLike },
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  const program = argv[0]
  if (!program || !isAbsolute(program)) return Promise.resolve({ code: null, stdout: "", stderr: "", error: "argv[0] is not absolute" })
  try {
    const st = statSync(program)
    if (!st.isFile()) return Promise.resolve({ code: null, stdout: "", stderr: "", error: "argv[0] is not a regular file" })
    if ((st.mode & 0o022) !== 0) return Promise.resolve({ code: null, stdout: "", stderr: "", error: "argv[0] is writable by group or others" })
  } catch {
    return Promise.resolve({ code: null, stdout: "", stderr: "", error: "argv[0] does not exist" })
  }
  const env: NodeJS.ProcessEnv = { PATH: REVIVE_ENV_PATH }
  for (const key of REVIVE_ENV_COPY) if (opts.env[key] !== undefined) env[key] = opts.env[key]
  return new Promise((resolve) => {
    const out = { stdout: [] as Buffer[], stderr: [] as Buffer[], bytes: { stdout: 0, stderr: 0 } }
    let child
    try {
      child = (opts.spawn ?? nodeSpawn)(program, argv.slice(1), {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env,
        cwd: opts.home,
        windowsHide: true,
      })
    } catch (error) {
      resolve({ code: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : "spawn failed" })
      return
    }
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      const room = PROBE_BODY_MAX_BYTES - out.bytes[stream]
      if (room <= 0) return
      const kept = chunk.length > room ? chunk.subarray(0, room) : chunk
      out.bytes[stream] += kept.length
      out[stream].push(kept)
    }
    child.stdout?.on("data", collect("stdout"))
    child.stderr?.on("data", collect("stderr"))
    let settled = false
    child.on("error", (error: Error) => {
      if (settled) return
      settled = true
      resolve({ code: null, stdout: "", stderr: "", error: error.message })
    })
    child.on("close", (code: number | null) => {
      if (settled) return
      settled = true
      resolve({ code, stdout: Buffer.concat(out.stdout).toString("utf8"), stderr: Buffer.concat(out.stderr).toString("utf8") })
    })
  })
}

export function createToolHealth(deps: ToolHealthDeps): ToolHealth {
  const now = deps.now ?? Date.now
  const sleep = deps.sleep ?? defaultSleep
  const defer = deps.defer ?? (() => new Promise<void>((resolve) => setImmediate(resolve)))
  const env = deps.env ?? process.env
  const secrets = () => deps.secrets?.() ?? []
  const memory = new RegimeMemory()
  const queue = new ReviveQueue()
  let stopped = false
  let startup: Promise<void> | undefined
  let watcher: RecheckWatcher | undefined
  let state: ToolHealthState | undefined
  let results: ComponentResult[] = []
  let running: Promise<void> | undefined
  const pending = new Map<"agent" | "person", { ids?: string[] }>()
  let bridgeNoticeLogged = false

  const log: ToolHealthLog = (level, message, context) => {
    try {
      deps.log(level, scrubDetail(message, secrets()) || message.slice(0, 300), context)
    } catch {
      // Logging must never break a pass.
    }
  }

  const setupStates = () => readSetupComponentStates(deps.home) as Record<string, string | undefined>

  const registry = (): ResolvedToolHealthComponent[] => {
    if (deps.resolveRegistry) return deps.resolveRegistry()
    const { components, user } = resolveToolHealthRegistry(deps, { getuid: deps.getuid as (() => number) | undefined })
    for (const issue of user.issues) log("warn", userRegistryIssueMessage(issue), { reason: issue.code, id: issue.id })
    return components
  }

  const probe = async (c: ResolvedToolHealthComponent): Promise<ProbeResult> => {
    if (deps.probe) return deps.probe(c)
    return runProbe(c.probe, {
      fetch: deps.fetch,
      processProbe: async (_p, timeoutMs) => {
        const studio = deps.datumStudio
        if (!studio?.probeBridge) return { healthy: false, reason: "BRIDGE_NOT_STARTED", detail: "no render-bridge probe in this build" }
        await studio.start().catch(() => undefined)
        return studio.probeBridge(timeoutMs)
      },
    })
  }

  const setupStart = (id: string) => async (): Promise<ReviveOutcome> => {
    if (!(SETUP_START_IDS as readonly string[]).includes(id))
      return { ok: false, reason: "REVIVE_EXIT", detail: `${id} has no setup start` }
    const runner = deps.setupRunner?.()
    if (!runner?.start) return { ok: false, reason: "SETUP_NO_START_VERB", detail: "swarm-setup start is not available" }
    if (runner.busy?.()) return { ok: false, reason: "SETUP_BUSY", detail: "swarm-setup is running" }
    const result = await runner.start(id as (typeof SETUP_START_IDS)[number])
    if (result.kind === "refused") {
      if (result.reason === "busy") return { ok: false, reason: "SETUP_BUSY", detail: "swarm-setup is running" }
      if (/start.?verb|no_start/i.test(result.reason)) return { ok: false, reason: "SETUP_NO_START_VERB", detail: result.reason }
      return { ok: false, reason: "REVIVE_EXIT", detail: `swarm-setup start ${id} refused (${result.reason})` }
    }
    const text = `${result.stdout}\n${result.stderr}`
    if (result.exitCode === 0) return { ok: true, detail: `swarm-setup start ${id} ok` }
    log("warn", `swarm-setup start ${id} output`, { stdout: scrubOutput(result.stdout, secrets()), stderr: scrubOutput(result.stderr, secrets()) })
    const code = SETUP_REFUSAL_CODES.find((c) => new RegExp(`\\b${c}\\b`).test(text))
    if (code) return { ok: false, reason: code, detail: `swarm-setup start ${id}: ${code}` }
    const first = scrubDetail(result.stderr || result.stdout, secrets()) || "no output"
    return { ok: false, reason: "REVIVE_EXIT", detail: `exit ${result.exitCode}: ${first}` }
  }

  const argvRevive = (c: ResolvedToolHealthComponent, argv: string[], fallbackArgv?: string[]) => async (): Promise<ReviveOutcome> => {
    const attempt = async (list: string[], which: string) => {
      log("info", `${c.label}: running revive ${which}`, { id: c.id, argv: list.map((a) => scrubDetail(a, secrets())) })
      const run = await runReviveArgv(list, { home: deps.home, env, spawn: deps.spawn })
      const stdout = scrubOutput(run.stdout, secrets())
      const stderr = scrubOutput(run.stderr, secrets())
      log(run.code === 0 ? "info" : "warn", `${c.label}: revive ${which} finished`, { id: c.id, exitCode: run.code, error: run.error, stdout, stderr })
      return run
    }
    // SEC-18 (row 94): a watched file whose hash changed since the entry was written gives one warning; the revive
    // still runs (U21: warn, never block).
    const changed = changedWatchedFiles(c.watch)
    if (changed.length)
      log("warn", watchedFileChangedMessage(c.label, changed), {
        id: c.id,
        reason: "WATCHED_FILE_CHANGED",
        files: changed.map((x) => ({ path: x.path, expected: x.expected, actual: x.actual })),
      })
    let run = await attempt(argv, "argv")
    if (run.code !== 0 && fallbackArgv) run = await attempt(fallbackArgv, "fallbackArgv")
    if (run.code === 0) return { ok: true, detail: "revive command ok" }
    const first = run.error ?? (scrubDetail(run.stderr || run.stdout, secrets()) || "no output")
    return { ok: false, reason: "REVIVE_EXIT", detail: `exit ${run.code ?? "none"}: ${first}` }
  }

  const reviveFor = (c: ResolvedToolHealthComponent) => {
    const revive = c.revive
    if (!revive) return undefined
    if ("builtin" in revive) {
      if (c.source !== "shipped") return undefined
      if (revive.builtin === "compose-start") return setupStart(c.id)
      const studio = deps.datumStudio
      if (!studio?.reviveBridge) return undefined
      return async (): Promise<ReviveOutcome> => {
        await studio.reviveBridge!()
        return { ok: true, detail: "render bridge restarted on the same endpoint" }
      }
    }
    return argvRevive(c, revive.argv, revive.fallbackArgv)
  }

  const isInstalled = (c: ResolvedToolHealthComponent) => {
    const when = c.installedWhen
    if (!when) return true
    if ("setupComponent" in when) return INSTALLED_SETUP_STATES.has(setupStates()[when.setupComponent] ?? "")
    try {
      statSync(when.path)
      return true
    } catch {
      return false
    }
  }

  async function pass(request: ToolHealthPassRequest) {
    let components = registry()
    if (!deps.probe && !deps.datumStudio?.probeBridge) {
      components = components.filter((c) => c.probe.kind !== "process")
      if (!bridgeNoticeLogged) {
        bridgeNoticeLogged = true
        log("info", "render-bridge is not probed in this build (no bridge probe wired)")
      }
    }
    if (request.ids) {
      const known = new Set(components.map((c) => c.id))
      request = { ...request, ids: request.ids.filter((id) => known.has(id)) }
    }
    state ??= readToolHealthState(deps.home, deps.appVersion ?? "").state
    state.appVersion = deps.appVersion ?? state.appVersion
    results = await runToolHealthPass({
      components,
      request,
      state,
      memory,
      queue,
      deps: {
        platform: deps.platform,
        now,
        sleep,
        probe,
        revive: reviveFor,
        isInstalled,
        setupState: (id) => setupStates()[id],
        secrets,
        log,
        stopped: () => stopped,
      },
    })
    try {
      writeToolHealthState(deps.home, state)
    } catch (error) {
      log("error", "tool-health state could not be written", { message: error instanceof Error ? error.message : String(error) })
    }
  }

  /** Serial passes; requests that arrive during a pass merge into one follow-up per trigger. */
  function schedule(trigger: "agent" | "person", ids?: string[]): Promise<void> {
    const prev = pending.get(trigger)
    if (prev === undefined) pending.set(trigger, ids ? { ids: [...ids] } : {})
    else if (!ids || !prev.ids) pending.set(trigger, {})
    else pending.set(trigger, { ids: [...new Set([...prev.ids, ...ids])] })
    if (running) return running
    running = (async () => {
      try {
        if (startup) await startup
        while (pending.size && !stopped) {
          const [next, req] = pending.entries().next().value as ["agent" | "person", { ids?: string[] }]
          pending.delete(next)
          await pass({ trigger: next, ids: req.ids }).catch((error) =>
            log("error", "tool-health re-check failed", { message: error instanceof Error ? error.message : String(error) }),
          )
        }
      } finally {
        running = undefined
      }
    })()
    return running
  }

  async function takeRequestFile() {
    if (stopped) return
    let known: Set<string>
    try {
      known = new Set(registry().map((c) => c.id))
    } catch {
      return
    }
    const read = takeRecheckRequest(deps.home, known, { getuid: deps.getuid })
    if (read.kind === "absent") return
    if (read.kind === "invalid") {
      log("warn", `recheck.json was ignored: ${read.why}`, { reason: read.reason })
      return
    }
    log("info", "tool-health re-check requested (recheck.json)", { ids: read.request.ids ?? "all" })
    await schedule("agent", read.request.ids)
  }

  function runStartup() {
    startup ??= (async () => {
      await defer()
      try {
        if (stopped) return
        await pass({ trigger: "startup" })
      } catch (error) {
        log("error", "tool-health startup pass failed", { message: error instanceof Error ? error.message : String(error) })
      }
      try {
        if (stopped) return
        ensureToolHealthDir(deps.home)
        watcher = watchRecheck(deps.home, () => void takeRequestFile().catch(() => undefined), {
          watch: deps.watch,
          onError: (error) => log("warn", "tool-health re-check watcher failed", { message: error instanceof Error ? error.message : String(error) }),
        })
        // A request written while the app was closed is served once now (not awaited: its pass waits for this
        // startup promise, so awaiting here would deadlock).
        void takeRequestFile().catch(() => undefined)
      } catch (error) {
        log("warn", "tool-health re-check watcher not started", { message: error instanceof Error ? error.message : String(error) })
      }
    })()
    return startup
  }

  return {
    runStartup,
    recheck: (ids) => {
      if (stopped) return Promise.resolve()
      log("info", "tool-health re-check requested (menu)", { ids: ids ?? "all" })
      return schedule("person", ids)
    },
    takeRequestFile,
    stop: () => {
      stopped = true
      watcher?.close()
      watcher = undefined
    },
    lastResults: () => results,
  }
}
