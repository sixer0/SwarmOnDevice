import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { AutonomyAuditLine } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { decisionGroups } from "@/pages/session/map/session-map-model"

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

// The message parts pull in a Vite worker URL, which Bun cannot load. Nothing the list draws uses them.
mock.module("@opencode-ai/session-ui/message-part", () => ({ getToolInfo: () => ({}) }))
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? String(key) }),
}))
const shown: unknown[] = []
const dialogs = await import("@opencode-ai/ui/context/dialog")
mock.module("@opencode-ai/ui/context/dialog", () => ({
  ...dialogs,
  useDialog: () => ({ show: (render: unknown) => shown.push(render), close: () => {} }),
}))

// The list the Activity panel draws, not a copy of it. The computed path keeps the view out of this folder's typecheck,
// which reads `import.meta.env` differently from the app's own.
const { DecisionList } = await import(
  new URL("../src/pages/session/map/session-map-view.tsx", import.meta.url).pathname
)

let seq = 0
const decision = (requestID: string, fields: Partial<Extract<AutonomyAuditLine, { type: "decision" }>> = {}) =>
  ({
    v: 1,
    seq: ++seq,
    prev: "",
    at: seq,
    type: "decision",
    rootID: "root",
    sessionID: "root",
    requestID,
    messageID: "msg_5",
    agent: "build",
    directory: "/repo",
    permission: "bash",
    patterns: ["ls"],
    patternsTruncated: false,
    class: "P",
    risk: "",
    canUndo: true,
    decidedBy: "agent:test/test-model",
    decision: "allow",
    memo: false,
    follows: [],
    ...fields,
  }) as AutonomyAuditLine
const outcome = (requestID: string, value: string, by?: string) =>
  ({ v: 1, seq: ++seq, prev: "", at: seq, type: "outcome", requestID, outcome: value, by }) as AutonomyAuditLine
const marker = (name: string) =>
  ({
    v: 1,
    seq: ++seq,
    prev: "",
    at: seq,
    type: "marker",
    rootID: "root",
    marker: name,
    decidedBy: "gate",
  }) as AutonomyAuditLine

const lines = [
  decision("edited", { permission: "edit", patterns: ["/repo/src/app.ts"], decidedBy: "person" }),
  outcome("edited", "ran"),
  marker("bypass_on"),
  decision("main", {
    class: "A",
    category: "by_main_agent",
    bypassed: "outside_folder",
    decidedBy: "agent:main/build",
    via: "main_agent",
    patterns: ["mkdir -p build\necho done"],
    canUndo: false,
  }),
  decision("declined", {
    sessionID: "child",
    permission: "webfetch",
    patterns: ["https://example.com/page"],
    decision: "reject",
    decidedBy: "agent:main/build",
    via: "for_subagent",
    reason: "not part of the goal",
  }),
  decision("held", {
    class: "D",
    decision: "defer",
    decidedBy: "gate",
    category: "outward",
    patterns: ["git push origin main"],
  }),
]

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function mount() {
  const replies: string[] = []
  const undone: string[] = []
  // A re-read of the audit builds every entry anew: `regroup` does the same with the same lines.
  const [groups, setGroups] = createSignal(decisionGroups(lines, "root"))
  const regroup = () => setGroups(decisionGroups(lines, "root"))
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
    calls: () => [{ tool: "bash", args: [{ name: "command", value: "git push origin main" }] }],
    canAlways: () => false,
    replyBusy: () => false,
    undoBusy: () => false,
    reply: (entry: { id: string }, reply: string) => replies.push(`${entry.id}:${reply}`),
    undo: (entry: { id: string }) => undone.push(entry.id),
    canRetry: () => true,
    retry: () => {},
    refresh: () => {},
    confirm: () => {},
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(DecisionList, { decisions, directory: "/repo" }), host)
  const section = (name: string) => host.querySelector<HTMLElement>(`[data-decision-section="${name}"]`)!
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-decision="${id}"]`)
  const summary = (id: string) => row(id)?.querySelector("[data-decision-summary]")?.textContent?.trim()
  const buttons = (id: string) =>
    [...(row(id)?.querySelectorAll("button") ?? [])].map((button) => button.textContent?.trim())
  const openHistory = () => section("history").querySelector<HTMLButtonElement>("button")!.click()
  return { host, section, row, summary, buttons, openHistory, replies, undone, regroup }
}

describe("1.1.1: Decisions as Waiting and History", () => {
  test("two sections, Waiting open and History closed on first render, each with its count", () => {
    const view = mount()
    expect(view.host.querySelectorAll("[data-decision-section]")).toHaveLength(2)
    const counts = [...view.host.querySelectorAll("[data-decision-count]")].map((span) => span.textContent?.trim())
    expect(counts).toEqual(["1", "4"])
    expect(view.section("waiting").textContent).toContain(dict["session.map.decisions.group.waiting"])
    expect(view.section("history").textContent).toContain(dict["session.map.decisions.group.history"])
    expect(view.row("held")).not.toBeNull()
    expect(view.host.querySelector('[data-decision-group="history"]')).toBeNull()
    expect(view.row("main")).toBeNull()
    // The headings 1.1.0 had are gone from the view.
    expect(view.host.textContent).not.toContain(dict["session.map.decisions.group.decided"])
    expect(view.host.textContent).not.toContain(dict["session.map.decisions.group.limited"])
  })

  test("a waiting row says what, decision, who and why on one line, and Allow and Deny need no expanding", () => {
    const view = mount()
    expect(view.summary("held")).toBe(
      [
        `${dict["session.map.decisions.what.bash"]}: git push origin main`,
        dict["session.map.decisions.state.waiting"],
        dict["session.map.decisions.by.rules"],
        dict["session.permission.leavesMachine"],
      ].join(" · "),
    )
    expect(view.buttons("held")).toEqual([
      dict["session.movedOn.allow"],
      // Deny's text lives in the ui package's dictionary.
      expect.any(String),
      dict["session.map.decisions.details.show"],
    ])
    view.row("held")!.querySelector<HTMLButtonElement>("button")!.click()
    expect(view.replies).toEqual(["held:once"])
    // The held call's arguments are details.
    expect(view.row("held")!.querySelector("[data-decision-call]")).toBeNull()
  })

  test("History lists latest first, names the main agent, and keeps raw details behind the toggle", () => {
    const view = mount()
    view.openHistory()
    const history = view.host.querySelector('[data-decision-group="history"]')!
    const order = [...history.children].map(
      (child) => child.getAttribute("data-decision") ?? (child.hasAttribute("data-decision-note") ? "note" : "?"),
    )
    expect(order).toEqual(["declined", "main", "note", "edited"])
    expect(history.querySelector("[data-decision-note]")?.textContent).toBe(dict["session.map.decisions.note.bypassOn"])
    expect(view.summary("main")).toBe(
      [
        `${dict["session.map.decisions.what.bash"]}: mkdir -p build`,
        dict["session.map.decisions.state.allowed"],
        dict["session.map.decisions.by.mainAgent"],
        dict["session.map.decisions.category.by_main_agent"],
      ].join(" · "),
    )
    expect(dict["session.map.decisions.by.mainAgent"]).toBe("Main agent")
    // A subagent's call the main agent declined: refused, by the main agent, for the reason it gave.
    expect(view.summary("declined")).toBe(
      [
        `${dict["session.map.decisions.what.web"]}: https://example.com/page`,
        dict["session.map.decisions.state.refused"],
        dict["session.map.decisions.by.mainAgent"],
        "not part of the goal",
      ].join(" · "),
    )
    // A file by its path in the project.
    expect(view.summary("edited")).toStartWith(`${dict["session.map.decisions.what.edit"]}: src/app.ts · `)

    const main = view.row("main")!
    expect(main.querySelector("[data-decision-details]")).toBeNull()
    expect(main.querySelector("[data-decision-pattern]")).toBeNull()
    const toggle = main.querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!
    toggle.click()
    expect(main.querySelector("[data-decision-pattern]")?.textContent).toBe("mkdir -p build\necho done")
    expect(main.querySelector("[data-decision-details]")?.textContent).toContain("main/build")
    expect(toggle.textContent?.trim()).toBe(dict["session.map.decisions.details.hide"])
    toggle.click()
    expect(main.querySelector("[data-decision-details]")).toBeNull()
  })

  test("Undo in History needs no expanding and asks before it goes back", () => {
    const view = mount()
    view.openHistory()
    expect(view.buttons("edited")).toEqual([dict["command.session.undo"], dict["session.map.decisions.details.show"]])
    view.row("edited")!.querySelector<HTMLButtonElement>("[data-decision-undo]")!.click()
    expect(shown).toHaveLength(1)
    expect(view.undone).toEqual([])
  })

  test("Details stays open when the audit is read again and every row is drawn anew (code review M3)", () => {
    const view = mount()
    view.openHistory()
    const before = view.row("main")!
    before.querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!.click()
    const held = view.row("held")!
    held.querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!.click()
    expect(view.row("main")!.querySelector("[data-decision-details]")).not.toBeNull()

    view.regroup()
    view.regroup()

    // New entry objects. Waiting and History both reuse a row whose content did not change (review P6, row F16), so the
    // elements are the same ones; a changed entry is drawn anew (decision-waiting-reuse.render.ts), Details kept by id.
    expect(view.row("held") === held).toBe(true)
    expect(view.row("main") === before).toBe(true)
    expect(view.row("main")!.querySelector("[data-decision-details]")).not.toBeNull()
    expect(view.row("main")!.querySelector("[data-decision-details-toggle]")?.getAttribute("aria-expanded")).toBe(
      "true",
    )
    expect(view.row("held")!.querySelector("[data-decision-details]")).not.toBeNull()
    // The rows the person did not open stay closed.
    expect(view.row("declined")!.querySelector("[data-decision-details]")).toBeNull()

    view.row("main")!.querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!.click()
    view.regroup()
    expect(view.row("main")!.querySelector("[data-decision-details]")).toBeNull()
  })
})
