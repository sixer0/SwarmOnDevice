/**
 * Swarm 1.3.0 row 86 (AC-P5c, AC-REN-WN; N10-185, N10-125, N10-241, 01d RN-9). The swarm-whats-new brief of this
 * build: one `## 1.3.0 (this build)` section (1.2.10 was never released and has no heading of its own) carrying the
 * diagram-flow pointer, the device-only memory line, the owner-message line and the vault inbox line; the 1.2.8
 * Obsidian line says notes kept on this device are not mirrored; the whole file stays within 12,288 bytes and the
 * 1.3.0 section names nothing classified, private or path-like (F24).
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const OC = path.join(import.meta.dir, "..", "..")
const PACKAGES = path.join(OC, "..")
const text = readFileSync(path.join(OC, "src", "skill", "swarm-whats-new.md"), "utf8")
const flat = (part: string) => part.replace(/\s+/g, " ")
const between = (from: string, to: string) => {
  const start = text.indexOf(`\n## ${from}`)
  const end = text.indexOf(`\n## ${to}`)
  return start > 0 && end > start ? text.slice(start, end) : ""
}
// 1.3.1 row R1 (INTENT): 1.3.1 (Obsidian hotfix) is this build; the 1.3.0 section keeps its content, without the marker.
const v130 = between("1.3.0\n", "1.2.9")
const v131 = between("1.3.1 (this build)", "1.3.0")

const POINTER = "- Diagram rules (engine in DATUM Studio, `direction` opt-in, fit codes): skill `diagram-flow`."
const P4_LINE =
  "- Memory kept on this device (on-device model) is not copied to the vault; only the person copies a note, in the memory view; secret or classified never. Never copy memory into the inbox. Changing who receives a note is person-only."
const OWNER_LINE = "- An owner message (from: owner) from a session the app has not attested is refused (SESSION_NOT_ATTESTED)"

describe("swarm-whats-new 1.3.0 brief (N10-185)", () => {
  test("1.3.1 is this build; 1.3.0 and 1.2.9 are not; 1.2.10 has no heading; the title names 1.3.1", () => {
    expect(v130.length).toBeGreaterThan(200)
    expect(text).toContain("\n## 1.3.0\n")
    expect(text).toContain("\n## 1.2.9\n")
    expect(text).not.toContain("## 1.3.0 (this build)")
    expect(text).not.toContain("## 1.2.9 (this build)")
    expect(text).not.toMatch(/\n## 1\.2\.10\b/)
    expect(text.split("\n")[0]).toBe("# Swarm whats-new: agent briefs 1.2.0 to 1.3.1")
    expect(text.match(/\(this build\)/g)?.length).toBe(1)
  })

  test("1.3.1 row R1: the 1.3.1 brief names the Obsidian fix and nothing path-like or classified", () => {
    const slice = flat(v131)
    expect(slice).toContain("Open in Obsidian with Obsidian closed now registers the vault")
    expect(slice).toContain("name the configured vault folder")
    expect(v131).not.toMatch(
      /\b004\b|adint|kajian|rev-f|swarm-audit|Documents\/Research|\/Users\/|\/private\/tmp|~\/|TERBATAS|RAHASIA|CONFIDENTIAL|RESTRICTED|[0-9]{1,3}(\.[0-9]{1,3}){3}/i,
    )
  })

  test("the diagram-flow pointer is in the 1.3.0 section exactly once and names the skill in backticks", () => {
    expect(flat(v130).split(POINTER).length - 1).toBe(1)
    expect(v130).toContain("`diagram-flow`")
  })

  test("the 1.3.0 section names only registered studio_ tools", () => {
    const studio = new Set(
      [
        ["datum-studio", "vendor", "scripts", "studio", "mcp", "figure-tools.ts"],
        ["datum-studio", "vendor", "scripts", "studio", "mcp", "doc-tools.ts"],
        ["datum-studio", "vendor", "scripts", "studio", "mcp", "write-tools.ts"],
        ["datum-studio", "vendor", "scripts", "studio", "mcp", "tools.ts"],
        ["datum-studio", "src", "mcp-host", "mission", "schemas.ts"],
        ["datum-studio", "src", "mcp-host", "asset-tool.ts"],
      ].flatMap((parts) => {
        let source = ""
        try {
          source = readFileSync(path.join(PACKAGES, ...parts), "utf8")
        } catch {}
        return [...source.matchAll(/"(studio_[a-z_]+)"/g)].map((m) => m[1]!)
      }),
    )
    const named = [...new Set([...v130.matchAll(/\bstudio_[a-z_]*[a-z]\b/g)].map((m) => m[0]))]
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((name) => !studio.has(name))).toEqual([])
  })

  test("the file is at most 12,288 bytes", () => {
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(12_288)
  })

  test("the 1.3.0 section carries the device-only memory, owner-message and vault inbox lines", () => {
    const slice = flat(v130)
    expect(slice).toContain(P4_LINE)
    expect(slice).toContain(OWNER_LINE)
    expect(slice).toContain("only with `swarm-web_vault_inbox`")
    expect(slice).toContain("draftTime")
    expect(slice).toContain("derived.drift.changed")
  })

  test("01d RN-9: the 1.2.8 Obsidian line says notes kept on this device are not mirrored", () => {
    const v128 = flat(between("1.2.8", "1.2.7"))
    const line = v128.slice(v128.indexOf("- Obsidian:"))
    expect(line.startsWith("- Obsidian: Swarm itself mirrors memory, index entries and final reports into the vault folder swarm-memory/, except notes kept on this device.")).toBe(true)
  })

  test("F24: the 1.3.0 section names nothing classified, private or path-like", () => {
    expect(v130).not.toMatch(
      /\b004\b|adint|kajian|rev-f|swarm-audit|Documents\/Research|\/Users\/|\/private\/tmp|~\/|TERBATAS|RAHASIA|CONFIDENTIAL|RESTRICTED|[0-9]{1,3}(\.[0-9]{1,3}){3}/i,
    )
  })
})
