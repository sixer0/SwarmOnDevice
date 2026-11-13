// Swarm 1.2.7 row 58a (C91), F-2 / F-3 render half. Run by rel127-f1f3-feed-decision.test.ts in a child process
// (browser conditions + Solid JSX transform), the rel127-u4-feed-order.render.ts pattern. happy-dom has no layout:
// this pins the structure that makes the panel's flex sizing work (see the layout contract in mission-command.tsx);
// the sizes (about 10 entries where the panel has room, actions on screen at 1280x800 and 1024x640) are live checks.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { buildMission, FEED_VISIBLE_ROWS, type MissionGetWire } from "./mission-model"
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

const LONG = "alfa bravo charlie delta echo foxtrot ".repeat(30)

/** The L-4 / L-5a shape: `count` messages and an open decision with a long question and context. */
function wire(count: number, decision = true): MissionGetWire {
  const out = fixture()
  out.messages = Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    at: "2026-11-13T08:00:00.000Z",
    from: "agent" as const,
    to: "controller" as const,
    kind: "report" as const,
    text: `msg ${i + 1}`,
    row: "3",
  }))
  out.requests = decision
    ? [
        {
          id: "D-3",
          question: `Kilo or Lima? ${LONG}`,
          context: LONG.slice(0, 300),
          options: [
            { id: "K", label: "Kilo", consequence: "mike" },
            { id: "L", label: "Lima", consequence: "november" },
          ],
          recommended: "K",
          status: "open",
          createdAt: "2026-11-13T08:00:00Z",
        },
      ]
    : []
  return out
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

/** Mounted inside a stand-in for `[data-mission-side]` (the flex column panel). */
function mount(count: number, decision = true) {
  const panel = document.createElement("aside")
  panel.setAttribute("data-mission-side", "")
  document.body.append(panel)
  dispose = render(
    () =>
      createComponent(MissionCommand, {
        model: buildMission(wire(count, decision), "en"),
        writer: {
          answer: async () => ({ ok: true, data: { decision: "U1", released: [] } }),
          instruct: async () => ({ ok: true, data: { seq: 1 } }),
        } as never,
        refresh: () => {},
        prompt: async () => undefined,
      }),
    panel,
  )
  return panel
}

const classes = (el: Element | null | undefined) =>
  new Set((el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))
const scrolls = (el: Element) => [...classes(el)].some((c) => /^overflow(-y)?-(auto|scroll)$/.test(c))
/** Elements strictly between `el` and `top`. */
function between(el: Element, top: Element) {
  const out: Element[] = []
  for (let at = el.parentElement; at && at !== top; at = at.parentElement) out.push(at)
  return out
}

describe("1.2.7 row 58a F-2: one scroll container for the feed", () => {
  test("the feed is a direct flex item of the panel: its wrappers are display: contents and do not scroll", () => {
    const panel = mount(28)
    const feed = panel.querySelector("[data-mission-feed]")!
    expect(feed).not.toBeNull()
    expect(feed.querySelectorAll(":scope > li").length).toBe(28)
    const wrappers = between(feed, panel)
    expect(wrappers.map((el) => el.hasAttribute("data-mission-command-card") || el.hasAttribute("data-mission-command"))).toEqual([true, true])
    for (const el of wrappers) {
      expect(classes(el).has("contents")).toBe(true)
      expect(scrolls(el)).toBe(false)
    }
    // the only scroll container on the way from an entry to the panel is the feed itself
    const entry = feed.querySelector(":scope > li")!
    expect(between(entry, panel).filter(scrolls)).toEqual([feed])
  })

  test("the feed shrinks to the panel's remaining height: shrink, min-h-0, max FEED_VISIBLE_ROWS entries, a two-entry floor", () => {
    let feed = mount(28).querySelector<HTMLElement>("[data-mission-feed]")!
    for (const c of ["overflow-y-auto", "min-h-0", "shrink", "flex-col"]) expect(classes(feed).has(c)).toBe(true)
    expect(classes(feed).has("shrink-0")).toBe(false)
    expect(classes(feed).has("no-scrollbar")).toBe(false)
    const style = feed.getAttribute("style") ?? ""
    expect(style).toMatch(new RegExp(`max-height:\\s*calc\\(${FEED_VISIBLE_ROWS} \\* \\(2lh \\+ 0\\.25rem\\)\\)`))
    expect(style).toMatch(/min-height:\s*calc\(2 \* \(2lh \+ 0\.25rem\)\)/)
    dispose?.()
    document.body.innerHTML = ""
    // one entry: the floor is one entry, so a short feed adds no empty space
    feed = mount(1).querySelector<HTMLElement>("[data-mission-feed]")!
    expect(feed.getAttribute("style") ?? "").toMatch(/min-height:\s*calc\(1 \* \(2lh \+ 0\.25rem\)\)/)
  })

  test("every other direct item of the panel keeps its content height (no second shrinking list)", () => {
    const panel = mount(28, false)
    const feed = panel.querySelector("[data-mission-feed]")!
    // flex items of the panel = children of the display: contents wrappers
    const card = panel.querySelector("[data-mission-command-card]")!
    for (const item of [...card.children]) {
      if (item === feed) continue
      expect(scrolls(item)).toBe(false)
      expect(classes(item).has("shrink")).toBe(false)
    }
  })
})

describe("1.2.7 row 58a F-3: the decision actions stay inside the panel", () => {
  test("the card is capped at the panel height and does not shrink; the body shrinks first; actions keep their height", () => {
    const panel = mount(28)
    const card = panel.querySelector("[data-mission-decision]")!
    expect(card).not.toBeNull()
    // a direct flex item of the panel (its only wrapper is display: contents)
    expect(between(card, panel).every((el) => classes(el).has("contents"))).toBe(true)
    for (const c of ["max-h-full", "shrink-0", "flex", "flex-col", "min-w-0"]) expect(classes(card).has(c)).toBe(true)
    const body = card.querySelector("[data-mission-decision-body]")!
    for (const c of ["shrink", "min-h-0", "overflow-y-auto"]) expect(classes(body).has(c)).toBe(true)
    expect(classes(body).has("shrink-0")).toBe(false)
    expect([...classes(body)].some((c) => c.startsWith("max-h-"))).toBe(true)
    const actions = card.querySelector("[data-mission-decision-actions]")!
    expect(actions.parentElement === card).toBe(true)
    expect(body.contains(actions)).toBe(false)
    expect(actions.contains(body)).toBe(false)
    expect(body.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(classes(actions).has("shrink-0")).toBe(true)
    expect(scrolls(actions)).toBe(false)
  })

  test("the answer buttons wrap: a wrapping row of buttons that grow from 8rem, not full-width stacked", () => {
    const actions = mount(28).querySelector("[data-mission-decision-actions]")!
    for (const c of ["flex", "flex-wrap", "min-w-0"]) expect(classes(actions).has(c)).toBe(true)
    expect(classes(actions).has("flex-col")).toBe(false)
    const buttons = [...actions.querySelectorAll("[data-mission-option]")]
    expect(buttons.map((b) => b.getAttribute("data-mission-option"))).toEqual(["K", "L"])
    for (const button of buttons) {
      expect(classes(button).has("flex-[1_1_8rem]")).toBe(true)
      expect(classes(button).has("min-w-0")).toBe(true)
      expect(classes(button).has("w-full")).toBe(false)
    }
  })
})
