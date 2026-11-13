// Swarm 1.2.7 row 27, AC-U4 render half (N7-125; C6, R-5). Run by rel127-u4-feed-order.test.ts in a child process
// (browser conditions + Solid JSX transform), the mission-deliverables.render.ts pattern. happy-dom has no layout:
// this pins the structure (bounded scroll list, newest first, no hidden scrollbar); real scrolling is row 58's live check.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import * as missionModel from "./mission-model"
import { buildMission, type MissionGetWire } from "./mission-model"
import { fixture } from "./mission-deliverables.fixture"

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

const table: Record<string, string> = en
const translate = (key: string, params?: Record<string, string | number>) =>
  (table[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => String(params?.[name] ?? ""))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: translate }) }))

const { MissionCommand } = await import("./mission-command")

// Namespace read: absent at the red base, so the test fails on an assertion, not on the import.
const FEED_VISIBLE_ROWS = (missionModel as Record<string, unknown>).FEED_VISIBLE_ROWS as number | undefined

function withMessages(count: number): MissionGetWire {
  const wire = fixture()
  wire.messages = Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    at: new Date(Date.UTC(2026, 10, 13, 8, i)).toISOString(),
    from: "agent" as const,
    to: "controller" as const,
    kind: "report" as const,
    text: `report ${i + 1}`,
    row: "3",
  }))
  return wire
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(count: number) {
  const host = document.createElement("div")
  document.body.append(host)
  const model = buildMission(withMessages(count), "en")
  dispose = render(
    () =>
      createComponent(MissionCommand, {
        model,
        writer: {
          answer: async () => ({ ok: true, data: { decision: "U1", released: [] } }),
          instruct: async () => ({ ok: true, data: { seq: 1 } }),
        } as never,
        refresh: () => {},
        prompt: async () => undefined,
      }),
    host,
  )
  return host
}

const classes = (el: Element | null | undefined) =>
  new Set((el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))

describe("1.2.7 U-4 mission feed (DOM)", () => {
  test("[data-mission-feed] is a bounded scroll list: inline max-height from FEED_VISIBLE_ROWS, overflow-y-auto, min-h-0", () => {
    const host = mount(12)
    const feed = host.querySelector<HTMLElement>("[data-mission-feed]")!
    expect(feed).not.toBeNull()
    expect(FEED_VISIBLE_ROWS).toBe(10)
    const style = feed.getAttribute("style") ?? ""
    expect(style).toMatch(/max-height:/)
    expect(style).toContain(`${FEED_VISIBLE_ROWS}`)
    for (const c of ["overflow-y-auto", "min-h-0"]) expect(classes(feed).has(c)).toBe(true)
    // the scrollbar stays visible (both scrollbar modes, row 58 live check)
    expect(classes(feed).has("no-scrollbar")).toBe(false)
  })

  test("12 messages give 12 entries, newest first; 60 give 50 (the rest reachable by scrolling, no cut-off at 10)", () => {
    let host = mount(12)
    let items = [...host.querySelectorAll("[data-mission-feed] > li")]
    expect(items.length).toBe(12)
    expect(items[0].textContent).toContain("report 12")
    expect(items.at(-1)!.textContent).toContain("report 1")
    dispose?.()
    document.body.innerHTML = ""
    host = mount(60)
    items = [...host.querySelectorAll("[data-mission-feed] > li")]
    expect(items.length).toBe(50)
    expect(items[0].textContent).toContain("report 60")
    expect(items.at(-1)!.textContent).toContain("report 11")
  })
})
