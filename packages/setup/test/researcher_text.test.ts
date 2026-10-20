// Row-98 units — the single-source proof for the researcher final assembly.
//
// The heart is PROOF-GRADE BYTE-COMPARE: every model-facing text under src/skills/text/ must equal,
// byte for byte, what renderSkillTexts() produces FROM researcherAssemblyInputs(lock) (row 97's handoff)
// at test time. Facts live in rows 94/95/97's exports; prose lives here; if the wiring moves and the
// golden does not, this suite goes red instead of shipping a skill that describes code that no longer
// exists. Run TARGETED: cd packages/setup && bun test test/researcher_text.test.ts

import { describe, it, expect } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { renderSkillTexts, RTK_RECALL_RULING, TEXT_TARGETS, type SkillTexts } from "../src/skills/researcher_text.ts"
import { researcherAssemblyInputs } from "../src/wiring/handoff_98.ts"
import { researcherDefinition, validateResearcherDefinition, mcpPermissionGates } from "../src/mcpproxy/wiring.ts"
import { vaultSkillFacts } from "../src/vault/writer.ts"

const TEXT_DIR = join(import.meta.dir, "../src/skills/text")

const rendered = renderSkillTexts()
const inputs = researcherAssemblyInputs()

function golden(target: string): string {
  return readFileSync(join(TEXT_DIR, target), "utf8")
}

const GOLDEN_BY_KEY: ReadonlyArray<readonly [keyof SkillTexts, string]> = [
  ["agentResearcherMd", TEXT_TARGETS.agentResearcher],
  ["skillSwarmResearchMd", TEXT_TARGETS.swarmResearch],
  ["skillGraftMd", TEXT_TARGETS.graft],
  ["skillRtkMd", TEXT_TARGETS.rtk],
  ["skillObsidianInboxMd", TEXT_TARGETS.obsidianInbox],
]

describe("prose == facts (byte-compare against the shipped wiring)", () => {
  // THE gate: regenerated-from-facts vs golden-on-disk, byte equality, per file.
  it.each(GOLDEN_BY_KEY.map(([key, target]) => [key, target] as const))(
    "%s golden equals rendered facts byte-for-byte",
    (key, target) => {
      expect(rendered[key]).toBe(golden(target))
    },
  )

  it("the generator consumes row 97's object rather than re-typing facts", () => {
    // Every fact-bearing token below appears in a text ONLY via interpolation of these exports;
    // pinning the sources here means deleting one from the wiring breaks both sides at once.
    expect(inputs.researcher).toEqual(researcherDefinition)
    expect(inputs.permissionGates).toEqual(mcpPermissionGates())
    expect(inputs.vault).toEqual(vaultSkillFacts())
    expect(inputs.researcherValid).toBe(true)
    expect(validateResearcherDefinition(inputs.researcher)).toEqual([])
  })

  it("frontmatter of the agent artifact round-trips the shipped definition exactly, order included", () => {
    const fm = parseFrontmatter(rendered.agentResearcherMd)
    const def = inputs.researcher.agent.researcher
    expect(JSON.parse(String(fm.description))).toBe(def.description)
    expect(JSON.parse(String(fm.mode))).toBe(def.mode)
    const perm = JSON.parse(String(fm.permission)) as Record<string, string>
    expect(perm).toEqual(def.permission)
    // key ORDER is load-bearing (01f §2.1: last-match-wins), so compare the sequence, not just the map
    expect(Object.keys(perm).join(",")).toBe(Object.keys(def.permission).join(","))
  })

  it("skill frontmatter names match their install directories (loader keys by name, path keys by dir)", () => {
    const pairs: readonly [string, string][] = [
      [TEXT_TARGETS.swarmResearch, rendered.skillSwarmResearchMd],
      [TEXT_TARGETS.graft, rendered.skillGraftMd],
      [TEXT_TARGETS.rtk, rendered.skillRtkMd],
      [TEXT_TARGETS.obsidianInbox, rendered.skillObsidianInboxMd],
    ]
    for (const [target, text] of pairs) {
      const fm = parseFrontmatter(text)
      const name = JSON.parse(String(fm.name)) as string
      const dirFromTarget = target.split("/")[1] // skills/<name>/SKILL.md
      expect(dirFromTarget).toBe(name)
      expect(typeof JSON.parse(String(fm.description))).toBe("string")
    }
  })
})

describe("facts actually reach the prose (per-text consumption)", () => {
  const v = inputs.vault

  it("researcher prompt quotes its own grants, deny-all, denies and return contract", () => {
    const t = rendered.agentResearcherMd
    expect(t).toContain('"*": "deny"')
    for (const tool of ["swarm-web_search", "swarm-web_fetch", v.toolName]) expect(t).toContain(`\`${tool}\``)
    expect(t).toContain("`task`")
    expect(t).toContain("`todowrite`")
    expect(t).toContain("web tools unavailable")
    expect(t).toContain("fetched_at")
    expect(t).toContain("untrusted")
    expect(t).toContain(v.writeTarget)
    expect(t).toContain(inputs.returnContract.nonceMakesTranscriptAuditable ? "nonce" : "NONCE-MISSING")
  })

  it("swarm-research skill carries the spawn contract and the caller-side gates", () => {
    const t = rendered.skillSwarmResearchMd
    expect(t).toContain("One spawn at a time")
    expect(t).toContain("Resume by task id")
    expect(t).toContain("never fall back to bash curl")
    for (const [pattern, action] of inputs.permissionGates) expect(t).toContain(`\`"${pattern}": "${action}"\``)
    expect(t).toContain(returnContractFragment())
  })

  it("graft skill carries server, subcommand, telemetry knob and must-be-unset list", () => {
    const t = rendered.skillGraftMd
    expect(t).toContain(`\`${inputs.graft.serverName}\``)
    expect(t).toContain(`\`${inputs.graft.sanctionedSubcommand}\``)
    expect(t).toContain("`--deep`")
    expect(t).toContain(inputs.graft.telemetryKnob)
    for (const key of inputs.graft.mustBeUnset) expect(t).toContain(key)
    expect(t).toContain(`\`"${inputs.graft.gateRule[0]}": "${inputs.graft.gateRule[1]}"\``)
  })

  it("rtk skill carries absolute-path-only, never-run list, telemetry knob and the evidence rule", () => {
    const t = rendered.skillRtkMd
    expect(t).toContain("ABSOLUTE PATH")
    expect(t).toContain("never adds it to `PATH`")
    for (const cmd of inputs.rtk.telemetry.neverRun) expect(t).toContain(`\`${cmd}\``)
    expect(t).toContain(inputs.rtk.telemetry.childEnvKnob)
    expect(t).toContain(inputs.rtk.telemetry.storeLocation)
    expect(t).toContain("filtered result is a SUMMARY")
    expect(t).toContain("rtk recall <hash>")
    expect(t).toContain(RTK_RECALL_RULING.decision)
  })

  it("obsidian-inbox skill carries tool, actions, paths, byte bound and every refusal reason", () => {
    const t = rendered.skillObsidianInboxMd
    expect(t).toContain(`\`${v.toolName}\``)
    for (const action of v.actions) expect(t).toContain(`\`${action}\``)
    expect(t).toContain(v.writeTarget)
    expect(t).toContain(v.vaultRootDefault)
    expect(t).toContain(v.envVarName)
    expect(t).toContain(String(v.maxNoteBytes))
    expect(t).toContain(v.overwriteDeleteRename)
    for (const reason of v.refusalReasons) expect(t).toContain(`\`${reason}\``)
    expect(t).toContain(v.communityPluginUsed ? "COMMUNITY-PLUGIN-USED" : "never used, installed or pre-seeded")
  })

  function returnContractFragment(): string {
    return inputs.returnContract.sourceListWithUrlsAndFetchTimes
      ? "source list with URLs and fetch times"
      : "MISSING-CONTRACT"
  }
})

describe("blueprint :262 verification items per skill (when-to-use / permissions / untrusted)", () => {
  const skills: readonly (readonly [string, string])[] = [
    ["swarm-research", rendered.skillSwarmResearchMd],
    ["graft", rendered.skillGraftMd],
    ["rtk", rendered.skillRtkMd],
    ["obsidian-inbox", rendered.skillObsidianInboxMd],
  ]

  it.each(skills)(
    "`%s` states when to use it, its restricted permissions and the untrusted-content rule",
    (_name, text) => {
      expect(text).toContain("## When to use it")
      expect(text).toMatch(/## Restricted permissions/)
      expect(text).toMatch(/## Untrusted-content rule|untrusted/i)
    },
  )
})

describe("forbidden shapes (01f §14 row-98 line + blueprint :262 + driver rules)", () => {
  const allTexts: readonly (readonly [string, string])[] = GOLDEN_BY_KEY.map(
    ([, target]) => [target, golden(target)] as const,
  )

  it("no emoji or non-ASCII anywhere in a shipped text", () => {
    for (const [target, text] of allTexts) {
      const bad = [...text].filter((ch) => ch.codePointAt(0)! > 0x7f)
      expect({ target, bad: bad.join("") }).toEqual({ target, bad: "" })
      // explicit pictograph / arrow / variation-selector ranges, belt and braces over the ASCII gate
      expect(new RegExp("[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}\\u{2190}-\\u{21FF}]", "u").test(text)).toBe(
        false,
      )
    }
  })

  it("no brand strings in a shipped text (keep-class lives only in source comments, not in goldens)", () => {
    for (const [target, text] of allTexts) {
      const hits = text.split("\n").filter((line) => /opencode/i.test(line))
      expect({ target, hits }).toEqual({ target, hits: [] })
    }
  })

  it("raw pages are only ever mentioned under a prohibition (never promises pasting onward)", () => {
    for (const [target, text] of allTexts) {
      const offenders = text.split("\n").filter((line) => /paste|pasting/i.test(line) && !/never|no |not /i.test(line))
      expect({ target, offenders }).toEqual({ target, offenders: [] })
    }
    expect(rendered.agentResearcherMd).toContain("Never paste raw page bodies")
    expect(rendered.skillSwarmResearchMd).toContain("Never ask it to paste raw pages")
  })

  it("nested fan-out is never promised from inside the researcher", () => {
    for (const [target, text] of allTexts) {
      const offenders = text
        .split("\n")
        .filter(
          (line) =>
            /fan out|spawn (?:multiple|more|another) researchers?|nested researchers?/i.test(line) &&
            !/not|cannot|never|instead of|nowhere/i.test(line),
        )
      expect({ target, offenders }).toEqual({ target, offenders: [] })
    }
    expect(rendered.agentResearcherMd).toContain("You cannot delegate")
  })

  it("bash curl appears only as the forbidden fallback", () => {
    for (const [target, text] of allTexts) {
      const offenders = text.split("\n").filter((line) => /curl/i.test(line) && !/never|BLOCKED_BY_POLICY/i.test(line))
      expect({ target, offenders }).toEqual({ target, offenders: [] })
    }
  })

  it("no text instructs anyone to run rtk config / init / graft init / --deep", () => {
    const forbidden = [/rtk\s+init/, /rtk\s+config/, /rtk\s+telemetry\s+enable/, /graft\s+init/, /--deep/]
    for (const [target, text] of allTexts) {
      for (const re of forbidden) {
        const offenders = text
          .split("\n")
          .filter(
            (line) =>
              re.test(line) &&
              !/forbid|never|unreachable|refus|absent|never-run|on the never-run list|Deep mode/i.test(line),
          )
        expect({ target, pattern: String(re), offenders }).toEqual({ target, pattern: String(re), offenders: [] })
      }
    }
  })

  it("no port literals, no URLs beyond the register's tilde paths (skills carry no endpoints)", () => {
    for (const [target, text] of allTexts) {
      expect(new RegExp("\\b(3000|3002|5432|6379|8080|8888|9021|9022|27124)\\b").test(text)).toBe(false)
      const urls = text.split("\n").filter((line) => /https?:\/\//i.test(line))
      expect({ target, urls }).toEqual({ target, urls: [] })
    }
  })
})

describe("rtk recall ruling (task c) - finalized here, recorded as data", () => {
  it("decision is KEEP OFF and setup never runs the control", () => {
    expect(RTK_RECALL_RULING.decision).toBe("keep-off")
    expect(RTK_RECALL_RULING.setupRunsConfigRecall).toBe(false)
    expect(RTK_RECALL_RULING.decidedBy).toBe("row 98")
    expect(RTK_RECALL_RULING.date).toBe("2026-10-20")
    expect(RTK_RECALL_RULING.rationale).toContain("WRITES the user's own config store")
  })

  it("the flip path is recorded exactly: argv shape plus the structural gate that precedes it", () => {
    expect(RTK_RECALL_RULING.enableArgvIfFlipped).toEqual([
      "<absolute private rtk binary>",
      "config",
      "recall",
      "<sqlite|tee|disabled>",
    ])
    expect(RTK_RECALL_RULING.gateToFlipFirst).toContain("rtk_invocation.ts")
    expect(RTK_RECALL_RULING.gateToFlipFirst).toContain("FORBIDDEN_VERBS")
    // and the gate is still shut in the shipped guard: "config" remains forbidden there
    const guardSource = readFileSync(join(import.meta.dir, "../src/wiring/rtk_invocation.ts"), "utf8")
    expect(guardSource).toMatch(/FORBIDDEN_VERBS[^;]*"config"/)
  })

  it("the rtk skill states the affordance without instructing the control", () => {
    const t = rendered.skillRtkMd
    expect(t).toContain("rtk recall <hash>")
    expect(t).toContain("Swarm never changes that recovery mode")
    expect(t).not.toMatch(/run(s)? `?rtk config/)
  })
})

describe("determinism and install-shape sanity", () => {
  it("rendering twice is byte-identical (no clock, no host state)", () => {
    const again = renderSkillTexts()
    for (const [key] of GOLDEN_BY_KEY) expect(again[key]).toBe(rendered[key])
  })

  it("every text is non-empty markdown with a frontmatter block and ends with a newline", () => {
    for (const [key, target] of GOLDEN_BY_KEY) {
      const text = rendered[key]
      expect(text.length).toBeGreaterThan(400)
      expect(text.startsWith("---\n")).toBe(true)
      expect(text.endsWith("\n")).toBe(true)
      expect(target.startsWith("agent/") || target.startsWith("skills/")).toBe(true)
    }
  })
})

// --- helpers ------------------------------------------------------------------------------------

/** Minimal reader for the frontmatter this generator itself writes (flat `key: <JSON value>` lines).
 *  Deliberately NOT a YAML dependency: packages/setup carries none (01f §6.1 no-deps rule), and the
 *  real engine's own parser is exercised end-to-end in test/researcher_final.proofs.sh instead. */
function parseFrontmatter(text: string): Record<string, string> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) throw new Error("no frontmatter block")
  const out: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const idx = line.indexOf(": ")
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 2)
  }
  return out
}
