// 1.2.10 row 70 (AC-B1007a, N10-197): Settings > Skills binds a draft approve to the draft the person saw. Every
// approve click sends `draftTime`, the draft's `time` as listed (the server half, row 70a, refuses a request without it
// or with a different time with 409 SKILL_CHANGED and writes nothing). The second (commands) confirm sends the time the
// first click was made with. On SKILL_CHANGED the confirm closes, the existing "changed" text shows and the drafts list
// is fetched again, so the person sees the new draft. The 1.2.9 B08 order is kept: untrusted -> text, no confirm.
// The fake follows the server order of row 70a: missing draft, then changed (409), then untrusted, then unconfirmed.
// Synthetic names and times only. Asserts counts, booleans, strings and plain objects: printing a happy-dom element in
// a failing expect never ends.
import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict as enDict } from "@/i18n/en"
import { dict as idDict } from "@/i18n/id"
import { dict as uiEn } from "@opencode-ai/ui/i18n/en"
import { dict as uiId } from "@opencode-ai/ui/i18n/id"

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

// Everything the dialogs read and this test does not look at.
const handler: ProxyHandler<object> = {
  get: (_, key) => {
    if (key === "then" || key === "nodeType") return undefined
    if (key === Symbol.iterator) return function* () {}
    if (key === Symbol.toPrimitive) return () => ""
    if (key === "length") return 0
    return new Proxy(() => undefined, handler)
  },
  apply: () => anything(),
  has: () => false,
}
const anything = (): any => new Proxy({}, handler)
const partly = (values: object): any =>
  new Proxy(values, { get: (target, key) => (key in target ? target[key as never] : anything()[key]) })

type Translate = (key: string, params?: Record<string, string | number | boolean>) => string
const translators: Record<"en" | "id", Translate> = {
  en: i18n.translator(() => i18n.flatten({ ...enDict, ...uiEn }), i18n.resolveTemplate) as Translate,
  id: i18n.translator(() => i18n.flatten({ ...enDict, ...uiEn, ...idDict, ...uiId }), i18n.resolveTemplate) as Translate,
}

const NONCE = "nonce-syn1210"
// Synthetic draft times (ms). T2 is the time of the draft the agent writes while the confirm is open.
const T1 = 1_763_190_000_000
const T2 = T1 + 5_000
const T3 = T1 + 1_000
const T4 = T1 + 2_000

type Call = { route: string; input: any; headers?: Record<string, string> }
const world = {
  locale: "en" as "en" | "id",
  calls: [] as Call[],
  toasts: [] as string[],
  draftLists: 0,
  untrustedProject: false,
  // When set, the fake replaces the command-running draft (new time T2, new content) as the confirm click arrives.
  swapOnConfirm: false,
  drafts: [] as any[],
}
const fresh = () => {
  world.locale = "en"
  world.calls = []
  world.toasts = []
  world.draftLists = 0
  world.untrustedProject = false
  world.swapOnConfirm = false
  world.drafts = [
    { name: "syn1210-shell", scope: "project", content: "!`pwd`", time: T1, untrusted: false, runsCommands: true, replaces: false },
    { name: "syn1210-plain", scope: "project", content: "plain draft", time: T3, untrusted: false, runsCommands: false, replaces: false },
    { name: "syn1210-shell-u", scope: "project", content: "!`ls`", time: T4, untrusted: true, runsCommands: true, replaces: false },
  ]
}
fresh()
const t = (key: keyof typeof enDict) => translators[world.locale](key)
const err = (name: string, code: string) => ({ error: { name, data: { code, message: code } } })
const seen = (route: string, input: any, options?: { headers?: Record<string, string> }) =>
  world.calls.push({ route, input: structuredClone(input), headers: options?.headers })

const client = {
  app: { skills: async () => ({ data: [] }) },
  skill: {
    drafts: async () => {
      world.draftLists++
      return { data: world.drafts }
    },
    draftApprove: async (input: any, options?: any) => {
      seen("draftApprove", input, options)
      const at = () => world.drafts.findIndex((item) => item.name === input.name && item.scope === input.scope)
      if (at() < 0) return err("SkillDraftMissingError", "SKILL_DRAFT_MISSING")
      if (world.swapOnConfirm && input.acceptCommands === true) {
        world.swapOnConfirm = false
        world.drafts = world.drafts.map((item, index) =>
          index === at() ? { ...item, time: T2, content: "!`whoami`" } : item,
        )
      }
      const draft = world.drafts[at()]
      if (input.draftTime === undefined || input.draftTime !== draft.time)
        return err("SkillChangedError", "SKILL_CHANGED")
      if (draft.runsCommands && draft.scope === "project" && world.untrustedProject)
        return err("SkillShellUntrustedError", "SKILL_SHELL_UNTRUSTED")
      if (draft.runsCommands && input.acceptCommands !== true)
        return err("SkillShellUnconfirmedError", "SKILL_SHELL_UNCONFIRMED")
      world.drafts = world.drafts.filter((item) => item !== draft)
      return { data: { location: "x", hash: "h3", note: "skipped" } }
    },
    draftDiscard: async (input: any, options?: any) => {
      seen("draftDiscard", input, options)
      return { data: { removed: true } }
    },
  },
  global: { config: { get: async () => ({ data: { skills: { disabled: [] } } }) } },
}
;(globalThis as any).api = { desktopNonce: async () => NONCE }

const override = async (id: string, values: Record<string, unknown>) => {
  const real = await import(id)
  mock.module(id, () => ({ ...real, ...values }))
}
const nothing = () => null
await override("@/context/language", {
  useLanguage: () =>
    partly({
      t: (key: string, params?: Record<string, string | number | boolean>) => translators[world.locale](key, params),
      locale: () => world.locale,
      intl: () => world.locale,
      locales: [],
    }),
})
await override("@/utils/toast", {
  showToast: (options: { title?: string } | string) =>
    world.toasts.push(typeof options === "string" ? options : (options.title ?? "")),
})
await override("@/context/server-sdk", {
  useServerSDK: () => () => partly({ client, createClient: () => client }),
})
await override("@/context/server-sync", {
  useServerSync: () => () => partly({ session: partly({ get: () => ({ directory: "/work/syn1210" }) }) }),
})
await override("@/context/layout", { useLayout: () => partly({ route: () => ({ type: "session", sessionId: "s1" }) }) })
await override("@/context/tabs", { useTabs: () => ({ store: [] }) })
await override("@/context/platform", { usePlatform: () => partly({ platform: "web", version: "0" }) })
await override("@opencode-ai/ui/context/dialog", { useDialog: anything })
await override("@opencode-ai/ui/dialog", { Dialog: (props: { children?: unknown }) => props.children })
await override("@opencode-ai/ui/v2/dialog-v2", { Dialog: (props: { children?: unknown }) => props.children })
await override("@/components/settings-general", { SettingsGeneral: nothing })
await override("@/components/settings-providers", { SettingsProviders: nothing })
await override("@/components/settings-models", { SettingsModels: nothing })
await override("@/components/settings-servers", { SettingsServers: nothing })
await override("@/components/settings-keybinds", { SettingsKeybinds: nothing })
await override("@/components/settings-v2/general", { SettingsGeneralV2: nothing })
await override("@/components/settings-v2/providers", { SettingsProvidersV2: nothing })
await override("@/components/settings-v2/models", { SettingsModelsV2: nothing })
await override("@/components/settings-v2/servers", { SettingsServersV2: nothing })

// The real dialogs. Computed paths keep them out of this folder's typecheck (import.meta.env differs).
const v1 = await import(new URL("../src/components/dialog-settings.tsx", import.meta.url).pathname)
const v2 = await import(new URL("../src/components/settings-v2/dialog-settings-v2.tsx", import.meta.url).pathname)

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
let dispose = () => {}
let host!: HTMLDivElement

async function mount(Dialog: any) {
  host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(Dialog, { defaultValue: "skills" }), host)
  await tick(60)
}
const $ = (selector: string) => host.querySelector(selector) as HTMLElement | null
const has = (selector: string) => host.querySelector(selector) !== null
const click = async (selector: string) => {
  const element = $(selector)
  if (!element) throw new Error(`missing ${selector}`)
  element.click()
  await tick(40)
}
const bodies = () => world.calls.filter((call) => call.route === "draftApprove").map((call) => call.input)
const confirmShown = () => has('[data-slot="skill-commands-confirm"]')
const errorText = () => $('[data-slot="skill-error"]')?.textContent ?? ""
const shell = '[data-draft="syn1210-shell"]'

beforeEach(fresh)
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

for (const [label, module] of [
  ["v1", v1],
  ["v2", v2],
] as const) {
  describe(`Settings ${label} > Skills > AC-B1007a approve carries the listed draft time`, () => {
    test("A1 a command-running draft: both clicks send draftTime T1; only the confirm sends acceptCommands", async () => {
      await mount(module.DialogSettings)
      await click(`${shell} [data-action="draft-approve"]`)
      // At BASE the body is { name, scope } (no draftTime).
      expect(bodies()).toEqual([{ name: "syn1210-shell", scope: "project", draftTime: T1 }])
      expect(confirmShown()).toBe(true)
      expect(has('[data-slot="skill-error"]')).toBe(false)
      await click(`${shell} [data-action="draft-approve-commands"]`)
      expect(bodies()).toEqual([
        { name: "syn1210-shell", scope: "project", draftTime: T1 },
        { name: "syn1210-shell", scope: "project", draftTime: T1, acceptCommands: true },
      ])
      expect(world.calls.every((call) => call.headers?.["x-swarm-desktop-nonce"] === NONCE)).toBe(true)
      expect(confirmShown()).toBe(false)
      expect(has('[data-slot="skill-error"]')).toBe(false)
      expect(world.toasts).toEqual([translators.en("settings.skills.savedNoNote")])
    })

    for (const locale of ["en", "id"] as const) {
      test(`A2 (${locale}) the draft is swapped while the confirm is open: 409 closes it, shows the changed text, reloads`, async () => {
        world.locale = locale
        await mount(module.DialogSettings)
        await click(`${shell} [data-action="draft-approve"]`)
        expect(bodies()).toEqual([{ name: "syn1210-shell", scope: "project", draftTime: T1 }])
        expect(confirmShown()).toBe(true)
        const before = world.draftLists
        world.swapOnConfirm = true
        await click(`${shell} [data-action="draft-approve-commands"]`)
        expect(bodies()[1]).toEqual({ name: "syn1210-shell", scope: "project", draftTime: T1, acceptCommands: true })
        // At BASE the confirm stays open and the drafts list is not fetched again.
        expect({ confirmShown: confirmShown(), refetched: world.draftLists - before }).toEqual({
          confirmShown: false,
          refetched: 1,
        })
        expect(errorText()).toBe(t("settings.skills.error.changed"))
        expect(world.toasts.length).toBe(0)
        // The new draft is listed: its content shows, and the next approve is bound to its time T2.
        await click(`${shell} [data-action="draft-view"]`)
        expect($(`${shell} [data-slot="skill-content"]`)?.textContent).toBe("!`whoami`")
        await click(`${shell} [data-action="draft-approve"]`)
        expect(bodies()[2]).toEqual({ name: "syn1210-shell", scope: "project", draftTime: T2 })
        expect(confirmShown()).toBe(true)
        await click(`${shell} [data-action="draft-approve-commands"]`)
        expect(bodies()[3]).toEqual({ name: "syn1210-shell", scope: "project", draftTime: T2, acceptCommands: true })
        expect(world.toasts).toEqual([t("settings.skills.savedNoNote")])
      })
    }

    test("A3 a draft without commands: one click, its body carries draftTime", async () => {
      await mount(module.DialogSettings)
      await click('[data-draft="syn1210-plain"] [data-action="draft-approve"]')
      expect(bodies()).toEqual([{ name: "syn1210-plain", scope: "project", draftTime: T3 }])
      expect(confirmShown()).toBe(false)
      expect(has('[data-slot="skill-error"]')).toBe(false)
      expect(world.toasts).toEqual([translators.en("settings.skills.savedNoNote")])
    })

    test("A4 untrusted project: the first click carries draftTime, 403 untrusted shows its text and no confirm (B08)", async () => {
      world.untrustedProject = true
      await mount(module.DialogSettings)
      await click('[data-draft="syn1210-shell-u"] [data-action="draft-approve"]')
      expect(bodies()).toEqual([{ name: "syn1210-shell-u", scope: "project", draftTime: T4 }])
      expect("acceptCommands" in bodies()[0]).toBe(false)
      expect(confirmShown()).toBe(false)
      expect(errorText()).toBe(translators.en("settings.skills.error.untrusted"))
      expect(world.toasts.length).toBe(0)
    })
  })
}
