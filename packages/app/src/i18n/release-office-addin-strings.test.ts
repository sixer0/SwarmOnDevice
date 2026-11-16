import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_ENGLISH, DESKTOP_NATIVE_KEYS } from "./desktop-native"
import { dict as en } from "./en"
import { dict as id } from "./id"

// Row 45 / M1-04 of docs/2026-11-16_swarm_office_addin (decision C13: EN and ID only), plus M1-04b (C49) and M1-04c (C65). The twenty native strings of
// the Office Add-in, register rev 4 §8.3: the menu, the three-code pairing dialog, the install notice, the
// Finder-guided install and uninstall fallbacks (U11, C49), the disable dialog with its certificate checkbox and the errors (incl. C65 not-installed and cert removal). Main reads
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
  "desktop.officeAddin.error.uninstallFailed": ["path"],
  "desktop.officeAddin.error.notInstalled": ["path"],
  "desktop.officeAddin.error.certRemovalFailed": [],
} as const

const placeholders = (text: string) => [...new Set([...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]))].sort()
const locales: Record<string, Record<string, string>> = { en, id }
const names = Object.keys(KEYS)

describe("Office Add-in desktop strings (EN, ID)", () => {
  test("the native English bundle carries exactly these twenty Office keys", () => {
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

  // M1-04a (CP-M4 F-3, SC-15): allow only if the user just clicked Connect in the pane. The quoted labels must equal the
  // pane's `office.connect.button` (packages/office-addin/src/i18n/en.ts, id.ts) and this bundle's Deny key.
  test("the pairing message names the pane's Connect button and the Deny button (SC-15)", () => {
    const labels = { en: { connect: "Connect", deny: en["desktop.officeAddin.pair.deny"] }, id: { connect: "Hubungkan", deny: "Tolak" } }
    for (const [locale, table] of Object.entries(locales)) {
      const label = labels[locale as keyof typeof labels]
      expect(table["desktop.officeAddin.pair.message"]).toContain(label.connect)
      expect(table["desktop.officeAddin.pair.message"]).toContain(label.deny)
    }
    expect(id["desktop.officeAddin.pair.deny"]).toBe("Tolak")
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

  // M1-04b (C49): the Finder-guided uninstall mirror of installFailed. It names the file, Finder and the Trash.
  test("the uninstall fallback names the manifest file, Finder and the Trash in both locales", () => {
    const trash = { en: "Trash", id: "Tempat Sampah" }
    for (const [locale, table] of Object.entries(locales)) {
      const text = table["desktop.officeAddin.error.uninstallFailed"]
      expect(text).toContain("swarm-office-addin.xml")
      expect(text).toContain("Finder")
      expect(text).toContain(trash[locale as keyof typeof trash])
      expect(text).not.toBe(table["desktop.officeAddin.error.installFailed"])
    }
  })

  // M1-04c (C65): Office missing (wef parents absent) and a failed certificate removal on Disable.
  test("the not-installed and certificate-removal errors name Word, Excel and the keychain in both locales", () => {
    const keychain = { en: "keychain", id: "rantai kunci" }
    for (const [locale, table] of Object.entries(locales)) {
      expect(table["desktop.officeAddin.error.notInstalled"]).toContain("Word")
      expect(table["desktop.officeAddin.error.notInstalled"]).toContain("Excel")
      expect(table["desktop.officeAddin.error.notInstalled"].trimEnd().endsWith("{{path}}")).toBe(true)
      expect(table["desktop.officeAddin.error.certRemovalFailed"]).toContain(keychain[locale as keyof typeof keychain])
      // Same keychain term as the disable dialog's checkbox, so the two texts read as one concept.
      expect(table["desktop.officeAddin.disable.removeCertificate"]).toContain(keychain[locale as keyof typeof keychain])
    }
  })

  test("the keys sit after the positionally mapped keys and before the DATUM tail", () => {
    const first = DESKTOP_NATIVE_KEYS.indexOf("desktop.menu.officeAddin")
    expect(DESKTOP_NATIVE_KEYS.slice(first, first + names.length)).toEqual(names as typeof DESKTOP_NATIVE_KEYS)
    expect(first).toBeGreaterThan(DESKTOP_NATIVE_KEYS.indexOf("desktop.menu.recheckTools"))
    expect(first + names.length).toBeLessThanOrEqual(DESKTOP_NATIVE_KEYS.indexOf("desktop.menu.installDatumStudio"))
    expect(DESKTOP_NATIVE_ENGLISH["desktop.officeAddin.pair.deny"]).toBe("Deny")
  })

  test("the exemption pin is 369 at both sites (349 + 17 C13 + 1 C49 + 2 C65)", async () => {
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    expect(guard.split("toBe(369)").length - 1).toBe(2)
    expect(guard.split("toBe(367)").length - 1).toBe(0)
    expect(guard.split("toBe(366)").length - 1).toBe(0)
    expect(guard.split("toBe(349)").length - 1).toBe(0)
    const gate = await Bun.file(new URL("./parity.test.ts", import.meta.url)).text()
    for (const key of names) expect({ key, exempt: gate.includes(`"${key}",`) }).toEqual({ key, exempt: true })
  })
})
