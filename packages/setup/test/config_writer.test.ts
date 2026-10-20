// Row-97 FIX rounds b + c — config-writer unit tests. Fresh-HOME matrix: health gating, the two register
// MCP entries, hash+timestamp backups on BOTH paths (create vs modify), atomic replace, idempotence,
// reversible removal (restore vs delete), symlinked-target refusal, unrelated-key preservation, and the
// blueprint's byte-manifest guarantee (~/.claude, ~/.codex, ~/.config/opencode, rc files identical). Round c
// adds the skill/agent text writes (byte-equal to gen_cli goldens), checkSkillFiles drift detection, and a
// full write->check->remove->restore cycle. No HOME mutation (every path is driven off an explicit `base`),
// no spawn, no network. Run TARGETED: cd packages/setup && bun test test/config_writer.test.ts

import { describe, it, expect } from "bun:test"
import {
  chmodSync,
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
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import { defaultState } from "../src/state.ts"
import { STATES } from "../src/constants.ts"
import {
  writeConfigEntries,
  removeConfigEntries,
  previewConfig,
  checkSkillFiles,
  configFilePath,
  configDir,
  type ConfigWriterOptions,
} from "../src/wiring/config_writer.ts"
import { renderSkillTexts, TEXT_TARGETS } from "../src/skills/researcher_text.ts"
import { writeGoldens } from "../src/skills/gen_cli.ts"

function base(): string {
  return mkdtempSync(join(tmpdir(), "r97-cfg-"))
}
function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex")
}
function stageProxyBinary(b: string): string {
  const p = join(b, ".swarm", "setup", "bin", "swarm-web-proxy")
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, "#!/bin/sh\n")
  chmodSync(p, 0o755)
  return p
}
const okLaunch = () => ({
  ok: true as const,
  nodePath: "/home/u/.swarm/tools/node/v24/bin/node",
  cliPath: "/home/u/.swarm/tools/graft/0.18.0/node_modules/@nanonets/graft/dist/cli.js",
})

function stateWith(healthy: Array<"graft" | "searxng">) {
  const s = defaultState("swarm-tools-test")
  for (const id of healthy) s.components[id].state = STATES.HEALTHY
  return s
}

function opts(b: string, extra: Partial<ConfigWriterOptions> = {}): ConfigWriterOptions {
  return {
    base: b,
    chain: { path: join(b, ".swarm", "setup", "audit.jsonl") },
    launch: okLaunch,
    env: {},
    now: () => "2026-10-20T09:00:00.000Z",
    ...extra,
  }
}

describe("health gating (blueprint: no entries when health fails)", () => {
  it("all-absent state writes NOTHING (no file, no backup)", () => {
    const b = base()
    try {
      const res = writeConfigEntries(opts(b, { state: stateWith([]) }))
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.changed).toBe(false)
      expect(res.wrote.graft).toBe(false)
      expect(res.wrote.swarmWeb).toBe(false)
      expect(res.backupPath).toBeNull()
      // the config file (and its dir) were never created — nothing to reverse
      let exists = true
      try {
        statSync(configFilePath({ base: b }))
      } catch {
        exists = false
      }
      expect(exists).toBe(false)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("graft healthy alone -> only the graft entry (swarm-web skipped, searxng down)", () => {
    const b = base()
    try {
      const res = writeConfigEntries(opts(b, { state: stateWith(["graft"]) }))
      expect(res.ok && res.wrote.graft && !res.wrote.swarmWeb).toBe(true)
      const cfg = JSON.parse(readFileSync(configFilePath({ base: b }), "utf8")) as {
        mcp: Record<string, { command?: string[]; env?: Record<string, string> }>
      }
      expect(cfg.mcp.graft?.command).toEqual([okLaunch().nodePath, okLaunch().cliPath, "mcp"])
      expect(cfg.mcp.graft?.env?.DO_NOT_TRACK).toBe("1")
      expect(cfg.mcp["swarm-web"]).toBeUndefined()
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("searxng healthy + binary staged -> swarm-web entry with non-secret pointers, NEVER the token", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const res = writeConfigEntries(
        opts(b, { state: stateWith(["searxng"]), estate: { searxngUrl: "http://127.0.0.1:9021" } }),
      )
      expect(res.ok && res.wrote.swarmWeb).toBe(true)
      const cfg = JSON.parse(readFileSync(configFilePath({ base: b }), "utf8")) as {
        mcp: Record<string, { command: string[]; timeout: number; env: Record<string, string> }>
      }
      const sw = cfg.mcp["swarm-web"]
      expect(sw.command[0]?.endsWith("/.swarm/setup/bin/swarm-web-proxy")).toBe(true) // PC-PATH-14 absolute
      expect(sw.timeout).toBe(30000)
      expect(sw.env.SWARM_SEARXNG_URL).toBe("http://127.0.0.1:9021")
      expect(sw.env.SWARM_WEB_AUDIT_LOG?.endsWith("/.swarm/logs/web-audit.log")).toBe(true) // PC-PATH-10 default
      expect(sw.env.SWARM_VAULT_DIR?.endsWith("/.swarm/vault")).toBe(true) // PC-PATH-13 default
      expect(sw.env.SWARM_FIRECRAWL_TOKEN).toBeUndefined() // P-8: secret never in the file
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("searxng healthy but binary NOT staged -> swarm-web skipped (no dangling command)", () => {
    const b = base()
    try {
      const res = writeConfigEntries(opts(b, { state: stateWith(["searxng"]) }))
      expect(res.ok && res.wrote.swarmWeb).toBe(false)
      if (!res.ok) return
      expect(res.skipped.swarmWeb).toContain("proxy binary")
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("backup + atomic replace + idempotence (both paths)", () => {
  it("first-ever creation: changed=true, NO backup (nothing to preserve), ledger marks preexisting=false", () => {
    const b = base()
    try {
      const res = writeConfigEntries(opts(b, { state: stateWith(["graft"]) }))
      expect(res.ok && res.changed).toBe(true)
      if (!res.ok) return
      expect(res.backupPath).toBeNull()
      const ledger = JSON.parse(readFileSync(join(b, ".swarm", "setup", "config-writer.json"), "utf8")) as {
        version: number
        files: Record<string, { preexisting: boolean }>
      }
      expect(ledger.version).toBe(1)
      expect(ledger.files[configFilePath({ base: b })]?.preexisting).toBe(false) // swarm.json was created by us
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("modifying a pre-existing file: hash+timestamp backup created, prior bytes recoverable", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const original = '{\n  "theme": "swarm",\n  "mcp": {}\n}\n'
      writeFileSync(configFilePath({ base: b }), original, { encoding: "utf8", mode: 0o600 })
      const res = writeConfigEntries(opts(b, { state: stateWith(["graft"]) }))
      expect(res.ok && res.changed).toBe(true)
      if (!res.ok) return
      expect(res.backupPath).not.toBeNull()
      expect(readFileSync(res.backupPath as string, "utf8")).toBe(original) // exact prior bytes
      expect(res.backupPath as string).toContain(`.${sha(original).slice(0, 12)}.`) // hash-named
      expect(res.backupPath as string).toContain("20261020T090000") // timestamped
      const cfg = JSON.parse(readFileSync(configFilePath({ base: b }), "utf8")) as Record<string, unknown>
      expect(cfg.theme).toBe("swarm") // unrelated key preserved
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("idempotent: a second run over unchanged inputs is a byte no-op with no new backup", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const o = opts(b, { state: stateWith(["graft", "searxng"]), estate: { searxngUrl: "http://127.0.0.1:9021" } })
      const first = writeConfigEntries(o)
      const afterFirst = readFileSync(configFilePath({ base: b }), "utf8")
      const backupsAfterFirst = countBaks(b)
      const second = writeConfigEntries(o)
      expect(first.ok && first.changed).toBe(true)
      expect(second.ok && second.changed).toBe(false)
      if (!second.ok) return
      expect(second.backupPath).toBeNull()
      expect(readFileSync(configFilePath({ base: b }), "utf8")).toBe(afterFirst) // byte-identical
      expect(countBaks(b)).toBe(backupsAfterFirst) // no extra backup
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("reversal (removal restores or deletes)", () => {
  it("pre-existing file is restored byte-for-byte and backups swept", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const original = '{"theme":"swarm"}\n'
      writeFileSync(configFilePath({ base: b }), original, { encoding: "utf8", mode: 0o600 })
      writeConfigEntries(opts(b, { state: stateWith(["graft"]) }))
      const rem = removeConfigEntries(opts(b))
      expect(rem.ok && rem.action === "restored").toBe(true)
      expect(readFileSync(configFilePath({ base: b }), "utf8")).toBe(original)
      expect(countBaks(b)).toBe(0)
      // idempotent removal
      const rem2 = removeConfigEntries(opts(b))
      expect(rem2.ok && rem2.action === "no-op").toBe(true)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("created-from-nothing is deleted on removal", () => {
    const b = base()
    try {
      writeConfigEntries(opts(b, { state: stateWith(["graft"]) }))
      const rem = removeConfigEntries(opts(b))
      expect(rem.ok && rem.action === "deleted").toBe(true)
      let exists = true
      try {
        statSync(configFilePath({ base: b }))
      } catch {
        exists = false
      }
      expect(exists).toBe(false)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("symlinked-target refusal + key preservation + byte manifest", () => {
  it("refuses to write through a symlinked target; removal is a safe no-op when nothing was written", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const victim = join(b, "victim.txt")
      writeFileSync(victim, "do not clobber")
      symlinkSync(victim, configFilePath({ base: b }))
      const res = writeConfigEntries(opts(b, { state: stateWith(["graft"]) }))
      expect(res.ok).toBe(false)
      if (res.ok) return
      expect(res.reason).toContain("symlink")
      expect(readFileSync(victim, "utf8")).toBe("do not clobber") // never followed
      // nothing was ever recorded, so removal is a no-op (not a refusal) and still never touches victim
      const rem = removeConfigEntries(opts(b))
      expect(rem.ok && rem.action === "no-op").toBe(true)
      expect(readFileSync(victim, "utf8")).toBe("do not clobber")
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("refuses to REMOVE through a symlink swapped in after a real write", () => {
    const b = base()
    try {
      writeConfigEntries(opts(b, { state: stateWith(["graft"]) })) // creates a real file + ledger
      const cfgPath = configFilePath({ base: b })
      rmSync(cfgPath, { force: true })
      const victim = join(b, "victim2.txt")
      writeFileSync(victim, "keep me")
      symlinkSync(victim, cfgPath)
      const rem = removeConfigEntries(opts(b))
      expect(rem.ok).toBe(false)
      if (rem.ok) return
      expect(rem.reason).toContain("symlink")
      expect(readFileSync(victim, "utf8")).toBe("keep me") // never followed on removal either
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("preserves other mcp servers and top-level key order (no reorder, s96 §7)", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const existing = { alpha: 1, mcp: { "user-server": { type: "local", command: ["x"] } }, omega: 2 }
      writeFileSync(configFilePath({ base: b }), JSON.stringify(existing, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      })
      writeConfigEntries(opts(b, { state: stateWith(["graft"]) }))
      const text = readFileSync(configFilePath({ base: b }), "utf8")
      const cfg = JSON.parse(text) as { alpha: number; omega: number; mcp: Record<string, unknown> }
      expect(cfg.alpha).toBe(1)
      expect(cfg.omega).toBe(2)
      expect(cfg.mcp["user-server"]).toBeDefined() // untouched
      expect(cfg.mcp.graft).toBeDefined() // ours added
      // order preserved: alpha before mcp before omega in the serialised text
      expect(text.indexOf('"alpha"')).toBeLessThan(text.indexOf('"mcp"'))
      expect(text.indexOf('"mcp"')).toBeLessThan(text.indexOf('"omega"'))
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("BLUEPRINT GATE: ~/.claude, ~/.codex, ~/.config/opencode and rc files are byte-identical before/after", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const watched: Record<string, string> = {}
      const seed = (rel: string, body: string) => {
        const p = join(b, rel)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, body, { encoding: "utf8" })
        watched[p] = sha(body)
      }
      seed(".claude/settings.json", '{"a":1}')
      seed(".codex/config.toml", "[model]\nx=1\n")
      seed(".config/opencode/opencode.json", "{}")
      seed(".zshrc", "export PATH=/keep\n")
      seed(".bashrc", "# keep\n")
      const before = Object.fromEntries(Object.entries(watched).map(([k, v]) => [k, v]))

      writeConfigEntries(
        opts(b, { state: stateWith(["graft", "searxng"]), estate: { searxngUrl: "http://127.0.0.1:9021" } }),
      )

      for (const [p, digest] of Object.entries(before)) {
        expect(sha(readFileSync(p, "utf8"))).toBe(digest) // byte-identical
      }
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("previewConfig reports eligibility without touching disk", () => {
    const b = base()
    try {
      const p = previewConfig(stateWith(["graft"]), opts(b))
      expect(p.wrote.graft).toBe(true)
      expect(JSON.parse(p.json).mcp.graft.command[2]).toBe("mcp")
      let exists = true
      try {
        statSync(configFilePath({ base: b }))
      } catch {
        exists = false
      }
      expect(exists).toBe(false)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

function countBaks(b: string): number {
  const dir = join(b, ".config", "swarm")
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".bak")).length
  } catch {
    return 0
  }
}

// --- FIX ROUND c: skill/agent text writes + check mode -------------------------------------------

function stateAll(healthy: Array<"graft" | "searxng" | "rtk" | "obsidian">) {
  const s = defaultState("swarm-tools-test")
  for (const id of healthy) s.components[id].state = STATES.HEALTHY
  return s
}
const TEXT_KEYS: Array<keyof typeof TEXT_TARGETS> = [
  "agentResearcher",
  "swarmResearch",
  "graft",
  "rtk",
  "obsidianInbox",
]

describe("FIX c: skill/agent text writes (imported from src/skills, never copied)", () => {
  it("all-healthy install lands all five rendered texts at their TEXT_TARGETS paths", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const res = writeConfigEntries(opts(b, { state: stateAll(["graft", "searxng", "rtk", "obsidian"]) }))
      expect(res.ok && res.wrote.skills.length).toBe(5)
      const texts = renderSkillTexts()
      const map: Record<string, string> = {
        agentResearcher: texts.agentResearcherMd,
        swarmResearch: texts.skillSwarmResearchMd,
        graft: texts.skillGraftMd,
        rtk: texts.skillRtkMd,
        obsidianInbox: texts.skillObsidianInboxMd,
      }
      for (const k of TEXT_KEYS) {
        const dest = join(configDir(b), TEXT_TARGETS[k])
        expect(readFileSync(dest, "utf8")).toBe(map[k]) // byte-equal to renderSkillTexts()
      }
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("installed bytes are byte-equal to gen_cli goldens (same renderer, no fork)", () => {
    const b = base()
    const g = base()
    try {
      stageProxyBinary(b)
      writeConfigEntries(opts(b, { state: stateAll(["graft", "searxng", "rtk", "obsidian"]) }))
      const goldenDir = join(g, "text")
      writeGoldens(goldenDir) // gen_cli writes into <outDir>/<rel>
      for (const k of TEXT_KEYS) {
        expect(readFileSync(join(configDir(b), TEXT_TARGETS[k]), "utf8")).toBe(
          readFileSync(join(goldenDir, TEXT_TARGETS[k]), "utf8"),
        )
      }
    } finally {
      rmSync(b, { recursive: true, force: true })
      rmSync(g, { recursive: true, force: true })
    }
  })

  it("health-gated per subject: rtk-only installs just the rtk skill (no agent/swarm-research)", () => {
    const b = base()
    try {
      const res = writeConfigEntries(opts(b, { state: stateAll(["rtk"]) }))
      expect(res.ok && res.wrote.skills).toEqual(["skills/rtk/SKILL.md"])
      expect(exists(join(b, ".config", "swarm", "skills", "rtk", "SKILL.md"))).toBe(true)
      expect(exists(join(b, ".config", "swarm", "agent", "researcher.md"))).toBe(false)
      expect(exists(join(b, ".config", "swarm", "skills", "obsidian-inbox", "SKILL.md"))).toBe(false)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("idempotent across texts too: second all-healthy run changes nothing, adds no backup", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const o = opts(b, { state: stateAll(["graft", "searxng", "rtk", "obsidian"]) })
      const first = writeConfigEntries(o)
      const skillBytes = readFileSync(join(configDir(b), TEXT_TARGETS.graft), "utf8")
      const second = writeConfigEntries(o)
      expect(first.ok && first.changed).toBe(true)
      expect(second.ok && second.changed).toBe(false)
      expect(readFileSync(join(configDir(b), TEXT_TARGETS.graft), "utf8")).toBe(skillBytes)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("FIX c: checkSkillFiles drift gate (render-vs-written)", () => {
  it("reports zero drift immediately after a fresh install", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      writeConfigEntries(opts(b, { state: stateAll(["graft", "searxng", "rtk", "obsidian"]) }))
      const chk = checkSkillFiles(opts(b, { state: stateAll(["graft", "searxng", "rtk", "obsidian"]) }))
      expect(chk.ok).toBe(true)
      expect(chk.drifts).toEqual([])
      expect(chk.checked.length).toBe(5)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("fails loudly on tamper (edited body) and on deletion (MISSING)", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const st = stateAll(["graft", "searxng", "rtk", "obsidian"])
      writeConfigEntries(opts(b, { state: st }))
      writeFileSync(join(configDir(b), TEXT_TARGETS.graft), "tampered\n") // edited
      rmSync(join(configDir(b), TEXT_TARGETS.rtk), { force: true }) // deleted
      const chk = checkSkillFiles(opts(b, { state: st }))
      expect(chk.ok).toBe(false)
      expect(chk.drifts.some((d) => d.startsWith("skills/graft/SKILL.md") && d.includes("differs"))).toBe(true)
      expect(chk.drifts.some((d) => d.startsWith("skills/rtk/SKILL.md") && d.includes("MISSING"))).toBe(true)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

describe("FIX c: full write -> check -> remove -> restore cycle (byte-equality preserved)", () => {
  it("restore returns a pre-existing swarm.json byte-for-byte AND deletes created texts", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const original = '{"theme":"swarm"}\n'
      writeFileSync(configFilePath({ base: b }), original, { encoding: "utf8", mode: 0o600 })
      stageProxyBinary(b)
      const st = stateAll(["graft", "searxng", "rtk", "obsidian"])
      writeConfigEntries(opts(b, { state: st }))
      expect(checkSkillFiles(opts(b, { state: st })).ok).toBe(true) // installed clean
      const rem = removeConfigEntries(opts(b, { state: st }))
      expect(rem.ok && rem.action === "restored").toBe(true)
      expect(readFileSync(configFilePath({ base: b }), "utf8")).toBe(original) // byte-for-byte
      for (const k of TEXT_KEYS) expect(exists(join(configDir(b), TEXT_TARGETS[k]))).toBe(false) // created texts gone
      // idempotent removal
      expect(removeConfigEntries(opts(b, { state: st })).action).toBe("no-op")
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("a pre-existing skill file is restored, not deleted, on removal", () => {
    const b = base()
    try {
      const graftPath = join(configDir(b), TEXT_TARGETS.graft)
      mkdirSync(dirname(graftPath), { recursive: true })
      const userGraft = "# my own graft notes\n"
      writeFileSync(graftPath, userGraft, { encoding: "utf8", mode: 0o600 })
      const st = stateAll(["graft"])
      writeConfigEntries(opts(b, { state: st }))
      expect(readFileSync(graftPath, "utf8")).not.toBe(userGraft) // overwritten by our render
      const rem = removeConfigEntries(opts(b, { state: st }))
      expect(rem.ok).toBe(true)
      expect(readFileSync(graftPath, "utf8")).toBe(userGraft) // user's file restored byte-for-byte
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})

function exists(p: string): boolean {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

// --- FIX ROUND d: F-R109-1 kill-boundary replay (per-target durable ledger) ----------------------

const SIMULATED_KILL = "SIMULATED_KILL"
function ledgerFiles(b: string): Record<string, { preexisting: boolean; firstBackupPath: string | null }> {
  const p = join(b, ".swarm", "setup", "config-writer.json")
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { files: Record<string, never> }).files as Record<
      string,
      { preexisting: boolean; firstBackupPath: string | null }
    >
  } catch {
    return {}
  }
}

describe("FIX d: F-R109-1 mid-loop kill -> resume -> removal still complete", () => {
  const ALL = ["graft", "searxng", "rtk", "obsidian"] as const

  it("post-replace fault mid-loop: already-written targets are recorded; resume finishes; removal reverses ALL", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const st = stateAll(ALL)
      // die right after the 4th target (graft skill) fully lands
      let threw = false
      try {
        writeConfigEntries(
          opts(b, {
            state: st,
            onTargetBoundary: (phase, label) => {
              if (phase === "post-replace" && label === TEXT_TARGETS.graft) throw new Error(SIMULATED_KILL)
            },
          }),
        )
      } catch (e) {
        threw = (e as Error).message === SIMULATED_KILL
      }
      expect(threw).toBe(true)
      const lf = ledgerFiles(b)
      // the four completed targets are already durable in the ledger (no orphan among them)
      expect(Object.keys(lf).length).toBe(4)
      expect(exists(join(configDir(b), TEXT_TARGETS.rtk))).toBe(false) // pending target not written
      // resume: finishes the remaining two targets
      const resumed = writeConfigEntries(opts(b, { state: st }))
      expect(resumed.ok && resumed.changed).toBe(true)
      expect(Object.keys(ledgerFiles(b)).length).toBe(6)
      // removal reverses everything the crashed run + resume wrote — NOT a permanent no-op
      const rem = removeConfigEntries(opts(b, { state: st }))
      expect(rem.ok && rem.files.length).toBe(6)
      expect(exists(join(configDir(b), TEXT_TARGETS.graft))).toBe(false)
      expect(exists(join(configDir(b), TEXT_TARGETS.rtk))).toBe(false)
      expect(exists(configFilePath({ base: b }))).toBe(false)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("pre-replace fault on a PRE-EXISTING swarm.json: ledger durable BEFORE the change; removal restores original", () => {
    const b = base()
    try {
      mkdirSync(join(b, ".config", "swarm"), { recursive: true })
      const original = '{"theme":"swarm"}\n'
      writeFileSync(configFilePath({ base: b }), original, { encoding: "utf8", mode: 0o600 })
      const st = stateAll(ALL)
      let threw = false
      try {
        writeConfigEntries(
          opts(b, {
            state: st,
            onTargetBoundary: (phase, label) => {
              if (phase === "pre-replace" && label === "swarm.json") throw new Error(SIMULATED_KILL)
            },
          }),
        )
      } catch (e) {
        threw = (e as Error).message === SIMULATED_KILL
      }
      expect(threw).toBe(true)
      // the replace never happened: swarm.json is still the user's original bytes...
      expect(readFileSync(configFilePath({ base: b }), "utf8")).toBe(original)
      // ...yet the ledger ALREADY records it as pre-existing with a durable origin backup
      const rec = ledgerFiles(b)[configFilePath({ base: b })]
      expect(rec?.preexisting).toBe(true)
      expect(rec?.firstBackupPath && exists(rec.firstBackupPath)).toBe(true)
      // removal therefore restores the original byte-for-byte (no unrecorded modification can survive)
      const rem = removeConfigEntries(opts(b, { state: st }))
      expect(rem.ok && rem.action === "restored").toBe(true)
      expect(readFileSync(configFilePath({ base: b }), "utf8")).toBe(original)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("K12 exact shape is unreachable: after the LAST target lands, the ledger is already complete", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const st = stateAll(ALL)
      let threw = false
      try {
        writeConfigEntries(
          opts(b, {
            state: st,
            onTargetBoundary: (phase, label) => {
              if (phase === "post-replace" && label === TEXT_TARGETS.obsidianInbox) throw new Error(SIMULATED_KILL)
            },
          }),
        )
      } catch (e) {
        threw = (e as Error).message === SIMULATED_KILL
      }
      expect(threw).toBe(true)
      // all six targets replaced AND all six recorded — the old "all written, no ledger" gap cannot occur
      expect(Object.keys(ledgerFiles(b)).length).toBe(6)
      const rem = removeConfigEntries(opts(b, { state: st }))
      expect(rem.ok && rem.reversed).toBe(true)
      expect(exists(configFilePath({ base: b }))).toBe(false)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })

  it("MANIFEST_IDENTICAL still holds across a per-target-committed install", () => {
    const b = base()
    try {
      stageProxyBinary(b)
      const watched: Record<string, string> = {}
      const seed = (rel: string, body: string) => {
        const p = join(b, rel)
        mkdirSync(dirname(p), { recursive: true })
        writeFileSync(p, body, { encoding: "utf8" })
        watched[p] = sha(body)
      }
      seed(".claude/settings.json", "{}")
      seed(".codex/config.toml", "x")
      seed(".config/opencode/opencode.json", "{}")
      seed(".zshrc", "p")
      writeConfigEntries(opts(b, { state: stateAll(ALL) }))
      for (const [p, digest] of Object.entries(watched)) expect(sha(readFileSync(p, "utf8"))).toBe(digest)
    } finally {
      rmSync(b, { recursive: true, force: true })
    }
  })
})
