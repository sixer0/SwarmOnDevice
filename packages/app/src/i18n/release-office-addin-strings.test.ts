import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_ENGLISH, DESKTOP_NATIVE_KEYS } from "./desktop-native"
import { dict as en } from "./en"
import { dict as id } from "./id"

// Row 45 / M1-04 of docs/2026-11-16_swarm_office_addin (decision C13: EN and ID only). The seventeen native strings of
// the Office Add-in, register rev 4 §8.3: the menu, the three-code pairing dialog, the install notice, the
// Finder-guided install fallback (U11), the disable dialog with its certificate checkbox and the errors. Main reads
// them through nativeT; a missing key or a lost placeholder fails here.
const KEYS = {
  "desktop.menu.officeAddin": [],
  "desktop.menu.officeAddin.enable": [],
  "desktop.menu.officeAddin.disconnect": [],
  "desktop.menu.officeAddin.clearCache": [],
  "desktop.officeAddin.pair.title": [],
  "desktop.officeAddin.pair.message": ["host"],
  "desktop.officeAddin.pair.deny": [],
  "desktop.officeAddin.installed": [],
  "desktop.officeAddin.error.portInUse": [],
  "desktop.officeAddin.error.certUntrusted": [],
  "desktop.officeAddin.error.startFailed": [],
  "desktop.officeAddin.error.installFailed": ["path"],
  "desktop.officeAddin.clearCache.confirm": [],
  "desktop.officeAddin.clearCache.confirmButton": [],
  "desktop.officeAddin.disable.confirm": [],
  "desktop.officeAddin.disable.removeCertificate": [],
  "desktop.officeAddin.disable.confirmButton": [],
} as const

const placeholders = (text: string) => [...new Set([...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]))].sort()
const locales: Record<string, Record<string, string>> = { en, id }
const names = Object.keys(KEYS)

describe("Office Add-in desktop strings (EN, ID)", () => {
  test("the native English bundle carries exactly these seventeen Office keys", () => {
    const office = DESKTOP_NATIVE_KEYS.filter((key) => key.startsWith("desktop.menu.officeAddin") || key.startsWith("desktop.officeAddin."))
    expect(office).toEqual(names as typeof office)
  })

  for (const [locale, table] of Object.entries(locales))
    test(`${locale} carries every Office key, non-empty, with the placeholders main fills`, () => {
      const missing = names.filter((key) => typeof table[key] !== "string" || table[key].trim() === "")
      expect({ locale, missing }).toEqual({ locale, missing: [] })
      for (const [key, params] of Object.entries(KEYS)) expect({ key, params: placeholders(table[key]) }).toEqual({ key, params: [...params] })
    })

  test("the retired Allow key is absent and the pairing message carries no code (RC-1 row 23)", () => {
    for (const table of Object.values(locales)) {
      expect(Object.hasOwn(table, "desktop.officeAddin.pair.allow")).toBe(false)
      expect(table["desktop.officeAddin.pair.message"]).not.toContain("{{code}}")
    }
  })

  test("the Indonesian text is translated, keeps product names, and no text has emoji", () => {
    for (const key of names) {
      expect({ key, same: id[key as keyof typeof id] === en[key as keyof typeof en] }).toEqual({ key, same: false })
      expect(id[key as keyof typeof id]).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(en[key as keyof typeof en]).not.toMatch(/\p{Extended_Pictographic}/u)
    }
    expect(id["desktop.officeAddin.error.installFailed"]).toContain("swarm-office-addin.xml")
    expect(id["desktop.officeAddin.error.installFailed"]).toContain("Finder")
    expect(id["desktop.officeAddin.disable.confirm"]).toContain("Word")
  })

  test("the keys sit after the positionally mapped keys and before the DATUM tail", () => {
    const first = DESKTOP_NATIVE_KEYS.indexOf("desktop.menu.officeAddin")
    expect(DESKTOP_NATIVE_KEYS.slice(first, first + names.length)).toEqual(names as typeof DESKTOP_NATIVE_KEYS)
    expect(first).toBeGreaterThan(DESKTOP_NATIVE_KEYS.indexOf("desktop.menu.recheckTools"))
    expect(first + names.length).toBeLessThanOrEqual(DESKTOP_NATIVE_KEYS.indexOf("desktop.menu.installDatumStudio"))
    expect(DESKTOP_NATIVE_ENGLISH["desktop.officeAddin.pair.deny"]).toBe("Deny")
  })

  test("the exemption pin is 366 at both sites (349 + 17, C13)", async () => {
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    expect(guard.split("toBe(366)").length - 1).toBe(2)
    expect(guard.split("toBe(349)").length - 1).toBe(0)
    const gate = await Bun.file(new URL("./parity.test.ts", import.meta.url)).text()
    for (const key of names) expect({ key, exempt: gate.includes(`"${key}",`) }).toEqual({ key, exempt: true })
  })
})
