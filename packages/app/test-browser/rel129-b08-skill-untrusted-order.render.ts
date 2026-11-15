// 1.2.9 row 48b (AC-B08, N9-125, C8): Settings > Skills refuses an untrusted command-running draft first, without
// asking. Approve sends one draftApprove without acceptCommands; SKILL_SHELL_UNTRUSTED shows the error and no confirm;
// SKILL_SHELL_UNCONFIRMED (trusted project, global scope) opens the confirm, whose button alone sends acceptCommands.
// The fake follows the server order pinned by row 48a (rel128-sk-d-skill-routes.test.ts). Synthetic names (syn129).
// Asserts counts, booleans and strings only: printing a happy-dom element in a failing expect never ends.
import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as uiDict } from "@opencode-ai/ui/i18n/en"

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

const translate = i18n.translator(() => i18n.flatten({ ...dict, ...uiDict }), i18n.resolveTemplate) as (
  key: string,
  params?: Record<string, string | number | boolean>,
) => string
const text = (key: keyof typeof dict, params?: Record<string, string | number>) => translate(key, params)

type Call = { route: string; input: any; headers?: Record<string, string> }
const NONCE = "nonce-syn129"
const world = {
  calls: [] as Call[],
  toasts: [] as string[],
  // The project is not trusted: the server refuses its command-running drafts with SKILL_SHELL_UNTRUSTED, before
  // (and regardless of) SKILL_SHELL_UNCONFIRMED (row 48a pin).
  untrustedProject: false,
  drafts: [] as any[],
}
const fresh = () => {
  world.calls = []
  world.toasts = []
  world.untrustedProject = false
  world.drafts = [
    {
      name: "syn129-plain",
      scope: "project",
      content: "plain draft",
      time: 2001,
      untrusted: false,
      runsCommands: false,
      replaces: false,
    },
    // 1.2.10 AC-B1007a (INTENT, row 70): drafts are listed with their `time`; every approve echoes it as `draftTime`.
    {
      name: "syn129-shell-p",
      scope: "project",
      content: "!`pwd`",
      time: 2002,
      untrusted: true,
      runsCommands: true,
      replaces: false,
    },
    {
      name: "syn129-shell-g",
      scope: "global",
      content: "!`ls`",
      time: 2003,
      untrusted: false,
      runsCommands: true,
      replaces: false,
    },
  ]
}
fresh()
const err = (code: string) => ({ error: { name: "SkillError", data: { code, message: code } } })
const seen = (route: string, input: any, options?: { headers?: Record<string, string> }) =>
  world.calls.push({ route, input, headers: options?.headers })

const client = {
  app: { skills: async () => ({ data: [] }) },
  skill: {
    drafts: async () => ({ data: world.drafts }),
    draftApprove: async (input: any, options?: any) => {
      seen("draftApprove", input, options)
      const draft = world.drafts.find((item) => item.name === input.name)
      if (draft?.runsCommands && input.scope === "project" && world.untrustedProject) return err("SKILL_SHELL_UNTRUSTED")
      if (draft?.runsCommands && input.acceptCommands !== true) return err("SKILL_SHELL_UNCONFIRMED")
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
  useLanguage: () => partly({ t: translate, locale: () => "en", intl: () => "en", locales: [] }),
})
await override("@/utils/toast", {
  showToast: (options: { title?: string } | string) =>
    world.toasts.push(typeof options === "string" ? options : (options.title ?? "")),
})
await override("@/context/server-sdk", {
  useServerSDK: () => () => partly({ client, createClient: () => client }),
})
await override("@/context/server-sync", {
  useServerSync: () => () => partly({ session: partly({ get: () => ({ directory: "/work/syn129" }) }) }),
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
const approves = () => world.calls.filter((call) => call.route === "draftApprove")
const confirmShown = () => has('[data-slot="skill-commands-confirm"]')
const errorText = () => $('[data-slot="skill-error"]')?.textContent ?? ""

beforeEach(fresh)
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

for (const [label, module] of [
  ["v1", v1],
  ["v2", v2],
] as const) {
  describe(`Settings ${label} > Skills > AC-B08 refuse first`, () => {
    test("(a) untrusted project: one approve without acceptCommands, the untrusted text, no confirm", async () => {
      world.untrustedProject = true
      await mount(module.DialogSettings)
      await click('[data-draft="syn129-shell-p"] [data-action="draft-approve"]')
      // At BASE: the confirm is shown and draftApprove is called 0 times.
      expect({ confirmShown: confirmShown(), approveCalls: approves().length }).toEqual({
        confirmShown: false,
        approveCalls: 1,
      })
      expect(approves()[0].input).toEqual({ name: "syn129-shell-p", scope: "project", draftTime: 2002 })
      expect("acceptCommands" in approves()[0].input).toBe(false)
      expect(approves()[0].headers).toEqual({ "x-swarm-desktop-nonce": NONCE })
      expect(errorText()).toBe(text("settings.skills.error.untrusted"))
      expect(has('[data-action="draft-approve-commands"]')).toBe(false)
      expect(world.toasts.length).toBe(0)
    })

    test("(b) trusted project: one approve without acceptCommands, then the confirm with no error", async () => {
      await mount(module.DialogSettings)
      await click('[data-draft="syn129-shell-p"] [data-action="draft-approve"]')
      expect(approves().length).toBe(1)
      expect(approves()[0].input).toEqual({ name: "syn129-shell-p", scope: "project", draftTime: 2002 })
      expect(confirmShown()).toBe(true)
      expect(has('[data-draft="syn129-shell-p"] [data-slot="skill-commands-confirm"]')).toBe(true)
      expect(has('[data-slot="skill-error"]')).toBe(false)
      await click('[data-draft="syn129-shell-p"] [data-action="draft-approve-commands"]')
      expect(approves().length).toBe(2)
      expect(approves()[1].input).toEqual({
        name: "syn129-shell-p",
        scope: "project",
        draftTime: 2002,
        acceptCommands: true,
      })
      expect(approves()[1].headers).toEqual({ "x-swarm-desktop-nonce": NONCE })
      expect(has('[data-slot="skill-error"]')).toBe(false)
      expect(confirmShown()).toBe(false)
      expect(world.toasts).toEqual([text("settings.skills.savedNoNote")])
    })

    test("(c) global scope: one approve without acceptCommands, then the confirm with no error", async () => {
      world.untrustedProject = true
      await mount(module.DialogSettings)
      await click('[data-draft="syn129-shell-g"] [data-action="draft-approve"]')
      expect(approves().length).toBe(1)
      expect(approves()[0].input).toEqual({ name: "syn129-shell-g", scope: "global", draftTime: 2003 })
      expect(has('[data-draft="syn129-shell-g"] [data-slot="skill-commands-confirm"]')).toBe(true)
      expect(has('[data-slot="skill-error"]')).toBe(false)
      await click('[data-draft="syn129-shell-g"] [data-action="draft-approve-commands"]')
      expect(approves().length).toBe(2)
      expect(approves()[1].input).toEqual({
        name: "syn129-shell-g",
        scope: "global",
        draftTime: 2003,
        acceptCommands: true,
      })
      expect(has('[data-slot="skill-error"]')).toBe(false)
    })

    test("(d) a plain draft: one approve, no confirm (unchanged)", async () => {
      world.untrustedProject = true
      await mount(module.DialogSettings)
      await click('[data-draft="syn129-plain"] [data-action="draft-approve"]')
      expect(approves().length).toBe(1)
      expect(approves()[0].input).toEqual({ name: "syn129-plain", scope: "project", draftTime: 2001 })
      expect(confirmShown()).toBe(false)
      expect(has('[data-slot="skill-error"]')).toBe(false)
      expect(world.toasts).toEqual([text("settings.skills.savedNoNote")])
    })
  })
}
