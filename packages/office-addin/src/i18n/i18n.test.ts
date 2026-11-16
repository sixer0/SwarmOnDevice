// U-I18N-01..U-I18N-03 (AC-45; REG rev 5 §8.3; FS FR-52, D16).
import { describe, expect, test } from "bun:test"
import { Glob } from "bun"
import { createTranslate, detectLocale, dictionary } from "./translate"
import { dict as en } from "./en"
import { dict as id } from "./id"
import { REVISION_4_KEYS } from "./register-rev4.fixture"

const params = (text: string) => [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).toSorted()
const src = `${import.meta.dir}/..`

async function sources() {
  const files = await Array.fromAsync(new Glob("**/*.{ts,tsx}").scan({ cwd: src }))
  return files.filter((file) => !/\.test\.tsx?$|\.fixture\.ts$|^i18n\/(en|id)\.ts$/.test(file))
}

describe("U-I18N-01 key parity", () => {
  test("en and id hold the same keys with the same {{params}}", () => {
    expect(Object.keys(id).toSorted()).toEqual(Object.keys(en).toSorted())
    for (const key of Object.keys(en) as (keyof typeof en)[]) expect(params(id[key])).toEqual(params(en[key]))
  })

  test("every office.* key referenced in src exists in en.ts", async () => {
    const used = new Set<string>()
    for (const file of await sources()) {
      const text = await Bun.file(`${src}/${file}`).text()
      for (const match of text.matchAll(/["'`](office\.[a-z]+(?:\.[A-Za-z]+)*)["'`]/g)) used.add(match[1]!)
    }
    expect(used.size).toBeGreaterThan(40)
    expect([...used].filter((key) => !(key in en))).toEqual([])
  })
})

describe("U-I18N-02 detection", () => {
  test("displayLanguage first, then navigator.language, then en; id* maps to id", () => {
    expect(detectLocale({ displayLanguage: "id-ID" })).toBe("id")
    expect(detectLocale({ displayLanguage: "id" })).toBe("id")
    expect(detectLocale({ displayLanguage: "en-US" })).toBe("en")
    expect(detectLocale({ displayLanguage: "fr-FR" })).toBe("en")
    expect(detectLocale({})).toBe("en")
    expect(detectLocale({ navigatorLanguage: "id-ID" })).toBe("id")
    expect(detectLocale({ displayLanguage: "en-US", navigatorLanguage: "id-ID" })).toBe("en")
    expect(detectLocale({ displayLanguage: "ida" })).toBe("en")
  })

  test("contentLanguage is never read for the UI language (D16)", async () => {
    for (const file of await sources()) {
      const text = await Bun.file(`${src}/${file}`).text()
      const code = text.replace(/\/\/.*$/gm, "")
      expect({ file, uses: code.includes("contentLanguage") }).toEqual({ file, uses: false })
    }
  })

  test("a key missing from id falls back to en; params are filled", () => {
    expect(dictionary("id")["office.title"]).toBe("Swarm")
    const t = createTranslate("id")
    expect(t("office.reply.insert")).toBe("Sisipkan")
    expect(t("office.context.tagChars", { scope: "Pilihan", count: 1204 })).toBe("Pilihan · 1.204 karakter")
    expect(createTranslate("en")("office.context.tagChars", { scope: "Selection", count: 1204 })).toBe(
      "Selection · 1,204 characters",
    )
  })
})

describe("U-I18N-03 register rev 4 + rev 6 (84 keys)", () => {
  test("en.ts and id.ts each hold exactly 84 office.* keys (81 rev 4 + 3 rev 6, C70)", () => {
    expect(Object.keys(en).length).toBe(84)
    expect(Object.keys(en).every((key) => key.startsWith("office."))).toBe(true)
    expect(Object.keys(id).length).toBe(84)
    expect(params(en["office.reply.preview"])).toEqual(["action"])
  })

  test("the 47 revision 4 keys equal the register table character for character", () => {
    expect(REVISION_4_KEYS.length).toBe(47)
    for (const [key, english, indonesian] of REVISION_4_KEYS) {
      const actual: { key: string; en: string; id: string } = {
        key,
        en: en[key as keyof typeof en],
        id: id[key as keyof typeof id],
      }
      expect(actual).toEqual({
        key,
        en: english,
        id: indonesian,
      })
    }
  })
})

describe("register rev 6 (C70, M8-07b)", () => {
  const REVISION_6_KEYS = [
    ["office.preview.invisible", "{{count}} hidden characters will be written. They are shown as markers below. Click Write again to confirm.", "{{count}} karakter tersembunyi akan ikut ditulis. Karakter itu ditampilkan sebagai penanda di bawah. Klik Tulis sekali lagi untuk mengonfirmasi."],
    ["office.preview.showAll", "Show all", "Tampilkan semua"],
    ["office.preview.fullText", "Full text that will be written", "Teks lengkap yang akan ditulis"],
  ] as const
  test("the 3 revision 6 keys equal the register text; id uses the Write button verb", () => {
    for (const [key, english, indonesian] of REVISION_6_KEYS) {
      expect(en[key]).toBe(english)
      expect(id[key]).toBe(indonesian)
    }
    expect(params(en["office.preview.invisible"])).toEqual(["count"])
    expect(params(id["office.preview.invisible"])).toEqual(["count"])
    expect(id["office.preview.invisible"]).toContain(id["office.reply.confirm"].split(" ")[0]!)
  })
})
