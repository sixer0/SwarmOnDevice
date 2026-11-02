import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { MemoryRouter, Route, createMemoryHistory } from "@solidjs/router"
import { createComponent, render } from "solid-js/web"
import { createRoot } from "solid-js"
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
  writes: [] as Call[],
  reads: [] as string[],
  tabs: [] as { type: string; draftID?: string; server?: string; directory?: string }[],
  servers: ["local", "remote"],
  pathname: { value: "/", search: "" },
}
const autonomyOf = (server: string, directory: string) => ({
  mode: async () => {
    world.reads.push(`${server}:${directory}`)
    return { data: { on: world.folders.has(`${server}:${directory}`) } }
  },
  session: async () => ({ data: { on: false, open: 0 } }),
  modeUpdate: async (input: { on: boolean; sessionID?: string }) => {
    world.writes.push({ server, directory, on: input.on, sessionID: input.sessionID })
    if (input.on) world.folders.add(`${server}:${directory}`)
    if (!input.on) world.folders.delete(`${server}:${directory}`)
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
await override("@/context/server", {
  useServer: () => partly({ key: "local", list: [] }),
  ServerConnection: { key: (conn: { key: string }) => conn.key },
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

// The real dialog and the real composer read, not pieces of them. The computed path keeps the dialog out of this
// folder's typecheck, which reads `import.meta.env` differently from the app's own.
const { DialogSettings } = await import(
  new URL("../src/components/settings-v2/dialog-settings-v2.tsx", import.meta.url).pathname
)
const { createPromptAutonomy } = await import("@/components/prompt-input/autonomy")

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const row = () => document.querySelector<HTMLElement>('[data-action="settings-autonomous-mode"]')!
const input = () => row().querySelector<HTMLInputElement>("input")!
const reason = () => document.body.textContent

let dispose = () => {}

async function mount(pathname: string, search = "") {
  world.pathname = { value: pathname, search }
  const history = createMemoryHistory()
  history.set({ value: `${pathname}${search}`, scroll: false, replace: true })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(MemoryRouter, {
        history,
        root: () => createComponent(DialogSettings, {}),
        get children() {
          return createComponent(Route, { path: "*", component: nothing })
        },
      }),
    host,
  )
  await tick()
}

beforeEach(() => {
  world.folders = new Set()
  world.writes = []
  world.reads = []
  world.tabs.length = 0
  world.servers = ["local", "remote"]
})
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

describe("the autonomous row on a draft (F6)", () => {
  test("a draft with a folder is on offer and writes that folder's level on the draft's server", async () => {
    world.tabs.push({ type: "draft", draftID: "d1", server: "remote", directory: "/work/proj" })
    await mount("/new-session", "?draftId=d1")
    expect(input().disabled).toBe(false)
    expect(reason()).not.toContain(dict["settings.general.row.autonomous.disabledReason"])
    expect(world.reads).toEqual(["remote:/work/proj"])

    input().click()
    await tick()
    expect(world.writes).toEqual([{ server: "remote", directory: "/work/proj", on: true, sessionID: undefined }])
    expect(input().checked).toBe(true)
  })

  test("the add menu's read sees what the row wrote, and the row reads what the menu wrote", async () => {
    world.tabs.push({ type: "draft", draftID: "d1", server: "remote", directory: "/work/proj" })
    await mount("/new-session", "?draftId=d1")
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

    input().click()
    await tick(320)
    expect(composer.on()).toBe(true)

    await composer.toggle()
    expect(world.writes.at(-1)).toEqual({ server: "remote", directory: "/work/proj", on: false, sessionID: undefined })
    expect(world.writes.map((call) => call.directory)).toEqual(["/work/proj", "/work/proj"])
    dispose()
    document.body.innerHTML = ""
    await mount("/new-session", "?draftId=d1")
    expect(input().checked).toBe(false)
  })

  test("Home without a folder stays off, says why, and never reaches a server", async () => {
    await mount("/")
    expect(input().disabled).toBe(true)
    expect(reason()).toContain(dict["settings.general.row.autonomous.disabledReason"])
    input().click()
    await tick()
    expect(world.reads).toEqual([])
    expect(world.writes).toEqual([])
  })

  test("a draft whose server has gone stays off rather than writing to the selected server", async () => {
    world.tabs.push({ type: "draft", draftID: "d1", server: "gone", directory: "/work/proj" })
    await mount("/new-session", "?draftId=d1")
    expect(input().disabled).toBe(true)
    expect(reason()).toContain(dict["settings.general.row.autonomous.disabledReason"])
    expect(world.reads).toEqual([])
    expect(world.writes).toEqual([])
  })
})
