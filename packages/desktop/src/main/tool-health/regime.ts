// TH-02 / SEC-05 / SEC-16 (1.2.6 row 91): one pass of the tool-health regime, the D6 decision table of spec 01c 6.2.
// Pure logic over injected probes, revives, clock and installed checks, so fake probes test it (regime.test.ts).
//
// Rules this module holds (01c 6.2-6.4, 01_specs TH-02, SEC-05, SEC-16):
// - A revive never installs: the only revive paths are the injected `revive` callback (built by startup.ts from the
//   shipped `builtin` kinds and the user's absolute argv) and they run only after the D6 gate (installed AND previously
//   healthy). Not installed or never healthy = probe only.
// - First 1.2.6 launch: a setup component with no record in state.json counts as previously healthy when setup's own
//   state says `healthy` (bootstrap, 6.4 rule 2). A record without `lastHealthyAt` gets no bootstrap.
// - Internal components (shipped, no `installedWhen`) count as previously healthy only when healthy earlier in THIS launch.
// - `consent: "manual"` is revived only by a PERSON trigger (the "Re-check Tools" menu item) naming it; an agent's
//   recheck.json probes it but leaves it `dead` `CONSENT_MANUAL` (SEC-05, C8).
// - REVIVE_MAX_PER_LAUNCH automatic attempts; each re-check grants one more per named component; attempts of the same
//   component are spaced at least REVIVE_WAIT_MS apart (no revive storm).
// - Revives run one at a time (single queue, CLAUDE.md §6 single-writer rule).
// - `detail` and revive output are scrubbed (SEC-16) before they reach the state or the log.

import type { ProbeResult } from "./probe"
import { scrubDetail } from "./state"
import type { ToolHealthRecord, ToolHealthState } from "./state"
import {
  REVIVE_MAX_PER_LAUNCH,
  REVIVE_WAIT_MS,
  type ResolvedToolHealthComponent,
  type ToolHealthReason,
  type ToolHealthStatus,
} from "./types"

/** Poll interval of the re-probe after a revive (01c 6.2 row 10). */
export const REVIVE_POLL_MS = 2000

/** How a pass was started. `agent` = recheck.json (agent or a person writing the file); `person` = the menu item. */
export type ToolHealthTrigger = "startup" | "agent" | "person"

export type ToolHealthPassRequest = {
  trigger: ToolHealthTrigger
  /** Named ids (re-check only). Absent on a re-check = every component. */
  ids?: string[]
}

export type ReviveOutcome =
  | { ok: true; detail?: string }
  | { ok: false; reason: Extract<ToolHealthReason, "SETUP_BUSY" | "SETUP_NO_START_VERB" | "START_NOT_INSTALLED" | "RUNTIME_PROFILE_MISSING" | "START_CONTAINERS_MISSING" | "REVIVE_EXIT" | "REVIVE_TIMEOUT">; detail: string }

export type ToolHealthLog = (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => void

export type RegimeDeps = {
  platform: string
  now: () => number
  sleep: (ms: number) => Promise<void>
  probe: (component: ResolvedToolHealthComponent) => Promise<ProbeResult>
  /** Undefined = this component cannot be revived in this build (treated as "no revive", 01c 6.2 row 6). */
  revive: (component: ResolvedToolHealthComponent) => ((signal: { stopped: () => boolean }) => Promise<ReviveOutcome>) | undefined
  /** `installedWhen` (01c 6.2): setup state healthy/configured/installed, or the path exists. Absent = true. */
  isInstalled: (component: ResolvedToolHealthComponent) => boolean
  /** Setup's own state for a setup component (bootstrap rule 6.4.2). */
  setupState: (setupComponent: string) => string | undefined
  /** Values that must never reach state or log (the render-bridge token). */
  secrets?: () => readonly string[]
  log: ToolHealthLog
  stopped: () => boolean
}

export type ComponentResult = {
  id: string
  status: ToolHealthStatus
  reason: ToolHealthReason
  detail: string
  message: string
}

/** 01c section 9: the person-facing text for a status. */
export function toolHealthMessage(
  component: Pick<ResolvedToolHealthComponent, "id" | "label">,
  reason: ToolHealthReason,
  detail: string,
  extra: { seconds?: number; dep?: string } = {},
): string {
  const label = component.label
  switch (reason) {
    case "OK":
      return `${label} is running.`
    case "REVIVED":
      return `${label} was down and has been started again (${extra.seconds ?? 0} s).`
    case "NOT_INSTALLED":
      return `${label} is not installed, so Swarm did not start it. Swarm never installs tools on its own; install it from Settings > Tools if you need it.`
    case "NEVER_HEALTHY":
      return `${label} is not running and has never been seen running, so Swarm did not start it. Start it once yourself; after that Swarm keeps it running.`
    case "CONSENT_MANUAL":
      // 1.2.6 INT-1 (row 105): only a person trigger revives it (SEC-05), so point to the menu item, not the agent.
      return `${label} is down. It is set to start only when you ask; choose "Re-check Tools" in the Swarm menu to start it.`
    case "REVIVE_LIMIT":
      return `${label} is down again after one restart in this session. Swarm will not keep restarting it; ask for a re-check or look at the log.`
    case "REQUIRES_DOWN":
      return `${label} needs ${extra.dep ?? "another tool"}, which is down.`
    case "FILE_MISSING":
      return `${label} is missing (${detail}). Swarm cannot repair this itself; reinstall or re-apply the Swarm update.`
    case "BRIDGE_NOT_STARTED":
      return "The DATUM render bridge did not start with Swarm, so renders will fail. Quit and reopen Swarm."
    case "BRIDGE_SOCKET_GONE":
      return `The DATUM render bridge stopped answering (${detail}).`
    case "BRIDGE_BAD_REPLY":
      return "The DATUM render bridge answered incorrectly."
    case "SETUP_BUSY":
      return `${label} could not be started because Swarm's tool setup is running. Try a re-check when it has finished.`
    case "SETUP_NO_START_VERB":
      return `This Swarm build cannot start ${label} (its setup helper has no start command).`
    case "START_NOT_INSTALLED":
      return `${label} is not recorded as installed, so it was not started.`
    case "RUNTIME_PROFILE_MISSING":
      return 'The container runtime profile "swarm" does not exist. Starting it would create a new VM, which Swarm does not do on its own; run the Tools setup.'
    case "START_CONTAINERS_MISSING":
      return `${label}'s containers no longer exist. Swarm only starts existing containers; to rebuild them run "swarm-setup apply ${component.id}" from Settings > Tools.`
    case "REVIVE_EXIT":
      return `Starting ${label} failed: ${detail}.`
    case "REVIVE_TIMEOUT":
      return `${label} was started but did not become healthy within ${extra.seconds ?? 0} s.`
    default:
      return `${label}: ${detail || reason}`
  }
}

/** Per-launch memory of the regime: revive budget and in-launch health of internal components. */
export class RegimeMemory {
  readonly attempts = new Map<string, number>()
  readonly grants = new Map<string, number>()
  readonly lastReviveAt = new Map<string, number>()
  readonly healthyThisLaunch = new Set<string>()

  grant(id: string) {
    this.grants.set(id, (this.grants.get(id) ?? 0) + 1)
  }

  allowance(id: string) {
    return REVIVE_MAX_PER_LAUNCH + (this.grants.get(id) ?? 0)
  }
}

function isUp(status: ToolHealthStatus | undefined) {
  return status === "healthy" || status === "revived"
}

/** One revive at a time across every pass of this launch. */
export class ReviveQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private inFlight = 0
  maxInFlight = 0

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.inFlight++
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
      try {
        return await work()
      } finally {
        this.inFlight--
      }
    })
    this.tail = next.catch(() => undefined)
    return next
  }
}

/** The set of components a pass looks at, with the `requires` closure of named ids. */
export function selectPassComponents(
  components: ResolvedToolHealthComponent[],
  request: ToolHealthPassRequest,
): { selected: ResolvedToolHealthComponent[]; named: Set<string> } {
  if (request.trigger === "startup" || !request.ids) {
    const named = request.trigger === "startup" ? new Set<string>() : new Set(components.map((c) => c.id))
    return { selected: components, named }
  }
  const byId = new Map(components.map((c) => [c.id, c]))
  const named = new Set(request.ids.filter((id) => byId.has(id)))
  const want = new Set<string>()
  const visit = (id: string) => {
    if (want.has(id)) return
    const c = byId.get(id)
    if (!c) return
    want.add(id)
    for (const dep of c.requires ?? []) visit(dep)
  }
  for (const id of named) visit(id)
  return { selected: components.filter((c) => want.has(c.id)), named }
}

/**
 * Runs one pass over `components` and updates `state` in place (records only for rows 3-10; rows 1-2 leave the old
 * record). Returns the results of the components that were judged. Never throws.
 */
export async function runToolHealthPass(input: {
  components: ResolvedToolHealthComponent[]
  request: ToolHealthPassRequest
  /** Updated in place. The bootstrap rule (6.4.2) reads "no record" from it, so pass it before any write of this pass. */
  state: ToolHealthState
  memory: RegimeMemory
  queue: ReviveQueue
  deps: RegimeDeps
}): Promise<ComponentResult[]> {
  const { request, state, memory, queue, deps } = input
  const { selected, named } = selectPassComponents(input.components, request)
  const recheck = request.trigger !== "startup"
  // A re-check grants one more attempt per named component (and its requires closure).
  if (recheck) for (const c of selected) memory.grant(c.id)

  const byId = new Map(selected.map((c) => [c.id, c]))
  const settled = new Map<string, Promise<ComponentResult | undefined>>()
  const secrets = () => deps.secrets?.() ?? []

  const record = (c: ResolvedToolHealthComponent, status: ToolHealthStatus, reason: ToolHealthReason, detail: string, extra: { seconds?: number; dep?: string; revivedAt?: number } = {}): ComponentResult => {
    const now = deps.now()
    const clean = scrubDetail(detail, secrets())
    const previous = state.components[c.id]
    const next: ToolHealthRecord = {
      lastStatus: status,
      reason,
      detail: clean,
      lastCheckedAt: now,
      source: c.source,
    }
    const healthyAt = isUp(status) ? now : previous?.lastHealthyAt
    if (healthyAt !== undefined) next.lastHealthyAt = healthyAt
    const reviveAt = extra.revivedAt ?? previous?.lastReviveAt
    if (reviveAt !== undefined) next.lastReviveAt = reviveAt
    state.components[c.id] = next
    if (isUp(status)) memory.healthyThisLaunch.add(c.id)
    const message = scrubDetail(toolHealthMessage(c, reason, clean, extra), secrets())
    const level = isUp(status) ? "info" : status.startsWith("skipped") ? "info" : "warn"
    deps.log(level, message, { id: c.id, status, reason, detail: clean, trigger: request.trigger })
    return { id: c.id, status, reason, detail: clean, message }
  }

  const previouslyHealthy = (c: ResolvedToolHealthComponent) => {
    const previous = state.components[c.id]
    const installedWhen = c.installedWhen
    if (c.source === "shipped" && !installedWhen) return memory.healthyThisLaunch.has(c.id)
    if (previous?.lastHealthyAt !== undefined) return true
    if (memory.healthyThisLaunch.has(c.id)) return true
    // 6.4 rule 2: first 1.2.6 launch bootstrap, setup components with no record only.
    if (!previous && installedWhen && "setupComponent" in installedWhen)
      return deps.setupState(installedWhen.setupComponent) === "healthy"
    return false
  }

  const judge = async (c: ResolvedToolHealthComponent): Promise<ComponentResult | undefined> => {
    // Row 1: platform.
    if (c.platforms && !c.platforms.includes(deps.platform)) return undefined
    // Row 2: startup off (re-checks naming it still probe it).
    if (c.startup === "off" && !(recheck && named.has(c.id))) return undefined
    if (deps.stopped()) return undefined
    // Row 3: installed.
    let installed = false
    try {
      installed = deps.isInstalled(c)
    } catch {
      installed = false
    }
    if (!installed) return record(c, "skipped_not_installed", "NOT_INSTALLED", "not installed")
    // Row 4: requires, after their own turn.
    for (const dep of c.requires ?? []) {
      const pending = settled.get(dep)
      const result = pending ? await pending : undefined
      // Not judged in this pass (startup off, not named): fall back to its last recorded status.
      const status = result?.status ?? state.components[dep]?.lastStatus
      if (!isUp(status)) {
        const depLabel = byId.get(dep)?.label ?? input.components.find((x) => x.id === dep)?.label ?? dep
        return record(c, "dead", "REQUIRES_DOWN", `requires ${dep}`, { dep: depLabel })
      }
    }
    // Row 5: probe.
    const probed = await deps.probe(c)
    if (probed.healthy) return record(c, "healthy", "OK", probed.detail)
    // Row 6: no revive (or none wired in this build, or the bridge never started: nothing to restart).
    const revive = probed.reason === "BRIDGE_NOT_STARTED" ? undefined : deps.revive(c)
    if (!revive) return record(c, "dead", probed.reason, probed.detail)
    // Row 7: D6, never healthy.
    if (!previouslyHealthy(c)) return record(c, "skipped_never_healthy", "NEVER_HEALTHY", probed.detail)
    // Row 8: consent manual needs a person trigger naming it (SEC-05).
    if (c.consent === "manual" && !(request.trigger === "person" && named.has(c.id)))
      return record(c, "dead", "CONSENT_MANUAL", probed.detail)
    // Row 9: budget and spacing.
    const attempts = memory.attempts.get(c.id) ?? 0
    const last = memory.lastReviveAt.get(c.id)
    if (attempts >= memory.allowance(c.id) || (last !== undefined && deps.now() - last < REVIVE_WAIT_MS))
      return record(c, "dead", "REVIVE_LIMIT", probed.detail)
    // Row 10: revive (serial), then re-probe every REVIVE_POLL_MS until reviveTimeoutMs.
    return queue.run(async () => {
      if (deps.stopped()) return record(c, "dead", probed.reason, `${probed.detail}; not revived: Swarm is quitting`)
      memory.attempts.set(c.id, attempts + 1)
      const started = deps.now()
      memory.lastReviveAt.set(c.id, started)
      const budget = c.reviveTimeoutMs ?? REVIVE_WAIT_MS
      const deadline = started + budget
      deps.log("info", `${c.label} is down; starting it again`, { id: c.id, reason: probed.reason, trigger: request.trigger })
      let outcome: ReviveOutcome | "timeout"
      try {
        outcome = await Promise.race([
          revive({ stopped: deps.stopped }),
          deps.sleep(budget).then(() => "timeout" as const),
        ])
      } catch (error) {
        outcome = { ok: false, reason: "REVIVE_EXIT", detail: error instanceof Error ? error.message : "revive failed" }
      }
      const seconds = () => Math.max(0, Math.round((deps.now() - started) / 1000))
      if (outcome === "timeout")
        return record(c, "revive_failed", "REVIVE_TIMEOUT", `no result within ${Math.round(budget / 1000)} s`, { seconds: Math.round(budget / 1000), revivedAt: started })
      if (!outcome.ok) return record(c, "revive_failed", outcome.reason, outcome.detail, { revivedAt: started })
      while (true) {
        const again = await deps.probe(c)
        if (again.healthy)
          return record(c, "revived", "REVIVED", `${outcome.detail ? `${outcome.detail}; ` : ""}${again.detail}`, { seconds: seconds(), revivedAt: started })
        if (deps.now() >= deadline || deps.stopped())
          return record(c, "revive_failed", "REVIVE_TIMEOUT", again.detail, { seconds: Math.round(budget / 1000), revivedAt: started })
        await deps.sleep(Math.min(REVIVE_POLL_MS, Math.max(0, deadline - deps.now())))
      }
    })
  }

  // Components without requires start in parallel; dependents wait for theirs inside `judge`.
  for (const c of selected) {
    settled.set(
      c.id,
      Promise.resolve()
        .then(() => judge(c))
        .catch((error) => {
          deps.log("error", "tool-health component check failed", {
            id: c.id,
            message: scrubDetail(error instanceof Error ? error.message : String(error), secrets()),
          })
          return undefined
        }),
    )
  }
  const results = await Promise.all(settled.values())
  state.updatedAt = deps.now()
  return results.filter((r): r is ComponentResult => r !== undefined)
}
