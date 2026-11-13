// 1.2.8 row 42 (AC-SKh, N8-355): the Skills tab inside the existing Settings dialog, v1 and v2.
// Synthetic skills and drafts only; the server is a recording fake so every write, its body and its nonce are seen.
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

// The same translator the app builds (context/language.tsx): flattened app + ui dictionaries, templates resolved.
const translate = i18n.translator(() => i18n.flatten({ ...dict, ...uiDict }), i18n.resolveTemplate) as (
  key: string,
  params?: Record<string, string | number | boolean>,
) => string
const text = (key: keyof typeof dict, params?: Record<string, string | number>) => translate(key, params)

type Call = { route: string; input: any; headers?: Record<string, string> }
const NONCE = "nonce-row42"
const HOSTILE = '<img src=x onerror="globalThis.__pwned=1">'
const world = {
  calls: [] as Call[],
  toasts: [] as string[],
  disabled: ["claude-x", "ghost"] as string[],
  changed: false,
  forceUnconfirmed: false,
  skills: [] as any[],
  drafts: [] as any[],
}
const fresh = () => {
  world.calls = []
  world.toasts = []
  world.disabled = ["claude-x", "ghost"]
  world.changed = false
  world.forceUnconfirmed = false
  world.skills = [
    { name: "swarm-workflow", description: "Built-in workflow", content: HOSTILE, scope: "builtin" },
    { name: "obsidian-memory", description: "Vault notes", content: "body", scope: "builtin", required: true },
    {
      name: "notes",
      description: "Global notes skill",
      content: "x",
      scope: "global",
      hash: "h-notes",
      triggers: { keywords: ["memo"], files: ["*.md"], missionTypes: [] },
    },
    { name: "proj-skill", description: "Project skill", content: "y", scope: "project", hash: "h-proj" },
    { name: "claude-x", description: "From another tool", content: "z", scope: "other", disabled: true },
  ]
  world.drafts = [
    {
      name: "d-plain",
      scope: "project",
      content: "plain draft",
      untrusted: false,
      runsCommands: false,
      replaces: false,
    },
    { name: "d-shell", scope: "global", content: "!`ls`", untrusted: true, runsCommands: true, replaces: true },
    { name: "d-shell-p", scope: "project", content: "!`pwd`", untrusted: false, runsCommands: true, replaces: false },
  ]
}
fresh()
const err = (code: string) => ({ error: { name: "SkillError", data: { code, message: code } } })
const seen = (route: string, input: any, options?: { headers?: Record<string, string> }) =>
  world.calls.push({ route, input, headers: options?.headers })

const client = {
  app: { skills: async () => ({ data: world.skills.map((item) => ({ ...item, disabled: item.disabled })) }) },
  skill: {
    drafts: async () => ({ data: world.drafts }),
    source: async (input: any) => {
      seen("source", input)
      return { data: { location: "x", scope: input.scope, content: `---\nname: ${input.name}\n---\nsrc`, hash: "h1" } }
    },
    save: async (input: any, options?: any) => {
      seen("save", input, options)
      return world.changed ? err("SKILL_CHANGED") : { data: { location: "x", hash: "h2", note: "added" } }
    },
    delete: async (input: any, options?: any) => {
      seen("delete", input, options)
      return { data: { archive: ".swarm/archive/1" } }
    },
    draftApprove: async (input: any, options?: any) => {
      seen("draftApprove", input, options)
      const draft = world.drafts.find((item) => item.name === input.name)
      if (world.forceUnconfirmed || (draft?.runsCommands && input.acceptCommands !== true))
        return err("SKILL_SHELL_UNCONFIRMED")
      return { data: { location: "x", hash: "h3", note: "skipped" } }
    },
    draftDiscard: async (input: any, options?: any) => {
      seen("draftDiscard", input, options)
      return { data: { removed: true } }
    },
  },
  global: {
    config: {
      get: async () => ({ data: { skills: { disabled: [...world.disabled] } } }),
      update: async (input: any, options?: any) => {
        seen("config.update", input, options)
        world.disabled = input.config.skills.disabled
        for (const item of world.skills) item.disabled = world.disabled.includes(item.name)
        return { data: input.config }
      },
    },
  },
}
// The preload's per-launch nonce (desktop app only).
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
  useServerSync: () => () => partly({ session: partly({ get: () => ({ directory: "/work/proj" }) }) }),
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
const $$ = (selector: string) => [...host.querySelectorAll(selector)] as HTMLElement[]
const click = async (selector: string) => {
  const element = $(selector)
  if (!element) throw new Error(`missing ${selector}`)
  element.click()
  await tick(40)
}
const typeInto = async (value: string) => {
  const area = $('[data-slot="skill-textarea"]') as HTMLTextAreaElement
  area.value = value
  area.dispatchEvent(new Event("input", { bubbles: true }))
  await tick()
}
const routes = () => world.calls.map((call) => call.route)
const writes = () => world.calls.filter((call) => call.route !== "source")

beforeEach(fresh)
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

for (const [label, module] of [
  ["v1", v1],
  ["v2", v2],
] as const) {
  describe(`Settings ${label} > Skills`, () => {
    test("the tab sits in the existing dialog and lists the four scopes in order", async () => {
      await mount(module.DialogSettings)
      expect(host.textContent).toContain(text("settings.skills.title"))
      expect(has('[data-component="settings-skills"]')).toBe(true)
      expect($$("[data-group]").map((group) => group.dataset.group)).toEqual(["builtin", "global", "project", "other"])
      for (const key of [
        "settings.skills.scope.builtin",
        "settings.skills.scope.global",
        "settings.skills.scope.project",
        "settings.skills.scope.other",
      ] as const)
        expect(host.textContent).toContain(text(key))
      expect(host.textContent).toContain(text("settings.skills.description"))
      expect($('[data-skill="claude-x"] [data-badge="off"]')?.textContent).toBe(text("settings.skills.off"))
      expect($('[data-skill="notes"]')?.textContent).toContain(text("settings.skills.triggers"))
      expect($('[data-skill="proj-skill"]')?.textContent).toContain(text("settings.skills.triggers.none"))
      // Nothing of the tab is placed outside the dialog's host. Counts only: printing a happy-dom element never ends.
      expect(document.querySelectorAll('[data-component="settings-skills"]').length).toBe(1)
      expect(document.querySelectorAll("[data-skill], [data-draft]").length).toBe(
        $$("[data-skill], [data-draft]").length,
      )
    })

    test("obsidian-memory is Required and its switch cannot be operated", async () => {
      await mount(module.DialogSettings)
      const row = '[data-skill="obsidian-memory"]'
      expect($(`${row} [data-badge="required"]`)?.textContent).toBe(text("settings.skills.required"))
      expect($(row)?.textContent).toContain(text("settings.skills.requiredHint"))
      const input = $(`${row} input`) as HTMLInputElement
      expect(input.disabled).toBe(true)
      expect(input.checked).toBe(true)
      input.click()
      await tick(40)
      expect(world.calls).toEqual([])
    })

    test("turning a skill off and on sends the full list with the nonce", async () => {
      await mount(module.DialogSettings)
      await click('[data-skill="notes"] input')
      expect(world.calls).toEqual([
        {
          route: "config.update",
          input: { config: { skills: { disabled: ["claude-x", "ghost", "notes"] } } },
          headers: { "x-swarm-desktop-nonce": NONCE },
        },
      ])
      await tick(40)
      await click('[data-skill="claude-x"] input')
      expect(world.calls[1]).toEqual({
        route: "config.update",
        input: { config: { skills: { disabled: ["ghost", "notes"] } } },
        headers: { "x-swarm-desktop-nonce": NONCE },
      })
    })

    test("View shows plain text: markup in a skill is never rendered", async () => {
      await mount(module.DialogSettings)
      await click('[data-skill="swarm-workflow"] [data-action="skill-view"]')
      expect($('[data-skill="swarm-workflow"] [data-slot="skill-content"]')?.textContent).toBe(HOSTILE)
      expect(host.querySelectorAll("img").length).toBe(0)
      expect((globalThis as any).__pwned).toBeUndefined()
      // Built-in and other-folder rows are view-only.
      expect(has('[data-skill="swarm-workflow"] [data-action="skill-edit"]')).toBe(false)
      expect(has('[data-skill="claude-x"] [data-action="skill-delete"]')).toBe(false)
      expect($('[data-skill="swarm-workflow"]')?.textContent).toContain(text("settings.skills.readOnly"))
      expect($('[data-skill="claude-x"]')?.textContent).toContain(text("settings.skills.otherReadOnly"))
      // A saved skill is read from its source file.
      await click('[data-skill="notes"] [data-action="skill-view"]')
      expect(world.calls[0]).toEqual({ route: "source", input: { scope: "global", name: "notes" }, headers: undefined })
    })

    test("Edit sends the hash it read and the nonce; a 409 shows the changed text", async () => {
      await mount(module.DialogSettings)
      await click('[data-skill="notes"] [data-action="skill-edit"]')
      await typeInto("---\nname: notes\ndescription: d\n---\nnew body")
      world.changed = true
      await click('[data-skill="notes"] [data-action="skill-save"]')
      expect($('[data-slot="skill-error"]')?.textContent).toBe(text("settings.skills.error.changed"))
      world.changed = false
      await click('[data-skill="notes"] [data-action="skill-save"]')
      expect(writes()).toEqual([
        {
          route: "save",
          input: {
            scope: "global",
            name: "notes",
            content: "---\nname: notes\ndescription: d\n---\nnew body",
            baseHash: "h1",
          },
          headers: { "x-swarm-desktop-nonce": NONCE },
        },
        {
          route: "save",
          input: {
            scope: "global",
            name: "notes",
            content: "---\nname: notes\ndescription: d\n---\nnew body",
            baseHash: "h1",
          },
          headers: { "x-swarm-desktop-nonce": NONCE },
        },
      ])
      expect(world.toasts).toEqual([text("settings.skills.saved")])
    })

    test("New saves the frontmatter name in the chosen scope with the nonce", async () => {
      await mount(module.DialogSettings)
      await click('[data-action="skill-new"]')
      expect(host.textContent).toContain(text("settings.skills.saveFor"))
      await typeInto("---\nname: fresh\ndescription: a new one\n---\nbody")
      ;($('input[data-scope="project"]') as HTMLInputElement).click()
      await tick()
      await click('[data-action="skill-save"]')
      expect(writes()).toEqual([
        {
          route: "save",
          input: { scope: "project", name: "fresh", content: "---\nname: fresh\ndescription: a new one\n---\nbody" },
          headers: { "x-swarm-desktop-nonce": NONCE },
        },
      ])
    })

    test("Delete asks first and only then archives with the nonce", async () => {
      await mount(module.DialogSettings)
      await click('[data-skill="proj-skill"] [data-action="skill-delete"]')
      expect(world.calls).toEqual([])
      expect($('[data-slot="skill-delete-confirm"]')?.textContent).toContain(
        text("settings.skills.deleteConfirm", { name: "proj-skill" }),
      )
      await click('[data-action="skill-delete-confirm"]')
      expect(world.calls).toEqual([
        {
          route: "delete",
          input: { scope: "project", name: "proj-skill" },
          headers: { "x-swarm-desktop-nonce": NONCE },
        },
      ])
      expect(world.toasts).toEqual([text("settings.skills.deleted")])
    })

    test("drafts show their badges, and a plain draft is approved without acceptCommands", async () => {
      await mount(module.DialogSettings)
      expect(host.textContent).toContain(text("settings.skills.drafts.title"))
      expect($('[data-draft="d-shell"] [data-badge="untrusted"]')?.textContent).toBe(
        text("settings.skills.drafts.untrusted"),
      )
      expect($('[data-draft="d-shell"] [data-badge="runsCommands"]')?.textContent).toBe(
        text("settings.skills.drafts.runsCommands"),
      )
      expect($('[data-draft="d-shell"] [data-badge="replaces"]')?.textContent).toBe(
        text("settings.skills.drafts.replaces"),
      )
      expect(has('[data-draft="d-plain"] [data-badge]')).toBe(false)
      await click('[data-draft="d-plain"] [data-action="draft-view"]')
      expect($('[data-draft="d-plain"] [data-slot="skill-content"]')?.textContent).toBe("plain draft")
      await click('[data-draft="d-plain"] [data-action="draft-approve"]')
      expect(world.calls).toEqual([
        {
          route: "draftApprove",
          input: { name: "d-plain", scope: "project" },
          headers: { "x-swarm-desktop-nonce": NONCE },
        },
      ])
      expect(world.toasts).toEqual([text("settings.skills.savedNoNote")])
      await click('[data-draft="d-shell-p"] [data-action="draft-discard"]')
      expect(world.calls[1]).toEqual({
        route: "draftDiscard",
        input: { name: "d-shell-p", scope: "project" },
        headers: { "x-swarm-desktop-nonce": NONCE },
      })
    })
  })

  // SR8-08: the confirm UI.
  describe(`Settings ${label} > Skills > a draft that runs commands`, () => {
    test("global scope: Approve opens N8-430 and sends nothing; only its confirm sends acceptCommands", async () => {
      await mount(module.DialogSettings)
      await click('[data-draft="d-shell"] [data-action="draft-approve"]')
      expect(world.calls).toEqual([])
      expect($('[data-draft="d-shell"] [data-slot="skill-commands-confirm"]')?.textContent).toContain(
        text("settings.skills.drafts.confirmCommandsGlobal"),
      )
      await click('[data-draft="d-shell"] [data-action="skill-cancel"]')
      expect(has('[data-slot="skill-commands-confirm"]')).toBe(false)
      expect(world.calls).toEqual([])
      await click('[data-draft="d-shell"] [data-action="draft-approve"]')
      await click('[data-draft="d-shell"] [data-action="draft-approve-commands"]')
      expect(world.calls).toEqual([
        {
          route: "draftApprove",
          input: { name: "d-shell", scope: "global", acceptCommands: true },
          headers: { "x-swarm-desktop-nonce": NONCE },
        },
      ])
    })

    test("project scope shows N8-429; SKILL_SHELL_UNCONFIRMED maps to N8-431", async () => {
      await mount(module.DialogSettings)
      await click('[data-draft="d-shell-p"] [data-action="draft-approve"]')
      const confirm = $('[data-draft="d-shell-p"] [data-slot="skill-commands-confirm"]')?.textContent ?? ""
      expect(confirm).toContain(text("settings.skills.drafts.confirmCommands"))
      expect(confirm).not.toContain(text("settings.skills.drafts.confirmCommandsGlobal"))
      world.forceUnconfirmed = true
      await click('[data-draft="d-shell-p"] [data-action="draft-approve-commands"]')
      expect(routes()).toEqual(["draftApprove"])
      expect($('[data-slot="skill-error"]')?.textContent).toBe(text("settings.skills.error.shellUnconfirmed"))
    })
  })
}

// No new panel: the component is reached only through the two Settings dialogs.
test("SettingsSkills is imported only by the two Settings dialogs", async () => {
  const root = new URL("../src/", import.meta.url).pathname
  const users: string[] = []
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan({ cwd: root }))
    if (file !== "components/settings-skills.tsx" && (await Bun.file(root + file).text()).includes("settings-skills"))
      users.push(file)
  expect(users.sort()).toEqual(["components/dialog-settings.tsx", "components/settings-v2/dialog-settings-v2.tsx"])
})
