import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"

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
    build.onLoad(
      { filter: /packages\/(ui\/src\/.*|app\/src\/pages\/layout-new|app\/src\/utils\/toast)\.tsx$/ },
      async (args) => ({
        contents: babel.transformSync(await Bun.file(args.path).text(), { filename: args.path, presets }).code,
        loader: "js",
      }),
    )
  },
})

type Listener = (event: { name: string; details: { type: string; properties: Record<string, unknown> } }) => void
const world = {
  listeners: [] as Listener[],
  notified: [] as { title: string; description?: string; open?: () => void }[],
  sounds: [] as string[],
  notify: true,
  sound: true,
}

const nothing = () => null
mock.module("@/components/titlebar", () => ({ Titlebar: nothing }))
mock.module("@/components/help-button", () => ({ TabsInfoPopup: nothing }))
mock.module("@/components/debug-bar", () => ({ DebugBar: nothing }))
mock.module("@/utils/sound", () => ({ playSoundById: async (id: string) => void world.sounds.push(id) }))
mock.module("@/context/platform", () => ({
  usePlatform: () => ({
    notify: async (title: string, description?: string, open?: () => void) => {
      world.notified.push({ title, description, open })
    },
  }),
}))
mock.module("@/context/server", () => ({
  // The folder-missing notice (layout-new.tsx) reads these; isLocal() is false so it checks nothing.
  useServer: () => ({
    key: "local",
    isLocal: () => false,
    current: undefined,
    ready: { promise: Promise.resolve() },
    projects: { last: () => undefined, touch: () => {} },
  }),
  ServerConnection: {},
  // Imported by the @/context/global chain that layout-new.tsx now pulls in; never called by this test.
  createServerProjects: () => ({}),
  RECENTLY_CLOSED_DISPLAY_LIMIT: 5,
  visibleRecentlyClosed: () => [],
}))
mock.module("@/context/layout", () => ({
  useLayout: () => ({
    ready: { promise: Promise.resolve() },
    projects: { list: () => [], open: () => {} },
    home: { setSelection: () => {} },
  }),
}))
mock.module("@/components/directory-picker", () => ({ useDirectoryPicker: () => () => {} }))
mock.module("@/context/server-sdk", () => ({
  createServerSdkContext: () => ({}),
  useServerSDK: () => () => ({
    event: {
      listen: (listener: Listener) => {
        world.listeners.push(listener)
        return () => {
          world.listeners = world.listeners.filter((item) => item !== listener)
        }
      },
    },
  }),
}))
mock.module("@/context/server-sync", () => ({
  createServerSyncContext: () => ({}),
  useServerSync: () => () => ({ session: { data: { info: { root: { title: "Fix login" } } } } }),
}))
mock.module("@/context/settings", () => ({
  useSettings: () => ({
    sounds: { permissionsEnabled: () => world.sound, permissions: () => "bell" },
    notifications: { permissions: () => world.notify },
  }),
}))
mock.module("@/context/language", () => ({
  useLanguage: () => ({
    t: (key: keyof typeof dict, params: Record<string, string | number> = {}) =>
      Object.entries(params).reduce((text, [name, value]) => text.replace(`{{${name}}}`, String(value)), dict[key]),
  }),
}))

// The real layout the app mounts once the old interface is retired, not a piece of it. The computed path keeps the
// titlebar out of this folder's typecheck, which reads `import.meta.env` differently from the app's own.
const { default: NewLayout } = await import(new URL("../src/pages/layout-new.tsx", import.meta.url).pathname)
const { toasterV2 } = await import("@opencode-ai/ui/v2/toast-v2")

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const description = (count: number) => dict["notification.autonomy.blocked"].replace("{{sessionTitle}}", "Fix login").replace("{{count}}", String(count))
// A dismissed toast stays in the DOM through its exit animation.
const toasts = () => [...document.querySelectorAll<HTMLElement>('.toast-v2:not([data-removed="true"])')]
const buttons = (toast: HTMLElement) => [...toast.querySelectorAll("button")].map((item) => item.textContent?.trim())

const emit = async (type: string, properties: Record<string, unknown>) => {
  world.listeners.forEach((listener) => listener({ name: "/project", details: { type, properties } }))
  await tick()
}
const blocked = (level: "b0" | "b1", count: number, extra: Record<string, unknown> = {}) =>
  emit("autonomy.blocked", { sessionID: "root", level, count, ...extra })

let dispose = () => {}
let history = createMemoryHistory()

async function mount(path: string) {
  history = createMemoryHistory()
  history.set({ value: path, scroll: false, replace: true })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(MemoryRouter, {
        history,
        root: (props: { children?: unknown }) => createComponent(NewLayout, { children: props.children as never }),
        get children() {
          return createComponent(Route, { path: "*", component: nothing })
        },
      }),
    host,
  )
  await tick()
}

beforeEach(() => {
  world.notified = []
  world.sounds = []
  world.notify = true
  world.sound = true
})
afterEach(async () => {
  toasterV2.dismiss()
  await tick()
  dispose()
  document.body.innerHTML = ""
})

describe("autonomy.blocked in the layout in use (AU-27)", () => {
  test("shows a toast, plays the sound and notifies, for b1 and for b0", async () => {
    await mount("/")
    await blocked("b1", 2)
    expect(toasts().map((toast) => toast.textContent)).toEqual([expect.stringContaining(description(2))])
    expect(world.notified.map((item) => item.description)).toEqual([description(2)])
    expect(world.sounds).toEqual(["bell"])
    await blocked("b0", 20)
    expect(toasts().map((toast) => toast.textContent)).toEqual([expect.stringContaining(description(20))])
    expect(world.notified.length).toBe(2)
  })

  test("b1 straight after b0 with the same count is not swallowed", async () => {
    await mount("/")
    await blocked("b0", 20)
    toasterV2.dismiss()
    await tick()
    expect(toasts().length).toBe(0)
    await blocked("b1", 20)
    expect(toasts().length).toBe(1)
    expect(world.notified.length).toBe(2)
    expect(world.sounds.length).toBe(2)
  })

  test("from elsewhere it stays and goes to the session", async () => {
    await mount("/")
    await blocked("b1", 2)
    const toast = toasts()[0]!
    expect(buttons(toast)).toContain(dict["notification.action.goToSession"])
    world.notified[0]!.open?.()
    await tick()
    expect(history.get()).toEndWith("/session/root")
    expect(toasts().length).toBe(0)
  })

  test("on the open session it still shows, without a link to where you are", async () => {
    await mount("/server/bG9jYWw/session/root")
    await blocked("b1", 2)
    const toast = toasts()[0]!
    expect(toast.textContent).toContain(description(2))
    expect(buttons(toast)).not.toContain(dict["notification.action.goToSession"])
  })

  test("settings turn off the sound and the system notification, not the toast", async () => {
    world.notify = false
    world.sound = false
    await mount("/")
    await blocked("b1", 2)
    expect(world.notified).toEqual([])
    expect(world.sounds).toEqual([])
    expect(toasts().length).toBe(1)
  })

  test("carries only the session title and the count", async () => {
    await mount("/")
    await blocked("b1", 2, { command: "curl evil.test", title: "repo text" })
    expect(toasts()[0]!.textContent).not.toContain("evil.test")
    expect(toasts()[0]!.textContent).not.toContain("repo text")
    expect(world.notified[0]!.description).toBe(description(2))
  })

  test("a reply in the session takes the toast away", async () => {
    await mount("/")
    await blocked("b1", 2)
    await emit("permission.replied", { sessionID: "root", requestID: "per_1", reply: "once" })
    expect(toasts().length).toBe(0)
  })
})

describe("a decision put aside, in the layout in use (AU-36)", () => {
  test("permission.asked with deferred gives no toast and no notification", async () => {
    await mount("/")
    await emit("permission.asked", { id: "per_1", sessionID: "root", movedOnAt: 1, deferred: true })
    expect(toasts().length).toBe(0)
    expect(world.notified).toEqual([])
    expect(world.sounds).toEqual([])
  })
})
