// Row-91 unit tests for the stack bring-up library (src/stacklib.ts) and its two component
// steps (searxng PC-CMP-06, firecrawl PC-CMP-07). NO docker daemon, NO network, NO real spawn:
// every lifecycle path is driven through the injected fake docker CLI shim (makeFakeDockerShim),
// which records argv and answers from canned rules — the honest fake the brief demands ("prove
// with injected fake docker CLI shim"). Artefacts are staged by CONSUMING the row-85 renderer's
// declared interface (renderAll + applyRenderedFiles) into a throwaway HOME; this row never
// re-renders into ~/.swarm and never edits the renderer.
//
// The four brief-mandated proofs are each a named describe:
//   (1) missing-secret refusal (fail-closed listing)      -> "preconditions fail closed"
//   (2) label-scoped down selection (only labelled objs)  -> "label-scoped teardown"
//   (3) dry-run zero-exec                                 -> "dry-run performs zero exec, zero writes"
//   (4) healthcheck timeout -> BLOCKED-style token         -> "health gate timeout"
// Plus PORT RULE (ports parsed from artefact, never literal) and the egress-proxy pin conformance.
//
// Run TARGETED (row 102 owns the full suite): cd packages/setup && bun test test/stack_steps.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
// Per-run isolation of the source-posture lock (replaces the shared src/tools.lock.json staging).
import { isolateSourceLock } from "./lockPosture.ts"
import { OUTCOME } from "../src/outcomes.ts"
import { STATES, DOCKER_CONTEXT, type ComponentId } from "../src/constants.ts"
import { defaultState, type StateFile } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { createStepKit } from "../src/stepkit.ts"
import { stateFile } from "../src/paths.ts"
import { computeLockSha256, evaluateConsent, expectedTokenValue } from "../src/consent.ts"
import { renderAll, applyRenderedFiles } from "../src/composefiles/index.ts"
import { SECRET_INVENTORY, pathsFor } from "../src/composefiles/shared.ts"
import {
  bringUp,
  checkPreconditions,
  composeDownCmd,
  composeNetworksArgs,
  composePsArgs,
  composeUpCmd,
  containerInspectArgs,
  containerRmArgs,
  contextInspectArgs,
  egressProxyPinReady,
  firecrawlPlan,
  healthProbeUrls,
  healthVerdict,
  imageRmArgs,
  labelListArgs,
  makeFakeDockerShim,
  networkRmArgs,
  parsePublishedPorts,
  readStackProvenanceRecords,
  resolveDockerContextName,
  searxngPlan,
  selectLabelled,
  serviceFromContainerName,
  serviceProbeUrls,
  stackProvenanceFile,
  tearDown,
  volumeRmCmd,
  waitForHealthy,
  type DockerRunner,
  type ReadinessProbe,
} from "../src/stacklib.ts"
import searxngStep from "../src/steps/searxng/index.ts"
import firecrawlStep from "../src/steps/firecrawl/index.ts"

// ---- source-run lock posture: private program dir per run (see test/lockPosture.ts) ----
let releaseLockPosture: (() => void) | undefined
let LOCK: LockFile

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in test setup: ${loaded.error}`)
  LOCK = loaded.lock
})
afterAll(() => {
  releaseLockPosture?.()
})

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-r91-${label}-`))
  process.env.HOME = home
  return home
}

/** Consume the r85 renderer to place the two compose stacks + generated configs under a throwaway
 *  tools root. Declares every REQUIRED secret slot generated (names only — the renderer never sees
 *  values); optionals stay absent (D-22). This is READ of the renderer interface, not a re-render. */
function stageArtefacts(home: string): void {
  const requiredManifest = { searxng: {} as Record<string, "generated">, firecrawl: {} as Record<string, "generated"> }
  for (const comp of ["searxng", "firecrawl"] as const) {
    for (const spec of SECRET_INVENTORY[comp]) if (spec.required) requiredManifest[comp][spec.name] = "generated"
  }
  const result = renderAll(LOCK, { home, secrets: requiredManifest })
  if (!result.ok)
    throw new Error(
      `stageArtefacts: renderer refused: ${JSON.stringify(result.errors)} ${JSON.stringify(result.findings)}`,
    )
  applyRenderedFiles(result, `${home}/.swarm/tools`)
}

/** Create the required secret FILES a component's bring-up precondition demands (0600, non-empty).
 *  The renderer deliberately does NOT create these (s85 §8); the owning step does. */
function writeSecrets(home: string, component: "searxng" | "firecrawl"): void {
  const dir = `${home}/.swarm/tools/${component}/secrets`
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const spec of SECRET_INVENTORY[component]) {
    if (!spec.required) continue
    writeFileSync(`${dir}/${spec.name}`, `fake-${spec.name}-value-0123456789abcdef\n`, { mode: 0o600 })
  }
}

function readyState(component: ComponentId): StateFile {
  const st = defaultState(LOCK.version)
  st.components.runtime = { state: STATES.HEALTHY }
  st.components[component] = { state: STATES.CONFIGURED }
  return st
}

/** A green shim: context ok, up ok, ps reports every named container running+healthy, lists empty. */
function greenShim(
  containers: Array<{ name: string; health?: string }> = [{ name: "searxng", health: "healthy" }, { name: "valkey" }],
) {
  const psOut = containers.map((c) => `${c.name}=running=${c.health ?? "<none>"}`).join("\n")
  return makeFakeDockerShim([
    { match: "context inspect", stdout: "swarm" },
    { match: "={{.Health}}", stdout: psOut }, // compose ps
    { match: "network ls", stdout: "swarm-tools_se-edge\nswarm-tools_se-int" },
  ])
}

/** Host-side readiness prober paired with greenShim. Under the 2026-10-20 healthcheck-contract
 *  ruling a container WITHOUT a declared healthcheck (e.g. valkey above, or api/playwright once
 *  row 85 drops their wget checks) is green only on `Up` PLUS a passing probe — this is that probe.
 *  It records the targets it was asked about so a test can assert the gate probed the RIGHT service. */
function recordingReadiness(): { probe: ReadinessProbe; targets: Array<{ service: string; container: string; urls: readonly string[] }> } {
  const targets: Array<{ service: string; container: string; urls: readonly string[] }> = []
  const probe: ReadinessProbe = async (t) => {
    targets.push({ service: t.service, container: t.container, urls: t.urls })
    return { ok: true, detail: "ready (fixture)" }
  }
  return { probe, targets }
}
const greenReadiness: ReadinessProbe = async () => ({ ok: true, detail: "ready (fixture)" })

describe("(1) preconditions fail closed — missing secret is refused with a listing, zero docker calls", () => {
  it("refuses when a required secret file is absent, listing exactly what is missing", async () => {
    const home = freshHome("sec-missing")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    rmSync(`${home}/.swarm/tools/searxng/secrets/secret_key`, { force: true }) // remove the one required secret

    const shim = greenShim()
    const kit = createStepKit({
      componentId: "searxng",
      lock: LOCK,
      state: readyState("searxng"),
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })

    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.missing.some((g) => g.code === "SECRET_MISSING" && g.item.includes("secret_key"))).toBe(true)
    expect(shim.zeroExec()).toBe(true) // fail-closed BEFORE any daemon round-trip
    expect(out.message).toContain("preconditions not met")
  })

  it("refuses a group/other-readable secret (D-04 mode discipline)", async () => {
    const home = freshHome("sec-mode")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const p = `${home}/.swarm/tools/searxng/secrets/secret_key`
    rmSync(p, { force: true }) // recreate so the creation mode actually lands (writeFileSync mode is create-only)
    writeFileSync(p, "x".repeat(40) + "\n", { mode: 0o644 })
    expect((statSync(p).mode & 0o077) !== 0).toBe(true) // fixture sanity: group bits really set
    const shim = greenShim()
    const kit = createStepKit({
      componentId: "searxng",
      lock: LOCK,
      state: readyState("searxng"),
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.missing.some((g) => g.code === "SECRET_MISSING" && g.item.includes("mode"))).toBe(true)
    expect(shim.zeroExec()).toBe(true)
  })

  it("refuses when runtime is not healthy (lifecycle gate), zero docker calls", async () => {
    const home = freshHome("rt-down")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const st = readyState("searxng")
    st.components.runtime = { state: STATES.INSTALLED } // not healthy
    const shim = greenShim()
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.missing.some((g) => g.code === "RUNTIME_NOT_HEALTHY")).toBe(true)
    expect(shim.zeroExec()).toBe(true)
  })

  it("honours a deliberate skip (memory floor decision 12) — bring-up will not resurrect it", async () => {
    const home = freshHome("skipped")
    stageArtefacts(home)
    writeSecrets(home, "firecrawl")
    const st = readyState("firecrawl")
    st.components.firecrawl = { state: STATES.SKIPPED }
    const shim = greenShim([{ name: "api" }])
    const kit = createStepKit({
      componentId: "firecrawl",
      lock: LOCK,
      state: st,
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bringUp({ kit, plan: firecrawlPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.missing.some((g) => g.code === "COMPONENT_SKIPPED")).toBe(true)
    expect(shim.zeroExec()).toBe(true)
  })

  it("refuses a component that is not yet at configured (this row consumes, never creates)", async () => {
    const home = freshHome("not-ready")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const st = readyState("searxng")
    st.components.searxng = { state: STATES.ABSENT }
    const shim = greenShim()
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.missing.some((g) => g.code === "COMPONENT_NOT_READY")).toBe(true)
  })

  it("does not mis-flag an in-whitelist bind when HOME carries a double slash (path-collapse guard)", () => {
    // Regression: r85's joinAbs leaves a `/x//y` HOME unnormalized in the rendered source while
    // path.join collapses it; without collapseSlashes the whitelist prefix test mis-fires.
    const base = mkdtempSync(join(tmpdir(), "swarm-r91-dslash-"))
    process.env.HOME = base
    const home = `${base}//nested` // same directory, doubled separator
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const report = checkPreconditions(searxngPlan(home), readyState("searxng"), home)
    expect(report.gaps.some((g) => g.code === "BIND_SOURCE_OUTSIDE_WHITELIST")).toBe(false)
    rmSync(base, { recursive: true, force: true })
  })
})

describe("(3) dry-run performs ZERO exec and ZERO filesystem writes", () => {
  it("prints the exact commands, touches nothing", async () => {
    const home = freshHome("dryrun")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const before = existsSync(stateFile())

    const shim = greenShim()
    const st = readyState("searxng")
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: true, consentGate: () => true })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })

    expect(out.token).toBe(OUTCOME.OK)
    expect(shim.zeroExec()).toBe(true) // no docker call at all
    expect(kit.dryTransitions.length).toBe(1) // the single configured->healthy marker
    expect(kit.dryTransitions[0]?.to).toBe(STATES.HEALTHY)
    expect(out.commands.some((c) => c.includes("up -d --pull never"))).toBe(true)
    expect(out.commands.some((c) => c.includes(`-p swarm-tools`))).toBe(true)
    expect(out.commands.some((c) => c.includes(`--context ${DOCKER_CONTEXT}`))).toBe(true) // context name from the register constant (colima-swarm), never a literal here
    // Zero writes: no state.json committed, no provenance ledger created.
    expect(existsSync(stateFile())).toBe(before)
    expect(existsSync(stackProvenanceFile())).toBe(false)
  })

  it("remove dry-run prints the label scope and deletes nothing", async () => {
    const home = freshHome("dryrun-down")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = greenShim()
    const kit = createStepKit({
      componentId: "searxng",
      lock: LOCK,
      state: readyState("searxng"),
      dryRun: true,
      consentGate: () => true,
    })
    const out = await tearDown({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.OK)
    expect(shim.zeroExec()).toBe(true)
    expect(out.commands.some((c) => c.includes("down"))).toBe(true)
    expect(out.commands.some((c) => c.includes("volume rm"))).toBe(false) // volume removal never even implied as executed
  })
})

describe("happy path — up, health gate green, healthy transition, provenance row", () => {
  it("brings the stack up under project swarm-tools and records one provenance line", async () => {
    const home = freshHome("happy")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = greenShim()
    const st = readyState("searxng")
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    // valkey reports <none> health -> no-healthcheck container; the readiness prober is what
    // satisfies it under the 2026-10-20 contract (see FIX ROUND 3 describes for the dedicated fixtures).
    const out = await bringUp({
      kit,
      plan: searxngPlan(home),
      run: shim.runner,
      readiness: greenReadiness,
      healthIntervalMs: 1,
      sleep: async () => {},
    })

    expect(out.token).toBe(OUTCOME.OK)
    expect(st.components.searxng.state).toBe(STATES.HEALTHY)
    expect(st.components.searxng.dockerObjects?.some((o) => o.kind === "container" && o.createdBySwarm)).toBe(true)
    expect(shim.neverPrune()).toBe(true)
    // Executed the context probe, the file-scoped up, the health poll, the network list.
    const cmds = shim.formatted()
    expect(cmds.some((c) => c.includes(`context inspect ${DOCKER_CONTEXT}`))).toBe(true)
    expect(cmds.some((c) => c.includes("-f ") && c.includes("up -d --pull never"))).toBe(true)
    expect(cmds.some((c) => c.includes("={{.Health}}"))).toBe(true)
    // Provenance per bring-up. A GREEN sequence keeps the bare "up" verb (R112b-7 vocabulary:
    // only failed phases carry the "-failed"/"-incomplete" suffix).
    const rows = readStackProvenanceRecords()
    expect(rows.length).toBe(1)
    expect(rows[0]?.outcome).toBe(OUTCOME.OK)
    expect(rows[0]?.action).toBe("up")
    expect(rows[0]?.project).toBe("swarm-tools")
  })

  it("is idempotent: an already-healthy stack needs no daemon round-trip", async () => {
    const home = freshHome("idempotent")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const st = readyState("searxng")
    st.components.searxng = { state: STATES.HEALTHY }
    const shim = greenShim()
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.OK)
    expect(shim.zeroExec()).toBe(true)
    expect(out.message).toContain("already healthy")
  })
})

describe("(4) health gate timeout -> HEALTH_FAILED (BLOCKED-style outcome token)", () => {
  it("returns HEALTH_FAILED when containers never report healthy within the window", async () => {
    const shim = makeFakeDockerShim([
      { match: "context inspect", stdout: "swarm" },
      { match: "={{.Health}}", stdout: "searxng=running=starting\nvalkey=running=<none>" }, // never green
      { match: "network ls", stdout: "" },
    ])
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "/fixture/compose/searxng.yml",
      deadlineMs: 0, // immediate timeout after the first non-green poll
      intervalMs: 1,
      sleep: async () => {},
    })
    expect(wait.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(wait.verdict.unhealthy).toContain("searxng")
  })

  it("fails fast (no long wait) when a container is not running", async () => {
    const shim = makeFakeDockerShim([
      { match: "context inspect", stdout: "swarm" },
      { match: "={{.Health}}", stdout: "searxng=exited=none" },
    ])
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "/fixture/x.yml",
      deadlineMs: 600_000,
      intervalMs: 1,
      sleep: async () => {},
    })
    expect(wait.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(wait.attempts).toBe(1) // did not spin the whole window
  })

  it("propagates HEALTH_FAILED through bringUp and records failed state + provenance", async () => {
    const home = freshHome("health-timeout")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = makeFakeDockerShim([
      { match: "context inspect", stdout: "swarm" },
      { match: "={{.Health}}", stdout: "searxng=running=starting" },
      { match: "network ls", stdout: "" },
    ])
    const st = readyState("searxng")
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await bringUp({
      kit,
      plan: searxngPlan(home),
      run: shim.runner,
      healthDeadlineMs: 0,
      healthIntervalMs: 1,
      sleep: async () => {},
    })
    expect(out.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(st.components.searxng.state).toBe(STATES.FAILED)
    const rows = readStackProvenanceRecords()
    expect(rows.at(-1)?.outcome).toBe(OUTCOME.HEALTH_FAILED)
    // R112b-7 truthfulness: the ledger verb must not read as a bare "up" on a failed phase.
    expect(rows.at(-1)?.action).toBe("up-failed")
  })
})

describe("(2) label-scoped teardown — only labelled objects, ask-before-volume, never prune", () => {
  it("builds the label pair (managed=true AND component=<id>) as the ONLY selector", () => {
    const args = labelListArgs("container", "searxng")
    const joined = args.join(" ")
    expect(joined).toContain("label=io.gsp.swarm.managed=true")
    expect(joined).toContain("label=io.gsp.swarm.component=searxng")
    expect(joined).not.toContain("prune")
  })

  it("routes label-list output into kinds; unlabelled objects are structurally absent", () => {
    const sel = selectLabelled({ containers: "c1\nc2", networks: "n1", volumes: "", images: "" })
    expect(sel.containers).toEqual(["c1", "c2"])
    expect(sel.networks).toEqual(["n1"])
    expect(sel.volumes).toEqual([])
  })

  it("removes labelled residue but DEFERS volumes; never touches the other stack", async () => {
    const home = freshHome("teardown")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = makeFakeDockerShim([
      { match: "container ls", stdout: "c-searxng-1" },
      { match: "network ls", stdout: "swarm-tools_se-int" },
      { match: "volume ls", stdout: "leftover-vol" }, // drift case: a labelled volume appeared
      { match: "image ls", stdout: "" },
    ])
    const st = readyState("searxng")
    st.components.searxng = { state: STATES.HEALTHY }
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await tearDown({ kit, plan: searxngPlan(home), run: shim.runner })

    expect(out.token).toBe(OUTCOME.SKIPPED_WITH_INSTRUCTIONS) // a volume was found -> ask
    expect(out.deferredVolumes).toEqual(["leftover-vol"])
    const executed = shim.formatted()
    expect(executed.some((c) => c.includes("down"))).toBe(true)
    expect(executed.some((c) => c.includes("rm c-searxng-1"))).toBe(true)
    expect(executed.some((c) => c.includes("network rm swarm-tools_se-int"))).toBe(true)
    // The volume removal is PRINTED as an instruction but NEVER EXECUTED (ask-before-data-volume).
    expect(out.commands.some((c) => c.includes("volume rm leftover-vol"))).toBe(true)
    expect(executed.some((c) => c.includes("volume rm"))).toBe(false)
    // Cross-stack isolation: nothing here names firecrawl, and no prune anywhere.
    expect(executed.some((c) => c.includes("firecrawl"))).toBe(false)
    expect(shim.neverPrune()).toBe(true)
  })

  it("reaches absent when no volumes linger", async () => {
    const home = freshHome("teardown-clean")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = makeFakeDockerShim([
      { match: "container ls", stdout: "" },
      { match: "network ls", stdout: "" },
      { match: "volume ls", stdout: "" },
      { match: "image ls", stdout: "" },
    ])
    const st = readyState("searxng")
    st.components.searxng = { state: STATES.HEALTHY }
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await tearDown({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.OK)
    expect(st.components.searxng.state).toBe(STATES.ABSENT)
  })
})

describe("PORT RULE — ports/URLs are parsed from the artefact, never hardcoded", () => {
  it("derives loopback probe URLs from whatever host ports the rendered compose declares", () => {
    const home = freshHome("ports")
    stageArtefacts(home)
    const text = readFileSync(pathsFor(`${home}/.swarm/tools`).searxngCompose, "utf8")
    const ports = parsePublishedPorts(text)
    expect(ports.length).toBeGreaterThanOrEqual(1)
    for (const p of ports) {
      expect(p.hostIp).toBe("127.0.0.1") // P-6 loopback form, read not asserted-to-a-number
      expect(/^\d+$/.test(p.hostPort)).toBe(true)
    }
    const urls = healthProbeUrls(text)
    expect(urls.every((u) => u.startsWith("http://127.0.0.1:"))).toBe(true)
    // The URL host:port equals the artefact's own value (round-trip), proving no re-hardcode.
    expect(urls[0]).toBe(`http://${ports[0]!.hostIp}:${ports[0]!.hostPort}/`)
  })

  it("the up command scopes to the single stack file under the shared project", () => {
    const cmd = composeUpCmd("/abs/path/searxng/compose/searxng.yml").join(" ")
    expect(cmd).toContain(`--context ${DOCKER_CONTEXT}`)
    expect(cmd).toContain("-p swarm-tools")
    expect(cmd).toContain("-f /abs/path/searxng/compose/searxng.yml")
    expect(cmd).toContain("up -d --pull never")
    expect(cmd).not.toContain("firecrawl") // file scoping: searxng up never references the other stack
  })
})

describe("H-R93-2 / H-R93-1 — context-inspect argv + recorded-name resolution", () => {
  // The live VM (r93) proved real docker rejects `docker --context context inspect swarm` (it reads
  // `--context context` + `inspect swarm`). The correct form has NO --context flag. And colima names
  // the context colima-<profile>, so the probe target follows the runtime step's recorded name.
  it("builds `docker context inspect <name>` with NO leading --context flag", () => {
    const args = contextInspectArgs("colima-swarm")
    expect(args).toEqual(["context", "inspect", "colima-swarm"])
    expect(args[0]).toBe("context") // NOT "--context"
    expect(args.join(" ")).not.toContain("--context")
  })

  it("defaults the inspected name to the register constant when none is passed", () => {
    expect(contextInspectArgs()).toEqual(["context", "inspect", DOCKER_CONTEXT])
  })

  it("resolveDockerContextName returns the runtime step's recorded context id", () => {
    const st = defaultState(LOCK.version)
    st.components.runtime = {
      state: STATES.HEALTHY,
      dockerObjects: [
        { kind: "profile", id: "swarm", createdBySwarm: true, hasData: true }, // distractor: NOT a context
        { kind: "docker-context", id: "state-ctx-marker", createdBySwarm: true },
      ],
    }
    expect(resolveDockerContextName(st)).toBe("state-ctx-marker") // picks the docker-context entry, not the profile, not the default
  })

  it("falls back to the register constant when no context is recorded (offline / nothing recorded)", () => {
    // The fallback must equal the SAME register name contextInspectArgs() defaults to (proven via
    // that builder's own third argv slot, so this stays correct whatever PC-PROF-02 resolves to).
    expect(resolveDockerContextName(readyState("searxng"))).toBe(contextInspectArgs()[2])
  })

  it("bringUp dry-run probes the RECORDED context name (end-to-end wiring), zero exec", async () => {
    const home = freshHome("ctx-recorded")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const st = readyState("searxng")
    // A DISTINCT synthetic name (not the register constant) proves the resolver reads state, not coincidence.
    st.components.runtime = {
      state: STATES.HEALTHY,
      dockerObjects: [{ kind: "docker-context", id: "state-ctx-marker", createdBySwarm: true }],
    }
    const shim = greenShim()
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: true, consentGate: () => true })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.OK)
    expect(shim.zeroExec()).toBe(true)
    expect(out.commands[0]).toBe("docker context inspect state-ctx-marker") // corrected argv + RECORDED name overrides the default
    expect(out.commands[0]).not.toContain("--context")
  })

  it("bringUp fails closed when the (correctly-formed) context probe is rejected by docker", async () => {
    const home = freshHome("ctx-reject")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = makeFakeDockerShim([
      { match: "context inspect", exitCode: 1, stderr: "unable to resolve docker endpoint: context not found" },
    ])
    const kit = createStepKit({
      componentId: "searxng",
      lock: LOCK,
      state: readyState("searxng"),
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.FAILED)
    const wantCtx = contextInspectArgs()[2] // the register-resolved context name (colima-swarm)
    expect(out.message).toContain(`docker context "${wantCtx}" not reachable`)
    // The probe was the ONLY thing run (compose up never reached): exactly one invocation, correctly formed.
    expect(shim.invocations.length).toBe(1)
    expect(shim.invocations[0]).toEqual(["context", "inspect", wantCtx])
  })
})

describe("egress-proxy pin — the controller-cleared squid digest is what the lock carries", () => {
  // Reference constants supplied by the controller brief (r78a ADDENDUM, re-fetch matched). They
  // live HERE as fixtures, not in shipped code: shipped code only asserts the lock field is a
  // digest-pinned reference (egressProxyPinReady), keeping no magic digest literal in src/.
  const CLEARED_INDEX = "sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029"
  const CLEARED_ARM64 = "sha256:eecf35336788c1ab143566bca99ac58f213e9f17906a9a684346d7b323b6696c"

  it("lock egress_proxy_image equals the cleared index digest", () => {
    const ref = String(LOCK.components.firecrawl?.egress_proxy_image)
    expect(ref).toBe(`docker.io/ubuntu/squid@${CLEARED_INDEX}`)
  })
  it("lock arm64 manifest digest equals the cleared platform digest", () => {
    expect(String(LOCK.components.firecrawl?.egress_proxy_image_arm64_manifest_digest)).toBe(CLEARED_ARM64)
  })
  it("egressProxyPinReady accepts the shipped lock and rejects a tag-only/null field", () => {
    expect(egressProxyPinReady(LOCK).ok).toBe(true)
    const bad = {
      ...LOCK,
      components: {
        ...LOCK.components,
        firecrawl: { ...LOCK.components.firecrawl, egress_proxy_image: "docker.io/ubuntu/squid:latest" },
      },
    }
    expect(egressProxyPinReady(bad as LockFile).ok).toBe(false)
    const nul = {
      ...LOCK,
      components: { ...LOCK.components, firecrawl: { ...LOCK.components.firecrawl, egress_proxy_image: null } },
    }
    expect(egressProxyPinReady(nul as LockFile).ok).toBe(false)
  })
})

describe("step modules wire the library end-to-end (install/remove via StepContext)", () => {
  // The steps build their kit with the DEFAULT consent gate (consent is the engine's job, not a
  // step seam), so through a step module the gate is genuinely enforced. This first case proves
  // that; the next drives a REAL durable grant (row-83 evaluateConsent) to reach healthy.
  it("searxng.install enforces the consent gate FIRST (no grant -> REFUSED_NO_CONSENT, zero docker)", async () => {
    const home = freshHome("step-consent")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = greenShim()
    const out = await searxngStep.install({
      lock: LOCK,
      state: readyState("searxng"),
      dryRun: false,
      docker: shim.runner,
    } as never)
    expect(out.token).toBe(OUTCOME.REFUSED_NO_CONSENT)
    expect(shim.zeroExec()).toBe(true)
  })

  it("searxng.install reaches healthy after a durable consent grant; remove returns to absent", async () => {
    const home = freshHome("step-e2e")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const granted = evaluateConsent({
      selected: ["searxng"],
      nonInteractive: true,
      tokens: { searxng: expectedTokenValue("searxng", computeLockSha256()) },
      lock: LOCK,
    })
    expect(granted.ok).toBe(true)

    const st = readyState("searxng")
    const upShim = greenShim()
    // readiness rides the widened StackStepContext (row 91's local seam): the engine-side prober
    // satisfies the no-healthcheck valkey container; without it this e2e would fail CLOSED (red),
    // which is itself asserted in the FIX ROUND 3 describe below.
    const install = await searxngStep.install({
      lock: LOCK,
      state: st,
      dryRun: false,
      docker: upShim.runner,
      readiness: greenReadiness,
    } as never)
    expect(install.token).toBe(OUTCOME.OK)
    expect(st.components.searxng.state).toBe(STATES.HEALTHY)

    const rmShim = makeFakeDockerShim([{ match: "ls", stdout: "" }])
    const remove = await searxngStep.remove({ lock: LOCK, state: st, dryRun: false, docker: rmShim.runner } as never)
    expect(remove.token).toBe(OUTCOME.OK)
    expect(st.components.searxng.state).toBe(STATES.ABSENT)
  })

  it("firecrawl.install refuses when the egress-proxy pin is unusable", async () => {
    const home = freshHome("step-fc-pin")
    stageArtefacts(home)
    writeSecrets(home, "firecrawl")
    const badLock = {
      ...LOCK,
      components: {
        ...LOCK.components,
        firecrawl: { ...LOCK.components.firecrawl, egress_proxy_image: "docker.io/ubuntu/squid:latest" },
      },
    }
    const st = readyState("firecrawl")
    const shim = greenShim([{ name: "api" }])
    const out = await firecrawlStep.install({
      lock: badLock as LockFile,
      state: st,
      dryRun: false,
      docker: shim.runner,
    } as never)
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(shim.zeroExec()).toBe(true) // refused before touching docker
  })

  it("both steps refuse honestly with no runner injected (never touch docker)", async () => {
    const home = freshHome("step-norunner")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const sx = await searxngStep.install({ lock: LOCK, state: readyState("searxng"), dryRun: false } as never)
    expect(sx.token).toBe(OUTCOME.FAILED)
    expect(sx.message).toContain("runner")
  })
})

// ---- FIX ROUND 2 (R111-1 / R111-2) -------------------------------------------------------
// A fake-shim fixture that ERRORS on any docker/compose subcommand outside the pinned CLI's
// documented surface, so an unsupported verb can never slip through again unnoticed. Citation:
// docker compose v5.6.0 (tools.lock.json components.runtime.docker_compose; 02d §6) documents NO
// `compose networks` subcommand (docs.docker.com/reference/cli/docker/compose/); R111-1 captured
// the live rejection `unknown docker command: "networks"`.
describe("FIX2 R111-1 — every shipped builder uses a SUPPORTED verb (fixture errors otherwise)", () => {
  const COMPOSE_VERBS = new Set([
    "attach", "build", "commit", "config", "convert", "cp", "create", "down", "events", "exec",
    "export", "images", "kill", "logs", "ls", "pause", "port", "ps", "publish", "pull", "push",
    "restart", "rm", "run", "scale", "start", "stats", "stop", "top", "unpause", "up", "version",
    "volumes", "wait", "watch",
  ]) // docker compose v5.6.0 documented subcommands — deliberately NO "networks"
  const DOCKER_TOP = new Set(["context", "network", "volume", "image", "container", "inspect", "rm", "rmi", "ps", "pull", "info", "images", "system"])
  const VALUE_FLAGS = new Set(["-p", "--project-name", "-f", "--file", "--project-directory", "--profile", "--env-file"])

  // Resolve the operative subcommand from an argv, mirroring how the CLI parses global + per-command
  // flags. Returns null for an unrecognised docker top-level verb; `compose <sub>` for compose mode.
  function resolveVerb(args: readonly string[]): string | null {
    let i = 0
    while (i < args.length && args[i] === "--context") i += 2 // consume the global --context <name>
    const head = args[i]
    if (head === undefined) return null
    if (head === "compose") {
      i += 1
      while (i < args.length) {
        const t = args[i]!
        if (t.startsWith("-")) { i += VALUE_FLAGS.has(t) ? 2 : 1; continue }
        return `compose ${t}` // first non-flag token after `compose` is its subcommand
      }
      return "compose"
    }
    if (!DOCKER_TOP.has(head)) return null // unknown docker top-level verb
    return `docker ${head}` // sub-subcommands (network ls / context inspect / volume rm …) ride on a valid top verb
  }

  // Shim that returns exit 1 (`unknown docker command`) for any unresolvable/unsupported verb.
  function verbValidatingRunner() {
    const seen: string[] = []
    return {
      seen,
      runner: async (args: readonly string[]) => {
        seen.push(args.join(" "))
        const verb = resolveVerb(args)
        const bad = verb === null || (verb.startsWith("compose ") && !COMPOSE_VERBS.has(verb.slice(8)))
        if (bad) return { exitCode: 1, stdout: "", stderr: `unknown docker command: "${(verb ?? "").replace(/^\S+ /, "")}"` }
        return { exitCode: 0, stdout: "", stderr: "" }
      },
    }
  }

  it("accepts EVERY builder the stack lifecycle emits", async () => {
    const v = verbValidatingRunner()
    const cmds = [
      composeUpCmd("/abs/searxng.yml"),
      composeDownCmd("/abs/searxng.yml"),
      composePsArgs("/abs/searxng.yml"),
      composeNetworksArgs("/abs/searxng.yml"),
      contextInspectArgs("colima-swarm"),
      labelListArgs("container", "searxng"),
      labelListArgs("network", "searxng"),
      labelListArgs("volume", "searxng"),
      labelListArgs("image", "searxng"),
      containerInspectArgs("c1"),
      containerRmArgs("c1"),
      networkRmArgs("n1"),
      imageRmArgs("i1"),
      volumeRmCmd("v1"),
    ]
    for (const c of cmds) {
      const r = await v.runner(c)
      expect(`${c.join(" ")} -> ${r.stderr}`).toBe(`${c.join(" ")} -> `) // exit 0, empty stderr
    }
    expect(v.seen.length).toBe(cmds.length)
  })

  it("the networks listing is now plain `docker network ls` (no compose verb, no bogus 'networks')", () => {
    const args = composeNetworksArgs("/abs/searxng.yml")
    expect(args).toContain("network")
    expect(args).toContain("ls")
    expect(args).not.toContain("compose") // fixed: not a compose subcommand at all
    expect(args.join(" ")).not.toContain(" networks ")
    expect(args.join(" ")).toContain("com.docker.compose.project.config_files=/abs/searxng.yml") // per-stack scoping inside shared project
  })

  it("the SAME fixture REJECTS the retired broken form (regression guard)", async () => {
    const v = verbValidatingRunner()
    const broken = ["--context", "colima-swarm", "compose", "-p", "swarm-tools", "-f", "/abs/searxng.yml", "networks", "--format", "{{.Name}}"]
    const r = await v.runner(broken)
    expect(r.exitCode).toBe(1)
    expect(r.stderr).toContain('unknown docker command: "networks"')
  })
})

describe("FIX2 R111-2 — context gone (colima stop deletes the context it added)", () => {
  it("resolver falls back to the register constant when only a profile is recorded (context absent)", () => {
    const st = defaultState(LOCK.version)
    st.components.runtime = { state: STATES.HEALTHY, dockerObjects: [{ kind: "profile", id: "swarm", createdBySwarm: true, hasData: true }] }
    expect(resolveDockerContextName(st)).toBe(contextInspectArgs()[2]) // == register DOCKER_CONTEXT, the safe fallback
  })

  it("bringUp probes the register constant (not a phantom) when the context was never recorded", async () => {
    const home = freshHome("ctx-absent")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const st = defaultState(LOCK.version)
    st.components.runtime = { state: STATES.HEALTHY, dockerObjects: [{ kind: "profile", id: "swarm", createdBySwarm: true, hasData: true }] }
    st.components.searxng = { state: STATES.CONFIGURED }
    const shim = greenShim()
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: true, consentGate: () => true })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.commands[0]).toBe(`docker context inspect ${contextInspectArgs()[2]}`)
    expect(shim.zeroExec()).toBe(true)
  })

  it("fails CLOSED mid-run when a RECORDED context turns out gone (no silent proceed, no wrong-context up)", async () => {
    const home = freshHome("ctx-gone")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const st = defaultState(LOCK.version)
    st.components.runtime = { state: STATES.HEALTHY, dockerObjects: [{ kind: "docker-context", id: "colima-swarm", createdBySwarm: true }] }
    st.components.searxng = { state: STATES.CONFIGURED }
    const shim = makeFakeDockerShim([{ match: "context inspect", exitCode: 1, stderr: "context not found" }])
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await bringUp({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.message).toContain('docker context "colima-swarm" not reachable')
    expect(shim.invocations.length).toBe(1) // compose up NEVER ran against a wrong/absent context
    expect(shim.invocations[0]).toEqual(["context", "inspect", "colima-swarm"])
  })
})

// ---- FIX ROUND 3 (R112b-3, host-side half) ---------------------------------------------------
// The 2026-10-20 healthcheck-contract ruling (decisions.md :40-47) splits R112b-3: row 85 drops
// the wget healthchecks on api/playwright-service (digests ship no wget); THIS row's half is the
// gate treating a service with NO healthcheck defined as satisfied by Up PLUS its own host-side
// readiness probe, staying file/label-scoped. Live evidence being answered:
// verification/13b_live_firecrawl_rerun.md:135 — HEALTH_FAILED at poll 75 while both services
// served HTTP 200. The probe is an injected seam (this module opens no socket — P4b grep gate);
// the offline fake below stands in for row 93's live HTTP/TCP prober.

describe("FIX3 R112b-3 — no-healthcheck service goes green through the host-side readiness probe", () => {
  // Artefact-shaped snippet (indent rules mirror the r85 renderer) with ONE loopback publish on
  // api. The numbers are synthetic fixture values chosen OUTSIDE every register port pool, and
  // the host token is not 127.0.0.1 — this file must stay free of port/IP:port literals (P4a).
  const FIXTURE_COMPOSE = [
    "services:",
    "  api:",
    "    ports:",
    '      - "loopback.test:7001:7002"',
    "  nuq-postgres:",
    "    image: x",
  ].join("\n")

  it("fixture proof: shim serves a no-healthcheck service whose readiness answers — gate goes GREEN", async () => {
    const shim = makeFakeDockerShim([
      {
        match: "={{.Health}}",
        stdout: "swarm-tools-nuq-postgres-1=running=healthy\nswarm-tools-api-1=running=<none>",
      },
    ])
    const rec = recordingReadiness()
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "/fixture/firecrawl.yml",
      deadlineMs: 10_000,
      intervalMs: 1,
      sleep: async () => {},
      probe: rec.probe,
      composeText: FIXTURE_COMPOSE,
    })
    expect(wait.token).toBe(OUTCOME.OK)
    expect(wait.attempts).toBe(1)
    expect(wait.verdict.detail).toContain("satisfied by host-side readiness probes")
    // Probed EXACTLY the no-healthcheck container — mapped to its compose service, carrying the
    // artefact-derived URL; the healthy postgres was never probed (scope discipline).
    expect(rec.targets).toEqual([{ service: "api", container: "swarm-tools-api-1", urls: ["http://loopback.test:7001/"] }])
  })

  it("end-to-end: the U-1 shipped shape (searxng declares no healthcheck) reaches healthy with a serving probe", async () => {
    const home = freshHome("gate-green")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = makeFakeDockerShim([
      { match: "context inspect", stdout: "colima-swarm" },
      { match: "={{.Health}}", stdout: "swarm-tools-searxng-1=running=<none>\nswarm-tools-valkey-1=running=healthy" },
      { match: "network ls", stdout: "" },
    ])
    const st = readyState("searxng")
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await bringUp({
      kit,
      plan: searxngPlan(home),
      run: shim.runner,
      readiness: greenReadiness,
      healthIntervalMs: 1,
      sleep: async () => {},
    })
    expect(out.token).toBe(OUTCOME.OK)
    expect(st.components.searxng.state).toBe(STATES.HEALTHY)
    const rows = readStackProvenanceRecords()
    expect(rows.at(-1)?.outcome).toBe(OUTCOME.OK)
    expect(rows.at(-1)?.action).toBe("up") // green sequence keeps the bare verb
  })

  it("a FAILING readiness probe keeps the gate red and names WHICH service and WHY", async () => {
    const shim = makeFakeDockerShim([
      { match: "={{.Health}}", stdout: "swarm-tools-playwright-service-1=running=<none>" },
    ])
    const failing: ReadinessProbe = async () => ({ ok: false, detail: "tcp connect refused" })
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "/fixture/firecrawl.yml",
      deadlineMs: 0,
      intervalMs: 1,
      sleep: async () => {},
      probe: failing,
    })
    expect(wait.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(wait.verdict.unhealthy).toEqual(["swarm-tools-playwright-service-1"])
    expect(wait.verdict.detail).toContain("playwright-service")
    expect(wait.verdict.detail).toContain("no-healthcheck+readiness-failed(tcp connect refused)")
  })

  it("fail-closed WITHOUT a wired prober: the verdict names the service and says the probe is missing", async () => {
    const shim = makeFakeDockerShim([
      { match: "={{.Health}}", stdout: "swarm-tools-egress-proxy-1=running=<none>" },
    ])
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "/fixture/firecrawl.yml",
      deadlineMs: 0,
      intervalMs: 1,
      sleep: async () => {},
    })
    expect(wait.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(wait.verdict.detail).toContain("egress-proxy")
    expect(wait.verdict.detail).toContain("no-healthcheck+readiness-probe-missing")
  })

  it("timeout/poll budget unchanged in spirit: readiness-pending containers keep polling to the deadline", async () => {
    const shim = makeFakeDockerShim([{ match: "={{.Health}}", stdout: "swarm-tools-api-1=running=<none>" }])
    let now = 0
    const wait = await waitForHealthy({
      run: shim.runner,
      composeFile: "/fixture/x.yml",
      deadlineMs: 50,
      intervalMs: 10,
      sleep: async () => {
        now += 10
      },
      clock: () => now,
      probe: async () => ({ ok: false, detail: "not listening yet" }),
    })
    expect(wait.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(wait.attempts).toBeGreaterThan(1) // rode the window like a healthcheck-pending stack did before
    expect(wait.attempts).toBe(6) // polls at t=0,10,20,30,40,50; the deadline branch then fires
  })

  it("declared-healthcheck semantics UNCHANGED: all-green needs no probe call; starting still waits", async () => {
    const rec = recordingReadiness()
    const greenShimAllDeclared = makeFakeDockerShim([
      { match: "={{.Health}}", stdout: "swarm-tools-redis-1=running=healthy\nswarm-tools-rabbitmq-1=running=healthy" },
    ])
    const green = await waitForHealthy({
      run: greenShimAllDeclared.runner,
      composeFile: "/f.yml",
      deadlineMs: 1000,
      intervalMs: 1,
      sleep: async () => {},
      probe: rec.probe,
    })
    expect(green.token).toBe(OUTCOME.OK)
    expect(rec.targets.length).toBe(0) // every container declared a healthcheck -> nothing to probe
    const startingShim = makeFakeDockerShim([
      { match: "={{.Health}}", stdout: "swarm-tools-rabbitmq-1=running=starting" },
    ])
    const starting = await waitForHealthy({
      run: startingShim.runner,
      composeFile: "/f.yml",
      deadlineMs: 0,
      intervalMs: 1,
      sleep: async () => {},
      probe: rec.probe,
    })
    expect(starting.token).toBe(OUTCOME.HEALTH_FAILED)
    expect(starting.verdict.detail).toContain("rabbitmq-1:starting") // the pre-fix label form survives
    expect(rec.targets.length).toBe(0)
  })

  it("service mapping + URL grouping helpers (artefact-derived, PORT RULE intact)", () => {
    expect(serviceFromContainerName("swarm-tools-playwright-service-1")).toBe("playwright-service")
    expect(serviceFromContainerName("swarm-tools-api-1")).toBe("api")
    expect(serviceFromContainerName("foreign-name")).toBe("foreign-name") // falls back to itself
    const urls = serviceProbeUrls(FIXTURE_COMPOSE)
    expect(urls.get("api")).toEqual(["http://loopback.test:7001/"])
    expect(urls.get("nuq-postgres")).toBeUndefined() // unpublished -> exec/TCP-class probe territory (row 93's call)
  })

  it("healthVerdict unit: the readiness map is keyed by CONTAINER NAME and gates only no-healthcheck lanes", () => {
    const map = new Map([
      ["a", { ok: true, detail: "ready" }],
      ["b", { ok: false, detail: "refused" }],
    ])
    const v = healthVerdict(
      [
        { name: "a", running: true },
        { name: "b", running: true },
        { name: "c", running: true, health: "healthy" },
      ],
      map,
    )
    expect(v.healthy).toBe(false)
    expect(v.unhealthy).toEqual(["b"]) // "a" green via probe, "c" green via declared check
    expect(v.detail).toContain("b:no-healthcheck+readiness-failed(refused)")
  })
})

// ---- FIX ROUND 3 (R112b-7) -------------------------------------------------------------------
// Audit-trail truthfulness, reproduced twice (verification/13_live_firecrawl.md R112-7, then
// verification/13b_live_firecrawl_rerun.md:139): (a) the ledger read `firecrawl up` although the
// phase ended HEALTH_FAILED — the outcome FIELD was already honest on disk (live row
// 2026-10-20T10:52:59.099Z carries "outcome":"HEALTH_FAILED"), but the bare action verb invited
// the misread; bare verbs are now reserved for green sequences. (b) tearDown printed `0 network(s)`
// while down verifiably removed five — root cause: the count came from the POST-down residue
// listing (empty by construction after a good down) AND compose networks carry no io.gsp.swarm.*
// labels at all (FIX ROUND 2 citation), so a label-scoped count could never be non-zero. Counts
// are now before/after deltas over the compose-labelled network scoping; a failed leg reports
// "count unavailable", never a fabricated zero.

describe("FIX3 R112b-7 — provenance verb and teardown count tell the truth", () => {
  /** Stateful fake estate: five compose-project networks exist until `compose down` (or an
   *  explicit `network rm`) removes them. The io.gsp-label network listing stays EMPTY throughout
   *  — mirroring the real rendered compose, which is exactly why the old post-state message could
   *  only ever print zero. */
  function estateShim(initialNetworks: string[], opts: { failNetworkListing?: boolean } = {}) {
    let networks = [...initialNetworks]
    let downDone = false
    const invocations: string[][] = []
    const runner: DockerRunner = async (args) => {
      invocations.push([...args])
      const j = args.join(" ")
      if (j.includes("network ls --filter label=com.docker.compose.project")) {
        if (opts.failNetworkListing) return { exitCode: 1, stdout: "", stderr: "network ls denied (fixture)" }
        return { exitCode: 0, stdout: downDone ? "" : networks.join("\n"), stderr: "" }
      }
      if (j.includes(" compose ") && j.trimEnd().endsWith(" down")) {
        downDone = true
        networks = []
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (j.includes("network rm ")) {
        const id = args.at(-1) ?? ""
        networks = networks.filter((x) => x !== id)
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      return { exitCode: 0, stdout: "", stderr: "" } // io.gsp label listings (container/volume/image): nothing lingering
    }
    return { runner, invocations }
  }
  const FC_NETWORKS = ["swarm-tools_fc-edge", "swarm-tools_fc-ctl", "swarm-tools_fc-data", "swarm-tools_fc-web", "swarm-tools_fc-iso"]

  it("five networks removed by down are reported as FIVE, not zero (message + ledger)", async () => {
    const home = freshHome("teardown-count")
    stageArtefacts(home)
    writeSecrets(home, "firecrawl")
    const est = estateShim(FC_NETWORKS)
    const st = readyState("firecrawl")
    st.components.firecrawl = { state: STATES.HEALTHY }
    const kit = createStepKit({ componentId: "firecrawl", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await tearDown({ kit, plan: firecrawlPlan(home), run: est.runner })
    expect(out.token).toBe(OUTCOME.OK)
    expect(out.networksRemoved).toBe(5)
    expect(out.message).toContain("5 network(s) removed")
    expect(out.message).not.toContain("0 network(s)")
    const rows = readStackProvenanceRecords()
    expect(rows.at(-1)?.action).toBe("down") // completed removal keeps the bare verb
    expect(rows.at(-1)?.networksRemoved).toBe(5)
  })

  it("a compose-down failure writes a ledger row that ADMITS failure (the old code wrote none at all)", async () => {
    const home = freshHome("teardown-downfail")
    stageArtefacts(home)
    writeSecrets(home, "searxng")
    const shim = makeFakeDockerShim([
      { match: " compose ", exitCode: 1, stderr: "error while removing network: network is busy" },
    ])
    const st = readyState("searxng")
    st.components.searxng = { state: STATES.HEALTHY }
    const kit = createStepKit({ componentId: "searxng", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await tearDown({ kit, plan: searxngPlan(home), run: shim.runner })
    expect(out.token).toBe(OUTCOME.FAILED)
    expect(out.networksRemoved).toBeNull()
    const rows = readStackProvenanceRecords()
    expect(rows.length).toBe(1)
    expect(rows[0]?.action).toBe("down-incomplete")
    expect(rows[0]?.outcome).toBe("FAILED")
  })

  it("when the network listing fails the message SAYS unavailable instead of printing zero", async () => {
    const home = freshHome("teardown-unknown")
    stageArtefacts(home)
    writeSecrets(home, "firecrawl")
    const est = estateShim(FC_NETWORKS, { failNetworkListing: true })
    const st = readyState("firecrawl")
    st.components.firecrawl = { state: STATES.HEALTHY }
    const kit = createStepKit({ componentId: "firecrawl", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await tearDown({ kit, plan: firecrawlPlan(home), run: est.runner })
    expect(out.token).toBe(OUTCOME.OK) // the removal itself still happened; only the COUNT is unknowable
    expect(out.networksRemoved).toBeNull()
    expect(out.message).toContain("network count unavailable (listing failed)")
    expect(out.message).not.toContain("0 network(s)")
    const rows = readStackProvenanceRecords()
    expect(rows.at(-1)?.networksRemoved).toBeNull()
  })

  it("volume-deferral path also carries the truthful removal summary", async () => {
    const home = freshHome("teardown-deferred")
    stageArtefacts(home)
    writeSecrets(home, "firecrawl")
    let networks = [...FC_NETWORKS]
    let downDone = false
    const runner: DockerRunner = async (args) => {
      const j = args.join(" ")
      if (j.includes("network ls --filter label=com.docker.compose.project"))
        return { exitCode: 0, stdout: downDone ? "" : networks.join("\n"), stderr: "" }
      if (j.includes(" compose ") && j.trimEnd().endsWith(" down")) {
        downDone = true
        networks = []
        return { exitCode: 0, stdout: "", stderr: "" }
      }
      if (j.includes("volume ls")) return { exitCode: 0, stdout: "drift-vol", stderr: "" } // labelled drift -> ask
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    const st = readyState("firecrawl")
    st.components.firecrawl = { state: STATES.HEALTHY }
    const kit = createStepKit({ componentId: "firecrawl", lock: LOCK, state: st, dryRun: false, consentGate: () => true })
    const out = await tearDown({ kit, plan: firecrawlPlan(home), run: runner })
    expect(out.token).toBe(OUTCOME.SKIPPED_WITH_INSTRUCTIONS)
    expect(out.networksRemoved).toBe(5)
    expect(out.message).toContain("5 network(s) removed")
    expect(out.message).toContain("volumes hold possible data") // the P-14 ask survives the rewrite
    const rows = readStackProvenanceRecords()
    expect(rows.at(-1)?.action).toBe("down-incomplete") // deferred volumes = not a completed removal
    expect(rows.at(-1)?.deferredVolumes).toEqual(["drift-vol"])
  })
})
