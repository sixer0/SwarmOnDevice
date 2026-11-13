// Swarm 1.2.8 row 46 (N8-367), render half. Run by rel128-proj-f-placement.test.ts.
// AC-PROJf: a `project-placement` request renders in the existing decision card (no new panel) with the app's own texts
// N8-151..N8-155 and `{{group}}` from the option field `group` (N8-454), never the agent's label; join/new wait while a
// linked session is busy (N8-453), root stays enabled; join/new go to `place`, root to `answer`.
// AC-SEC05 (N8-462): a by-user answer with `attested === false` carries the "recorded by an agent" label; true or absent
// does not. Counts and booleans only (C77: a failing expect on an element can hang bun).
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

const placement = (options?: Array<Record<string, unknown>>) => ({
  id: "D-1",
  topic: "project-placement",
  question: "Where should this mission live? (agent text)",
  context: "confidence high: title shares DEMS with group DEMS",
  options: options ?? [
    { id: "join", label: "Join Crafted-Label", consequence: "agent consequence", group: "DEMS", groupKind: "product" },
    { id: "new", label: "New group Crafted", consequence: "agent consequence", group: "Kemenkeu", groupKind: "institution" },
    { id: "root", label: "Keep crafted", consequence: "agent consequence" },
  ],
  recommended: "join",
  status: "open",
  createdAt: "2026-11-14T08:00:00Z",
})

function mount(requests: unknown[], opts: { busy?: boolean; place?: (i: unknown) => Promise<unknown> } = {}) {
  const wire = fixture()
  wire.requests = requests as never
  ;(wire.mission as { sessions?: unknown }).sessions = [{ client: "swarm", ref: SESSION }]
  const calls = { answer: [] as unknown[], place: [] as unknown[], toast: [] as string[], busyAsked: [] as string[][] }
  const writer = {
    answer: async (i: unknown) => (calls.answer.push(i), { ok: true, data: { decision: "U1", released: [] } }),
    instruct: async () => ({ ok: true, data: { seq: 1 } }),
    place: async (i: unknown) => (calls.place.push(i), opts.place ? opts.place(i) : { ok: true, data: { decision: "U1", group: "DEMS" } }),
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
        sessionBusy: (ids: string[]) => (calls.busyAsked.push(ids), opts.busy === true),
        toast: (text: string) => void calls.toast.push(text),
      }),
    el,
  )
  return { el, calls }
}
const button = (el: Element, id: string) => el.querySelector<HTMLButtonElement>(`[data-mission-option="${id}"]`)

describe("1.2.8 row 46 AC-PROJf: placement card", () => {
  test("3 buttons with N8-152..N8-154, {{group}} from the option field, kind chips, title N8-151, note N8-155", () => {
    const { el } = mount([placement()])
    expect(el.querySelectorAll("[data-mission-decision]").length).toBe(1)
    expect(el.querySelectorAll("[data-mission-option]").length).toBe(3)
    const text = el.textContent ?? ""
    expect(text.includes(tr("session.mission.placement.title"))).toBe(true)
    expect(button(el, "join")?.textContent?.includes(tr("session.mission.placement.join", { group: "DEMS" }))).toBe(true)
    expect(button(el, "new")?.textContent?.includes(tr("session.mission.placement.new", { group: "Kemenkeu" }))).toBe(true)
    expect(button(el, "root")?.textContent?.includes(tr("session.mission.placement.root"))).toBe(true)
    for (const crafted of ["Crafted", "agent consequence", "(agent text)"]) expect(text.includes(crafted)).toBe(false)
    expect(el.querySelectorAll("[data-mission-group-kind]").length).toBe(2)
    expect(button(el, "join")?.textContent?.includes(tr("session.mission.group.product"))).toBe(true)
    expect(el.querySelectorAll("[data-mission-placement-note]").length).toBe(1)
    expect(text.includes(tr("session.mission.placement.note"))).toBe(true)
    expect(el.querySelectorAll("[data-mission-recommended]").length).toBe(1)
    expect(el.querySelectorAll("[data-mission-placement-wait]").length).toBe(0)
  })

  test("a linked session is busy: join/new disabled with N8-453, root enabled", () => {
    const { el, calls } = mount([placement()], { busy: true })
    expect(button(el, "join")?.disabled).toBe(true)
    expect(button(el, "new")?.disabled).toBe(true)
    expect(button(el, "root")?.disabled).toBe(false)
    expect(el.querySelectorAll("[data-mission-placement-wait]").length).toBe(1)
    expect((el.textContent ?? "").includes(tr("session.mission.placement.waitIdle"))).toBe(true)
    expect(calls.busyAsked.some((ids) => ids.length === 1 && ids[0] === SESSION)).toBe(true)
  })

  test("join goes to place (one main action, toast N8-168); root goes to the ordinary answer", async () => {
    const first = mount([placement()])
    button(first.el, "join")!.click()
    await tick()
    await tick()
    expect(first.calls.place.length).toBe(1)
    const sent = first.calls.place[0] as { mission: string; request: string; option: string }
    expect(`${Object.keys(sent).sort().join(",")} ${sent.request} ${sent.option}`).toBe("mission,option,request D-1 join")
    expect(first.calls.answer.length).toBe(0)
    expect(first.calls.toast.length).toBe(1)
    expect(first.calls.toast[0] === tr("session.mission.move.done", { group: "DEMS" })).toBe(true)
    dispose()
    document.body.innerHTML = ""
    const second = mount([placement()])
    button(second.el, "root")!.click()
    await tick()
    await tick()
    expect(second.calls.answer.length).toBe(1)
    expect((second.calls.answer[0] as { option: string }).option).toBe("root")
    expect(second.calls.place.length).toBe(0)
  })

  test("a refused move shows the mapped text in the existing decision alert", async () => {
    const { el } = mount([placement()], { place: async () => ({ ok: false, code: "REHOME_TARGET_EXISTS", message: "x" }) })
    button(el, "join")!.click()
    await tick()
    await tick()
    const alert = el.querySelector("[data-mission-decision-error]")
    expect(alert !== null).toBe(true)
    expect(alert?.textContent === tr("session.mission.move.error.targetExists")).toBe(true)
  })

  test("SR8-17 app mirror: an option whose group fails the rule is not shown", () => {
    const { el } = mount([
      placement([
        { id: "join", label: "Join", consequence: "", group: "DEMS​", groupKind: "product" },
        { id: "new", label: "New", consequence: "", group: "docs", groupKind: "theme" },
        { id: "root", label: "Keep", consequence: "" },
      ]),
    ])
    expect(el.querySelectorAll("[data-mission-option]").length).toBe(1)
    expect(button(el, "root") !== null).toBe(true)
  })
})

describe("1.2.8 row 46 AC-SEC05: unattested answer label (N8-462)", () => {
  const answered = (id: string, minute: number, attested?: boolean) => ({
    id,
    question: "Scope?",
    options: [{ id: "a", label: `Option ${id}`, consequence: "" }],
    status: "answered",
    createdAt: "2026-11-14T07:00:00Z",
    closedAt: `2026-11-14T07:${String(minute).padStart(2, "0")}:00Z`,
    answer: { option: "a", by: "user", decision: `U${minute}`, ...(attested === undefined ? {} : { attested, via: "x" }) },
  })

  test("shown only when attested === false", () => {
    const { el } = mount([answered("D-2", 10, false), answered("D-3", 11, true), answered("D-4", 12)])
    const labels = el.querySelectorAll("[data-mission-unattested]")
    expect(labels.length).toBe(1)
    expect(labels[0]?.textContent === tr("session.mission.decision.unattested")).toBe(true)
    const line = labels[0]?.parentElement
    expect((line?.textContent ?? "").includes("D-2: Option D-2")).toBe(true)
  })
})
