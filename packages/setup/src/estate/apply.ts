// Estate apply owner (blueprint 11 row 246) — the ONE named command that takes a stored lane
// choice and a fresh DNS answer and lands both on ONE live stack.
//
// WHAT THIS ROW OWNS, per the two specs that name it:
//   - masterplan/06_s6b_lanes_spec.md §5.3: "One named command re-renders and recreates one stack
//     by label scope … refuses while another row holds the profile … It cannot rely on `compose
//     up -d` to notice an env-only change … It proves the value inside the running container, not
//     inside the file … Its user-visible effect is downtime."
//   - masterplan/07_s6b_p3_producer_spec.md §2.2 option (b): "This is the refresh owner … re-runs
//     the producer, re-renders, and recreates the affected tier." §5 row 246 adds: re-produce
//     BEFORE renderAll, because a changed literal is recreate-class and bring-up never re-renders
//     (stacklib.ts:497).
//
// THE ORDERING IS THE SAFETY. Everything that can refuse without touching the machine refuses
// first: stack name → HOME pin (E7) → lane validation → stored-pin screen → pin refresh → render →
// estate integrity → write (with rollback) → post-write integrity (with rollback) → context probe →
// compose → health gate → in-container proof. A refusal at any earlier stage leaves the previously
// rendered bytes exactly where they were; that property is asserted by watching hashes and mtimes,
// not by reading the response (06 §4.2's mechanism, reused here).
//
// WHAT THIS ROW DELIBERATELY DOES NOT DO:
//   - It does not download, fetch or install anything, so it asks no consent and dispatches no step
//     module. Consent covers a download (index.ts cmdWire's reasoning); this verb moves local bytes
//     and local containers.
//   - It does not create the crawl-target allow-list. Which hostnames are pinned is an operator/
//     gate decision (producer spec §1.1, U-240b-1, carried forward as U-266-1), so the refresh
//     re-produces exactly the names ALREADY stored in dns-pins.json and invents none. With no pins
//     file there is nothing to refresh: the absent file is the one legal no-pins state (§3.3) and
//     the render stays byte-identical.
//   - It does not gate on the recorded lifecycle state. See `integrityGate` below: the two
//     state-class gap codes are reported, the four artefact-class codes refuse. Rationale and the
//     routed question are in the artifact; the short form is rule E9 — state.json is a documented
//     reconstruction, so an operation on a LIVE estate must key off what is observably on disk and
//     observably running, not off a field that may be inferred.
//   - It never touches the other stack. Every compose leg carries `-f <this stack's file>` plus the
//     file's own service names positionally (the R112c-4 scoping rule), and every listing is
//     label-scoped (PC-LBL-01/02). No prune verb exists here, as elsewhere in this package.

import { createHash } from "node:crypto"
import { existsSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { atomicWriteText } from "../atomic.ts"
import { homeDir } from "../paths.ts"
import { renderAll } from "../composefiles/index.ts"
import { SECRET_INVENTORY, type RenderFile } from "../composefiles/shared.ts"
import { LANE_CONTROLS, createLanesFileAtSetup, lanesPath, readLanes, type LaneKey, type LaneValues } from "../composefiles/lanes.ts"
import { readDnsPins } from "../composefiles/dns_pins.ts"
import { produceDnsPins } from "./pins.ts"
import type { Resolver } from "../mcpproxy/resolve.ts"
import type { LockFile } from "../lockfile.ts"
import { readState } from "../state.ts"
import { writeSetupLog } from "../setuplog.ts"
import {
  checkPreconditions,
  composePsArgs,
  composeUpCmd,
  containerCreateArgs,
  containerExecArgs,
  contextInspectArgs,
  firecrawlPlan,
  formatCmd,
  parseComposeServices,
  refusingRunner,
  resolveDockerContextName,
  searxngPlan,
  serviceFromContainerName,
  waitForHealthy,
  type DockerRunner,
  type PreconditionGap,
  type ReadinessProbe,
  type StackPlan,
} from "../stacklib.ts"

export type ApplyComponent = "searxng" | "firecrawl"

/** Closed refusal-code set, in row 263's idiom: membership is pinned by a test, so widening needs
 *  a ruling rather than a commit. Each code names the phase that refused. */
export const APPLY_CODES = [
  "APPLY_STACK_NAMED", // scope is not exactly one of the two stacks
  "APPLY_HOME_UNPINNED", // E7: the pinned home did not take effect — refuse before any path resolves
  "APPLY_LANES_INVALID", // lanes.json refuses validation (the renderer's own token travels)
  "APPLY_PINS_INVALID", // the stored pins file refuses the render-side screen
  "APPLY_PINS_REFRESH_FAILED", // the producer refused to re-resolve/re-screen/re-write
  "APPLY_RENDER_REFUSED", // renderAll refused (renderer error or lint finding)
  "APPLY_ARTEFACT_INCOMPLETE", // artefact-class precondition gaps (never a partial restart)
  "APPLY_CONTEXT_UNAVAILABLE", // the swarm docker context is not reachable
  "APPLY_WRITE_FAILED", // a committed write threw — prior bytes restored
  "APPLY_VERIFY_MISMATCH", // read-back differs from the plan — prior bytes restored
  "APPLY_COMPOSE_UP_FAILED", // compose refused the recreate
  "APPLY_HEALTH_FAILED", // recreated, but the gate did not go green (proofs still reported)
  "APPLY_NOT_APPLIED", // the container reports a DIFFERENT value than the stored one — the change never landed
  "APPLY_PROOF_UNREADABLE", // the in-container read failed, so the applied state is unobservable (E3)
] as const
export type ApplyCode = (typeof APPLY_CODES)[number]

/** The four gap codes that describe BYTES (they protect the estate); the rest describe recorded
 *  lifecycle state and are reported without refusing — see the header and `integrityGate`. */
const ARTEFACT_GAP_CODES: readonly string[] = [
  "ARTEFACT_MISSING",
  "BIND_SOURCE_MISSING",
  "BIND_SOURCE_OUTSIDE_WHITELIST",
  "SECRET_MISSING",
]

const LOG_SOURCE = "swarm-setup.estate.apply"

export interface ApplyOptions {
  /** Scope: exactly one stack. Anything else refuses with APPLY_STACK_NAMED. */
  readonly component: string
  readonly lock: LockFile
  /** Pinned HOME (rule E7): required, and cross-checked against the resolved home before use. */
  readonly home: string
  /** Engine-injected docker runner. Without one every docker leg refuses honestly. */
  readonly run?: DockerRunner
  /** DNS resolver seam for the pin refresh (mcpproxy/resolve.ts systemResolver by default). */
  readonly resolver?: Resolver
  readonly readiness?: ReadinessProbe
  readonly dryRun?: boolean
  readonly nowIso?: string
  readonly sleep?: (ms: number) => Promise<void>
  readonly clock?: () => number
  readonly healthDeadlineMs?: number
  readonly healthIntervalMs?: number
}

/** One container's identity before and across the recreate — the recreate evidence itself, in the
 *  report rather than in prose. `observed` is null when the container did not exist yet. */
export interface ContainerObservation {
  readonly container: string
  readonly service: string
  /** `.Created` from inspect — changes when compose replaces the container. */
  readonly created: string | null
  /** `com.docker.compose.config-hash` — changes when the container's config changes. */
  readonly configHash: string | null
  /** Environment the daemon fixed at creation (host-side view of the container config). */
  readonly hostEnv: Readonly<Record<string, string>>
  /** `/proc/1/environ` read INSIDE the running container; null when it could not be read. */
  readonly inContainerEnv: Readonly<Record<string, string>> | null
  readonly inContainerError?: string
  /** This stack's lane keys, read from the in-container environment where available, else from the
   *  creation-time config. null means "the container does not carry this variable at all", which is
   *  a distinct observation from unreadable. */
  readonly laneValues: Readonly<Record<string, string | null>>
  /** True when this run replaced the container (present before, gone or different after). */
  readonly recreated: boolean
}

export interface ApplyReport {
  readonly ok: boolean
  readonly code?: ApplyCode
  readonly message: string
  readonly stack: ApplyComponent
  readonly home: string
  readonly composeFile: string
  readonly dryRun: boolean
  /** Validated lane tuple as read from the file (absent keys mean unset controls). */
  readonly lanes: LaneValues
  readonly lanesPresent: boolean
  /** What the DNS-pin refresh did. `no-stored-pins` is the legal no-op, not a failure. */
  readonly pinsRefresh: {
    readonly action: "no-stored-pins" | "written" | "unchanged" | "planned" | "refused" | "skipped-dry-run"
    readonly names: readonly string[]
    readonly detail: string
  }
  readonly render: { readonly filesTotal: number; readonly filesScoped: number; readonly enginePath: string }
  /** Artefact paths this run wrote, and the ones it left byte-identical (content-addressed no-write). */
  readonly written: readonly string[]
  readonly unchanged: readonly string[]
  /** Gaps that refused the run (artefact-class) and gaps that were only observed (state-class). */
  readonly refusedGaps: readonly string[]
  readonly observedStateGaps: readonly string[]
  /** Every docker argv this run issued, formatted — the scoping evidence. */
  readonly commands: readonly string[]
  readonly health?: { readonly token: string; readonly detail: string; readonly attempts: number }
  readonly proof: readonly ContainerObservation[]
  readonly elapsedMs: number
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function fileMode(path: string): number {
  return statSync(path).mode & 0o777
}

function log(level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>): void {
  writeSetupLog({ level, source: LOG_SOURCE, message, ...(context ? { context } : {}) })
}

/** D-262-2's declaration posture, mirrored at this caller because deliver.ts keeps its own copy
 *  private: EVERY required slot of BOTH stacks must be declared for renderAll to produce the full
 *  set at all, while writes stay scoped by the `stack` tag each RenderFile carries. */
function declareRequiredSlots(): Record<"searxng" | "firecrawl", Record<string, "generated">> {
  const secrets: Record<"searxng" | "firecrawl", Record<string, "generated">> = { searxng: {}, firecrawl: {} }
  for (const comp of ["searxng", "firecrawl"] as const)
    for (const spec of SECRET_INVENTORY[comp]) if (spec.required) secrets[comp][spec.name] = "generated"
  return secrets
}

function stackOf(component: ApplyComponent, home: string): StackPlan {
  return component === "searxng" ? searxngPlan(home) : firecrawlPlan(home)
}

function laneKeysFor(component: ApplyComponent): readonly LaneKey[] {
  return LANE_CONTROLS.filter((c) => c.stack === component).map((c) => c.key)
}

/** ---------------------------------------------------------------------------------------------
 * Configure-time creation (06 §2.3's swarm-setup column, routed to this row as R-245-3).
 *
 * `createLanesFileAtSetup` shipped in row 245 with no production caller; this is the caller. It
 * runs in BOTH stack steps BEFORE the delivery stage renders, because renderAll reads lanes.json
 * and bring-up never re-renders (stacklib.ts:497) — a write that landed after the render would be
 * invisible to the estate it claims to configure. Create-if-absent only: a file the user edited
 * (or the desktop route replaced) is never overwritten here, which is the single thing standing
 * between "raise the limit at setup" and "silently reset it at every repair" (06 §2.3).
 * --------------------------------------------------------------------------------------------- */
export interface ConfigureLanesResult {
  readonly ok: boolean
  readonly message: string
  readonly created?: boolean
  readonly path?: string
}

export function configureLanesAtSetup(opts: {
  readonly log: (level: "info" | "warn" | "error", message: string, context?: Record<string, unknown>) => void
  readonly home?: string
  readonly dryRun?: boolean
}): ConfigureLanesResult {
  const home = opts.home ?? homeDir()
  const path = lanesPath(home)
  if (opts.dryRun)
    return { ok: true, message: `dry-run: would create ${path} with the fork-H tuple if absent, touching nothing` }
  try {
    const report = createLanesFileAtSetup(home)
    opts.log(
      "info",
      report.created
        ? `lanes.json created at ${report.path} with the stored tuple (NUQ_WORKER_COUNT 5, MAX_CONCURRENT_PAGES 4, GRANIAN_BLOCKING_THREADS 4); dir mode ${report.dirModeBefore.toString(8)} -> ${report.dirModeAfter.toString(8)}${report.dirModeRepaired ? " (repaired to 0700)" : ""}, file mode ${report.fileMode.toString(8)}`
        : `lanes.json already stored at ${report.path} — left byte-identical (create-if-absent; a user or route edit is never overwritten at setup)`,
      { created: report.created, path: report.path, dirModeRepaired: report.dirModeRepaired },
    )
    return { ok: true, message: report.created ? `created ${report.path}` : `kept ${report.path}`, created: report.created, path: report.path }
  } catch (err) {
    // Fork H requires a STORED value; an install that cannot keep one is broken, not merely
    // cosmetic, so this refuses rather than bringing up an estate whose dial has no state.
    opts.log("error", `lanes.json could not be created at configure time: ${(err as Error).message}`)
    return { ok: false, message: `lane storage refused: ${(err as Error).message}` }
  }
}

/** ---------------------------------------------------------------------------------------------
 * Entry
 * --------------------------------------------------------------------------------------------- */
export async function applyEstate(opts: ApplyOptions): Promise<ApplyReport> {
  const startedAt = Date.now()
  const run = opts.run ?? refusingRunner
  const component = opts.component as ApplyComponent
  const commands: string[] = []

  const finish = (partial: Partial<ApplyReport> & Pick<ApplyReport, "ok" | "message">): ApplyReport => ({
    stack: component,
    home: opts.home,
    composeFile: "",
    dryRun: opts.dryRun ?? false,
    lanes: {},
    lanesPresent: false,
    pinsRefresh: { action: "no-stored-pins", names: [], detail: "not reached" },
    render: { filesTotal: 0, filesScoped: 0, enginePath: "fallback-list-of-four" },
    written: [],
    unchanged: [],
    refusedGaps: [],
    observedStateGaps: [],
    commands,
    proof: [],
    elapsedMs: Date.now() - startedAt,
    ...partial,
  })

  const refuse = (code: ApplyCode, message: string, extra: Partial<ApplyReport> = {}): ApplyReport => {
    log("error", `apply ${component} refused [${code}] ${message.split("\n")[0]}`, { code })
    return finish({ ok: false, code, message, ...extra })
  }

  // --- Phase 0: scope and HOME pin -------------------------------------------------------------
  if (component !== "searxng" && component !== "firecrawl")
    return refuse(
      "APPLY_STACK_NAMED",
      `apply targets exactly one stack by name — accepted: searxng, firecrawl; got "${opts.component}". The other stack is never touched by this command, and neither stack is applied implicitly.`,
    )
  if (homeDir() !== opts.home)
    return refuse(
      "APPLY_HOME_UNPINNED",
      `resolved home is "${homeDir()}" but the caller pinned "${opts.home}" — refusing before any path resolves (rule E7: an unpinned HOME is how a probe reached a user's real ~/.swarm once already).`,
    )

  const home = opts.home
  const plan = stackOf(component, home)
  const toolsRoot = join(home, ".swarm", "tools")
  const composeFile = plan.composeFile
  const base = { composeFile }

  // --- Phase 1: the lane file validates before anything is touched ------------------------------
  const lanes = readLanes(home)
  if (!lanes.ok)
    return refuse(
      "APPLY_LANES_INVALID",
      `${lanes.token}: ${lanes.message} — refused without rendering, writing or restarting anything (06 §4: refusal, not coercion).`,
      { ...base, lanesPresent: true },
    )

  // --- Phase 2: stored pins screen, then the refresh (producer spec §2.2 option b) -------------
  const stored = readDnsPins(home)
  if (!stored.ok)
    return refuse(
      "APPLY_PINS_INVALID",
      `dns-pins.json refused the screen: ${stored.message} — the whole apply aborts rather than rendering a half-screened estate (producer spec §3.3: never omit an entry silently).`,
      { ...base, lanes: lanes.lanes, lanesPresent: lanes.present },
    )
  const pinNames = stored.entries.map((e) => e.hostname)

  let pinsRefresh: ApplyReport["pinsRefresh"] = {
    action: "no-stored-pins",
    names: [],
    detail: "no dns-pins.json entries stored — nothing to refresh; the absent file is the legal no-pins state (producer spec §3.3)",
  }
  if (pinNames.length > 0) {
    if (opts.dryRun) {
      pinsRefresh = { action: "skipped-dry-run", names: pinNames, detail: "dry-run: would re-resolve and re-screen these names through produceDnsPins, touching nothing" }
    } else {
      const produced = await produceDnsPins({ home, hostnames: pinNames, resolver: opts.resolver, nowIso: opts.nowIso })
      if (!produced.ok)
        return refuse(
          "APPLY_PINS_REFRESH_FAILED",
          `producer refused [${produced.code}] ${produced.hostname}: ${produced.reason} — refuse-the-whole-thing: no render, no write, no restart (producer spec §3.3).`,
          { ...base, lanes: lanes.lanes, lanesPresent: lanes.present, pinsRefresh: { action: "refused", names: pinNames, detail: `${produced.code}: ${produced.reason}` } },
        )
      pinsRefresh = {
        action: produced.action === "planned" ? "planned" : produced.action,
        names: pinNames,
        detail: `${produced.action} ${produced.path} (${pinNames.length} name(s) re-resolved and re-screened; bytesWritten=${produced.bytesWritten})`,
      }
    }
  }

  const carried = { ...base, lanes: lanes.lanes, lanesPresent: lanes.present, pinsRefresh }

  // --- Phase 3: render the whole set, keep only this stack's files -----------------------------
  const rendered = renderAll(opts.lock, { home, secrets: declareRequiredSlots() })
  if (!rendered.ok) {
    const error = rendered.errors[0]
    const finding = rendered.findings.find((f) => f.severity === "error")
    const detail = error ? `[${error.code}] ${error.message}` : finding ? `[${finding.rule}] ${finding.message}` : "no detail"
    return refuse("APPLY_RENDER_REFUSED", `renderer refused the re-render ${detail}`, { ...carried })
  }
  const scoped = rendered.files.filter((f) => f.stack === component)
  // Row 263's discriminator pair, restated here: shipped defaults render ten files split 3/7 by
  // stack. Any other count means a slot flipped or a required half vanished — say which, refuse.
  const expectedScoped = component === "searxng" ? 3 : 7
  if (rendered.files.length !== 10 || scoped.length !== expectedScoped)
    return refuse(
      "APPLY_RENDER_REFUSED",
      `artefact count drifted: render emitted ${rendered.files.length} file(s), ${scoped.length} tagged ${component}; shipped defaults require 10 (${expectedScoped})`,
      { ...carried, render: { filesTotal: rendered.files.length, filesScoped: scoped.length, enginePath: rendered.enginePath } },
    )
  const renderInfo = { filesTotal: rendered.files.length, filesScoped: scoped.length, enginePath: rendered.enginePath }

  // --- Phase 4: estate integrity BEFORE any byte moves -----------------------------------------
  const preGate = integrityGate(plan, opts.lock, home)
  if (preGate.refused.length > 0)
    return refuse(
      "APPLY_ARTEFACT_INCOMPLETE",
      `estate is not applyable: ${preGate.refused.join("; ")} — nothing rendered to disk, nothing restarted.`,
      { ...carried, render: renderInfo, observedStateGaps: preGate.observed },
    )

  if (opts.dryRun) {
    const planned = scoped.filter((f) => !sameBytesOnDisk(f, join(toolsRoot, f.relPath))).map((f) => f.relPath)
    const argv = composeUpCmd(composeFile)
    commands.push(formatCmd(argv))
    log("info", `apply ${component} dry-run: would write ${planned.length} artefact(s) and recreate with the printed argv`, { planned })
    return finish({
      ok: true,
      message: `dry-run apply ${component}: validated lanes, screened pins, rendered ${scoped.length} artefact(s) of this stack, printed the exact compose command; wrote nothing, ran nothing`,
      ...carried,
      render: renderInfo,
      unchanged: scoped.filter((f) => sameBytesOnDisk(f, join(toolsRoot, f.relPath))).map((f) => f.relPath),
      commands,
    })
  }

  // --- Phase 5: commit this stack's artefacts (content-addressed, rollback on failure) ---------
  const commit = commitScoped(scoped, toolsRoot)
  if (!commit.ok) {
    const rolled = rollback(commit.entries)
    return refuse(
      commit.code,
      `${commit.reason}; rolled back ${rolled} path(s) — prior bytes restored`,
      { ...carried, render: renderInfo },
    )
  }

  // --- Phase 6: integrity again, over the bytes that are now on disk ---------------------------
  const postGate = integrityGate(plan, opts.lock, home)
  if (postGate.refused.length > 0) {
    const rolled = rollback(commit.entries)
    return refuse(
      "APPLY_ARTEFACT_INCOMPLETE",
      `re-rendered estate is not applyable: ${postGate.refused.join("; ")} — rolled back ${rolled} path(s), no container was contacted`,
      { ...carried, render: renderInfo, observedStateGaps: postGate.observed },
    )
  }

  // --- Phase 7: docker legs, all of them pinned to the swarm context ---------------------------
  const stateRes = readState(opts.lock.version)
  const ctxName = stateRes.ok ? resolveDockerContextName(stateRes.state) : "colima-swarm"
  const ctxProbe = contextInspectArgs(ctxName)
  commands.push(formatCmd(ctxProbe))
  const ctxRes = await run(ctxProbe)
  if (ctxRes.exitCode !== 0)
    return refuse(
      "APPLY_CONTEXT_UNAVAILABLE",
      `docker context "${ctxName}" unavailable (${ctxRes.stderr.trim().slice(0, 200)}) — artefacts are committed (${commit.written.length} written, ${commit.unchanged.length} unchanged) but no container was contacted`,
      { ...carried, render: renderInfo, written: commit.written, unchanged: commit.unchanged, observedStateGaps: postGate.observed },
    )

  const composeText = rendered.files.find((f) => f.relPath.endsWith(`${component}.yml`))?.content ?? ""
  const services = parseComposeServices(composeText)
  const keys = laneKeysFor(component)

  // BEFORE-state census for the recreate measurement: names plus creation facts. Captured here, not
  // reconstructed afterwards, so "the other stack is untouched" and "this stack was replaced" are
  // both deltas over observed data.
  const before = await observe(run, composeFile, services, { withExec: false })

  const upArgv = composeUpCmd(composeFile)
  commands.push(formatCmd(upArgv))
  const up = await run(upArgv)
  if (up.exitCode !== 0)
    return refuse(
      "APPLY_COMPOSE_UP_FAILED",
      `compose up exited ${up.exitCode}: ${up.stderr.trim().slice(0, 300)} — artefacts stay as committed (they are the truth of what the user asked for); no rollback of a restart that never began`,
      { ...carried, render: renderInfo, written: commit.written, unchanged: commit.unchanged, commands },
    )

  const wait = await waitForHealthy({
    run,
    composeFile,
    deadlineMs: opts.healthDeadlineMs ?? 180_000,
    intervalMs: opts.healthIntervalMs ?? 3_000,
    ...(opts.sleep ? { sleep: opts.sleep } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.readiness ? { probe: opts.readiness } : {}),
    composeText,
    expectedServices: services,
  })

  // --- Phase 8: prove the value INSIDE the running container -------------------------------------
  const after = await observe(run, composeFile, services, { withExec: true })
  const proof = mergeObservations(before, after, keys)

  // --- Phase 9: the proof is a gate, not a printout ---------------------------------------------
  // 06 §5.3 makes "proves the value inside the running container" part of what this command IS, so
  // a stored value that the container contradicts fails the run rather than being printed and waved
  // through. Absent evidence fails too: rule E3 forbids converting "could not observe" into "passed".
  const proofGaps = proofFailures(proof, lanes.lanes, keys)
  if (proofGaps.length > 0)
    return finish({
      ok: false,
      code: proofGaps.some((g) => g.startsWith("unreadable")) ? "APPLY_PROOF_UNREADABLE" : "APPLY_NOT_APPLIED",
      message: `apply ${component}: ${proofGaps.join("; ")}`,
      ...carried,
      render: renderInfo,
      written: commit.written,
      unchanged: commit.unchanged,
      observedStateGaps: postGate.observed,
      proof,
    })

  const report: ApplyReport = {
    ...finish({
      ok: wait.token === "OK",
      message:
        wait.token === "OK"
          ? `apply ${component}: ${commit.written.length} artefact(s) written, ${commit.unchanged.length} unchanged; recreated under ${formatCmd(upArgv)}; health green in ${wait.attempts} poll(s)`
          : `apply ${component}: artefacts committed and compose up succeeded, but the health gate did not go green: ${wait.verdict.detail}`,
      ...carried,
      render: renderInfo,
      written: commit.written,
      unchanged: commit.unchanged,
      observedStateGaps: postGate.observed,
      proof,
    }),
    health: { token: wait.token, detail: wait.verdict.detail, attempts: wait.attempts },
  }
  if (wait.token !== "OK") return { ...report, ok: false, code: "APPLY_HEALTH_FAILED" }
  log("info", `apply ${component}: green — ${wait.verdict.detail}`, { written: commit.written.length, proof: proof.length })
  return report
}

/** ---------------------------------------------------------------------------------------------
 * Integrity gate — one instrument (the shipped checkPreconditions), used twice.
 *
 * The four artefact-class codes refuse; the state-class codes (RUNTIME_NOT_HEALTHY,
 * COMPONENT_NOT_READY, COMPONENT_SKIPPED) are returned as observations. WHY they do not refuse:
 * rule E9 records that ~/.swarm/setup/state.json is a reconstruction, not a recovery, and forbids
 * treating it as evidence of an install nobody observed — while this verb's whole subject is an
 * estate that is observably running. Whether apply should ALSO require the recorded chain is a
 * ruling for the controller, routed from implementation/s6b_d5_apply.md; until then the honest
 * middle is to gate on bytes (which protect the estate) and report state (which may be stale).
 * --------------------------------------------------------------------------------------------- */
function integrityGate(plan: StackPlan, lock: LockFile, home: string): { refused: string[]; observed: string[] } {
  const stateRes = readState(lock.version)
  if (!stateRes.ok) return { refused: [`state file unreadable: ${stateRes.error}`], observed: [] }
  const report = checkPreconditions(plan, stateRes.state, home)
  const refused: string[] = []
  const observed: string[] = []
  for (const gap of report.gaps) (ARTEFACT_GAP_CODES.includes(gap.code) ? refused : observed).push(describeGap(gap))
  return { refused, observed }
}

function describeGap(gap: PreconditionGap): string {
  return `${gap.code}: ${gap.item}`
}

/** ---------------------------------------------------------------------------------------------
 * Scoped commit — the same three properties row 263's stage ships, applied to one stack's files:
 * content-addressed no-write (identical bytes AND mode are left alone, so mtime freezes), atomic
 * per-file rename, and read-back verification. Rollback restores planted prior bytes and removes
 * what this pass created; a foreign `.tmp-*` sibling is never touched (E13).
 * --------------------------------------------------------------------------------------------- */
interface CommitEntry {
  readonly absPath: string
  readonly prior?: { bytes: string; mode: number }
}

type CommitResult =
  | { ok: true; written: string[]; unchanged: string[]; entries: CommitEntry[] }
  | { ok: false; code: ApplyCode; reason: string; entries: CommitEntry[]; written: string[]; unchanged: string[] }

function sameBytesOnDisk(file: RenderFile, absPath: string): boolean {
  if (!existsSync(absPath)) return false
  try {
    return fileMode(absPath) === file.mode && sha256(readFileSync(absPath, "utf8")) === sha256(file.content)
  } catch {
    return false
  }
}

function commitScoped(scoped: readonly RenderFile[], toolsRoot: string): CommitResult {
  const entries: CommitEntry[] = []
  const written: string[] = []
  const unchanged: string[] = []
  const mismatches: string[] = []
  for (const file of scoped) {
    const absPath = join(toolsRoot, file.relPath)
    if (sameBytesOnDisk(file, absPath)) {
      unchanged.push(file.relPath)
      continue
    }
    let prior: { bytes: string; mode: number } | undefined
    if (existsSync(absPath)) {
      try {
        prior = { bytes: readFileSync(absPath, "utf8"), mode: fileMode(absPath) }
      } catch (err) {
        return {
          ok: false,
          code: "APPLY_WRITE_FAILED",
          reason: `${absPath}: existing target unreadable (${(err as Error).message})`,
          entries,
          written,
          unchanged,
        }
      }
    }
    entries.push({ absPath, ...(prior ? { prior } : {}) })
    try {
      atomicWriteText(absPath, file.content, file.mode)
    } catch (err) {
      return { ok: false, code: "APPLY_WRITE_FAILED", reason: `${absPath}: ${(err as Error).message}`, entries, written, unchanged }
    }
    written.push(file.relPath)
  }
  for (const file of scoped) {
    const absPath = join(toolsRoot, file.relPath)
    if (!existsSync(absPath)) mismatches.push(`${absPath}: missing after commit`)
    else if (fileMode(absPath) !== file.mode) mismatches.push(`${absPath}: mode ${fileMode(absPath).toString(8)} != ${file.mode.toString(8)}`)
    else if (sha256(readFileSync(absPath, "utf8")) !== sha256(file.content)) mismatches.push(`${absPath}: sha256 differs from plan`)
  }
  if (mismatches.length > 0)
    return { ok: false, code: "APPLY_VERIFY_MISMATCH", reason: mismatches.join("; "), entries, written, unchanged }
  return { ok: true, written, unchanged, entries }
}

function rollback(entries: readonly CommitEntry[]): number {
  let restored = 0
  for (const e of entries) {
    try {
      if (e.prior) {
        atomicWriteText(e.absPath, e.prior.bytes, e.prior.mode)
        restored += 1
      } else if (existsSync(e.absPath)) {
        // Only paths THIS pass created are removed — never a foreign sibling (E13).
        rmSync(e.absPath)
        restored += 1
      }
    } catch {
      /* best-effort: the caller reports the refusal either way and names the rollback count */
    }
  }
  return restored
}

/** ---------------------------------------------------------------------------------------------
 * Observation legs — creation facts plus, optionally, the value read inside the container.
 * --------------------------------------------------------------------------------------------- */
async function observe(
  run: DockerRunner,
  composeFile: string,
  services: readonly string[],
  opts: { withExec: boolean },
): Promise<Map<string, ContainerObservation>> {
  const out = new Map<string, ContainerObservation>()
  const ps = await run(composePsArgs(composeFile, services))
  if (ps.exitCode !== 0) return out
  for (const line of ps.stdout.split("\n")) {
    const name = line.split("=")[0]?.trim() ?? ""
    if (name === "") continue
    const obs = await observeOne(run, name, opts.withExec)
    if (obs) out.set(name, obs)
  }
  return out
}

async function observeOne(run: DockerRunner, container: string, withExec: boolean): Promise<ContainerObservation | null> {
  const insp = await run(containerCreateArgs(container))
  if (insp.exitCode !== 0) return null
  const parsed = parseCreateLine(insp.stdout)
  if (!parsed) return null
  let inContainerEnv: Record<string, string> | null = null
  let inContainerError: string | undefined
  if (withExec) {
    const exec = await run(containerExecArgs(container, ["cat", "/proc/1/environ"]))
    if (exec.exitCode === 0) inContainerEnv = parseEnviron(exec.stdout)
    else inContainerError = exec.stderr.trim().slice(0, 200) || `exit ${exec.exitCode}`
  }
  return {
    container,
    service: serviceFromContainerName(container),
    ...parsed,
    inContainerEnv,
    ...(inContainerError ? { inContainerError } : {}),
    laneValues: {},
    recreated: false,
  }
}

/** `{{.Created}} {{config-hash}} {{json .Config.Env}}` — the third field is JSON, so the split is
 *  on the first two spaces only. An empty hash renders as nothing between the separators, hence the
 *  explicit index handling rather than a positional destructure. */
function parseCreateLine(text: string): { created: string | null; configHash: string | null; hostEnv: Record<string, string> } | null {
  const trimmed = text.trim()
  if (trimmed === "") return null
  const first = trimmed.indexOf(" ")
  const second = first >= 0 ? trimmed.indexOf(" ", first + 1) : -1
  if (first < 0 || second < 0) return null
  const created = trimmed.slice(0, first)
  const hash = trimmed.slice(first + 1, second)
  const envJson = trimmed.slice(second + 1).trim()
  let hostEnv: Record<string, string> = {}
  try {
    const arr = JSON.parse(envJson === "<no value>" ? "[]" : envJson) as unknown
    if (Array.isArray(arr)) hostEnv = parseEnvironList(arr.filter((x): x is string => typeof x === "string"))
  } catch {
    /* leave hostEnv empty — the in-container read is the authoritative one anyway */
  }
  return { created, configHash: hash === "" || hash === "<no value>" ? null : hash, hostEnv }
}

/** NUL-separated (procfs) or newline-separated (already-split) KEY=VALUE pairs. Values may contain
 *  "=" themselves, so split on the FIRST "=" only. */
function parseEnviron(raw: string): Record<string, string> {
  return parseEnvironList(raw.split(/[\u0000\n]/))
}

function parseEnvironList(entries: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of entries) {
    const item = entry.trim()
    if (item === "" || !item.includes("=")) continue
    const eq = item.indexOf("=")
    out[item.slice(0, eq)] = item.slice(eq + 1)
  }
  return out
}

/** Every way the in-container evidence can fail to support the claim this command just made. */
function proofFailures(proof: readonly ContainerObservation[], stored: LaneValues, keys: readonly LaneKey[]): string[] {
  const gaps: string[] = []
  if (proof.length === 0) return ["no container of this stack was listed after the recreate — nothing was observed"]
  for (const key of keys) {
    const want = stored[key]
    if (want === undefined) continue // unset control: nothing to prove (06 §5.1 rule 4)
    const carriers = proof.filter((p) => p.service === serviceOfKey(key))
    if (carriers.length === 0) {
      gaps.push(`${key}: no container for its own service was listed, so the value is unobserved`)
      continue
    }
    for (const c of carriers) {
      if (c.inContainerEnv === null) {
        gaps.push(`unreadable ${key} in ${c.container}: /proc/1/environ could not be read (${c.inContainerError ?? "no detail"})`)
        continue
      }
      const got = c.laneValues[key]
      if (got !== String(want))
        gaps.push(`${key} in ${c.container}: stored ${want}, container reports ${got === null ? "<absent>" : got}${c.recreated ? "" : " and the container was NOT replaced"}`)
    }
  }
  return gaps
}

function serviceOfKey(key: LaneKey): string {
  const control = LANE_CONTROLS.find((c) => c.key === key)
  return control?.service ?? ""
}

function mergeObservations(
  before: Map<string, ContainerObservation>,
  after: Map<string, ContainerObservation>,
  keys: readonly LaneKey[],
): ContainerObservation[] {
  const rows: ContainerObservation[] = []
  for (const [name, obs] of after) {
    const pre = before.get(name)
    const source = obs.inContainerEnv ?? obs.hostEnv
    const laneValues: Record<string, string | null> = {}
    for (const key of keys) laneValues[key] = source[key] ?? null
    rows.push({
      ...obs,
      laneValues,
      // Recreate = this name was absent before, or its creation stamp / config-hash moved. A start
      // of the SAME container moves neither, which is exactly the distinction the measurement turns on.
      recreated: pre === undefined ? true : pre.created !== obs.created || pre.configHash !== obs.configHash,
    })
  }
  return rows.sort((a, b) => (a.container < b.container ? -1 : a.container > b.container ? 1 : 0))
}
