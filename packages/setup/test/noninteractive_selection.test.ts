// Row 198 session 6 — an unnamed component list refuses on the NON-INTERACTIVE path instead of
// silently selecting all seven (fix contract §3, masterplan/03_s6_fix_contract.md; drift D10,
// research/s6_01_seam_anchor.md:460 — the default lived in TWO places, `resolveSelected` for
// `install` and an inline ternary inside `cmdRemove`).
//
// WHAT THIS LANE PROVES, behaviourally (it drives the real `main`, so a mutation at either site
// turns a test red rather than a text grep merely going stale):
//   AC-S1  both verbs print a refusal that NAMES the candidate ids and ends `RESULT REFUSED_NO_SELECTION`;
//   AC-S2  that run exits 1 and leaves no consent.log, no state.json, no swarm.json and no `wire:` line —
//          i.e. it never consumes consent and never reaches the writer call row 197 added;
//   AC-S3  `--non-interactive` WITH explicit names behaves exactly as before (reaches the consent gate and
//          is refused there for missing tokens) — the refusal is about silence, not about non-interactivity;
//   DC-S2  a `--terms-token` with no positional component still refuses: a token acknowledges a component,
//          it does not select one (src/cli.ts records tokens without touching `components`);
//   register PC-CMD-01 (frozen, masterplan/01c0_preinstall_register.md:386) the INTERACTIVE path still
//          presents all seven unticked — that presentation is the consent model working, not a defect.
//
// WHY IN-PROCESS RATHER THAN SPAWNED: `resolveProgramDir()` (src/paths.ts:74-81) needs
// tools.lock.json beside the executable and otherwise falls back to `src/`, where no lock exists;
// staging one there is exactly the shared-path race `test/lockPosture.ts` was written to end, and
// compiling a binary is outside this row's posture (no build). `isolateSourceLock()` points
// process.execPath at a private temp program directory holding the shipped lock, so `main` runs the
// real dispatch path against a throwaway HOME.
//
// ZERO NETWORK: every case here terminates at or before the consent gate, which sits before any fetch
// (src/index.ts records consent durably only after it returns ok:true). No case grants consent, so no
// case can download anything.
//
// Run TARGETED: cd packages/setup && bun test test/noninteractive_selection.test.ts

import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isolateSourceLock } from "./lockPosture.ts"
import { main } from "../src/index.ts"
import { OUTCOME, exitCodeFor, messageFor } from "../src/outcomes.ts"
import { COMPONENT_IDS } from "../src/constants.ts"

const REAL_HOME = process.env.HOME
const homes: string[] = []
let releaseLockPosture: (() => void) | undefined

beforeAll(() => {
  releaseLockPosture = isolateSourceLock()
})

afterAll(() => {
  releaseLockPosture?.()
  process.env.HOME = REAL_HOME
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

/** `main` ends in process.exit, which would take the test runner with it. Carrying the code in a
 *  typed sentinel keeps the exit value observable without killing the lane. */
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

interface Run {
  code: number
  out: string
  err: string
  home: string
}

/** Drive the real CLI surface in-process against a fresh throwaway HOME. */
async function runCli(argv: readonly string[]): Promise<Run> {
  const home = mkdtempSync(join(tmpdir(), "swarm-r198-"))
  homes.push(home)
  process.env.HOME = home

  let out = ""
  let err = ""
  const logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out += `${a.map(String).join(" ")}\n`
  })
  const errSpy = spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    err += `${a.map(String).join(" ")}\n`
  })
  const exitSpy = spyOn(process, "exit").mockImplementation(((code: number) => {
    throw new ExitSignal(code)
  }) as never)

  let code = -1
  try {
    await main([...argv])
  } catch (e) {
    if (e instanceof ExitSignal) code = e.code
    else throw e
  } finally {
    logSpy.mockRestore()
    errSpy.mockRestore()
    exitSpy.mockRestore()
  }
  return { code, out, err, home }
}

/** Every file under $HOME/.swarm — a refused run must leave none of the load-bearing ones behind. */
function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const found: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else found.push(p)
    }
  }
  walk(root)
  return found
}

describe("AC-S1 install — an unnamed --non-interactive install refuses and names the candidates", () => {
  it("prints the candidate ids, prints RESULT REFUSED_NO_SELECTION, exits 1", async () => {
    const r = await runCli(["install", "--non-interactive"])
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.code).toBe(1)
    // AC-S1: the id list must be VISIBLE in the output, not implied by the token.
    for (const id of COMPONENT_IDS) expect(r.err).toContain(id)
    expect(r.err).toContain("refusing instead of selecting all seven")
  })

  it("teaches the required command form without picking components for the operator", async () => {
    const r = await runCli(["install", "--non-interactive"])
    expect(r.err).toContain("required form:")
    expect(r.err).toContain("install <component> [<component>...] --non-interactive")
  })

  it("does NOT report REFUSED_NO_CONSENT or REFUSED_NON_INTERACTIVE — those name different gates", async () => {
    const r = await runCli(["install", "--non-interactive"])
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NO_CONSENT}`)
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NON_INTERACTIVE}`)
  })
})

describe("AC-S1 remove — the SECOND site (drift D10): cmdRemove carried its own all-seven default", () => {
  it("remove --non-interactive with no names refuses with the same token and names the candidates", async () => {
    const r = await runCli(["remove", "--non-interactive"])
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.code).toBe(1)
    for (const id of COMPONENT_IDS) expect(r.err).toContain(id)
    // The old inline default (`cmd.components.length > 0 ? cmd.components : COMPONENT_IDS`) would have
    // walked the whole fleet and ended SKIPPED_WITH_INSTRUCTIONS, exit 0. Pin that class of slip out.
    expect(r.out).not.toContain("RESULT OK")
    expect(r.out).not.toContain("SKIPPED_WITH_INSTRUCTIONS")
  })

  it("the --remove alias takes the same refusal", async () => {
    const r = await runCli(["--remove", "--non-interactive"])
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.code).toBe(1)
  })
})

describe("AC-S2 — the refusal consumes and writes nothing", () => {
  it("neither verb leaves consent.log, state.json, swarm.json or a wire: line", async () => {
    for (const verb of ["install", "remove"] as const) {
      const r = await runCli([verb, "--non-interactive"])
      expect(r.code).toBe(exitCodeFor(OUTCOME.REFUSED_NO_SELECTION))
      expect(r.code).toBe(1)
      const files = filesUnder(join(r.home, ".swarm"))
      expect(files.some((f) => f.endsWith("consent.log"))).toBe(false)
      expect(files.some((f) => f.endsWith("state.json"))).toBe(false)
      expect(files.some((f) => f.endsWith("config-writer.json"))).toBe(false)
      // Row 197's writer call sits AFTER the step pipeline; a refusal must never reach it, so neither
      // the config file it owns nor any of its printed skip reasons may appear.
      expect(existsSync(join(r.home, ".config", "swarm", "swarm.json"))).toBe(false)
      expect(r.out).not.toContain("wire:")
      expect(r.out).not.toContain("step ")
    }
  })
})

describe("DC-S2 — a token is not a selection", () => {
  it("--terms-token with no positional component still refuses REFUSED_NO_SELECTION", async () => {
    const r = await runCli(["install", "--non-interactive", "--terms-token", "graft=graft@deadbeef1234"])
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.code).toBe(1)
    // Not the missing-token gate: nothing was selected, so nothing was ever asked to be paid for.
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NON_INTERACTIVE}`)
    expect(filesUnder(join(r.home, ".swarm")).some((f) => f.endsWith("consent.log"))).toBe(false)
  })

  it("tokens for ALL SEVEN components with no positional still refuse", async () => {
    const argv = ["install", "--non-interactive"]
    for (const id of COMPONENT_IDS) argv.push("--terms-token", `${id}=${id}@deadbeef1234`)
    const r = await runCli(argv)
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.code).toBe(1)
  })
})

describe("AC-S3 — explicit names still behave exactly as before", () => {
  it("named --non-interactive reaches the CONSENT gate and is refused there for missing tokens", async () => {
    const r = await runCli(["install", "node", "graft", "rtk", "--non-interactive"])
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NON_INTERACTIVE}`)
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.err).toContain("Missing --terms-token for: node, graft, rtk")
    expect(r.code).toBe(1)
  })

  it("named --dry-run still renders the consent screen for exactly those components", async () => {
    const r = await runCli(["install", "graft", "--dry-run"])
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NO_CONSENT}`)
    expect(r.out).toContain("graft")
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
  })

  it("remove with an explicit name is unaffected (lists targets, deletes nothing)", async () => {
    const r = await runCli(["remove", "graft", "--non-interactive"])
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.code).toBe(0)
  })
})

describe("Register PC-CMD-01 preserved — the interactive path still presents all seven UNTICKED", () => {
  it("install --dry-run with no names and no --non-interactive offers all seven and consents nothing", async () => {
    const r = await runCli(["install", "--dry-run"])
    expect(r.out).toContain(`RESULT ${OUTCOME.REFUSED_NO_CONSENT}`)
    expect(r.out).toContain("unticked by default")
    for (const id of COMPONENT_IDS) expect(r.out).toContain(id)
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(filesUnder(join(r.home, ".swarm")).some((f) => f.endsWith("consent.log"))).toBe(false)
  })

  it("interactive remove with no names keeps its all-seven SCOPE (it prints targets, deletes nothing)", async () => {
    const r = await runCli(["remove"])
    expect(r.out).not.toContain(`RESULT ${OUTCOME.REFUSED_NO_SELECTION}`)
    expect(r.code).toBe(0)
  })
})

describe("Token hygiene — three distinct gates, three distinct tokens", () => {
  it("REFUSED_NO_SELECTION is its own token with its own message and exits 1", () => {
    expect(OUTCOME.REFUSED_NO_SELECTION).toBe("REFUSED_NO_SELECTION")
    expect(messageFor(OUTCOME.REFUSED_NO_SELECTION)).not.toBe(messageFor(OUTCOME.REFUSED_NO_CONSENT))
    expect(messageFor(OUTCOME.REFUSED_NO_SELECTION)).not.toBe(messageFor(OUTCOME.REFUSED_NON_INTERACTIVE))
    expect(exitCodeFor(OUTCOME.REFUSED_NO_SELECTION)).toBe(1)
    // The message must not claim consent was ever asked for (contract §3.3's misleading-success class).
    expect(messageFor(OUTCOME.REFUSED_NO_SELECTION)).not.toMatch(/no component was consented/)
  })
})

describe("DC-S1 support — BOTH sites carry their own guard (a one-site fix is how D10 was born)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")

  it("cmdInstall carries the install-site refusal", () => {
    const start = src.indexOf("async function cmdInstall")
    const end = src.indexOf("function printWiringOutcome")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(src.slice(start, end)).toContain('printNoSelectionRefusal("install")')
  })

  it("cmdRemove carries its OWN refusal, not a shared upstream one", () => {
    const start = src.indexOf("function cmdRemove")
    expect(start).toBeGreaterThan(-1)
    expect(src.slice(start)).toContain('printNoSelectionRefusal("remove")')
  })
})
