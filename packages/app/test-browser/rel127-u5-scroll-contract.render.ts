// Swarm 1.2.7 row 27, AC-U5 render half (N7-088; C6, D-11, SR7-14). Run by rel127-u5-scroll-contract.test.ts.
// happy-dom has no layout: this pins the structure of the one scroll rule (a bounded body that scrolls with a visible
// scrollbar, the actions a sibling outside it). Real scrolling and the overflow cue toggling are row 58's live checks.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
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
const { SessionPermissionDock } = await import(
  new URL("../src/pages/session/composer/session-permission-dock.tsx", import.meta.url).pathname
)
const { DecisionList } = await import(
  new URL("../src/pages/session/map/session-map-view.tsx", import.meta.url).pathname
)

// Synthetic 3,000-character bodies.
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
const hasMaxH = (el: Element | null | undefined) => [...classes(el)].some((c) => c.startsWith("max-h-"))
const follows = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)

/** The text of the first top-level `selector {` block in `css`, braces balanced. */
function block(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return ""
  let depth = 0
  for (let i = css.indexOf("{", start); i < css.length; i++) {
    if (css[i] === "{") depth++
    if (css[i] === "}" && --depth === 0) return css.slice(start, i + 1)
  }
  return ""
}

describe("1.2.7 U-5 surface 1: mission decision card", () => {
  test("[data-mission-decision-body] is bounded and scrolls; [data-mission-decision-actions] holds every option, after and outside it", () => {
    const wire = fixture()
    wire.requests = [
      {
        id: "D-7",
        question: `Pick a revision ${LONG.slice(0, 200)}`,
        context: LONG,
        options: [
          { id: "A", label: "Rev A", consequence: "Keeps the form" },
          { id: "B", label: "Rev B", consequence: "Needs review" },
          { id: "C", label: "Rev C", consequence: "Starts over" },
        ],
        recommended: "A",
        status: "open",
        createdAt: "2026-11-13T08:00:00Z",
      },
    ]
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
    const card = el.querySelector("[data-mission-decision]")!
    expect(card).not.toBeNull()
    const body = card.querySelector("[data-mission-decision-body]")!
    expect(body).not.toBeNull()
    for (const c of ["overflow-y-auto", "min-h-0"]) expect(classes(body).has(c)).toBe(true)
    expect(hasMaxH(body)).toBe(true)
    expect(classes(body).has("no-scrollbar")).toBe(false)
    expect(body.querySelector("[data-mission-context]")?.textContent).toBe(LONG)
    expect(body.querySelector("[data-mission-question]")).not.toBeNull()
    const actions = card.querySelector("[data-mission-decision-actions]")!
    expect(actions).not.toBeNull()
    expect(body.contains(actions)).toBe(false)
    expect(actions.contains(body)).toBe(false)
    expect(follows(body, actions)).toBe(true)
    expect(actions.querySelectorAll("[data-mission-option]").length).toBe(3)
    expect(card.querySelectorAll("[data-mission-option]").length).toBe(3)
    expect(body.querySelector("[data-mission-option]")).toBeNull()
  })
})

describe("1.2.7 U-5 surface 2: permission prompt (SR7-14)", () => {
  test("footer actions are outside [data-slot=permission-body]; the body holds the long command and starts at the top", () => {
    const el = host()
    dispose = render(
      () =>
        createComponent(SessionPermissionDock, {
          request: {
            id: "per_u5",
            sessionID: "ses_u5",
            permission: "bash",
            patterns: [LONG],
            metadata: {},
            always: [],
          },
          responding: false,
          onDecide: () => {},
        }),
      el,
    )
    const body = el.querySelector<HTMLElement>("[data-slot='permission-body']")!
    const actions = el.querySelector("[data-slot='permission-footer-actions']")!
    expect(body).not.toBeNull()
    expect(actions).not.toBeNull()
    expect(body.contains(actions)).toBe(false)
    expect(follows(body, actions)).toBe(true)
    expect(actions.querySelectorAll("button").length).toBeGreaterThanOrEqual(2)
    expect(body.textContent).toContain(LONG)
    expect(body.scrollTop).toBe(0)
  })

  test("message-part.css: the dock is capped by --permission-prompt-max-height, the body scrolls, no hidden scrollbar, a fade keyed on data-permission-body-more", () => {
    const css = readFileSync(
      new URL("../../session-ui/src/components/message-part.css", import.meta.url).pathname,
      "utf8",
    )
    const dock = block(css, '[data-component="dock-prompt"][data-kind="permission"]')
    expect(dock.length).toBeGreaterThan(0)
    expect(dock).toContain("max-height: var(--permission-prompt-max-height")
    expect(dock).not.toMatch(/max-height:\s*100dvh/)
    const body = block(dock, '[data-slot="permission-body"]')
    expect(body).toMatch(/overflow-y:\s*auto/)
    expect(dock).not.toMatch(/scrollbar-width:\s*none/)
    expect(dock).not.toMatch(/::-webkit-scrollbar\s*\{\s*display:\s*none/)
    // SR7-14: a visible overflow cue (fade) while more text is below, keyed on the N7-149 attribute.
    expect(dock).toMatch(/\[data-permission-body-more\][^{]*\{[^}]*(gradient|mask)/)
  })
})

describe("1.2.7 U-5 surface 3: Decisions list", () => {
  test("a waiting entry with a 3,000-character pattern: [data-map-decision-body] bounded, [data-map-decision-actions] after and outside it", () => {
    let seq = 0
    const lines = [
      {
        v: 1,
        seq: ++seq,
        prev: "",
        at: seq,
        type: "decision",
        rootID: "root",
        sessionID: "root",
        requestID: "held",
        messageID: "msg_1",
        agent: "build",
        directory: "/repo",
        permission: "bash",
        patterns: [LONG],
        patternsTruncated: false,
        class: "D",
        risk: "",
        canUndo: true,
        decidedBy: "gate",
        decision: "defer",
        category: "outward",
        memo: false,
        follows: [],
      },
    ] as unknown as AutonomyAuditLine[]
    const [groups] = createSignal(decisionGroups(lines, "root"))
    const decisions = {
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
      calls: () => [{ tool: "bash", args: [{ name: "command", value: LONG }] }],
      canAlways: () => false,
      replyBusy: () => false,
      undoBusy: () => false,
      reply: () => {},
      undo: () => {},
      canRetry: () => true,
      retry: () => {},
      refresh: () => {},
      confirm: () => {},
    }
    const el = host()
    dispose = render(() => createComponent(DecisionList, { decisions, directory: "/repo" }), el)
    const row = el.querySelector<HTMLElement>('[data-decision="held"]')!
    expect(row).not.toBeNull()
    row.querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!.click()
    const body = row.querySelector("[data-map-decision-body]")!
    expect(body).not.toBeNull()
    for (const c of ["overflow-y-auto", "min-h-0"]) expect(classes(body).has(c)).toBe(true)
    expect(hasMaxH(body)).toBe(true)
    expect(classes(body).has("no-scrollbar")).toBe(false)
    expect(body.querySelector("[data-decision-summary]")).not.toBeNull()
    expect(body.querySelector("[data-decision-details]")).not.toBeNull()
    expect(body.querySelector("[data-decision-pattern]")?.textContent).toBe(LONG)
    const actions = row.querySelector("[data-map-decision-actions]")!
    expect(actions).not.toBeNull()
    expect(body.contains(actions)).toBe(false)
    expect(follows(body, actions)).toBe(true)
    expect(body.querySelector("button")).toBeNull()
    const labels = [...actions.querySelectorAll("button")].map((b) => b.textContent?.trim())
    expect(labels).toContain(dict["session.movedOn.allow"])
    expect(labels).toContain(dict["session.map.decisions.details.hide"])
    // Allow, Deny, Details: three buttons, all in the actions container.
    expect(actions.querySelectorAll("button").length).toBe(3)
  })
})
