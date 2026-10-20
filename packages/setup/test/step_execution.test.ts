// Seam pass 8 — unit lane for the step-execution wiring in src/index.ts (finding R113-1).
//
// WHAT THIS LANE PROVES (dispatch expectations a/c/d, source level):
//  (a) the engine's topological order is honoured by the dispatcher (listing itself is proven
//      end-to-end by r81-fix2 / proofs.sh PROOF 7 and re-shown here at module level);
//  (c)+(d) failure honesty: a refusing step yields FAILED, a mixed run reports the most severe
//      token, and the shipped defect's fingerprint — a consented run terminating in the
//      "step execution is owned by" placeholder — is pinned OUT of the source forever.
//
// NO network anywhere: every dispatched module here is a test-authored fake through the
// `modules` parameter, which can only OBSERVE dispatch or make it stricter — it cannot grant
// consent or weaken a gate (the narrowing discipline of r82 allowedHosts / r83 ask / r84 seams).
// The real-registry path is exercised separately by step_execution.proofs.sh against the
// COMPILED binary and row 108's mock-release-server shape.
//
// Run TARGETED (row 102 owns the full suite):
//   cd packages/setup && bun test test/step_execution.test.ts

import { describe, it, expect, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolateSourceLock } from "./lockPosture.ts"
import { executeSteps, main, type StepExecutionReport } from "../src/index.ts"
import { discoverSteps, discoverStepsFromRegistry, orderSteps, type StepDescriptor } from "../src/steps.ts"
import { GENERATED_DESCRIPTORS, GENERATED_MODULES, GENERATED_MODULES_BY_ID } from "../src/steps.gen.ts"
import { evaluateConsent, consentWasGranted } from "../src/consent.ts"
import { loadLock } from "../src/lockfile.ts"
import { defaultState } from "../src/state.ts"
import { OUTCOME, exitCodeFor, type OutcomeToken } from "../src/outcomes.ts"
import { COMPONENT_IDS, PROGRAM_NAME, type ComponentId } from "../src/constants.ts"
import type { StepContext } from "../src/steps/_template/index.ts"

let releaseLockPosture: (() => void) | undefined
const homes: string[] = []

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
})
afterAll(() => {
  releaseLockPosture?.()
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

function freshHome(label: string): string {
  const home = mkdtempSync(join(tmpdir(), `swarm-seam8-${label}-`))
  process.env.HOME = home
  homes.push(home)
  return home
}

function ctx(): StepContext {
  const loaded = loadLock()
  if (!loaded.ok) throw new Error(`loadLock failed in test setup: ${loaded.error}`)
  return { lock: loaded.lock, state: defaultState(loaded.lock.version), dryRun: false }
}

function desc(id: ComponentId, order: number, requires: readonly ComponentId[] = []): StepDescriptor {
  return { id, order, requires }
}

/** Test-authored modules keyed by id; records the exact execution sequence. */
function fakeModules(behaviour: Partial<Record<ComponentId, OutcomeToken>>) {
  const executed: ComponentId[] = []
  const modules = Object.fromEntries(
    (Object.keys(behaviour) as ComponentId[]).map((id) => [
      id,
      {
        id,
        install(_ctx: StepContext) {
          executed.push(id)
          return { token: behaviour[id] as OutcomeToken, message: `fake ${id}` }
        },
      },
    ]),
  ) as unknown as Record<ComponentId, { install(ctx: StepContext): { token: OutcomeToken } }>
  return { modules, executed }
}

describe("(seam8-a) dispatcher honours the engine's topological order", () => {
  it("runs dependents after their prerequisites regardless of input order", async () => {
    freshHome("order")
    const { modules, executed } = fakeModules({ runtime: OUTCOME.OK, node: OUTCOME.OK, graft: OUTCOME.OK })
    // Deliberately unsorted input: orderSteps must still produce runtime -> node -> graft.
    const ordered = orderSteps([desc("graft", 30, ["node"]), desc("node", 20), desc("runtime", 10)])
    if (!ordered.ok) throw new Error(ordered.error)
    const report = await executeSteps(ordered.ordered, ctx(), modules)
    expect(executed).toEqual(["runtime", "node", "graft"])
    expect(report.executions.map((e) => e.id)).toEqual(["runtime", "node", "graft"])
    expect(report.token).toBe(OUTCOME.OK)
    expect(exitCodeFor(report.token)).toBe(0)
  })

  it("keeps the seven-step order identical across disk scan and embedded registry", () => {
    const disk = discoverSteps()
    expect(disk.errors).toEqual([])
    const registry = discoverStepsFromRegistry()
    const fromDisk = orderSteps(disk.steps)
    const fromRegistry = orderSteps(registry.steps)
    if (!fromDisk.ok || !fromRegistry.ok) throw new Error("ordering failed")
    // The exact order r81-fix2 proved on the compiled binary (s81_setup_skeleton.md FIX ROUND 2):
    const expected = ["runtime", "node", "graft", "rtk", "obsidian", "searxng", "firecrawl"]
    expect(fromDisk.ordered.map((s) => s.id)).toEqual(expected)
    expect(fromRegistry.ordered.map((s) => s.id)).toEqual(expected)
  })
})

describe("(seam8-c) failure path stays honest", () => {
  it("a refusing step yields FAILED with exit code 1", async () => {
    freshHome("refuse")
    const { modules } = fakeModules({ node: OUTCOME.FAILED })
    const report = await executeSteps([desc("node", 20)], ctx(), modules)
    expect(report.token).toBe(OUTCOME.FAILED)
    expect(exitCodeFor(report.token)).toBe(1)
    expect(report.executions[0]?.message).toContain("fake node")
  })

  it("a blocked-network step yields BLOCKED_BY_NETWORK (exit 1), not a silent OK", async () => {
    freshHome("blocked")
    const { modules } = fakeModules({ node: OUTCOME.BLOCKED_BY_NETWORK })
    const report = await executeSteps([desc("node", 20)], ctx(), modules)
    expect(report.token).toBe(OUTCOME.BLOCKED_BY_NETWORK)
    expect(exitCodeFor(report.token)).toBe(1)
  })

  it("one failed optional component does not stop the others (01c §8 P-15)", async () => {
    freshHome("continue")
    const { modules, executed } = fakeModules({ node: OUTCOME.FAILED, rtk: OUTCOME.OK })
    const report = await executeSteps([desc("node", 20), desc("rtk", 40)], ctx(), modules)
    expect(executed).toEqual(["node", "rtk"]) // the sibling still ran
    expect(report.token).toBe(OUTCOME.FAILED) // and the run still reports the failure
    expect(exitCodeFor(report.token)).toBe(1)
  })

  it("mixed severities report the MOST SEVERE token, never a diluted average", async () => {
    freshHome("mixed")
    const { modules } = fakeModules({
      node: OUTCOME.OK,
      rtk: OUTCOME.SKIPPED,
      graft: OUTCOME.HEALTH_FAILED,
      obsidian: OUTCOME.FAILED,
    })
    const report = await executeSteps(
      [desc("node", 20), desc("graft", 30), desc("rtk", 40), desc("obsidian", 50)],
      ctx(),
      modules,
    )
    expect(report.token).toBe(OUTCOME.FAILED)
    const okAndSkipOnly = await executeSteps([desc("node", 20), desc("rtk", 40)], ctx(), {
      node: { id: "node", install: () => ({ token: OUTCOME.OK }) },
      rtk: { id: "rtk", install: () => ({ token: OUTCOME.SKIPPED }) },
    } as never)
    expect(okAndSkipOnly.token).toBe(OUTCOME.SKIPPED)
    expect(exitCodeFor(okAndSkipOnly.token)).toBe(0)
  })

  it("a step id with no dispatchable module is FAILED, never silently skipped", async () => {
    freshHome("missing-module")
    const report: StepExecutionReport = await executeSteps([desc("graft", 30)], ctx(), {} as never)
    expect(report.token).toBe(OUTCOME.FAILED)
    expect(report.executions[0]?.message).toContain("no dispatchable step module")
  })

  it("a throwing step maps to a named FAILED outcome instead of escaping", async () => {
    freshHome("throws")
    const boom = {
      node: {
        id: "node",
        install: () => {
          throw new Error("simulated step crash")
        },
      },
    }
    const report = await executeSteps([desc("node", 20)], ctx(), boom as never)
    expect(report.token).toBe(OUTCOME.FAILED)
    expect(report.executions[0]?.message).toContain("simulated step crash")
  })
})

describe("(seam8-d) REGRESSION PIN — the shipped R113-1 defect must not return", () => {
  // Row 113 proved from the archive binary (sha256 cb843b07bd…, verification/09_preinstall_security.md
  // §8.1) that a CONSENTED run printed "step execution is owned by rows 86-90" and returned FAILED.
  // This pin asserts the placeholder state cannot be reached again from the entry source.
  const PLACEHOLDER_PHRASES = ["step execution is owned by", "which install nothing yet", "would run step:"] as const

  it("src/index.ts contains none of the placeholder strings the shipped binary carried", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
    for (const phrase of PLACEHOLDER_PHRASES) {
      expect(source.includes(phrase)).toBe(false)
    }
  })

  it("the post-consent branch actually calls the dispatcher (not a print-and-fail)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
    const consentLine = source.indexOf("evaluateConsent({")
    const dispatchCall = source.indexOf("await executeSteps(", consentLine)
    expect(consentLine).toBeGreaterThan(-1)
    expect(dispatchCall).toBeGreaterThan(consentLine)
    // And the dispatch surface is real: every register component resolves to an embedded module.
    for (const id of COMPONENT_IDS) {
      expect(typeof (GENERATED_MODULES_BY_ID[id] as { install?: unknown }).install).toBe("function")
    }
    expect(GENERATED_MODULES.length).toBe(COMPONENT_IDS.length)
    expect(GENERATED_DESCRIPTORS.length).toBe(COMPONENT_IDS.length)
  })

  it("a consented run does not terminate in FAILED-by-placeholder (grant-in-effect feeds the gate)", async () => {
    // Drives the REAL consent decision (interactive seam answers 'y' for node only — the same
    // narrowing seam row 83 shipped), then asserts the download gate is open for exactly that
    // component: the precondition for any step execution. Pre-fix, this state printed the
    // placeholder and returned FAILED; now cmdInstall dispatches (proven end-to-end against the
    // compiled binary by step_execution.proofs.sh SCENARIO=install-ok).
    freshHome("consented")
    const loaded = loadLock()
    if (!loaded.ok) throw new Error(loaded.error)
    const result = evaluateConsent({
      selected: ["node"],
      nonInteractive: false,
      tokens: {},
      lock: loaded.lock,
      ask: (prompt) => (prompt.includes("node") ? "y" : "n"),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.consented).toEqual(["node"])
    expect(consentWasGranted("node")).toBe(true)
    expect(consentWasGranted("rtk")).toBe(false) // grant-in-effect stays per-component (M4)
    // A consented pipeline of one real module resolves AND dispatches without the placeholder:
    const ordered = orderSteps(discoverSteps().steps.filter((s) => s.id === "node"))
    if (!ordered.ok) throw new Error(ordered.error)
    const report = await executeSteps(ordered.ordered, ctx(), {
      node: { id: "node", install: () => ({ token: OUTCOME.OK, message: "dispatch reached" }) },
    } as never)
    expect(report.token).toBe(OUTCOME.OK)
    expect(report.executions[0]?.message).toBe("dispatch reached")
  })
})

describe("(seam8-surface) entry module import posture", () => {
  it("index.ts imports as a module without firing a CLI run (import.meta.main guard)", async () => {
    // Reaching this test AT ALL proves the guard: importing ../src/index.ts did not call
    // process.exit. Assert the exported surface is callable-typed rather than side-effecting.
    expect(typeof main).toBe("function")
    expect(typeof executeSteps).toBe("function")
    expect(PROGRAM_NAME).toBe("swarm-setup")
  })
})
