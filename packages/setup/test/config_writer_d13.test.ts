// Row-197 session-6 — drift D13 destructive case (fix contract §2.5 / AC-T1..AC-T4) plus the
// idempotence byte+time corroboration (§4.3) and the CONFIG PATH resolution decision.
//
// WHY THIS FILE EXISTS SEPARATELY: the shared lane `config_writer.test.ts` is row 200's surface; this
// row owns the truncation fix and its decisive test, so the destructive case lives here and never edits
// the shared file. No HOME mutation for the writer cases (every write path is driven off an explicit
// `base`); the one env-touching case (XDG resolution) saves and restores process.env around itself.
// Run TARGETED: cd packages/setup && bun test test/config_writer_d13.test.ts

import { describe, it, expect } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { defaultState } from "../src/state.ts"
import { STATES } from "../src/constants.ts"
import {
  writeConfigEntries,
  configFilePath,
  configDir,
  type ConfigWriterOptions,
} from "../src/wiring/config_writer.ts"
import { atomicWriteText } from "../src/atomic.ts"
import { MODES } from "../src/constants.ts"
import { TEXT_TARGETS } from "../src/skills/researcher_text.ts"

function base(): string {
  return mkdtempSync(join(tmpdir(), "r197-d13-"))
}
function shaBytes(buf: Uint8Array | string): string {
  return createHash("sha256").update(buf instanceof Uint8Array ? buf : Buffer.from(buf, "utf8")).digest("hex")
}
function stageProxyBinary(b: string): string {
  const p = join(b, ".swarm", "setup", "bin", "swarm-web-proxy")
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, "#!/bin/sh\n")
  return p
}
const okLaunch = () => ({
  ok: true as const,
  nodePath: "/home/u/.swarm/tools/node/v24/bin/node",
  cliPath: "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js",
})
// graft healthy => the planner DOES want to write swarm.json, so the merge actually runs against the
// corrupt bytes. Without a healthy component the plan is empty and the writer returns early (a vacuous
// pass that proves nothing — fix contract §2.5 step 2).
function graftHealthy() {
  const s = defaultState("swarm-tools-test")
  s.components.graft.state = STATES.HEALTHY
  return s
}
function opts(b: string): ConfigWriterOptions {
  return {
    base: b,
    chain: { path: join(b, ".swarm", "setup", "audit.jsonl") },
    launch: okLaunch,
    env: {},
    now: () => "2026-10-20T09:00:00.000Z",
  }
}
function countBaks(b: string): number {
  try {
    return readdirSync(join(b, ".config", "swarm")).filter((n) => n.endsWith(".bak")).length
  } catch {
    return 0
  }
}
function ledgerExists(b: string): boolean {
  try {
    statSync(join(b, ".swarm", "setup", "config-writer.json"))
    return true
  } catch {
    return false
  }
}
function exists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

describe("D13 AC-T1..AC-T4 — unparseable swarm.json is refused, bytes survive AT THEIR PATH", () => {
  it("invalid-JSON bytes are left byte-identical at swarm.json; refusal carries the conflict sentence", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      // Known invalid, NON-EMPTY bytes (fix contract §2.5 step 1 verbatim fixture).
      const corrupt = '{"mcp": {"graft": TRUNCATED-BY-CRASH'
      const cfgPath = configFilePath({ base: b })
      writeFileSync(cfgPath, corrupt, { encoding: "utf8", mode: 0o600 })
      const shaPre = shaBytes(corrupt)
      const sizePre = Buffer.byteLength(corrupt, "utf8")

      const res = writeConfigEntries({ ...opts(b), state: graftHealthy() })

      // AC-T1: refuses, carrying the conflict text it already computed (:262 sentence).
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toContain("existing swarm.json is not valid JSON")

      // AC-T2: the ORIGINAL bytes survive AT THE ORIGINAL PATH — not merely "somewhere".
      expect(shaBytes(readFileSync(cfgPath))).toBe(shaPre) // shasum before == after, at that path
      expect(statSync(cfgPath).size).toBe(sizePre) // still its original non-zero size (never truncated)

      // AC-T3: refusal happened BEFORE any target was touched — no backup, no ledger, no skill text.
      expect(countBaks(b)).toBe(0)
      expect(ledgerExists(b)).toBe(false)
      expect(exists(join(configDir(b), TEXT_TARGETS.graft))).toBe(false) // graft was eligible yet unwritten
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("valid-JSON-but-array-topped is refused on the second branch (:265), bytes untouched", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const corrupt = '["not","an","object"]'
      const cfgPath = configFilePath({ base: b })
      writeFileSync(cfgPath, corrupt, { encoding: "utf8", mode: 0o600 })
      const shaPre = shaBytes(corrupt)

      const res = writeConfigEntries({ ...opts(b), state: graftHealthy() })

      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toContain("existing swarm.json top level is not an object")
      expect(shaBytes(readFileSync(cfgPath))).toBe(shaPre)
      expect(countBaks(b)).toBe(0)
      expect(ledgerExists(b)).toBe(false)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("D13 negative control — the chosen assertion distinguishes 'backup exists' from 'original untouched'", () => {
  // The named trap (fix contract §2.5): the UNFIXED writer already created a hash-named backup of the
  // corrupt content BEFORE truncating the target (config_writer.ts:388-393 backup, :402 replace). So a
  // test phrased "the original bytes still exist SOMEWHERE" is satisfied by that .bak and PASSES on the
  // buggy code. This control reproduces the pre-fix write sequence BY HAND on a throwaway dir and shows
  // the two assertions diverge on the SAME fixture: the weak backup-search check reports "fine", the
  // strong original-path check reports the loss. It proves the destructive test above is decisive rather
  // than accidentally permissive. It does not import or depend on the removed buggy branch.
  it("models the pre-fix backup-then-truncate: a .bak search passes while the original-path check fails", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const corrupt = '{"mcp": {"graft": TRUNCATED-BY-CRASH'
      const cfgPath = configFilePath({ base: b })
      writeFileSync(cfgPath, corrupt, { encoding: "utf8", mode: 0o600 })
      const shaPre = shaBytes(corrupt)

      // --- reproduce exactly what the unfixed loop did: durable hash-named backup, then commit empty bytes
      const bak = join(dirname(cfgPath), `swarm.json.${shaPre.slice(0, 12)}.20261020T090000.bak`)
      atomicWriteText(bak, corrupt, MODES.FILE_0600) // :388-393 — backup of the corrupt content
      atomicWriteText(cfgPath, "", MODES.FILE_0600) // :402 — the empty desired bytes land (truncation)

      // Weak assertion ("bytes exist somewhere"): TRUE on the buggy sequence -> would misreport as fixed.
      const bytesExistSomewhere = readdirSync(join(b, ".config", "swarm"))
        .filter((n) => n.endsWith(".bak"))
        .some((n) => shaBytes(readFileSync(join(b, ".config", "swarm", n))) === shaPre)
      expect(bytesExistSomewhere).toBe(true) // the trap: this passes even though data was lost

      // Strong assertion (what the real test uses): FALSE on the buggy sequence -> catches the defect.
      const originalUntouchedAtItsPath = shaBytes(readFileSync(cfgPath)) === shaPre
      expect(originalUntouchedAtItsPath).toBe(false) // the original path was truncated to zero bytes
      expect(statSync(cfgPath).size).toBe(0)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("idempotence (§4.3) — second run is changed:false corroborated by bytes AND mtime (find -newer)", () => {
  function sleep(ms: number): void {
    const end = Date.now() + ms
    while (Date.now() < end) {
      /* synchronous spin so the gap exceeds APFS mtime granularity without an async test wrapper */
    }
  }

  it("re-running over unchanged inputs leaves swarm.json bytes and mtime untouched", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const s = defaultState("swarm-tools-test")
      s.components.graft.state = STATES.HEALTHY
      s.components.searxng.state = STATES.HEALTHY
      const o = { ...opts(b), state: s, estate: { searxngUrl: "http://127.0.0.1:9021" } }

      const first = writeConfigEntries(o)
      expect(first.ok && first.changed).toBe(true)
      const cfgPath = configFilePath({ base: b })
      const bytesAfterFirst = readFileSync(cfgPath)
      sleep(60)
      const mtimeAfterFirst = statSync(cfgPath).mtimeMs
      const baksAfterFirst = countBaks(b)

      const second = writeConfigEntries(o)
      expect(second.ok && second.changed).toBe(false) // the writer's own no-op contract (:407-409)

      // Byte corroboration: identical bytes...
      expect(Buffer.from(readFileSync(cfgPath)).equals(Buffer.from(bytesAfterFirst))).toBe(true)
      // ...and the file was not rewritten at all (the in-test analogue of `find -newer` returning nothing):
      expect(statSync(cfgPath).mtimeMs).toBe(mtimeAfterFirst)
      expect(countBaks(b)).toBe(baksAfterFirst) // no new backup created on the no-op run
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("CONFIG PATH resolution decision — writer default dir matches the product's xdg-basedir", () => {
  // research/s6_04_route_impact.md: the server resolves config via xdg-basedir (global.ts:13), which
  // honours an ABSOLUTE $XDG_CONFIG_HOME and otherwise falls back to $HOME/.config. The wiring call must
  // resolve the same way so an installer never writes where the product will not read. These cases pin
  // both halves of that rule against configDir()/configFilePath() with NO explicit base.
  it("honours an absolute XDG_CONFIG_HOME (writes where the product reads)", () => {
    const savedXdg = process.env.XDG_CONFIG_HOME
    const savedHome = process.env.HOME
    const xdg = mkdtempSync(join(tmpdir(), "r197-xdg-"))
    try {
      process.env.XDG_CONFIG_HOME = xdg
      expect(configDir()).toBe(join(xdg, "swarm"))
      expect(configFilePath()).toBe(join(xdg, "swarm", "swarm.json"))
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg
      if (savedHome !== undefined) process.env.HOME = savedHome
      rmSync(xdg, { recursive: true, force: true })
    }
  })

  it("falls back to $HOME/.config when XDG_CONFIG_HOME is unset (the AC-W1 throwaway-HOME posture)", () => {
    const savedXdg = process.env.XDG_CONFIG_HOME
    const savedHome = process.env.HOME
    const home = mkdtempSync(join(tmpdir(), "r197-home-"))
    try {
      delete process.env.XDG_CONFIG_HOME
      process.env.HOME = home
      expect(configDir()).toBe(join(home, ".config", "swarm"))
      expect(configFilePath()).toBe(join(home, ".config", "swarm", "swarm.json"))
    } finally {
      if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = savedXdg
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      rmSync(home, { recursive: true, force: true })
    }
  })
})
