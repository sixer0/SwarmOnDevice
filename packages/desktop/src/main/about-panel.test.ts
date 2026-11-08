import { describe, expect, test } from "bun:test"
import { aboutPanelOptions, formatBuildDate } from "./about-panel"

describe("about panel (row 175)", () => {
  test("Indonesian: name, version only once, update date; no licence text", () => {
    expect(aboutPanelOptions({ name: "Swarm", version: "1.2.1", buildDate: "2026-11-08", locale: "id" })).toEqual({
      applicationName: "Swarm",
      applicationVersion: "1.2.1",
      version: "",
      credits: "",
      copyright: "Diperbarui 8 November 2026",
    })
  })

  test("English locale", () => {
    expect(aboutPanelOptions({ name: "Swarm", version: "1.2.1", buildDate: "2026-01-05", locale: "en" }).copyright).toBe(
      "Updated January 5, 2026",
    )
  })

  test("no build date (dev run): empty copyright, never the Info.plist text", () => {
    const o = aboutPanelOptions({ name: "Swarm Dev", version: "1.2.1", buildDate: undefined, locale: "id" })
    expect(o.copyright).toBe("")
    expect(JSON.stringify(o)).not.toMatch(/opencode|MIT/i)
  })

  test("formatBuildDate rejects malformed input", () => {
    expect(formatBuildDate("2026-13-01", "id")).toBeUndefined()
    expect(formatBuildDate("8 Nov", "id")).toBeUndefined()
    expect(formatBuildDate("2026-03-31", "id")).toBe("31 Maret 2026")
  })
})
