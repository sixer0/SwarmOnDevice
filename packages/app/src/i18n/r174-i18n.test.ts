import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict as en } from "./en"
import { dict as id } from "./id"

// Source text of the two call sites this batch edits, plus the separate ui table,
// read directly so the assertions prove the wiring (dictionary-sourced, not literal)
// rather than restating the dictionary again.
const layoutSrc = readFileSync(join(import.meta.dir, "../pages/layout.tsx"), "utf8")
const railSrc = readFileSync(join(import.meta.dir, "../components/settings-v2/dialog-settings-v2.tsx"), "utf8")
const uiIdSrc = readFileSync(join(import.meta.dir, "../../../ui/src/i18n/id.ts"), "utf8")

// Referral #3 (F-D2-1): the numbered "Open Project" command title used to be a raw
// template literal `Open Project {number}`, so Indonesian users saw English copy plus
// the literal characters "{number}". It must now come from the dictionary and interpolate.
describe("#3 Open Project title routes through i18n with interpolation", () => {
  test("both tables carry the {{number}} token, never a bare {number}", () => {
    expect(en["command.project.openNumber"]).toBe("Open Project {{number}}")
    expect(id["command.project.openNumber"]).toBe("Buka proyek {{number}}")
    for (const value of [en["command.project.openNumber"], id["command.project.openNumber"]]) {
      expect(value).toContain("{{number}}")
      // strip the real token; nothing shaped like a single-brace placeholder may remain
      expect(value.replace(/\{\{number\}\}/g, "")).not.toContain("{number}")
    }
  })

  test("the shipped resolver interpolates the digit and leaves no raw braces", () => {
    // resolveTemplate is the exact function language.t uses (context/language.tsx:191).
    const enOut = resolveTemplate(en["command.project.openNumber"], { number: 3 })
    const idOut = resolveTemplate(id["command.project.openNumber"], { number: 7 })
    expect(enOut).toBe("Open Project 3")
    expect(idOut).toBe("Buka proyek 7")
    expect(enOut).not.toMatch(/[{}]/)
    expect(idOut).not.toMatch(/[{}]/)
  })

  test("the title is read from the dictionary, not hardcoded", () => {
    expect(layoutSrc).toContain('language.t("command.project.openNumber", { number })')
    expect(layoutSrc).not.toContain("`Open Project {number}`")
    expect(layoutSrc).not.toMatch(/title:\s*`Open Project/)
  })
})

// Referral #5 (F-D2-3): id.ts had "Tutup Tab" (:768) against "Tutup tab" (:151, :898).
// Majority form is lowercase "tab"; the lone outlier is unified toward it.
describe("#5 Tutup tab casing unified toward the majority form", () => {
  test("the three app-table close-tab values share one casing", () => {
    expect(id["command.tab.close"]).toBe("Tutup tab")
    expect(id["common.closeTab"]).toBe("Tutup tab")
    expect(id["session.error.notFound.closeTab"]).toBe("Tutup tab")
  })

  test("no app-table value still reads 'Tutup Tab' with a capital T", () => {
    const offenders = Object.entries(id).filter(([, value]) => value === "Tutup Tab")
    expect(offenders).toEqual([])
  })

  test("the ui table's separate close key already matches and stays untouched", () => {
    // ui.tabs.close is a different key in a different table; it was already lowercase.
    expect(uiIdSrc).toContain('"ui.tabs.close": "Tutup tab"')
    expect(uiIdSrc).not.toContain('"ui.tabs.close": "Tutup Tab"')
  })
})

// Referrals #6 + #7 (F-D2-4 / F-D2-5): the rail reused status.popover.tab.servers, so the
// group and its child tab collapsed to one Indonesian word. The rail gets its own key; the
// r6 ruling puts the collection word on the TAB, not the group, and leaves English identical.
describe("#6 + #7 settings rail gets its own Servers key", () => {
  test("new rail key values match the r6 ruling byte-for-byte", () => {
    expect(id["settings.tab.servers"]).toBe("Daftar server")
    expect(en["settings.tab.servers"]).toBe("Servers")
  })

  test("group label and borrowed popover tab values are unchanged", () => {
    expect(id["settings.section.server"]).toBe("Server")
    expect(id["status.popover.tab.servers"]).toBe("Server")
    expect(en["settings.section.server"]).toBe("Server")
    expect(en["status.popover.tab.servers"]).toBe("Servers")
  })

  test("English rail value is byte-identical to what the same line renders today", () => {
    // Before: rail rendered status.popover.tab.servers ("Servers"). After: settings.tab.servers.
    expect(en["settings.tab.servers"]).toBe(en["status.popover.tab.servers"])
  })

  test("Indonesian group and rail tab now read differently", () => {
    expect(id["settings.section.server"]).not.toBe(id["settings.tab.servers"])
  })

  test("the rail call site switched to the new key", () => {
    expect(railSrc).toContain('language.t("settings.tab.servers")')
    expect(railSrc).not.toContain('language.t("status.popover.tab.servers")')
  })
})
