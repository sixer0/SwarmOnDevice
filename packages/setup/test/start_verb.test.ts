// Row 92a (Swarm 1.2.6, OFF-04 / N-153): the start-only verb `swarm-setup start <runtime|searxng|firecrawl>`.
// Spec: masterplan/01c_spec_u7_tool_health.md §4.7 (contract) and §11.8 (this file's cases 1-7).
//
// What the verb may do, and nothing more: read state, `colima list --json`, an optional FLAGLESS
// `colima start --profile swarm --activate=false`, poll `docker --context <observed> info`, and
// `docker --context <observed> compose -p swarm-tools -f <tools>/<id>/compose/<id>.yml start`.
// It never runs up / create / pull / install / --force-recreate, never writes tools.lock.json, never
// writes a state transition, and appends exactly one audit.jsonl line per invocation.
//
// Every case runs against a scripted fake runner (no process is spawned) and a throwaway HOME.
// Run TARGETED: cd packages/setup && bun test test/start_verb.test.ts   (with XDG_* unset)

import { describe, it, expect, beforeAll, afterAll, beforeEach, spyOn } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolateSourceLock } from "./lockPosture.ts"
import { scriptedRunner } from "../src/steps/runtime/commands.ts"
import { defaultState, writeState } from "../src/state.ts"
import { STATES, type ComponentId } from "../src/constants.ts"
import { resolveLockFile, stateFile } from "../src/paths.ts"
import { parseArgs } from "../src/cli.ts"
import { main, usageText } from "../src/index.ts"
import { runStart, START_CODES } from "../src/estate/start.ts"

const REAL_HOME = process.env.HOME
const REAL_AUDIT = process.env.SWARM_SETUP_AUDIT_LOG
const homes: string[] = []
let releaseLockPosture: (() => void) | undefined

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
})

afterAll(() => {
  releaseLockPosture?.()
  process.env.HOME = REAL_HOME
  if (REAL_AUDIT === undefined) delete process.env.SWARM_SETUP_AUDIT_LOG
  else process.env.SWARM_SETUP_AUDIT_LOG = REAL_AUDIT
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.SWARM_SETUP_AUDIT_LOG // the audit line must land in <HOME>/.swarm/setup/audit.jsonl
  const h = mkdtempSync(join(tmpdir(), "swarm-r92a-"))
  homes.push(h)
  process.env.HOME = h
})

const COLIMA = "/fake/bin/colima"
const DOCKER = "/fake/bin/docker"
const FORBIDDEN = /(^|\s)(up|create|pull|install|--force-recreate|--cpus|--memory|--disk|--vm-type|delete|rm|down)(\s|$)/

function seedState(states: Partial<Record<ComponentId, string>>, context?: string): void {
  const st = defaultState("test")
  for (const [id, value] of Object.entries(states)) {
    st.components[id as ComponentId] = { state: value as never }
  }
  if (context) st.components.runtime = { ...st.components.runtime, dockerObjects: [{ kind: "context", id: context } as never] }
  writeState(st)
}

function fake(opts: { profile?: "Running" | "Stopped" | "absent"; infoOk?: boolean; compose?: "ok" | "missing" | "fail" }) {
  const profile = opts.profile ?? "Stopped"
  const listOut = profile === "absent" ? `{"name":"default","status":"Running"}` : `{"name":"swarm","status":"${profile}"}`
  const compose =
    opts.compose === "missing"
      ? { result: { exitCode: 1, stderr: 'service "searxng" has no container to start' } }
      : opts.compose === "fail"
        ? { result: { exitCode: 1, stderr: "Cannot connect to the Docker daemon" } }
        : { result: { exitCode: 0 } }
  // First prefix match wins, so the compose rules sit before the generic `docker --context` (info) rule.
  return scriptedRunner([
    { match: `${COLIMA} list --json`, stdout: listOut },
    { match: `${COLIMA} start`, result: { exitCode: 0 } },
    { match: `${DOCKER} --context colima-swarm compose`, ...compose },
    { match: `${DOCKER} --context observed-ctx compose`, ...compose },
    { match: `${DOCKER} --context`, result: { exitCode: opts.infoOk === false ? 1 : 0 } },
  ])
}

function start(component: string, runner: ReturnType<typeof scriptedRunner>) {
  let t = 0
  return runStart({
    component,
    runner,
    colimaPath: COLIMA,
    dockerPath: DOCKER,
    pollMs: 5_000,
    waitMs: 180_000,
    sleep: (ms) => {
      t += ms
    },
    now: () => t,
  })
}

function auditLines(): Record<string, unknown>[] {
  const p = join(process.env.HOME as string, ".swarm", "setup", "audit.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

function assertNeverInstalls(calls: readonly string[]): void {
  for (const c of calls) expect(c).not.toMatch(FORBIDDEN)
}

describe("11.8 case 1 — start searxng spawns only colima list, a flagless colima start and compose start", () => {
  it("stopped VM: list, flagless start, docker info, compose start on the observed context", () => {
    seedState({ runtime: STATES.HEALTHY, searxng: STATES.HEALTHY }, "observed-ctx")
    const r = fake({ profile: "Stopped" })
    const rep = start("searxng", r)
    expect(rep.ok).toBe(true)
    expect(rep.code).toBeUndefined()
    const home = process.env.HOME as string
    expect(r.calls).toEqual([
      `${COLIMA} list --json`,
      `${COLIMA} start --profile swarm --activate=false`,
      `${DOCKER} --context observed-ctx info --format '{{.ServerVersion}}'`,
      `${DOCKER} --context observed-ctx compose -p swarm-tools -f ${home}/.swarm/tools/searxng/compose/searxng.yml start`,
    ])
    assertNeverInstalls(r.calls)
  })

  it("running VM: no colima start at all, straight to compose start", () => {
    seedState({ runtime: STATES.HEALTHY, firecrawl: STATES.HEALTHY })
    const r = fake({ profile: "Running" })
    const rep = start("firecrawl", r)
    expect(rep.ok).toBe(true)
    const home = process.env.HOME as string
    expect(r.calls).toEqual([
      `${COLIMA} list --json`,
      `${DOCKER} --context colima-swarm compose -p swarm-tools -f ${home}/.swarm/tools/firecrawl/compose/firecrawl.yml start`,
    ])
    assertNeverInstalls(r.calls)
  })

  it("start runtime only touches colima (and the info gate), never compose", () => {
    seedState({ runtime: STATES.HEALTHY })
    const r = fake({ profile: "Stopped" })
    const rep = start("runtime", r)
    expect(rep.ok).toBe(true)
    expect(r.calls.some((c) => c.includes(" compose "))).toBe(false)
    expect(r.calls[1]).toBe(`${COLIMA} start --profile swarm --activate=false`)
    assertNeverInstalls(r.calls)
  })

  it("runtime that never answers docker info within the deadline fails and starts no stack", () => {
    seedState({ runtime: STATES.HEALTHY, searxng: STATES.HEALTHY })
    const r = fake({ profile: "Stopped", infoOk: false })
    const rep = start("searxng", r)
    expect(rep.ok).toBe(false)
    expect(r.calls.some((c) => c.includes(" compose "))).toBe(false)
    assertNeverInstalls(r.calls)
  })
})

describe("11.8 case 2 — not installed refuses with START_NOT_INSTALLED and spawns nothing", () => {
  for (const st of [STATES.ABSENT, STATES.FAILED]) {
    it(`searxng state ${st}`, () => {
      seedState({ runtime: STATES.HEALTHY, searxng: st })
      const r = fake({})
      const rep = start("searxng", r)
      expect(rep.ok).toBe(false)
      expect(rep.code).toBe(START_CODES.NOT_INSTALLED)
      expect(r.calls).toEqual([])
    })
  }
  it("runtime not healthy refuses a stack start too (the stack needs the runtime)", () => {
    seedState({ runtime: STATES.FAILED, searxng: STATES.HEALTHY })
    const r = fake({})
    const rep = start("searxng", r)
    expect(rep.code).toBe(START_CODES.NOT_INSTALLED)
    expect(r.calls).toEqual([])
  })
  it("no state file at all (fresh machine) refuses", () => {
    const r = fake({})
    const rep = start("runtime", r)
    expect(rep.code).toBe(START_CODES.NOT_INSTALLED)
    expect(r.calls).toEqual([])
  })
})

describe("11.8 case 3 — profile missing refuses with RUNTIME_PROFILE_MISSING, no colima start", () => {
  it("colima list without profile swarm", () => {
    seedState({ runtime: STATES.HEALTHY, searxng: STATES.HEALTHY })
    const r = fake({ profile: "absent" })
    const rep = start("searxng", r)
    expect(rep.code).toBe(START_CODES.PROFILE_MISSING)
    expect(r.calls).toEqual([`${COLIMA} list --json`])
  })
})

describe("11.8 case 4 — compose start with no containers refuses with START_CONTAINERS_MISSING", () => {
  it("names the manual repair hint and never falls back to up", () => {
    seedState({ runtime: STATES.HEALTHY, searxng: STATES.HEALTHY })
    const r = fake({ profile: "Running", compose: "missing" })
    const rep = start("searxng", r)
    expect(rep.ok).toBe(false)
    expect(rep.code).toBe(START_CODES.CONTAINERS_MISSING)
    expect(rep.message).toContain("swarm-setup apply searxng")
    expect(r.calls.filter((c) => c.includes(" compose ")).length).toBe(1)
    assertNeverInstalls(r.calls)
  })
  it("any other compose failure is a plain failure, not the missing-containers refusal", () => {
    seedState({ runtime: STATES.HEALTHY, searxng: STATES.HEALTHY })
    const r = fake({ profile: "Running", compose: "fail" })
    const rep = start("searxng", r)
    expect(rep.ok).toBe(false)
    expect(rep.code).toBeUndefined()
    assertNeverInstalls(r.calls)
  })
})

describe("11.8 case 5 — tools.lock.json and state.json byte-identical; one audit.jsonl line", () => {
  it("success path", () => {
    seedState({ runtime: STATES.HEALTHY, searxng: STATES.HEALTHY })
    const lockBefore = readFileSync(resolveLockFile())
    const stateBefore = readFileSync(stateFile())
    const rep = start("searxng", fake({ profile: "Stopped" }))
    expect(rep.ok).toBe(true)
    expect(Buffer.compare(readFileSync(resolveLockFile()), lockBefore)).toBe(0)
    expect(Buffer.compare(readFileSync(stateFile()), stateBefore)).toBe(0)
    const lines = auditLines()
    expect(lines.length).toBe(1)
    expect(lines[0]?.verb).toBe("start")
    expect(lines[0]?.component).toBe("searxng")
    expect(lines[0]?.outcome).toBe("OK")
  })
  it("refusal path also writes exactly one line and no state", () => {
    seedState({ runtime: STATES.HEALTHY, searxng: STATES.ABSENT })
    const stateBefore = readFileSync(stateFile())
    start("searxng", fake({}))
    expect(Buffer.compare(readFileSync(stateFile()), stateBefore)).toBe(0)
    const lines = auditLines()
    expect(lines.length).toBe(1)
    expect(lines[0]?.outcome).toBe(START_CODES.NOT_INSTALLED)
  })
})

describe("11.8 case 6 — start obsidian gives START_UNKNOWN_COMPONENT", () => {
  it("engine refuses without spawning", () => {
    seedState({ obsidian: STATES.HEALTHY })
    const r = fake({})
    const rep = start("obsidian", r)
    expect(rep.code).toBe(START_CODES.UNKNOWN)
    expect(r.calls).toEqual([])
  })

  it("the CLI prints RESULT START_UNKNOWN_COMPONENT and exits 1", async () => {
    class ExitSignal extends Error {
      constructor(readonly code: number) {
        super(`exit ${code}`)
      }
    }
    let out = ""
    const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out += `${a.map(String).join(" ")}\n`
    })
    const errSpy = spyOn(console, "error").mockImplementation(() => {})
    const exitSpy = spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new ExitSignal(code)
    }) as never)
    let code = -1
    try {
      await main(["start", "obsidian"])
    } catch (e) {
      if (e instanceof ExitSignal) code = e.code
      else throw e
    } finally {
      logSpy.mockRestore()
      errSpy.mockRestore()
      exitSpy.mockRestore()
    }
    expect(code).toBe(1)
    expect(out).toContain(`RESULT ${START_CODES.UNKNOWN}`)
  })
})

describe("11.8 case 7 — the CLI surface lists start (the desktop feature-detects it)", () => {
  it("usage text names the verb and its three ids", () => {
    expect(usageText()).toContain("start <runtime|searxng|firecrawl>")
  })
  it("parseArgs accepts start with one component", () => {
    const p = parseArgs(["start", "searxng"])
    expect(p.ok).toBe(true)
    if (p.ok) {
      expect(p.cmd.verb).toBe("start")
      expect(p.cmd.components).toEqual(["searxng"])
    }
  })
})
