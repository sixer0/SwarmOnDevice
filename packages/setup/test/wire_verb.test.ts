// Row-199 session-6 — the `wire` verb (fix contract §4, masterplan/03_s6_fix_contract.md; blueprint row
// 199 kept off the critical path per identification/10_onboarding_blueprint.md §6). It exists for one
// machine state this project is actually in: tools installed while the wiring never ran.
//
// WHAT THIS LANE PROVES, behaviourally (it drives the real `main`, so a mutation turns a test red rather
// than a text grep merely going stale):
//   AC-V1  on a half-state machine `wire` writes the eligible entries and DELETES NOTHING — a pre-existing
//          user key in swarm.json and an unrelated file under ~/.config/swarm both survive the run;
//   AC-V2  a second run reports an honest no-op: the printed outcome says nothing changed, every target's
//          bytes are identical, no target's mtime moved, and the writer's own `changed` field is false with
//          no backup created;
//   AC-V3  with components unhealthy the output names each component AND the writer's reason string
//          verbatim, prints the repair command, and the run never reports OK (§4.4's token table);
//   §4.4   the searxng-unhealthy reason and the missing-proxy-binary reason stay two distinct sentences —
//          collapsing them is named as a regression by the contract and is pinned here;
//   §4.4   a writer refusal (symlinked target) prints its flat reason verbatim and exits 1 as FAILED;
//   D10    `wire` resolves NO component list of its own, so the all-seven default row 198 closed cannot be
//          reborn in a third verb (implementation/s6_r198_selection.md §6 named this exact trap);
//   N5/N6  `wire` fabricates no consent and reaches no install step: no consent.log appears, state.json is
//          byte-unchanged across a successful run, and no step line is ever printed.
//
// WHY NO `launch` SEAM IS USED: rows 197/198 pass `launch` to the writer directly because they call the
// writer. This lane drives the CLI, and the CLI has no seam — that is the shipped posture. The consequence
// is stated honestly rather than hidden: a fully healthy machine (graft included) needs a staged graft CLI
// whose digest matches its install record, which a throwaway HOME does not have; contract U-W2 records the
// same unknown for the compiled binary. So no case here asserts `RESULT OK` from the CLI, and the
// swarm.json write is exercised through the swarm-web entry (searxng healthy + proxy binary staged),
// which needs no resolver beyond existsSync. Rows 208/218 own the mcp.graft-on-bytes leg.
//
// Run TARGETED: cd packages/setup && bun test test/wire_verb.test.ts

import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { isolateSourceLock } from "./lockPosture.ts"
import { main } from "../src/index.ts"
import { defaultState, writeState } from "../src/state.ts"
import { COMPONENT_IDS, STATES } from "../src/constants.ts"
import { writeConfigEntries, configFilePath } from "../src/wiring/config_writer.ts"
import { TEXT_TARGETS } from "../src/skills/researcher_text.ts"

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

/** `main` ends in process.exit, which would take the runner with it; carry the code as a sentinel. */
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

async function runCli(argv: readonly string[], home?: string): Promise<Run> {
  const h = home ?? mkdtempSync(join(tmpdir(), "swarm-r199-"))
  if (!home) homes.push(h)
  process.env.HOME = h

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
  return { code, out, err, home: h }
}

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes).digest("hex")
}

/** Every file under `root` as rel-path -> sha256. Used for byte equality and for "nothing else changed". */
function manifest(root: string): Record<string, string> {
  const found: Record<string, string> = {}
  if (!existsSync(root)) return found
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else found[relative(root, p)] = sha(readFileSync(p))
    }
  }
  walk(root)
  return found
}

function mtimes(root: string): Record<string, number> {
  const found: Record<string, number> = {}
  if (!existsSync(root)) return found
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else found[relative(root, p)] = statSync(p).mtimeMs
    }
  }
  walk(root)
  return found
}

function configRoot(home: string): string {
  return join(home, ".config", "swarm")
}

/** Seed the recorded component state the way the engine would have left it (PC-PATH-02).
 *  HOME is pointed at `home` HERE, not left to the ambient value: `stateFile()` resolves through
 *  process.env.HOME at call time, so seeding before a runCli() would otherwise write into whichever
 *  throwaway HOME a previous case had installed — or, if no case had run yet, into the REAL user home. */
function seedState(home: string, healthy: readonly string[]): void {
  process.env.HOME = home
  mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
  const s = defaultState("r199-test-lock")
  for (const id of healthy) s.components[id as keyof typeof s.components].state = STATES.HEALTHY
  writeState(s)
}

/** The swarm-web entry's eligibility needs the staged proxy binary (register PC-PATH-14). Staging it is
 *  exactly what a real `install searxng` leaves behind, so this models the half-state honestly instead of
 *  reaching for a test seam the shipped CLI does not have. */
function stageProxyBinary(home: string): string {
  const p = join(home, ".swarm", "setup", "bin", "swarm-web-proxy")
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, "#!/bin/sh\n")
  return p
}

function baks(home: string): string[] {
  if (!existsSync(configRoot(home))) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".bak")) out.push(relative(configRoot(home), p))
    }
  }
  walk(configRoot(home))
  return out
}

/** The edited entry point as text. Bounded at the NEXT function so a source tripwire can only ever read
 *  cmdWire's own code — an unbounded slice reaches into cmdRemove, which legitimately calls resolveSelected,
 *  and the tripwire would then be asserting nothing about the verb it names. */
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
const CMD_WIRE_BODY = SRC.slice(SRC.indexOf("function cmdWire"), SRC.indexOf("function cmdRemove"))

describe("Verb surface — `wire` is a recognised verb with its own usage line", () => {
  it("parses `wire` as a verb rather than an unknown argument", async () => {
    const r = await runCli(["wire"])
    expect(r.out).not.toContain("unknown command")
    expect(r.err).not.toContain("unknown argument")
    // Reached the verb body: the writer ran and reported its skips (everything is absent here).
    expect(r.out).toContain("graft component is not healthy")
  })

  it("usage text lists all five verbs — the three frozen ones plus wire and apply", async () => {
    const r = await runCli(["--help"])
    expect(r.out).toContain("re-wire")
    expect(r.out).toContain("install [component...]")
    expect(r.out).toContain("remove  [component...]")
    // Row 246b: the help screen must not under-name the verb set either (register §21.4 R-3).
    expect(r.out).toContain("apply <stack>")
  })

  it("the missing-verb error enumerates the COMPLETE register set, so help never contradicts the parser", async () => {
    // A bare unknown word hits `unknown argument` first; the verb-enumerating message is reachable via a
    // flag-only invocation (parseArgs:80-88), which is the surface that would have gone stale.
    // Row 246b: this pins the full set per register §21.4 R-3 — PC-CMD-01..03 frozen plus PC-CMD-04
    // (wire) and PC-CMD-05 (apply). A verb added to the parser without joining this message, or dropped
    // from it, goes red here; mutation-proven in implementation/s6_r246b_verb_register.md §3.
    const r = await runCli(["--dry-run"])
    expect(r.err).toContain("missing command verb (install | status | remove | wire | apply)")
    expect(r.code).toBe(1)
  })

  it("the unknown-command error names the same complete set (both enumerating strings move together)", async () => {
    // A component id with no verb reaches the OTHER enumerating message (cli.ts:109). Row 246b widened
    // both strings in one batch, so both are pinned — one test per string, not one string tested twice.
    const r = await runCli(["graft"])
    expect(r.err).toContain("expected install | status | remove | wire | apply")
    expect(r.code).toBe(1)
  })

  it("a named component is refused, not silently ignored, and nothing is written", async () => {
    const r = await runCli(["wire", "graft"])
    expect(r.code).toBe(1)
    expect(r.out).toContain(`RESULT FAILED`)
    expect(r.err).toContain("wire takes no component list")
    expect(r.err).toContain("named graft")
    expect(existsSync(join(configRoot(r.home), "swarm.json"))).toBe(false)
    // Refused before the lock was even needed for a write: no config tree was created.
    expect(existsSync(configRoot(r.home))).toBe(false)
  })

  it("--dry-run is refused rather than honoured-as-touch-nothing (PC-FLAG-03 cannot be satisfied here)", async () => {
    const r = await runCli(["wire", "--dry-run"])
    expect(r.code).toBe(1)
    expect(r.out).toContain("RESULT FAILED")
    expect(r.err).toContain("wire --dry-run is not offered")
    expect(existsSync(configRoot(r.home))).toBe(false)
  })

  it("--non-interactive is inert on this verb (there is no prompt to skip) and does not refuse", async () => {
    const r = await runCli(["wire", "--non-interactive"])
    expect(r.out).not.toContain(`RESULT REFUSED_NO_SELECTION`)
    expect(r.out).not.toContain(`RESULT REFUSED_NON_INTERACTIVE`)
    // Same outcome as the bare verb: health decides scope, interactivity is irrelevant to wiring.
    expect(r.out).toContain("graft component is not healthy")
  })
})

describe("No-args semantics — scope comes from recorded health, never from an all-seven default (D10)", () => {
  it("cmdWire contains no expression that could turn an empty argument list into a component list", () => {
    expect(SRC).toContain("function cmdWire") // the slice below is real, not an empty string passing vacuously
    expect(CMD_WIRE_BODY.length).toBeGreaterThan(500)
    expect(CMD_WIRE_BODY).toContain("writeConfigEntries(")
    // The three shapes D10 was actually made of. If any reappears here, a third default has been born.
    expect(CMD_WIRE_BODY).not.toContain("COMPONENT_IDS")
    expect(CMD_WIRE_BODY).not.toContain("resolveSelected")
    expect(CMD_WIRE_BODY).not.toMatch(/components\.length\s*>\s*0\s*\?/)
  })

  it("with every component absent, `wire` writes NOTHING — proving no args is not all seven", async () => {
    const r = await runCli(["wire"])
    expect(r.code).toBe(0)
    expect(r.out).toContain(`RESULT SKIPPED_WITH_INSTRUCTIONS`)
    expect(r.out).not.toContain("RESULT OK")
    // An all-seven default would have tried to wire everything; health-derived scope touched no disk at all.
    expect(existsSync(join(configRoot(r.home), "swarm.json"))).toBe(false)
    expect(Object.keys(manifest(configRoot(r.home))).length).toBe(0)
  })

  it("with only rtk healthy, exactly the rtk text is written and no swarm.json entry appears", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["rtk"])
    const r = await runCli(["wire"], home)
    expect(r.code).toBe(0)
    expect(existsSync(join(configRoot(home), TEXT_TARGETS.rtk))).toBe(true)
    // No MCP entry is eligible (graft absent, searxng absent) => swarm.json is not even planned.
    expect(existsSync(join(configRoot(home), "swarm.json"))).toBe(false)
    // The other four texts were skipped with their gate named, not silently omitted.
    expect(existsSync(join(configRoot(home), TEXT_TARGETS.graft))).toBe(false)
    expect(r.out).toContain(`${TEXT_TARGETS.graft}: skipped — graft component is not healthy (P-15)`)
    expect(r.out).toContain(`${TEXT_TARGETS.obsidianInbox}: skipped — obsidian component is not healthy (P-15)`)
  })
})

describe("AC-V1 — the half-state repair writes what is eligible and deletes nothing", () => {
  it("a pre-existing user key and an unrelated file both survive a real write", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["searxng", "rtk"])
    stageProxyBinary(home)
    mkdirSync(join(configRoot(home)), { recursive: true })
    const cfg = join(configRoot(home), "swarm.json")
    writeFileSync(cfg, JSON.stringify({ permissions: { keep: "me" }, other: 1 }, null, 2) + "\n", { mode: 0o600 })
    const unrelated = join(configRoot(home), "skills", "someone-else", "SKILL.md")
    mkdirSync(dirname(unrelated), { recursive: true })
    writeFileSync(unrelated, "user content, not ours\n")

    const r = await runCli(["wire"], home)
    expect(r.code).toBe(0)
    expect(r.out).toContain("wire: wrote")

    const written = JSON.parse(readFileSync(cfg, "utf8")) as Record<string, unknown>
    expect(written.permissions).toEqual({ keep: "me" }) // merge preserved the user's key
    expect((written.mcp as Record<string, unknown>)["swarm-web"]).toBeTruthy() // the entry landed
    expect(readFileSync(unrelated, "utf8")).toBe("user content, not ours\n") // nothing deleted
    expect(existsSync(join(configRoot(home), TEXT_TARGETS.rtk))).toBe(true)
    expect(existsSync(join(configRoot(home), TEXT_TARGETS.agentResearcher))).toBe(true)
  })
})

describe("AC-V2 — idempotence three ways: changed:false, byte equality, and no target touched", () => {
  it("second run says no change, every target is byte-identical, and no mtime moved", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["searxng", "rtk"])
    stageProxyBinary(home)

    const first = await runCli(["wire"], home)
    expect(first.code).toBe(0)
    expect(first.out).toContain("wire: wrote")
    const targets = Object.keys(manifest(configRoot(home)))
    expect(targets.length).toBeGreaterThan(1) // swarm.json plus the gated texts
    const bytesAfterFirst = manifest(configRoot(home))
    const baksAfterFirst = baks(home)

    // A gap wider than APFS mtime granularity, so a rewrite would be visible in mtimeMs.
    const spinUntil = Date.now() + 80
    while (Date.now() < spinUntil) {
      /* synchronous spin: the in-test analogue of `find -newer <stamp>` returning nothing */
    }
    const timesAfterFirst = mtimes(configRoot(home))

    const second = await runCli(["wire"], home)
    expect(second.code).toBe(0)
    // (1) the honest wording — a no-op is never dressed as a fresh wire.
    expect(second.out).toContain("wire: no change (already current)")
    expect(second.out).not.toContain("wire: wrote")
    // (2) byte equality of EVERY target.
    expect(manifest(configRoot(home))).toEqual(bytesAfterFirst)
    // (3) no target was rewritten at all, and no new backup appeared.
    expect(mtimes(configRoot(home))).toEqual(timesAfterFirst)
    expect(baks(home)).toEqual(baksAfterFirst)
  })

  it("the writer's own field says changed:false with no backup, corroborating the printed line", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["searxng", "rtk"])
    stageProxyBinary(home)
    // Drive the CLI once so the tree is current, then read the writer's structured verdict on the same tree.
    const cli = await runCli(["wire"], home)
    expect(cli.out).toContain("wire: wrote")
    const res = writeConfigEntries({ base: home })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.changed).toBe(false) // config_writer.ts's own no-op contract
    expect(res.backupPath).toBeNull()
    expect(res.backups).toEqual([])
  })
})

describe("AC-V3 / §4.4 — unhealthy targets print the writer's reasons verbatim and never report OK", () => {
  it("every unhealthy gate is named with its own sentence and its own repair command", async () => {
    const r = await runCli(["wire"])
    expect(r.out).toContain("wire graft: skipped — graft component is not healthy (P-15)")
    expect(r.out).toContain("wire swarm-web: skipped — searxng component is not healthy (P-15)")
    expect(r.out).toContain(`wire ${TEXT_TARGETS.graft}: skipped — graft component is not healthy (P-15)`)
    expect(r.out).toContain(`wire ${TEXT_TARGETS.agentResearcher}: skipped — swarmWeb component is not healthy (P-15)`)
    // The repair command rides alongside, naming the component that must become healthy.
    expect(r.out).toContain("wire: repair with swarm-setup install graft")
    expect(r.out).toContain("wire: repair with swarm-setup install searxng")
    expect(r.out).toContain("wire: repair with swarm-setup install rtk")
    expect(r.out).toContain("wire: repair with swarm-setup install obsidian")
    // One instruction per component, even though two texts share the swarmWeb gate.
    expect(r.out.split("repair with swarm-setup install searxng").length - 1).toBe(1)
    // Never OK while an eligible target went unwritten.
    expect(r.out).toContain("RESULT SKIPPED_WITH_INSTRUCTIONS")
    expect(r.out).not.toContain("RESULT OK")
    expect(r.code).toBe(0) // §4.4: the operator chain keys on the token, exit stays 0
  })

  it("searxng healthy with the proxy binary missing keeps the two causes separate", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["searxng"]) // healthy, but PC-PATH-14 was never staged
    const r = await runCli(["wire"], home)
    expect(r.out).toContain("proxy binary not staged at PC-PATH-14")
    // Collapsing this into "searxng is unhealthy" is the regression §4.4 row 3 names explicitly.
    expect(r.out).not.toContain("searxng component is not healthy")
    expect(r.out).toContain("RESULT SKIPPED_WITH_INSTRUCTIONS")
  })

  it("the drift check reports how many files it actually compared (no vacuous clean bill)", async () => {
    const r = await runCli(["wire"])
    expect(r.out).toContain("drift check compared 0 file(s)")
  })
})

describe("§4.4 last row — a writer refusal surfaces its reason verbatim and exits 1", () => {
  it("a symlinked swarm.json is refused with the writer's own sentence and is not clobbered", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["searxng"])
    stageProxyBinary(home) // makes swarm.json a planned target, so the symlink guard has something to check
    mkdirSync(configRoot(home), { recursive: true })
    const outside = join(home, "elsewhere.json")
    writeFileSync(outside, '{"user":"do not follow me"}\n', { mode: 0o600 })
    symlinkSync(outside, join(configRoot(home), "swarm.json"))

    const r = await runCli(["wire"], home)
    expect(r.code).toBe(1)
    expect(r.out).toContain("RESULT FAILED")
    expect(r.err).toContain("wiring refused:")
    expect(r.err).toContain("is a symlink")
    expect(r.err).toContain("target_symlink") // the writer's words, not a paraphrase
    expect(lstatSync(join(configRoot(home), "swarm.json")).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(configRoot(home), "swarm.json"))).toBe(outside)
    expect(readFileSync(outside, "utf8")).toBe('{"user":"do not follow me"}\n')
  })
})

describe("Consent posture — wire re-runs wiring and nothing else", () => {
  it("cmdWire reaches none of the consent, step-pipeline or state-commit surfaces", () => {
    expect(CMD_WIRE_BODY.length).toBeGreaterThan(500)
    for (const forbidden of [
      "evaluateConsent",
      "renderConsentScreen",
      "executeSteps",
      "discoverSteps",
      "orderSteps",
      "writeState",
      "setState",
      "cmdInstall",
    ]) {
      expect(CMD_WIRE_BODY).not.toContain(forbidden)
    }
  })

  it("a successful wire writes no consent.log, leaves state.json byte-identical, and releases its lock", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["searxng", "rtk"])
    stageProxyBinary(home)
    const statePath = join(home, ".swarm", "setup", "state.json")
    const stateShaBefore = sha(readFileSync(statePath))

    const r = await runCli(["wire"], home)
    expect(r.code).toBe(0)
    expect(r.out).toContain("wire: wrote") // a real write happened, so the absence claims below mean something

    const swarmFiles = Object.keys(manifest(join(home, ".swarm")))
    expect(swarmFiles.some((f) => f.endsWith("consent.log"))).toBe(false)
    expect(sha(readFileSync(statePath))).toBe(stateShaBefore) // no state commit
    expect(existsSync(join(home, ".swarm", "setup", "lock"))).toBe(false) // transient lock released
    expect(r.out).not.toContain("step ") // the step pipeline never ran
    expect(r.out).not.toContain("consent") // no consent screen was rendered or mentioned
  })

  it("wire never touches ~/.swarm/tools, where the installed components live", async () => {
    const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
    homes.push(home)
    seedState(home, ["searxng", "rtk"])
    stageProxyBinary(home)
    const toolsDir = join(home, ".swarm", "tools")
    expect(existsSync(toolsDir)).toBe(false)
    const r = await runCli(["wire"], home)
    expect(r.code).toBe(0)
    expect(existsSync(toolsDir)).toBe(false)
  })
})

describe("Selection-rule sharing — the two verbs row 198 closed stay closed beside the new one", () => {
  it("install --non-interactive still refuses (row 198's site is undisturbed)", async () => {
    const r = await runCli(["install", "--non-interactive"])
    expect(r.out).toContain("RESULT REFUSED_NO_SELECTION")
    expect(r.code).toBe(1)
    for (const id of COMPONENT_IDS) expect(r.err).toContain(id)
  })

  it("remove --non-interactive still refuses (drift D10's second site)", async () => {
    const r = await runCli(["remove", "--non-interactive"])
    expect(r.out).toContain("RESULT REFUSED_NO_SELECTION")
    expect(r.code).toBe(1)
  })

  it("wire does not borrow either refusal token — it has no selection question to answer", async () => {
    const r = await runCli(["wire", "--non-interactive"])
    expect(r.out).not.toContain("REFUSED_NO_SELECTION")
    expect(r.out).not.toContain("REFUSED_NON_INTERACTIVE")
  })
})

describe("Config path — the file wire writes is the one the product reads", () => {
  it("writes to <HOME>/.config/swarm with XDG_CONFIG_HOME unset (the AC-W1 throwaway-HOME posture)", async () => {
    const savedXdg = process.env.XDG_CONFIG_HOME
    try {
      delete process.env.XDG_CONFIG_HOME
      const home = mkdtempSync(join(tmpdir(), "swarm-r199-"))
      homes.push(home)
      seedState(home, ["searxng"])
      stageProxyBinary(home)
      const r = await runCli(["wire"], home)
      expect(r.code).toBe(0)
      expect(existsSync(configFilePath({ base: home }))).toBe(true)
    } finally {
      if (savedXdg !== undefined) process.env.XDG_CONFIG_HOME = savedXdg
    }
  })
})
