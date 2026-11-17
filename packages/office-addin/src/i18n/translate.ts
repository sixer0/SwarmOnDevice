// Pane i18n (REG §8.3, FS FR-52, D16 of C22). Two locales, `en` (base) and `id`; a key missing
// from `id` falls back to `en`. The UI language comes from `Office.context.displayLanguage`, else
// `navigator.language`, else `en`. `Office.context.contentLanguage` is never read: it follows the
// document's proofing language, not the UI (SP-S3: displayLanguage en-US, contentLanguage en-ID).
import { resolveTemplate, translator } from "@solid-primitives/i18n"
import { OFFICE_LOCALES } from "../constants"
import { dict as en } from "./en"
import { dict as id } from "./id"

export type Locale = (typeof OFFICE_LOCALES)[number]
export type MessageKey = keyof typeof en
export type Params = Record<string, string | number>
export type Translate = (key: MessageKey, params?: Params) => string

// `id*` (id, id-ID) maps to `id`; every other tag, and a missing one, maps to `en`.
export function detectLocale(input: { displayLanguage?: string; navigatorLanguage?: string }): Locale {
  const tag = input.displayLanguage || input.navigatorLanguage || "en"
  return /^id(-|_|$)/i.test(tag) ? "id" : "en"
}

export function dictionary(locale: Locale): Record<MessageKey, string> {
  if (locale === "id") return { ...en, ...id }
  return en
}

export function createTranslate(locale: Locale): Translate {
  const strings = dictionary(locale)
  const translate = translator(() => strings, resolveTemplate)
  const numbers = new Intl.NumberFormat(locale === "id" ? "id-ID" : "en-US")
  return (key, params) => {
    const values = params
      ? Object.fromEntries(
          Object.entries(params).map(([name, value]) => [name, typeof value === "number" ? numbers.format(value) : value]),
        )
      : undefined
    // Rev 7 (C93): a key with a `.one` sibling uses it when `count` is exactly 1 ("1 paragraph").
    const one = `${key}.one`
    const chosen = params?.count === 1 && one in strings ? (one as MessageKey) : key
    return translate(chosen, values) ?? en[chosen]
  }
}
