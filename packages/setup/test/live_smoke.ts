// Row 93 — LIVE VM bring-up smoke driver. This is the FIRST program in the whole project to run
// REAL colima + docker on this host (rows 86/91/92 all proved their logic offline against fakes).
//
// It is orchestrated PHASE BY PHASE from test/live_vm_smoke.proofs.sh, which owns the parts that
// need a terminal (streamed image pulls, curl probes, before/after non-interference diffing, and the
// final profile teardown). Each phase here does one bounded job and prints a machine-readable result
// line (`R93_JSON {...}`) plus human narration; the harness greps the JSON.
//
// SAFETY MODEL (mirrors the dispatch brief's binding HOST SAFETY block):
//   - Everything runs inside colima profile COLIMA_PROFILE and the docker context r86 OBSERVES for it
//     (register DOCKER_CONTEXT; colima 0.10.3 names it `colima-<profile>` — see H-R93-1, closed r72-fix3).
//     The user's `default` profile and current docker context are NEVER mutated (r86 builders carry the
//     observed `--context <name>` and pass `--activate=false`; this driver restores the marker if it moved).
//   - Consent is exercised through the kit's IN-PROCESS seam (consentGate:()=>true), which drives the
//     granted code path WITHOUT writing a durable consent.log — honest for a self-cleaning smoke;
//     the durable consent recording itself is proven by rows 83/84.
//   - Only the searxng/firecrawl tool dirs + setup state are written under the real ~/.swarm; the
//     sibling native-tool dirs (node/graft/rtk/obsidian, rows 87-90) are untouched.
//   - If any external command cannot run (a sandbox denial surfaces as a spawn failure / non-zero),
//     the phase reports its exact position rather than fabricating a pass.
//
// Run ONLY via the harness (which sets R93_LIVE=1 and R93_WORK/R93_PHASE); direct execution refuses.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { validateLock } from "../src/lockfile.ts"
import { defaultState, readState, writeState } from "../src/state.ts"
import { STATES, COLIMA_PROFILE, DOCKER_CONTEXT } from "../src/constants.ts"
import { createStepKit } from "../src/stepkit.ts"
import { homeDir, toolDir, toolsDir } from "../src/paths.ts"
import { SECRET_INVENTORY } from "../src/composefiles/shared.ts"
import { renderAll, applyRenderedFiles } from "../src/composefiles/index.ts"
import { bringUp, firecrawlPlan, healthProbeUrls, searxngPlan, tearDown, type DockerRunner } from "../src/stacklib.ts"
import { bakeEgressProxy, egressHealthContract } from "../src/steps/firecrawl/egress_bake.ts"
import { asText, makeRealDockerRunner } from "../src/dockerRunner.real.ts"
import {
  brewBin,
  colimaStartArgv,
  dockerContextUseArgv,
  dockerInfoArgv,
  type CommandRunner,
} from "../src/steps/runtime/commands.ts"
import { evaluatePreflight, parseDarwinMajor, type HostInfo } from "../src/steps/runtime/preflight.ts"
import {
  buildContextEvidence,
  captureFilePath,
  captureGuestImage,
  listColimaProfiles,
  parseImageUrls,
  readContextTable,
} from "../src/steps/runtime/capture.ts"

const phase = process.env.R93_PHASE ?? ""
const live = process.env.R93_LIVE === "1"
const work = process.env.R93_WORK ?? "/tmp"
if (!live) {
  console.error("live_smoke: refusing to run — set R93_LIVE=1 (this driver touches the real docker daemon)")
  process.exit(2)
}
const home = homeDir() // the REAL user home: the live path must render where colima/virtiofs mounts it
const dockerPath = brewBin("docker", "/opt/homebrew")
const colimaPath = brewBin("colima", "/opt/homebrew")
const limactlPath = brewBin("limactl", "/opt/homebrew")

// Resolve the shipped lock from the PACKAGE ROOT (this driver lives in test/, so `../tools.lock.json`),
// not loadLock()'s program-dir posture which points at src/ under `bun run`. Overridable via R93_LOCK.
const lockPath = process.env.R93_LOCK ?? join(import.meta.dir, "..", "tools.lock.json")
const lockRes = validateLock(JSON.parse(readFileSync(lockPath, "utf8")))
if (!lockRes.ok) {
  console.error(`live_smoke: ${lockRes.error}`)
  process.exit(1)
}
const lock = lockRes.lock

function json(tag: string, data: unknown): void {
  console.log(`R93_JSON ${tag} ${JSON.stringify(data)}`)
}

function writeImages(comp: "searxng" | "firecrawl", text: string): string[] {
  const imgs = [
    ...new Set(
      text
        .split("\n")
        .map((l) => /^\s+image:\s*(\S+)/.exec(l)?.[1])
        .filter((x): x is string => !!x),
    ),
  ]
  writeFileSync(join(work, `r93-images-${comp}.txt`), `${imgs.join("\n")}\n`)
  return imgs
}

// Smoke-only secret material: two UUIDs -> 64 hex chars (>= the §4.6 length floors, never a
// placeholder). Not shipped, not logged (kit redacts), torn down with the secrets dir at the end.
// Storm-safe: an existing non-empty secret is LEFT IN PLACE so a mid-phase resume never rotates a
// token a already-running stack was authenticated with (would otherwise break probe 2 on re-entry).
function genSecret(path: string): void {
  if (existsSync(path)) {
    try {
      if (readFileSync(path, "utf8").trim().length >= 32) return
    } catch {
      /* fall through and rewrite */
    }
  }
  const val = `${randomUUID()}${randomUUID()}`.replace(/-/g, "")
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${val}\n`, { mode: 0o600 })
}

/** Row-86 hypothesis [H] closure by DIRECT OBSERVATION of the colima 0.10.3 + lima 2.2.0 layout on
 *  this host, after the first real profile start. Recorded to ~/.swarm/tools/runtime/lima-layout.json
 *  (and the same object into the JSON stream) so rows 108/109/112 read one durable file. Never reads
 *  the multi-GiB sparse disk into memory — statSync().size only. */
function layoutObservation(): Record<string, unknown> {
  const h = homeDir()
  const limaHome = join(h, ".colima", "_lima")
  const instanceDir = join(limaHome, `colima-${COLIMA_PROFILE}`)
  const yamlPath = join(instanceDir, "lima.yaml")
  const candidates: Record<string, string> = {
    colima_profile_yaml: join(h, ".colima", COLIMA_PROFILE, "lima.yaml"),
    underlima_colima_profile_yaml: yamlPath,
    lima_home_colima_profile_yaml: join(h, ".lima", `colima-${COLIMA_PROFILE}`, "lima.yaml"),
  }
  let images: string[] = []
  try {
    if (existsSync(yamlPath)) images = parseImageUrls(readFileSync(yamlPath, "utf8"))
  } catch {
    /* recorded as empty list */
  }
  const existingInstanceDirs = existsSync(limaHome) ? readdirSync(limaHome).filter((n) => !n.startsWith("_")) : []
  const diskPath = join(instanceDir, "disk")
  return {
    ts: new Date().toISOString(),
    profile: COLIMA_PROFILE,
    limaHomeConvention: "~/.colima/_lima (colima overrides LIMA_HOME)",
    instanceNameCandidatesProbed: [`colima-${COLIMA_PROFILE}`, COLIMA_PROFILE],
    observedInstanceDirs: existingInstanceDirs,
    instanceNameMatchesHypothesis: existingInstanceDirs.includes(`colima-${COLIMA_PROFILE}`),
    limaYamlExistsAt: Object.fromEntries(Object.entries(candidates).map(([k, p]) => [k, existsSync(p)])),
    imagesBlockLocations: images,
    guestImageRefKind:
      images.length > 0
        ? /^[a-z]+:\/\//i.test(images[0] ?? "")
          ? "remote-url"
          : "local-content-addressed-cache-file"
        : "none-found",
    diskFileBytes: existsSync(diskPath) ? statSync(diskPath).size : null,
    note: "closes r86 §8 [H]: instance name == colima-<profile>; lima.yaml under ~/.colima/_lima/<instance>/; guest image referenced as a content-addressed LOCAL cache file (~/Library/Caches/colima/caches/<sha256>), NOT a remote url — which is why captureGuestImage cannot derive version/sha256 from it on THIS host layout",
  }
}

function committedState() {
  const r = readState(lock.version)
  if (!r.ok) throw new Error(`live_smoke: state unreadable: ${r.error}`)
  return r.state
}

/** Row-93 caught CommandRunner adapter. Behaves like row 86's spawnRunner (argv array, absolute
 *  binary, TextDecoder normalisation) BUT additionally catches a spawn failure into exitCode 127 —
 *  which is the contract row 86 DOCUMENTS ("a missing binary surfaces as exitCode 127") yet its
 *  spawnRunner does not actually honor (it throws). Live surfacing of that gap is exactly this row's
 *  job; here the smoke must not die on a stray binary, so it catches and reports. */
function caughtRunner(timeoutMs = 300_000): CommandRunner {
  const printed: string[] = []
  let executed = 0
  return {
    run(argv) {
      printed.push(argv.join(" "))
      if (argv.length === 0) return { ok: false, exitCode: 127, stdout: "", stderr: "empty argv" }
      try {
        const o = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs })
        executed += 1
        const code = o.exitCode ?? 127
        return { ok: code === 0, exitCode: code, stdout: asText(o.stdout), stderr: asText(o.stderr) }
      } catch (err) {
        executed += 1
        return { ok: false, exitCode: 127, stdout: "", stderr: `spawn failed: ${(err as Error).message}` }
      }
    },
    get executedCount(): number {
      return executed
    },
    get printed(): readonly string[] {
      return printed
    },
  }
}

/** Host facts for evaluatePreflight, probed at the CORRECT macOS paths. Row 86's own probeHost bakes
 *  SYSTEM_TOOLS.sysctl = "/sbin/sysctl", which does not exist on macOS (sysctl is /usr/sbin/sysctl);
 *  unexercised because r86 only ever runs scripted runners. Reported to r86 as a routed finding; the
 *  live path uses the real location so preflight measures the true floors instead of throwing. */
function probeHostLocal(runner: CommandRunner): HostInfo {
  const productVersion = runner.run(["/usr/bin/sw_vers", "-productVersion"]).stdout.trim()
  const memRaw = runner.run(["/usr/sbin/sysctl", "-n", "hw.memsize"]).stdout.trim()
  const cpuRaw = runner.run(["/usr/sbin/sysctl", "-n", "hw.ncpu"]).stdout.trim()
  const armBrew = existsSync("/opt/homebrew/bin/brew")
  return {
    productVersion,
    darwinMajor: parseDarwinMajor(productVersion),
    memsizeBytes: /^\d+$/.test(memRaw) ? Number(memRaw) : 0,
    ncpu: /^\d+$/.test(cpuRaw) ? Number(cpuRaw) : 0,
    virtualizationFramework: existsSync("/System/Library/Frameworks/Virtualization.framework"),
    brewPrefix: armBrew ? "/opt/homebrew" : null,
    rosettaBrewOnly: !armBrew && existsSync("/usr/local/bin/brew"),
  }
}

/** Bring-up runs through stacklib.bringUp VERBATIM. r91's fix round rewrote contextInspectArgs() to
 *  the valid `["context","inspect",<name>]` argv and added resolveDockerContextName(state), which reads
 *  the runtime step's RECORDED `{kind:"docker-context",id}` state entry (falling back to DOCKER_CONTEXT).
 *  This driver records that entry below from the OBSERVED post-start context, so the diagnostic probe and
 *  every compose `--context <name>` operation address the same live daemon. No workaround path remains. */
async function main(): Promise<void> {
  const realDocker = makeRealDockerRunner({ dockerBinary: dockerPath })
  const run: DockerRunner = realDocker.runner

  if (phase === "bringup") {
    const cmdRunner = caughtRunner()
    const host = probeHostLocal(cmdRunner)
    const pre = evaluatePreflight(host, lock, true)
    json("preflight", {
      verdict: pre.verdict,
      ...(pre.verdict === "pass"
        ? {
            sizing: pre.sizing,
            firecrawlOffered: pre.firecrawlOffered,
            memoryFloor: pre.memoryFloor,
            cpuFloor: pre.cpuFloor,
            notes: pre.notes,
          }
        : { message: pre.message }),
    })
    if (pre.verdict !== "pass") {
      console.log(`R93_OUTCOME bringup=REFUSED (${pre.verdict})`)
      return
    }
    const existing = listColimaProfiles(cmdRunner, colimaPath)
    const alreadyPresent = existing.some((p) => p.name === COLIMA_PROFILE)
    const swarmRunning = existing.some((p) => p.name === COLIMA_PROFILE && /running/i.test(p.status))
    json("profiles_before", existing)
    if (alreadyPresent)
      console.log(
        `NOTE profile ${COLIMA_PROFILE} already exists (status ${swarmRunning ? "Running" : "not-running"}) — storm-resilient re-entry`,
      )

    const ctxBefore = readContextTable(cmdRunner, dockerPath)
    // State-aware: if the profile is already up and the daemon answers over the recorded context, the
    // colima-start phase already succeeded in a prior (interrupted) attempt — do not re-run it.
    let start = { ok: true, exitCode: 0, stderr: "skipped: profile already running" }
    if (!swarmRunning) {
      start = cmdRunner.run(colimaStartArgv(colimaPath, pre.sizing.cpu, pre.sizing.memoryGiB, true))
    }
    json("colima_start", {
      skippedBecauseRunning: swarmRunning,
      ok: start.ok,
      exitCode: start.exitCode,
      stderrTail: start.stderr.trim().slice(-400),
    })
    if (!start.ok) {
      console.log(`R93_OUTCOME bringup=BLOCKED_AT colima-start exit=${start.exitCode}`)
      return
    }

    let ctxAfter = readContextTable(cmdRunner, dockerPath)
    let ev = buildContextEvidence(ctxBefore, ctxAfter)
    if (
      !ev.unchanged &&
      ctxBefore !== "" &&
      ev.previousCurrentNames.length === 1 &&
      ev.afterCurrentNames[0] !== ev.previousCurrentNames[0]
    ) {
      cmdRunner.run(dockerContextUseArgv(dockerPath, ev.previousCurrentNames[0] as string))
      ctxAfter = readContextTable(cmdRunner, dockerPath)
      ev = buildContextEvidence(ctxBefore, ctxAfter)
    }
    json("context_isolation", {
      unchanged: ev.unchanged,
      observedContextName: ev.observedContextName,
      previousCurrent: ev.previousCurrentNames,
      afterCurrent: ev.afterCurrentNames,
      unexpectedAdditions: ev.unexpectedAdditions,
    })

    // Observe-never-assume (mirrors r86-fix): the live context name is whatever colima actually created,
    // read back from the before/after table; DOCKER_CONTEXT is only the fallback. It flows into the health
    // gate, the recorded state entry below, and r91's compose/`--context` operations (same contract).
    const observedContext = ev.observedContextName ?? DOCKER_CONTEXT
    const info = cmdRunner.run(dockerInfoArgv(dockerPath, observedContext))
    json("docker_info_health", { ok: info.ok, server: info.stdout.trim(), context: observedContext })
    if (!info.ok) {
      console.log(`R93_OUTCOME bringup=BLOCKED_AT docker-info exit=${info.exitCode}`)
      return
    }

    const cap = captureGuestImage(cmdRunner, lock, limactlPath, () => new Date().toISOString())
    const layout = layoutObservation()
    mkdirSync(toolDir("runtime"), { recursive: true, mode: 0o700 })
    writeFileSync(
      join(toolDir("runtime"), "lima-layout.json"),
      JSON.stringify(
        {
          ...layout,
          captureComplete: cap.complete !== null,
          captureMissing: cap.missing,
          captureEvidence: cap.evidence,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    )
    json("d13_capture", { complete: cap.complete, missing: cap.missing, evidence: cap.evidence, layout })

    // Seed the state envelope: runtime is HEALTHY because the health gate measured it (daemon reachable
    // over the recorded context). The observed docker-context name is recorded in the state manifest so
    // row 91's resolveDockerContextName(state) and every compose `--context <name>` op target the SAME
    // daemon — the same read-path contract r91/r86 established post-fix. The D-13 guest-pin capture is a
    // separate OBSERVATION (its own file), not folded into a healthy claim it cannot support.
    const st = defaultState(lock.version)
    st.components.runtime = {
      state: STATES.HEALTHY,
      installedBySwarm: !alreadyPresent,
      version: `profile ${COLIMA_PROFILE} ${pre.sizing.cpu}cpu/${pre.sizing.memoryGiB}GiB vz`,
      integrity: cap.complete ? `sha256:${cap.complete.sha256}` : `D13-capture-incomplete:${cap.missing.join("+")}`,
      paths: [toolDir("runtime"), captureFilePath(), join(toolDir("runtime"), "lima-layout.json")],
      dockerObjects: [
        { kind: "profile", id: COLIMA_PROFILE, createdBySwarm: !alreadyPresent, hasData: true },
        { kind: "docker-context", id: observedContext, createdBySwarm: !alreadyPresent },
      ],
    }
    st.components.searxng = { state: STATES.CONFIGURED }
    st.components.firecrawl = pre.firecrawlOffered ? { state: STATES.CONFIGURED } : { state: STATES.SKIPPED }
    writeState(st)

    // Render the estate into the real tools root + generate every REQUIRED secret so checkPreconditions
    // passes for a real bring-up (bind sources under ~/.swarm/tools, which colima mounts via virtiofs).
    const manifest = { searxng: {} as Record<string, "generated">, firecrawl: {} as Record<string, "generated"> }
    for (const c of ["searxng", "firecrawl"] as const)
      for (const s of SECRET_INVENTORY[c]) if (s.required) manifest[c][s.name] = "generated"
    const rendered = renderAll(lock, { home, secrets: manifest })
    if (!rendered.ok) {
      json("render", {
        ok: false,
        errors: rendered.errors,
        findings: rendered.findings?.filter((f) => f.severity === "error"),
      })
      console.log("R93_OUTCOME bringup=BLOCKED_AT render")
      return
    }
    applyRenderedFiles(rendered, toolsDir())
    for (const comp of ["searxng", "firecrawl"] as const) {
      if (comp === "firecrawl" && !pre.firecrawlOffered) continue
      for (const spec of SECRET_INVENTORY[comp])
        if (spec.required) genSecret(join(home, ".swarm", "tools", comp, "secrets", spec.name))
    }
    const sxText = readFileSync(searxngPlan(home).composeFile, "utf8")
    const fcText = readFileSync(firecrawlPlan(home).composeFile, "utf8")
    const sxUrls = healthProbeUrls(sxText)
    const fcUrls = pre.firecrawlOffered ? healthProbeUrls(fcText) : []
    // The harness reads this instead of hardcoding a context name: every live docker call uses
    // `--context "$(cat r93-context.txt)"`, keeping the observed name the single source of truth.
    writeFileSync(join(work, "r93-context.txt"), `${observedContext}\n`)
    writeFileSync(join(work, "r93-probe-searxng.txt"), `${sxUrls.join("\n")}\n`)
    writeFileSync(join(work, "r93-probe-firecrawl.txt"), `${fcUrls.join("\n")}\n`)
    json("images", {
      searxng: writeImages("searxng", sxText),
      firecrawl: pre.firecrawlOffered ? writeImages("firecrawl", fcText) : [],
    })
    json("probe_urls", { searxng: sxUrls, firecrawl: fcUrls })

    // Precondition: the egress-proxy config bake must pass before Firecrawl may be brought up (r92).
    const fcKit = createStepKit({ componentId: "firecrawl", lock, state: st, dryRun: false, consentGate: () => true })
    const bake = await bakeEgressProxy({ kit: fcKit, home })
    json("egress_bake", { token: bake.token, ok: bake.verdict.ok, findings: bake.verdict.findings.map((f) => f.code) })
    if (pre.firecrawlOffered && bake.token !== "OK") {
      console.log("R93_OUTCOME bringup=BLOCKED_AT egress-bake")
      return
    }
    json("egress_health_contract", egressHealthContract({ lock, home, composeText: fcText }))
    console.log(`R93_OUTCOME bringup=OK firecrawlOffered=${pre.firecrawlOffered}`)
    return
  }

  if (phase === "searxng-up") {
    const st = committedState()
    const kit = createStepKit({ componentId: "searxng", lock, state: st, dryRun: false, consentGate: () => true })
    const plan = searxngPlan()
    const out = await bringUp({ kit, plan, run })
    json("searxng_up", {
      token: out.token,
      attempts: out.attempts,
      healthUrls: out.healthUrls,
      commands: out.commands,
      message: out.message,
    })
    console.log(`R93_OUTCOME searxng-up=${out.token}`)
    return
  }

  if (phase === "firecrawl-up") {
    const st = committedState()
    const kit = createStepKit({ componentId: "firecrawl", lock, state: st, dryRun: false, consentGate: () => true })
    const plan = firecrawlPlan()
    const out = await bringUp({ kit, plan, run, healthDeadlineMs: 240_000, healthIntervalMs: 3_000 })
    json("firecrawl_up", {
      token: out.token,
      attempts: out.attempts,
      healthUrls: out.healthUrls,
      commands: out.commands,
      message: out.message,
    })
    console.log(`R93_OUTCOME firecrawl-up=${out.token}`)
    return
  }

  if (phase === "teardown") {
    const st = committedState()
    for (const comp of ["firecrawl", "searxng"] as const) {
      const plan = comp === "firecrawl" ? firecrawlPlan() : searxngPlan()
      const kit = createStepKit({ componentId: comp, lock, state: st, dryRun: false, consentGate: () => true })
      const out = await tearDown({ kit, plan, run })
      json(`teardown_${comp}`, { token: out.token, deferredVolumes: out.deferredVolumes, message: out.message })
    }
    console.log(`R93_OUTCOME teardown=OK spawned=${realDocker.executedCount()}`)
    return
  }

  console.error(`live_smoke: unknown phase ${JSON.stringify(phase)}`)
  process.exit(2)
}

await main()
