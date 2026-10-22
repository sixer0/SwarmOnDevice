import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { createRoot } from "solid-js"
import * as i18n from "@solid-primitives/i18n"
import { dict as appEn } from "@/i18n/en"
import { dict as appId } from "@/i18n/id"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { dict as uiId } from "@opencode-ai/ui/i18n/id"

// r249 render-path proof (blueprint 11). The apply-consequence sentence must be READ by the card path — the
// LaneControls block row 248 mounted into the Home status card — not just sit in the tables unread.
//
// Why this binds resolution + mount instead of a DOM tree: Solid JSX from this repo cannot render under either
// declared bun lane — measured again on 2026-10-22 by attempting exactly that in ./test-browser: rendering
// LanguageProvider died with `ReferenceError: React is not defined` inside packages/ui/src/context/helper.tsx:27,
// because `"jsx": "preserve"` (packages/app/tsconfig.json:11, packages/ui/tsconfig.json:6) leaves the real
// transform to Vite. That is the same constraint recorded at home-status-card.model.test.ts:6-10 and
// new-session-view-mark.test.ts:19-23; a DOM test here would either not run or run through a hand-rolled shim
// that could go green while the shipped transform breaks. So the proof has two mechanical halves:
//   (1) resolution — the EXACT production call chain from context/language.tsx:46 + :192 (i18n.flatten of
//       app+ui tables, then i18n.translator with resolveTemplate) maps the key to the sentence in `en` and `id`;
//   (2) mount — the component source contains exactly one call to language.t for this key, it sits in the
//       persistent warning element (before ANY <Show> gate in the returned JSX, so nothing can hide it), and the
//       `container-recreate` token face survives beside it.
// E4 discrimination ran against HEAD bytes in scratch: both halves are red there (see implementation report).

const EN_SENTENCE = "Applying recreates the stack and interrupts running work; the change is not live until then."
const ID_SENTENCE =
  "Menerapkan perubahan akan membuat ulang stack dan mengganggu pekerjaan yang sedang berjalan; perubahan belum aktif hingga saat itu."

function translateWithProductionChain(locale: "en" | "id", key: string): string {
  return createRoot((dispose) => {
    try {
      // language.tsx:46 builds the English base; :49-50 merges a locale over it. Same calls, same resolver.
      const base = i18n.flatten({ ...appEn, ...uiEn })
      const merged = locale === "en" ? base : { ...base, ...i18n.flatten({ ...appId, ...uiId }) }
      const t = i18n.translator(() => merged, i18n.resolveTemplate) as (key: string) => string
      return t(key)
    } finally {
      dispose()
    }
  })
}

describe("r249 apply-warning key resolves through the production translator", () => {
  test("en resolves to the routed S2 sentence byte-for-byte", () => {
    expect(translateWithProductionChain("en", "setup.lanes.apply_warning")).toBe(EN_SENTENCE)
  })

  test("id resolves to the Indonesian value through the same merge the provider performs", () => {
    expect(translateWithProductionChain("id", "setup.lanes.apply_warning")).toBe(ID_SENTENCE)
  })

  test("the tables carry exactly one setup.lanes key — the cap moved six to seven, not further", () => {
    const enLanes = Object.keys(appEn).filter((key) => key.startsWith("setup.lanes."))
    const idLanes = Object.keys(appId).filter((key) => key.startsWith("setup.lanes."))
    expect(enLanes).toEqual(["setup.lanes.apply_warning"])
    expect(idLanes).toEqual(["setup.lanes.apply_warning"])
  })

  test("the six declined prose strings stay unminted in the setup family", () => {
    // decisions.md 2026-10-22 item 1 declined S1/S3/S4/S5/S6/S7; they may not appear as values of any
    // setup.* or lanes.* key, which is where row 249 would have put them if it had minted them.
    const declined = [
      "Lanes",
      "Concurrency lanes",
      "Apply",
      "Save",
      "Stored",
      "Applied",
      "Allowed range",
      "Setup default",
      "Queue workers",
      "Browser pages",
      "Search threads",
      "Present in the configuration but not read by this build",
      "Refresh",
    ]
    for (const [locale, dict] of [
      ["en", appEn as Record<string, string>],
      ["id", appId as Record<string, string>],
    ] as const) {
      for (const key of Object.keys(dict)) {
        if (!key.startsWith("setup.") && !key.startsWith("lanes.")) continue
        expect({ locale, key, declined: declined.includes(dict[key]) }).toEqual({
          locale,
          key,
          declined: false,
        })
      }
    }
  })
})

describe("r249 apply-warning is mounted persistently in the card path", () => {
  const source = readFileSync(join(import.meta.dir, "lane-controls.tsx"), "utf8")

  test("the component calls language.t for exactly this key once, and keeps the common.loading reuse", () => {
    expect(source.split('language.t("setup.lanes.apply_warning")').length - 1).toBe(1)
    expect(source.split('language.t("common.loading")').length - 1).toBe(1)
  })

  test("the warning element carries the call and no Show gate can hide it", () => {
    const warningAt = source.indexOf("data-lane-apply-warning")
    expect(warningAt).toBeGreaterThan(-1)
    const block = source.slice(warningAt, source.indexOf("</div>", warningAt))
    expect(block).toContain('language.t("setup.lanes.apply_warning")')
    expect(block).not.toContain("when=")
    // Persistent by position: every <Show> gate in the returned JSX opens AFTER this element, so the sentence
    // renders on mount without depending on a read, a write outcome, or any other condition.
    const firstShow = source.indexOf("<Show")
    expect(warningAt).toBeLessThan(firstShow)
  })

  test("the container-recreate token face survives beside the sentence", () => {
    // The sentence replaced the token's lone-carrier role, not the wire value: the restart class still prints
    // per control and in the applied line.
    expect(source.split("{c.restartClass}").length - 1).toBe(2)
  })
})
