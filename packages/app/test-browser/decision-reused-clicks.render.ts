// Row F18 (gate 7, G7-2): clicks Allow, Always, Deny on REUSED Waiting rows and Undo (through its
// confirm dialog) on REUSED History rows, and checks each reaches createDecisions' reply/undo with the right entry.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { AutonomyAuditLine } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { decisionGroups } from "@/pages/session/map/session-map-model"

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
mock.module("@opencode-ai/session-ui/message-part", () => ({ getToolInfo: () => ({}) }))
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? String(key) }),
}))
// The dialog stand-in draws what it is shown into its own host, so the Undo confirmation button can be clicked.
const dialogHosts: HTMLElement[] = []
const dialogs = await import("@opencode-ai/ui/context/dialog")
// The app draws a dialog inside Kobalte's Dialog root (the ui package's provider); the stand-in does the same, with the
// ui package's own copy of Kobalte.
const { Dialog: KDialog } = await import(
  Bun.resolveSync("@kobalte/core/dialog", new URL("../../ui/src", import.meta.url).pathname)
)
mock.module("@opencode-ai/ui/context/dialog", () => ({
  ...dialogs,
  useDialog: () => ({
    show: (fn: () => unknown) => {
      const h = document.createElement("div")
      h.setAttribute("data-probe-dialog", String(dialogHosts.length))
      document.body.append(h)
      render(
        () =>
          createComponent(KDialog, {
            open: true,
            modal: false,
            get children() {
              return (fn as () => any)()
            },
          }),
        h,
      )
      dialogHosts.push(h)
    },
    close: () => {},
  }),
}))
// The list the Activity panel draws, not a copy of it. The computed path keeps the view out of this folder's typecheck.
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
    messageID: `msg_${requestID}`,
    agent: "build",
    directory: `/repo/${requestID}`,
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
const waitingLine = (id: string, sessionID = "root") =>
  decision(id, {
    class: "D",
    decision: "defer",
    decidedBy: "gate",
    category: "outward",
    patterns: [`git push ${id}`],
    sessionID,
  })

let dispose = () => {}
afterEach(() => {
  dispose()
  dialogHosts.length = 0
  document.body.innerHTML = ""
})

type Sent = { id: string; sessionID: string; messageID?: string; directory?: string; reply?: string; json: string }
function mount(lines: AutonomyAuditLine[]) {
  const replies: Sent[] = []
  const undone: Sent[] = []
  const [groups, setGroups] = createSignal(decisionGroups(lines, "root"))
  const refresh = (next: AutonomyAuditLine[]) => setGroups(decisionGroups(next, "root"))
  const pick = (entry: any, reply?: string): Sent => ({
    id: entry.id,
    sessionID: entry.sessionID,
    messageID: entry.messageID,
    directory: entry.directory,
    reply,
    json: JSON.stringify(entry),
  })
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
    canAlways: () => true,
    replyBusy: () => false,
    undoBusy: () => false,
    reply: (entry: any, reply: string) => replies.push(pick(entry, reply)),
    undo: (entry: any) => undone.push(pick(entry)),
    canRetry: () => true,
    retry: () => {},
    refresh: () => {},
    confirm: () => {},
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(DecisionList, { decisions, directory: "/repo" }), host)
  const row = (id: string) => host.querySelector<HTMLElement>(`[data-decision="${id}"]`)!
  const button = (id: string, label: string) =>
    [...row(id).querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)
  const openHistory = () =>
    host
      .querySelector<HTMLElement>('[data-decision-section="history"]')!
      .querySelector<HTMLButtonElement>("button")!
      .click()
  // The entry the current groups hold for this id: what a click must send.
  const current = (id: string) => {
    const g = groups()
    return JSON.stringify([...g.waiting, ...g.decided, ...g.limited].find((e) => e.id === id))
  }
  return { host, row, button, openHistory, refresh, replies, undone, current }
}

const ALLOW = dict["session.movedOn.allow"]
const ALWAYS = dict["session.movedOn.alwaysInSession"]
const UNDO = dict["command.session.undo"]
const dialogButton = (n: number, label: string) => {
  const boxes = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
  const box = boxes[n] ?? dialogHosts[n]!
  return [...box.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!
}
const deny = (view: ReturnType<typeof mount>, id: string) => {
  // Deny's text is in the ui dictionary; it is the last reply button, after Allow and Always.
  const buttons = [...view.row(id).querySelectorAll<HTMLButtonElement>("button")]
  return buttons[buttons.findIndex((b) => b.hasAttribute("data-decision-always")) + 1]!
}

describe("row F18: clicks on reused rows", () => {
  test("Waiting: Allow, Always, Deny on reused rows send the reply for that row's entry", () => {
    const base = [waitingLine("w0"), waitingLine("w1", "child"), waitingLine("w2"), waitingLine("w3", "child")]
    const view = mount(base)
    const before = ["w0", "w1", "w2", "w3"].map((id) => view.row(id))
    // A refresh with the same data, then one with a new entry placed FIRST in the audit (shifts every index).
    view.refresh([...base])
    view.refresh([waitingLine("n0"), ...base])
    const after = ["w0", "w1", "w2", "w3"].map((id) => view.row(id))
    after.forEach((el, i) => expect(el === before[i]).toBe(true)) // reused: the same elements
    view.button("w1", ALLOW)!.click()
    view.button("w2", ALWAYS)!.click()
    deny(view, "w3").click()
    view.button("n0", ALLOW)!.click()
    expect(view.replies.map((r) => `${r.id}:${r.sessionID}:${r.directory}:${r.reply}`)).toEqual([
      "w1:child:/repo/w1:once",
      "w2:root:/repo/w2:always",
      "w3:child:/repo/w3:reject",
      "n0:root:/repo/n0:once",
    ])
    // What a reused row sends is the same content as the entry the groups hold now.
    for (const r of view.replies) expect(r.json).toBe(view.current(r.id))
  })

  test("Waiting: an entry that changed is drawn again, and its click sends the changed entry", () => {
    const base = [waitingLine("w0"), waitingLine("w1")]
    const view = mount(base)
    const old = view.row("w1")
    view.refresh([
      waitingLine("w0"),
      decision("w1", {
        class: "D",
        decision: "defer",
        decidedBy: "gate",
        category: "outward",
        patterns: ["git push changed"],
        directory: "/repo/elsewhere",
      }),
    ])
    expect(view.row("w1") === old).toBe(false)
    view.button("w1", ALLOW)!.click()
    expect(view.replies[0]!.directory).toBe("/repo/elsewhere")
    expect(view.replies[0]!.json).toBe(view.current("w1"))
  })

  test("History: Undo on reused rows, through the confirm dialog, undoes that row's entry", () => {
    const base = Array.from({ length: 6 }, (_, i) => [decision(`r${i}`), outcome(`r${i}`, "ran")]).flat()
    const view = mount(base)
    view.openHistory()
    const before = ["r1", "r4"].map((id) => view.row(id))
    view.refresh([...base])
    view.refresh([...base, decision("new"), outcome("new", "ran")])
    ;["r1", "r4"].forEach((id, i) => expect(view.row(id) === before[i]).toBe(true))
    // Undo opens the confirmation; nothing is undone until it is confirmed.
    view.button("r4", UNDO)!.click()
    expect(view.undone).toEqual([])
    expect(dialogHosts).toHaveLength(1)
    const confirm = dialogButton(0, UNDO)
    confirm.click()
    view.button("r1", UNDO)!.click()
    dialogButton(1, UNDO).click()
    // Cancel on a third: nothing sent.
    view.button("new", UNDO)!.click()
    dialogButton(2, dict["common.cancel"]).click()
    expect(view.undone.map((u) => `${u.id}:${u.sessionID}:${u.messageID}`)).toEqual([
      "r4:root:msg_r4",
      "r1:root:msg_r1",
    ])
    for (const u of view.undone) expect(u.json).toBe(view.current(u.id))
  })

  test("History: after an undone outcome the row is redrawn without Undo; its neighbours stay reused and correct", () => {
    const base = Array.from({ length: 4 }, (_, i) => [decision(`r${i}`), outcome(`r${i}`, "ran")]).flat()
    const view = mount(base)
    view.openHistory()
    const r2 = view.row("r2")
    const r1 = view.row("r1")
    view.refresh([...base, outcome("r1", "undone")])
    expect(view.row("r1") === r1).toBe(false)
    expect(view.button("r1", UNDO)).toBeUndefined()
    expect(view.row("r2") === r2).toBe(true)
    view.button("r2", UNDO)!.click()
    dialogButton(0, UNDO).click()
    expect(view.undone.map((u) => u.id)).toEqual(["r2"])
  })

  test("A Waiting entry that moves to History: its row leaves Waiting and History's row sends Undo for it", () => {
    // w1 waits for a reason Undo can bring back (not an outward call, which BEYOND_UNDO gives no Undo).
    const w1 = () => decision("w1", { class: "D", decision: "defer", decidedBy: "gate", category: "not_routine" })
    const first = [waitingLine("w0"), w1()]
    const view = mount(first)
    view.openHistory()
    // w1 is now answered by the person (approved_later) and ran.
    view.refresh([...first, outcome("w1", "approved_later"), outcome("w1", "ran")])
    const inWaiting = view.host.querySelector('[data-decision-group="waiting"] [data-decision="w1"]')
    const inHistory = view.host.querySelector<HTMLElement>('[data-decision-group="history"] [data-decision="w1"]')
    expect(inWaiting).toBeNull()
    expect(inHistory).not.toBeNull()
    const undo = [...inHistory!.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === UNDO,
    )
    expect(undo).toBeDefined()
    undo!.click()
    dialogButton(0, UNDO).click()
    expect(view.undone.map((u) => `${u.id}:${u.messageID}`)).toEqual(["w1:msg_w1"])
    view.button("w0", ALLOW)!.click()
    expect(view.replies.map((r) => r.id)).toEqual(["w0"])
  })
})
