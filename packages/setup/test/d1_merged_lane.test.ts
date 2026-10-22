// Row-200 session-6 — the consolidated D1 unit lane (fix contract masterplan/03_s6_fix_contract.md,
// rows 197+198+199 verified together against ONE merged tree).
//
// WHY THIS FILE EXISTS ALTHOUGH EACH AUTHOR SHIPPED A LANE: rows 197, 198 and 199 each reported green
// against their OWN bytes (implementation/s6_r197_wiring_call.md §5, s6_r198_selection.md §3,
// s6_r199_wire_verb.md §7). The serialised setup-cli-file handoff means the merged tree is row 199's
// snapshot, but that equivalence is proven here by running, not by the hash chain alone. Row 202
// meanwhile caught a transient red in this very file (`token used before assigned` at index.ts:529-534)
// while a sibling was mid-write — the class of failure only a post-merge run sees.
//
// WHAT THIS LANE ADDS BEYOND REPLAYING THE THREE AUTHOR LANES:
//   - cross-author scenarios none of them could run alone: the `wire` verb (row 199) driving the D13
//     refusal (row 197) through the real CLI, and the selection gate (row 198) proven to sit BEFORE
//     any consent read and BEHIND the pre-existing gates on the merged bytes;
//   - the audit-appendix honesty row 199 disclosed (s6_r199_wire_verb.md §3): a second `wire` run
//     legitimately appends a tool_launch line to ~/.swarm/setup/audit.jsonl while ~/.config/swarm
//     must stay byte-frozen — asserted as one paired expectation, so "no change" stays true where it
//     means something and honest where it does not;
//   - the deferred-vs-closable line kept visible: everything here is SOURCE posture. AC-W1/W2/W4,
//     AC-S1/S2 on the shipped binary, DC-W1's behavioural half and AC-T4 on bytes belong to rows
//     208/218/219/221 (contract §1.2, §3.5, §6) and no case here claims them.
//
// Posture inherited from the author lanes: drive the real `main` in-process (spy on console + process.exit
// only), throwaway HOME per case, isolateSourceLock() so no shared src/tools.lock.json is ever staged,
// and seedState() pinning HOME itself before writing (the harness hazard row 199 found at
// s6_r199_wire_verb.md §8 — a seeding helper that reads paths.ts resolution can otherwise hit the REAL
// ~/.swarm/setup/state.json).
//
// Run TARGETED: cd packages/setup && bun test test/d1_merged_lane.test.ts

import { describe, it, expect, beforeAll, afterAll, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import {
  writeConfigEntries,
  checkSkillFiles,
  configFilePath,
  configDir,
  type ConfigWriterOptions,
} from "../src/wiring/config_writer.ts"
import { renderSkillTexts, TEXT_TARGETS } from "../src/skills/researcher_text.ts"

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
  const h = home ?? mkdtempSync(join(tmpdir(), "r200-merged-"))
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

/** Every file under `root` as rel-path -> sha256 ("nothing else moved" instrument). */
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

/** Seed recorded component state the way the engine would leave it. Pins HOME itself FIRST:
 *  stateFile() resolves through process.env.HOME at CALL time (paths.ts), so a helper that does
 *  not pin can write into the real home — the hazard row 199 measured and reported (§8). */
function seedState(home: string, healthy: readonly string[]): void {
  process.env.HOME = home
  mkdirSync(join(home, ".swarm", "setup"), { recursive: true, mode: 0o700 })
  const s = defaultState("r200-merged-test-lock")
  for (const id of healthy) s.components[id as keyof typeof s.components].state = STATES.HEALTHY
  writeState(s)
}

/** swarm-web eligibility needs the staged proxy binary (PC-PATH-14) — what a real `install searxng`
 *  leaves behind, so the half-state is modelled honestly rather than through a seam the CLI lacks. */
function stageProxyBinary(home: string): string {
  const p = join(home, ".swarm", "setup", "bin", "swarm-web-proxy")
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, "#!/bin/sh\n")
  return p
}

function baksUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith(".bak")) out.push(relative(root, p))
    }
  }
  walk(root)
  return out
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p)
      else out.push(relative(root, p))
    }
  }
  walk(root)
  return out
}

const ALL_TEXTS = Object.values(TEXT_TARGETS) // the five model-facing paths

/** The DC-T1 fixtures, verbatim from the fix contract §2.5 step 1 and step 6: not valid JSON, and
 *  valid JSON whose top level is an array. Both non-empty so a truncation is unmistakable. */
const CORRUPT_JSON = '{"mcp": {"graft": TRUNCATED-BY-CRASH'
const CORRUPT_ARRAY = '["not","an","object"]'

function seedCorruptConfig(home: string, bytes: string): { path: string; sha: string; size: number } {
  const p = join(configRoot(home), "swarm.json")
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, bytes)
  return { path: p, sha: sha(bytes), size: Buffer.byteLength(bytes) }
}

/** The launch seam row 197's lane uses (config_writer_d13.test.ts): lets the DIRECT writer call plan a
 *  real graft entry. The CLI has no such seam — that asymmetry is why the mcp.graft leg below runs
 *  through writeConfigEntries while every refusal leg runs through `main`. */
const okLaunch = () => ({
  ok: true as const,
  nodePath: "/home/u/.swarm/tools/node/v24/bin/node",
  cliPath: "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js",
})

function directOpts(b: string, extra: Partial<ConfigWriterOptions> = {}): ConfigWriterOptions {
  return {
    base: b,
    chain: { path: join(b, ".swarm", "setup", "audit.jsonl") },
    env: {},
    now: () => "2026-10-21T09:00:00.000Z",
    ...extra,
  }
}

function graftHealthyState(): ReturnType<typeof defaultState> {
  const s = defaultState("r200-merged-test-lock")
  s.components.graft.state = STATES.HEALTHY
  return s
}

// --- source slices for the call-site pins ---------------------------------------------------------
// Bounded per function so a tripwire can only speak about the verb it names (the discipline row 199
// established at wire_verb.test.ts:188-191: an unbounded slice reads into cmdRemove, which legitimately
// calls resolveSelected, and the assertion would be vacuous or spuriously red).
const SRC = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
const CMD_INSTALL_BODY = SRC.slice(SRC.indexOf("async function cmdInstall"), SRC.indexOf("/** Surface the writer's own result"))
const CMD_WIRE_BODY = SRC.slice(SRC.indexOf("function cmdWire"), SRC.indexOf("function cmdRemove"))
const CMD_REMOVE_BODY = SRC.slice(SRC.indexOf("function cmdRemove"), SRC.indexOf("export async function main"))
const MAIN_BODY = SRC.slice(SRC.indexOf("export async function main"))

describe("1. Merged-tree call sites — all three authors' load-bearing lines present in ONE file", () => {
  it("cmdInstall carries row 197's live-state writer call and the failure fold", () => {
    expect(CMD_INSTALL_BODY).toContain("writeConfigEntries({ state: st.state, lock: lockRes.lock })")
    expect(CMD_INSTALL_BODY).toContain("if (!wire.ok) return moreSevere(report.token, OUTCOME.FAILED)")
    // The call sits AFTER the dry-run early-return, so a dry run can never wire (contract §5.4).
    expect(CMD_INSTALL_BODY.indexOf("return OUTCOME.REFUSED_NO_CONSENT")).toBeLessThan(
      CMD_INSTALL_BODY.indexOf("writeConfigEntries"),
    )
  })

  it("cmdWire is a thin call over the SAME entry point, with no second engine and no selection rule", () => {
    expect(CMD_WIRE_BODY).toContain("writeConfigEntries({ state: st.state, lock: lockRes.lock })")
    // D10 shapes: none of the three forms the all-seven default actually lived in may appear.
    expect(CMD_WIRE_BODY).not.toContain("COMPONENT_IDS")
    expect(CMD_WIRE_BODY).not.toContain("resolveSelected")
    expect(CMD_WIRE_BODY).not.toMatch(/components\.length\s*>\s*0\s*\?/)
    // §4.2 "not a second engine": eligibility, backup naming and the ledger stay in the writer.
    // Code-form patterns only — the verb's own comments legitimately SAY "eligibility"/"healthy",
    // so a bare-word grep would fire on prose (caught by this lane's first run).
    expect(CMD_WIRE_BODY).not.toContain(".bak")
    expect(CMD_WIRE_BODY).not.toContain("config-writer.json")
    expect(CMD_WIRE_BODY).not.toMatch(/eligibility\s*\(/)
    expect(CMD_WIRE_BODY).not.toContain("STATES.HEALTHY")
  })

  it("cmdRemove carries row 198's SECOND refusal site (the half of D10 outside resolveSelected)", () => {
    expect(CMD_REMOVE_BODY).toContain("resolveSelected(cmd.components, cmd.nonInteractive)")
    expect(CMD_REMOVE_BODY).toContain('printNoSelectionRefusal("remove")')
    expect(CMD_REMOVE_BODY).toContain("OUTCOME.REFUSED_NO_SELECTION")
  })

  it("main() runs the entry gates before dispatching any verb, so REFUSED_ROOT keeps precedence structurally", () => {
    // Behavioural root-gate exercise needs euid 0 and stays UNKNOWN in this lane (labelled, not claimed);
    // what IS provable is the order of operations in the merged bytes: gate check precedes the switch.
    expect(MAIN_BODY.indexOf("runEntryGates()")).toBeLessThan(MAIN_BODY.indexOf("switch (cmd.verb)"))
  })
})

describe("2. D13 refusal through the merged product surface — row 199's verb driving row 197's fix", () => {
  // The scenario no single author could run: `wire` (199) reaches writeConfigEntries (197) against a
  // corrupt swarm.json. searxng healthy + proxy staged gives the planner a REAL swarm.json write to
  // attempt, so the refusal is decisive, not vacuous (contract §2.5 step 2).
  for (const [name, bytes] of [
    ["invalid JSON", CORRUPT_JSON],
    ["valid JSON, array top level", CORRUPT_ARRAY],
  ] as const) {
    it(`CLI wire refuses on ${name}: bytes survive at their path, nothing else appears (AC-T1..T4 source half)`, async () => {
      const h = mkdtempSync(join(tmpdir(), "r200-d13-cli-"))
      homes.push(h)
      seedState(h, ["searxng"])
      stageProxyBinary(h)
      const cfg = seedCorruptConfig(h, bytes)

      const r = await runCli(["wire"], h)
      expect(r.code).toBe(1)
      expect(r.out).toContain("RESULT FAILED")
      expect(r.err).toContain("wiring refused:")
      expect(r.err).toContain("existing swarm.json")

      // AC-T2: the ORIGINAL bytes at the ORIGINAL path — hash and non-zero size both unchanged.
      const after = readFileSync(cfg.path)
      expect(sha(after)).toBe(cfg.sha)
      expect(after.length).toBe(cfg.size)
      expect(after.length).toBeGreaterThan(0)

      // AC-T3 absence half: no backup, no ledger, no skill text anywhere the writer would put them.
      expect(baksUnder(configRoot(h))).toEqual([])
      expect(existsSync(join(h, ".swarm", "setup", "config-writer.json"))).toBe(false)
      for (const rel of ALL_TEXTS) expect(existsSync(join(configRoot(h), rel))).toBe(false)
    })
  }

  it("direct writer carries the conflict sentence verbatim for both branches (AC-T1 wording)", () => {
    for (const [bytes, needle] of [
      [CORRUPT_JSON, "existing swarm.json is not valid JSON"],
      [CORRUPT_ARRAY, "existing swarm.json top level is not an object"],
    ] as const) {
      const b = mkdtempSync(join(tmpdir(), "r200-d13-direct-"))
      homes.push(b)
      const cfgPath = configFilePath({ base: b })
      mkdirSync(dirname(cfgPath), { recursive: true })
      writeFileSync(cfgPath, bytes)
      const shaPre = sha(readFileSync(cfgPath))
      const sizePre = statSync(cfgPath).size

      const res = writeConfigEntries(directOpts(b, { state: graftHealthyState(), launch: okLaunch }))
      expect(res.ok).toBe(false)
      if (res.ok === false) expect(res.reason).toContain(needle)
      expect(sha(readFileSync(cfgPath))).toBe(shaPre)
      expect(statSync(cfgPath).size).toBe(sizePre)
      expect(baksUnder(join(b, ".config"))).toEqual([])
      expect(existsSync(join(b, ".swarm", "setup", "config-writer.json"))).toBe(false)
    }
  })

  it("the conflict check sits AFTER the symlink guard, so a symlinked corrupt target still reports symlink first (D13 fix ordering)", () => {
    // research/s6_01_seam_anchor.md D13 + row 197 §1.2: moving the conflict return earlier would flip
    // the pre-existing symlink behaviour. This pins the ORDERING, not just the refusal.
    const b = mkdtempSync(join(tmpdir(), "r200-d13-sym-"))
    homes.push(b)
    const cfgPath = configFilePath({ base: b })
    mkdirSync(dirname(cfgPath), { recursive: true })
    const real = join(b, "elsewhere.json")
    writeFileSync(real, CORRUPT_JSON) // corrupt AND symlinked: whichever guard is first decides the reason
    symlinkSync(real, cfgPath)

    const res = writeConfigEntries(directOpts(b, { state: graftHealthyState(), launch: okLaunch }))
    expect(res.ok).toBe(false)
    if (res.ok === false) {
      expect(res.reason).toContain("symlink")
      expect(res.reason).not.toContain("not valid JSON")
    }
    expect(sha(readFileSync(real))).toBe(sha(CORRUPT_JSON)) // never followed, never rewritten
  })
})

describe("3. Unnamed --non-interactive refuses on BOTH verbs before any consent read (row 198, merged)", () => {
  it("install refuses with REFUSED_NO_SELECTION, names the seven candidates, and consents nothing", async () => {
    const r = await runCli(["install", "--non-interactive"])
    expect(r.out).toContain("RESULT REFUSED_NO_SELECTION")
    expect(r.code).toBe(1)
    expect(r.err).toContain(`candidates: ${COMPONENT_IDS.join(", ")}`)
    expect(r.err).toContain("required form:")
    // "Before any consent read", behaviourally: the consent gate never speaks (its missing-token line
    // would name components), no consent.log exists anywhere, and the writer (row 197) is unreachable.
    expect(r.err).not.toContain("Missing --terms-token")
    expect(filesUnder(join(r.home, ".swarm")).filter((f) => f.includes("consent"))).toEqual([])
    expect(filesUnder(join(r.home, ".swarm"))).toEqual([]) // incl. lock dir released, zero residue
    expect(existsSync(configRoot(r.home))).toBe(false)
  })

  it("remove refuses with the SAME token — the second D10 site is independently live", async () => {
    const r = await runCli(["remove", "--non-interactive"])
    expect(r.out).toContain("RESULT REFUSED_NO_SELECTION")
    expect(r.code).toBe(1)
    expect(r.err).toContain("remove --non-interactive named no component")
    expect(filesUnder(join(r.home, ".swarm"))).toEqual([])
  })

  it("DC-S2 edge: a terms token acknowledges, it does not select (still REFUSED_NO_SELECTION)", async () => {
    const r = await runCli(["install", "--non-interactive", "--terms-token", "graft=graft@deadbeef1234"])
    expect(r.out).toContain("RESULT REFUSED_NO_SELECTION")
    expect(r.code).toBe(1)
  })

  it("pre-existing gates keep precedence on the merged bytes: held lock outranks the new refusal", async () => {
    const h = mkdtempSync(join(tmpdir(), "r200-order-"))
    homes.push(h)
    const lockDir = join(h, ".swarm", "setup", "lock")
    mkdirSync(lockDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(lockDir, "pid"), `${process.pid}\n`) // live pid -> acquireLock refuses concurrency
    const r = await runCli(["install", "--non-interactive"], h)
    expect(r.out).toContain("RESULT REFUSED_CONCURRENCY")
    expect(r.out).not.toContain("REFUSED_NO_SELECTION")
    rmSync(lockDir, { recursive: true, force: true })
  })

  it("pre-existing gates keep precedence: a malformed tools.lock.json outranks the new refusal", async () => {
    // Safe to corrupt because isolateSourceLock() gave THIS FILE a private program dir; restore after.
    const lockCopy = join(dirname(process.execPath), "tools.lock.json")
    const keep = join(dirname(process.execPath), "tools.lock.json.r200keep")
    copyFileSync(lockCopy, keep)
    try {
      writeFileSync(lockCopy, "{ not json at all\n")
      const r = await runCli(["install", "--non-interactive"])
      expect(r.out).toContain("RESULT REFUSED_LOCK_MALFORMED")
      expect(r.out).not.toContain("REFUSED_NO_SELECTION")
    } finally {
      copyFileSync(keep, lockCopy)
      rmSync(keep, { force: true })
    }
  })

  it("AC-S3 contrast: named components still reach the consent gate — the refusal is about silence", async () => {
    const r = await runCli(["install", "node", "graft", "rtk", "--non-interactive"])
    expect(r.out).toContain("RESULT REFUSED_NON_INTERACTIVE")
    expect(r.out).not.toContain("REFUSED_NO_SELECTION")
    expect(r.err).toContain("Missing --terms-token for: node, graft, rtk")
    // Consent refused -> durable consent.log never appears, and the writer is unreachable behind it.
    expect(filesUnder(join(r.home, ".swarm")).filter((f) => f.includes("consent"))).toEqual([])
    expect(existsSync(configRoot(r.home))).toBe(false)
  })
})

describe("4. wire scope follows health, never arguments (row 199 + D10 cannot resurrect)", () => {
  it("all seven absent: zero files under ~/.config/swarm, SKIPPED_WITH_INSTRUCTIONS, never OK", async () => {
    const r = await runCli(["wire"])
    expect(r.out).toContain("RESULT SKIPPED_WITH_INSTRUCTIONS")
    expect(r.out).not.toContain("RESULT OK")
    expect(r.code).toBe(0)
    expect(filesUnder(configRoot(r.home))).toEqual([]) // an all-seven default would have attempted writes
    expect(r.out).toContain("graft component is not healthy (P-15)")
    expect(r.out).toContain("searxng component is not healthy (P-15)")
    expect(r.out).toContain("drift check compared 0 file(s)") // §5.3: the vacuous count is NAMED
  })

  it("only rtk healthy: the rtk text lands, swarm.json is NOT even planned, other texts name their gates", async () => {
    const h = mkdtempSync(join(tmpdir(), "r200-rtk-"))
    homes.push(h)
    seedState(h, ["rtk"])
    const r = await runCli(["wire"], h)
    expect(existsSync(join(configRoot(h), TEXT_TARGETS.rtk))).toBe(true)
    expect(existsSync(join(configRoot(h), "swarm.json"))).toBe(false) // empty entry set -> no config plan
    expect(r.out).toContain(`wire ${TEXT_TARGETS.agentResearcher}: skipped — swarmWeb`)
    expect(r.out).toContain(`wire ${TEXT_TARGETS.graft}: skipped — graft`)
    expect(r.out).toContain(`wire ${TEXT_TARGETS.obsidianInbox}: skipped — obsidian`)
    expect(r.out).toContain("drift check compared 1 file(s)")
    expect(r.out).toContain("RESULT SKIPPED_WITH_INSTRUCTIONS")
  })

  it("AC-V1 deletes nothing: a user key and an unrelated file survive a real write", async () => {
    const h = mkdtempSync(join(tmpdir(), "r200-acv1-"))
    homes.push(h)
    seedState(h, ["searxng", "rtk"])
    stageProxyBinary(h)
    const cfgPath = join(configRoot(h), "swarm.json")
    mkdirSync(dirname(cfgPath), { recursive: true })
    writeFileSync(cfgPath, JSON.stringify({ permissions: { keep: "me" } }, null, 2) + "\n")
    const unrelated = join(configRoot(h), "skills", "someone-else", "SKILL.md")
    mkdirSync(dirname(unrelated), { recursive: true })
    writeFileSync(unrelated, "user content, not ours\n")
    const unrelatedSha = sha(readFileSync(unrelated))

    const r = await runCli(["wire"], h)
    expect(r.out).toContain("wire: wrote")
    const written = JSON.parse(readFileSync(cfgPath, "utf8"))
    expect(written.permissions).toEqual({ keep: "me" }) // merge preserved the user key
    expect(written.mcp?.["swarm-web"]).toBeDefined() // and the eligible entry landed
    expect(sha(readFileSync(unrelated))).toBe(unrelatedSha)
  })
})

describe("5. Idempotence with the audit appendix stated honestly (AC-V2 + row 199's disclosed residue)", () => {
  it("second wire: config frozen, no backups, mtimes unmoved — while audit.jsonl legitimately grows", async () => {
    const h = mkdtempSync(join(tmpdir(), "r200-idem-"))
    homes.push(h)
    seedState(h, ["searxng", "rtk"])
    stageProxyBinary(h)

    const run1 = await runCli(["wire"], h)
    expect(run1.out).toContain("wire: wrote") // a real write first, so the no-op claim is not vacuous

    const manifest1 = manifest(configRoot(h))
    const mtimes1 = mtimes(configRoot(h))
    const auditPath = join(h, ".swarm", "setup", "audit.jsonl")
    const audit1 = existsSync(auditPath) ? readFileSync(auditPath, "utf8") : ""
    expect(audit1).toContain('"tool_launch"') // swarm-web eligible -> line appended per eligible run

    // Past APFS mtime granularity — the >1.2 s spin row 199 used for the same instrument.
    const t0 = Date.now()
    while (Date.now() - t0 < 1300) { /* spin */ }

    const run2 = await runCli(["wire"], h)
    expect(run2.out).toContain("wire: no change (already current)") // honest wording, not dressed up
    expect(run2.code).toBe(0)

    // WHAT IT MUST NOT TOUCH: every config byte and every mtime identical, zero .bak files.
    expect(manifest(configRoot(h))).toEqual(manifest1)
    expect(mtimes(configRoot(h))).toEqual(mtimes1)
    expect(baksUnder(configRoot(h))).toEqual([])

    // WHAT IT LEGITIMATELY TOUCHES: the audit chain is append-only and DID grow — the second run
    // re-emitted its tool_launch line (config_writer.ts desiredEntries fires on eligibility, not on
    // change). Asserting this pair is what closes the gap row 199 named (s6_r199_wire_verb.md §3):
    // "no change" holds for ~/.config/swarm and is stated honestly for ~/.swarm/setup.
    const audit2 = readFileSync(auditPath, "utf8")
    expect(audit2.length).toBeGreaterThan(audit1.length)
    expect(audit2.startsWith(audit1)).toBe(true) // prior bytes untouched — append, never rewrite
    const added = audit2.slice(audit1.length).trim().split("\n").map((l) => JSON.parse(l) as { kind?: string })
    expect(added.length).toBeGreaterThan(0)
    for (const line of added) expect(line.kind).toBe("tool_launch")
  })

  it("the writer's own fields corroborate the no-op (changed:false, no backup) — the line DC-V1 breaks", () => {
    const b = mkdtempSync(join(tmpdir(), "r200-idem-direct-"))
    homes.push(b)
    stageProxyBinary(b)
    const s = defaultState("r200-merged-test-lock")
    s.components.searxng.state = STATES.HEALTHY
    const first = writeConfigEntries(directOpts(b, { state: s }))
    expect(first.ok).toBe(true)
    if (first.ok) expect(first.changed).toBe(true)

    const second = writeConfigEntries(directOpts(b, { state: s }))
    expect(second.ok).toBe(true)
    if (second.ok) {
      expect(second.changed).toBe(false)
      expect(second.backupPath).toBeNull()
      expect(second.backups).toEqual([])
    }
  })
})

describe("6. Wiring after health produces mcp.graft plus the five texts in a throwaway HOME (source-level AC-W2 shape)", () => {
  it("eligible graft yields the sanctioned argv + DO_NOT_TRACK=1, and all five texts byte-equal a fresh render", () => {
    const b = mkdtempSync(join(tmpdir(), "r200-graft-"))
    homes.push(b)
    stageProxyBinary(b)
    const s = defaultState("r200-merged-test-lock")
    for (const id of ["graft", "searxng", "rtk", "obsidian"] as const) s.components[id].state = STATES.HEALTHY

    const res = writeConfigEntries(directOpts(b, { state: s, launch: okLaunch }))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.wrote.graft).toBe(true)
      expect(res.wrote.swarmWeb).toBe(true)
      expect(res.wrote.skills.length).toBe(ALL_TEXTS.length)
    }

    const cfg = JSON.parse(readFileSync(configFilePath({ base: b }), "utf8"))
    expect(Object.keys(cfg.mcp).sort()).toEqual(["graft", "swarm-web"])
    expect(cfg.mcp.graft.command).toEqual([okLaunch().nodePath, okLaunch().cliPath, "mcp"]) // AC-W2 argv
    expect(cfg.mcp.graft.env.DO_NOT_TRACK).toBe("1")
    expect(cfg.mcp.graft.enabled).toBe(true)

    const texts = renderSkillTexts()
    const rendered: Record<string, string> = {
      [TEXT_TARGETS.agentResearcher]: texts.agentResearcherMd,
      [TEXT_TARGETS.swarmResearch]: texts.skillSwarmResearchMd,
      [TEXT_TARGETS.graft]: texts.skillGraftMd,
      [TEXT_TARGETS.rtk]: texts.skillRtkMd,
      [TEXT_TARGETS.obsidianInbox]: texts.skillObsidianInboxMd,
    }
    for (const [rel, want] of Object.entries(rendered))
      expect(readFileSync(join(configDir(b), rel), "utf8")).toBe(want)

    // Positive control for the ledger: writes happening -> ledger EXISTS (the D13 cases above assert
    // it does NOT when the run refuses). And the drift gate reports its real count, per §5.3.
    expect(existsSync(join(b, ".swarm", "setup", "config-writer.json"))).toBe(true)
    const check = checkSkillFiles(directOpts(b, { state: s, launch: okLaunch }))
    expect(check.ok).toBe(true)
    expect(check.checked.length).toBe(5)
  })

  it("graft recorded healthy WITHOUT staged resolver facts: entry refused by the launch guard, text still gated healthy, no fabricated swarm.json", async () => {
    // The CLI has no launch seam (row 199 §2.4), so this is the shipped posture on a machine whose
    // state says healthy but whose disk has no staged graft CLI. The writer separates "not healthy"
    // from "guard refused"; the run must not print OK and must not invent an entry.
    const h = mkdtempSync(join(tmpdir(), "r200-guard-"))
    homes.push(h)
    seedState(h, ["graft"])
    const r = await runCli(["wire"], h)
    expect(r.code).toBe(0)
    expect(r.out).not.toContain("RESULT OK")
    expect(r.out).toContain("RESULT SKIPPED_WITH_INSTRUCTIONS")
    expect(r.out).toContain("wire graft: skipped —")
    expect(r.out).not.toContain("graft component is not healthy") // the state DOES say healthy
    expect(existsSync(join(configRoot(h), "swarm.json"))).toBe(false) // refused entry -> nothing to merge
    expect(existsSync(join(configRoot(h), TEXT_TARGETS.graft))).toBe(true) // text gate is state-derived
  })
})
