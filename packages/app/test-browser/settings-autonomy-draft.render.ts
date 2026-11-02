import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { createComponent, render } from "solid-js/web"
import { createRoot } from "solid-js"
import { base64Encode } from "@opencode-ai/core/util/encode"
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
    build.onLoad({ filter: /packages\/(ui|session-ui|app)\/src\/.*\.tsx$/ }, async (args) => ({
      contents: babel.transformSync(await Bun.file(args.path).text(), { filename: args.path, presets }).code,
      loader: "js",
    }))
  },
})

// Everything the dialog reads and this test does not look at: any property, callable, empty when iterated. A call
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

// The server's own rule: a session's value, or else its folder's. One state per server.
type Call = { server: string; directory: string; on: boolean; sessionID?: string }
const world = {
  folders: new Set<string>(),
  sessions: new Set<string>(),
  writes: [] as Call[],
  reads: [] as string[],
  tabs: [] as { type: string; draftID?: string; server?: string; directory?: string }[],
  servers: ["local", "remote"],
  pathname: { value: "/", search: "" },
  commands: new Map<string, () => { id: string; keybind?: string; title: string; onSelect?: () => unknown }[]>(),
}
const autonomyOf = (server: string, directory: string) => ({
  mode: async () => {
    world.reads.push(`${server}:${directory}`)
    return { data: { on: world.folders.has(`${server}:${directory}`) } }
  },
  session: async (input: { sessionID: string }) => {
    world.reads.push(`${server}:${input.sessionID}`)
    return {
      data: {
        on: world.sessions.has(`${server}:${input.sessionID}`) || world.folders.has(`${server}:${directory}`),
        open: 0,
      },
    }
  },
  modeUpdate: async (input: { on: boolean; sessionID?: string }) => {
    world.writes.push({ server, directory, on: input.on, sessionID: input.sessionID })
    const key = input.sessionID ? `${server}:${input.sessionID}` : `${server}:${directory}`
    const level = input.sessionID ? world.sessions : world.folders
    if (input.on) level.add(key)
    if (!input.on) level.delete(key)
    return { data: { on: input.on } }
  },
})
const sdkOf = (server: string) => ({
  createClient: (input: { directory: string }) => ({ autonomy: autonomyOf(server, input.directory) }),
})

const override = async (id: string, values: Record<string, unknown>) => {
  const real = await import(id)
  mock.module(id, () => ({ ...real, ...values }))
}
const nothing = () => null
await override("@/components/settings-v2/providers", { SettingsProvidersV2: nothing })
await override("@/components/settings-v2/models", { SettingsModelsV2: nothing })
await override("@/components/settings-v2/servers", { SettingsServersV2: nothing })
await override("@/components/settings-keybinds", { SettingsKeybinds: nothing })
await override("@/components/settings-v2/interface-transition", {
  LayoutRetirementNotice: nothing,
  LayoutTransitionToggle: nothing,
})
await override("@/components/updater-action", { useUpdaterAction: anything })
await override("@/utils/sound", { playSoundById: async () => {}, SOUND_OPTIONS: [] })
await override("@/context/platform", { usePlatform: () => partly({ platform: "web" }) })
const { ServerConnection } = await import("@/context/server")
await override("@/context/server", {
  useServer: () => partly({ key: "local", list: [] }),
  ServerConnection: { ...ServerConnection, key: (conn: { key: string }) => conn.key },
})
await override("@/context/global", {
  useGlobal: () => ({
    servers: { list: () => world.servers.map((key) => ({ key })) },
    ensureServerCtx: (conn: { key: string }) => ({ sdk: sdkOf(conn.key) }),
  }),
})
await override("@/context/server-sdk", {
  useServerSDK: () => () => partly(sdkOf("local")),
})
await override("@/context/server-sync", {
  useServerSync: () => () => partly({ session: partly({ lineage: { peek: () => undefined }, get: () => undefined }) }),
})
await override("@/context/settings", {
  useSettings: () => partly({ general: partly({ newLayoutDesigns: () => true }) }),
})
await override("@/context/language", {
  useLanguage: () =>
    partly({
      t: (key: keyof typeof dict) => dict[key] ?? String(key),
      locale: () => "en",
      intl: () => "en",
      locales: [],
    }),
})
const { currentRoute } = await import("@/context/layout")
await override("@/context/layout", {
  useLayout: () => partly({ route: () => currentRoute(world.pathname.value, world.pathname.search) }),
})
await override("@/context/tabs", { useTabs: () => ({ store: world.tabs }) })
await override("@opencode-ai/ui/context/dialog", { useDialog: anything })
await override("@opencode-ai/ui/theme/context", { useTheme: anything })
await override("@opencode-ai/ui/v2/dialog-v2", { Dialog: (props: { children?: unknown }) => props.children })

// The session page's command hook, for the palette entry and its shortcut. Only what that entry reads is real.
await override("@/context/command", {
  useCommand: () =>
    partly({
      register: (name: string, options: () => never[]) => world.commands.set(name, options),
    }),
})
await override("@/context/sdk", { useSDK: () => () => partly({ directory: "/work/proj" }) })
await override("@/pages/session/session-layout", {
  useSessionLayout: () => partly({ params: { id: "ses_a" } }),
})
await override("@/components/project-memory", { createProjectMemoryNotices: () => {} })
await override("@/pages/session/session-archive", { useSessionArchive: anything })
for (const [id, name] of [
  ["@/context/file", "useFile"],
  ["@/context/prompt", "usePrompt"],
  ["@/context/terminal", "useTerminal"],
  ["@/context/local", "useLocal"],
])
  await override(id, { [name]: anything })
await override("@/context/sync", { useSync: () => () => anything() })

// The real dialog, the real composer and the real session command hook. The computed paths keep the dialog and the
// hook out of this folder's typecheck, which reads `import.meta.env` differently from the app's own.
const { DialogSettings } = await import(
  new URL("../src/components/settings-v2/dialog-settings-v2.tsx", import.meta.url).pathname
)
const { useSessionCommands } = await import(
  new URL("../src/pages/session/use-session-commands.tsx", import.meta.url).pathname
)
const { createPromptAutonomy } = await import("@/components/prompt-input/autonomy")

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
// A count, not the element: printing a happy-dom element on failure never finishes.
const settingsRows = () => document.querySelectorAll('[data-action="settings-autonomous-mode"]').length

let dispose = () => {}

async function mount(pathname: string, search: string, root: () => unknown) {
  world.pathname = { value: pathname, search }
  const history = createMemoryHistory()
  history.set({ value: `${pathname}${search}`, scroll: false, replace: true })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(MemoryRouter, {
        history,
        root: root as never,
        get children() {
          return createComponent(Route, { path: "*", component: nothing })
        },
      }),
    host,
  )
  await tick()
}

const palette = () => world.commands.get("session")!().find((option) => option.id === "permissions.autonomous")!

beforeEach(() => {
  world.folders = new Set()
  world.sessions = new Set()
  world.writes = []
  world.reads = []
  world.tabs.length = 0
  world.servers = ["local", "remote"]
  world.commands.clear()
})
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

// Decision C62: the mode is changed from the add menu, the palette and its shortcut, never from Settings.
describe("Settings > General has no autonomous row", () => {
  const places = [
    { name: "Home", pathname: "/", search: "", props: {} },
    { name: "a session", pathname: `/server/${base64Encode("remote")}/session/ses_a`, search: "", props: { sessionID: "ses_a" } },
    { name: "a draft", pathname: "/new-session", search: "?draftId=d1", props: {} },
  ]
  for (const place of places)
    test(`opened from ${place.name}`, async () => {
      world.tabs.push({ type: "draft", draftID: "d1", server: "remote", directory: "/work/proj" })
      await mount(place.pathname, place.search, () => createComponent(DialogSettings, place.props))
      expect(document.body.textContent).toContain(dict["settings.general.row.shell.title"])
      expect(settingsRows()).toBe(0)
      expect(document.body.textContent).not.toContain(dict["settings.general.row.autonomous.title"])
      expect(world.reads).toEqual([])
      expect(world.writes).toEqual([])
    })
})

describe("the ways that stay", () => {
  test("the add menu on a draft changes that folder's level", async () => {
    const composer = createRoot(() =>
      createPromptAutonomy({
        sdk: () =>
          ({
            client: { autonomy: autonomyOf("remote", "/work/proj") },
            event: { on: () => () => {} },
          }) as never,
        sessionID: () => undefined,
        onChanged: () => {},
        onFailed: () => {},
      }),
    )
    await tick()
    expect(composer.on()).toBe(false)

    await composer.toggle()
    expect(world.writes).toEqual([{ server: "remote", directory: "/work/proj", on: true, sessionID: undefined }])
    expect(composer.on()).toBe(true)
  })

  test("the palette entry and mod+shift+a change the session it was given, from what the server holds now", async () => {
    await mount(`/server/${base64Encode("local")}/session/ses_a`, "", () =>
      createComponent(() => {
        useSessionCommands(anything())
        return null
      }, {}),
    )
    expect(palette().keybind).toBe("mod+shift+a")
    expect(palette().title).toBe(dict["command.permissions.autonomous.enable"])

    // Changed elsewhere since the session opened: the entry reads again before it writes.
    world.folders.add("local:/work/proj")
    await palette().onSelect!()
    await tick()
    expect(world.writes).toEqual([{ server: "local", directory: "/work/proj", on: false, sessionID: "ses_a" }])

    world.folders.clear()
    await palette().onSelect!()
    await tick()
    expect(world.writes.at(-1)).toEqual({ server: "local", directory: "/work/proj", on: true, sessionID: "ses_a" })
    expect(palette().title).toBe(dict["command.permissions.autonomous.disable"])
  })
})
