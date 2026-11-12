// Row 92a (Swarm 1.2.6) — OFF-04 / register N-153: the START-ONLY verb `swarm-setup start <id>`.
// Contract: masterplan/01c_spec_u7_tool_health.md §4.7; refusal codes N-154..N-157.
//
// WHY: the colima VM stops when Swarm quits and the web stacks have no restart policy
// (composefiles/lint.ts), so after a quit or a reboot SearXNG and Firecrawl are down although
// they are installed. The Swarm-made workaround `estate-up.sh` (2026-11-09) revived them with
// `compose up -d`, which CAN create containers. `apply` cannot serve either: it re-renders and
// recreates (estate/apply.ts header). This module generalises the workaround into a verb that can
// only START what an earlier consented install created:
//
//   runtime   colima list --json  ->  profile `swarm` absent: RUNTIME_PROFILE_MISSING (a start would
//             create a VM) | running: done | stopped: `colima start --profile swarm --activate=false`
//             WITHOUT sizing flags, then poll `docker --context <observed> info` (180 s)
//   searxng / firecrawl   runtime as above, then
//             `docker --context <observed> compose -p swarm-tools -f <tools>/<id>/compose/<id>.yml start`
//             "no container" -> START_CONTAINERS_MISSING with the repair hint `swarm-setup apply <id>`
//
// Never `up`, `create`, `pull`, `--force-recreate`, `install`, `delete`. Preconditions are read from
// state.json (the component, and for a stack also `runtime`, must be `healthy`, PC-ST-06), else
// START_NOT_INSTALLED with nothing spawned. Writes: exactly ONE audit.jsonl line (kind setup_verb,
// verb start) per invocation, plus setup.log lines on failure. It writes no state transition, never
// touches tools.lock.json, takes no consent token (it downloads nothing) and takes no setup lock
// (register N-153 "no lock"; it is idempotent and the desktop runner already serialises its calls).
//
// Every command runs through the injected CommandRunner (commands.ts), so tests drive the whole
// sequence with a scripted fake and the real CLI uses spawnRunner (argv array, env-stripped, no shell).

import { COMPOSE_PROJECT, PROGRAM_NAME, STATES, type ComponentId } from "../constants.ts"
import { OUTCOME, type OutcomeToken } from "../outcomes.ts"
import { readState } from "../state.ts"
import { writeSetupLog } from "../setuplog.ts"
import { firecrawlPlan, resolveDockerContextName, searxngPlan } from "../stacklib.ts"
import { appendChainEvent } from "../wiring/audit_chain.ts"
import { parseProfileJson } from "../steps/runtime/capture.ts"
import {
  colimaListJsonArgv,
  colimaStartOnlyArgv,
  dockerArgv,
  dockerInfoArgv,
  formatArgv,
  type CommandRunner,
  type ExecResult,
} from "../steps/runtime/commands.ts"

/** The only ids `start` accepts (§4.7). Checked against COMPONENT_IDS by type; no id is added there (E-41). */
export const STARTABLE_COMPONENTS = ["runtime", "searxng", "firecrawl"] as const satisfies readonly ComponentId[]
export type StartableComponent = (typeof STARTABLE_COMPONENTS)[number]

/** The four refusal codes (N-154..N-157), printed as the RESULT token. */
export const START_CODES = {
  NOT_INSTALLED: OUTCOME.START_NOT_INSTALLED,
  UNKNOWN: OUTCOME.START_UNKNOWN_COMPONENT,
  CONTAINERS_MISSING: OUTCOME.START_CONTAINERS_MISSING,
  PROFILE_MISSING: OUTCOME.RUNTIME_PROFILE_MISSING,
} as const
export type StartCode = (typeof START_CODES)[keyof typeof START_CODES]

/** §4.7: wait for `docker info` up to 180 s after a colima start (estate-up.sh DEADLINE=180). */
export const START_RUNTIME_WAIT_MS = 180_000
export const START_POLL_MS = 5_000

const LOG_SOURCE = "swarm-setup.estate.start"

export interface StartOptions {
  readonly component: string
  readonly runner: CommandRunner
  readonly colimaPath: string
  readonly dockerPath: string
  /** Defaults: 180 s / 5 s; tests inject a fake clock and a no-op sleep. */
  readonly waitMs?: number
  readonly pollMs?: number
  readonly sleep?: (ms: number) => void
  readonly now?: () => number
}

export interface StartReport {
  readonly ok: boolean
  readonly component: string
  /** The RESULT token: OK, FAILED or one of START_CODES. */
  readonly token: OutcomeToken
  /** Set only for the four registered refusals. */
  readonly code?: StartCode
  readonly message: string
  /** Every argv line run, in order (also written to the audit line). */
  readonly commands: readonly string[]
}

function isStartable(id: string): id is StartableComponent {
  return (STARTABLE_COMPONENTS as readonly string[]).includes(id)
}

function tail(r: ExecResult): string {
  const text = `${r.stderr}\n${r.stdout}`.trim()
  return text.length > 400 ? `…${text.slice(-400)}` : text || `exit ${r.exitCode}`
}

/** Run `swarm-setup start <component>`. Synchronous (the runner is synchronous); never throws for a
 *  refusal or a command failure — every outcome is a named token, and one audit line is appended. */
export function runStart(opts: StartOptions): StartReport {
  const commands: string[] = []
  const run = (argv: readonly string[]): ExecResult => {
    commands.push(formatArgv(argv))
    return opts.runner.run(argv)
  }
  const done = (token: OutcomeToken, message: string): StartReport => {
    const code = (Object.values(START_CODES) as string[]).includes(token) ? (token as StartCode) : undefined
    const report: StartReport = {
      ok: token === OUTCOME.OK,
      component: opts.component,
      token,
      ...(code ? { code } : {}),
      message,
      commands: [...commands],
    }
    audit(report)
    if (!report.ok) {
      log(code ? "warn" : "error", `start ${opts.component}: ${token} — ${message}`, { component: opts.component, commands: report.commands })
    }
    return report
  }

  // 1. Id gate first: nothing is read or spawned for an id outside the three.
  if (!isStartable(opts.component)) {
    return done(OUTCOME.START_UNKNOWN_COMPONENT, `start accepts only ${STARTABLE_COMPONENTS.join(", ")}; got "${opts.component}"`)
  }
  const id = opts.component

  // 2. State precondition (read-only). The lock version is only readState's fallback for a missing
  //    file, which normalises to all-absent and therefore refuses below; tools.lock.json is not read.
  const st = readState("")
  if (!st.ok) return done(OUTCOME.FAILED, `cannot read setup state: ${st.error}`)
  const needed: ComponentId[] = id === "runtime" ? ["runtime"] : ["runtime", id]
  for (const need of needed) {
    const value = st.state.components[need].state
    if (value !== STATES.HEALTHY) {
      return done(
        OUTCOME.START_NOT_INSTALLED,
        `${need} is "${value}", not healthy; start only starts what an install completed (${PROGRAM_NAME} install ${need})`,
      )
    }
  }
  const context = resolveDockerContextName(st.state)

  // 3. Runtime: list, refuse a missing profile, start a stopped one without sizing flags.
  const runtime = ensureRuntime(opts, run, context)
  if (runtime) return done(runtime.token, runtime.message)
  if (id === "runtime") return done(OUTCOME.OK, "runtime is running")

  // 4. Stack: compose start of the EXISTING containers only.
  const plan = id === "searxng" ? searxngPlan() : firecrawlPlan()
  const res = run(dockerArgv(opts.dockerPath, context, "compose", "-p", COMPOSE_PROJECT, "-f", plan.composeFile, "start"))
  if (res.ok) return done(OUTCOME.OK, `${id} containers started`)
  if (/no container/i.test(`${res.stderr}\n${res.stdout}`)) {
    return done(
      OUTCOME.START_CONTAINERS_MISSING,
      `${id} has no containers to start; start never creates them. Repair by hand: ${PROGRAM_NAME} apply ${id}`,
    )
  }
  return done(OUTCOME.FAILED, `compose start for ${id} failed: ${tail(res)}`)
}

/** Returns undefined when the runtime is running (already, or after a start that answered docker info). */
function ensureRuntime(
  opts: StartOptions,
  run: (argv: readonly string[]) => ExecResult,
  context: string,
): { token: OutcomeToken; message: string } | undefined {
  const list = run(colimaListJsonArgv(opts.colimaPath))
  if (!list.ok) return { token: OUTCOME.FAILED, message: `colima list failed: ${tail(list)}` }
  const profile = parseProfileJson(list.stdout).find((p) => String(p.name ?? p.Name ?? "") === "swarm")
  if (!profile) {
    return {
      token: OUTCOME.RUNTIME_PROFILE_MISSING,
      message: `colima profile swarm does not exist; start never creates a VM (${PROGRAM_NAME} install runtime)`,
    }
  }
  if (String(profile.status ?? profile.Status ?? "").toLowerCase() === "running") return undefined

  const started = run(colimaStartOnlyArgv(opts.colimaPath))
  if (!started.ok) return { token: OUTCOME.FAILED, message: `colima start failed: ${tail(started)}` }

  const now = opts.now ?? Date.now
  // packages/setup declares its own minimal BunNamespace (types/bun-net.d.ts) without sleepSync, so the
  // accessor is typed by hand here, as egress_bake.ts does for its own Bun extras.
  const sleep = opts.sleep ?? ((ms: number) => (Bun as unknown as { sleepSync(ms: number): void }).sleepSync(ms))
  const waitMs = opts.waitMs ?? START_RUNTIME_WAIT_MS
  const pollMs = opts.pollMs ?? START_POLL_MS
  const deadline = now() + waitMs
  for (;;) {
    if (run(dockerInfoArgv(opts.dockerPath, context)).ok) return undefined
    if (now() >= deadline) {
      return { token: OUTCOME.FAILED, message: `docker --context ${context} info did not answer within ${Math.round(waitMs / 1000)} s after colima start` }
    }
    sleep(pollMs)
  }
}

function audit(report: StartReport): void {
  try {
    appendChainEvent({
      ts: new Date().toISOString(),
      kind: "setup_verb",
      source: LOG_SOURCE,
      decision: report.ok ? "started" : report.code ? "refused" : "failed",
      verb: "start",
      component: report.component,
      outcome: report.token,
      commands: report.commands,
    })
  } catch (err) {
    // The audit line is evidence, not control: a write failure never changes the outcome, but it is
    // recorded persistently in setup.log so a missing line can be explained the next morning.
    log("error", `start ${report.component}: audit.jsonl line not written`, {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    })
  }
}

function log(level: "warn" | "error", message: string, context: Record<string, unknown>): void {
  try {
    writeSetupLog({ level, source: LOG_SOURCE, message, context })
  } catch (err) {
    console.error(`${PROGRAM_NAME}: setup.log unwritable: ${err instanceof Error ? err.message : String(err)}`)
  }
}
