// Row-93 unit tests for the spawn-backed DockerRunner (src/dockerRunner.real.ts).
//
// NO docker daemon, NO network, NO real process: the runner's spawn is injected as a SCRIPTED
// function that mirrors row 91's `makeFakeDockerShim` rule table, so the two runners can be driven
// over the SAME command sequences and compared element for element. That comparison IS the contract
// parity the brief demands ("unit with shim (contract parity)"): whatever row 91 proved offline must
// hold verbatim once the real runner drops in, because the argv row 91 builds is what both consume.
//
// Run TARGETED (row 102 owns the full suite):
//   cd packages/setup && bun test test/docker_runner_real.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OUTCOME } from "../src/outcomes.ts"
import { STATES, DOCKER_CONTEXT, COMPOSE_PROJECT } from "../src/constants.ts"
import { defaultState, type StateFile } from "../src/state.ts"
import { loadLock, type LockFile } from "../src/lockfile.ts"
import { createStepKit } from "../src/stepkit.ts"
import { renderAll, applyRenderedFiles } from "../src/composefiles/index.ts"
import { SECRET_INVENTORY } from "../src/composefiles/shared.ts"
import {
  bringUp,
  composeUpCmd,
  labelListArgs,
  makeFakeDockerShim,
  searxngPlan,
  type DockerResult,
} from "../src/stacklib.ts"
import {
  asText,
  DOCKER_BINARY_DEFAULT,
  makeRealDockerRunner,
  type SpawnFn,
  type SpawnOutput,
} from "../src/dockerRunner.real.ts"

type Rule = { match: string; exitCode?: number; stdout?: string; stderr?: string }

// A scripted spawn answering from the SAME rule shape the fake shim uses, so the two runners are
// fed identical fixtures. `argv` is the FULL spawned array (binary + subcommand); the matcher joins
// the subcommand tail (argv.slice(1)) so a rule written for the shim hits the real runner too.
function scriptedSpawn(rules: Rule[], calls: string[][]): SpawnFn {
  return (argv) => {
    calls.push([...argv])
    const joined = argv.slice(1).join(" ")
    for (const r of rules)
      if (joined.includes(r.match)) return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
}

// Source-run lock posture (same harness trick as rows 82/83/84/91): loadLock() falls back to
// import.meta.dir == src/ under `bun test`, so stage a copy of the shipped lock there for the run
// and remove it after — never leaves an untracked file behind.
const SHIPPED_LOCK = join(import.meta.dir, "..", "tools.lock.json")
const SRC_LOCK = join(import.meta.dir, "..", "src", "tools.lock.json")
let stagedLock = false
let LOCK: LockFile
let realHome = ""
let sandboxHome = ""

beforeAll(() => {
  // Sandbox the setup root so no state.json / setup.log write lands in the real user home.
  realHome = process.env.HOME ?? ""
  sandboxHome = mkdtempSync(join(tmpdir(), "r93-home-"))
  process.env.HOME = sandboxHome
  if (!existsSync(SRC_LOCK)) {
    copyFileSync(SHIPPED_LOCK, SRC_LOCK)
    stagedLock = true
  }
  const res = loadLock()
  if (!res.ok) throw new Error(res.error)
  LOCK = res.lock
})
afterAll(() => {
  if (stagedLock) rmSync(SRC_LOCK, { force: true })
  if (realHome) process.env.HOME = realHome
  rmSync(sandboxHome, { recursive: true, force: true })
})

function lock(): LockFile {
  return LOCK
}

// Stage a HOME whose searxng artefacts + required secrets satisfy checkPreconditions, exactly the
// way row 91 stages them (consume the r85 renderer; never re-render into ~/.swarm). bringUp reads
// secrets/artefacts through the ENV HOME (it calls checkPreconditions without a home override), so
// the staged home must BE process.env.HOME for the whole path to line up — the same contract row 91's
// shim-demo honors by exporting HOME to its staging dir.
function stagedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "r93-runner-"))
  process.env.HOME = home
  const lck = lock()
  const manifest = { searxng: {} as Record<string, "generated">, firecrawl: {} as Record<string, "generated"> }
  for (const c of ["searxng", "firecrawl"] as const)
    for (const s of SECRET_INVENTORY[c]) if (s.required) manifest[c][s.name] = "generated"
  applyRenderedFiles(renderAll(lck, { home, secrets: manifest }), `${home}/.swarm/tools`)
  const secrets = `${home}/.swarm/tools/searxng/secrets`
  mkdirSync(secrets, { recursive: true, mode: 0o700 })
  for (const s of SECRET_INVENTORY.searxng)
    if (s.required) writeFileSync(`${secrets}/${s.name}`, "0123456789abcdef0123456789abcdef\n", { mode: 0o600 })
  return home
}

function readyState(lck: LockFile): StateFile {
  const st = defaultState(lck.version)
  st.components.runtime = { state: STATES.HEALTHY }
  st.components.searxng = { state: STATES.CONFIGURED }
  return st
}

describe("asText — Bun.spawnSync piped-output normalisation (r87 note)", () => {
  it("passes through a string stream unchanged", () => {
    expect(asText("hello")).toBe("hello")
  })
  it("decodes a Uint8Array stream (Buffer comes back as bytes on bun 1.3.14)", () => {
    expect(asText(new TextEncoder().encode("docker 29.8.0"))).toBe("docker 29.8.0")
  })
  it("maps undefined to empty string", () => {
    expect(asText(undefined)).toBe("")
  })
})

describe("makeRealDockerRunner — interface contract (returns DockerResult, never rejects)", () => {
  it("prepends ONLY the absolute binary and leaves argv untouched", async () => {
    const calls: string[][] = []
    const r = makeRealDockerRunner({ dockerBinary: "/opt/homebrew/bin/docker", spawn: scriptedSpawn([], calls) })
    const res = await r.runner(["--context", DOCKER_CONTEXT, "info", "--format", "{{.ServerVersion}}"])
    expect(calls[0]).toEqual([
      "/opt/homebrew/bin/docker",
      "--context",
      DOCKER_CONTEXT,
      "info",
      "--format",
      "{{.ServerVersion}}",
    ])
    expect(res).toEqual<DockerResult>({ exitCode: 0, stdout: "", stderr: "" })
    expect(r.spawnedArgv[0]?.[0]).toBe("/opt/homebrew/bin/docker")
  })

  it("defaults to the arm64 brew docker path", async () => {
    const calls: string[][] = []
    const r = makeRealDockerRunner({ spawn: scriptedSpawn([], calls) })
    await r.runner(["info"])
    expect(calls[0]?.[0]).toBe(DOCKER_BINARY_DEFAULT)
  })

  it("resolves (never rejects) when the spawn throws (missing binary)", async () => {
    const throwing: SpawnFn = () => {
      throw new Error("ENOENT docker")
    }
    const r = makeRealDockerRunner({ spawn: throwing })
    const res = await r.runner(["info"]) // must NOT throw across row 91's await boundary
    expect(res.exitCode).toBe(127)
    expect(res.stderr).toContain("ENOENT docker")
  })

  it("maps a killed/timed-out child (exitCode null) to non-zero", async () => {
    const hang: SpawnFn = (): SpawnOutput => ({ exitCode: null, stdout: "", stderr: "killed" })
    const r = makeRealDockerRunner({ spawn: hang })
    const res = await r.runner(["compose", "up", "-d"])
    expect(res.exitCode).toBe(127)
    expect(res.stderr).toBe("killed")
  })

  it("executedCount / zeroExec / neverPrune mirror the fake shim semantics", async () => {
    const r = makeRealDockerRunner({ spawn: scriptedSpawn([], []) })
    expect(r.zeroExec()).toBe(true)
    expect(r.executedCount()).toBe(0)
    await r.runner(["container", "ls"])
    expect(r.executedCount()).toBe(1)
    expect(r.zeroExec()).toBe(false)
    expect(r.neverPrune()).toBe(true)
    await r.runner(["system", "prune"])
    expect(r.neverPrune()).toBe(false)
  })
})

describe("CONTRACT PARITY — real runner drives stacklib.bringUp identically to the fake shim", () => {
  const rules = (composeFile: string): Rule[] => {
    void composeFile // rules key off substrings present in every build; file name is incidental here
    return [
      { match: "context inspect", stdout: `${DOCKER_CONTEXT}\n` },
      { match: "up -d --pull never", stdout: "Network created\nContainer started\n" },
      { match: "ps --format", stdout: "searxng=running=healthy\nvalkey=running=healthy\n" },
      { match: "networks --format", stdout: "swarm-tools_se-int\nswarm-tools_se-edge\n" },
    ]
  }

  it("produces byte-identical formatted commands + same OK outcome through both runners", async () => {
    const lck = lock()
    const home = stagedHome()
    const plan = searxngPlan(home)

    // (A) the fake shim row 91 proved against.
    const shim = makeFakeDockerShim(rules(plan.composeFile))
    const kitShim = createStepKit({
      componentId: "searxng",
      lock: lck,
      state: readyState(lck),
      dryRun: false,
      consentGate: () => true,
    })
    const outShim = await bringUp({
      kit: kitShim,
      plan,
      run: shim.runner,
      sleep: async () => {},
      clock: (() => {
        let t = 0
        return () => (t += 1)
      })(),
    })

    // (B) the REAL runner with a scripted spawn, absolute binary pinned.
    const real = makeRealDockerRunner({
      dockerBinary: "/opt/homebrew/bin/docker",
      spawn: scriptedSpawn(rules(plan.composeFile), []),
    })
    const kitReal = createStepKit({
      componentId: "searxng",
      lock: lck,
      state: readyState(lck),
      dryRun: false,
      consentGate: () => true,
    })
    const outReal = await bringUp({
      kit: kitReal,
      plan,
      run: real.runner,
      sleep: async () => {},
      clock: (() => {
        let t = 0
        return () => (t += 1)
      })(),
    })

    rmSync(home, { recursive: true, force: true })

    expect(outReal.token).toBe(outShim.token)
    expect(outReal.token).toBe(OUTCOME.OK)
    // The command surface row 91 builds is what both consume: identical element for element.
    expect(real.formatted()).toEqual(shim.formatted())
    // Scoping survived into the spawn argv.
    const joined = real.formatted().join("\n")
    expect(joined).toContain(`--context ${DOCKER_CONTEXT}`)
    expect(joined).toContain(`-p ${COMPOSE_PROJECT}`)
    expect(joined).toContain("up -d --pull never")
    expect(real.neverPrune()).toBe(true)
  })

  it("health-gate timeout yields HEALTH_FAILED through the real runner exactly as through the shim", async () => {
    const lck = lock()
    const home = stagedHome()
    const plan = searxngPlan(home)
    const stall: Rule[] = [
      { match: "context inspect", stdout: `${DOCKER_CONTEXT}\n` },
      { match: "up -d", stdout: "" },
      { match: "ps --format", stdout: "searxng=running=starting\nvalkey=running=healthy\n" },
    ]
    const real = makeRealDockerRunner({ spawn: scriptedSpawn(stall, []) })
    const kit = createStepKit({
      componentId: "searxng",
      lock: lck,
      state: readyState(lck),
      dryRun: false,
      consentGate: () => true,
    })
    const out = await bringUp({
      kit,
      plan,
      run: real.runner,
      healthDeadlineMs: 10,
      healthIntervalMs: 1,
      sleep: async () => {},
      clock: (() => {
        let t = 0
        return () => (t += 5)
      })(),
    })
    rmSync(home, { recursive: true, force: true })
    expect(out.token).toBe(OUTCOME.HEALTH_FAILED)
  })

  it("label-scoped teardown commands reach the real spawn with no prune verb", async () => {
    const real = makeRealDockerRunner({ spawn: scriptedSpawn([{ match: "down", stdout: "" }], []) })
    // Directly exercise the builders the tearDown path spawns (row 91 owns tearDown logic; this proves
    // the runner forwards them verbatim with the absolute binary and never injects a prune).
    await real.runner(labelListArgs("container", "searxng"))
    await real.runner(composeUpCmd("/tmp/x.yml"))
    expect(real.neverPrune()).toBe(true)
    expect(real.spawnedArgv.every((a) => a[0] === DOCKER_BINARY_DEFAULT)).toBe(true)
    expect(real.invocations.some((a) => a.includes("prune"))).toBe(false)
  })
})
