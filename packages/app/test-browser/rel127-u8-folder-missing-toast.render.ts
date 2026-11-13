import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { ServerScope } from "@/utils/server-scope"

// 1.2.7 U-8 (AC-U8, N7-096): the legacy layout's start-up autoselect and its other project openings check the folder
// first. A missing folder is neither added nor entered; one persistent toast offers Restore / Recreate / Choose under
// SR7-13 rules 5-7. The desktop half (rules 1-4) is N7-095 in packages/desktop.

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

// Everything the layout reads and this test does not look at: any property, callable, empty when iterated.
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

const GONE = "/work/gone"
const HOME = "/home/tester"
const world = {
  exists: new Set<string>(),
  last: GONE as string | undefined,
  list: [{ worktree: GONE }] as { worktree: string }[],
  checked: [] as string[],
  recreated: [] as string[],
  recreateResult: true,
  picker: [] as unknown[],
  opened: [] as string[],
  touched: [] as string[],
}

const nothing = () => null
const override = async (id: string, values: Record<string, unknown>) => {
  const real = await import(id)
  mock.module(id, () => ({ ...real, ...values }))
}
const directoryStore = () => [
  { path: { directory: GONE }, session: [], session_status: {}, permission: {}, question: {} },
]
const ready = Object.assign(() => true, { promise: Promise.resolve() })

await override("@/components/titlebar", { Titlebar: nothing })
await override("@/pages/layout/sidebar-shell", { SidebarContent: nothing })
await override("@/components/help-button", { TabsInfoPopup: nothing })
await override("@/components/debug-bar", { DebugBar: nothing })
await override("@/components/directory-picker", { useDirectoryPicker: anything })
await override("@/utils/sound", { playSoundById: async () => {} })
await override("@/hooks/use-providers", { useProviders: anything })
await override("@/context/platform", {
  usePlatform: () =>
    partly({
      platform: "desktop",
      notify: async () => {},
      updater: undefined,
      storage: undefined,
      draftStore: undefined,
      checkDirectoryExists: async (path: string) => {
        world.checked.push(path)
        return world.exists.has(path)
      },
      recreateDirectory: async (path: string) => {
        world.recreated.push(path)
        if (world.recreateResult) world.exists.add(path)
        return world.recreateResult
      },
      openDirectoryPickerDialog: async (opts: unknown) => {
        world.picker.push(opts)
        return null
      },
    }),
})
await override("@/context/server", {
  useServer: () =>
    partly({
      key: "local",
      scope: () => ServerScope.local,
      list: [],
      isLocal: () => true,
      current: { type: "http", http: { url: "http://127.0.0.1:4096" } },
      projects: partly({
        last: () => world.last,
        touch: (path: string) => world.touched.push(path),
      }),
    }),
})
await override("@/context/server-sdk", {
  useServerSDK: () => () => partly({ event: { listen: () => () => {} }, scope: ServerScope.local }),
})
await override("@/context/server-sync", {
  useServerSync: () => () =>
    partly({
      data: partly({ path: { home: HOME }, project: [] }),
      peek: directoryStore,
      child: directoryStore,
    }),
})
await override("@/context/settings", {
  useSettings: () =>
    partly({
      general: partly({ newLayoutDesigns: () => false }),
      sounds: partly({ permissionsEnabled: () => false, agentEnabled: () => false, errorsEnabled: () => false }),
      notifications: partly({ permissions: () => false, agent: () => false, errors: () => false }),
    }),
})
await override("@/context/language", {
  useLanguage: () => ({
    t: (key: keyof typeof dict, params?: Record<string, string>) =>
      String(dict[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) => params?.[name] ?? ""),
    plural: () => "",
    locale: () => "en",
    intl: () => "en",
    locales: [],
    label: () => "",
    setLocale: () => {},
  }),
})
await override("@/context/layout", {
  useLayout: () =>
    partly({
      ready,
      projects: partly({
        list: () => world.list,
        open: (path: string) => world.opened.push(path),
      }),
    }),
})
await override("@/context/notification", { useNotification: anything })
await override("@/context/command", { useCommand: anything })
await override("@opencode-ai/ui/context/dialog", { useDialog: anything })
await override("@opencode-ai/ui/theme/context", { useTheme: anything })

const { default: LegacyLayout } = await import(new URL("../src/pages/layout.tsx", import.meta.url).pathname)
const { toaster } = await import("@opencode-ai/ui/toast")

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const region = () => document.querySelector('[data-component="toast-region"]')
const toastText = () => region()?.textContent ?? ""
const button = (label: string) =>
  [...(region()?.querySelectorAll("button") ?? [])].find((item) => item.textContent?.trim() === label)
const click = async (label: string) => {
  const target = button(label)
  if (!target) throw new Error(`no "${label}" button in: ${toastText()}`)
  target.click()
  await tick()
}
const t = (key: keyof typeof dict) => String(dict[key]).replace("{{path}}", GONE)

let dispose = () => {}

beforeEach(() => {
  world.exists = new Set()
  world.last = GONE
  world.list = [{ worktree: GONE }]
  world.checked = []
  world.recreated = []
  world.recreateResult = true
  world.picker = []
  world.opened = []
  world.touched = []
  ;(window as { __OPENCODE__?: { deepLinks?: string[] } }).__OPENCODE__ = { deepLinks: [] }
})

afterEach(async () => {
  toaster.clear()
  await tick()
  dispose()
  document.body.innerHTML = ""
})

// The legacy layout at the router root with no folder in the route: the start-up autoselect runs.
async function mount() {
  const history = createMemoryHistory()
  history.set({ value: "/", scroll: false, replace: true })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(MemoryRouter, {
        history,
        root: (props: { children?: unknown }) => createComponent(LegacyLayout, { children: props.children as never }),
        get children() {
          return [createComponent(Route, { path: "/", component: nothing })] as never
        },
      }),
    host,
  )
  await tick(80)
  return history
}

describe("U-8 missing project folder (AC-U8, N7-096)", () => {
  test("start-up: the stored last folder is gone -> not added, not entered, one persistent toast, nothing created", async () => {
    const history = await mount()
    // Step 0 (C9): at BASE the folder is added and entered without a check and no notice appears.
    expect(world.opened).toEqual([])
    expect(world.touched).toEqual([])
    expect(history.get()).toBe("/")
    expect(world.checked).toContain(GONE)
    expect(toastText()).toContain(dict["toast.project.folderMissing.title"])
    expect(toastText()).toContain(t("toast.project.folderMissing.description"))
    expect(button(dict["toast.project.folderMissing.restore"])).toBeDefined()
    expect(button(dict["toast.project.folderMissing.recreate"])).toBeDefined()
    expect(button(dict["toast.project.folderMissing.choose"])).toBeDefined()
    expect(region()?.querySelectorAll('[data-component="toast"]').length).toBe(1)
    expect(world.recreated).toEqual([])
    // persistent: still there later
    await tick(200)
    expect(toastText()).toContain(dict["toast.project.folderMissing.title"])
  })

  test("Recreate calls recreateDirectory once for that path, then opens the project", async () => {
    await mount()
    await click(dict["toast.project.folderMissing.recreate"])
    expect(world.recreated).toEqual([GONE])
    expect(world.opened).toEqual([GONE])
    expect(world.touched).toEqual([GONE])
    expect(toastText()).not.toContain(dict["toast.project.folderMissing.title"])
  })

  test("Recreate refused (parent missing): the N7-127 text, no second Recreate, nothing opened", async () => {
    world.recreateResult = false
    await mount()
    await click(dict["toast.project.folderMissing.recreate"])
    expect(world.recreated).toEqual([GONE])
    expect(world.opened).toEqual([])
    expect(toastText()).toContain(t("toast.project.folderMissing.recreateFailed"))
    expect(button(dict["toast.project.folderMissing.recreate"])).toBeUndefined()
    expect(button(dict["toast.project.folderMissing.choose"])).toBeDefined()
  })

  test("Restore re-checks: still gone keeps the notice; back again opens the same path, nothing created", async () => {
    await mount()
    await click(dict["toast.project.folderMissing.restore"])
    expect(world.opened).toEqual([])
    expect(toastText()).toContain(dict["toast.project.folderMissing.title"])
    world.exists.add(GONE)
    await click(dict["toast.project.folderMissing.restore"])
    expect(world.opened).toEqual([GONE])
    expect(world.touched).toEqual([GONE])
    expect(world.recreated).toEqual([])
  })

  test("Choose opens the folder picker at home", async () => {
    await mount()
    await click(dict["toast.project.folderMissing.choose"])
    expect(world.picker).toEqual([expect.objectContaining({ defaultPath: HOME })])
    expect(world.recreated).toEqual([])
  })

  test("a deep-link-only folder gets Restore and Choose, never Recreate; no session route is entered", async () => {
    world.last = undefined
    world.list = []
    const other = "/work/elsewhere"
    ;(window as { __OPENCODE__?: { deepLinks?: string[] } }).__OPENCODE__ = {
      deepLinks: [`swarm://new-session?directory=${encodeURIComponent(other)}`],
    }
    const history = await mount()
    expect(world.checked).toContain(other)
    expect(history.get()).toBe("/")
    expect(toastText()).toContain(dict["toast.project.folderMissing.title"])
    expect(button(dict["toast.project.folderMissing.recreate"])).toBeUndefined()
    expect(button(dict["toast.project.folderMissing.restore"])).toBeDefined()
    expect(button(dict["toast.project.folderMissing.choose"])).toBeDefined()
  })

  test("CHAR: an existing stored folder opens as before, with no notice", async () => {
    world.exists.add(GONE)
    await mount()
    expect(world.opened).toEqual([GONE])
    expect(world.touched).toEqual([GONE])
    // String(): the key is absent at BASE, where this line must pass too.
    expect(toastText()).not.toContain(String(dict["toast.project.folderMissing.title"]))
  })
})
