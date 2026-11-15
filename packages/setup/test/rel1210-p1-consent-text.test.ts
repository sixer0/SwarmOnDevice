// Row 46a (1.2.10, AC-P1-consent, N10-167): the Obsidian consent block names the registry entry
// the Swarm app may add, and no longer claims Swarm writes a .obsidian/ settings dir.
// Exact strings: 01a section 3.8 (:275) and the S10-11(P1) sentence (:276).
// Run: cd packages/setup && bun test test/rel1210-p1-consent-text.test.ts
import { describe, it, expect } from "bun:test"
import { CONSENT_BLOCKS } from "../src/consentText.ts"

const LINE_275 =
  "the new vault at PC-PATH-13 with its inbox/ folder at PC-PATH-12 (Obsidian itself creates a .obsidian/ settings folder inside it the first time it opens the vault; Swarm writes none)"
const LINE_276 =
  "Swarm install records under ~/.swarm/tools/obsidian/; Obsidian's own global state under ~/Library/Application Support/obsidian/ belongs to Obsidian. " +
  "The Swarm app adds exactly one entry (folder path and time) for this vault to Obsidian's vault list (obsidian.json) when the person presses Open graph in Obsidian while Obsidian is closed, " +
  "creating that list and its folder first if Obsidian has not made them yet, keeps a one-time copy of an existing list beside it (obsidian.json.swarm-backup), and changes nothing else there"

describe("N10-167 AC-P1-consent: Obsidian consent pathsWritten", () => {
  const paths = CONSENT_BLOCKS.obsidian.flatMap((b) => [...b.pathsWritten])

  it("the old 'plus a .obsidian/ settings dir' phrase is gone", () => {
    expect(paths.join("\n").includes("plus a .obsidian/ settings dir")).toBe(false)
  })

  it("both fixed sentences are present verbatim", () => {
    expect(paths).toContain(LINE_275)
    expect(paths).toContain(LINE_276)
  })

  it("mentions obsidian.json and its one-time backup", () => {
    const joined = paths.join("\n")
    expect(joined.includes("obsidian.json")).toBe(true)
    expect(joined.includes("obsidian.json.swarm-backup")).toBe(true)
  })

  it("block count stays 8", () => {
    const total = Object.values(CONSENT_BLOCKS).reduce((n, bs) => n + bs.length, 0)
    expect(total).toBe(8)
  })
})
