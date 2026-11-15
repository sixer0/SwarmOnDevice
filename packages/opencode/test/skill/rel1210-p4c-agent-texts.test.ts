// N10-182 (Swarm 1.2.10 row 61, AC-P4c, P4-c; spec 01d section 3.8, F-1). The agent texts no longer claim that Swarm
// copies all project memory into the vault:
// - the built-in skill `obsidian-memory` (src/skill/obsidian-memory.md) carries N10-017: Swarm copies memory into
//   `swarm-memory/` except notes kept on this device, secret-looking notes and notes with a classification word; only
//   the person exports a kept note; never copy a memory note into the inbox;
// - the installed-tools system line (src/session/system.ts) carries N10-016 (row 60);
// - the setup `obsidian-inbox` golden carries N10-018 and stays byte-equal to its generator (row 61a).
// Red at BASE a3e3c4c93a: the skill holds the unqualified F21 sentence, the system line lacks N10-016 and the setup
// golden lacks N10-018. Text checks only; no files are written, no network, no ports.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const OC = path.join(import.meta.dir, "..", "..")
const SETUP = path.join(OC, "..", "setup")
const readOptional = (file: string) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}
const flat = (s: string) => s.replace(/\s+/g, " ")
const SKILL = readOptional(path.join(OC, "src", "skill", "obsidian-memory.md"))
const SYSTEM = readOptional(path.join(OC, "src", "session", "system.ts"))
const GOLDEN = readOptional(path.join(SETUP, "src", "skills", "text", "skills", "obsidian-inbox", "SKILL.md"))

const N10_017 =
  "Swarm copies project memory, mission index entries and final reports into the vault folder `swarm-memory/` by itself, except notes kept on this device (written while an on-device model ran, or set so by the person), secret-looking notes and notes with a classification word. Only the person exports a kept note, in Swarm's memory view. Never copy a memory note, its text or a summary of it into the inbox to get it into the vault."
const N10_016 =
  "Notes kept on this device stay out of it; only the person exports one, never you, and never via the inbox."
const N10_018 =
  "Never copy Swarm project-memory notes into the inbox: a note Swarm keeps on this device stays there unless the person exports it in Swarm's memory view."
const OLD_F21 = "Swarm already copies project memory, mission index entries and final reports into"

const has = (text: string, s: string) => expect(flat(text).includes(s) ? "" : `missing: ${s}`).toBe("")

describe("AC-P4c agent texts: memory kept on this device is not copied, only the person exports, never via the inbox", () => {
  test("obsidian-memory: N10-017 replaces the copy claim, exactly as registered", () => {
    expect(SKILL.length).toBeGreaterThan(0)
    has(SKILL, N10_017)
    expect(flat(SKILL).includes(OLD_F21)).toBe(false)
    expect(flat(SKILL).split("Swarm copies project memory").length - 1).toBe(1)
  })

  test("obsidian-memory: the device-only exception, the person-only export and the inbox rule are each present", () => {
    has(SKILL, "except notes kept on this device (written while an on-device model ran, or set so by the person)")
    has(SKILL, "Only the person exports a kept note, in Swarm's memory view.")
    has(SKILL, "Never copy a memory note, its text or a summary of it into the inbox to get it into the vault.")
  })

  test("obsidian-memory: the surrounding rules stay (not turned off, never write swarm-memory/, index entry first)", () => {
    has(SKILL, "This skill cannot be turned off.")
    has(SKILL, "You never write, edit, rename or delete anything in `swarm-memory/`")
    expect(SKILL).toContain('`remember` with kind "index"')
  })

  test("system line (row 60) carries N10-016 right after 'never edit it.'", () => {
    expect(SYSTEM).toContain(`The vault folder swarm-memory/ is generated from project memory: never edit it. ${N10_016}`)
  })

  test("setup obsidian-inbox golden (row 61a) carries N10-018 and byte-equals its generator", async () => {
    expect(GOLDEN).toContain(N10_018)
    // Non-literal specifier: the setup package is not part of the opencode typecheck graph.
    const generator = path.join(SETUP, "src", "skills", "researcher_text.ts")
    const mod = (await import(generator)) as { renderSkillTexts: () => { skillObsidianInboxMd: string } }
    expect(mod.renderSkillTexts().skillObsidianInboxMd === GOLDEN).toBe(true)
  })
})
