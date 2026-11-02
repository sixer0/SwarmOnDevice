import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { ServerScope } from "@/utils/server-scope"

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

// Everything the layouts read and this test does not look at: any property, callable, empty when iterated. A call
// answers with something not callable, because Solid keeps calling a rendered function until it gets a value.
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

type Listener = (event: { name: string; details: { type: string; properties: Record<string, unknown> } }) => void
const world = { listeners: [] as Listener[], newLayout: true }

const nothing = () => null
// A module keeps every export it has; only the ones named here change.
const override = async (id: string, values: Record<string, unknown>) => {
  const real = await import(id)
  mock.module(id, () => ({ ...real, ...values }))
}
const directoryStore = () => [
  { path: { directory: "/work/proj" }, session: [], session_status: {}, permission: {}, question: {} },
]
await override("@/components/titlebar", { Titlebar: nothing })
await override("@/pages/layout/sidebar-shell", { SidebarContent: nothing })
await override("@/components/help-button", { TabsInfoPopup: nothing })
await override("@/components/debug-bar", { DebugBar: nothing })
await override("@/components/directory-picker", { useDirectoryPicker: anything })
await override("@/utils/sound", { playSoundById: async () => {} })
await override("@/hooks/use-providers", { useProviders: anything })
await override("@/context/platform", {
  usePlatform: () => partly({ notify: async () => {}, platform: "web", updater: undefined }),
})
await override("@/context/server", {
  useServer: () => partly({ key: "local", scope: () => ServerScope.local, list: [] }),
})
await override("@/context/server-sdk", {
  useServerSDK: () => () =>
    partly({
      event: {
        listen: (listener: Listener) => {
          world.listeners.push(listener)
          return () => {
            world.listeners = world.listeners.filter((item) => item !== listener)
          }
        },
      },
      scope: ServerScope.local,
    }),
})
await override("@/context/server-sync", {
  useServerSync: () => () =>
    partly({
      session: { data: { info: { root: { title: "Fix login" } } } },
      peek: directoryStore,
      child: directoryStore,
    }),
})
await override("@/context/settings", {
  useSettings: () =>
    partly({
      general: partly({ newLayoutDesigns: () => world.newLayout }),
      sounds: partly({ permissionsEnabled: () => false, agentEnabled: () => false, errorsEnabled: () => false }),
      notifications: partly({ permissions: () => false, agent: () => false, errors: () => false }),
    }),
})
await override("@/context/language", {
  useLanguage: () => ({
    t: (key: keyof typeof dict) => dict[key] ?? String(key),
    plural: () => "",
    locale: () => "en",
    intl: () => "en",
    locales: [],
    label: () => "",
    setLocale: () => {},
  }),
})
await override("@/context/layout", { useLayout: anything })
await override("@/context/notification", { useNotification: anything })
await override("@/context/command", { useCommand: anything })
await override("@opencode-ai/ui/context/dialog", { useDialog: anything })
await override("@opencode-ai/ui/theme/context", { useTheme: anything })

// The real layouts the app mounts, not a piece of them. The computed path keeps them out of this folder's typecheck,
// which reads `import.meta.env` differently from the app's own.
const { default: NewLayout } = await import(new URL("../src/pages/layout-new.tsx", import.meta.url).pathname)
const { default: LegacyLayout } = await import(new URL("../src/pages/layout.tsx", import.meta.url).pathname)
const { showToast } = await import(new URL("../src/utils/toast.tsx", import.meta.url).pathname)
const { toasterV2 } = await import("@opencode-ai/ui/v2/toast-v2")

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const v2Toasts = () => [...document.querySelectorAll<HTMLElement>('.toast-v2:not([data-removed="true"])')]
const emit = async (type: string, properties: Record<string, unknown>) => {
  world.listeners.forEach((listener) => listener({ name: "/project", details: { type, properties } }))
  await tick()
}

let dispose = () => {}

afterEach(async () => {
  toasterV2.dismiss()
  await tick()
  dispose()
  world.listeners = []
  document.body.innerHTML = ""
})

// The same nesting `app.tsx` builds: the new layout at the router root, the legacy one on the `/:dir` routes beneath it.
async function mount(path: string, root: (props: { children?: unknown }) => unknown) {
  const history = createMemoryHistory()
  history.set({ value: path, scroll: false, replace: true })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(MemoryRouter, {
        history,
        root: root as never,
        get children() {
          return [
            createComponent(Route, { path: "/", component: nothing }),
            createComponent(Route, {
              path: "/:dir/*",
              component: (props: { children?: unknown }) =>
                createComponent(LegacyLayout, { children: props.children as never }),
            }),
          ] as never
        },
      }),
    host,
  )
  await tick()
  return history
}

const withNewLayout = (props: { children?: unknown }) =>
  createComponent(NewLayout, { children: props.children as never })

const go = async (history: ReturnType<typeof createMemoryHistory>, value: string) => {
  history.set({ value, scroll: false, replace: true })
  await tick()
}
// What a click on a system notification does: `/:dir/session/:id` is matched by the legacy branch first.
const passThroughLegacy = async () => {
  const history = await mount("/", withNewLayout)
  await go(history, "/L3dvcmsvcHJvag/session/ses_1")
  expect(document.querySelector('[data-component="toast-region"]')).not.toBeNull()
  return history
}

describe("toasts after the legacy layout passed through (F3)", () => {
  test("a toast still shows once the legacy layout under the new one is gone", async () => {
    const history = await passThroughLegacy()
    await go(history, "/")
    expect(document.querySelector('[data-component="toast-region"]')).toBeNull()

    showToast({ title: dict["toast.permissions.autonomous.on.title"] })
    await tick()
    expect(v2Toasts().map((toast) => toast.textContent)).toEqual([
      expect.stringContaining(dict["toast.permissions.autonomous.on.title"]),
    ])
  })

  test("autonomy.blocked shows its toast afterwards too", async () => {
    const history = await passThroughLegacy()
    await go(history, "/")
    await emit("autonomy.blocked", { sessionID: "root", level: "b1", count: 2 })
    expect(v2Toasts().length).toBe(1)
  })

  test("a toast raised while the legacy layout is mounted reaches the region that stays", async () => {
    await passThroughLegacy()
    showToast({ title: dict["toast.permissions.autonomous.off.title"] })
    await tick()
    expect(v2Toasts().length).toBe(1)
  })

  test("with the old interface alone the legacy toaster stays in charge", async () => {
    world.newLayout = false
    try {
      await mount("/L3dvcmsvcHJvag/session", (props) => props.children)
      showToast({ title: dict["toast.permissions.autonomous.off.title"] })
      await tick()
      expect(v2Toasts().length).toBe(0)
      expect(document.querySelector('[data-component="toast-region"]')?.textContent).toContain(
        dict["toast.permissions.autonomous.off.title"],
      )
    } finally {
      world.newLayout = true
    }
  })
})
