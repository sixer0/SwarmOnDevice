import { describe, expect, test } from "bun:test"
import { desktopNativePluralCategories } from "./desktop-native"

const appLocales = [
  "ar",
  "br",
  "bs",
  "da",
  "de",
  "es",
  "fr",
  "ja",
  "ko",
  "no",
  "pl",
  "ru",
  "uk",
  "th",
  "tr",
  "zh",
  "zht",
  "hi",
  "nl",
  "id",
  "vi",
  "it",
  "ur",
  "pa",
  "az",
  "fi",
  "sv",
  "am",
  "bg",
  "bn",
  "ca",
  "cs",
  "dv",
  "dz",
  "el",
  "et",
  "fa",
  "fo",
  "hr",
  "hu",
  "hy",
  "is",
  "ka",
  "km",
  "lo",
  "lt",
  "lv",
  "mk",
  "mn",
  "ms",
  "my",
  "ne",
  "ro",
  "si",
  "sk",
  "sl",
  "sq",
  "sr",
  "tg",
  "tk",
  "uz",
] as const
const desktopLocales = appLocales
const pluralCategories = new Map(
  appLocales.map(
    (locale) =>
      [
        locale,
        desktopNativePluralCategories(locale).filter((category) => category !== "one" && category !== "other"),
      ] as const,
  ),
)

// Narrow presence-only exemption, branch B of the 2026-10-21 i18n propagation decision
// (`docs/2026-10-19_opencode_swarm_rebrand/decisions/decisions.md`: "A if a credential exists, else B";
// no credential was supplied). Keys landed in the `en` and `id` tables only, ahead of the translation
// lane, so this list excuses PRESENCE of exactly those keys in every locale other than `en` and `id`.
// It does not change what any other assertion checks: values, placeholders, plural variants and `extra`
// keys are still enforced for these same keys once a locale carries them. Proper closure is
// `bun run translate:app -- all`, which translates them and retires this list.
// Deliberate batches live here, each real in `en`+`id` and absent in the other 60 locales:
//   - the original three (branch B): `command.project.openNumber` and `settings.tab.servers` (app
//     table) plus `ui.toast.ariaLabel` (ui table — row 170's accessible region name, see
//     packages/ui/src/v2/components/toast-v2.tsx:21);
//   - six more landed by blueprint-10 row 204 (session 6, CONTROLLER GATE ruling (i) in decisions.md):
//     the Home status card's four level names plus its level-4 non-claim (`setup.status.installed`,
//     `.registered`, `.visible`, `.used`, `.notClaimed`) and the freed sixth slot
//     `mcp.status.needs_client_registration`, which also repairs the dangling key referenced at
//     packages/app/src/components/dialog-select-mcp.tsx:13;
//   - one more by blueprint-11 row 249 (session 6, USER DECISIONS 2026-10-22 item 1: the i18n cap moved
//     six → seven by explicit user decision, spent entirely on the apply-consequence sentence
//     `setup.lanes.apply_warning` shown by the lane controls on the Home card);
//   - two more for the Knowledge Library row in Settings (`settings.general.row.knowledgeLibrary.title`
//     and `.description`, decision C2 in `docs/2026-11-01_knowledge_library_default/decisions/decisions.md`).
// Widening this list is a decision, not drift: `parity-exemption-guard.test.ts` fails the suite on any
// thirteenth entry, on any non-literal/wildcard, and if `en` or `id` ever stops carrying an exempt key.
const UNTRANSLATED_KEY_PRESENCE_EXEMPTION: readonly string[] = [
  "command.project.openNumber",
  "settings.tab.servers",
  "ui.toast.ariaLabel",
  "setup.status.installed",
  "setup.status.registered",
  "setup.status.visible",
  "setup.status.used",
  "setup.status.notClaimed",
  "mcp.status.needs_client_registration",
  "setup.lanes.apply_warning",
  "settings.general.row.knowledgeLibrary.title",
  "settings.general.row.knowledgeLibrary.description",
]
// Locales the exemption never applies to. `en` is every domain's source, and `id` is the second
// maintained locale: it already carries every exempt key, so it stays fully enforced like the rest.
const NEVER_EXEMPT_LOCALES: readonly string[] = ["en", "id"]

function exemptFromPresence(key: string, locale: string) {
  return UNTRANSLATED_KEY_PRESENCE_EXEMPTION.includes(key) && !NEVER_EXEMPT_LOCALES.includes(locale)
}

const domains = [
  {
    name: "app",
    source: "./en.ts",
    target: (locale: string) => `./${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "ui",
    source: "../../../ui/src/i18n/en.ts",
    target: (locale: string) => `../../../ui/src/i18n/${locale}.ts`,
    locales: appLocales,
  },
  {
    name: "desktop",
    source: "../../../desktop/src/renderer/i18n/en.ts",
    target: (locale: string) => `../../../desktop/src/renderer/i18n/${locale}.ts`,
    locales: desktopLocales,
  },
] as const

describe("i18n parity", () => {
  test("non-English locales have every English key and required plural variants", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = Object.keys(source).filter(
          (key) => !Object.hasOwn(target, key) && !exemptFromPresence(key, locale),
        )
        const extra = Object.keys(target)
          .filter((key) => !Object.hasOwn(source, key))
          .sort()
        const expected = pluralFamilies(source)
          .flatMap((key) => (pluralCategories.get(locale) ?? []).map((category) => `${key}.${category}`))
          .sort()
        expect({ domain: domain.name, locale, missing, extra }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          extra: expected,
        })
      }
    }
  })

  test("non-English locales preserve English placeholders", async () => {
    for (const domain of domains) {
      const source = await dictionary(domain.source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const mismatched = Object.keys(source).filter(
          (key) => Object.hasOwn(target, key) && placeholders(source[key]).join() !== placeholders(target[key]).join(),
        )
        const pluralMismatched = pluralFamilies(source).flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join()),
        )
        expect({ domain: domain.name, locale, mismatched, pluralMismatched }).toEqual({
          domain: domain.name,
          locale,
          mismatched: [],
          pluralMismatched: [],
        })
      }
    }
  })

  test("non-English locales translate targeted unseen session keys", async () => {
    const source = await dictionary("./en.ts")
    for (const locale of appLocales) {
      const target = await dictionary(`./${locale}.ts`)
      for (const key of ["command.session.previous.unseen", "command.session.next.unseen"]) {
        expect(target[key]).toBeDefined()
        expect(target[key]).not.toBe(source[key])
      }
    }
  })

  test("changed-file summary keys preserve rendered English copy and localize complete phrases", async () => {
    const source = await dictionary("../../../ui/src/i18n/en.ts")
    expect(source["ui.sessionTurn.diffs.changed.one"].replace("{{count}}", "1")).toBe("1 Changed file")
    expect(source["ui.sessionTurn.diffs.changed.other"].replace("{{count}}", "2")).toBe("2 Changed files")
    expect(source["ui.sessionTurn.diffs.changed"]).toBeUndefined()

    for (const locale of appLocales) {
      const target = await dictionary(`../../../ui/src/i18n/${locale}.ts`)
      for (const key of ["ui.sessionTurn.diffs.changed.one", "ui.sessionTurn.diffs.changed.other"]) {
        expect(target[key].trim()).not.toBe("")
        expect(placeholders(target[key])).toEqual(["count"])
      }
    }
  })
})

describe("i18n plural parity", () => {
  test("locale-specific categories exist and preserve count placeholders", async () => {
    for (const domain of domains.slice(0, 2)) {
      const source = await dictionary(domain.source)
      const families = pluralFamilies(source)
      for (const locale of domain.locales) {
        const target = await dictionary(domain.target(locale))
        const missing = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter((variant) => !Object.hasOwn(target, variant)),
        )
        const mismatched = families.flatMap((key) =>
          (pluralCategories.get(locale) ?? [])
            .map((category) => `${key}.${category}`)
            .filter(
              (variant) =>
                Object.hasOwn(target, variant) &&
                placeholders(source[`${key}.other`]).join() !== placeholders(target[variant]).join(),
            ),
        )
        expect({ domain: domain.name, locale, missing, mismatched }).toEqual({
          domain: domain.name,
          locale,
          missing: [],
          mismatched: [],
        })
      }
    }
  })
})

async function dictionary(file: string) {
  const module: unknown = await import(file)
  if (typeof module !== "object" || module === null || !("dict" in module) || !isDictionary(module.dict)) {
    throw new Error(`Invalid translation dictionary: ${file}`)
  }
  return module.dict
}

function isDictionary(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  return Object.values(value).every((item) => typeof item === "string")
}

function placeholders(value: string) {
  return Array.from(value.matchAll(/{{\s*([^}]+?)\s*}}/g), (match) => match[1]).sort()
}

function pluralFamilies(dictionary: Record<string, string>) {
  return Object.keys(dictionary)
    .filter(
      (key) =>
        key.endsWith(".one") &&
        dictionary[key].includes("{{count}}") &&
        dictionary[`${key.slice(0, -4)}.other`]?.includes("{{count}}"),
    )
    .map((key) => key.slice(0, -4))
}
