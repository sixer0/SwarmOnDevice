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
import { readState } from "./state.ts"
import { acquireLock, releaseLock } from "./lockdir.ts"
import { printHostList, evaluateConsent, renderConsentScreen } from "./consent.ts"
import { enforcePolicy } from "./wiring/policy_enforce.ts"
import { discoverSteps, orderSteps, type StepDescriptor } from "./steps.ts"
import { GENERATED_MODULES_BY_ID } from "./steps.gen.ts"
import type { StepContext, StepResult } from "./steps/_template/index.ts"
import { firecrawlPlan, searxngPlan, type DockerRunner } from "./stacklib.ts"
import { makeRealDockerRunner } from "./dockerRunner.real.ts"
import { makeReadinessProbe } from "./readinessProbe.ts"
import { COMPONENT_IDS, PROGRAM_NAME, type ComponentId } from "./constants.ts"
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
    "",
    "Flags:",
    "  --non-interactive                MDM mode; needs --terms-token for every selected component",
    "  --terms-token <component>=<value>  per-tool acknowledgement unlocking --non-interactive",
    "                                   (value = <component_id>@<lock_sha256_12>, shown on the consent screen)",
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

function resolveSelected(named: readonly ComponentId[]): ComponentId[] {
  return named.length > 0 ? [...named] : [...COMPONENT_IDS]
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
    const offered = selectable(resolveSelected(cmd.components), forbidden)
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
    return report.token
  } finally {
    releaseLock()
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
    const targets: string[] = []
    const scope = cmd.components.length > 0 ? cmd.components : COMPONENT_IDS
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
