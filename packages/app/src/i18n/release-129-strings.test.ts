import { describe, expect, test } from "bun:test"

// Row 24 of docs/2026-11-14_swarm_1_2_9_patch (N9-142, AC-C04 keys): the 1.2.9 i18n contract.
// N9-040/N9-041 are the two plural forms of the tidy result (AC-C04), N9-044 is the person text for REHOME_APPROVAL_MISSING,
// N9-042 (`session.mission.tidy.done`) is gone. The new keys are exempt in both lists (en and id only, the
// 1.2.6-1.2.8 convention), which moves the pin from 327 to 329 (+2 N9-040/041, +1 N9-044, -1 N9-042; N9-045, C13).
// Row 79b (C112, INTENT): `session.mission.tidy.approve` becomes `.one`/`.other` (+2 -1): 5 keys here, pin 330.

const app = async (locale: string): Promise<Record<string, string>> => (await import(`./${locale}.ts`)).dict

const NEW_APP: Record<string, { en: string; id: string }> = {
  "session.mission.tidy.approve.one": {
    en: "Approve and move {{count}} mission",
    id: "Setujui dan pindahkan {{count}} misi",
  },
  "session.mission.tidy.approve.other": {
    en: "Approve and move {{count}} missions",
    id: "Setujui dan pindahkan {{count}} misi",
  },
  "session.mission.tidy.done.one": {
    en: "{{count}} mission moved. Its memory notes moved with it.",
    id: "{{count}} misi dipindahkan. Catatan memorinya ikut dipindahkan.",
  },
  "session.mission.tidy.done.other": {
    en: "{{count}} missions moved. Their memory notes moved with them.",
    id: "{{count}} misi dipindahkan. Catatan memorinya ikut dipindahkan.",
  },
  "session.mission.move.error.approval": {
    en: "Swarm could not confirm your answer for this move in DATUM Studio. Nothing was moved. Check that DATUM Studio is running, then try again.",
    id: "Swarm tidak dapat memastikan jawaban Anda untuk pemindahan ini di DATUM Studio. Tidak ada yang dipindahkan. Pastikan DATUM Studio berjalan, lalu coba lagi.",
  },
}

const REMOVED = "session.mission.tidy.done"

describe("1.2.9 i18n contract (N9-142)", () => {
  test("the register lists 5 new app keys", () => {
    expect(Object.keys(NEW_APP).length).toBe(5)
  })

  test("every new key carries the register text in en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      const dict = await app(locale)
      for (const [key, text] of Object.entries(NEW_APP))
        expect({ locale, key, value: dict[key] }).toEqual({ locale, key, value: text[locale] })
    }
  })

  test("N9-042 session.mission.tidy.done is absent from en, id and both exemption lists", async () => {
    for (const locale of ["en", "id"]) {
      const dict = await app(locale)
      expect({ locale, present: Object.hasOwn(dict, REMOVED) }).toEqual({ locale, present: false })
    }
    for (const file of ["parity.test.ts", "parity-exemption-guard.test.ts"]) {
      const text = await Bun.file(new URL(`./${file}`, import.meta.url)).text()
      expect({ file, listed: text.includes(`"${REMOVED}",`) }).toEqual({ file, listed: false })
    }
  })

  test("the id catalogue keeps one text for both plural forms", async () => {
    const id = await app("id")
    expect(id["session.mission.tidy.done.one"]).toBe(id["session.mission.tidy.done.other"])
    expect(id["session.mission.tidy.approve.one"]).toBe(id["session.mission.tidy.approve.other"])
  })

  test("the 5 new keys are exempt in both lists and no other locale carries them", async () => {
    const parity = await Bun.file(new URL("./parity.test.ts", import.meta.url)).text()
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    for (const key of Object.keys(NEW_APP)) {
      expect({ key, parity: parity.includes(`"${key}",`) }).toEqual({ key, parity: true })
      expect({ key, guard: guard.includes(`"${key}",`) }).toEqual({ key, guard: true })
    }
    const fr = await app("fr")
    for (const key of Object.keys(NEW_APP)) expect({ key, present: Object.hasOwn(fr, key) }).toEqual({ key, present: false })
  })

  test("the exemption pin is 366 at both sites (INTENT, office-addin row 45 / C13: 349 + 17, pinned in release-office-addin-strings.test.ts)", async () => {
    const guard = await Bun.file(new URL("./parity-exemption-guard.test.ts", import.meta.url)).text()
    expect(guard.split("toBe(366)").length - 1).toBe(2)
    expect(guard.split("toBe(327)").length - 1).toBe(0)
  })
})
