// U14 row 221 — the proxy stager. Before this row nothing copied swarm-web-proxy into PC-PATH-14, so the
// writer's existsSync gate always skipped swarm-web ("proxy binary not staged at PC-PATH-14").
//
// WHAT THIS LANE PROVES, in a throwaway HOME (never the user's):
//   1. a proxy beside the program lands at PC-PATH-14 with mode 0755 and the SAME sha256, and the writer then
//      prints `wire: wrote ...swarm.json:mcp.swarm-web` with the staged path as the command;
//   2. with no source the stager writes nothing and the writer's old skip reason is unchanged;
//   3. a second stage is a no-op; a stale or wrong-mode copy is replaced; a symlink at the target is refused;
//   4. cmdInstall stages BEFORE it calls the writer, and folds a refused stage into FAILED (source pin).
//
// Run TARGETED: cd packages/setup && bun test test/proxy_stage.test.ts

import { describe, it, expect, afterAll, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stageProxyBinary, PROXY_MODE } from "../src/wiring/proxy_stage.ts"
import { writeConfigEntries, configFilePath } from "../src/wiring/config_writer.ts"
import { printWiringOutcome, printProxyStageOutcome, stageProxyForWiring } from "../src/index.ts"
import { defaultState } from "../src/state.ts"
import { STATES } from "../src/constants.ts"
import { PROXY_BINARY_NAME } from "../src/mcpproxy/register.ts"

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function fresh(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}

/** A fake program directory holding a fake proxy (bytes are arbitrary; nothing executes it). */
function programWithProxy(bytes = "#!/bin/sh\necho swarm-web-proxy fixture\n"): { dir: string; sha: string } {
  const dir = fresh("r221-prog-")
  writeFileSync(join(dir, PROXY_BINARY_NAME), bytes, { mode: 0o644 })
  return { dir, sha: sha(readFileSync(join(dir, PROXY_BINARY_NAME))) }
}

function sha(b: Uint8Array): string {
  return createHash("sha256").update(b).digest("hex")
}

const target = (home: string) => join(home, ".swarm", "setup", "bin", PROXY_BINARY_NAME)

function searxngHealthy() {
  const s = defaultState("swarm-tools-test")
  s.components.searxng.state = STATES.HEALTHY
  return s
}

function captureLog(fn: () => void): string {
  let out = ""
  const spy = spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out += `${a.map(String).join(" ")}\n`
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return out
}

describe("1. proxy beside the program -> PC-PATH-14 0755, same hash, swarm-web wired", () => {
  it("stages the copy and the writer reports wire: wrote ... swarm-web", () => {
    const home = fresh("r221-home-")
    const prog = programWithProxy()

    const stage = stageProxyBinary({ base: home, programDir: prog.dir })
    expect(stage).toMatchObject({ ok: true, staged: true, changed: true, sha256: prog.sha })
    const st = statSync(target(home))
    expect(st.mode & 0o777).toBe(PROXY_MODE)
    expect(sha(readFileSync(target(home)))).toBe(prog.sha)
    expect(statSync(join(home, ".swarm", "setup", "bin")).mode & 0o777).toBe(0o700)

    const wire = writeConfigEntries({ base: home, state: searxngHealthy(), env: {}, chain: { path: join(home, ".swarm", "setup", "audit.jsonl") }, now: () => "2026-11-02T00:00:00.000Z" })
    expect(wire.ok && wire.wrote.swarmWeb).toBe(true)
    const out = captureLog(() => printWiringOutcome(wire))
    expect(out).toMatch(/^wire: wrote .*swarm\.json:mcp\.swarm-web/m)
    const cfg = JSON.parse(readFileSync(configFilePath({ base: home }), "utf8")) as {
      mcp: Record<string, { command?: string[] }>
    }
    expect(cfg.mcp["swarm-web"]?.command?.[0]).toBe(target(home))

    const printed = captureLog(() => printProxyStageOutcome(stage))
    expect(printed).toContain(`stage ${PROXY_BINARY_NAME}: copied (sha256 ${prog.sha.slice(0, 12)})`)
    // the stager's audit line lands in the fixture's setup.log, not the user's
    expect(readFileSync(join(home, ".swarm", "setup", "setup.log"), "utf8")).toContain("staged swarm-web-proxy")
  })
})

describe("2. no source -> nothing written, the writer's old skip reason stays", () => {
  it("skips with a reason and swarm-web is skipped as 'proxy binary not staged at PC-PATH-14'", () => {
    const home = fresh("r221-home-")
    const emptyProg = fresh("r221-prog-")

    const stage = stageProxyBinary({ base: home, programDir: emptyProg })
    expect(stage.ok).toBe(true)
    expect(stage.ok && stage.staged).toBe(false)
    expect(existsSync(target(home))).toBe(false)
    expect(existsSync(join(home, ".swarm"))).toBe(false) // not even the bin dir

    const wire = writeConfigEntries({ base: home, state: searxngHealthy(), env: {}, chain: { path: join(home, ".swarm", "setup", "audit.jsonl") }, now: () => "2026-11-02T00:00:00.000Z" })
    expect(wire.ok).toBe(true)
    if (!wire.ok) return
    expect(wire.skipped.swarmWeb).toBe("proxy binary not staged at PC-PATH-14")
    expect(captureLog(() => printWiringOutcome(wire))).toContain("wire swarm-web: skipped — proxy binary not staged at PC-PATH-14")
    expect(captureLog(() => printProxyStageOutcome(stage))).toContain(`stage ${PROXY_BINARY_NAME}: skipped — `)
  })
})

describe("3. idempotence, replacement and refusal", () => {
  it("a second stage is a no-op with the same hash", () => {
    const home = fresh("r221-home-")
    const prog = programWithProxy()
    stageProxyBinary({ base: home, programDir: prog.dir })
    const before = statSync(target(home)).mtimeMs
    const again = stageProxyBinary({ base: home, programDir: prog.dir })
    expect(again).toMatchObject({ ok: true, staged: true, changed: false, sha256: prog.sha })
    expect(statSync(target(home)).mtimeMs).toBe(before)
  })

  it("a stale copy (different bytes) and a wrong-mode copy are both replaced", () => {
    const home = fresh("r221-home-")
    const prog = programWithProxy("new proxy bytes\n")
    mkdirSync(join(home, ".swarm", "setup", "bin"), { recursive: true, mode: 0o700 })
    writeFileSync(target(home), "old proxy bytes\n", { mode: 0o755 })
    expect(stageProxyBinary({ base: home, programDir: prog.dir })).toMatchObject({ ok: true, changed: true })
    expect(sha(readFileSync(target(home)))).toBe(prog.sha)

    chmodSync(target(home), 0o644)
    expect(stageProxyBinary({ base: home, programDir: prog.dir })).toMatchObject({ ok: true, changed: true })
    expect(statSync(target(home)).mode & 0o777).toBe(PROXY_MODE)
  })

  it("a symlink at PC-PATH-14 is refused and left untouched", () => {
    const home = fresh("r221-home-")
    const prog = programWithProxy()
    const elsewhere = join(fresh("r221-else-"), "victim")
    writeFileSync(elsewhere, "do not touch\n")
    mkdirSync(join(home, ".swarm", "setup", "bin"), { recursive: true, mode: 0o700 })
    symlinkSync(elsewhere, target(home))

    const stage = stageProxyBinary({ base: home, programDir: prog.dir })
    expect(stage.ok).toBe(false)
    expect(lstatSync(target(home)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(target(home))).toBe(elsewhere)
    expect(readFileSync(elsewhere, "utf8")).toBe("do not touch\n")
  })

  it("an empty source is refused rather than staged", () => {
    const home = fresh("r221-home-")
    const prog = programWithProxy("")
    expect(stageProxyBinary({ base: home, programDir: prog.dir }).ok).toBe(false)
    expect(existsSync(target(home))).toBe(false)
  })
})

describe("4. cmdInstall stages before it wires (source pin)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
  const body = src.slice(src.indexOf("async function cmdInstall"), src.indexOf("/** Surface the writer's own result"))

  it("the stage call precedes the writer call and its failure folds FAILED", () => {
    const stageAt = body.indexOf("stageProxyForWiring(st.state)")
    const wireAt = body.indexOf("writeConfigEntries({ state: st.state, lock: lockRes.lock })")
    expect(stageAt).toBeGreaterThan(-1)
    expect(wireAt).toBeGreaterThan(stageAt)
    expect(body.indexOf("return OUTCOME.REFUSED_NO_CONSENT")).toBeLessThan(stageAt) // a dry run never stages
    expect(body).toContain("if (!stage.ok) return moreSevere(report.token, OUTCOME.FAILED)")
  })
})

describe("5. no copy when swarm-web cannot be wired (senior 239 finding 15)", () => {
  it("searxng not healthy: nothing is written, and the writer's own skip reason is unchanged", () => {
    const home = fresh("r247-home-")
    const prog = programWithProxy()
    for (const state of [STATES.ABSENT, STATES.FAILED, STATES.INSTALLED]) {
      const s = defaultState("swarm-tools-test")
      s.components.searxng.state = state
      s.components.node.state = STATES.HEALTHY
      const stage = stageProxyForWiring(s, { base: home, programDir: prog.dir })
      expect(stage).toEqual({ ok: true, staged: false, reason: "searxng component is not healthy (P-15)" })
      expect(existsSync(target(home))).toBe(false)
      const wire = writeConfigEntries({ base: home, state: s, env: {}, chain: { path: join(home, ".swarm", "setup", "audit.jsonl") }, now: () => "2026-11-02T00:00:00.000Z" })
      expect(wire.ok && wire.skipped.swarmWeb).toBe("searxng component is not healthy (P-15)")
    }
    expect(existsSync(target(home))).toBe(false)
  })

  it("searxng healthy: the copy is staged exactly as stageProxyBinary does", () => {
    const home = fresh("r247-home-")
    const prog = programWithProxy()
    const stage = stageProxyForWiring(searxngHealthy(), { base: home, programDir: prog.dir })
    expect(stage.ok && stage.staged && stage.sha256).toBe(prog.sha)
    expect(sha(readFileSync(target(home)))).toBe(prog.sha)
  })
})

describe("6. layout of index.ts (senior 239 finding 14)", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "index.ts"), "utf8")
  it("each JSDoc sits directly above the function it documents", () => {
    expect(src).toMatch(/to the gate the skip was recorded under, so no reason string ever goes unexplained\. \*\/\nfunction wireGateOfReason\(/)
    expect(src).toMatch(/\/\*\* The proxy stager's result, verbatim \(row 221\)\. \*\/\nexport function printProxyStageOutcome\(/)
    expect(src).not.toMatch(/\*\/\n\/\*\*/)
  })
})
