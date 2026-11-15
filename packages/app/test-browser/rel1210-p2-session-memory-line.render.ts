import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as uiDict } from "@opencode-ai/ui/i18n/en"
import type { SessionComposerRegionController } from "@/pages/session/composer/session-composer-region-controller"

// 1.2.10 row 47 (AC-P2a, AC-P2b, AC-P2c, T7 of AC-P2d; spec 01b section 2): the project memory line stays on the
// session page, under the composer, for the whole session. Counts and booleans only (C77): a failing expect on an
// element can hang bun while it prints the element.

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

// The same translator the app builds (context/language.tsx): flattened app + ui dictionaries, templates resolved.
const translate = i18n.translator(() => i18n.flatten({ ...dict, ...uiDict }), i18n.resolveTemplate) as (
  key: string,
  params?: Record<string, string | number | boolean>,
) => string
const realLanguage = await import("@/context/language")
mock.module("@/context/language", () => ({ ...realLanguage, useLanguage: () => ({ t: translate }) }))

const realRouter = await import("@solidjs/router")
mock.module("@solidjs/router", () => ({ ...realRouter, useParams: () => ({ id: "s1" }) }))

const [newLayout, setNewLayout] = createSignal(true)
const realSettings = await import("@/context/settings")
mock.module("@/context/settings", () => ({
  ...realSettings,
  useSettings: () => ({ general: { newLayoutDesigns: newLayout } }),
}))

// The sdk records every memory read, keeps each event handler by name and counts the unsubscribes.
type Item = Record<string, unknown>
const store: { items: Item[]; gets: number; off: number; handlers: Map<string, (event: unknown) => void> } = {
  items: [],
  gets: 0,
  off: 0,
  handlers: new Map(),
}
const sdk = {
  directory: "/tmp/syn-p2",
  client: {
    memory: {
      get: async () => {
        store.gets++
        return { data: { enabled: true, items: [...store.items] } }
      },
      add: async () => ({ data: {} }),
      remove: async () => ({ data: true }),
      update: async () => ({ data: {} }),
      settings: async () => ({ data: true }),
    },
  },
  event: {
    on: (name: string, handler: (event: unknown) => void) => {
      store.handlers.set(name, handler)
      return () => {
        store.off++
      }
    },
  },
}
const realSdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...realSdk, useSDK: () => () => sdk }))

// The docks need contexts of their own (sync, server, platform). The region's Show conditions read the controller, not
// the docks, so each dock is one marker element here (01b A4).
const stub = (name: string) => () => {
  const element = document.createElement("div")
  element.setAttribute("data-stub", name)
  return element
}
for (const [path, name] of [
  ["@/pages/session/composer/session-trust-dock", "SessionTrustDock"],
  ["@/pages/session/composer/session-question-dock", "SessionQuestionDock"],
  ["@/pages/session/composer/session-permission-dock", "SessionPermissionDock"],
  ["@/pages/session/composer/session-followup-dock", "SessionFollowupDock"],
  ["@/pages/session/composer/session-moved-on-dock", "SessionMovedOnDock"],
  ["@/pages/session/composer/session-repeat-dock", "SessionRepeatDock"],
  ["@/pages/session/composer/session-revert-dock", "SessionRevertDock"],
  ["@/pages/session/composer/session-todo-dock", "SessionTodoDock"],
] as const) {
  mock.module(path, () => ({ [name]: stub(name) }))
}

const { DialogProvider } = await import("@opencode-ai/ui/context/dialog")
const { SessionComposerRegion } = await import(
  new URL("../src/pages/session/composer/session-composer-region.tsx", import.meta.url).pathname
)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// A hand-built controller with the shape of createSessionComposerRegionController (prompt-input.stories.tsx).
function controller() {
  const [blocked, setBlocked] = createSignal(false)
  const [question, setQuestion] = createSignal<{ id: string } | undefined>()
  const [permission, setPermission] = createSignal<{ id: string } | undefined>()
  const [parentID, setParentID] = createSignal<string | undefined>()
  const [dock, setDock] = createSignal(false)
  const [progress, setProgress] = createSignal(0)
  const [todos, setTodos] = createSignal<{ content: string; status: string }[]>([])
  const [followup, setFollowup] = createSignal<{ items: { id: string; text: string }[] } | undefined>()
  const [ready, setReady] = createSignal(true)
  const value = {
    state: {
      blocked,
      questionRequest: question,
      permissionRequest: permission,
      permissionResponding: () => false,
      decide: () => {},
      todos,
      dock,
      movedOn: () => [],
      responding: undefined,
      allowMovedOn: () => {},
      answerMovedOn: () => {},
      leaveMovedOn: () => {},
    },
    centered: () => true,
    todo: { collapsed: () => false, onToggle: () => {} },
    followup: () => {
      const current = followup()
      return current ? { ...current, onSend: () => {}, onEdit: () => {} } : undefined
    },
    revert: () => undefined,
    onResponseSubmit: () => {},
    openParent: () => {},
    setPromptRef: () => {},
    setDockRef: () => {},
    parentID,
    child: () => !!parentID(),
    showComposer: () => !blocked() || !!parentID(),
    handoffPrompt: () => undefined,
    promptReady: ready,
    dock: () => dock() || progress() > 0.001,
    dockProgress: progress,
    dockHeight: () => 78,
    lift: () => 36 * progress(),
    setDockBodyRef: () => {},
  }
  return {
    value: value as unknown as SessionComposerRegionController,
    set: { setBlocked, setQuestion, setPermission, setParentID, setDock, setProgress, setTodos, setFollowup, setReady },
  }
}

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
  store.items = []
  store.gets = 0
  store.off = 0
  store.handlers.clear()
  setNewLayout(true)
})

async function mount(control = controller()) {
  const host = document.createElement("div")
  document.body.append(host)
  const prompt = document.createElement("div")
  prompt.setAttribute("data-stub", "prompt")
  dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          return createComponent(SessionComposerRegion, { controller: control.value, promptInput: prompt })
        },
      }),
    host,
  )
  await tick(20)
  return { ...control, prompt }
}

const dockSelector = '[data-component="session-prompt-dock"]'
const lineSelector = `${dockSelector} [data-action="project-memory"]`
const lines = () => document.querySelectorAll(lineSelector).length
const line = () => document.querySelector(lineSelector)
const lineText = () => line()?.textContent ?? ""

const note = (id: string, extra: Item = {}): Item => ({
  id,
  text: `syn note ${id}`,
  source: "agent",
  deviceOnly: false,
  time: 1,
  ...extra,
})
const threeItems = () => [
  note("n1"),
  note("n2"),
  note("i1", { kind: "index", missionId: "syn-mission", text: "2026-11-15 | syn mission | done" }),
]

function insideRaised(element: Element | null) {
  for (let current = element?.parentElement; current; current = current.parentElement) {
    if (current.classList.contains("z-[70]")) return true
  }
  return false
}

describe("AC-P2a the memory line on the session page", () => {
  test("T1 shows the same line with all items counted, in the new and the old layout", async () => {
    for (const layout of [true, false]) {
      store.items = threeItems()
      setNewLayout(layout)
      await mount()
      expect(lines()).toBe(1)
      expect(lineText().includes(translate("memory.title"))).toBe(true)
      expect(lineText().includes("3")).toBe(true)
      ;(line() as HTMLElement | null)?.click()
      await tick(20)
      expect(document.querySelectorAll("[data-memory-add]").length > 0).toBe(true)
      dispose()
      dispose = () => {}
      document.body.innerHTML = ""
    }
  })

  test("T2 (CHAR) no items: no line, as on the new-session screen", async () => {
    await mount()
    expect(lines()).toBe(0)
  })
})

describe("AC-P2b visible for the whole session", () => {
  test("T3 stays while a permission or a question is open, and is the same node after the answer", async () => {
    store.items = threeItems()
    const permission = controller()
    permission.set.setPermission({ id: "per1" })
    permission.set.setBlocked(true)
    await mount(permission)
    expect(lines()).toBe(1)
    const before = line()
    permission.set.setPermission(undefined)
    permission.set.setBlocked(false)
    await tick(20)
    expect(lines()).toBe(1)
    expect(before !== null && line() === before).toBe(true)
    dispose()
    dispose = () => {}
    document.body.innerHTML = ""

    const question = controller()
    question.set.setQuestion({ id: "que1" })
    question.set.setBlocked(true)
    await mount(question)
    expect(lines()).toBe(1)
  })

  test("T4 stays in a child session", async () => {
    store.items = threeItems()
    const child = controller()
    child.set.setParentID("parent-session")
    await mount(child)
    expect(lines()).toBe(1)
  })

  test("T5 stays with the todo dock, a queued follow-up and the loading prompt, never under the raised prompt", async () => {
    const cases: ((set: ReturnType<typeof controller>["set"]) => void)[] = [
      (set) => {
        set.setDock(true)
        set.setProgress(1)
        set.setTodos([{ content: "syn todo", status: "in_progress" }])
      },
      (set) => set.setFollowup({ items: [{ id: "f1", text: "syn follow-up" }] }),
      (set) => set.setReady(false),
    ]
    for (const apply of cases) {
      store.items = threeItems()
      const control = controller()
      apply(control.set)
      await mount(control)
      expect(lines()).toBe(1)
      expect(insideRaised(line())).toBe(false)
      dispose()
      dispose = () => {}
      document.body.innerHTML = ""
    }
  })
})

describe("AC-P2c the count follows memory.updated without a reload", () => {
  test("T6 one read at mount, a re-read per event, updated in place, no listener left", async () => {
    store.items = threeItems()
    await mount()
    expect(store.gets).toBe(1)
    const handler = store.handlers.get("memory.updated")
    expect(typeof handler).toBe("function")
    const before = line()

    store.items = [...store.items, note("n3")]
    handler?.({ properties: {} })
    await tick(20)
    expect(lineText().includes("4")).toBe(true)
    expect(store.gets).toBe(2)
    expect(before !== null && line() === before).toBe(true)

    store.items = store.items.slice(1)
    handler?.({ properties: {} })
    await tick(20)
    expect(lineText().includes("3")).toBe(true)
    expect(store.gets).toBe(3)

    dispose()
    dispose = () => {}
    expect(store.off).toBe(1)
  })
})

describe("AC-P2d (unit half) no new panel", () => {
  test("T7 the line is the column's last child, after the prompt, with no new data-component", async () => {
    // The line's own icon carries data-component="icon" (ui Icon); the set compares what the region adds around it.
    const components = () =>
      [...document.querySelectorAll(`${dockSelector}, ${dockSelector} [data-component]`)]
        .filter((element) => !element.closest('[data-action="project-memory"]'))
        .map((element) => element.getAttribute("data-component"))
        .sort()
        .join(",")
    await mount()
    const without = components()
    dispose()
    dispose = () => {}
    document.body.innerHTML = ""

    store.items = threeItems()
    const { prompt } = await mount()
    const column = document.querySelector(dockSelector)?.firstElementChild
    const current = line()
    expect(!!current && !!column?.lastElementChild?.contains(current)).toBe(true)
    expect(!!current && (prompt.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0).toBe(true)
    expect(components() === without).toBe(true)
  })
})
