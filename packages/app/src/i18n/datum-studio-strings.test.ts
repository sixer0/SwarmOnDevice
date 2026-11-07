import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_ENGLISH, DESKTOP_NATIVE_KEYS } from "./desktop-native"
import { dict as en } from "./en"
import { dict as id } from "./id"

// Row 34b (decisions C63/C64 of docs/2026-11-06_swarm_1_2_0_datum_installer): the seven native strings of
// Install DATUM Studio for Claude, used by createDatumStudioInstaller (packages/desktop/src/main/cli-install.ts).
// Both maintained locales must carry every key with the placeholders the installer fills; a missing key fails here.
const KEYS = {
  "desktop.menu.installDatumStudio": [],
  "desktop.datumStudio.confirm.message": [],
  "desktop.datumStudio.confirm.detail": ["path"],
  "desktop.datumStudio.done.message": [],
  "desktop.datumStudio.done.detail": ["claude", "path"],
  "desktop.datumStudio.done.pathHint": ["claude", "dir", "path"],
  "desktop.datumStudio.failed.message": [],
} as const

const placeholders = (text: string) => [...new Set([...text.matchAll(/\{\{([^{}]+)\}\}/g)].map((m) => m[1]))].sort()
const locales: Record<string, Record<string, string>> = { en, id }

describe("Install DATUM Studio for Claude strings (EN, ID)", () => {
  for (const [locale, table] of Object.entries(locales))
    test(`${locale} carries all seven keys, non-empty, with the installer's placeholders`, () => {
      const missing = Object.keys(KEYS).filter((key) => typeof table[key] !== "string" || table[key].trim() === "")
      expect({ locale, missing }).toEqual({ locale, missing: [] })
      for (const [key, params] of Object.entries(KEYS)) expect({ key, params: placeholders(table[key]) }).toEqual({ key, params: [...params] })
    })

  test("the Indonesian text is translated, keeps MCP/CLI terms and the command name, and has no emoji", () => {
    for (const key of Object.keys(KEYS)) {
      expect({ key, same: id[key as keyof typeof id] === en[key as keyof typeof en] }).toEqual({ key, same: false })
      expect(id[key as keyof typeof id]).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(en[key as keyof typeof en]).not.toMatch(/\p{Extended_Pictographic}/u)
    }
    expect(id["desktop.datumStudio.confirm.detail"]).toContain("MCP")
    expect(id["desktop.datumStudio.confirm.message"]).toContain("datum-studio")
  })

  test("the keys are appended after every earlier native key (hr, hu, is and lt map native keys by position)", () => {
    const tail = DESKTOP_NATIVE_KEYS.slice(-Object.keys(KEYS).length)
    expect(tail).toEqual(Object.keys(KEYS) as typeof tail)
    expect(DESKTOP_NATIVE_ENGLISH["desktop.menu.installDatumStudio"]).toBe("Install DATUM Studio for Claude...")
  })
})
