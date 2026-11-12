import { describe, expect, test } from "bun:test"
import { DESKTOP_NATIVE_ENGLISH, DESKTOP_NATIVE_LOCALES } from "./desktop-native"

// Row 109 of docs/2026-11-12_swarm_1_2_6_patch: the 1.2.6 i18n contract (UX-01, UX-02, UX-03).
// UX-02 memory strings are in all 62 locales with a {{max}} placeholder and no hard-coded limit; the
// Re-check Tools menu label is in every locale; the UX-03 keys and the UX-01 consent texts are in en and id.

const table = async (locale: string): Promise<Record<string, string>> => (await import(`./${locale}.ts`)).dict
const MEMORY_KEYS = ["memory.refused.long", "memory.refused.bodyLong", "memory.refused.tooManyRefs"]
// 400 in Latin, Devanagari, Bengali, Persian, Khmer, Myanmar and Tibetan digits (the old hard-coded limit).
const OLD_LIMIT = /400|४००|৪০০|۴۰۰|៤០០|၄၀၀|༤༠༠/

describe("1.2.6 i18n contract", () => {
  test("UX-02: memory refusals carry {{max}} and no hard-coded 400 in all 62 locales", async () => {
    expect(DESKTOP_NATIVE_LOCALES.length).toBe(62)
    for (const locale of DESKTOP_NATIVE_LOCALES) {
      const dict = await table(locale)
      for (const key of MEMORY_KEYS) {
        expect({ locale, key, max: dict[key]?.includes("{{max}}") }).toEqual({ locale, key, max: true })
        expect({ locale, key, old: OLD_LIMIT.test(dict[key] ?? "") }).toEqual({ locale, key, old: false })
      }
    }
  })

  test("UX-03: Re-check Tools is a native menu key carried by every locale", async () => {
    expect(DESKTOP_NATIVE_ENGLISH["desktop.menu.recheckTools"]).toBe("Re-check Tools")
    for (const locale of DESKTOP_NATIVE_LOCALES) {
      const dict = await table(locale)
      expect({ locale, label: (dict["desktop.menu.recheckTools"] ?? "").trim() !== "" }).toEqual({
        locale,
        label: true,
      })
    }
  })

  test("UX-03: drift line and checkpoint group keys exist in en and id", async () => {
    for (const locale of ["en", "id"]) {
      const dict = await table(locale)
      expect(dict["session.mission.line.drift"]).toContain("{{count}}")
      expect(dict["session.autonomy.checkpoint.title"]).toContain("{{count}}")
      expect(dict["session.autonomy.checkpoint.revert"]?.trim()).toBeTruthy()
      expect(dict["session.autonomy.checkpoint.confirm"]?.trim()).toBeTruthy()
    }
  })

  test("UX-01: the consent dialog states the checkpoint and hidden-values behaviour", async () => {
    const en = await table("en")
    const id = await table("id")
    expect(en["dialog.autonomyBypass.archive"]).toContain("run after Swarm saves a checkpoint")
    expect(en["dialog.autonomyBypass.secrets"]).toContain("Their values stay hidden as [hidden:NAME]")
    expect(id["dialog.autonomyBypass.archive"]).toContain("dijalankan setelah Swarm menyimpan titik pemulihan")
    expect(id["dialog.autonomyBypass.secrets"]).toContain("Nilainya tetap disembunyikan sebagai [hidden:NAME]")
    // git reset --hard and git clean now run after a checkpoint, so no text may say they do not run.
    for (const dict of [en, id]) {
      expect(dict["dialog.autonomyBypass.refused"]).not.toContain("git reset --hard")
      expect(dict["dialog.autonomyBypass.refused"]).not.toContain("git clean")
    }
  })
})
