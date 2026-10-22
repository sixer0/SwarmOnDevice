// Row 246 unit lane — the apply owner (src/estate/apply.ts) plus the configure-time lane write it
// puts into the shipped steps.
//
// NO real docker, NO network, NO real home: every test pins process.env.HOME at a mkdtemp sandbox
// and verifies the resolved path took effect before anything writes (rule E7 — the incident that
// rule encodes destroyed a user's state.json once). The daemon here is a SCRIPTED MODEL whose
// recreate decision the test supplies through `onUp`: what the model does is not a claim about
// Docker, it is the two arms the live measurement has to choose between (U-237-2 / U-266-2). The
// units therefore prove that apply REPORTS and GATES correctly under each arm; which arm this host
// is actually in is answered on the VM and recorded in implementation/s6b_d5_apply.md.
//
// What each describe pins:
//   scope          -> 06 §5.3 "one stack by label scope": one name or refuse, and the refusal binds
//                     nothing (E12: zero daemon calls, zero bytes moved)
//   E7 pin         -> apply refuses when the caller's pinned home is not the resolved home
//   refuse-first   -> 06 §4.2: an invalid lane file / poisoned pins / refused render / incomplete
//                     estate leave prior bytes, modes and directory entries untouched
//   pins refresh   -> producer spec §2.2 option (b): re-produce BEFORE renderAll, names taken from
//                     the stored file only (U-266-1: this row does not invent an allow-list), and a
//                     producer refusal aborts the whole apply
//   scoped writes  -> D-262-2's per-stack scope at the apply surface: only this stack's artefacts are
//                     written, the other stack's bytes are hash-frozen across the run
//   idempotence    -> content-addressed no-write (mtimes frozen on a second identical apply)
//   proof gate     -> 06 §5.3 "proves the value inside the running container": a container that
//                     contradicts the stored value fails the run, and an unreadable proof fails it
//                     too (E3: unobserved is never reported as passed)
//   argv discipline-> PC-PROF-02 pinned on every leg, no prune/down/rm verb anywhere (P-14)
//   configure-time -> 06 §2.3 + fork H: install creates lanes.json with the stored tuple, preserves
//                     an edited file byte-for-byte, and touches nothing under --dry-run
//   one home (r269)  -> this verb's commit loop is the shared primitive in src/estate/scoped_commit.ts:
//                     no re-inlined rule here, stepkit's `healthy` edge unwidened, and the four commit
//                     faults (unreadable target, mode-only drift, throw between writes, post-commit
//                     drift) refused with their shipped APPLY_* codes on THIS path
//
// Collected by the package's declared command (`bun test` from packages/setup) — rule E14.

import { describe, it, expect } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultState, type StateFile } from "../src/state.ts"
import { validateLock } from "../src/lockfile.ts"
import { createStepKit } from "../src/stepkit.ts"
import { homeDir } from "../src/paths.ts"
import { deliverEstate } from "../src/estate/deliver.ts"
import { APPLY_CODES, applyEstate, configureLanesAtSetup, type ApplyReport } from "../src/estate/apply.ts"
import { createLanesFileAtSetup, lanesPath, SETUP_LANE_VALUES } from "../src/composefiles/lanes.ts"
import { dnsPinsPath } from "../src/composefiles/dns_pins.ts"
import type { ResolveOutcome, Resolver } from "../src/mcpproxy/resolve.ts"
import { COMPOSE_PS_FORMAT, composeUpCmd, formatCmd, type DockerResult, type DockerRunner } from "../src/stacklib.ts"
import searxngStep from "../src/steps/searxng/index.ts"
import firecrawlStep from "../src/steps/firecrawl/index.ts"

const LOCK = (() => {
  const r = validateLock(JSON.parse(readFileSync(join(import.meta.dir, "..", "tools.lock.json"), "utf8")))
  if (!r.ok) throw new Error(`r246 test lock invalid: ${r.error}`)
  return r.lock
})()

const sha = (text: string): string => createHash("sha256").update(text).digest("hex")
const modeOf = (p: string): number => statSync(p).mode & 0o777
const toolsRootOf = (home: string): string => join(home, ".swarm", "tools")

/** E7-safe sandbox: pin HOME, VERIFY the resolved path took effect before the body may write, then
 *  restore. AWAITED on purpose: an async body that outlived the finally would have its sandbox
 *  deleted mid-flight (measured the hard way — every census came back empty), so the helper is
 *  async and every caller awaits it. */
async function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const saved = process.env.HOME
  const home = mkdtempSync(join(tmpdir(), "r246-"))
  process.env.HOME = home
  if (homeDir() !== home) {
    process.env.HOME = saved
    throw new Error(`E7: HOME pin did not take effect (homeDir()=${homeDir()})`)
  }
  try {
    return await fn(home)
  } finally {
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
}

function kitFor(component: "searxng" | "firecrawl", state: StateFile, dryRun = false) {
  return createStepKit({ componentId: component, lock: LOCK, state, dryRun })
}

/** Step context for the shipped install path. The docker runner is a silent fake: runnerGuard is
 *  FIRST in both steps, so without a runner the step refuses before it ever reaches the lane write,
 *  and the legs below would be proving nothing about the wiring they name. */
function stepCtx(home: string, dryRun = false) {
  const runner = async (): Promise<DockerResult> => ({ exitCode: 0, stdout: "", stderr: "" })
  return { lock: LOCK, state: defaultState(LOCK.version), dryRun, home, docker: runner } as never
}

/** A complete, delivered estate for one or both stacks — apply's precondition is a real estate. */
function deliveredHome(home: string, components: readonly ("searxng" | "firecrawl")[]): void {
  for (const c of components) {
    const res = deliverEstate({ kit: kitFor(c, defaultState(LOCK.version)), home })
    if (res.token !== "OK") throw new Error(`r246 fixture: delivery of ${c} refused: ${res.message}`)
  }
}

/** Snapshot of every file under ~/.swarm/tools plus the setup dir: path, sha, mode, mtime. */
function census(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const abs = join(dir, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.push(`${abs.slice(root.length + 1)} ${sha(readFileSync(abs, "utf8"))} ${modeOf(abs).toString(8)} ${statSync(abs).mtimeMs}`)
    }
  }
  walk(root)
  return out.sort()
}

// --- scripted daemon model ------------------------------------------------------------------

interface FakeContainer {
  created: string
  hash: string
  env: Record<string, string>
  running: boolean
  health?: string
}

interface DaemonModel {
  readonly runner: DockerRunner
  readonly calls: string[][]
  containers: Map<string, FakeContainer>
  /** Test-supplied answer to "what did compose do on this up leg?" — the arm under test. */
  onUp?: (daemon: DaemonModel) => void
  upExits?: number
  contextReachable?: boolean
  execReadable?: boolean
}

function makeDaemon(opts: { services: Record<string, FakeContainer> }): DaemonModel {
  const daemon: DaemonModel = {
    calls: [],
    containers: new Map(Object.entries(opts.services)),
    contextReachable: true,
    execReadable: true,
  }
  let generation = 0
  daemon.runner = async (args): Promise<DockerResult> => {
    daemon.calls.push([...args])
    const joined = args.join(" ")
    if (joined.includes("context inspect"))
      return daemon.contextReachable
        ? { exitCode: 0, stdout: "[{}]", stderr: "" }
        : { exitCode: 1, stdout: "", stderr: `context "colima-swarm" not found` }
    if (joined.includes(" up ")) {
      if (daemon.upExits && daemon.upExits !== 0) return { exitCode: daemon.upExits, stdout: "", stderr: "compose refused" }
      generation += 1
      daemon.onUp?.(daemon)
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    if (joined.includes("ps --format")) {
      const rows = [...daemon.containers.entries()].map(
        ([name, c]) => `${name}=${c.running ? "running" : "exited"}=${c.health ?? ""}=0`,
      )
      return { exitCode: 0, stdout: rows.join("\n"), stderr: "" }
    }
    if (joined.includes("{{.Created}}")) {
      const id = args[args.length - 1] as string
      const c = daemon.containers.get(id)
      if (!c) return { exitCode: 1, stdout: "", stderr: "no such container" }
      const envJson = JSON.stringify(Object.entries(c.env).map(([k, v]) => `${k}=${v}`))
      return { exitCode: 0, stdout: `${c.created} ${c.hash} ${envJson}\n`, stderr: "" }
    }
    if (joined.includes(" exec ")) {
      const id = args[args.indexOf("exec") + 1] as string
      const c = daemon.containers.get(id)
      if (!c) return { exitCode: 1, stdout: "", stderr: "no such container" }
      if (!daemon.execReadable || !c.running) return { exitCode: 1, stdout: "", stderr: "container not running" }
      return { exitCode: 0, stdout: Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join("\u0000"), stderr: "" }
    }
    return { exitCode: 0, stdout: "", stderr: "" }
  }
  // Exposed so onUp callbacks can mint distinguishable creation stamps.
  ;(daemon as unknown as { nextStamp: () => string }).nextStamp = () => `2026-10-22T0${generation + 1}:00:00Z`
  return daemon
}

function replace(daemon: DaemonModel, name: string, env: Record<string, string>, health?: string): void {
  const gen = (daemon.calls.filter((a) => a.join(" ").includes(" up ")).length + 1).toString()
  daemon.containers.set(name, { created: `2026-10-22T1${gen}:00:00Z`, hash: `hash-${name}-${gen}`, env, running: true, ...(health ? { health } : {}) })
}

const SEARXNG_CONTAINER = "swarm-tools-searxng-1"
const VALKEY_CONTAINER = "swarm-tools-valkey-1"
const API_CONTAINER = "swarm-tools-api-1"

/** A live searxng stack as the gate sees it: both declared services have containers, the one with a
 *  healthcheck (valkey, searxng.yml:73) reports healthy and the one without (searxng) is satisfied
 *  by the readiness seam. Without this the absence lane keeps the gate red for fixture reasons, not
 *  product ones. */
function liveSearxng(): Record<string, FakeContainer> {
  return {
    [SEARXNG_CONTAINER]: { created: "2026-10-20T00:00:00Z", hash: "hash-old-sx", env: { PATH: "/usr/bin" }, running: true },
    [VALKEY_CONTAINER]: { created: "2026-10-20T00:00:00Z", hash: "hash-old-vk", env: {}, running: true, health: "healthy" },
  }
}

/** SearXNG declares no healthcheck (searxng.yml:48 records why), so the gate needs a prober. */
const greenReadiness = async (): Promise<{ ok: boolean; detail: string }> => ({ ok: true, detail: "model probe" })

function applyOpts(home: string, daemon: DaemonModel, extra: Record<string, unknown> = {}) {
  // A monotone fake clock, one tick per call: the health gate's deadline must be reachable without
  // wall-clock sleeping. (Passing the FACTORY instead of the closure makes every comparison NaN and
  // the gate spins forever — measured, and it cost an hour.)
  let tick = 0
  const clock = () => (tick += 1)
  return {
    lock: LOCK,
    home,
    run: daemon.runner,
    readiness: greenReadiness,
    sleep: async () => {},
    clock,
    healthDeadlineMs: 50,
    healthIntervalMs: 1,
    ...extra,
  }
}

// --- 1. scope -------------------------------------------------------------------------------

describe("r246 scope: one stack by name, or nothing at all", () => {
  it("refuses a name that is not a stack without touching the daemon (E12: the refusal binds)", async () => {
    await withHome(async (home) => {
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: {} })
      const r = await applyEstate(applyOpts(home, daemon, { component: "graft" }))
      expect(r.ok).toBe(false)
      expect(r.code).toBe("APPLY_STACK_NAMED")
      expect(daemon.calls.length).toBe(0)
    })
  })

  it("refuses an empty scope the same way", async () => {
    await withHome(async (home) => {
      const daemon = makeDaemon({ services: {} })
      const r = await applyEstate(applyOpts(home, daemon, { component: "" }))
      expect(r.code).toBe("APPLY_STACK_NAMED")
      expect(daemon.calls.length).toBe(0)
    })
  })

  it("names both accepted stacks in the refusal so an operator learns the form", async () => {
    await withHome(async (home) => {
      const r = await applyEstate(applyOpts(home, makeDaemon({ services: {} }), { component: "firecrawl-searxng" }))
      expect(r.message).toContain("searxng, firecrawl")
    })
  })

  it("refuses when the caller's pinned home is not the resolved home (E7 guard)", async () => {
    await withHome(async (home) => {
      const daemon = makeDaemon({ services: {} })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng", home: "/nonexistent/pinned" }))
      expect(r.code).toBe("APPLY_HOME_UNPINNED")
      expect(daemon.calls.length).toBe(0)
    })
  })
})

// --- 2. refuse-first: prior bytes intact -----------------------------------------------------

describe("r246 refusal leaves the estate exactly as it found it (06 §4.2)", () => {
  function injectLanes(home: string, text: string): void {
    mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
    writeFileSync(lanesPath(home), text, { mode: 0o600 })
    chmodSync(lanesPath(home), 0o600)
  }

  it.each([
    ["out-of-range", JSON.stringify({ version: 1, lanes: { GRANIAN_BLOCKING_THREADS: 9 } }), "APPLY_LANES_INVALID", "LANE_VALUE_OUT_OF_RANGE"],
    ["not-a-lane", JSON.stringify({ version: 1, lanes: { NUM_WORKERS_PER_QUEUE: 6 } }), "APPLY_LANES_INVALID", "LANE_VALUE_NOT_A_LANE"],
    ["malformed", "{ this is not json", "APPLY_LANES_INVALID", "LANE_VALUE_MALFORMED"],
  ])("an invalid lane file (%s) refuses with %s and moves zero bytes", async (_label, text, _wantCode, wantToken) => {
    await withHome(async (home) => {
      deliveredHome(home, ["searxng"])
      const before = census(toolsRootOf(home))
      injectLanes(home, text as string)
      const daemon = makeDaemon({ services: {} })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(false)
      expect(r.code).toBe(_wantCode)
      expect(r.message).toContain(wantToken as string)
      expect(census(toolsRootOf(home))).toEqual(before)
      expect(daemon.calls.length).toBe(0)
    })
  })

  it("a poisoned stored pins file refuses the whole apply before any write", async () => {
    await withHome(async (home) => {
      deliveredHome(home, ["searxng"])
      mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
      writeFileSync(dnsPinsPath(home), "{ not json", { mode: 0o600 })
      const before = census(toolsRootOf(home))
      const daemon = makeDaemon({ services: {} })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.code).toBe("APPLY_PINS_INVALID")
      expect(census(toolsRootOf(home))).toEqual(before)
      expect(daemon.calls.length).toBe(0)
    })
  })

  it("an estate with no rendered artefact refuses with the shipped gap code and writes nothing", async () => {
    await withHome(async (home) => {
      mkdirSync(join(toolsRootOf(home), "searxng", "secrets"), { recursive: true, mode: 0o700 })
      writeFileSync(join(toolsRootOf(home), "searxng", "secrets", "secret_key"), "f".repeat(64) + "\n", { mode: 0o600 })
      chmodSync(join(toolsRootOf(home), "searxng", "secrets", "secret_key"), 0o600)
      const daemon = makeDaemon({ services: {} })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.code).toBe("APPLY_ARTEFACT_INCOMPLETE")
      expect(r.refusedGaps.length + (r.message.includes("ARTEFACT_MISSING") ? 1 : 0)).toBeGreaterThan(0)
      expect(r.message).toContain("ARTEFACT_MISSING")
      expect(daemon.calls.length).toBe(0)
    })
  })

  it("an unreachable context refuses AFTER committing artefacts but before any compose leg", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: {} })
      daemon.contextReachable = false
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.code).toBe("APPLY_CONTEXT_UNAVAILABLE")
      const composeLegs = daemon.calls.filter((a) => a.join(" ").includes(" up ") || a.join(" ").includes("ps --format"))
      expect(composeLegs.length).toBe(0)
    })
  })
})

// --- 3. happy path, scoping and argv discipline ----------------------------------------------

describe("r246 apply of the searxng stack (label/file scope, PC-PROF-02 pinned)", () => {
  it("recreates with the shipped bring-up argv shape and reports green", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: liveSearxng() })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { PATH: "/usr/bin", GRANIAN_BLOCKING_THREADS: "4" })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(true)
      const up = r.commands.find((c) => c.includes(" up ")) as string
      expect(up).toContain("--context colima-swarm")
      expect(up).toContain("-p swarm-tools")
      expect(up).toContain(join(toolsRootOf(home), "searxng", "compose", "searxng.yml"))
      expect(up).toContain("--pull never")
      expect(up).toEqual(formatCmd(composeUpCmd(join(toolsRootOf(home), "searxng", "compose", "searxng.yml"))))
    })
  })

  it("every daemon leg it issues is pinned to the swarm context and none carries a destructive verb (P-14)", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: liveSearxng() })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { GRANIAN_BLOCKING_THREADS: "4" })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(true)
      for (const call of daemon.calls) {
        const joined = call.join(" ")
        // Two shapes only: the pre-bring-up context probe (`docker context inspect <name>`, which
        // must NOT carry --context — H-R93-2 proved that prefix makes real docker reject it), and an
        // operation that pins PC-PROF-02 first. Anything else is out of contract.
        if (joined.startsWith("context inspect ")) expect(call[2]).toBe("colima-swarm")
        else expect(call.slice(0, 2)).toEqual(["--context", "colima-swarm"])
        expect(call.some((a) => a.includes("prune"))).toBe(false)
        expect(call.some((a) => a === "down" || a === "rm")).toBe(false)
        // Token-level, not substring-level: "colima-swarm" CONTAINS "colima", so a pattern test on
        // the joined string would flag the register name itself. The slice assertion above already
        // pins the context slot; this one catches a second context named anywhere else in argv.
        expect(call.filter((a) => a === "default" || a === "colima")).toEqual([])
      }
    })
  })

  it("writes only this stack's artefacts and leaves the other stack hash-frozen (D-262-2 scope)", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng", "firecrawl"])
      const fcBefore = listStack(toolsRootOf(home), "firecrawl")
      const sxBefore = listStack(toolsRootOf(home), "searxng")
      // Make the change real: clear the stored tuple so the environment block leaves searxng.yml.
      // (Rewriting the same values would be a no-op render and the write claim would be vacuous.)
      writeFileSync(lanesPath(home), JSON.stringify({ version: 1, lanes: {} }) + "\n", { mode: 0o600 })
      chmodSync(lanesPath(home), 0o600)
      const daemon = makeDaemon({ services: liveSearxng() })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { GRANIAN_BLOCKING_THREADS: "4" })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(true)
      expect(r.written).toEqual(["searxng/compose/searxng.yml"])
      expect(r.unchanged.sort()).toEqual(["searxng/searxng.env", "searxng/settings.yml"])
      expect(listStack(toolsRootOf(home), "firecrawl")).toEqual(fcBefore)
      expect(fcBefore.length).toBe(11) // 7 artefacts + 4 secrets: untouched, not merely unasserted
      expect(sxBefore.length).toBe(4)
    })
  })

  it("a second identical apply writes nothing and freezes every mtime", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: liveSearxng() })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { GRANIAN_BLOCKING_THREADS: "4" })
      const first = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(first.ok).toBe(true)
      await new Promise((r) => setTimeout(r, 30)) // a real clock gap: any rewrite would move an mtime
      const before = census(toolsRootOf(home))
      const second = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(second.ok).toBe(true)
      expect(second.written.length).toBe(0)
      expect(second.unchanged.length).toBe(3)
      expect(census(toolsRootOf(home))).toEqual(before)
    })
  })

  it("a compose-up refusal names the failure and never reaches the health gate", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: liveSearxng() })
      daemon.upExits = 17
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.code).toBe("APPLY_COMPOSE_UP_FAILED")
      // Exactly one ps leg survives: the BEFORE census that gives the report its recreate delta.
      // A second one would mean the health gate polled a stack compose never started.
      expect(daemon.calls.filter((a) => a.join(" ").includes("ps --format")).length).toBe(1)
    })
  })
})

// --- 4. the in-container proof is a gate ------------------------------------------------------

describe("r246 proof gate (06 §5.3: the value inside the running container)", () => {
  it("reports the observed value and the recreate delta for the applied control", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({
        services: { [SEARXNG_CONTAINER]: { created: "2026-10-20T00:00:00Z", hash: "hash-old", env: { PATH: "/usr/bin" }, running: true } },
      })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { PATH: "/usr/bin", GRANIAN_BLOCKING_THREADS: "4" })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      const row = r.proof.find((p) => p.container === SEARXNG_CONTAINER)
      expect(row?.laneValues.GRANIAN_BLOCKING_THREADS).toBe("4")
      expect(row?.recreated).toBe(true)
      expect(row?.created).not.toBe("2026-10-20T00:00:00Z")
    })
  })

  it("ARM B (compose ignores an env-only change): the same container still reports the old value, and apply FAILS rather than claims success", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({
        services: { [SEARXNG_CONTAINER]: { created: "2026-10-20T00:00:00Z", hash: "hash-old", env: { PATH: "/usr/bin" }, running: true } },
      })
      daemon.onUp = () => { /* the ignore arm: nothing is replaced */ }
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(false)
      expect(r.code).toBe("APPLY_NOT_APPLIED")
      expect(r.message).toContain("GRANIAN_BLOCKING_THREADS")
      expect(r.message).toContain("NOT replaced")
    })
  })

  it("an unreadable /proc/1/environ fails the run instead of reporting an unobserved value as applied (E3)", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: {} })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { GRANIAN_BLOCKING_THREADS: "4" })
      daemon.execReadable = false
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(false)
      expect(r.code).toBe("APPLY_PROOF_UNREADABLE")
      expect(r.message).toContain("unreadable")
    })
  })

  it("an unset control asks for no proof (06 §5.1 rule 4: absence is a legal state, not a failure)", async () => {
    await withHome(async (home) => {
      deliveredHome(home, ["searxng"])
      mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
      writeFileSync(lanesPath(home), JSON.stringify({ version: 1, lanes: {} }) + "\n", { mode: 0o600 })
      chmodSync(lanesPath(home), 0o600)
      const daemon = makeDaemon({ services: liveSearxng() })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(true)
      expect(r.proof.find((p) => p.container === SEARXNG_CONTAINER)?.recreated).toBe(false)
    })
  })
})

// --- 5. DNS-pin refresh (producer spec §2.2 option b) ------------------------------------------

describe("r246 DNS-pin refresh is the producer's own entry, over the STORED names only", () => {
  function seedPins(home: string, hostname: string, address: string): void {
    mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
    writeFileSync(
      dnsPinsPath(home),
      JSON.stringify({
        version: 1,
        generatedAt: "2026-10-21T00:00:00.000Z",
        pins: [{ hostname, address, answersSeen: [address], checkedAt: "2026-10-21T00:00:00.000Z" }],
      }) + "\n",
      { mode: 0o600 },
    )
    chmodSync(dnsPinsPath(home), 0o600)
  }

  it("with no stored pins file, refresh is a named no-op and no resolver is dialed", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      let dialed = 0
      const resolver: Resolver = async () => {
        dialed += 1
        return { ok: true, addresses: [] } satisfies ResolveOutcome
      }
      const daemon = makeDaemon({ services: {} })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { GRANIAN_BLOCKING_THREADS: "4" })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng", resolver }))
      expect(r.pinsRefresh.action).toBe("no-stored-pins")
      expect(dialed).toBe(0)
    })
  })

  it("re-produces exactly the stored names, before the render, and carries the answer into extra_hosts", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      seedPins(home, "api.example.com", "93.184.216.34")
      deliveredHome(home, ["firecrawl"])
      const asked: string[] = []
      const resolver: Resolver = async (hostname) => {
        asked.push(hostname)
        return { ok: true, addresses: ["203.0.113.7"] } satisfies ResolveOutcome
      }
      const daemon = makeDaemon({ services: {} })
      daemon.onUp = (d) => replace(d, API_CONTAINER, { NUQ_WORKER_COUNT: "5" })
      const r = await applyEstate(applyOpts(home, daemon, { component: "firecrawl", resolver }))
      expect(asked).toEqual(["api.example.com"]) // stored name only — this row invents no allow-list
      expect(r.pinsRefresh.action).toBe("written")
      const fc = readFileSync(join(toolsRootOf(home), "firecrawl", "compose", "firecrawl.yml"), "utf8")
      expect(fc).toContain("api.example.com:203.0.113.7") // the rotated answer reached the render
    })
  })

  it("a denied fresh answer refuses the whole apply with zero bytes moved and zero daemon calls", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      seedPins(home, "api.example.com", "93.184.216.34")
      deliveredHome(home, ["firecrawl"])
      const before = census(toolsRootOf(home))
      const resolver: Resolver = async () => ({ ok: true, addresses: ["127.0.0.1"] }) satisfies ResolveOutcome
      const daemon = makeDaemon({ services: {} })
      const r = await applyEstate(applyOpts(home, daemon, { component: "firecrawl", resolver }))
      expect(r.code).toBe("APPLY_PINS_REFRESH_FAILED")
      expect(r.message).toContain("PINS_DENIED_ANSWER")
      expect(census(toolsRootOf(home))).toEqual(before)
      expect(daemon.calls.length).toBe(0)
    })
  })

  it("a resolver error propagates as the same whole-run refusal", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      seedPins(home, "api.example.com", "93.184.216.34")
      deliveredHome(home, ["firecrawl"])
      const resolver: Resolver = async () => ({ ok: false, error: "EAI_AGAIN api.example.com" }) satisfies ResolveOutcome
      const r = await applyEstate(applyOpts(home, makeDaemon({ services: {} }), { component: "firecrawl", resolver }))
      expect(r.code).toBe("APPLY_PINS_REFRESH_FAILED")
      expect(r.message).toContain("PINS_RESOLVE_FAILED")
    })
  })
})

// --- 6. configure-time creation (06 §2.3 + fork H) --------------------------------------------

describe("r246 configure-time creation reaches the shipped flow", () => {
  it("install of the searxng step creates lanes.json with the fork-H tuple", async () => {
    await withHome(async (home) => {
      const res = await searxngStep.install(stepCtx(home))
      expect(res.token).toBeDefined() // delivery may refuse on its own gates; the write is what is under test here
      const text = readFileSync(lanesPath(home), "utf8")
      expect(JSON.parse(text).lanes).toEqual({ ...SETUP_LANE_VALUES })
      expect(modeOf(lanesPath(home))).toBe(0o600)
      expect(modeOf(join(home, ".swarm", "setup"))).toBe(0o700)
    })
  })

  it("install of the firecrawl step creates it too, and a second install preserves an edited file byte-for-byte", async () => {
    await withHome(async (home) => {
      const first = await firecrawlStep.install(stepCtx(home))
      expect(first.token).toBeDefined()
      const edited = JSON.stringify({ version: 1, updatedAt: "2026-10-22T00:00:00Z", lanes: { NUQ_WORKER_COUNT: 4 } }) + "\n"
      writeFileSync(lanesPath(home), edited, { mode: 0o600 })
      chmodSync(lanesPath(home), 0o600)
      const before = { sha: sha(readFileSync(lanesPath(home), "utf8")), mode: modeOf(lanesPath(home)) }
      await firecrawlStep.install(stepCtx(home))
      expect(sha(readFileSync(lanesPath(home), "utf8"))).toBe(before.sha)
      expect(modeOf(lanesPath(home))).toBe(before.mode)
    })
  })

  it("a dry-run install creates nothing at all (PC-FLAG-03: touch nothing)", async () => {
    await withHome(async (home) => {
      await searxngStep.install(stepCtx(home, true))
      expect(existsSync(lanesPath(home))).toBe(false)
    })
  })

  it("the helper reports created vs kept, and repairs a drifted setup-dir mode", async () => {
    await withHome((home) => {
      const lines: string[] = []
      const log = (level: string, message: string) => lines.push(`${level} ${message}`)
      mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o755 })
      chmodSync(join(home, ".swarm", "setup"), 0o755)
      const first = configureLanesAtSetup({ log: log as never })
      expect(first.created).toBe(true)
      expect(modeOf(join(home, ".swarm", "setup"))).toBe(0o700)
      expect(lines.some((l) => l.includes("755 -> 700") && l.includes("repaired to 0700"))).toBe(true)
      const second = configureLanesAtSetup({ log: log as never })
      expect(second.created).toBe(false)
      expect(lines.at(-1)).toContain("left byte-identical")
    })
  })

  it("the render that follows the write carries the stored values into literals (row 245's renderer, called from the shipped flow)", async () => {
    await withHome(async (home) => {
      await firecrawlStep.install(stepCtx(home))
      const fc = join(toolsRootOf(home), "firecrawl", "compose", "firecrawl.yml")
      if (!existsSync(fc)) return // delivery refused before rendering; the write-side legs above cover this home
      const text = readFileSync(fc, "utf8")
      expect(text).toContain('NUQ_WORKER_COUNT: "5"')
      expect(text).toContain('MAX_CONCURRENT_PAGES: "4"')
    })
  })
})

// --- 7. vocabulary freeze ---------------------------------------------------------------------

describe("r246 refusal vocabulary is a closed set", () => {
  it("carries exactly the fourteen codes this row ships, so widening needs a ruling", () => {
    expect(APPLY_CODES.length).toBe(14)
    expect([...APPLY_CODES].sort()).toEqual(
      [
        "APPLY_ARTEFACT_INCOMPLETE",
        "APPLY_COMPOSE_UP_FAILED",
        "APPLY_CONTEXT_UNAVAILABLE",
        "APPLY_HEALTH_FAILED",
        "APPLY_HOME_UNPINNED",
        "APPLY_LANES_INVALID",
        "APPLY_NOT_APPLIED",
        "APPLY_PINS_INVALID",
        "APPLY_PINS_REFRESH_FAILED",
        "APPLY_PROOF_UNREADABLE",
        "APPLY_RENDER_REFUSED",
        "APPLY_STACK_NAMED",
        "APPLY_VERIFY_MISMATCH",
        "APPLY_WRITE_FAILED",
      ].sort(),
    )
  })

  it("a report always names its stack, its compose file and every command it issued", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const daemon = makeDaemon({ services: {} })
      daemon.onUp = (d) => replace(d, SEARXNG_CONTAINER, { GRANIAN_BLOCKING_THREADS: "4" })
      const r: ApplyReport = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.stack).toBe("searxng")
      expect(r.composeFile).toBe(join(toolsRootOf(home), "searxng", "compose", "searxng.yml"))
      expect(r.commands.length).toBeGreaterThan(1)
      expect(COMPOSE_PS_FORMAT).toContain("{{.ExitCode}}")
    })
  })
})

function listStack(root: string, component: string): string[] {
  const dir = join(root, component)
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const abs = join(d, name)
      if (statSync(abs).isDirectory()) walk(abs)
      else out.push(`${abs.slice(root.length + 1)} ${sha(readFileSync(abs, "utf8"))}`)
    }
  }
  walk(dir)
  return out.sort()
}

// --- 8. r269: this verb's commit loop is the shared primitive --------------------------------------

/** The commit rules row 252 §Q1 found written twice. Each has exactly one declaration now, in
 *  src/estate/scoped_commit.ts; if this file ever re-inlines one, the first test below reddens.
 *  (The same guard list exists in estate_delivery.test.ts for its own caller — a knowingly duplicated
 *  three lines, because a shared test helper would mean a new file outside row 269's area. Routed to
 *  the same owner as Q6.2's `withHome` triplication.) */
const SHARED_RULE_DECLARATIONS = [
  "function sha256(",
  "function fileMode(",
  "function declareRequiredSlots(",
  "function isUnchanged(",
  "function commitScoped(",
  "function sameBytesOnDisk(",
  "function rollback(",
  "atomicWriteText(",
] as const

const readEstateSrc = (name: string): string => readFileSync(join(import.meta.dir, "..", "src", "estate", name), "utf8")
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1
const moduleSpecifiers = (src: string): string[] => [...src.matchAll(/from "([^"]+)"/g)].map((m) => m[1] as string)

describe("r269 the scoped commit loop has one home (row 252 Q1, R-246-2)", () => {
  it("this verb declares no commit rule of its own any more", () => {
    const applySrc = readEstateSrc("apply.ts")
    const offenders = SHARED_RULE_DECLARATIONS.filter((declaration) => applySrc.includes(declaration))
    expect(offenders).toEqual([])
    expect(applySrc).toContain('from "./scoped_commit.ts"')
  })

  it("the primitive declares each shared rule once, and deliver imports the same module", () => {
    const primitive = readEstateSrc("scoped_commit.ts")
    const rules = [
      "export function sha256(",
      "export function fileMode(",
      "export function declareRequiredSlots(",
      "export function artefactMatchesDisk(",
      "export function planScopedCommit(",
      "function isUnchanged(",
      "function writeUnit(",
      "function verifyUnits(",
      "export function rollbackScopedUnits(",
    ]
    const miscounted = rules.map((rule) => `${rule} declared ${occurrences(primitive, rule)}x`).filter((line) => !line.endsWith("declared 1x"))
    expect(miscounted).toEqual([])
    expect(readEstateSrc("deliver.ts")).toContain('from "./scoped_commit.ts"')
  })

  it("apply still commits no lifecycle state — the primitive never saw a kit", () => {
    const applySrc = readEstateSrc("apply.ts")
    const primitive = readEstateSrc("scoped_commit.ts")
    // The ruling's whole point: sharing the commit loop must not smuggle the state walk or the ledger
    // into apply, and must not give the primitive a lifecycle vocabulary of its own. Module specifiers
    // are the honest instrument here — a token search would trip on the comments that argue this.
    expect(moduleSpecifiers(primitive).sort()).toEqual(["../atomic.ts", "../composefiles/shared.ts", "node:crypto", "node:fs"])
    expect(moduleSpecifiers(applySrc).filter((m) => /stepkit|outcomes|estate\/ledger/.test(m))).toEqual([])
  })
})

describe("r269 apply refuses what the shared primitive refuses (codes unchanged)", () => {
  it("an existing target that cannot be read refuses with APPLY_WRITE_FAILED and binds nothing (E12)", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const squatted = join(toolsRootOf(home), "searxng", "settings.yml")
      rmSync(squatted)
      mkdirSync(squatted, { recursive: true }) // a DIRECTORY on the artefact's name: EISDIR on read
      const before = census(toolsRootOf(home))
      const daemon = makeDaemon({ services: liveSearxng() })
      const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
      expect(r.ok).toBe(false)
      expect(r.code).toBe("APPLY_WRITE_FAILED")
      // Parity anchor: this phrase is produced by exactly one function in the package, and
      // estate_delivery.test.ts asserts the identical phrase from DELIVER_TARGET_UNWRITABLE.
      expect(r.message).toContain("existing target unreadable (")
      expect(r.message).toContain("rolled back 0 path(s)")
      expect(census(toolsRootOf(home))).toEqual(before)
      expect(daemon.calls.length).toBe(0) // the refusal happened before the first docker leg
    })
  })

  it("a mode-only drift under an unwritable directory refuses, freezing every byte and mtime", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const composeDir = join(toolsRootOf(home), "searxng", "compose")
      const yml = join(composeDir, "searxng.yml")
      chmodSync(yml, 0o600) // drift: the render wants 0644, so R-262-1 says this MUST be rewritten
      chmodSync(composeDir, 0o500) // ...and its directory now refuses the atomic rename
      const before = census(toolsRootOf(home))
      try {
        const daemon = makeDaemon({ services: liveSearxng() })
        const r = await applyEstate(applyOpts(home, daemon, { component: "searxng" }))
        expect(r.code).toBe("APPLY_WRITE_FAILED")
        expect(r.message).toContain("rolled back 0 path(s)") // the restore refused too — counted honestly
        expect(census(toolsRootOf(home))).toEqual(before)
        expect(daemon.calls.length).toBe(0)
      } finally {
        chmodSync(composeDir, 0o700)
        chmodSync(yml, 0o644)
      }
    })
  })

  it("a throw between writes restores the planted prior through the shared rollback", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const yml = join(toolsRootOf(home), "searxng", "compose", "searxng.yml")
      writeFileSync(yml, "OLD PLANTED BYTES\n", { mode: 0o644 })
      const daemon = makeDaemon({ services: liveSearxng() })
      const r = await applyEstate(
        applyOpts(home, daemon, {
          component: "searxng",
          disturbWrite: (absPath: string) => {
            if (absPath === yml) throw new Error("simulated ENOSPC between writes")
          },
        }),
      )
      expect(r.ok).toBe(false)
      expect(r.code).toBe("APPLY_WRITE_FAILED")
      expect(r.message).toContain("simulated ENOSPC between writes")
      expect(r.message).toContain("rolled back 1 path(s)")
      expect(readFileSync(yml, "utf8")).toBe("OLD PLANTED BYTES\n")
      expect(daemon.calls.length).toBe(0)
    })
  })

  it("bytes that drift after the commit are caught by the shared read-back verify", async () => {
    await withHome(async (home) => {
      createLanesFileAtSetup(home)
      deliveredHome(home, ["searxng"])
      const yml = join(toolsRootOf(home), "searxng", "compose", "searxng.yml")
      writeFileSync(yml, "OLD PLANTED BYTES\n", { mode: 0o644 })
      const daemon = makeDaemon({ services: liveSearxng() })
      const r = await applyEstate(
        applyOpts(home, daemon, {
          component: "searxng",
          disturbWrite: (absPath: string) => {
            if (absPath === yml) writeFileSync(absPath, `${readFileSync(absPath, "utf8")}CORRUPTED`, { mode: 0o644 })
          },
        }),
      )
      expect(r.ok).toBe(false)
      expect(r.code).toBe("APPLY_VERIFY_MISMATCH")
      expect(r.message).toContain("sha256 differs from plan")
      expect(r.message).toContain("rolled back 1 path(s)")
      expect(readFileSync(yml, "utf8")).toBe("OLD PLANTED BYTES\n") // the shared rollback undid the drift
      expect(daemon.calls.length).toBe(0)
    })
  })
})
