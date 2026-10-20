// Row 86 — the runtime step (PC-CMP-01): Colima profile `swarm` + docker CLI + compose
// plugin, the D-13 guest-image capture, and the environment floors. Contract sources:
// 01c §12(runtime) + §11 ordering; 01e §7.1 sizing (row 75 ratified); 02d §4/§5 pins and
// prerequisites (row 77); verification/10 items D-12/D-13/P-5 + the row-86 release note
// (:322); decisions.md brew-floor ruling (:31) + PORT BLOCK (:30).
//
// WHAT THIS STEP DOES NOT DO, deliberately:
//  - No kit.fetch CALL: the channel is Homebrew (decision 13) — the setup invokes an
//    already-present brew and downloads nothing itself (the lock's own `_channel_note`
//    and docker_cli `_url_closer` say exactly this). Consent enforcement layer 2 is
//    therefore the MANUAL gate below: nothing executes unless kit.hasConsent().
//  - Never relies on the CURRENT docker context: every docker argv carries
//    `--context swarm` structurally (commands.ts::dockerArgv). Colima's start would
//    otherwise ACTIVATE its context as a side effect (measured: `--activate` defaults
//    true on 0.10.3), so this step passes `--activate=false` as the PRIMARY P-5 guard
//    and additionally RESTORES the user's previous current-context marker if any table
//    drift is still observed — the before/after manifest must be byte-compatible either
//    way (P-5 end-state invariant, blueprint row-86 check "current context unchanged").
//  - Never installs/removes Homebrew itself (P-3), never `brew uninstall`s anything
//    (P-14), never installs QEMU (D-12 closed here: vm-type vz is the ONLY supported
//    path; the observed scope is RECORDED, pre-existing qemu left untouched).
//  - Publishes no ports and contains ZERO port literals (PORT BLOCK decisions.md :30:
//    the VM publishes nothing; stack health URLs are row 93's, fed by row-85 artefacts;
//    the runtime health gate is `docker info` over the context socket — port-free).
//  - Writes tools.lock.json NEVER (0444 shipped read-only; proof greps byte identity).
//    Observed values land in ~/.swarm/tools/runtime/guest-image-capture.jsonl +
//    provenance.jsonl + the state.json entry (version/integrity/paths/dockerObjects).
//
// REAL VM BRING-UP IS NOT EXERCISED BY THIS ROW'S CHECKS (row 93 runs stacks, row 112
// verifies): every unit test drives an injected CommandRunner/probe fixture; the proofs
// run --dry-run only and prove NON-INTERFERENCE with the live `default` profile by
// before/after byte-identical `colima list` + `docker context ls`.

import { createStepKit } from "../../stepkit.ts"
import { consentWasGranted } from "../../consent.ts"
import { COLIMA_PROFILE, LABELS, PROGRAM_NAME, type ComponentId } from "../../constants.ts"
import { OUTCOME, type OutcomeToken } from "../../outcomes.ts"
import { toolDir } from "../../paths.ts"
import { existsSync, rmSync } from "node:fs"
import { macSignatureCheck } from "../../verify.ts"
import type { SignatureSpec } from "../../verify.ts"
import type { LockFile } from "../../lockfile.ts"
import type { StepContext, StepModule, StepResult } from "../_template/index.ts"
import {
  brewBin,
  brewInstallArgv,
  brewListVersionsArgv,
  colimaDeleteArgv,
  colimaStartArgv,
  colimaStopArgv,
  contextCandidates,
  dockerArgv,
  dockerContextLsArgv,
  dockerContextUseArgv,
  dockerInfoArgv,
  foreignContainersArgv,
  formatArgv,
  printOnlyRunner,
  spawnRunner,
  SYSTEM_TOOLS,
} from "./commands.ts"
import type { CommandRunner } from "./commands.ts"
import { codenameOfMajor, evaluatePreflight, probeHost, preflightProbeArgv } from "./preflight.ts"
import type { HostInfo, PreflightOutcome } from "./preflight.ts"
import {
  appendIncompleteCapture,
  appendObservation,
  buildContextEvidence,
  captureFilePath,
  captureGuestImage,
  hasCompletedCapture,
  limaLayoutPath,
  listColimaProfiles,
  observeBottles,
  observeDockerContext,
  observeQemuScope,
  readContextTable,
  writeCapture,
  writeLimaLayout,
} from "./capture.ts"

export interface RuntimeStepDeps {
  /** TEST SEAM: replaces the CommandRunner (scripted fixtures). Cannot widen contact: the
   *  builders still decide every argv; the seam only replays/observes execution. */
  readonly runner?: CommandRunner
  /** TEST SEAM: fixture host facts (the fake-old-macOS refusal needs no machine spoofing). */
  readonly host?: HostInfo
  /** TEST SEAM: overrides the Firecrawl-consent read used ONLY for the sizing branch. */
  readonly consentFirecrawl?: boolean
  /** TEST SEAM forwarded to verify.ts's own narrowing seam for the signature gate. */
  readonly signatureRun?: SignatureSpec["run"]
  /** TEST SEAM identical in discipline to stepkit's own StepKitOptions.consentGate (r84):
   *  forwards a replacement predicate to createStepKit so tests can drive the granted
   *  path. It cannot grant consent out-of-band — nothing here writes consent.log; the
   *  durable recording stays owned by consent.ts::evaluateConsent. */
  readonly consentGate?: (id: ComponentId) => boolean
  readonly nowIso?: () => string
}

/** Formula names per artifact: read from the lock where it names one (docker_cli/qemu),
 *  else the Homebrew formula 02d §4/§5/§6 documents for that pin (colima, lima, docker-compose). */
const FORMULA_BY_FIELD: Readonly<Record<string, string>> = {
  colima: "colima",
  lima: "lima",
  docker_compose: "docker-compose",
}

/** The step module the engine imports (descriptor id "runtime" == directory name). */
export const step: StepModule = {
  id: "runtime",
  install(ctx: StepContext): Promise<StepResult> {
    return installWithDeps(ctx, {})
  },
  remove(ctx: StepContext): Promise<StepResult> {
    return removeWithDeps(ctx, {})
  },
}

export async function installWithDeps(ctx: StepContext, deps: RuntimeStepDeps = {}): Promise<StepResult> {
  const kit = createStepKit({
    componentId: "runtime",
    lock: ctx.lock,
    state: ctx.state,
    dryRun: ctx.dryRun,
    ...(deps.consentGate ? { consentGate: deps.consentGate } : {}),
  })
  const nowIso = deps.nowIso ?? (() => new Date().toISOString())

  // Enforcement layer 2 for a NON-fetch channel: consent gates EVERYTHING here, including
  // the first `brew` invocation (r84 wired layer 2 inside kit.fetch; this step never fetches).
  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: `${PROGRAM_NAME}.runtime: no consent recorded for the runtime component — refusing before any command (01c §11)`,
    }
  }

  const runner = deps.runner ?? (ctx.dryRun ? printOnlyRunner() : spawnRunner())
  const firecrawlConsented = deps.consentFirecrawl ?? consentWasGranted("firecrawl")

  if (ctx.dryRun) return dryRunPlan(kit, runner, firecrawlConsented)

  const host = deps.host ?? probeHost(runner)
  const brewPath = brewBin("brew", host.brewPrefix ?? "/opt/homebrew")
  const colimaPath = brewBin("colima", host.brewPrefix ?? "/opt/homebrew")
  const dockerPath = brewBin("docker", host.brewPrefix ?? "/opt/homebrew")
  const limactlPath = brewBin("limactl", host.brewPrefix ?? "/opt/homebrew")

  const pre = evaluatePreflight(host, ctx.lock, firecrawlConsented)
  const refusal = refusalResult(pre, kit)
  if (refusal !== null) return refusal
  if (pre.verdict !== "pass")
    return { token: OUTCOME.FAILED, message: "preflight did not reach a pass verdict (fail-closed)" }
  for (const note of pre.notes) {
    console.log(`runtime: ${note}`)
    kit.log("warn", note)
  }

  // Isolation evidence starts BEFORE any command that could mutate it (P-5 before-manifest),
  // but AFTER preflight so a refused host executes zero docker calls.
  const contextBefore = readContextTable(runner, dockerPath)

  const brewPhase = ensureFormulas(ctx, kit, runner, brewPath)
  if ("token" in brewPhase) return brewPhase
  kit.transition("downloaded", {
    version: brewPhase.colimaVersion,
    ...(brewPhase.installedBySwarm ? { installedBySwarm: true } : {}),
  })

  const verifyPhase = verifyArtifacts(ctx, kit, runner, brewPath, colimaPath, host, deps)
  if ("token" in verifyPhase) return verifyPhase
  kit.transition("verified", { integrity: `sha256:${verifyPhase.colimaSha256}` })

  const bringUp = bringUpProfile(ctx, kit, runner, colimaPath, limactlPath, pre.sizing, nowIso)
  if ("token" in bringUp) return bringUp

  // OBSERVE the real docker context name (r93 H-R93-1: colima 0.10.3 creates `colima-swarm`,
  // the register literal says `swarm`). Recorded into state for consumers — row 91 reads
  // dockerObjects kind:"context" — and pinned into every later docker argv of this step.
  const observedContext = observeDockerContext(runner, dockerPath, contextCandidates())
  if (observedContext === null) {
    kit.log("error", "neither PC-PROF-02 candidate context exists after bring-up", {
      context: { candidates: contextCandidates() },
    })
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message: `no docker context named ${contextCandidates().join(" or ")} after colima start — PC-PROF-02 [H] disproven on this host; refusing to continue (would risk operating on the wrong daemon)`,
    }
  }
  kit.transition("installed", {
    dockerObjects: [
      { kind: "profile", id: COLIMA_PROFILE, createdBySwarm: bringUp.createdByUs, hasData: true },
      { kind: "context", id: observedContext, createdBySwarm: true, hasData: false },
    ],
    paths: [toolDir("runtime"), captureFilePath(), limaLayoutPath()],
  })

  const isolation = restoreUserContext(kit, runner, dockerPath, contextBefore)
  if ("token" in isolation) return isolation
  kit.transition("configured", { paths: [toolDir("runtime"), captureFilePath(), limaLayoutPath()] })

  const health = runner.run(dockerInfoArgv(dockerPath, observedContext))
  if (!health.ok) {
    kit.log("error", `health gate failed: docker --context ${observedContext} info unreachable`, {
      context: { exitCode: health.exitCode, stderrTail: tail(health.stderr) },
    })
    kit.transition("failed")
    return {
      token: OUTCOME.HEALTH_FAILED,
      message: `docker daemon unreachable on observed context ${observedContext}: ${tail(health.stderr || health.stdout)}`,
    }
  }
  kit.transition("healthy")
  return {
    token: OUTCOME.OK,
    message: `runtime healthy: profile ${COLIMA_PROFILE} (${pre.sizing.cpu} vCPU / ${pre.sizing.memoryGiB} GiB, vm-type vz), context ${observedContext}${bringUp.captureNote}, server ${health.stdout.trim()}`,
  }
}

// --- dry-run plan ------------------------------------------------------------------------------------

function dryRunPlan(
  kit: ReturnType<typeof createStepKit>,
  runner: CommandRunner,
  firecrawlConsented: boolean,
): StepResult {
  // Every planned command goes THROUGH the runner (print-only mode records, never spawns),
  // so "printed every command, executed zero" is measured by the same counters a real run uses.
  const plan = (argv: readonly string[], why: string) => {
    runner.run([...argv])
    console.log(`  ${formatArgv(argv)}   # ${why}`)
  }
  const note = (why: string) => console.log(`  # ${why}`)
  console.log("dry-run runtime step — every command below is PRINTED, none executed:")
  for (const argv of preflightProbeArgv()) plan(argv, "host probe (read-only introspection)")
  note(
    "preflight: macOS floor computed from tools.lock.json bottle maps (fail-closed below floor AND above reviewed set); Virtualization.framework present (vz-only, D-12); brew at /opt/homebrew (absent -> stop with instructions, P-3)",
  )
  for (const f of ["colima", "lima", "docker", "docker-compose"]) {
    plan(
      ["/opt/homebrew/bin/brew", "list", "--formula", "--versions", f],
      `absent -> brew install --formula ${f}; version drift vs lock -> refuse fail-closed`,
    )
  }
  const branch = firecrawlConsented
    ? "Firecrawl consented: 8 vCPU / 10 GiB IF RAM >= 16 GiB, else 2 / 2 + Firecrawl skipped ([H-MEM] decision 12)"
    : "SearXNG-only: 2 vCPU / 2 GiB"
  note(`sizing per 01e §7.1 — ${branch}`)
  plan(
    colimaStartArgv("/opt/homebrew/bin/colima", firecrawlConsented ? 8 : 2, firecrawlConsented ? 10 : 2, false),
    "first bring-up adds --very-verbose (D-13 capture duty)",
  )
  note(
    `D-13 capture: image reference from ~/.colima/${COLIMA_PROFILE}/lima.yaml (measured r93: may be a LOCAL content-addressed cache path), sha256 computed over the real bytes; complete -> guest-image-capture.jsonl + provenance.jsonl; incomplete-with-evidence -> RECORDED-UNKNOWN (lima-layout.json + ledger row; transcription rows 80/108); no evidence at all -> fail-closed; tools.lock.json NEVER written`,
  )
  plan(
    dockerContextLsArgv("/opt/homebrew/bin/docker"),
    "before AND after; if colima's start moved the current marker, restore the USER's previous one (P-5 end-state)",
  )
  note(
    `context OBSERVATION after create (r93 H-R93-1): candidates ${contextCandidates().join(" | ")} — colima 0.10.3 names it colima-${COLIMA_PROFILE}; the observed name is recorded into state (dockerObjects kind:"context") and pinned into every later docker argv`,
  )
  plan(
    dockerArgv(
      "/opt/homebrew/bin/docker",
      `<observed:${contextCandidates().join("|")}>`,
      "info",
      "--format",
      "{{.ServerVersion}}",
    ),
    "health gate over the context socket (port-free); name shown is the OBSERVATION placeholder",
  )
  note(
    "qemu scope: brew list qemu recorded; DECLARED never-installed (D-12 vz-only); pre-existing qemu left untouched (P-14)",
  )
  note(
    `labels PC-LBL-01..03 (${LABELS.MANAGED_KEY}, ${LABELS.COMPONENT_KEY}, ${LABELS.VERSION_KEY}) ride every compose object rendered by row 85; the profile itself is owned through the state manifest`,
  )
  for (const to of ["downloaded", "verified", "installed", "configured", "healthy"] as const) kit.transition(to)
  return {
    token: OUTCOME.OK,
    message: `dry-run: ${runner.printed.length} external commands printed, ${runner.executedCount} executed (zero-exec guarantee)`,
  }
}

// --- phases ------------------------------------------------------------------------------------------

type PhaseFail = { token: OutcomeToken; message?: string }

function refusalResult(pre: PreflightOutcome, kit: ReturnType<typeof createStepKit>): StepResult | null {
  if (pre.verdict === "pass") return null
  kit.log("error", `preflight ${pre.verdict}: ${pre.message}`)
  if (pre.verdict === "skip_instructions") {
    kit.transition("skipped")
    for (const line of pre.instructions) console.log(`runtime: ${line}`)
  } else {
    kit.transition("failed")
  }
  return { token: pre.token, message: `${PROGRAM_NAME}.runtime: ${pre.message}` }
}

interface BrewOk {
  readonly colimaVersion: string
  readonly installedBySwarm: boolean
}

function ensureFormulas(
  ctx: StepContext,
  kit: ReturnType<typeof createStepKit>,
  runner: CommandRunner,
  brewPath: string,
): BrewOk | PhaseFail {
  let installedBySwarm = false
  let colimaVersion = ""
  for (const field of ["colima", "lima", "docker_cli", "docker_compose"]) {
    const formula = formulaName(ctx.lock, field)
    const pinned = (ctx.lock.components.runtime?.[field] ?? {}) as Record<string, unknown>
    const want = typeof pinned.version === "string" ? normalizeVersion(pinned.version) : ""
    const listed = runner.run(brewListVersionsArgv(brewPath, formula))
    let have = listed.ok ? parseBrewVersion(listed.stdout, formula) : null
    if (have === null) {
      kit.log(
        "info",
        `formula ${formula} absent — installing via the user's existing Homebrew (decision 13 channel; the setup bootstraps nothing)`,
        { context: { formula } },
      )
      const inst = runner.run(brewInstallArgv(brewPath, formula))
      installedBySwarm = true
      if (!inst.ok) {
        kit.transition("failed")
        return {
          token: OUTCOME.FAILED,
          message: `brew install ${formula} failed (exit ${inst.exitCode}): ${tail(inst.stderr)}`,
        }
      }
      have = parseBrewVersion(runner.run(brewListVersionsArgv(brewPath, formula)).stdout, formula)
    }
    if (have === null || (want !== "" && have !== want)) {
      kit.transition("failed")
      return {
        token: OUTCOME.FAILED,
        message: `formula ${formula}: brew reports ${JSON.stringify(have)}, tools.lock.json ${ctx.lock.version} pins ${JSON.stringify(want)} — ship a refreshed reviewed lock rather than drifting (fail-closed)`,
      }
    }
    if (field === "colima") colimaVersion = have
  }
  return { colimaVersion: colimaVersion || "unknown", installedBySwarm }
}

function formulaName(lock: LockFile, field: string): string {
  const entry = (lock.components.runtime?.[field] ?? {}) as Record<string, unknown>
  const named = entry.formula ?? FORMULA_BY_FIELD[field]
  return typeof named === "string" ? named : field
}

function normalizeVersion(v: string): string {
  return v.trim().replace(/^v/, "")
}

function parseBrewVersion(stdout: string, formula: string): string | null {
  const line = stdout.split("\n").find((l) => l.trim().startsWith(formula))
  if (!line) return null
  const ver = line.trim().split(/\s+/)[1]
  return ver ? normalizeVersion(ver) : null
}

interface VerifyOk {
  readonly colimaSha256: string
}

function verifyArtifacts(
  ctx: StepContext,
  kit: ReturnType<typeof createStepKit>,
  runner: CommandRunner,
  brewPath: string,
  colimaPath: string,
  host: HostInfo,
  deps: RuntimeStepDeps,
): VerifyOk | PhaseFail {
  const sig = macSignatureCheck(colimaPath, deps.signatureRun ? { run: deps.signatureRun } : {})
  if (!sig.codesignOk || !sig.spctlOk) {
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message: `macOS signature gate refused ${colimaPath}: ${sig.detail} (P-1/P-2 fail-closed)`,
    }
  }
  const codenameKey = `arm64_${codenameOfMajor(host.darwinMajor ?? -1) ?? "unknown"}`
  const observations = observeBottles(runner, ctx.lock, brewPath, codenameKey, [
    { field: "colima", formula: formulaName(ctx.lock, "colima") },
    { field: "lima", formula: formulaName(ctx.lock, "lima") },
    { field: "docker_cli", formula: formulaName(ctx.lock, "docker_cli") },
    { field: "docker_compose", formula: formulaName(ctx.lock, "docker_compose") },
  ])
  appendObservation(captureFilePath(), "bottle_observation", { codenameKey, observations })
  const drifted = observations.filter((o) => o.matchesLock === false)
  if (drifted.length > 0) {
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message: `brew bottle hashes drifted from tools.lock.json for: ${drifted.map((o) => o.formula).join(", ")} — refusing to run unreviewed binaries (P-1 fail-closed)`,
    }
  }
  const qemu = observeQemuScope(runner, brewPath, formulaName(ctx.lock, "qemu"))
  appendObservation(captureFilePath(), "qemu_scope", qemu)
  kit.log("info", `qemu install-scope observed: ${qemu.observedScope} (declared: ${qemu.declaredScope}) — ${qemu.note}`)
  const pinned = (ctx.lock.components.runtime?.colima ?? {}) as Record<string, unknown>
  return { colimaSha256: typeof pinned.sha256 === "string" ? pinned.sha256 : "" }
}

interface BringUpOk {
  readonly createdByUs: boolean
  /** Appended to the healthy message: what the D-13 capture established (or honestly didn't). */
  readonly captureNote: string
}

/** D-13 terminal-state policy (r93 live closure, controller fix-round):
 *  - COMPLETE capture            -> ledger + provenance + state integrity, as designed.
 *  - INCOMPLETE WITH EVIDENCE    -> recorded-unknown: the image reference (and usually the
 *    computed digest of the actual bytes) are known, only lima's metadata cannot NAME the
 *    version. 01c §8 lists `failed` triggers as integrity events (hash/signature mismatch,
 *    HTTP downgrade, foreign host, placeholder secret) — a metadata gap over bytes that
 *    exist is NOT among them, and P-15 demands "a named outcome, reported once". So v1
 *    CONTINUES with: an incomplete-capture ledger row + lima-layout.json (transcription
 *    duty routed to rows 80/108) + state integrity note + one disclosed warn line.
 *  - NO EVIDENCE AT ALL          -> FAILED (total blindness about the largest trust input
 *    is exactly what verification/10:143 forbids proceeding on).
 *  - DIGEST MISMATCH (lima's own claim vs locally computed bytes) -> FAILED: that IS a
 *    §8 hash-mismatch event. A content-addressed cache BASENAME is only a candidate claim,
 *    never a mismatch trigger by itself. */
function bringUpProfile(
  ctx: StepContext,
  kit: ReturnType<typeof createStepKit>,
  runner: CommandRunner,
  colimaPath: string,
  limactlPath: string,
  sizing: { cpu: number; memoryGiB: number },
  nowIso: () => string,
): BringUpOk | PhaseFail {
  const existing = listColimaProfiles(runner, colimaPath)
  const createdByUs = !existing.some((p) => p.name === COLIMA_PROFILE)
  const guestLock = (ctx.lock.components.runtime?.guest_image ?? {}) as Record<string, unknown>
  const lockPinned = typeof guestLock.url === "string" && typeof guestLock.sha256 === "string"
  // D-13: the FIRST bring-up (no reviewed pin, no prior capture) runs verbose so the actual
  // guest image facts are observable; afterwards the capture gates everything.
  const needsCapture = !lockPinned && !hasCompletedCapture()
  const start = runner.run(colimaStartArgv(colimaPath, sizing.cpu, sizing.memoryGiB, needsCapture))
  if (!start.ok) {
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message: `colima start --profile ${COLIMA_PROFILE} failed (exit ${start.exitCode}): ${tail(start.stderr)}`,
    }
  }
  if (!needsCapture) return { createdByUs, captureNote: ", guest pin already in lock or captured" }

  const attempt = captureGuestImage(runner, ctx.lock, limactlPath, nowIso)
  writeLimaLayout(attempt, nowIso) // ALWAYS recorded — complete or not — rows 80/108 read this file
  if (
    attempt.limaReportedDigest !== null &&
    attempt.observedSha256 !== null &&
    attempt.limaReportedDigest !== attempt.observedSha256
  ) {
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message:
        "D-13 capture: locally computed sha256 disagrees with lima's reported digest — refusing (fail-closed, 01c §8 hash-mismatch class)",
    }
  }
  if (attempt.complete !== null) {
    if (attempt.complete.digestCrossCheck === "mismatch") {
      kit.transition("failed")
      return {
        token: OUTCOME.FAILED,
        message: "D-13 capture: locally computed sha256 disagrees with lima's reported digest — refusing (fail-closed)",
      }
    }
    writeCapture(attempt.complete, ctx.lock)
    kit.log(
      "info",
      "D-13 guest-image capture recorded (lock stays read-only; evidence: guest-image-capture.jsonl + provenance.jsonl + state integrity + lima-layout.json)",
      {
        context: {
          url: attempt.complete.url,
          version: attempt.complete.version,
          sha256: attempt.complete.sha256,
          crossCheck: attempt.complete.digestCrossCheck,
        },
      },
    )
    return { createdByUs, captureNote: `, D-13 captured guest ${attempt.complete.version}` }
  }
  if (!attempt.hasEvidence) {
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message: `D-13 capture found NO evidence — neither the image reference nor cached bytes could be located${attempt.evidence.length > 0 ? ` (evidence attempts: ${attempt.evidence.join("; ")})` : ""}. Proceeding blind on the estate's largest trust input is forbidden (verification/10:143); lima-layout.json records what was checked.`,
    }
  }
  appendIncompleteCapture(attempt)
  const note = `D-13 recorded-unknown: missing [${attempt.missing.join(", ")}] over reference ${String(attempt.observedReference)}${attempt.observedSha256 !== null ? ` (sha256 COMPUTED over the real bytes)` : ""}; transcription duty rows 80/108 via ${limaLayoutPath()}`
  console.log(`runtime: ${note}`)
  kit.log("warn", note)
  kit.transition("verified", {
    integrity: `D13-capture-incomplete:${attempt.missing.join("+")}`,
    paths: [toolDir("runtime"), captureFilePath(), limaLayoutPath()],
  })
  return {
    createdByUs,
    captureNote: `, D-13 recorded-unknown missing ${attempt.missing.join("+")} (lima-layout.json; rows 80/108 transcribe)`,
  }
}

/** P-5 end-state guard (fallback tier): the PRIMARY guard is `--activate=false` at start
 *  (measured flag on colima 0.10.3), which never moves the marker. If a table drift is
 *  STILL observed (older colima, flag ignored), the user's own previous current context
 *  is restored here and the before/after tables must then match. Our commands never
 *  depend on the current marker (every argv carries --context swarm), so the restore is
 *  purely about preserving the USER's configuration. A host with NO docker before
 *  (empty table) had no user choice to preserve — recorded as a warning, not a violation. */
function restoreUserContext(
  kit: ReturnType<typeof createStepKit>,
  runner: CommandRunner,
  dockerPath: string,
  contextBefore: string,
): { ok: true } | PhaseFail {
  const first = buildContextEvidence(contextBefore, readContextTable(runner, dockerPath))
  if (
    !first.unchanged &&
    contextBefore !== "" &&
    first.previousCurrentNames.length === 1 &&
    first.afterCurrentNames[0] !== first.previousCurrentNames[0]
  ) {
    const previous = first.previousCurrentNames[0] as string
    kit.log(
      "warn",
      `colima start moved the current-context marker to ${String(first.afterCurrentNames[0])}; restoring the user's previous current context "${previous}" (P-5 end-state; our commands never relied on the marker)`,
      { context: { previous } },
    )
    runner.run(dockerContextUseArgv(dockerPath, previous))
  }
  const final = buildContextEvidence(contextBefore, readContextTable(runner, dockerPath))
  if (!final.swarmContextPresent) {
    kit.log("error", "context isolation violated: no candidate docker context after bring-up", { context: { final } })
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message: `neither ${contextCandidates().join(" nor ")} context present in the final table — PC-PROF-02 closure requires one; refusing to continue`,
    }
  }
  if (!final.unchanged && contextBefore !== "") {
    kit.log("error", "context isolation violated: current-context marker differs before/after", { context: { final } })
    kit.transition("failed")
    return {
      token: OUTCOME.FAILED,
      message: `docker context table differs before/after (previous current: ${final.previousCurrentNames.join(",") || "<none>"}; after: ${final.afterCurrentNames.join(",") || "<none>"}) — P-5 demands the user's context state survive byte-identical`,
    }
  }
  kit.log(
    "info",
    `context isolation proven: current-context marker stable before/after; observed context ${String(final.observedContextName)} present — PC-PROF-02 [H] CLOSED with evidence (register literal vs measured colima naming disclosed to consumers via state)`,
    { context: { final } },
  )
  return { ok: true }
}

// --- remove ------------------------------------------------------------------------------------------

export async function removeWithDeps(ctx: StepContext, deps: RuntimeStepDeps = {}): Promise<StepResult> {
  const kit = createStepKit({
    componentId: "runtime",
    lock: ctx.lock,
    state: ctx.state,
    dryRun: ctx.dryRun,
    ...(deps.consentGate ? { consentGate: deps.consentGate } : {}),
  })
  if (!kit.hasConsent()) {
    return {
      token: OUTCOME.REFUSED_NO_CONSENT,
      message: `${PROGRAM_NAME}.runtime: removal also requires consent for this component (P-14 ordering)`,
    }
  }
  const runner = deps.runner ?? (ctx.dryRun ? printOnlyRunner() : spawnRunner())
  const entry = ctx.state.components.runtime
  const profileObj = (entry.dockerObjects ?? []).find((o) => o.kind === "profile" && o.id === COLIMA_PROFILE)
  // The OBSERVED context name recorded at install time (H-R93-1); fall back to the register
  // candidate order if an older state envelope lacks it. A wrong guess fails closed anyway:
  // the foreign-container check cannot reach a nonexistent context and removal refuses.
  const observedContext =
    (entry.dockerObjects ?? []).find((o) => o.kind === "context")?.id ?? contextCandidates()[0] ?? COLIMA_PROFILE

  if (ctx.dryRun) {
    console.log("dry-run runtime remove — would execute (printed, not run):")
    if (profileObj?.createdBySwarm) {
      runner.run(foreignContainersArgv("/opt/homebrew/bin/docker", observedContext))
      console.log(
        `  ${formatArgv(foreignContainersArgv("/opt/homebrew/bin/docker", observedContext))}   # refuse if ANY container lacks ${LABELS.MANAGED_KEY}=true`,
      )
      runner.run(colimaStopArgv(SYSTEM_TOOLS.colimaDefault))
      console.log(`  ${formatArgv(colimaStopArgv(SYSTEM_TOOLS.colimaDefault))}`)
      runner.run(colimaDeleteArgv(SYSTEM_TOOLS.colimaDefault))
      console.log(
        `  ${formatArgv(colimaDeleteArgv(SYSTEM_TOOLS.colimaDefault))}   # colima cleans its own context (${observedContext}) with the profile (measured r93 L7); we never docker context rm behind its back`,
      )
      console.log(
        `  rm -rf ${toolDir("runtime")}   # only paths recorded in the state manifest (fs removal, not a spawn)`,
      )
    } else {
      console.log(
        "  nothing: the state manifest does not credit swarm-setup with creating the profile (P-14: never delete what we did not create; brew binaries are never uninstalled)",
      )
    }
    kit.transition("absent")
    return {
      token: OUTCOME.OK,
      message: `dry-run: ${runner.printed.length} commands printed, ${runner.executedCount} executed`,
    }
  }

  if (!profileObj?.createdBySwarm) {
    return {
      token: OUTCOME.SKIPPED_WITH_INSTRUCTIONS,
      message: `runtime was not created by swarm-setup (state manifest empty) — nothing deleted. Manual removal, if you really want it: ${formatArgv(colimaDeleteArgv(SYSTEM_TOOLS.colimaDefault))}`,
    }
  }

  const dockerPath = brewBin("docker", "/opt/homebrew")
  const foreign = runner.run(foreignContainersArgv(dockerPath, observedContext))
  const foreignIds = foreign.ok
    ? foreign.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s !== "")
    : ["<unverifiable-daemon>"]
  if (foreignIds.length > 0) {
    kit.log("error", "refusing profile deletion: containers without the Swarm managed label live inside it", {
      context: { foreignIds },
    })
    return {
      token: OUTCOME.FAILED,
      message: `containers without ${LABELS.MANAGED_KEY}=true exist in profile ${COLIMA_PROFILE} (${foreignIds.join(", ")}) — their owner must move them first (P-14 protects data we did not create)`,
    }
  }

  const stop = runner.run(colimaStopArgv(SYSTEM_TOOLS.colimaDefault))
  if (!stop.ok) {
    kit.transition("failed")
    return { token: OUTCOME.FAILED, message: `colima stop failed (exit ${stop.exitCode}): ${tail(stop.stderr)}` }
  }
  const del = runner.run(colimaDeleteArgv(SYSTEM_TOOLS.colimaDefault))
  if (!del.ok) {
    kit.transition("failed")
    return { token: OUTCOME.FAILED, message: `colima delete failed (exit ${del.exitCode}): ${tail(del.stderr)}` }
  }
  for (const p of entry.paths ?? []) {
    if (p.startsWith(toolDir("runtime")) && existsSync(p)) rmSync(p, { force: true })
  }
  if (existsSync(toolDir("runtime"))) rmSync(toolDir("runtime"), { recursive: true, force: true })
  kit.log(
    "info",
    "runtime removed: profile stopped+deleted (created-by-us verified via state manifest), manifest paths cleared, brew binaries LEFT in place (P-14)",
    {
      context: { profile: COLIMA_PROFILE, labelKeys: [LABELS.MANAGED_KEY, LABELS.COMPONENT_KEY, LABELS.VERSION_KEY] },
    },
  )
  kit.transition("absent")
  return {
    token: OUTCOME.OK,
    message: `profile ${COLIMA_PROFILE} removed; user's default profile and current context untouched`,
  }
}

function tail(text: string, max = 300): string {
  const t = text.trim()
  return t.length <= max ? t : `…${t.slice(-max)}`
}

export default step
