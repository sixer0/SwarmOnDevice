import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"

// 1.2.7 row 58b (AC-U8, F-4 of the live session): a fresh profile runs the NEW layout, which opens projects from Home,
// its palette and the composer, not through the legacy layout's openProject. The new layout now checks the folder
// with the same shared helper (pages/layout/folder-missing.ts): at start-up the project Home would focus is checked,
// and Home's "open project in a new session" goes through the check. Only "missing" shows the notice; a missing
// project is neither opened nor entered (no draft tab). Red at c79943d5d3: no check, no notice, the draft opens.

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
const OTHER = "/work/other"
const HOME = "/home/tester"
const CONN = { type: "http", http: { url: "http://127.0.0.1:4096" } }

type Toast = {
  id: number
  persistent?: boolean
  title?: string
  description?: string
  actions?: { label: string; onClick: unknown }[]
}

const world = {
  exists: new Set<string>(),
  refused: new Set<string>(),
  last: GONE as string | undefined,
  list: [{ worktree: GONE }] as { worktree: string }[],
  checked: [] as string[],
  recreated: [] as string[],
  picker: [] as unknown[],
  opened: [] as string[],
  touched: [] as string[],
  selected: [] as unknown[],
  drafts: [] as unknown[],
  toasts: [] as Toast[],
}

const nothing = () => null
const override = async (id: string, values: Record<string, unknown>) => {
  const real = await import(id)
  mock.module(id, () => ({ ...real, ...values }))
}
const ready = Object.assign(() => true, { promise: Promise.resolve() })
const projects = () =>
  partly({
    list: () => world.list,
    last: () => world.last,
    open: (path: string) => world.opened.push(path),
    touch: (path: string) => world.touched.push(path),
    recentlyClosed: () => [],
  })

let toastSeq = 0
await override("@/utils/toast", {
  setV2Toast: () => {},
  ToastRegion: nothing,
  showToast: (options: Omit<Toast, "id">) => {
    const id = ++toastSeq
    world.toasts.push({ ...options, id })
    return id
  },
  dismissToast: (id: number) => {
    world.toasts = world.toasts.filter((item) => item.id !== id)
  },
})
await override("@/components/titlebar", { Titlebar: nothing })
await override("@/components/help-button", { TabsInfoPopup: nothing })
await override("@/components/debug-bar", { DebugBar: nothing })
await override("@/pages/autonomy-blocked-alerts", { useAutonomyBlockedAlerts: () => {} })
await override("@/components/directory-picker", {
  useDirectoryPicker: () => (input: unknown) => world.picker.push(input),
})
await override("@/context/platform", {
  usePlatform: () =>
    partly({
      platform: "desktop",
      updater: undefined,
      checkDirectoryExists: async (path: string) => {
        world.checked.push(path)
        return world.exists.has(path) ? "exists" : world.refused.has(path) ? "refused" : "missing"
      },
      recreateDirectory: async (path: string) => {
        world.recreated.push(path)
        world.exists.add(path)
        return true
      },
    }),
})
await override("@/context/server", {
  useServer: () =>
    partly({
      key: "local",
      list: [CONN],
      current: CONN,
      ready,
      isLocal: () => true,
      projects: projects(),
    }),
})
await override("@/context/server-sync", {
  useServerSync: () => () => partly({ data: partly({ path: { home: HOME }, project: [] }) }),
})
await override("@/context/global", {
  useGlobal: () =>
    partly({
      servers: partly({ list: () => [CONN], health: {} }),
      ensureServerCtx: () => partly({ projects: projects() }),
    }),
})
await override("@/context/tabs", {
  useTabs: () => partly({ newDraft: async (draft: unknown) => world.drafts.push(draft) }),
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
      projects: projects(),
      home: partly({
        selection: () => ({ server: "local" }),
        setSelection: (value: unknown) => world.selected.push(value),
      }),
    }),
})

const { default: NewLayout } = await import(new URL("../src/pages/layout-new.tsx", import.meta.url).pathname)
const { createHomeController } = await import(new URL("../src/pages/home/home-controller.ts", import.meta.url).pathname)

const tick = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const notices = () => world.toasts.filter((item) => item.title === dict["toast.project.folderMissing.title"])
const labels = (toast: Toast | undefined) => toast?.actions?.map((action) => action.label) ?? []
const click = async (label: string) => {
  const action = notices()
    .at(-1)
    ?.actions?.find((item) => item.label === label)
  if (!action || typeof action.onClick !== "function") throw new Error(`no "${label}" action`)
  action.onClick()
  await tick()
}

let dispose = () => {}
let home: ReturnType<typeof createHomeController> | undefined

beforeEach(() => {
  world.exists = new Set()
  world.refused = new Set()
  world.last = GONE
  world.list = [{ worktree: GONE }]
  world.checked = []
  world.recreated = []
  world.picker = []
  world.opened = []
  world.touched = []
  world.selected = []
  world.drafts = []
  world.toasts = []
  home = undefined
})

afterEach(async () => {
  dispose()
  document.body.innerHTML = ""
  await tick()
})

// The real NewLayout with Home's controller as its child (Home mounts it under the layout).
async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(NewLayout, {
        get children() {
          return createComponent(() => {
            home = createHomeController()
            return null
          }, {}) as never
        },
      }),
    host,
  )
  await tick(80)
}

describe("U-8 in the new layout (row 58b, AC-U8, F-4)", () => {
  test("start-up: the last project's folder is gone -> one persistent notice, nothing opened or entered", async () => {
    await mount()
    expect(world.checked).toContain(GONE)
    expect(notices().length).toBe(1)
    const notice = notices()[0]
    expect(notice?.persistent).toBe(true)
    expect(notice?.description).toBe(String(dict["toast.project.folderMissing.description"]).replace("{{path}}", GONE))
    expect(labels(notice)).toEqual([
      dict["toast.project.folderMissing.restore"],
      dict["toast.project.folderMissing.recreate"],
      dict["toast.project.folderMissing.choose"],
    ])
    expect(world.opened).toEqual([])
    expect(world.touched).toEqual([])
    expect(world.drafts).toEqual([])
    expect(world.recreated).toEqual([])
  })

  test("Home opens a project whose folder is missing -> the notice, no draft tab (no navigation)", async () => {
    world.exists.add(OTHER)
    world.last = OTHER
    world.list = [{ worktree: OTHER }, { worktree: GONE }]
    await mount()
    expect(notices().length).toBe(0)
    await home!.project.openProjectNewSession(CONN as never, GONE)
    await tick()
    expect(world.checked).toContain(GONE)
    expect(world.drafts).toEqual([])
    expect(world.opened).toEqual([])
    expect(notices().length).toBe(1)
    expect(notices()[0]?.description).toContain(GONE)
  })

  test("Recreate makes the folder once and then opens it; Restore with the folder back opens it", async () => {
    await mount()
    await click(dict["toast.project.folderMissing.restore"])
    expect(world.opened).toEqual([])
    expect(notices().length).toBe(1)
    await click(dict["toast.project.folderMissing.recreate"])
    expect(world.recreated).toEqual([GONE])
    expect(world.opened).toEqual([GONE])
    expect(world.touched).toEqual([GONE])
    expect(notices().length).toBe(0)
  })

  test("Choose opens the folder picker at home", async () => {
    await mount()
    await click(dict["toast.project.folderMissing.choose"])
    expect(world.picker).toEqual([expect.objectContaining({ defaultPath: HOME })])
  })

  test("refused (the desktop may not look) opens as in 1.2.6, no notice", async () => {
    world.refused.add(GONE)
    await mount()
    await home!.project.openProjectNewSession(CONN as never, GONE)
    await tick()
    expect(notices().length).toBe(0)
    expect(world.drafts).toEqual([expect.objectContaining({ directory: GONE })])
  })

  test("CHAR: an existing folder opens a draft as before, with no notice", async () => {
    world.exists.add(GONE)
    await mount()
    await home!.project.openProjectNewSession(CONN as never, GONE)
    await tick()
    expect(notices().length).toBe(0)
    expect(world.opened).toEqual([GONE])
    expect(world.drafts).toEqual([expect.objectContaining({ directory: GONE })])
  })
})
