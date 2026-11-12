// Row 38c (P-01c): the Revert action of a checkpoint in the existing Decisions list, drawn through the real view with a
// stand-in for createDecisions; the dialog stand-in draws the confirmation so its buttons can be clicked.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { AutonomyAuditLine } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
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
  useLanguage: () => ({
    t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
      (dict[key] ?? String(key)).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params?.[name] ?? "")),
  }),
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
const line = (fields: Record<string, unknown>) =>
  ({ v: 1, seq: ++seq, prev: "", at: 1000 + seq, type: "outcome", ...fields }) as AutonomyAuditLine
const checkpointed = (id: string, extra: Record<string, unknown> = {}) =>
  line({
    requestID: `req_${id}`,
    outcome: "checkpointed",
    checkpoint: id,
    entries: 2,
    manifestSha256: "a".repeat(64),
    ...extra,
  })
const plainDecision = () =>
  ({
    v: 1,
    seq: ++seq,
    prev: "",
    at: seq,
    type: "decision",
    rootID: "root",
    sessionID: "root",
    requestID: "d1",
    messageID: "msg_1",
    agent: "build",
    directory: "/repo",
    permission: "bash",
    patterns: ["echo hi"],
    patternsTruncated: false,
    class: "P",
    risk: "",
    canUndo: true,
    decidedBy: "agent:test/test-model",
    decision: "allow",
    memo: false,
    follows: [],
  }) as AutonomyAuditLine

let dispose = () => {}
afterEach(() => {
  dispose()
  dialogHosts.length = 0
  document.body.innerHTML = ""
})

function mount(lines: AutonomyAuditLine[]) {
  const reverted: string[] = []
  const [result, setResult] = createStore<Record<string, { preRevert: string } | { error: string } | undefined>>({})
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
    checkpointBusy: () => false,
    checkpointResult: (id: string) => result[id],
    revertCheckpoint: (id: string) => reverted.push(id),
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(DecisionList, { decisions, directory: "/repo" }), host)
  return { host, reverted, setResult }
}

const REVERT = dict["session.autonomy.checkpoint.revert"]
const dialogButton = (n: number, label: string) =>
  [...dialogHosts[n]!.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label)!
const revertButtons = (host: HTMLElement) => [...host.querySelectorAll<HTMLButtonElement>("[data-checkpoint-revert]")]

describe("row 38c (P-01c): one Revert action on the checkpoints, in the existing Decisions list", () => {
  test("no checkpoint in the audit: no checkpoint group and no Revert", () => {
    const view = mount([plainDecision(), line({ requestID: "d1", outcome: "ran" })])
    expect(view.host.querySelector("[data-decision-checkpoints]")).toBeNull()
    expect(revertButtons(view.host)).toHaveLength(0)
    expect(view.host.textContent).not.toContain(REVERT)
  })

  test("a checkpointed line without its manifest sha (the route answers 404) offers no Revert", () => {
    const view = mount([plainDecision(), checkpointed("ck_nosha", { manifestSha256: undefined })])
    expect(revertButtons(view.host)).toHaveLength(0)
  })

  test("each checkpoint gets one Revert, latest first, under the title with the count, in the Waiting section", () => {
    const view = mount([plainDecision(), checkpointed("ck_one"), checkpointed("ck_two"), checkpointed("ck_one")])
    const group = view.host.querySelector<HTMLElement>('[data-decision-group="waiting"] [data-decision-checkpoints]')!
    expect(group).not.toBeNull()
    expect(group.textContent).toContain(dict["session.autonomy.checkpoint.title"].replace("{{count}}", "2"))
    const ids = [...group.querySelectorAll<HTMLElement>("[data-checkpoint]")].map((el) => el.dataset.checkpoint)
    expect(ids).toEqual(["ck_two", "ck_one"])
    expect(revertButtons(view.host).map((b) => b.textContent?.trim())).toEqual([REVERT, REVERT])
  })

  test("FX-13: only the newest 20 checkpoints are listed, then one plain 'N more' line", () => {
    // Written oldest first, so the audit order and the time order agree; the newest is ck_25.
    const view = mount(Array.from({ length: 25 }, (_, i) => checkpointed(`ck_${i + 1}`)))
    const group = view.host.querySelector<HTMLElement>("[data-decision-checkpoints]")!
    expect(group.textContent).toContain(dict["session.autonomy.checkpoint.title"].replace("{{count}}", "25"))
    const ids = [...group.querySelectorAll<HTMLElement>("[data-checkpoint]")].map((el) => el.dataset.checkpoint)
    expect(ids).toEqual(Array.from({ length: 20 }, (_, i) => `ck_${25 - i}`))
    expect(revertButtons(view.host)).toHaveLength(20)
    const more = group.querySelector<HTMLElement>("[data-checkpoint-more]")!
    expect(more).not.toBeNull()
    expect(more.textContent).toContain("5 more")
    expect(group.lastElementChild).toBe(more)
  })

  test("FX-13: 20 checkpoints or fewer: all listed, no 'more' line", () => {
    const view = mount(Array.from({ length: 20 }, (_, i) => checkpointed(`ck_${i + 1}`)))
    expect(view.host.querySelectorAll("[data-checkpoint]")).toHaveLength(20)
    expect(view.host.querySelector("[data-checkpoint-more]")).toBeNull()
  })

  test("Revert asks first: nothing is sent until the confirmation, Cancel sends nothing", () => {
    const view = mount([checkpointed("ck_one")])
    revertButtons(view.host)[0]!.click()
    expect(view.reverted).toEqual([])
    expect(dialogHosts).toHaveLength(1)
    expect(dialogHosts[0]!.textContent).toContain(dict["session.autonomy.checkpoint.confirm"])
    dialogButton(0, dict["common.cancel"]).click()
    expect(view.reverted).toEqual([])
    revertButtons(view.host)[0]!.click()
    dialogButton(1, REVERT).click()
    expect(view.reverted).toEqual(["ck_one"])
  })

  test("the answer is shown on the checkpoint: the error text, or Undone without a second Revert", () => {
    const view = mount([checkpointed("ck_one"), checkpointed("ck_two")])
    view.setResult("ck_one", { error: "Reverting a checkpoint is only taken from the Swarm desktop app" })
    const one = view.host.querySelector<HTMLElement>('[data-checkpoint="ck_one"]')!
    expect(one.querySelector("[data-checkpoint-error]")!.textContent).toContain("only taken from the Swarm desktop app")
    expect(one.querySelector("[data-checkpoint-revert]")).not.toBeNull()
    view.setResult("ck_two", { preRevert: "ck_pre" })
    const two = view.host.querySelector<HTMLElement>('[data-checkpoint="ck_two"]')!
    expect(two.querySelector("[data-checkpoint-reverted]")!.textContent).toBe(dict["session.review.group.undone"])
    expect(two.querySelector("[data-checkpoint-revert]")).toBeNull()
  })

  test("a checkpoint the audit says was reverted (its revert_<id> undone line) shows Undone, no Revert", () => {
    const view = mount([
      checkpointed("ck_one"),
      line({ requestID: "revert_ck_one", outcome: "undone", checkpoint: "ck_one", by: "person" }),
    ])
    const one = view.host.querySelector<HTMLElement>('[data-checkpoint="ck_one"]')!
    expect(one.querySelector("[data-checkpoint-reverted]")).not.toBeNull()
    expect(one.querySelector("[data-checkpoint-revert]")).toBeNull()
  })
})
