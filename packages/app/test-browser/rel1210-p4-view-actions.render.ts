import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as idDict } from "@/i18n/id"
import { dict as uiDict } from "@opencode-ai/ui/i18n/en"
import { dict as uiIdDict } from "@opencode-ai/ui/i18n/id"

// 1.2.10 row 59 (AC-P4-view, N10-180; 01d §3.7 cases V-1..V-12, S10-12(P4), S10-14(P4), S10-08(P4)).
// A device-only note gets "Copy to vault" in its label line, after the reason label; pressing it opens a confirmation in
// the same row that names agents as readers; "Copy" sends exactly one person-only call with the desktop nonce. An
// exported note gets "In vault: remove" with no confirmation. Secret, classified, any-model and archived notes get no
// action. Without a nonce (web build, `swarm serve`) there is no action and the scope is plain text. The expected texts
// are written out here (N10-085..N10-089, N10-094, N10-095, N10-102), not read from the dictionaries.

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

// Synthetic nonce (32 hex characters); the real one lives only in the desktop main process.
const NONCE = "0123456789abcdef0123456789abcdef"
const HEADER = "x-swarm-desktop-nonce"

type Item = Record<string, unknown>
type Kept = { id: string; reason: string }
type Answer = "ok" | "403" | "classified"
const state: {
  locale: "en" | "id"
  nonce: string | null
  items: Item[]
  kept: Kept[]
  answer: Answer
  allowCalls: unknown[][]
  updateCalls: unknown[][]
} = { locale: "en", nonce: NONCE, items: [], kept: [], answer: "ok", allowCalls: [], updateCalls: [] }

// The preload bridge the desktop app installs (`window.api.desktopNonce`); null is the web build or `swarm serve`.
;(globalThis as { api?: unknown }).api = { desktopNonce: async () => state.nonce }

const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string | number | boolean>) => translators[state.locale](key, params),
    locale: () => state.locale,
  }),
}))

const personOnly = () => ({
  error: { name: "MemoryPersonOnlyError", data: { code: "MEMORY_PERSON_ONLY", message: "person only" } },
  response: { status: 403 },
})

const client = {
  memory: {
    get: async () => ({ data: { enabled: true, items: state.items.map((item) => ({ ...item })) } }),
    add: async () => ({ data: {} }),
    remove: async () => ({ data: true }),
    update: async (...args: unknown[]) => {
      state.updateCalls.push(args)
      if (state.answer === "403") return personOnly()
      return { data: {} }
    },
    settings: async () => ({ data: true }),
    vault: async () => ({
      data: { folder: "p", hubPath: "/vault/swarm-memory/p/index.md", exists: true, kept: state.kept },
    }),
    allowVault: async (...args: unknown[]) => {
      state.allowCalls.push(args)
      if (state.answer === "403") return personOnly()
      if (state.answer === "classified") return { data: { refused: "classified" } }
      const input = args[0] as { id: string; allowed: boolean }
      state.items = state.items.map((item) => {
        if (item.id !== input.id) return item
        const { vaultAllowed: _, ...rest } = item
        return input.allowed ? { ...rest, vaultAllowed: true } : rest
      })
      state.kept = state.kept.filter((entry) => entry.id !== input.id)
      if (!input.allowed) state.kept = [...state.kept, { id: input.id, reason: "device" }]
      return { data: { item: state.items.find((item) => item.id === input.id) } }
    },
  },
}
const sdk = { client, event: { on: () => () => {} } }
const realSdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...realSdk, useSDK: () => () => sdk }))

const { DialogProvider, useDialog } = await import("@opencode-ai/ui/context/dialog")
const source = new URL("../src/components/project-memory.tsx", import.meta.url).pathname
const { DialogProjectMemory } = await import(source)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
  state.locale = "en"
  state.nonce = NONCE
  state.items = []
  state.kept = []
  state.answer = "ok"
  state.allowCalls = []
  state.updateCalls = []
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
  await tick(40)
}

const TEXT = {
  en: {
    copy: "Copy to vault",
    remove: "In vault: remove",
    confirm:
      "Copy this note to the Obsidian vault? Obsidian, its plugins, any sync you turn on, and agents allowed to read outside the project (for example in autonomous mode) can read the copy. Swarm still gives the note only to on-device models. You can remove it from the vault later.",
    confirmIndex: "Its final report report.md is copied with it, under the existing report rules.",
    reportClause: "Its final report",
    yes: "Copy",
    cancel: "Cancel",
    personOnly: "Only in the Swarm desktop app.",
    classified: "This note is marked as classified, so it is never copied to the vault.",
    device: "Kept on this device",
    secret: "Looks secret: never copied",
    classifiedLabel: "Marked as classified: never copied",
  },
  id: {
    copy: "Salin ke vault",
    remove: "Di vault: hapus",
    confirm:
      "Salin catatan ini ke vault Obsidian? Obsidian, pluginnya, sinkronisasi apa pun yang Anda aktifkan, dan agen yang boleh membaca di luar proyek (misalnya dalam mode otonom) dapat membaca salinannya. Swarm tetap hanya memberikan catatan ini ke model di perangkat ini. Anda dapat menghapusnya dari vault nanti.",
    confirmIndex: "Laporan akhirnya report.md ikut disalin, dengan aturan laporan yang sudah ada.",
    reportClause: "Laporan akhirnya",
    yes: "Salin",
    cancel: "Batal",
    personOnly: "Hanya di aplikasi desktop Swarm.",
    classified: "Catatan ini ditandai sebagai dokumen berklasifikasi, jadi tidak pernah disalin ke vault.",
    device: "Hanya di perangkat ini",
    secret: "Tampak berisi rahasia: tidak pernah disalin",
    classifiedLabel: "Ditandai berklasifikasi: tidak pernah disalin",
  },
} as const

// Synthetic store (no user data).
const note = (id: string, extra: Item = {}): Item => ({
  id,
  text: `hook ${id}`,
  source: "agent",
  deviceOnly: false,
  time: 1,
  ...extra,
})
const member = (id: string): Item => ({
  id,
  text: `2026-04-0${id.slice(-1)} ${id} | done | triggers: memory | docs/${id}/10_report/report.md`,
  source: "agent",
  deviceOnly: true,
  time: 3,
  kind: "index",
  missionId: id,
  rolledInto: "r1",
})
const store = () => [
  note("n-device", { deviceOnly: true }),
  note("n-exported", { deviceOnly: true, vaultAllowed: true }),
  note("n-turned", { deviceOnly: true, vaultAllowed: true }),
  note("n-secret", { deviceOnly: true }),
  note("n-classified"),
  note("n-any"),
  {
    id: "2026-05-02_m",
    text: "2026-05-02 2026-05-02_m | done | triggers: memory | docs/2026-05-02_m/10_report/report.md",
    source: "agent",
    deviceOnly: true,
    time: 2,
    kind: "index",
    missionId: "2026-05-02_m",
  },
  {
    id: "r1",
    text: "2026-Q2 roll-up | 2 missions | triggers: memory | body",
    body: "[2026-04-01_a1] one\n[2026-04-02_a2] two",
    source: "agent",
    deviceOnly: true,
    time: 4,
    kind: "index_rollup",
  },
  member("2026-04-01_a1"),
  member("2026-04-02_a2"),
]
const kept = (): Kept[] => [
  { id: "n-device", reason: "device" },
  { id: "n-turned", reason: "classified" },
  { id: "n-secret", reason: "secret" },
  { id: "n-classified", reason: "classified" },
  { id: "2026-05-02_m", reason: "device" },
  { id: "r1", reason: "device" },
]

const occurrences = (hay: string, needle: string) => hay.split(needle).length - 1
const row = (id: string) => document.querySelector(`[data-memory-item="${id}"]`)
const action = (id: string) => row(id)?.querySelector<HTMLElement>("[data-memory-vault]") ?? null
const actionValue = (id: string) => action(id)?.getAttribute("data-memory-vault") ?? null
const buttons = (id: string, text: string) =>
  [...(row(id)?.querySelectorAll<HTMLElement>("button") ?? [])].filter((button) => button.textContent?.trim() === text)
const rowText = (id: string) => row(id)?.textContent ?? ""
const problem = () => document.querySelector("[data-memory-problem]")?.textContent ?? ""
const headerOf = (args: unknown[]) => {
  const input = args[0] as Record<string, unknown> | undefined
  const options = args[1] as { headers?: Record<string, string> } | undefined
  return (input?.[HEADER] as string | undefined) ?? options?.headers?.[HEADER]
}

async function seed() {
  state.items = store()
  state.kept = kept()
  await open()
}

for (const locale of ["en", "id"] as const) {
  describe(`copy and confirmation (${locale})`, () => {
    test("V-1: a device-only clean note has copy beside the scope button, after its reason, in the label line", async () => {
      state.locale = locale
      await seed()
      expect(actionValue("n-device")).toBe("copy")
      const scope = row("n-device")!.querySelector("[data-memory-scope]")
      expect(scope?.tagName).toBe("BUTTON")
      const line = scope?.parentElement
      expect(action("n-device")!.parentElement === line).toBe(true)
      expect(action("n-device")!.textContent?.trim()).toBe(TEXT[locale].copy)
      // Order in the line: scope, reason label, then the action.
      const lineText = line?.textContent ?? ""
      expect(lineText.indexOf(TEXT[locale].device) > -1).toBe(true)
      expect(lineText.indexOf(TEXT[locale].device) < lineText.indexOf(TEXT[locale].copy)).toBe(true)
    })

    test("V-2: copy then Cancel shows the confirmation in the row and makes no route call", async () => {
      state.locale = locale
      await seed()
      action("n-device")!.click()
      await tick(20)
      expect(occurrences(rowText("n-device"), TEXT[locale].confirm)).toBe(1)
      // The confirmation names agents as readers (S10-14(P4)) and is not inside any other row.
      expect(occurrences(document.body.textContent ?? "", TEXT[locale].confirm)).toBe(1)
      expect(buttons("n-device", TEXT[locale].yes).length).toBe(1)
      expect(buttons("n-device", TEXT[locale].cancel).length).toBe(1)
      // Focus moves to Cancel.
      expect(document.activeElement === buttons("n-device", TEXT[locale].cancel)[0]).toBe(true)
      buttons("n-device", TEXT[locale].cancel)[0].click()
      await tick(20)
      expect(state.allowCalls.length).toBe(0)
      expect(state.updateCalls.length).toBe(0)
      expect(occurrences(rowText("n-device"), TEXT[locale].confirm)).toBe(0)
      expect(actionValue("n-device")).toBe("copy")
    })
  })
}

describe("copy, remove and the nonce", () => {
  test("V-2: Escape in the confirmation cancels it with no route call", async () => {
    await seed()
    action("n-device")!.click()
    await tick(20)
    const cancel = buttons("n-device", TEXT.en.cancel)[0]
    cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    // Escape belongs to the dialog (window capture): the view closes, and the confirmation with it.
    await tick(150)
    expect(occurrences(document.body.textContent ?? "", TEXT.en.confirm)).toBe(0)
    expect(state.allowCalls.length).toBe(0)
    expect(state.updateCalls.length).toBe(0)
  })

  test("V-3: copy then Copy sends exactly one allowVault call with the nonce; the row then shows remove", async () => {
    await seed()
    action("n-device")!.click()
    await tick(20)
    buttons("n-device", TEXT.en.yes)[0].click()
    await tick(40)
    expect(state.allowCalls.length).toBe(1)
    const input = state.allowCalls[0][0] as Record<string, unknown>
    expect(input.id).toBe("n-device")
    expect(input.allowed).toBe(true)
    expect(headerOf(state.allowCalls[0])).toBe(NONCE)
    expect(state.updateCalls.length).toBe(0)
    expect(actionValue("n-device")).toBe("remove")
    expect(occurrences(rowText("n-device"), TEXT.en.confirm)).toBe(0)
  })

  test("V-4: remove on an exported note sends one call { allowed: false } with the nonce and no confirmation", async () => {
    await seed()
    expect(actionValue("n-exported")).toBe("remove")
    expect(action("n-exported")!.textContent?.trim()).toBe(TEXT.en.remove)
    action("n-exported")!.click()
    await tick(40)
    expect(occurrences(document.body.textContent ?? "", TEXT.en.confirm)).toBe(0)
    expect(state.allowCalls.length).toBe(1)
    const input = state.allowCalls[0][0] as Record<string, unknown>
    expect(input.id).toBe("n-exported")
    expect(input.allowed).toBe(false)
    expect(headerOf(state.allowCalls[0])).toBe(NONCE)
    expect(actionValue("n-exported")).toBe("copy")
  })

  test("V-5: secret and classified notes that are not exported show their reason and no action", async () => {
    await seed()
    expect(occurrences(rowText("n-secret"), TEXT.en.secret)).toBe(1)
    expect(occurrences(rowText("n-classified"), TEXT.en.classifiedLabel)).toBe(1)
    expect(action("n-secret") === null).toBe(true)
    expect(action("n-classified") === null).toBe(true)
  })

  test("V-6: an exported note that turned classified shows its reason and remove", async () => {
    await seed()
    expect(occurrences(rowText("n-turned"), TEXT.en.classifiedLabel)).toBe(1)
    expect(actionValue("n-turned")).toBe("remove")
  })

  test("V-7: an any-model note and archived roll-up members have no action", async () => {
    await seed()
    expect(action("n-any") === null).toBe(true)
    const members = [...document.querySelectorAll("[data-memory-archived]")]
    expect(members.length).toBe(2)
    expect(members.filter((item) => item.querySelector("[data-memory-vault]")).length).toBe(0)
    // One action per live row at most; the roll-up's own action is its own, not a member's.
    expect(row("r1")!.querySelectorAll("[data-memory-vault]").length).toBe(1)
  })

  test("V-8: a mission index entry's confirmation names the report by its last segment only", async () => {
    await seed()
    action("2026-05-02_m")!.click()
    await tick(20)
    const text = rowText("2026-05-02_m")
    expect(occurrences(text, TEXT.en.confirm)).toBe(1)
    expect(occurrences(text, TEXT.en.confirmIndex)).toBe(1)
    // The shown sentence has no path separator: the report is named by its last segment.
    expect(TEXT.en.confirmIndex.includes("/")).toBe(false)
    expect(occurrences(text, "10_report/report.md")).toBe(1) // only in the entry's own line, not the confirmation
  })

  test("V-8 roll-up variant: a device-only roll-up's confirmation has no report clause (S10-08)", async () => {
    await seed()
    expect(actionValue("r1")).toBe("copy")
    action("r1")!.click()
    await tick(20)
    const text = rowText("r1")
    expect(occurrences(text, TEXT.en.confirm)).toBe(1)
    expect(occurrences(text, TEXT.en.reportClause)).toBe(0)
  })

  test("V-8 id: the index variant in Indonesian names the report by its last segment", async () => {
    state.locale = "id"
    await seed()
    action("2026-05-02_m")!.click()
    await tick(20)
    expect(occurrences(rowText("2026-05-02_m"), TEXT.id.confirmIndex)).toBe(1)
  })

  test("V-9: without a desktop nonce there is no action, the scope is text, and reason labels stay", async () => {
    state.nonce = null
    await seed()
    expect(document.querySelectorAll("[data-memory-vault]").length).toBe(0)
    const scopes = [...document.querySelectorAll("[data-memory-scope]")]
    expect(scopes.length > 0).toBe(true)
    expect(scopes.filter((scope) => scope.tagName === "BUTTON").length).toBe(0)
    expect(occurrences(rowText("n-device"), TEXT.en.device)).toBe(1)
    expect(occurrences(rowText("n-secret"), TEXT.en.secret)).toBe(1)
    // Clicking the plain scope text changes nothing.
    ;(scopes[0] as HTMLElement).click()
    await tick(20)
    expect(state.updateCalls.length).toBe(0)
  })

  test("V-10: a 403 from the route shows the person-only text in the problem line", async () => {
    await seed()
    state.answer = "403"
    action("n-device")!.click()
    await tick(20)
    buttons("n-device", TEXT.en.yes)[0].click()
    await tick(40)
    expect(state.allowCalls.length).toBe(1)
    expect(problem()).toBe(TEXT.en.personOnly)
  })

  test("V-10: a 403 on the scope toggle shows the person-only text too", async () => {
    await seed()
    state.answer = "403"
    row("n-any")!.querySelector<HTMLElement>("[data-memory-scope]")!.click()
    await tick(40)
    expect(state.updateCalls.length).toBe(1)
    expect(problem()).toBe(TEXT.en.personOnly)
  })

  test("V-10 id: the person-only text in Indonesian", async () => {
    state.locale = "id"
    await seed()
    state.answer = "403"
    action("n-exported")!.click()
    await tick(40)
    expect(problem()).toBe(TEXT.id.personOnly)
  })

  test("V-11: a refused classified answer (race) shows the classified refusal text", async () => {
    await seed()
    state.answer = "classified"
    action("n-device")!.click()
    await tick(20)
    buttons("n-device", TEXT.en.yes)[0].click()
    await tick(40)
    expect(problem()).toBe(TEXT.en.classified)
    expect(actionValue("n-device")).toBe("copy")
  })

  test("V-12: the scope toggle and the text edit each carry the nonce header", async () => {
    await seed()
    row("n-any")!.querySelector<HTMLElement>("[data-memory-scope]")!.click()
    await tick(40)
    expect(state.updateCalls.length).toBe(1)
    expect((state.updateCalls[0][0] as Record<string, unknown>).deviceOnly).toBe(true)
    expect(headerOf(state.updateCalls[0])).toBe(NONCE)

    const edited = row("n-device")!
    edited.querySelector<HTMLElement>("[data-memory-edit-button]")!.click()
    await tick(20)
    const input = edited.querySelector<HTMLInputElement>("[data-memory-edit] input, input[data-memory-edit]")!
    input.value = "hook n-device changed"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await tick(40)
    expect(state.updateCalls.length).toBe(2)
    expect((state.updateCalls[1][0] as Record<string, unknown>).text).toBe("hook n-device changed")
    expect(headerOf(state.updateCalls[1])).toBe(NONCE)
    expect(state.allowCalls.length).toBe(0)
  })
})

describe("S10-12(P4) source pins", () => {
  test("nonceHeader( appears exactly four times, all inside MemoryRow's handlers", async () => {
    const text = await Bun.file(source).text()
    const row = text.indexOf("function MemoryRow(")
    expect(row > 0).toBe(true)
    const sites = [...text.matchAll(/nonceHeader\(/g)].map((match) => match.index ?? -1)
    expect(sites.length).toBe(4)
    expect(sites.every((index) => index > row)).toBe(true)
    // Helpers are imported, never copied (N10-072).
    expect(occurrences(text, "export function nonceHeader")).toBe(0)
    expect(occurrences(text, "const DESKTOP_NONCE_HEADER")).toBe(0)
  })

  test("note text and the report name are rendered as text only, never as HTML", async () => {
    const text = await Bun.file(source).text()
    expect(occurrences(text, "innerHTML")).toBe(0)
    expect(occurrences(text, "outerHTML")).toBe(0)
    expect(occurrences(text, "insertAdjacentHTML")).toBe(0)
  })

  test("the confirmation is plain text: its sentence has no element inside it", async () => {
    await seed()
    action("2026-05-02_m")!.click()
    await tick(20)
    const sentence = [...row("2026-05-02_m")!.querySelectorAll("p")].filter((p) =>
      (p.textContent ?? "").includes(TEXT.en.confirm),
    )
    expect(sentence.length).toBe(1)
    expect(sentence[0].children.length).toBe(0)
  })
})
