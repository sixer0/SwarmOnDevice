import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as uiDict } from "@opencode-ai/ui/i18n/en"

// 1.2.8 row 42c (AC-OBSf, OBS-f-2, N8-362; 01c §7.1): exactly one [data-action="open-obsidian"] in the memory view's
// footer when the platform has openObsidianNote, none without it; exists:false -> N8-119 and no IPC; IPC no-app ->
// N8-120; no new dialog or panel. Synthetic data only. Counts and booleans only (C77: happy-dom element printing hangs).

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

const translate = i18n.translator(() => i18n.flatten({ ...dict, ...uiDict }), i18n.resolveTemplate) as (
  key: string,
  params?: Record<string, string | number | boolean>,
) => string
const realLanguage = await import("@/context/language")
mock.module("@/context/language", () => ({ ...realLanguage, useLanguage: () => ({ t: translate, locale: () => "en" }) }))

type Result = "opened" | "missing" | "outside" | "no-app" | "failed"
const state: {
  exists: boolean
  ipc?: Result
  ipcCalls: string[]
  vaultCalls: unknown[]
  toasts: string[]
} = { exists: true, ipcCalls: [], vaultCalls: [], toasts: [] }
const HUB = "/synthetic/vault/swarm-memory/default-project-3fa9c1/index.md"

const client = {
  memory: {
    get: async () => ({ data: { enabled: true, items: [] } }),
    add: async () => ({ data: {} }),
    remove: async () => ({ data: true }),
    update: async () => ({ data: {} }),
    settings: async () => ({ data: true }),
    vault: async (input: unknown) => {
      state.vaultCalls.push(input)
      return { data: { folder: "default-project-3fa9c1", hubPath: HUB, exists: state.exists } }
    },
  },
}
const sdk = { client, event: { on: () => () => {} } }
const realSdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...realSdk, useSDK: () => () => sdk }))

const platform: Record<string, unknown> = {}
const realPlatform = await import("@/context/platform")
mock.module("@/context/platform", () => ({ ...realPlatform, usePlatform: () => platform }))

const realToast = await import("@/utils/toast")
mock.module("@/utils/toast", () => ({
  ...realToast,
  showToast: (options: { title?: string } | string) => {
    state.toasts.push(typeof options === "string" ? options : (options.title ?? ""))
  },
}))

const { DialogProvider, useDialog } = await import("@opencode-ai/ui/context/dialog")
const { DialogProjectMemory } = await import(new URL("../src/components/project-memory.tsx", import.meta.url).pathname)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
  state.exists = true
  state.ipc = undefined
  state.ipcCalls = []
  state.vaultCalls = []
  state.toasts = []
  delete platform.openObsidianNote
})

function withIpc(result: Result) {
  state.ipc = result
  platform.openObsidianNote = async (hubPath: string) => {
    state.ipcCalls.push(hubPath)
    return state.ipc
  }
}

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
  await tick(20)
}

const buttons = () => document.querySelectorAll('[data-action="open-obsidian"]')
const dialogs = () => document.querySelectorAll('[role="dialog"]').length

describe("the Obsidian action", () => {
  test("exactly one button with the U1 label and the SR8-20 tooltip when the platform has openObsidianNote", async () => {
    withIpc("opened")
    await open()
    expect(buttons().length).toBe(1)
    const button = buttons()[0] as HTMLElement
    expect(button.textContent?.trim() === "Open graph in Obsidian").toBe(true)
    const hint = button.getAttribute("title") ?? ""
    expect(hint.includes("its plugins and any sync")).toBe(true)
  })

  test("none without openObsidianNote (web)", async () => {
    await open()
    expect(buttons().length).toBe(0)
  })

  test("hub present: the desktop gets the route's hubPath; opened -> no toast; no new dialog", async () => {
    withIpc("opened")
    await open()
    const before = dialogs()
    ;(buttons()[0] as HTMLElement).click()
    await tick(20)
    expect(state.vaultCalls.length).toBe(1)
    expect(JSON.stringify(state.vaultCalls[0])).toBe(JSON.stringify({ language: "en" }))
    expect(state.ipcCalls.length).toBe(1)
    expect(state.ipcCalls[0] === HUB).toBe(true)
    expect(state.toasts.length).toBe(0)
    expect(dialogs()).toBe(before)
  })

  test("exists:false -> N8-119 toast and the IPC is not called", async () => {
    withIpc("opened")
    state.exists = false
    await open()
    ;(buttons()[0] as HTMLElement).click()
    await tick(20)
    expect(state.ipcCalls.length).toBe(0)
    expect(state.toasts.length).toBe(1)
    expect(state.toasts[0] === translate("memory.obsidian.notYet")).toBe(true)
  })

  test("IPC no-app -> N8-120; missing -> N8-119; outside and failed -> N8-121", async () => {
    const seen: boolean[] = []
    for (const [result, key] of [
      ["no-app", "memory.obsidian.noApp"],
      ["missing", "memory.obsidian.notYet"],
      ["outside", "memory.obsidian.failed"],
      ["failed", "memory.obsidian.failed"],
    ] as const) {
      withIpc(result)
      state.toasts = []
      await open()
      ;(buttons()[0] as HTMLElement).click()
      await tick(20)
      seen.push(state.toasts.length === 1 && state.toasts[0] === translate(key))
      dispose()
      document.body.innerHTML = ""
    }
    expect(seen).toEqual([true, true, true, true])
  })
})
