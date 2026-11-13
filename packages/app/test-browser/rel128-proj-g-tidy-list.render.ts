// Swarm 1.2.8 row 46b (N8-368), render half. Run by rel128-proj-g-tidy-list.test.ts.
// AC-PROJg: a `project-tidy` request renders in the existing decision card (no new panel): title N8-159, description
// N8-160, one line per proposal item (N8-161 / N8-162), approve N8-163 with the count of moving items, decline N8-164;
// approve goes to `place` once (main moves the listed missions), decline to `answer`; refusal / stop texts N8-175 / N8-167.
// C98: an answered placement (by user, attested) whose mission is not in the group shows a retry in the same card.
// Counts and booleans only (C77: a failing expect on an element can hang bun).
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { resolveTemplate } from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { buildMission } from "@/pages/session/swarm/mission-model"
import { fixture } from "@/pages/session/swarm/mission-deliverables.fixture"

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
const tr = (key: string, params?: Record<string, string>) =>
  (dict as Record<string, string>)[key] === undefined ? String(key) : resolveTemplate((dict as Record<string, string>)[key]!, params ?? {})
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({ t: tr, locale: () => "en", intl: () => "en" }),
}))

const { MissionCommand } = await import(new URL("../src/pages/session/swarm/mission-command.tsx", import.meta.url).pathname)

const SESSION = "ses_0123456789abcdefABCDEFGHIJ"
let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))


const HOLDER = "2026-11-14_project-tidy"
const ROOT = "/srv/swarm/Documents/Default Project"
const A = "2026-09-01_lumen-onboarding-flow"
const B = "2026-09-08_dinas-contoh-nota-layanan"
const C = "2026-09-15_riset-pasang-surut-pesisir-utara"
const tidy = (over: Record<string, unknown> = {}) => ({
  id: "D-2",
  topic: "project-tidy",
  question: "Tidy (agent text)",
  context: "21 root missions; first list",
  options: [
    { id: "approve", label: "Approve crafted", consequence: "agent consequence" },
    { id: "decline", label: "Decline crafted", consequence: "agent consequence" },
  ],
  proposal: [
    { mission: A, group: "Lumen", groupKind: "product" },
    { mission: B, group: "Dinas Contoh", groupKind: "institution" },
    { mission: C, group: null },
  ],
  recommended: "approve",
  status: "open",
  createdAt: "2026-11-14T08:00:00Z",
  ...over,
})
const answeredPlacement = (answer: Record<string, unknown> = {}) => ({
  id: "D-1",
  topic: "project-placement",
  question: "Where?",
  options: [
    { id: "join", label: "Join crafted", consequence: "x", group: "DEMS", groupKind: "product" },
    { id: "new", label: "New crafted", consequence: "x", group: "Kemenkeu", groupKind: "institution" },
    { id: "root", label: "Keep", consequence: "x" },
  ],
  status: "answered",
  createdAt: "2026-11-14T07:00:00Z",
  closedAt: "2026-11-14T07:05:00Z",
  answer: { option: "join", by: "user", decision: "U1", via: "swarm-mission-control", attested: true, ...answer },
})

type PlaceResult = { ok: boolean; [k: string]: unknown }
function mount(requests: unknown[], opts: { busy?: boolean; dir?: string; place?: (i: unknown) => Promise<PlaceResult> } = {}) {
  const wire = fixture()
  wire.requests = requests as never
  ;(wire.mission as { sessions?: unknown }).sessions = [{ client: "swarm", ref: SESSION }]
  ;(wire.mission as { project?: unknown }).project = { dir: opts.dir ?? ROOT }
  const calls = { answer: [] as unknown[], place: [] as unknown[], toast: [] as Array<[string, string | undefined]> }
  const writer = {
    answer: async (i: unknown) => (calls.answer.push(i), { ok: true, data: { decision: "U1", released: [] } }),
    instruct: async () => ({ ok: true, data: { seq: 1 } }),
    place: async (i: unknown) => (calls.place.push(i), opts.place ? opts.place(i) : { ok: true, data: { decision: "U2", moved: 2, total: 2 } }),
  }
  const el = document.createElement("div")
  document.body.append(el)
  dispose = render(
    () =>
      createComponent(MissionCommand, {
        model: buildMission(wire, "en"),
        writer,
        refresh: () => {},
        prompt: async () => undefined,
        sessionBusy: () => opts.busy === true,
        toast: (text: string, variant?: string) => void calls.toast.push([text, variant]),
      }),
    el,
  )
  return { el, calls }
}
const button = (el: Element, id: string) => el.querySelector<HTMLButtonElement>(`[data-mission-option="${id}"]`)
const settle = async () => {
  await tick()
  await tick()
}

describe("1.2.8 row 46b AC-PROJg: the tidy list in the existing decision card", () => {
  test("title N8-159, description N8-160, lines N8-161 / N8-162 with kind chips, approve N8-163 (count 2) and decline N8-164", () => {
    const { el } = mount([tidy()])
    expect(el.querySelectorAll("[data-mission-decision]").length).toBe(1)
    const text = el.textContent ?? ""
    expect(text.includes(tr("session.mission.tidy.title"))).toBe(true)
    expect(text.includes(tr("session.mission.tidy.description"))).toBe(true)
    expect(el.querySelectorAll("[data-mission-tidy-line]").length).toBe(3)
    expect(el.querySelectorAll("[data-mission-tidy-line][data-stays]").length).toBe(1)
    expect(text.includes(tr("session.mission.tidy.row", { mission: A, group: "Lumen" }))).toBe(true)
    expect(text.includes(tr("session.mission.tidy.row", { mission: B, group: "Dinas Contoh" }))).toBe(true)
    expect(text.includes(tr("session.mission.tidy.stay"))).toBe(true)
    expect(el.querySelectorAll("[data-mission-tidy-list] [data-mission-group-kind]").length).toBe(2)
    expect(el.querySelectorAll("[data-mission-option]").length).toBe(2)
    expect(button(el, "approve")?.textContent?.includes(tr("session.mission.tidy.approve", { count: "2" }))).toBe(true)
    expect(button(el, "decline")?.textContent?.includes(tr("session.mission.tidy.decline"))).toBe(true)
    for (const crafted of ["crafted", "agent consequence", "(agent text)"]) expect(text.includes(crafted)).toBe(false)
    // the list sits in the existing bounded body; no new panel or dialog
    expect(el.querySelectorAll("[data-mission-decision-body] [data-mission-tidy-list]").length).toBe(1)
    expect(el.querySelectorAll("[role=dialog]").length).toBe(0)
  })

  test("approve: ONE place call (main moves the listed missions), no answer call, toast N8-166 with the moved count", async () => {
    const { el, calls } = mount([tidy()])
    button(el, "approve")!.click()
    await settle()
    expect(calls.place.length).toBe(1)
    const sent = calls.place[0] as Record<string, string>
    expect(`${Object.keys(sent).sort().join(",")} ${sent.request} ${sent.option}`).toBe("mission,option,request D-2 approve")
    expect(calls.answer.length).toBe(0)
    expect(calls.toast.length).toBe(1)
    expect(calls.toast[0]![0] === tr("session.mission.tidy.done", { count: "2" })).toBe(true)
  })

  test("decline is the ordinary answer; nothing moves", async () => {
    const { el, calls } = mount([tidy()])
    button(el, "decline")!.click()
    await settle()
    expect(calls.answer.length).toBe(1)
    expect((calls.answer[0] as { option: string }).option).toBe("decline")
    expect(calls.place.length).toBe(0)
  })

  test("a preflight refusal names the first failing mission (N8-175); a stop after the answer shows N8-167 and an error toast", async () => {
    const first = mount([tidy()], { place: async () => ({ ok: false, code: "REHOME_TARGET_EXISTS", message: "x", mission: B }) })
    button(first.el, "approve")!.click()
    await settle()
    const alert = first.el.querySelector("[data-mission-decision-error]")
    const want = tr("session.mission.move.error.failed", { reason: `${B}: ${tr("session.mission.move.error.targetExists")}` })
    expect(alert?.textContent === want).toBe(true)
    expect(first.calls.toast.length).toBe(0)
    dispose()
    document.body.innerHTML = ""
    const second = mount([tidy()], { place: async () => ({ ok: false, code: "REHOME_ROLLED_BACK", message: "x", mission: B, moved: 1, total: 2 }) })
    button(second.el, "approve")!.click()
    await settle()
    const stopped = tr("session.mission.tidy.stopped", { mission: B, reason: tr("session.mission.move.error.rolledBack") })
    expect(second.el.querySelector("[data-mission-decision-error]")?.textContent === stopped).toBe(true)
    expect(second.calls.toast.length).toBe(1)
    expect(`${second.calls.toast[0]![0] === stopped} ${second.calls.toast[0]![1]}`).toBe("true error")
  })

  test("progress N8-165 shows while the apply runs; approve waits while a session is busy, decline does not", async () => {
    let release: (v: PlaceResult) => void = () => {}
    const { el } = mount([tidy()], { place: () => new Promise<PlaceResult>((resolve) => (release = resolve)) })
    button(el, "approve")!.click()
    await tick()
    expect(el.querySelectorAll("[data-mission-tidy-progress]").length).toBe(1)
    expect((el.textContent ?? "").includes(tr("session.mission.tidy.progress", { done: "0", total: "2" }))).toBe(true)
    release({ ok: true, data: { decision: "U2", moved: 2, total: 2 } })
    await settle()
    expect(el.querySelectorAll("[data-mission-tidy-progress]").length).toBe(0)
    dispose()
    document.body.innerHTML = ""
    const busy = mount([tidy()], { busy: true })
    expect(button(busy.el, "approve")?.disabled).toBe(true)
    expect(button(busy.el, "decline")?.disabled).toBe(false)
    expect(busy.el.querySelectorAll("[data-mission-placement-wait]").length).toBe(1)
  })
})

describe("1.2.8 row 46b C98: retry an answered placement whose move did not finish", () => {
  test("the person's attested join answer and the mission still at the root: one retry button in the decision card", async () => {
    const { el, calls } = mount([answeredPlacement()], { place: async () => ({ ok: true, data: { decision: "U1", group: "DEMS" } }) })
    expect(el.querySelectorAll("[data-mission-decision]").length).toBe(1)
    expect(el.querySelectorAll("[data-mission-retry]").length).toBe(1)
    // row 24a (C99): the card's own keys, not the borrowed move-error / option labels.
    expect(el.querySelector("[data-mission-unplaced]")?.textContent === tr("session.mission.placement.unplaced")).toBe(true)
    expect(el.querySelector("[data-mission-retry]")?.textContent === tr("session.mission.placement.retry", { group: "DEMS" })).toBe(true)
    el.querySelector<HTMLButtonElement>("[data-mission-retry]")!.click()
    await settle()
    expect(calls.place.length).toBe(1)
    const sent = calls.place[0] as Record<string, string>
    expect(`${sent.mission === buildMission(fixture(), "en").id} ${sent.request} ${sent.option}`).toBe("true D-1 join")
    expect(calls.answer.length).toBe(0)
    expect(calls.toast[0]![0] === tr("session.mission.move.done", { group: "DEMS" })).toBe(true)
  })

  test("a failed retry shows the mapped text in the card's alert", async () => {
    const { el } = mount([answeredPlacement()], { place: async () => ({ ok: false, code: "REHOME_BUSY", message: "x" }) })
    el.querySelector<HTMLButtonElement>("[data-mission-retry]")!.click()
    await settle()
    expect(el.querySelector("[data-mission-decision-error]")?.textContent === tr("session.mission.move.error.busy")).toBe(true)
  })

  test("no retry: already in the group, an answer not attested or by an agent, root, or while another request is open", () => {
    const cases: Array<[string, unknown[], string | undefined]> = [
      ["in group", [answeredPlacement()], `${ROOT}/DEMS`],
      ["unattested", [answeredPlacement({ attested: false })], undefined],
      ["attested absent", [answeredPlacement({ attested: undefined })], undefined],
      ["controller", [answeredPlacement({ by: "controller" })], undefined],
      ["root", [answeredPlacement({ option: "root" })], undefined],
      ["open tidy", [answeredPlacement(), tidy()], undefined],
    ]
    for (const [name, requests, dir] of cases) {
      const { el } = mount(requests, dir ? { dir } : {})
      expect(`${name} ${el.querySelectorAll("[data-mission-retry]").length}`).toBe(`${name} 0`)
      dispose()
      document.body.innerHTML = ""
    }
  })
})
