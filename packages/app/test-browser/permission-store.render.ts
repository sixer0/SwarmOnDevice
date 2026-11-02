import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createStore } from "solid-js/store"

type Conn = { scope: string; key: string }
type Listener = (event: unknown) => void

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

const server = {
  listeners: [] as Listener[],
  replies: [] as unknown[],
  conns: createSignal<Conn[]>([{ scope: "local", key: "local" }]),
  sync: undefined as unknown,
}

const fakeSdk = (scope: string) => ({
  scope,
  protocol: Promise.resolve("v2"),
  protocolKind: () => "v2",
  event: {
    listen: (listener: Listener) => {
      server.listeners.push(listener)
      return () => undefined
    },
  },
  api: {
    permission: {
      reply: async (input: unknown) => {
        server.replies.push(input)
      },
      request: { list: async () => ({ data: [] }) },
    },
  },
})

mock.module("@/context/global", () => ({
  useGlobal: () => ({
    servers: { list: () => server.conns[0]() },
    ensureServerCtx: (conn: Conn) => ({ sdk: fakeSdk(conn.scope), sync: server.sync }),
  }),
}))
mock.module("@/context/platform", () => ({ usePlatform: () => ({ platform: "web" }) }))
mock.module("@/context/notification", () => ({
  useNotification: () => ({ ensureServerState: () => ({ session: { unseenCount: () => 0 } }) }),
}))
mock.module("@/context/server", () => ({
  ServerConnection: { key: (conn: Conn) => conn.key },
}))

const { PermissionProvider } = await import("@/context/permission")
const { Persist } = await import("@/utils/persist")
const { useSessionTabAvatarState } = await import("@/pages/layout/project-avatar-state")
const { createPromptAutonomy } = await import("@/components/prompt-input/autonomy")

const LOCAL_KEY = "opencode.global.dat:permission"
const REMOTE_SCOPE = "remote-1"
const storedForm = JSON.stringify({ autoAccept: { "L3dvcmsvcHJvag/*": true, "L3dvcmsvcHJvag/ses_1": true } })

const mount = () =>
  createRoot((dispose) => {
    PermissionProvider({ children: undefined })
    return dispose
  })

// What a server sends when it re-announces a prompt the agent carried on without (ADV-A20).
const askedMovedOn = (id = "per_1", extra: object = {}) => ({
  name: "/work/proj",
  details: {
    type: "permission.asked",
    properties: { id, sessionID: "ses_1", permission: "bash", patterns: ["ls"], movedOnAt: 1, ...extra },
  },
})

beforeEach(() => {
  localStorage.clear()
  server.listeners.length = 0
  server.replies.length = 0
  server.conns[1]([{ scope: "local", key: "local" }])
})

describe("the old preference", () => {
  afterEach(() => localStorage.clear())

  test.each([
    ["a stored true", "true"],
    ["the stored map, with this folder and this session on", storedForm],
  ])("%s is dropped and answers nothing", async (_name, value) => {
    localStorage.setItem(LOCAL_KEY, value)
    const dispose = mount()
    await tick()

    server.listeners.forEach((listener) => listener(askedMovedOn()))
    await tick()

    expect(localStorage.getItem(LOCAL_KEY)).toBeNull()
    expect(server.listeners).toEqual([])
    expect(server.replies).toEqual([])
    dispose()
  })

  test("the older name goes too, and other preferences stay", async () => {
    localStorage.setItem("permission.v3", storedForm)
    localStorage.setItem("opencode.global.dat:settings", "kept")
    const dispose = mount()
    await tick()

    expect(localStorage.getItem("permission.v3")).toBeNull()
    expect(localStorage.getItem("opencode.global.dat:settings")).toBe("kept")
    dispose()
  })

  test("every server's copy goes, including one added later", async () => {
    const remote = `opencode.global.dat:${Persist.serverGlobal(REMOTE_SCOPE as never, "permission").key}`
    localStorage.setItem(remote, "true")
    const dispose = mount()
    await tick()
    expect(localStorage.getItem(remote)).toBe("true")

    server.conns[1]((list) => [...list, { scope: REMOTE_SCOPE, key: REMOTE_SCOPE }])
    await tick()

    expect(localStorage.getItem(remote)).toBeNull()
    dispose()
  })

  test("the mode is what the server says, and the composer never writes it on its own", async () => {
    localStorage.setItem(LOCAL_KEY, "true")
    const writes: unknown[] = []
    const client = {
      autonomy: {
        mode: async () => ({ data: { on: false, externalChange: [] } }),
        session: async () => ({ data: { on: false, open: 0 } }),
        modeUpdate: async (input: unknown) => {
          writes.push(input)
          return { data: { on: true, externalChange: [] } }
        },
      },
    }
    const sdk = { client, event: { on: () => () => undefined } }
    const { on, dispose } = createRoot((dispose) => {
      PermissionProvider({ children: undefined })
      const autonomy = createPromptAutonomy({
        sdk: () => sdk as never,
        sessionID: () => undefined,
        onChanged: () => undefined,
        onFailed: () => undefined,
      })
      return { on: autonomy.on, dispose }
    })
    await tick()
    await tick()

    expect(on()).toBe(false)
    expect(writes).toEqual([])
    dispose()
  })
})

describe("no path left to an automatic answer", () => {
  test("only the four surfaces a person clicks on send a permission reply", async () => {
    const root = new URL("../src/", import.meta.url).pathname
    const senders: string[] = []
    for await (const path of new Bun.Glob("**/*.{ts,tsx}").scan(root)) {
      if (path.includes(".test.")) continue
      if ((await Bun.file(root + path).text()).includes(".permission.reply(")) senders.push(path)
    }
    expect(senders.toSorted()).toEqual([
      "pages/home/agent-board-controller.ts",
      "pages/session/composer/session-composer-state.ts",
      "pages/session/map/session-map-view.tsx",
      "pages/session/swarm/swarm-controller.ts",
    ])
  })

  test("the two emptied files and every caller are gone", async () => {
    const root = new URL("../src/", import.meta.url).pathname
    expect(await Bun.file(root + "context/permission-auto-respond.ts").exists()).toBe(false)
    expect(await Bun.file(root + "context/permission-auto-respond.test.ts").exists()).toBe(false)
    const provider = await Bun.file(root + "context/permission.tsx").text()
    expect(provider).not.toContain("listen")
    expect(provider).not.toContain("reply")
  })
})

describe("what the sidebar and project avatar count", () => {
  const avatar = (requests: object[], working: boolean) => {
    const [data] = createStore({
      permission: { ses_1: requests },
      question: {},
      session_working: () => working,
    })
    server.sync = {
      session: { data },
      child: () => [{ session: [{ id: "ses_1" }] }],
    }
    return createRoot((dispose) => {
      const state = useSessionTabAvatarState(
        () => "local" as never,
        () => "/work/proj",
        () => "ses_1",
      )
      const seen = { unread: state.unread(), loading: state.loading() }
      dispose()
      return seen
    })
  }
  const ask = { id: "per_1", sessionID: "ses_1", permission: "bash", patterns: [] }

  test("a running session with a decision put aside is still working, and asks nothing", () => {
    expect(avatar([{ ...ask, deferred: true }], true)).toEqual({ unread: false, loading: true })
  })

  test("a request really holding the agent still shows", () => {
    expect(avatar([ask], true)).toEqual({ unread: true, loading: false })
  })

  test("the sidebar reads requests through the same rule", async () => {
    const sidebar = await Bun.file(new URL("../src/pages/layout/sidebar-items.tsx", import.meta.url)).text()
    expect(sidebar).toContain("return !item.deferred")
    expect(sidebar).toContain("(item) => !item.deferred,")
  })
})
