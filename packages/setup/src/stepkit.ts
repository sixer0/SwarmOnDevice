// Step-engine helpers (row 84). This is the shared toolkit every component step
// (rows 86-90) builds on, so the ordering / state / logging / outcome rules are written
// ONCE here instead of seven times. It is a LIBRARY/service (like fetch/verify/provenance
// and setuplog), NOT a scanned step: no src/steps/<id>/ directory is created and no core
// module is edited. The engine (index.ts) still owns dispatch; rows 86-90 import createStepKit.
//
// What it enforces on behalf of a step, each wired to the module that OWNS the rule:
//   - CONSENT GATE FIRST (§11): kit.fetch() refuses with REFUSED_NO_CONSENT unless
//     consent.ts's consentWasGranted(id) is true, and it never calls the network in that
//     case (row 83 handoff: "call consentWasGranted before fetchArtifact"). This is
//     enforcement LAYER 2 — the durable recording in evaluateConsent is layer 1.
//   - STATE TRANSITIONS ONLY VIA state.ts (§4): kit.transition() validates the move against
//     the §4.1 lifecycle chain and then commits through setState — never by writing
//     state.json directly (single-writer rule A-73-3). An illegal move is refused with zero
//     writes.
//   - DRY-RUN PROPAGATION (PC-FLAG-03): when ctx.dryRun is set, transition() records an
//     in-memory dry marker instead of committing, log() returns the redacted line without
//     touching disk, and fetch() injects dryRun into FetchOptions so row 82's library takes
//     its own zero-write path. A dry run therefore performs ZERO filesystem writes.
//   - REDACTION (P-8): kit.log() delegates to setuplog.writeSetupLog, the one redactor.
//   - OUTCOME TOKENS (§8, gate D-23): kit maps fetch results onto the frozen token set via
//     row 82's outcomeTokenFor, and consolidates row 83's malformed-policy reuse decision.
//
// TEST SEAMS mirror the narrowing discipline already used by row 82 (allowedHosts) and row
// 83 (ask): consentGate and fetchImpl can only make the kit MORE restrictive or observe it,
// never widen contact or fabricate consent. Defaults are the real modules.

import { consentWasGranted } from "./consent.ts"
import {
  fetchArtifact,
  resolveArtifact,
  outcomeTokenFor,
  type FetchResult,
  type FetchOptions,
  type ResolveResult,
} from "./fetch.ts"
import { setState, type StateFile, type ComponentState } from "./state.ts"
import { STATES, PROGRAM_NAME, type ComponentId, type StateValue } from "./constants.ts"
import { OUTCOME, type OutcomeToken } from "./outcomes.ts"
import { writeSetupLog, registerSecretValue, type LogLevel, type SetupLogOptions } from "./setuplog.ts"
import type { LockFile } from "./lockfile.ts"

/** One intended-but-uncommitted transition recorded under --dry-run. In-memory only; this is
 *  the sole "state" a dry run produces (proof: zero filesystem writes beyond these markers). */
export interface DryTransition {
  readonly id: ComponentId
  readonly from: StateValue
  readonly to: StateValue
  readonly patch?: Partial<ComponentState>
}

export interface StepKitOptions {
  readonly componentId: ComponentId
  readonly lock: LockFile
  readonly state: StateFile
  readonly dryRun: boolean
  /** Per-run trace id stamped on every log line (global-rules correlation_id). */
  readonly correlationId?: string
  /** setup.log destination + rotation policy forwarded to writeSetupLog. */
  readonly log?: SetupLogOptions
  /** TEST SEAM ONLY: replaces the consent predicate. Default = real consentWasGranted.
   *  A test may pass () => false to prove refusal, or () => true to drive the granted path;
   *  it cannot grant consent out-of-band (nothing here writes consent.log). */
  readonly consentGate?: (id: ComponentId) => boolean
  /** TEST SEAM ONLY: replaces fetchArtifact so a test can count calls (instrumentation).
   *  Default = the real row-82 downloader. Passing a spy proves "zero network without consent". */
  readonly fetchImpl?: typeof fetchArtifact
}

export interface StepKit {
  readonly componentId: ComponentId
  readonly dryRun: boolean
  readonly lock: LockFile
  readonly state: StateFile
  /** Dry-run markers: the only thing a dry run mutates (in memory). */
  readonly dryTransitions: DryTransition[]
  /** Redacted lines produced under dry-run (returned, not written). */
  readonly dryLogs: string[]
  /** Enforcement layer 2: was THIS component consented to in this process? */
  hasConsent(): boolean
  /** Current resting state entry for this component (never undefined). */
  stateOf(): ComponentState
  /** Zero-network pin pre-flight (row 82 resolveArtifact) scoped to this component. */
  artifact(artifactId?: string): ResolveResult
  /** Guarded lifecycle transition committed ONLY through state.ts setState. */
  transition(to: StateValue, patch?: Partial<ComponentState>): { ok: true } | { ok: false; error: string }
  /** Consent-gated download; refuses before any network when consent is absent. */
  fetch(opts?: FetchOptions): Promise<FetchResult | { ok: false; token: OutcomeToken }>
  /** Register a freshly-generated secret so every later log line scrubs it (P-8 layer 2). */
  registerSecret(value: string): void
  /** Append one redacted line to setup.log (dry-run: captured in dryLogs, nothing written). */
  log(level: LogLevel, message: string, extra?: { context?: Record<string, unknown> }): void
}

/** The §4.1 forward lifecycle. Each state lists the states it may advance to; failure and
 *  network-block are reachable from every working state, and resume (§6.3) may restart the
 *  pipeline from `failed`. Two universal edges are added in legal() rather than here: a
 *  self-transition (idempotent re-run) and any-state -> `absent` (the remove path). */
const FORWARD: Record<StateValue, readonly StateValue[]> = {
  absent: ["downloaded", "skipped", "failed", "BLOCKED_BY_NETWORK"],
  downloaded: ["verified", "failed", "BLOCKED_BY_NETWORK"],
  verified: ["installed", "failed", "BLOCKED_BY_NETWORK"],
  installed: ["configured", "failed", "BLOCKED_BY_NETWORK"],
  configured: ["healthy", "failed", "BLOCKED_BY_NETWORK"],
  healthy: ["failed"],
  failed: ["downloaded", "verified", "installed", "configured", "healthy", "skipped", "BLOCKED_BY_NETWORK"],
  skipped: ["downloaded"],
  BLOCKED_BY_NETWORK: ["downloaded", "skipped"],
}

function legal(from: StateValue, to: StateValue): boolean {
  if (from === to) return true // idempotent re-run changes nothing (§6.3)
  if (to === STATES.ABSENT) return true // remove resets any component (§7)
  return FORWARD[from].includes(to)
}

/** Build the per-component toolkit a step receives alongside its StepContext. */
export function createStepKit(opts: StepKitOptions): StepKit {
  const consentGate = opts.consentGate ?? consentWasGranted
  const fetchImpl = opts.fetchImpl ?? fetchArtifact
  const dryTransitions: DryTransition[] = []
  const dryLogs: string[] = []
  const sourcePrefix = `${PROGRAM_NAME}.${opts.componentId}`

  const stateOf = (): ComponentState => opts.state.components[opts.componentId] ?? { state: STATES.ABSENT }

  // The lifecycle position this kit believes the component is in. It starts from the
  // committed state and advances on every accepted transition. Under --dry-run nothing is
  // written to disk, so this tracker is what lets a single install() call chain through
  // downloaded -> verified -> ... legally instead of re-reading an unchanged absent entry.
  let current: StateValue = stateOf().state

  return {
    componentId: opts.componentId,
    dryRun: opts.dryRun,
    lock: opts.lock,
    state: opts.state,
    dryTransitions,
    dryLogs,

    hasConsent(): boolean {
      return consentGate(opts.componentId)
    },

    stateOf,

    artifact(artifactId?: string): ResolveResult {
      return resolveArtifact(opts.lock, opts.componentId, artifactId)
    },

    transition(to: StateValue, patch?: Partial<ComponentState>): { ok: true } | { ok: false; error: string } {
      const from = current
      if (!legal(from, to)) {
        return { ok: false, error: `${opts.componentId}: illegal state transition ${from} -> ${to} (see 01c §4.1)` }
      }
      if (opts.dryRun) {
        dryTransitions.push({ id: opts.componentId, from, to, ...(patch ? { patch } : {}) })
      } else {
        setState(opts.state, opts.componentId, { state: to, ...(patch ?? {}) })
      }
      current = to // advance the kit's view so the next transition validates against it
      return { ok: true }
    },

    async fetch(fetchOpts: FetchOptions = {}): Promise<FetchResult | { ok: false; token: OutcomeToken }> {
      if (!consentGate(opts.componentId)) {
        // Refuse BEFORE calling the downloader: no socket, no staging file, no provenance line.
        return { ok: false, token: OUTCOME.REFUSED_NO_CONSENT }
      }
      // Propagate dry-run into row 82's own zero-write posture (resume-check only).
      const merged: FetchOptions = { ...fetchOpts, dryRun: opts.dryRun || fetchOpts.dryRun === true }
      return fetchImpl(opts.lock, opts.componentId, merged)
    },

    registerSecret(value: string): void {
      registerSecretValue(value)
    },

    log(level: LogLevel, message: string, extra: { context?: Record<string, unknown> } = {}): void {
      const line = writeSetupLog(
        {
          level,
          source: sourcePrefix,
          message,
          component: opts.componentId,
          ...(opts.correlationId ? { correlationId: opts.correlationId } : {}),
          ...(extra.context ? { context: extra.context } : {}),
        },
        { ...opts.log, dryRun: opts.dryRun },
      )
      if (opts.dryRun) dryLogs.push(line)
    },
  }
}

// --- outcome-token consolidation (r82 outcomeTokenFor + r83 malformed-policy reuse) ----

/** Row 82's fetch-code -> outcome mapping, re-exported so steps import the whole outcome
 *  surface from one place (stepkit) rather than reaching into fetch.ts for it. */
export { outcomeTokenFor }

/** Map a kit.fetch() result onto the §8 outcome token. A consent refusal carries its token
 *  directly; a fetch failure is routed through row 82's outcomeTokenFor; success is OK. */
export function stepOutcomeFromFetch(result: FetchResult | { ok: false; token: OutcomeToken }): OutcomeToken {
  if ("token" in result) return result.token // REFUSED_NO_CONSENT (kit-level refusal)
  if ("ok" in result) return outcomeTokenFor(result.code) // fetch failure variant { ok:false, code }
  return OUTCOME.OK // fetched | resumed | dry_run all settle at OK for the step
}

/**
 * Row 83's malformed-policy decision, given one home so steps and the engine agree: a
 * malformed `policy.json` reuses the existing FAILED token (exit 1, path named on stderr)
 * rather than inventing REFUSED_POLICY_MALFORMED, because outcomes.ts is row-81 owned and
 * gate D-23 froze the token set. Reported as a seam in s84 §seams; if outcomes.ts ever gains
 * the token, this is the single line to change.
 */
export function policyMalformedOutcome(): OutcomeToken {
  return OUTCOME.FAILED
}
