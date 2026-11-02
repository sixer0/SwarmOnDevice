// swarm-setup entry point (register PC-PKG-01). Row 81 skeleton: the command surface,
// the state-machine engine wiring, the fail-closed lock loader, the consent gate FIRST,
// the lock directory, and step self-registration by directory scan. Row 83 wired the
// consent UI onto that gate (consent.ts + consentText.ts + policy.ts): per-component nine-
// field blocks, terms linked never auto-accepted, --terms-token validation, durable consent
// recording BEFORE any fetch is permitted, and the F-79-A policy hook (enforcement half).
// SEAM PASS 8 (R113-1): the post-consent branch now DISPATCHES the registered steps instead
// of printing a placeholder and returning FAILED. The engine executes, it does not implement:
// every lifecycle rule lives in row 84's kit / row 91's stacklib / rows 86-90's modules, all
// consumed unchanged through the frozen StepModule contract (_template/index.ts:42-46).
// It performs NO network fetch itself (row 82 owns the library; steps own calling it),
// installs NO component behaviour of its own (rows 86-90), and binds no port (PORT RULE).
//
// Order of operations for `install` (01c §11): platform+root gate -> acquire lock ->
// load+validate tools.lock.json -> read fleet policy (F-79-A hook) -> print consolidated host
// list -> render consent blocks unticked (or refuse tokens) -> record grants durably ->
// (only then) step pipeline. Nothing past the recording line runs without a recorded consent.

import { existsSync, readFileSync } from "node:fs"
import { parseArgs, type ParsedCommand } from "./cli.ts"
import { runEntryGates } from "./gates.ts"
import { loadLock } from "./lockfile.ts"
import { readState, type StateFile } from "./state.ts"
import { acquireLock, releaseLock } from "./lockdir.ts"
import { printHostList, evaluateConsent, renderConsentScreen } from "./consent.ts"
import { enforcePolicy } from "./wiring/policy_enforce.ts"
import { writeConfigEntries, checkSkillFiles, type WriteResult } from "./wiring/config_writer.ts"
import { stageProxyBinary, type ProxyStageOptions, type ProxyStageResult } from "./wiring/proxy_stage.ts"
import { PROXY_BINARY_NAME } from "./mcpproxy/register.ts"
import { discoverSteps, orderSteps, type StepDescriptor } from "./steps.ts"
import { GENERATED_MODULES_BY_ID } from "./steps.gen.ts"
import type { StepContext, StepResult } from "./steps/_template/index.ts"
import { firecrawlPlan, searxngPlan, type DockerRunner, type ReadinessProbe } from "./stacklib.ts"
import { applyEstate, type ApplyReport } from "./estate/apply.ts"
import { homeDir } from "./paths.ts"
import { makeRealDockerRunner } from "./dockerRunner.real.ts"
import { makeReadinessProbe } from "./readinessProbe.ts"
import { COMPONENT_IDS, PROGRAM_NAME, STATES, type ComponentId } from "./constants.ts"
import { OUTCOME, EXIT_OK, EXIT_FAIL, exitCodeFor, messageFor, type OutcomeToken } from "./outcomes.ts"

function usageText(lockVersion?: string): string {
  const title = `${PROGRAM_NAME} — consent-first pre-install for optional Swarm tools (macOS arm64, unprivileged)`
  // Row 106: the banner states the ONE version this program can substantiate — the .version
  // field of the tools.lock.json it just loaded (PC-LBL-03 source). The CLI product version
  // (OPENCODE_VERSION define, register V09 / 01b:101) belongs to the swarm binary, not here;
  // printing it without the define plumbing behind it would be a lie, so it is absent by design.
  const lines = [title]
  if (lockVersion) lines.push(`tools lock: ${lockVersion}`)
  return [
    ...lines,
    "",
    "Usage:",
    `  ${PROGRAM_NAME}                        show this help + component states + host list`,
    `  ${PROGRAM_NAME} --help                 same`,
    `  ${PROGRAM_NAME} install [component...] consent-first install (all seven optional, unticked)`,
    `  ${PROGRAM_NAME} status                 report each component's state (read-only JSON)`,
    `  ${PROGRAM_NAME} remove  [component...] remove only what swarm-setup created (alias: --remove)`,
    `  ${PROGRAM_NAME} wire                   re-wire ~/.config/swarm for components already recorded healthy`,
    `  ${PROGRAM_NAME} apply <stack>          re-render and recreate ONE stack (searxng | firecrawl) from the`,
    `                                   stored lane values and a fresh DNS-pin produce; restarts work in flight`,
    "",
    "Flags:",
    "  --non-interactive                MDM mode; names NO default — pass an explicit component list,",
    "                                   plus --terms-token for every component named (row 198: an",
    "                                   unnamed list refuses with REFUSED_NO_SELECTION instead of",
    "                                   silently selecting all seven)",
    "  --terms-token <component>=<value>  per-tool acknowledgement unlocking --non-interactive",
    "                                   (value = <component_id>@<lock_sha256_12>, shown on the consent screen)",
    "  --consent-mode app               with --non-interactive and --terms-token only: consent.log records",
    "                                   mode app (the Swarm app collected the ticks); the token gate is unchanged",
    "  --dry-run                        touch nothing; install shows exactly what consent would be asked for, remove lists what would be deleted",
    "",
    `Components: ${COMPONENT_IDS.join(", ")}`,
  ].join("\n")
}

function cmdHelp(): OutcomeToken {
  // Load first so the banner can carry the lock version it actually validated (row 106).
  const lockRes = loadLock()
  console.log(usageText(lockRes.ok ? lockRes.lock.version : undefined))
  // Consolidated host list + current states are best-effort reads (no side effects).
  if (lockRes.ok) {
    console.log("")
    printHostList(lockRes.lock.hosts)
    const st = readState(lockRes.lock.version)
    if (st.ok) {
      console.log("")
      console.log("Component states:")
      for (const id of COMPONENT_IDS) console.log(`  ${id}: ${st.state.components[id].state}`)
    }
  } else {
    console.log(`\n(host list unavailable: ${lockRes.error})`)
  }
  return OUTCOME.OK
}

function cmdStatus(): OutcomeToken {
  const lockRes = loadLock()
  if (!lockRes.ok) {
    console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
    return OUTCOME.REFUSED_LOCK_MALFORMED
  }
  const st = readState(lockRes.lock.version)
  if (!st.ok) {
    console.error(`${PROGRAM_NAME}: ${st.error}`)
    return OUTCOME.FAILED
  }
  // Read-only: print the state envelope as pure JSON on stdout (the schema artifact).
  console.log(JSON.stringify(st.state, null, 2))
  return OUTCOME.OK
}

/** Row 198 (fix contract §3): the non-interactive path may never silently select everything. An
 *  unnamed list is legitimate ONLY where a human is present to tick boxes — register PC-CMD-01 freezes
 *  "no args presents all seven optional/unticked" for the interactive path, and the ticking IS the
 *  consent. With --non-interactive nobody is ticking: the old all-seven default forced operators to
 *  harvest seven tokens out of a --dry-run screen, which constraint N6 forbids becoming product
 *  behaviour. Returning null means "refuse"; the caller prints the candidates and returns
 *  REFUSED_NO_SELECTION. Named here so both verbs share one rule (drift D10 found the second copy). */
function resolveSelected(named: readonly ComponentId[], nonInteractive: boolean): ComponentId[] | null {
  if (named.length > 0) return [...named]
  if (nonInteractive) return null
  return [...COMPONENT_IDS]
}

/** Row 198: one refusal text for both verbs. Names every candidate id so an operator learns what to
 *  pass without reading source, and states the required form generically rather than picking
 *  components for them. The full register set is printed (not the policy-filtered remainder) because
 *  this is the answer to "what can this verb install?" and because a filtered list could be empty;
 *  a named-but-forbidden component still gets its own F-79-A warning from `selectable`. */
function printNoSelectionRefusal(verb: string): void {
  console.error(`${PROGRAM_NAME}: ${verb} --non-interactive named no component; refusing instead of selecting all seven`)
  console.error(`${PROGRAM_NAME}: candidates: ${COMPONENT_IDS.join(", ")}`)
  console.error(
    `${PROGRAM_NAME}: required form: ${PROGRAM_NAME} ${verb} <component> [<component>...] --non-interactive --terms-token <component>=<value> (one per named component)`,
  )
}

/** F-79-A enforcement (hook only; admin switch DEFERRED): forbidden components never reach the
 *  consent screen — they are dropped here and again inside evaluateConsent (one enforcement point
 *  per layer, same rule). A named-but-forbidden component warns so the operator sees why it vanished. */
function selectable(selected: readonly ComponentId[], forbidden: readonly ComponentId[]): ComponentId[] {
  const set = new Set(forbidden)
  const blocked = selected.filter((id) => set.has(id))
  if (blocked.length > 0)
    console.error(
      `${PROGRAM_NAME}: admin policy forbids ${blocked.join(", ")} — not presented, token or not (F-79-A hook)`,
    )
  return selected.filter((id) => !set.has(id))
}

// --- step execution (seam pass 8, R113-1) ---------------------------------------------------
//
// The dispatch half of the engine. WHY IT LIVES HERE: s84 §5 states the division once — "The
// engine (index.ts) still owns dispatch" — and row 113's acceptance routes R113-1 to exactly this
// lane ("row 81's engine (src/index.ts) … with rows 86-90's step exports consumed unchanged",
// verification/09_preinstall_security.md:909-911). This section calls modules through the frozen
// StepModule contract; it implements NO lifecycle, NO fetch, NO gate. Every rule stays where its
// owner shipped it: consent layer 2 in stepkit, the §4.1 transition chain in stepkit+state.ts,
// verification in fetch/verify, bring-up semantics in stacklib, component behaviour in steps/*.

/** What a step module must look like to be dispatched. The full StepModule also requires remove();
 *  the install lane only ever calls install(), so this narrower shape is what executeSteps accepts. */
interface InstallableStep {
  install(ctx: StepContext): StepResult | Promise<StepResult>
}

/** One dispatched step's outcome, printed verbatim — message truthfulness over tidiness (the
 *  R112b-7 lesson: never summarise away what the owning module actually said). */
export interface StepExecution {
  readonly id: ComponentId
  readonly token: OutcomeToken
  readonly message?: string
}

export interface StepExecutionReport {
  /** The run's headline token: the MOST severe per-step outcome (see severityRank). */
  readonly token: OutcomeToken
  readonly executions: StepExecution[]
}

/** Severity order for the run-level token, read off 01c §8's exit rule (outcomes.ts exitCodeFor):
 *  FAILED is the worst (§8 maps every hard failure to PC-ST-07), then BLOCKED_BY_NETWORK (PC-ST-09,
 *  exit 1), then HEALTH_FAILED (exit 1), then the instruction/skip family (exit 0), OK last. A run
 *  containing any refusal/failure step must exit 1 honestly even if other components succeeded.
 *  PARTIAL on purpose: the entry-gate refusals (ROOT/PLATFORM/CONCURRENCY/NON_INTERACTIVE/
 *  LOCK_MALFORMED) are produced by main/cmdInstall BEFORE or AROUND the pipeline, never by a step
 *  module, so they carry no rank; moreSevere treats an unranked token as most severe. */
const SEVERITY_RANK: Partial<Record<OutcomeToken, number>> = {
  [OUTCOME.FAILED]: 0,
  [OUTCOME.BLOCKED_BY_NETWORK]: 1,
  [OUTCOME.HEALTH_FAILED]: 2,
  [OUTCOME.REFUSED_NO_CONSENT]: 3,
  [OUTCOME.SKIPPED_WITH_INSTRUCTIONS]: 4,
  [OUTCOME.SKIPPED]: 5,
  [OUTCOME.OK]: 6,
}

function moreSevere(a: OutcomeToken, b: OutcomeToken): OutcomeToken {
  const rankA = SEVERITY_RANK[a] ?? -1
  const rankB = SEVERITY_RANK[b] ?? -1
  return rankA <= rankB ? a : b
}

/** Resolve the embedded module for one discovered step id. GENERATED_MODULES_BY_ID is generated
 *  from the SAME directories the scan reads and gen-steps fail-closes on any default-export defect,
 *  so an id with no entry means the registry and the descriptor set disagree — reported as FAILED,
 *  never silently skipped. The `modules` parameter is a TEST SEAM ONLY (same narrowing discipline
 *  as r82 allowedHosts / r83 ask / r84 consentGate): it can replace WHICH module object runs so a
 *  unit can observe ordering or script a refusal; it cannot grant consent, skip a gate, or widen
 *  any contact surface, and shipped code never passes it. */
function resolveStepModule(
  id: ComponentId,
  modules: Readonly<Record<string, Partial<InstallableStep>>> = GENERATED_MODULES_BY_ID,
): { ok: true; module: InstallableStep } | { ok: false; error: string } {
  const candidate = modules[id]
  if (!candidate || typeof candidate.install !== "function") {
    return { ok: false, error: `no dispatchable step module for "${id}" (registry/descriptor divergence)` }
  }
  return { ok: true, module: candidate as InstallableStep }
}

/** The docker CLI candidates, in priority order. No new literal is invented: the first is
 *  dockerRunner.real.ts's DOCKER_BINARY_DEFAULT (itself the P-1 signature target row 86 pins), the
 *  second is the Intel-prefix path row 86's commands.ts already carries. Resolution is existsSync
 *  only — no PATH lookup, no spawn (P-3). */
const DOCKER_BINARY_CANDIDATES = ["/opt/homebrew/bin/docker", "/usr/local/bin/docker"] as const

function resolveDockerBinary(): string | undefined {
  return DOCKER_BINARY_CANDIDATES.find((p) => existsSync(p))
}

/** Per-step context. The base trio is the frozen StepContext (_template/index.ts:28-32); stack
 *  steps additionally consume the engine-injected runner + prober (StackStepContext, stacklib.ts
 *  :112-119 — "The engine injects the spawn-backed runner; without it the steps refuse honestly").
 *  Injection is DELIBERATELY NARROW and can only make gates stricter:
 *   - the runner appears only when a docker CLI actually exists on this host; without one
 *     runnerGuard refuses with its own honest message instead of a fabricated spawn failure;
 *   - the readiness prober exists only when the stack's rendered compose artefact can be read —
 *     it parses ports FROM that artefact (PORT RULE), so there is nothing to probe without it and
 *     stacklib's no-healthcheck lane fails closed exactly as row 91 shipped it;
 *   - nothing here can grant consent, skip a precondition, or widen any contact surface. */
function buildStepContext(id: ComponentId, ctx: StepContext): StepContext {
  if (id !== "searxng" && id !== "firecrawl") return ctx
  const dockerBinary = resolveDockerBinary()
  if (!dockerBinary) return ctx
  const lifecycle = makeRealDockerRunner({ dockerBinary })
  const probe = makeRealDockerRunner({ dockerBinary, timeoutMs: 25_000 })
  const plan = id === "searxng" ? searxngPlan() : firecrawlPlan()
  let composeText: string | null = null
  try {
    composeText = readFileSync(plan.composeFile, "utf8")
  } catch {
    composeText = null // artefact not rendered yet — the prober stays out and the gate fails closed
  }
  return {
    ...ctx,
    docker: lifecycle.runner as DockerRunner,
    ...(composeText !== null
      ? { readiness: makeReadinessProbe({ docker: probe.runner, composeText }) }
      : {}),
  } as StepContext
}

/** Execute the ordered steps against one shared live state object (state.ts setState commits each
 *  transition, so a later step reads an earlier step's recorded facts — e.g. searxng's precondition
 *  sees runtime's healthy entry). Per 01c §8 a failed or network-blocked optional component does
 *  NOT stop the others, so the loop continues after a red step; dependents still run and refuse on
 *  their own fail-closed preconditions, which name the real gap instead of the engine guessing. */
export async function executeSteps(
  ordered: readonly StepDescriptor[],
  ctx: StepContext,
  modules?: Readonly<Record<string, Partial<InstallableStep>>>,
): Promise<StepExecutionReport> {
  const executions: StepExecution[] = []
  let token: OutcomeToken = OUTCOME.OK
  for (const step of ordered) {
    const resolved = resolveStepModule(step.id, modules)
    if (!resolved.ok) {
      executions.push({ id: step.id, token: OUTCOME.FAILED, message: resolved.error })
      token = moreSevere(token, OUTCOME.FAILED)
      continue
    }
    let result: StepResult
    try {
      // Steps are async (fetch/extract/health); the contract allows sync too, and await covers both.
      result = await resolved.module.install(buildStepContext(step.id, ctx))
    } catch (err) {
      // A throwing step is a real failure surfaced honestly (never swallowed); the lock release
      // stays guaranteed by cmdInstall's finally, so rethrowing adds no safety, only a stack trace
      // where a named per-step outcome belongs (01c §8: every failure is a named outcome).
      result = { token: OUTCOME.FAILED, message: `step ${step.id} threw: ${(err as Error).message}` }
    }
    const stepToken: OutcomeToken = typeof result?.token === "string" ? result.token : OUTCOME.FAILED
    executions.push({
      id: step.id,
      token: stepToken,
      ...(typeof result?.message === "string" ? { message: result.message } : {}),
    })
    token = moreSevere(token, stepToken)
  }
  return { token, executions }
}

async function cmdInstall(cmd: ParsedCommand): Promise<OutcomeToken> {
  const lock = acquireLock()
  if (!lock.ok) {
    console.error(`${PROGRAM_NAME}: another swarm-setup is running (holder pid ${lock.holderPid})`)
    return OUTCOME.REFUSED_CONCURRENCY
  }
  try {
    const lockRes = loadLock()
    if (!lockRes.ok) {
      console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
      return OUTCOME.REFUSED_LOCK_MALFORMED
    }

    // F-79-A policy hook — LIVE enforcement since FIX3 (r97 routed): strict schema validation and
    // a policy_active line on the unified audit chain whenever a policy is consulted; fail-closed
    // on every defect including unknown top-level keys. Read BEFORE anything is presented, so a
    // forbidden component never reaches the consent screen. Absent file = inactive, unchanged v1
    // behaviour (the admin switch itself stays DEFERRED per decisions.md).
    const policy = enforcePolicy({ correlationId: `run-${process.pid}` })
    if (!policy.ok) {
      console.error(`${PROGRAM_NAME}: ${policy.error}`)
      return OUTCOME.FAILED
    }
    const forbidden = policy.forbidden

    // Step 4: consolidated host list BEFORE any download (P-18 / P-13).
    printHostList(lockRes.lock.hosts)

    // Step 5 (row 83): per-component consent blocks — nine P-13 fields, live zero-network pins,
    // terms LINKED not auto-accepted, admin token for this lock. --dry-run shows EXACTLY what
    // would be asked, then refuses without consent (row-81 PROOF 3 exit contract preserved:
    // a dry run never consents, never records, never downloads).
    const selected = resolveSelected(cmd.components, cmd.nonInteractive)
    if (selected === null) {
      // Row 198: refuses BEFORE the consent gate, so no token is demanded, no consent is recorded and
      // nothing downstream (fetch, steps, the row-197 writer call) can be reached.
      printNoSelectionRefusal("install")
      return OUTCOME.REFUSED_NO_SELECTION
    }
    const offered = selectable(selected, forbidden)
    if (cmd.dryRun) {
      renderConsentScreen(lockRes.lock, offered, { dryRun: true })
      const scan = discoverSteps()
      for (const e of scan.errors) console.error(`${PROGRAM_NAME}: step descriptor error: ${e}`)
      const ordered = orderSteps(scan.steps)
      if (ordered.ok) {
        console.log("dry-run: after consent, steps would run in this order (touching nothing):")
        for (const s of ordered.ordered) console.log(`  - ${s.id}`)
      }
      return OUTCOME.REFUSED_NO_CONSENT
    }

    // Step 6: consent gate. Nothing downloads unless consent is granted AND durably recorded
    // (evaluateConsent records to PC-PATH-03 with fsync BEFORE it can return ok:true).
    const consent = evaluateConsent({
      selected: offered,
      nonInteractive: cmd.nonInteractive,
      appConsent: cmd.appConsent,
      tokens: cmd.tokens,
      lock: lockRes.lock,
      forbidden,
    })
    if (!consent.ok) {
      return consent.token // REFUSED_NO_CONSENT / REFUSED_NON_INTERACTIVE — nothing fetched, nothing written
    }

    // --- Past consent: consent is now durable on disk (consent.log) AND selected for this run
    // (consent.ts grant-in-effect). Seam pass 8 (R113-1): this is where the pipeline ACTUALLY runs.
    // Only the CONSENTED components are dispatched; orderSteps keeps the engine's topological
    // order among them; each module owns its own behaviour, gates and state commits (rows 84-91).
    const scan = discoverSteps()
    if (scan.errors.length > 0) {
      for (const e of scan.errors) console.error(`${PROGRAM_NAME}: step descriptor error: ${e}`)
      return OUTCOME.FAILED
    }
    const consented = new Set<ComponentId>(consent.consented)
    const pipeline = scan.steps.filter((s) => consented.has(s.id))
    if (pipeline.length === 0) {
      // Unreachable through evaluateConsent (it refuses when nothing was granted); kept as an
      // explicit dead end so a future widening can never fall through to "consent recorded,
      // nothing ran" — the exact R113-1 shape.
      console.error(`${PROGRAM_NAME}: consent recorded but no registered step matches the consented set`)
      return OUTCOME.FAILED
    }
    const ordered = orderSteps(pipeline)
    if (!ordered.ok) {
      console.error(`${PROGRAM_NAME}: ${ordered.error}`)
      return OUTCOME.FAILED
    }
    const st = readState(lockRes.lock.version)
    if (!st.ok) {
      // The pipeline cannot run without a trustworthy resume point (01c §4/§6.3): a corrupt
      // state file fails the run closed rather than starting from a fabricated clean state.
      console.error(`${PROGRAM_NAME}: ${st.error}`)
      return OUTCOME.FAILED
    }
    const report = await executeSteps(ordered.ordered, { lock: lockRes.lock, state: st.state, dryRun: false })
    for (const e of report.executions) {
      console.log(`step ${e.id}: ${e.token}${e.message ? ` — ${e.message.split("\n")[0]}` : ""}`)
    }

    // D1 wiring (row 197): the product now wires its own tools after the pipeline, with no caller
    // reaching into the module and no --dry-run token scraping. The health gate lives INSIDE the writer
    // (config_writer.ts eligibility()), so this call is unconditional-after-the-pipeline and an unhealthy
    // component produces a recorded skip rather than a write (§1.1 property 1). Pass the LIVE state the
    // steps just mutated (st.state) instead of re-reading disk at the moment it most recently changed
    // (§1.1 property 3). Skip reasons are printed verbatim; a writer refusal (D13 unparseable config,
    // symlinked target, unreadable state) folds FAILED in so the run exits non-zero (§1.1 property 2, AC-T4).
    // U14 row 221: copy the shipped swarm-web-proxy into PC-PATH-14 (hash-checked) BEFORE the writer, so its
    // existsSync gate can pass. The writer still decides eligibility; staging is only skipped when the
    // component behind swarm-web is not healthy, since the writer would skip it anyway (senior 239 finding 15).
    // A missing source keeps the writer's own skip reason; a refused or mismatched copy folds FAILED in.
    const stage = stageProxyForWiring(st.state)
    printProxyStageOutcome(stage)
    const wire = writeConfigEntries({ state: st.state, lock: lockRes.lock })
    printWiringOutcome(wire)
    if (!wire.ok) return moreSevere(report.token, OUTCOME.FAILED)
    if (!stage.ok) return moreSevere(report.token, OUTCOME.FAILED)
    return report.token
  } finally {
    releaseLock()
  }
}

/** Surface the writer's own result honestly: every skip reason verbatim, what changed, or the refusal.
 *  Never summarise a skip away into a bare OK (directive N9 refuse-silently class; §1.1 property 2). */
export function printWiringOutcome(wire: WriteResult): void {
  if (!wire.ok) {
    console.error(`${PROGRAM_NAME}: wiring refused: ${wire.reason}`)
    return
  }
  if (wire.skipped.graft) console.log(`wire graft: skipped — ${wire.skipped.graft}`)
  if (wire.skipped.swarmWeb) console.log(`wire swarm-web: skipped — ${wire.skipped.swarmWeb}`)
  for (const [rel, reason] of Object.entries(wire.skipped.skills ?? {})) console.log(`wire ${rel}: skipped — ${reason}`)
  if (!wire.changed) {
    console.log("wire: no change (already current)")
    return
  }
  const written = [
    wire.wrote.graft && "swarm.json:mcp.graft",
    wire.wrote.swarmWeb && "swarm.json:mcp.swarm-web",
    ...wire.wrote.skills,
  ].filter((s): s is string => Boolean(s))
  console.log(`wire: wrote ${written.join(", ")}`)
  for (const b of wire.backups) console.log(`wire: backup ${b}`)
}

/** The proxy stager's result, verbatim (row 221). */
export function printProxyStageOutcome(stage: ProxyStageResult): void {
  if (!stage.ok) console.error(`${PROGRAM_NAME}: stage ${PROXY_BINARY_NAME} refused: ${stage.reason}`)
  else if (!stage.staged) console.log(`stage ${PROXY_BINARY_NAME}: skipped — ${stage.reason}`)
  else console.log(`stage ${PROXY_BINARY_NAME}: ${stage.changed ? "copied" : "already current"} (sha256 ${stage.sha256.slice(0, 12)})`)
}

/** The component behind the writer's `swarmWeb` gate (config_writer.ts eligibility(): searxng plus the proxy). */
const SWARM_WEB_COMPONENT: ComponentId = "searxng"

/** Stage the proxy only when swarm-web can be wired this run (senior 239 finding 15). The ~61 MiB copy and its
 *  hashes are pointless when the component behind the gate is not healthy, e.g. `install node` on a machine
 *  without searxng. The writer keeps the eligibility rule and its own skip reason; this only avoids the copy. */
export function stageProxyForWiring(state: StateFile, opts: ProxyStageOptions = {}): ProxyStageResult {
  if (state.components[SWARM_WEB_COMPONENT]?.state !== STATES.HEALTHY)
    return { ok: true, staged: false, reason: `${SWARM_WEB_COMPONENT} component is not healthy (P-15)` }
  return stageProxyBinary(opts)
}

/** Which component actually has to become healthy for a writer gate to open. The writer keys eligibility
 *  on its own gate names (`Eligibility` in config_writer.ts), and `swarmWeb` is backed by the searxng
 *  component plus its staged proxy binary — so the repair command must name searxng, not "swarm-web". */
const WIRE_GATE_TO_COMPONENT: Readonly<Record<string, ComponentId>> = {
  graft: "graft",
  swarmWeb: SWARM_WEB_COMPONENT,
  rtk: "rtk",
  obsidian: "obsidian",
}

/** Recover the gate a writer skip reason names. Only the writer's own sentence shape is matched; an
 *  unrecognised reason (e.g. the graft launch guard refusing) yields undefined and the caller falls back
 *  to the gate the skip was recorded under, so no reason string ever goes unexplained. */
function wireGateOfReason(reason: string): string | undefined {
  const unhealthy = /^(\w+) component is not healthy \(P-15\)$/.exec(reason)
  if (unhealthy?.[1]) return unhealthy[1]
  if (reason.startsWith("proxy binary not staged")) return "swarmWeb"
  return undefined
}

/** Fix contract §4.4: an unhealthy target prints the writer's reason (already done, verbatim, by
 *  printWiringOutcome) PLUS the command that would make it eligible. Deduplicated per component so two
 *  texts gated on the same component produce one instruction, not two. */
function printWireRepairs(wire: WriteResult): void {
  if (!wire.ok) return
  const gates: string[] = []
  if (wire.skipped.graft) gates.push(wireGateOfReason(wire.skipped.graft) ?? "graft")
  if (wire.skipped.swarmWeb) gates.push(wireGateOfReason(wire.skipped.swarmWeb) ?? "swarmWeb")
  for (const reason of Object.values(wire.skipped.skills ?? {})) {
    const gate = wireGateOfReason(reason)
    if (gate) gates.push(gate)
  }
  const instructed = new Set<string>()
  for (const gate of gates) {
    const component = WIRE_GATE_TO_COMPONENT[gate]
    if (!component || instructed.has(component)) continue
    instructed.add(component)
    console.log(`wire: repair with ${PROGRAM_NAME} install ${component}`)
  }
}

/** Row 199 (fix contract §4, masterplan/03_s6_fix_contract.md) — the `wire` verb, kept off the critical
 *  path for the one machine state this project is actually in: tools installed while the wiring never
 *  ran (§4.1 reason 1, measured at research/s6_01_seam_anchor.md:421-427; and §4.1 reason 2 — there is
 *  no non-destructive product path out of that state, because `remove` prints targets and returns
 *  SKIPPED_WITH_INSTRUCTIONS without deleting anything).
 *
 *  IT RESOLVES NO COMPONENT LIST, AND THAT IS THE DESIGN. Scope comes entirely from the writer's health
 *  gate (`eligibility()` in config_writer.ts, which keys on a component's recorded state being healthy),
 *  so "wire with no arguments" means "rewire exactly what is already recorded healthy" — never "all
 *  seven". Drift D10 (research/s6_01_seam_anchor.md:460) was born from an empty-list-means-everything
 *  default living in two places; row 198 closed both into `resolveSelected` and warned that a third verb
 *  resolving its own list would reopen it (implementation/s6_r198_selection.md §6). This verb cannot
 *  reopen it: there is no expression here that turns an absent argument into a component list, so there
 *  is no default to inherit and nothing for the shared rule to be bypassed around. test/wire_verb.test.ts
 *  pins that absence mechanically (source tripwire) and behaviourally (all-absent wires nothing).
 *
 *  Thin call, not a second engine (§4.2): eligibility, backup naming, the ledger and the byte compare all
 *  stay inside config_writer.ts, reached through the same entry point row 197 shipped and printed by the
 *  same printer, so no writer logic is duplicated here.
 *
 *  Consent posture: `wire` re-runs wiring ONLY. It never calls evaluateConsent, never renders a consent
 *  screen, never dispatches a step module and never commits state — so it cannot fabricate consent or
 *  reach an install step. `--terms-token` is inert here for the same reason it is inert in `remove`: a
 *  token acknowledges terms for a download, and this verb downloads nothing. `--dry-run` is REFUSED rather
 *  than ignored: PC-FLAG-03 promises "touch nothing", and wiring writes, so accepting the flag would let
 *  the CLI promise something it does not do (directive N9's refuse-silently class). */
function cmdWire(cmd: ParsedCommand): OutcomeToken {
  if (cmd.components.length > 0) {
    console.error(
      `${PROGRAM_NAME}: wire takes no component list — it rewires exactly the components already recorded healthy, and scope is decided by the writer's health gate, not by arguments`,
    )
    console.error(
      `${PROGRAM_NAME}: named ${cmd.components.join(", ")}; to make one eligible, install it first: ${PROGRAM_NAME} install <component>`,
    )
    return OUTCOME.FAILED
  }
  if (cmd.dryRun) {
    console.error(`${PROGRAM_NAME}: wire --dry-run is not offered: wiring writes ~/.config/swarm, so "touch nothing" cannot be honoured here`)
    console.error(`${PROGRAM_NAME}: use "${PROGRAM_NAME} status" to inspect the recorded states, or install a component to make it eligible`)
    return OUTCOME.FAILED
  }

  const lock = acquireLock()
  if (!lock.ok) {
    console.error(`${PROGRAM_NAME}: another swarm-setup is running (holder pid ${lock.holderPid})`)
    return OUTCOME.REFUSED_CONCURRENCY
  }
  try {
    const lockRes = loadLock()
    if (!lockRes.ok) {
      console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
      return OUTCOME.REFUSED_LOCK_MALFORMED
    }
    const st = readState(lockRes.lock.version)
    if (!st.ok) {
      console.error(`${PROGRAM_NAME}: ${st.error}`)
      return OUTCOME.FAILED
    }

    // The same entry point row 197 shipped for install, called the same way: live state in, writer's own
    // health gate deciding scope. No second eligibility check is added here (contract §1.1 property 1 —
    // two owners of one rule is how the half-state got out of sync in the first place).
    const wire = writeConfigEntries({ state: st.state, lock: lockRes.lock })
    printWiringOutcome(wire)
    if (!wire.ok) return OUTCOME.FAILED // §4.4 last row: the flat reason is already printed verbatim; exit 1

    printWireRepairs(wire)

    // Post-write byte check over the rendered texts, reported with its real count so exit 0 on a machine
    // where nothing is eligible cannot be read as a clean bill (contract §5.3 / drift D5). Diagnostic only:
    // a drift immediately after the writer itself wrote those bytes is a contradiction, so it fails loudly.
    const check = checkSkillFiles({ state: st.state, lock: lockRes.lock })
    if (check.checked.length === 0)
      console.log("wire: drift check compared 0 file(s) — no text gate is healthy, so this says nothing about the texts")
    else if (check.ok)
      console.log(`wire: drift check compared ${check.checked.length} file(s), all byte-equal to a fresh render: ${check.checked.join(", ")}`)
    else for (const d of check.drifts) console.error(`${PROGRAM_NAME}: wire drift ${d}`)
    if (!check.ok) return OUTCOME.FAILED

    // AC-V3 / §4.4: any skipped target means the run is NOT an OK — the operator chain keys on
    // SKIPPED_WITH_INSTRUCTIONS (exit 0) while the reasons and repair commands above carry the detail.
    const anySkip =
      !!wire.skipped.graft || !!wire.skipped.swarmWeb || Object.keys(wire.skipped.skills ?? {}).length > 0
    if (anySkip) return OUTCOME.SKIPPED_WITH_INSTRUCTIONS
    return OUTCOME.OK
  } finally {
    releaseLock()
  }
}

/** Row 246 (blueprint 11) — the apply owner: re-render and recreate ONE stack from the stored lane
 *  tuple plus a fresh DNS-pin produce. Named command, single-stack scope, and the same
 *  `acquireLock()` posture every other mutating verb uses: the estate is single-writer by rule, so
 *  a second swarm-setup holding the setup lock makes this verb refuse with REFUSED_CONCURRENCY
 *  before a path resolves or a container is addressed (06 §5.3 "refuses while another row holds the
 *  profile"; blueprint 11's `colima-swarm-profile` lock is the wave-level twin of this mechanism).
 *
 *  Consent is not asked for and not required: consent covers a download (consent.ts records terms
 *  per artifact), and this verb downloads nothing — it moves local bytes and restarts local
 *  containers that an earlier consented install created. It dispatches no step module and commits
 *  no lifecycle state, for the same reason `wire` dispatches nothing.
 *
 *  `--dry-run` IS honoured here (unlike `wire`, which refuses it): apply's dry run validates the
 *  stored configuration, renders into memory and prints the exact compose argv, and touches
 *  neither disk nor daemon, so PC-FLAG-03's "touch nothing" promise is literally true. */
async function cmdApply(cmd: ParsedCommand): Promise<OutcomeToken> {
  if (cmd.components.length !== 1) {
    console.error(
      `${PROGRAM_NAME}: apply takes exactly one stack name — searxng or firecrawl — and applies it to that stack alone`,
    )
    console.error(
      cmd.components.length === 0
        ? `${PROGRAM_NAME}: required form: ${PROGRAM_NAME} apply <searxng|firecrawl>`
        : `${PROGRAM_NAME}: named ${cmd.components.join(", ")}; run one apply per stack so the other stack is provably untouched`,
    )
    return OUTCOME.FAILED
  }
  const lock = acquireLock()
  if (!lock.ok) {
    console.error(`${PROGRAM_NAME}: another swarm-setup is running (holder pid ${lock.holderPid})`)
    return OUTCOME.REFUSED_CONCURRENCY
  }
  try {
    const lockRes = loadLock()
    if (!lockRes.ok) {
      console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
      return OUTCOME.REFUSED_LOCK_MALFORMED
    }
    const home = homeDir()
    const component = cmd.components[0] as string
    const engine = buildApplyEngine(component, home, cmd.dryRun)
    const report = await applyEstate({
      component,
      lock: lockRes.lock,
      home,
      dryRun: cmd.dryRun,
      ...(engine.docker ? { run: engine.docker } : {}),
      ...(engine.readiness ? { readiness: engine.readiness } : {}),
    })
    printApplyReport(report)
    return report.ok ? OUTCOME.OK : OUTCOME.FAILED
  } finally {
    releaseLock()
  }
}

/** Engine injection for apply, built exactly the way buildStepContext builds it for the stack
 *  steps: a spawn-backed runner only when a docker CLI exists on this host (without one the apply
 *  refuses honestly at its context probe instead of reporting a fabricated spawn failure), and a
 *  readiness prober only when THIS stack's rendered artefact can be read, because the prober parses
 *  its probe URLs from that artefact (PORT RULE). Narrowing-only, like every other seam in this
 *  package: neither injection can skip a gate or widen a scope. */
function buildApplyEngine(
  component: string,
  home: string,
  dryRun: boolean,
): { docker?: DockerRunner; readiness?: ReadinessProbe } {
  if (component !== "searxng" && component !== "firecrawl") return {}
  const dockerBinary = resolveDockerBinary()
  if (!dockerBinary) return {}
  const plan = component === "searxng" ? searxngPlan(home) : firecrawlPlan(home)
  let composeText: string | null = null
  try {
    composeText = readFileSync(plan.composeFile, "utf8")
  } catch {
    composeText = null
  }
  const lifecycle = makeRealDockerRunner({ dockerBinary })
  if (!composeText || dryRun) return { docker: lifecycle.runner as DockerRunner }
  const probe = makeRealDockerRunner({ dockerBinary, timeoutMs: 25_000 })
  return { docker: lifecycle.runner as DockerRunner, readiness: makeReadinessProbe({ docker: probe.runner, composeText }) }
}

/** Message truthfulness over tidiness (the R112b-7 lesson): what was written, what was left alone,
 *  every docker argv issued, and the value read back INSIDE each running container — the claim
 *  06 §5.3 makes this command prove, printed rather than inferred. */
function printApplyReport(report: ApplyReport): void {
  const head = report.ok ? `apply ${report.stack}: OK` : `apply ${report.stack}: FAILED${report.code ? ` [${report.code}]` : ""}`
  console.log(head + " — " + report.message.split("\n")[0])
  for (const line of report.message.split("\n").slice(1)) console.log(`  ${line}`)
  console.log(`  lanes: ${report.lanesPresent ? JSON.stringify(report.lanes) : "no lanes.json stored (controls unset)"} · pins refresh: ${report.pinsRefresh.action} (${report.pinsRefresh.detail})`)
  if (report.written.length > 0) console.log(`  wrote ${report.written.join(", ")}`)
  if (report.unchanged.length > 0) console.log(`  unchanged ${report.unchanged.length} artefact(s) (content-addressed no-write)`)
  for (const gap of report.observedStateGaps) console.log(`  observed (not gating): ${gap}`)
  for (const c of report.commands) console.log(`  $ ${c}`)
  if (report.health) console.log(`  health gate: ${report.health.token} after ${report.health.attempts} poll(s) — ${report.health.detail}`)
  for (const p of report.proof) {
    const observed = Object.entries(p.laneValues)
      .map(([k, v]) => `${k}=${v ?? "<absent>"}`)
      .join(" ")
    console.log(
      `  proof ${p.container} (${p.service}): recreated=${p.recreated} created=${p.created ?? "?"} config-hash=${p.configHash ?? "none"} in-container: ${observed || "no lane keys for this stack"}${p.inContainerError ? ` [environ unreadable: ${p.inContainerError}]` : ""}`,
    )
  }
}

function cmdRemove(cmd: ParsedCommand): OutcomeToken {
  const lock = acquireLock()
  if (!lock.ok) {
    console.error(`${PROGRAM_NAME}: another swarm-setup is running (holder pid ${lock.holderPid})`)
    return OUTCOME.REFUSED_CONCURRENCY
  }
  try {
    const lockRes = loadLock()
    if (!lockRes.ok) {
      console.error(`${PROGRAM_NAME}: ${lockRes.error}`)
      return OUTCOME.REFUSED_LOCK_MALFORMED
    }
    const st = readState(lockRes.lock.version)
    if (!st.ok) {
      console.error(`${PROGRAM_NAME}: ${st.error}`)
      return OUTCOME.FAILED
    }

    // Collect ONLY objects the setup created (P-14: label + state manifest must agree).
    // Row 198 (fix contract §3.1/§3.4, drift D10): this is the SECOND copy of the all-seven default,
    // inline here rather than in resolveSelected. It shares install's rule — an unnamed scope is only
    // safe while a human is presenting. remove deletes nothing today (it ends in
    // SKIPPED_WITH_INSTRUCTIONS), so an unnamed INTERACTIVE run keeps the all-seven scope it prints;
    // the refusal exists for the day deletion lands, when a destructive verb defaulting to everything
    // would be a worse hazard than the install default this session is fixing.
    const scope = resolveSelected(cmd.components, cmd.nonInteractive)
    if (scope === null) {
      printNoSelectionRefusal("remove")
      return OUTCOME.REFUSED_NO_SELECTION
    }
    const targets: string[] = []
    for (const id of scope) {
      const c = st.state.components[id]
      if (!c.installedBySwarm) continue
      for (const p of c.paths ?? []) targets.push(`${id}:path ${p}`)
      for (const o of c.dockerObjects ?? [])
        if (o.createdBySwarm) targets.push(`${id}:${o.kind} ${o.id}${o.hasData ? " [DATA]" : ""}`)
    }

    if (cmd.dryRun) {
      console.log(`dry-run remove: would delete ${targets.length} object(s), deleting nothing:`)
      for (const t of targets) console.log(`  - ${t}`)
      return OUTCOME.OK
    }
    if (targets.length === 0) {
      console.log("nothing to remove: swarm-setup created no objects")
      return OUTCOME.OK
    }
    // Actual deletion (label match + ask-before-volume) is owned by rows 90+/97.
    console.log(`remove would target ${targets.length} object(s); deletion behaviour is owned by rows 90+/97`)
    for (const t of targets) console.log(`  - ${t}`)
    return OUTCOME.SKIPPED_WITH_INSTRUCTIONS
  } finally {
    releaseLock()
  }
}

export async function main(argv: readonly string[]): Promise<void> {
  const parsed = parseArgs(argv)
  if (!parsed.ok) {
    console.error(`${PROGRAM_NAME}: ${parsed.error}`)
    console.log(`RESULT ${OUTCOME.FAILED}`)
    process.exit(EXIT_FAIL)
  }
  const cmd = parsed.cmd

  // Entry gates FIRST for every command (platform P-20, root P-4).
  const gate = runEntryGates()
  if (gate) {
    console.error(`${PROGRAM_NAME}: ${messageFor(gate)}`)
    console.log(`RESULT ${gate}`)
    process.exit(exitCodeFor(gate))
  }

  let token: OutcomeToken
  switch (cmd.verb) {
    case "help":
      token = cmdHelp()
      break
    case "status":
      token = cmdStatus()
      break
    case "install":
      // The only async verb: the step pipeline fetches/extracts/awaits (seam pass 8). Awaiting a
      // sync verb's value is harmless, so the assignment below stays uniform.
      token = await cmdInstall(cmd)
      break
    case "remove":
      token = cmdRemove(cmd)
      break
    case "wire":
      // Row 199: synchronous by construction — the writer is synchronous and this verb fetches nothing,
      // dispatches no step module and asks no consent (see cmdWire's consent posture note).
      token = cmdWire(cmd)
      break
    case "apply":
      // Row 246: async because the DNS-pin refresh awaits the host resolver and the health gate polls
      // the recreated containers; both are inherent to applying a change to a live estate.
      token = await cmdApply(cmd)
      break
  }

  // A successful `status` printed pure JSON; do not pollute stdout with a RESULT line.
  const suppressResultLine = cmd.verb === "status" && token === OUTCOME.OK
  if (!suppressResultLine) {
    console.log(`RESULT ${token}`)
    if (exitCodeFor(token) !== EXIT_OK) console.error(`${PROGRAM_NAME}: ${messageFor(token)}`)
  }
  process.exit(exitCodeFor(token))
}

// Entry guard (seam pass 8): the compiled binary and `bun run src/index.ts` both report
// import.meta.main true and run exactly as before — row 106's build contract and every
// proofs.sh that compiles this file are unchanged. The guard exists so the unit lane can
// IMPORT the dispatch surface (executeSteps) without firing a real CLI run at import time.
// Same idiom already lives in this package (src/wiring/config_check.ts:40, src/skills/gen_cli.ts:58).
if (import.meta.main) {
  // The verbs own their error mapping (01c §8: every failure is a NAMED outcome). A rejection
  // escaping them is a harness-class defect: report it on stderr and exit 1 — never a silent 0,
  // never an unhandled-rejection crash that would skip the RESULT line row 108 asserts on.
  void main(process.argv.slice(2)).catch((err) => {
    console.error(`${PROGRAM_NAME}: unexpected error: ${(err as Error).stack ?? String(err)}`)
    process.exit(EXIT_FAIL)
  })
}
