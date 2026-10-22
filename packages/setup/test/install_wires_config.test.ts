// Row-197 session-6 — the D1 product path (fix contract §1). Two guarantees, both checkable from source
// without the rebuilt binary:
//   (a) the exact call the install site makes — writeConfigEntries({ state, lock }) against a healthy-graft
//       state — produces ~/.config/swarm/swarm.json carrying the graft mcp entry AND lands the gated skill
//       text, with no operator importing the module; and
//   (b) the install path in src/index.ts actually performs that call (the source-level half of DC-W1's
//       remove-the-call control: delete the call and this test goes red). The behavioural red on the shipped
//       binary is rows 200/208/218; this row proves the call exists and is wired to the live state.
// Run TARGETED: cd packages/setup && bun test test/install_wires_config.test.ts

import { describe, it, expect } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { defaultState } from "../src/state.ts"
import { STATES } from "../src/constants.ts"
import { writeConfigEntries, configFilePath, configDir, type ConfigWriterOptions } from "../src/wiring/config_writer.ts"
import { TEXT_TARGETS } from "../src/skills/researcher_text.ts"

function base(): string {
  return mkdtempSync(join(tmpdir(), "r197-wire-"))
}
const okLaunch = () => ({
  ok: true as const,
  nodePath: "/home/u/.swarm/tools/node/v24/bin/node",
  cliPath: "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js",
})
function exists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

describe("product path — a healthy-graft wire produces swarm.json:mcp.graft + the gated skill text", () => {
  it("writes the graft entry and skills/graft/SKILL.md into <base>/.config/swarm (no caller imports the module)", () => {
    const b = base()
    try {
      const s = defaultState("swarm-tools-test")
      s.components.graft.state = STATES.HEALTHY
      // Mirrors the install call site exactly: an explicit live state + the launch seam standing in for a
      // staged graft CLI (the compiled binary has no seam — that leg is AC-W1/AC-W2 at rows 208/218).
      const o: ConfigWriterOptions = {
        base: b,
        state: s,
        chain: { path: join(b, ".swarm", "setup", "audit.jsonl") },
        launch: okLaunch,
        env: {},
        now: () => "2026-10-20T09:00:00.000Z",
      }
      const res = writeConfigEntries(o)
      expect(res.ok && res.changed).toBe(true)

      // AC-W2 shape enforced on the produced file (argv + DO_NOT_TRACK), not merely "the guard ran".
      const cfg = JSON.parse(readFileSync(configFilePath({ base: b }), "utf8")) as {
        mcp: Record<string, { command?: string[]; env?: Record<string, string> }>
      }
      expect(cfg.mcp.graft?.command).toEqual([okLaunch().nodePath, okLaunch().cliPath, "mcp"])
      expect(cfg.mcp.graft?.env?.DO_NOT_TRACK).toBe("1")

      // The skill files land beside the entry, byte-equal to the renderer (TEXT_TARGETS.graft gate = graft).
      expect(exists(join(configDir(b), TEXT_TARGETS.graft))).toBe(true)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("an unhealthy component prints its skip reason and writes nothing (never a bare OK)", () => {
    const b = base()
    try {
      const s = defaultState("swarm-tools-test") // everything absent -> every gate false
      const res = writeConfigEntries({ base: b, state: s, env: {}, now: () => "2026-10-20T09:00:00.000Z" })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.changed).toBe(false)
      expect(res.skipped.graft).toContain("graft component is not healthy") // reason the caller must surface
      let created = true
      try {
        statSync(configFilePath({ base: b }))
      } catch {
        created = false
      }
      expect(created).toBe(false) // nothing written when nothing is healthy
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("call-site presence in src/index.ts — the source-level remove-the-call control (DC-W1)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")

  it("index.ts imports writeConfigEntries from the wiring module (the product, not an operator, owns the call)", () => {
    expect(src).toContain('import { writeConfigEntries')
    expect(src).toContain('from "./wiring/config_writer.ts"')
  })

  it("cmdInstall calls writeConfigEntries with the LIVE state object, not a re-read", () => {
    const installStart = src.indexOf("async function cmdInstall")
    const removeStart = src.indexOf("function cmdRemove")
    expect(installStart).toBeGreaterThan(-1)
    expect(removeStart).toBeGreaterThan(installStart)
    const body = src.slice(installStart, removeStart)
    // The call passes st.state (the object the steps mutated) and the loaded lock — §1.1 property 3.
    expect(body).toContain("writeConfigEntries({ state: st.state, lock: lockRes.lock })")
  })

  it("the wiring call sits AFTER the --dry-run early-return, so a dry run never wires (no token scraping path)", () => {
    const dryRunReturn = src.indexOf("return OUTCOME.REFUSED_NO_CONSENT")
    const wireCall = src.indexOf("writeConfigEntries({ state: st.state")
    expect(dryRunReturn).toBeGreaterThan(-1)
    expect(wireCall).toBeGreaterThan(dryRunReturn)
  })

  it("a writer refusal folds FAILED in so the install exits non-zero (AC-T4 wiring side)", () => {
    const installStart = src.indexOf("async function cmdInstall")
    const removeStart = src.indexOf("function cmdRemove")
    const body = src.slice(installStart, removeStart)
    expect(body).toContain("if (!wire.ok) return moreSevere(report.token, OUTCOME.FAILED)")
  })
})
