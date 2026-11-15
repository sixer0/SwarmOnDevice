import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as idDict } from "@/i18n/id"
import { dict as uiDict } from "@opencode-ai/ui/i18n/en"
import { dict as uiIdDict } from "@opencode-ai/ui/i18n/id"

// 1.2.10 row 58 (AC-P4b, N10-179): the memory view says why a note stays out of the Obsidian vault copy.
// Each note the server lists in `kept` shows one reason label in its existing label line, and one rule sentence
// sits at the top of the notes group. The expected texts are written out here (N10-090..N10-093), not read from the
// dictionaries, so the test does not depend on the keys it checks.

// Bun compiles JSX for React. These are the compilers the app's own build uses, reached through its Vite plugin.
const viteSolid = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = viteSolid("@babel/core")
const presets = [
  [viteSolid.resolve("babel-preset-solid"), { generate: "dom" }],
  [viteSolid.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
]
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /packages\/(ui|session-ui|app)\/src\/.*\.tsx$/ }, async (args) => ({
      contents: babel.transformSync(await Bun.file(args.path).text(), { filename: args.path, presets }).code,
      loader: "js",
    }))
  },
})

type Translate = (key: string, params?: Record<string, string | number | boolean>) => string
// The same translator the app builds (context/language.tsx): flattened app + ui dictionaries, templates resolved.
const translators = {
  en: i18n.translator(() => i18n.flatten({ ...dict, ...uiDict }), i18n.resolveTemplate) as Translate,
  id: i18n.translator(
    () => i18n.flatten({ ...dict, ...uiDict, ...idDict, ...uiIdDict }),
    i18n.resolveTemplate,
  ) as Translate,
}

type Item = Record<string, unknown>
type Kept = { id: string; reason: string }
const state: {
  locale: "en" | "id"
  items: Item[]
  kept: Kept[]
  vaultFails: boolean
  vaultCalls: unknown[][]
} = { locale: "en", items: [], kept: [], vaultFails: false, vaultCalls: [] }

const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string | number | boolean>) => translators[state.locale](key, params),
    locale: () => state.locale,
  }),
}))

const client = {
  memory: {
    get: async () => ({ data: { enabled: true, items: state.items } }),
    add: async () => ({ data: { item: state.items[0] } }),
    remove: async () => ({ data: true }),
    update: async () => ({ data: {} }),
    settings: async () => ({ data: true }),
    vault: async (...args: unknown[]) => {
      state.vaultCalls.push(args)
      if (state.vaultFails) throw new Error("vault unavailable")
      return {
        data: { folder: "p", hubPath: "/vault/swarm-memory/p/index.md", exists: true, kept: state.kept },
      }
    },
  },
}
const sdk = { client, event: { on: () => () => {} } }
const realSdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...realSdk, useSDK: () => () => sdk }))

const { DialogProvider, useDialog } = await import("@opencode-ai/ui/context/dialog")
const { DialogProjectMemory } = await import(new URL("../src/components/project-memory.tsx", import.meta.url).pathname)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
  state.locale = "en"
  state.items = []
  state.kept = []
  state.vaultFails = false
  state.vaultCalls = []
})

async function open() {
  let dialog!: ReturnType<typeof useDialog>
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          dialog = useDialog()
          return null
        },
      }),
    host,
  )
  dialog.show(() => createComponent(DialogProjectMemory, {}))
  await tick(30)
}

const TEXT = {
  en: {
    rule: "Notes kept on this device, secret-looking notes and notes marked as classified are not copied to the Obsidian vault. Notes for any model are copied. You can copy a note kept on this device yourself.",
    device: "Kept on this device",
    secret: "Looks secret: never copied",
    classified: "Marked as classified: never copied",
  },
  id: {
    rule: "Catatan yang hanya di perangkat ini, catatan yang tampak berisi rahasia, dan catatan yang ditandai sebagai dokumen berklasifikasi tidak disalin ke vault Obsidian. Catatan untuk model apa pun disalin. Anda dapat menyalin sendiri catatan yang hanya di perangkat ini.",
    device: "Hanya di perangkat ini",
    secret: "Tampak berisi rahasia: tidak pernah disalin",
    classified: "Ditandai berklasifikasi: tidak pernah disalin",
  },
} as const
const LABELS = ["device", "secret", "classified"] as const

// Synthetic store (no user data): one note per reason, a clean any-model note, and one live index entry.
const note = (id: string, extra: Item = {}): Item => ({
  id,
  text: `hook ${id}`,
  source: "agent",
  deviceOnly: false,
  time: 1,
  ...extra,
})
const store = () => [
  note("n-device", { deviceOnly: true }),
  note("n-secret", { deviceOnly: true }),
  note("n-classified"),
  note("n-unsafe"),
  note("n-clean"),
  {
    id: "2026-05-02_m",
    text: "2026-05-02 2026-05-02_m | done | triggers: memory | docs/2026-05-02_m/10_report/report.md",
    source: "agent",
    deviceOnly: true,
    time: 2,
    kind: "index",
    missionId: "2026-05-02_m",
  },
]
const kept = (): Kept[] => [
  { id: "n-device", reason: "device" },
  { id: "n-secret", reason: "secret" },
  { id: "n-classified", reason: "classified" },
  { id: "n-unsafe", reason: "unsafe" },
  { id: "2026-05-02_m", reason: "device" },
]

const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1
const row = (id: string) => document.querySelector(`[data-memory-item="${id}"]`)
/** How often each reason label appears in the row's label line (the line that holds the scope button). */
const labelCounts = (id: string, locale: "en" | "id") => {
  const line = row(id)?.querySelector("[data-memory-scope]")?.parentElement?.textContent ?? ""
  return LABELS.map((reason) => occurrences(line, TEXT[locale][reason]))
}
const ruleParagraphs = (locale: "en" | "id") =>
  [...document.querySelectorAll("p")].filter((p) => p.textContent === TEXT[locale].rule)

for (const locale of ["en", "id"] as const) {
  describe(`reason labels and the rule sentence (${locale})`, () => {
    test("each kept note shows exactly one label for its reason; unsafe and clean notes show none", async () => {
      state.locale = locale
      state.items = store()
      state.kept = kept()
      await open()
      expect(labelCounts("n-device", locale)).toEqual([1, 0, 0])
      expect(labelCounts("n-secret", locale)).toEqual([0, 1, 0])
      expect(labelCounts("n-classified", locale)).toEqual([0, 0, 1])
      expect(labelCounts("2026-05-02_m", locale)).toEqual([1, 0, 0])
      expect(labelCounts("n-unsafe", locale)).toEqual([0, 0, 0])
      expect(labelCounts("n-clean", locale)).toEqual([0, 0, 0])
    })

    test("the rule sentence appears exactly once, at the top of the notes group", async () => {
      state.locale = locale
      state.items = store()
      state.kept = kept()
      await open()
      const rules = ruleParagraphs(locale)
      expect(rules.length).toBe(1)
      expect(occurrences(document.body.textContent ?? "", TEXT[locale].rule)).toBe(1)
      // Above every ordinary note, below the mission index group.
      const first = row("n-clean")
      const index = document.querySelector("[data-memory-index]")
      expect(first !== null && index !== null).toBe(true)
      if (!first || !index) return
      expect(Boolean(rules[0].compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
      expect(Boolean(index.compareDocumentPosition(rules[0]) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    })
  })
}

describe("the vault request", () => {
  test("is sent when the dialog opens, without a language", async () => {
    state.items = store()
    state.kept = kept()
    await open()
    expect(state.vaultCalls.length).toBeGreaterThanOrEqual(1)
    const languages = state.vaultCalls.filter((args) =>
      args.some((arg) => typeof arg === "object" && arg !== null && "language" in arg),
    )
    expect(languages.length).toBe(0)
  })

  test("is asked again after a successful save, so a label follows the note's new state", async () => {
    state.items = store()
    state.kept = []
    await open()
    expect(labelCounts("n-device", "en")).toEqual([0, 0, 0])
    const before = state.vaultCalls.length
    state.kept = kept()
    row("n-clean")!.querySelector<HTMLElement>("[data-memory-scope]")!.click()
    await tick(30)
    expect(state.vaultCalls.length).toBeGreaterThan(before)
    expect(labelCounts("n-device", "en")).toEqual([1, 0, 0])
  })

  test("a failed request shows no labels and keeps the rule sentence", async () => {
    state.items = store()
    state.kept = kept()
    state.vaultFails = true
    await open()
    expect(state.vaultCalls.length).toBeGreaterThanOrEqual(1)
    for (const id of ["n-device", "n-secret", "n-classified", "2026-05-02_m"])
      expect(labelCounts(id, "en")).toEqual([0, 0, 0])
    expect(ruleParagraphs("en").length).toBe(1)
    expect(document.querySelector("[data-memory-error]")).toBeNull()
  })
})
