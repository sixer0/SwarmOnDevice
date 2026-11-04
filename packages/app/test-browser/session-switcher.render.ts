import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { Session } from "@opencode-ai/sdk/v2/client"
import { createComponent, render } from "solid-js/web"
import { createStore } from "solid-js/store"
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

const SERVER = "local\nhttp://localhost:4096"
const session = (id: string, directory: string, updated: number, parentID?: string) =>
  ({ id, directory, parentID, title: `title ${id}`, time: { created: updated, updated } }) as unknown as Session

// The worktree and one sandbox; `grandchild` is a subagent two levels under `root`.
const stores: Record<string, { path: { directory: string }; session: Session[] }> = {
  "/w": {
    path: { directory: "/w" },
    session: [
      session("root", "/w", 3),
      session("child", "/w", 4, "root"),
      session("grandchild", "/w", 5, "child"),
      session("older", "/w", 1),
    ],
  },
  "/s": { path: { directory: "/s" }, session: [session("sandbox", "/s", 2)] },
}
const all = Object.values(stores).flatMap((store) => store.session)
const loaded: string[] = []
const calls: string[] = []
const [tabs, setTabs] = createStore<{ list: { type: "session"; server: string; sessionId: string }[] }>({
  list: [{ type: "session", server: SERVER, sessionId: "older" }],
})
let current = "grandchild"

const realLanguage = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...realLanguage,
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? String(key) }),
}))
mock.module("@/context/server", () => ({ useServer: () => ({ key: SERVER }) }))
mock.module("@/context/server-sync", () => ({
  useServerSync: () => () => ({
    child: (dir: string) => [stores[dir]],
    project: { loadSessions: (dir: string) => void loaded.push(dir) },
  }),
}))
mock.module("@/context/sync", () => ({
  useSync: () => () => ({ session: { get: (id: string) => all.find((item) => item.id === id) } }),
}))
mock.module("@/context/tabs", () => ({
  sessionHasOpenTab: (list: typeof tabs.list, server: string, item: Session) =>
    list.some((tab) => tab.type === "session" && tab.server === server && tab.sessionId === item.id),
  useTabs: () => ({
    get store() {
      return tabs.list
    },
    addSessionTab: (tab: { server: string; sessionId: string }) => {
      calls.push(`add:${tab.sessionId}`)
      const found = tabs.list.find((item) => item.sessionId === tab.sessionId)
      if (found) return found
      const next = { type: "session" as const, ...tab }
      setTabs("list", (list) => [...list, next])
      return next
    },
    select: (tab: { sessionId: string }) => void calls.push(`select:${tab.sessionId}`),
  }),
}))
mock.module("@/pages/session/session-layout", () => ({
  useSessionLayout: () => ({
    params: {
      get id() {
        return current
      },
    },
  }),
}))

const { SessionSwitcher } = await import(
  new URL("../src/components/session/session-switcher.tsx", import.meta.url).pathname
)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
  loaded.length = 0
  calls.length = 0
  setTabs("list", [{ type: "session", server: SERVER, sessionId: "older" }])
  current = "grandchild"
})

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(SessionSwitcher, { variant: "v2", directories: ["/w", "/s"] }), host)
  return host
}

async function openMenu(host: HTMLElement) {
  const trigger = host.querySelector<HTMLElement>(`[aria-label="${dict["session.header.sessions.label"]}"]`)!
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
  trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
  trigger.click()
  await tick(5)
  return [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

const pick = async (item: HTMLElement) => {
  item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
  item.click()
  await tick(5)
}

describe("the session switcher in the header", () => {
  test("lists the project's root sessions newest first, marks the true root and open tabs, and loads each folder", async () => {
    const host = mount()
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(0)

    const items = await openMenu(host)

    expect(loaded).toEqual(["/w", "/s"])
    // Subagent sessions are not listed; the sandbox's root is.
    expect(items.map((item) => item.textContent)).toEqual([
      expect.stringContaining("title root"),
      expect.stringContaining("title sandbox"),
      expect.stringContaining("title older"),
    ])
    // On a grandchild subagent's page the current mark is on the true root, not on its parent (code review m10).
    expect(items[0]!.textContent).toContain(dict["session.header.sessions.current"])
    expect(items[2]!.textContent).toContain(dict["session.header.sessions.open"])
    expect(items[1]!.textContent).not.toContain(dict["session.header.sessions.open"])
  })

  test("choosing a session that is not open opens it in a tab and focuses it", async () => {
    const host = mount()
    const items = await openMenu(host)

    await pick(items[1]!)

    expect(calls).toEqual(["add:sandbox", "select:sandbox"])
    expect(tabs.list.map((tab) => tab.sessionId)).toEqual(["older", "sandbox"])
  })

  test("choosing an open session focuses its tab and adds none", async () => {
    const host = mount()
    const items = await openMenu(host)

    await pick(items[2]!)

    expect(calls).toEqual(["add:older", "select:older"])
    expect(tabs.list).toHaveLength(1)
  })

  test("choosing the current root only closes the menu", async () => {
    const host = mount()
    const items = await openMenu(host)

    await pick(items[0]!)

    expect(calls).toEqual([])
  })
})
