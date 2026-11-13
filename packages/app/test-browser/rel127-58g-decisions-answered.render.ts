// Swarm 1.2.7 row 58g (C101), render half. Run by rel127-58g-decisions-answered.test.ts.
// happy-dom has no layout, so this pins the structure behind the two live findings; the sizes are row 58's re-check.
// F-11: the Decisions list `[data-map-decisions]` is a flex column and the scroll container. Its accordion child clips
// (`overflow: hidden` in accordion-v2.css), and an overflow-clipping flex item has an automatic minimum height of 0,
// so it shrank to the list's height and cut off the expanded entry's actions while the list itself had nothing to
// scroll. The child must not shrink (`shrink-0`): then the list overflows and scrolls to every action.
// Answered card: once a decision is answered its card leaves the side panel; the answer is the feed entry.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { AutonomyAuditLine } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict } from "@/i18n/en"
import { decisionGroups } from "@/pages/session/map/session-map-model"
import { buildMission } from "@/pages/session/swarm/mission-model"
import { fixture } from "@/pages/session/swarm/mission-deliverables.fixture"

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

// The message parts pull in a Vite worker URL, which Bun cannot load. Nothing drawn here uses them.
mock.module("@opencode-ai/session-ui/message-part", () => ({ getToolInfo: () => ({}) }))
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: keyof typeof dict, params?: Record<string, string>) =>
      dict[key] === undefined ? String(key) : resolveTemplate(dict[key], params ?? {}),
    locale: () => "en",
    intl: () => "en",
  }),
}))
const dialogs = await import("@opencode-ai/ui/context/dialog")
mock.module("@opencode-ai/ui/context/dialog", () => ({
  ...dialogs,
  useDialog: () => ({ show: () => {}, close: () => {} }),
}))

// The real surfaces, not copies. Computed paths keep the views out of this folder's typecheck.
const { MissionCommand } = await import(
  new URL("../src/pages/session/swarm/mission-command.tsx", import.meta.url).pathname
)
const { DecisionList } = await import(
  new URL("../src/pages/session/map/session-map-view.tsx", import.meta.url).pathname
)

const LONG = Array.from({ length: 375 }, (_, i) => `seg${String(i).padStart(4, "0")}-`).join("")
expect(LONG.length).toBe(3000)

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})

function host() {
  const el = document.createElement("div")
  document.body.append(el)
  return el
}
const classes = (el: Element | null | undefined) =>
  new Set((el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))

function decisionsFor(lines: AutonomyAuditLine[]) {
  const [groups] = createSignal(decisionGroups(lines, "root"))
  return {
    store: { state: { externalChange: [], intact: true, lines, rootID: "root", on: true }, failed: false },
    groups,
    consent: () => undefined,
    archive: () => undefined,
    ticked: () => new Set<string>(),
    consentBusy: () => false,
    tick: () => {},
    allowConsent: () => {},
    archiveBusy: () => false,
    emptyArchive: () => {},
    calls: () => [{ tool: "zzr58g_unknown_tool", args: [{ name: "command", value: LONG }] }],
    canAlways: () => true,
    replyBusy: () => false,
    undoBusy: () => false,
    reply: () => {},
    undo: () => {},
    canRetry: () => true,
    retry: () => {},
    refresh: () => {},
    confirm: () => {},
  }
}

describe("1.2.7 row 58g F-11: Decisions list", () => {
  test("an expanded waiting entry with a 3,000-character command: every action sits in the list's scroll area, no clipping child shrinks", () => {
    let seq = 0
    const line = (requestID: string, patterns: string[]) => ({
      v: 1,
      seq: ++seq,
      prev: "",
      at: seq,
      type: "decision",
      rootID: "root",
      sessionID: "root",
      requestID,
      messageID: `msg_${seq}`,
      agent: "build",
      directory: "/repo",
      permission: "zzr58g_unknown_tool",
      patterns,
      patternsTruncated: false,
      class: "D",
      risk: "",
      canUndo: true,
      decidedBy: "gate",
      decision: "defer",
      category: "outward",
      memo: false,
      follows: [],
    })
    const lines = [line("short", ["zzr58g_unknown_tool x"]), line("held", [LONG])] as unknown as AutonomyAuditLine[]
    const el = host()
    dispose = render(() => createComponent(DecisionList, { decisions: decisionsFor(lines), directory: "/repo" }), el)
    const list = el.querySelector<HTMLElement>("[data-map-decisions]")!
    expect(list).not.toBeNull()
    // the list is the scroll container
    for (const c of ["overflow-y-auto", "min-h-0", "flex-col"]) expect(classes(list).has(c)).toBe(true)
    const row = el.querySelector<HTMLElement>('[data-decision="held"]')!
    expect(row).not.toBeNull()
    row.querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!.click()
    const body = row.querySelector("[data-map-decision-body]")!
    const actions = row.querySelector("[data-map-decision-actions]")!
    expect(body).not.toBeNull()
    expect(actions).not.toBeNull()
    expect(body.contains(actions)).toBe(false)
    expect(list.contains(actions)).toBe(true)
    const labels = [...actions.querySelectorAll("button")].map((b) => b.textContent?.trim())
    const text = (key: string) => (dict as Record<string, string>)[key] ?? key
    // Allow and continue, Always allow in this session, Deny, Hide details: all four in the actions container.
    for (const key of [
      "session.movedOn.allow",
      "session.movedOn.alwaysInSession",
      "ui.permission.deny",
      "session.map.decisions.details.hide",
    ])
      expect(labels).toContain(text(key))
    expect(actions.querySelectorAll("button").length).toBe(4)
    // No scroll container between the actions and the list other than the list itself; and the list's child that
    // holds them (the clipping accordion) keeps its content height, so the overflow reaches the list.
    let child: Element = actions
    while (child.parentElement && child.parentElement !== list) child = child.parentElement
    expect(child.parentElement).toBe(list)
    expect(child.getAttribute("data-component")).toBe("accordion-v2")
    expect(classes(child).has("shrink-0")).toBe(true)
    for (let node = actions.parentElement; node && node !== list; node = node.parentElement)
      expect(classes(node).has("overflow-y-auto") && node !== body).toBe(false)
  })
})

describe("1.2.7 row 58g: answered decision", () => {
  const mount = (wire: ReturnType<typeof fixture>) => {
    const el = host()
    dispose = render(
      () =>
        createComponent(MissionCommand, {
          model: buildMission(wire, "en"),
          writer: { answer: async () => ({ ok: false }), instruct: async () => ({ ok: false }) } as never,
          refresh: () => {},
          prompt: async () => undefined,
        }),
      el,
    )
    return el
  }

  test("no open decision, one answered with a long label: no card in the side panel, the answer is a feed entry", () => {
    const wire = fixture()
    const label = `Rev B ${LONG.slice(0, 400)}`
    wire.requests = [
      {
        id: "D-2",
        question: `Pick a revision ${LONG.slice(0, 300)}`,
        options: [
          { id: "A", label: "Rev A", consequence: "Keeps the form" },
          { id: "B", label, consequence: "Needs review" },
        ],
        recommended: "A",
        status: "answered",
        createdAt: "2026-11-13T08:00:00Z",
        closedAt: "2026-11-13T08:05:00Z",
        answer: { option: "B", by: "user", decision: "U9" },
      },
    ] as never
    const el = mount(wire)
    expect(el.querySelector("[data-mission-answered]")).toBeNull()
    expect(el.querySelector("[data-mission-decision]")).toBeNull()
    expect(el.textContent).not.toContain("Pick a revision")
    const feed = el.querySelector("[data-mission-feed]")!
    expect(feed).not.toBeNull()
    expect(feed.textContent).toContain(`D-2: ${label}`)
  })

  test("an open decision still shows its card next to an answered one", () => {
    const wire = fixture()
    wire.requests = [
      {
        id: "D-1",
        question: "Scope?",
        options: [{ id: "a", label: "Narrow", consequence: "" }],
        status: "answered",
        createdAt: "2026-11-13T07:00:00Z",
        closedAt: "2026-11-13T07:30:00Z",
        answer: { option: "a", by: "user", decision: "U8" },
      },
      {
        id: "D-3",
        question: "Keep legacy support?",
        options: [
          { id: "a", label: "Adapter", consequence: "+1 task" },
          { id: "b", label: "Defer", consequence: "smaller" },
        ],
        recommended: "a",
        status: "open",
        createdAt: "2026-11-13T08:00:00Z",
      },
    ] as never
    const el = mount(wire)
    expect(el.querySelector("[data-mission-decision]")).not.toBeNull()
    expect(el.querySelectorAll("[data-mission-option]").length).toBe(2)
    expect(el.querySelector("[data-mission-answered]")).toBeNull()
    expect(el.querySelector("[data-mission-feed]")!.textContent).toContain("D-1: Narrow")
  })
})
