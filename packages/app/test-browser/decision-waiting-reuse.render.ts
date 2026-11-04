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

// Row F16: the same for the Waiting rows. A refresh with unchanged data draws no Waiting row again; one new waiting entry
// draws one.
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

const waitingLine = (id: string, patterns = [`git push ${id}`]) =>
  decision(id, { class: "D", decision: "defer", decidedBy: "gate", category: "outward", patterns })

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
  const rows = () => [...host.querySelectorAll<HTMLElement>('[data-decision-group="waiting"] [data-decision]')]
  // Every row element seen so far. A row that is drawn again is a new element, so it is not in here yet.
  const seen = new WeakSet<HTMLElement>()
  const created = () => {
    const fresh = rows().filter((row) => !seen.has(row))
    rows().forEach((row) => seen.add(row))
    return fresh.map((row) => row.getAttribute("data-decision"))
  }
  return { rows, created, refresh, host }
}

const base = Array.from({ length: 20 }, (_, index) => waitingLine(`w${index}`))

describe("row F16: Waiting rows are reused across refreshes", () => {
  test("a refresh with the same data re-creates 0 rows, one with a new entry re-creates 1", () => {
    const view = mount(base)
    const first = view.created()
    expect(first).toHaveLength(20)
    view.refresh([...base])
    const same = view.created()
    view.refresh([...base, waitingLine("new")])
    const grown = view.created()
    // Printed for the row report: before the fix each refresh re-created every row.
    console.error(
      `F16 counts: first=${first.length} same=${same.length} grown=${grown.length} rows=${view.rows().length}`,
    )
    expect(same).toEqual([])
    expect(grown).toEqual(["new"])
    expect(view.rows()).toHaveLength(21)
  })

  test("a changed entry is drawn again with what it now says", () => {
    const view = mount(base)
    view.created()
    view.refresh([...base.slice(0, 3), waitingLine("w3", ["git push changed"]), ...base.slice(4)])
    expect(view.created()).toEqual(["w3"])
    expect(view.rows().find((row) => row.getAttribute("data-decision") === "w3")!.textContent).toContain(
      "git push changed",
    )
  })

  test("Details left open stay open when the entry is reused and when it is drawn again", () => {
    const view = mount(base)
    const row = (id: string) => view.host.querySelector<HTMLElement>(`[data-decision="${id}"]`)!
    const toggle = (id: string) => row(id).querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!
    toggle("w5").click()
    toggle("w6").click()
    expect(row("w5").querySelector("[data-decision-details]")).not.toBeNull()
    const kept = row("w5")
    view.refresh([...base.slice(0, 6), waitingLine("w6", ["git push changed"]), ...base.slice(7)])
    expect(row("w5") === kept).toBe(true)
    expect(row("w5").querySelector("[data-decision-details]")).not.toBeNull()
    expect(row("w6").querySelector("[data-decision-details]")).not.toBeNull()
    expect(row("w7").querySelector("[data-decision-details]")).toBeNull()
  })
})
