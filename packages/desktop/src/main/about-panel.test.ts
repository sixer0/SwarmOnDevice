import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { aboutPanelOptions, formatBuildDate } from "./about-panel"

describe("about panel (row 175)", () => {
  test("Indonesian: name, version only once, update date; no licence text", () => {
    expect(aboutPanelOptions({ name: "Swarm", version: "1.2.3", buildDate: "2026-11-08", locale: "id" })).toEqual({
      applicationName: "Swarm",
      applicationVersion: "1.2.3",
      version: "",
      credits: "",
      copyright: "Diperbarui 8 November 2026",
    })
  })

  test("English locale", () => {
    expect(aboutPanelOptions({ name: "Swarm", version: "1.2.3", buildDate: "2026-01-05", locale: "en" }).copyright).toBe(
      "Updated January 5, 2026",
    )
  })

  test("no build date (dev run): empty copyright, never the Info.plist text", () => {
    const o = aboutPanelOptions({ name: "Swarm Dev", version: "1.2.3", buildDate: undefined, locale: "id" })
    expect(o.copyright).toBe("")
    expect(JSON.stringify(o)).not.toMatch(/opencode|MIT/i)
  })

  test("formatBuildDate rejects malformed input", () => {
    expect(formatBuildDate("2026-13-01", "id")).toBeUndefined()
    expect(formatBuildDate("8 Nov", "id")).toBeUndefined()
    expect(formatBuildDate("2026-03-31", "id")).toBe("31 Maret 2026")
  })
})

// Row 206 (1.2.3): the About date is the build commit's date, never the run time: electron.vite.config.ts reads
// `git log -1 --format=%cs` into SWARM_BUILD_DATE and main passes it to aboutPanelOptions with app.getVersion().
describe("about panel build date comes from the commit (1.2.3)", () => {
  const root = join(import.meta.dir, "..", "..")
  test("the vite config derives SWARM_BUILD_DATE from the commit date and main uses it", () => {
    const cfg = readFileSync(join(root, "electron.vite.config.ts"), "utf8")
    expect(cfg).toContain('execFileSync("git", ["log", "-1", "--format=%cs"]')
    expect(cfg).toContain('"import.meta.env.SWARM_BUILD_DATE": JSON.stringify(buildDate)')
    expect(cfg).not.toMatch(/new Date\(\)/)
    const main = readFileSync(join(root, "src", "main", "index.ts"), "utf8")
    expect(main).toContain("import.meta.env.SWARM_BUILD_DATE")
    expect(main).toContain("buildDate: BUILD_DATE")
  })
  test("the commit date of this checkout formats as the About line, with the 1.2.3 version", () => {
    const iso = execFileSync("git", ["log", "-1", "--format=%cs"], { cwd: root, encoding: "utf8" }).trim()
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }
    expect(pkg.version).toBe("1.2.3")
    const o = aboutPanelOptions({ name: "Swarm", version: pkg.version, buildDate: iso, locale: "id" })
    expect(o.applicationVersion).toBe("1.2.3")
    expect(o.copyright).toBe(`Diperbarui ${formatBuildDate(iso, "id")}`)
  })
})
