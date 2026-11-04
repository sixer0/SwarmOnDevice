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

// Review P6 (gate 4): a refresh re-reads the audit and builds every entry anew. History must keep the rows it already drew
// and draw only what is new, so a refresh costs one row per new line, not one per line in the file.
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
    patterns: [`echo ${requestID}`],
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
const outcome = (requestID: string, value: string) =>
  ({ v: 1, seq: ++seq, prev: "", at: seq, type: "outcome", requestID, outcome: value }) as AutonomyAuditLine

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function mount(lines: AutonomyAuditLine[]) {
  const [groups, setGroups] = createSignal(decisionGroups(lines, "root"))
  // What a refresh does: the same audit read again gives new objects for every entry.
  const refresh = (next: AutonomyAuditLine[]) => setGroups(decisionGroups(next, "root"))
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
    calls: () => [],
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
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(DecisionList, { decisions, directory: "/repo" }), host)
  host
    .querySelector<HTMLElement>('[data-decision-section="history"]')!
    .querySelector<HTMLButtonElement>("button")!
    .click()
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-decision-group="history"] [data-decision]')]
  // Every row element seen so far. A row that is drawn again is a new element, so it is not in here yet.
  const seen = new WeakSet<HTMLElement>()
  const created = () => {
    const fresh = rows().filter((row) => !seen.has(row))
    rows().forEach((row) => seen.add(row))
    return fresh.map((row) => row.getAttribute("data-decision"))
  }
  return { rows, created, refresh, host }
}

const base = Array.from({ length: 20 }, (_, index) => [decision(`r${index}`), outcome(`r${index}`, "ran")]).flat()

describe("review P6: History rows are reused across refreshes", () => {
  test("two refreshes, the second with one new entry, re-create only that entry's row", () => {
    const view = mount(base)
    const first = view.created()
    expect(first).toHaveLength(20)
    view.refresh([...base])
    const same = view.created()
    const added = [...base, decision("new"), outcome("new", "ran")]
    view.refresh(added)
    const grown = view.created()
    // Printed for the row report: before the fix each refresh re-created every row.
    console.error(
      `P6 counts: first=${first.length} same=${same.length} grown=${grown.length} rows=${view.rows().length}`,
    )
    expect(same).toEqual([])
    expect(grown).toEqual(["new"])
    expect(view.rows()).toHaveLength(21)
    expect(view.rows()[0]!.getAttribute("data-decision")).toBe("new")
  })

  test("an entry whose content changed is drawn again with what it now says", () => {
    const view = mount(base)
    view.created()
    view.refresh([...base, outcome("r3", "undone")])
    expect(view.created()).toEqual(["r3"])
    expect(view.rows()).toHaveLength(20)
  })

  test("Details left open stay open across a refresh", () => {
    const view = mount(base)
    const row = () => view.host.querySelector<HTMLElement>('[data-decision="r5"]')!
    const toggle = () =>
      [...row().querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => button.textContent?.trim() === dict["session.map.decisions.details.show"],
      )
    toggle()!.click()
    expect(row().querySelector("[data-decision-details]") ?? row().textContent).toBeTruthy()
    const before = row().textContent
    view.refresh([...base, decision("new")])
    expect(row().textContent).toBe(before)
  })
})
