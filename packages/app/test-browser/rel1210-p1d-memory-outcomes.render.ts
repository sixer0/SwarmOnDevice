import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as idDict } from "@/i18n/id"
import { dict as uiDict } from "@opencode-ai/ui/i18n/en"
import { dict as uiIdDict } from "@opencode-ai/ui/i18n/id"

// 1.3.0 row 46 (AC-P1d-app, N10-164; 01a §3.6-3.7): the memory view's "Open graph in Obsidian" press shows exactly
// one toast per desktop outcome, in en and id: `registered` -> success N10-080; `close-obsidian` -> error N10-081;
// `not-registered` -> error N10-082; `opened` -> none; the BASE outcomes keep their 1.2.8 texts. No title is ever
// undefined. The three new texts are written out here (register values), not read from the dictionaries.
// Synthetic data only. Counts, strings and booleans only (C77: happy-dom element printing hangs).

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

type Locale = "en" | "id"
type Result = "opened" | "missing" | "outside" | "no-app" | "failed" | "registered" | "close-obsidian" | "not-registered"
type Toast = { variant: string; title: string | undefined }
const state: { locale: Locale; results: Result[]; ipcCalls: number; toasts: Toast[] } = {
  locale: "en",
  results: [],
  ipcCalls: 0,
  toasts: [],
}

const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string | number | boolean>) => translators[state.locale](key, params),
    locale: () => state.locale,
  }),
}))

const HUB = "/synthetic/vault/swarm-memory/default-project-3fa9c1/index.md"
const client = {
  memory: {
    get: async () => ({ data: { enabled: true, items: [] } }),
    add: async () => ({ data: {} }),
    remove: async () => ({ data: true }),
    update: async () => ({ data: {} }),
    settings: async () => ({ data: true }),
    vault: async () => ({ data: { folder: "default-project-3fa9c1", hubPath: HUB, exists: true, kept: [] } }),
  },
}
const sdk = { client, event: { on: () => () => {} } }
const realSdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...realSdk, useSDK: () => () => sdk }))

// Each press returns the next queued outcome (the desktop's answer).
const platform: Record<string, unknown> = {
  openObsidianNote: async () => {
    state.ipcCalls += 1
    return state.results.shift() ?? "opened"
  },
}
const realPlatform = await import("@/context/platform")
mock.module("@/context/platform", () => ({ ...realPlatform, usePlatform: () => platform }))

const realToast = await import("@/utils/toast")
mock.module("@/utils/toast", () => ({
  ...realToast,
  showToast: (options: { variant?: string; title?: string } | string) => {
    state.toasts.push(
      typeof options === "string"
        ? { variant: "default", title: options }
        : { variant: options.variant ?? "default", title: options.title },
    )
  },
}))

const { DialogProvider, useDialog } = await import("@opencode-ai/ui/context/dialog")
const { DialogProjectMemory } = await import(new URL("../src/components/project-memory.tsx", import.meta.url).pathname)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
  state.locale = "en"
  state.results = []
  state.ipcCalls = 0
  state.toasts = []
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

async function press() {
  const buttons = document.querySelectorAll('[data-action="open-obsidian"]')
  if (buttons.length !== 1) throw new Error(`expected one open-obsidian button, found ${buttons.length}`)
  ;(buttons[0] as HTMLElement).click()
  await tick(30)
}

// N10-080..N10-082 as fixed in the register (amended row 37, C28 RN-5).
const NEW_TEXT: Record<Locale, Record<"registered" | "close-obsidian" | "not-registered", string>> = {
  en: {
    registered: "Swarm added the Swarm vault (~/.swarm/vault) to Obsidian's vault list.",
    "close-obsidian":
      "Close Obsidian, then press Open graph in Obsidian again. If Obsidian is already closed, open it once and quit it normally. Or add the folder yourself: in Obsidian choose Open folder as vault and pick ~/.swarm/vault.",
    "not-registered":
      "Swarm could not add the Swarm vault to Obsidian's vault list safely, so it changed nothing. Add it yourself: in Obsidian choose Open folder as vault and pick ~/.swarm/vault.",
  },
  id: {
    registered: "Swarm menambahkan vault Swarm (~/.swarm/vault) ke daftar vault Obsidian.",
    "close-obsidian":
      "Tutup Obsidian, lalu tekan Buka grafik di Obsidian lagi. Jika Obsidian sudah tertutup, buka sekali lalu keluar seperti biasa. Atau tambahkan foldernya sendiri: di Obsidian pilih Open folder as vault lalu pilih ~/.swarm/vault.",
    "not-registered":
      "Swarm tidak dapat menambahkan vault Swarm ke daftar vault Obsidian dengan aman, jadi tidak ada yang diubah. Tambahkan sendiri: di Obsidian pilih Open folder as vault lalu pilih ~/.swarm/vault.",
  },
}

// The expected toast per outcome: none for `opened`, otherwise the variant and the exact title.
function expected(result: Result, locale: Locale): Toast | undefined {
  const t = translators[locale]
  switch (result) {
    case "opened":
      return undefined
    case "registered":
      return { variant: "success", title: NEW_TEXT[locale].registered }
    case "close-obsidian":
      return { variant: "error", title: NEW_TEXT[locale]["close-obsidian"] }
    case "not-registered":
      return { variant: "error", title: NEW_TEXT[locale]["not-registered"] }
    case "missing":
      return { variant: "error", title: t("memory.obsidian.notYet") }
    case "no-app":
      return { variant: "error", title: t("memory.obsidian.noApp") }
    case "outside":
    case "failed":
      return { variant: "error", title: t("memory.obsidian.failed") }
  }
}

const OUTCOMES: Result[] = [
  "registered",
  "close-obsidian",
  "not-registered",
  "opened",
  "missing",
  "outside",
  "no-app",
  "failed",
]

describe("open graph in Obsidian: one toast per desktop outcome", () => {
  for (const locale of ["en", "id"] as const) {
    for (const result of OUTCOMES) {
      test(`${locale}: ${result}`, async () => {
        state.locale = locale
        state.results = [result]
        await open()
        await press()
        expect(state.ipcCalls).toBe(1)
        const want = expected(result, locale)
        if (!want) {
          expect(state.toasts.length).toBe(0)
          return
        }
        expect(state.toasts.length).toBe(1)
        const got = state.toasts[0]
        expect(typeof got.title === "string" && got.title.length > 0).toBe(true)
        expect(got.variant).toBe(want.variant)
        expect(got.title === want.title).toBe(true)
      })
    }
  }

  test("the id texts differ from the en texts for the three new outcomes", () => {
    for (const result of ["registered", "close-obsidian", "not-registered"] as const)
      expect(NEW_TEXT.en[result] === NEW_TEXT.id[result]).toBe(false)
  })

  for (const locale of ["en", "id"] as const) {
    test(`${locale}: registered then opened gives exactly one toast, the success one`, async () => {
      state.locale = locale
      state.results = ["registered", "opened"]
      await open()
      await press()
      await press()
      expect(state.ipcCalls).toBe(2)
      expect(state.toasts.length).toBe(1)
      expect(state.toasts.filter((toast) => toast.variant === "success").length).toBe(1)
      expect(state.toasts[0].title === NEW_TEXT[locale].registered).toBe(true)
    })
  }
})
