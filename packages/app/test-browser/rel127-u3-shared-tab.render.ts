// 1.2.7 U-3 (AC-U3, N7-086): the real Activity panel (SessionMapPanel) with the real session-map controller and a fake
// swarm controller whose model holds one file changed by two agents (built by the real `findOverlaps`). Run by
// rel127-u3-shared-tab.test.ts in its own process.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createRoot, createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"

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

const table: Record<string, string> = dict
mock.module("@opencode-ai/session-ui/message-part", () => ({ getToolInfo: () => ({}) }))
const language = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...language,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params?.[name] ?? "")),
    locale: () => "en",
    intl: () => "en-US",
  }),
}))
const dialogs = await import("@opencode-ai/ui/context/dialog")
mock.module("@opencode-ai/ui/context/dialog", () => ({ ...dialogs, useDialog: () => ({ show: () => {}, close: () => {} }) }))
const platform = await import("@/context/platform")
mock.module("@/context/platform", () => ({ ...platform, usePlatform: () => ({ platform: "web" }) }))
// No run root is set, so the Decisions part of the panel never calls the server; it only subscribes to events.
const sdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...sdk, useSDK: () => () => ({ event: { on: () => () => {} }, client: {} }) }))
const sync = await import("@/context/server-sync")
mock.module("@/context/server-sync", () => ({
  ...sync,
  useServerSync: () => () => ({ session: { data: { info: {}, permission: {}, session_status: {} } } }),
}))

// Computed paths keep the views out of this folder's typecheck (same as decision-history.render.ts).
const { SessionMapPanel } = await import(
  new URL("../src/pages/session/map/session-map-view.tsx", import.meta.url).pathname
)
const { createSessionMap } = await import(
  new URL("../src/pages/session/map/session-map-controller.ts", import.meta.url).pathname
)
const { findOverlaps } = await import(new URL("../src/pages/session/swarm/swarm-model.ts", import.meta.url).pathname)

// Two agents each changed src/shared.ts with an edit (synthetic, no real session content).
const lane = (id: string, at: number) => ({
  id,
  title: id,
  session: { directory: "/repo" },
  model: {
    steps: [{ id: `${id}-s1`, tool: "edit", start: at, end: at + 1, files: [{ path: "/repo/src/shared.ts" }] }],
  },
})
const overlaps = findOverlaps([lane("coder-a", 10), lane("coder-b", 20)] as never)
const totals = { agents: 2, needs: 0, active: 0, failed: 0, problems: 0, cost: 0 }
const modelWith = (list: unknown[]) => ({ lanes: [], overlaps: list, axis: {}, totals })

const stub = {
  sessionID: () => undefined,
  messages: () => [],
  parts: () => [],
  revertMessageID: () => undefined,
  historyMore: () => false,
  historyLoading: () => false,
  loadOlder: async () => {},
  reveal: () => {},
  visibleTurn: () => undefined,
}

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})

const q = (selector: string) => document.querySelector<HTMLElement>(selector)
const qa = (selector: string) => [...document.querySelectorAll<HTMLElement>(selector)]

function mount(initial: unknown[]) {
  const [model, setModel] = createSignal<unknown>(modelWith(initial))
  const swarm = {
    rootID: () => undefined,
    model,
    pulse: () => ({ agents: 2, needs: 0 }),
    view: { discoverFailed: false, failed: {}, folded: true },
    selectedLane: () => undefined,
    retry: () => {},
    check: () => {},
  }
  const host = document.createElement("div")
  document.body.append(host)
  let map: { view: { filter: string }; setFilter: (filter: string) => void } | undefined
  dispose = render(() => {
    map = createSessionMap(stub)
    return createComponent(SessionMapPanel, {
      map,
      swarm,
      directory: "/repo",
      onAsk: () => {},
      onRewind: () => {},
      onClose: () => {},
    })
  }, host)
  return { map: map!, setModel }
}

describe("1.2.7 U-3 Shared files entry", () => {
  test("fixture: findOverlaps gives exactly one shared file", () => {
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]!.path).toBe("src/shared.ts")
  })

  test("the Agents view no longer holds the block; the strip offers Shared files 1 in warning tone", () => {
    const { map } = mount(overlaps)
    q('[data-map-filter="agents"]')!.click()
    expect(map.view.filter).toBe("agents")
    expect(q('[data-component="session-swarm"]')).not.toBeNull()
    expect(q('[data-component="session-swarm"] [data-swarm-overlap]')).toBeNull()
    expect(qa("[data-swarm-overlap]")).toHaveLength(0)

    const entry = q('[data-map-filter="shared"]')
    expect(entry).not.toBeNull()
    expect(entry!.textContent).toBe(`${dict["session.map.filter.shared"]}1`)
    expect(entry!.querySelector("span")!.className).toContain("!text-v2-state-fg-warning")
    // One strip, one more entry in it: no second tab strip.
    expect(qa('[role="group"]')).toHaveLength(1)
    expect(entry!.parentElement).toBe(q('[data-map-filter="agents"]')!.parentElement)
  })

  test("selecting it renders exactly one shared file with its check action, in a scrolling body", () => {
    const { map } = mount(overlaps)
    q('[data-map-filter="shared"]')!.click()
    expect(map.view.filter).toBe("shared")
    expect(q('[data-map-filter="shared"]')!.getAttribute("aria-pressed")).toBe("true")
    const rows = qa("[data-swarm-overlap]")
    expect(rows).toHaveLength(1)
    expect(rows[0]!.getAttribute("data-swarm-overlap")).toBe("src/shared.ts")
    expect(rows[0]!.textContent).toContain(dict["session.swarm.overlap.check"])
    expect(rows[0]!.textContent).toContain(dict["session.swarm.overlap.title"])
    expect(q('[data-component="session-swarm"]')).toBeNull()
    expect(q("[data-map-search]")).toBeNull()
    const body = rows[0]!.parentElement!
    expect(body.hasAttribute("data-scrollable")).toBe(true)
    expect(body.className).toContain("overflow-y-auto")
    expect(body.className).toContain("min-h-0")
  })

  test("zero overlaps: no Shared files entry", () => {
    mount([])
    expect(q('[data-map-filter="agents"]')).not.toBeNull()
    expect(q('[data-map-filter="shared"]')).toBeNull()
  })

  test("the view falls back to All when the count drops to 0", () => {
    const { map, setModel } = mount(overlaps)
    q('[data-map-filter="shared"]')!.click()
    expect(map.view.filter).toBe("shared")
    setModel(modelWith([]))
    expect(map.view.filter).toBe("all")
    expect(q('[data-map-filter="shared"]')).toBeNull()
    expect(q("[data-map-search]")).not.toBeNull()
  })

  test("leaving for another view keeps the entry while the swarm model is not built", () => {
    const { map, setModel } = mount(overlaps)
    q('[data-map-filter="edits"]')!.click()
    setModel(undefined)
    expect(map.view.filter).toBe("edits")
    expect(q('[data-map-filter="shared"]')).not.toBeNull()
  })
})
