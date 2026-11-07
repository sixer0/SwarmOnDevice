// Row 130: the HQ command deck rendered in the test DOM. Run by mission-hq.test.ts in its own process
// (`bun test --conditions=browser --preload ./happydom.ts ./src/pages/session/swarm/mission-hq.render.ts`) because it
// compiles Solid JSX with the app's babel preset and replaces the language context with `mock.module`.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import { fixtureMission, TYPE_PHASES, type FixtureOptions } from "./mission-hq.fixture"
import type { MissionVM } from "./mission-model"

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

let table: Record<string, string> = en
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => params?.[name] ?? ""),
  }),
}))

const { MissionHQ } = await import(new URL("./mission-hq.tsx", import.meta.url).pathname)

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
  table = en
})

type Mount = { selected?: string; onSelectAgent?: (id: string) => void; onOpenDecision?: () => void }
function mount(mission: MissionVM, width: number, extra: Mount = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(MissionHQ, { mission, width, ...extra }), host)
  return host.querySelector<HTMLElement>("[data-mission-hq]")!
}
const all = (root: Element, sel: string) => Array.from(root.querySelectorAll(sel))
const text = (root: Element, sel: string) => root.querySelector(sel)?.textContent ?? ""
const model = (type: string, opts?: FixtureOptions) => fixtureMission(type, opts)

describe("MissionHQ", () => {
  for (const type of Object.keys(TYPE_PHASES)) {
    for (const width of [1280, 420]) {
      test(`${type} at ${width} px: only the type's phases, in order, with their agents`, () => {
        const m = model(type)
        const root = mount(m, width)
        expect(root.dataset.missionHq).toBe(width >= 540 ? "radial" : "lanes")
        expect(root.dataset.missionType).toBe(type)
        const rooms = all(root, "[data-hq-room]")
        expect(rooms.map((r) => r.getAttribute("data-hq-room"))).toEqual(TYPE_PHASES[type].map(([pid]) => pid))
        expect(rooms.map((r) => r.querySelector("[data-hq-room-name]")?.textContent)).toEqual(
          TYPE_PHASES[type].map(([, , name]) => name.toUpperCase()),
        )
        for (const room of rooms) {
          const phase = m.phases.find((p) => p.id === room.getAttribute("data-hq-room"))!
          expect(all(room, "[data-hq-agent]").map((a) => a.getAttribute("data-hq-agent"))).toEqual(phase.rows)
          expect(text(room, "[data-hq-room-count]")).toBe(`${phase.done}/${phase.total}`)
          expect(room.getAttribute("data-family")).toBe(phase.family)
        }
        // dropped row 9 is never drawn; every other row is, with its status
        expect(root.querySelector('[data-hq-agent="9"]')).toBeNull()
        expect(all(root, "[data-hq-agent]").length).toBe(8)
      })
    }
  }

  test("ring: pct and n/m from the model (radial and lanes)", () => {
    const m = model("feature-release")
    expect(m.progress).toEqual({ done: 2, total: 8, pct: 25 })
    for (const width of [1280, 420]) {
      const root = mount(m, width)
      expect(text(root, "[data-hq-pct]")).toBe("25%")
      expect(text(root, "[data-hq-count]")).toBe("2/8")
      if (width >= 540) expect(root.querySelector("[data-hq-arc]")?.getAttribute("stroke-dasharray")).toBe("25 100")
      dispose()
      document.body.innerHTML = ""
    }
  })

  test("decision beacon only while a decision is open; rim turns review; click and Enter open it", () => {
    for (const width of [1280, 420]) {
      const quiet = mount(model("debug", { answered: true }), width)
      expect(quiet.querySelector("[data-hq-beacon]")).toBeNull()
      expect(quiet.querySelector("[data-hq-rim]")?.getAttribute("data-hq-rim")).toBe("glow")
      dispose()
      document.body.innerHTML = ""

      let opened = 0
      const root = mount(model("debug", { decision: true }), width, { onOpenDecision: () => opened++ })
      const beacon = root.querySelector("[data-hq-beacon]")!
      expect(beacon.getAttribute("data-hq-beacon")).toBe("D-07")
      expect(beacon.textContent).toBe("D-07 · decision")
      expect(beacon.getAttribute("aria-label")).toBe("Open decision D-07")
      expect(root.querySelector("[data-hq-rim]")?.getAttribute("data-hq-rim")).toBe("review")
      beacon.dispatchEvent(new MouseEvent("click", { bubbles: true }))
      beacon.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
      expect(opened).toBe(2)
      dispose()
      document.body.innerHTML = ""
    }
  })

  test("agent status, badge, lamp cone, held row and the label/checkpoint bar", () => {
    const root = mount(model("feature-release", { decision: true }), 1280)
    const status = (rid: string) => root.querySelector(`[data-hq-agent="${rid}"]`)!.getAttribute("data-status")
    expect(["1", "3", "4", "5", "6", "7"].map(status)).toEqual(["done", "running", "review", "issue", "blocked", "waiting"])
    const agent = (rid: string) => root.querySelector(`[data-hq-agent="${rid}"]`)!
    expect(agent("3").querySelector("[data-hq-cone]")).not.toBeNull()
    expect(agent("4").querySelector("[data-hq-cone]")).not.toBeNull()
    expect(agent("5").querySelector("[data-hq-cone]")).not.toBeNull()
    expect(agent("6").querySelector("[data-hq-cone]")).toBeNull()
    expect(agent("1").querySelector("[data-hq-badge]")?.getAttribute("data-hq-badge")).toBe("done")
    expect(agent("5").querySelector("[data-hq-badge]")?.getAttribute("data-hq-badge")).toBe("issue")
    expect(agent("6").querySelector("[data-hq-badge]")?.getAttribute("data-hq-badge")).toBe("blocked")
    expect(agent("3").querySelector("[data-hq-label]")?.textContent).toBe("A very long …")
    expect(agent("3").querySelector("[data-hq-checkpoint]")?.getAttribute("data-hq-checkpoint")).toBe("2/5")
    expect(agent("3").getAttribute("aria-label")).toBe("data-collector: A very long row title for the label, Running")
    // deliverable marker on its row (docKey row-2-...)
    expect(agent("2").querySelector("[data-hq-doc]")).not.toBeNull()
    // live phase: conduit flows; a phase with no running/review/issue row does not
    expect(all(root, '[data-hq-conduit="live"]').length).toBeGreaterThan(0)
    expect(root.querySelector('[data-hq-room="identification"]')?.hasAttribute("data-live")).toBe(false)
    expect(root.querySelector('[data-hq-room="research"]')?.hasAttribute("data-live")).toBe(true)
  })

  test("agent click and keyboard select the row; selected label is ink", () => {
    const picked: string[] = []
    const root = mount(model("document"), 1280, { selected: "3", onSelectAgent: (rid) => picked.push(rid) })
    const a = root.querySelector('[data-hq-agent="4"]')!
    a.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    a.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }))
    expect(picked).toEqual(["4", "4"])
    expect(root.querySelector('[data-hq-agent="3"]')?.getAttribute("aria-pressed")).toBe("true")
  })

  test("narrow: lanes, no legend, no row labels; wide: You + Swarm, caption and the legend", () => {
    const narrow = mount(model("research"), 539)
    expect(narrow.dataset.missionHq).toBe("lanes")
    expect(narrow.querySelector("[data-hq-legend]")).toBeNull()
    expect(narrow.querySelector("[data-hq-label]")).toBeNull()
    expect(narrow.querySelector("svg")?.getAttribute("viewBox")?.startsWith("0 0 400 ")).toBe(true)
    dispose()
    document.body.innerHTML = ""
    const wide = mount(model("research"), 540)
    expect(wide.dataset.missionHq).toBe("radial")
    expect(wide.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 1000 668")
    expect(text(wide, "[data-hq-you-label]")).toBe("You")
    expect(text(wide, "[data-hq-swarm-label]")).toBe("Swarm")
    expect(wide.textContent).toContain("HQ · COMMAND DECK")
    expect(all(wide, "[data-hq-legend] span").map((s) => s.textContent)).toEqual(["Running", "Review", "Issue", "Blocked", "Done", "Waiting"])
  })

  test("six phases fall back to lanes even when wide; Indonesian strings", () => {
    table = id
    const root = mount(fixtureMission("feature-release", { extraPhase: true, decision: true }, "id"), 1280)
    expect(root.dataset.missionHq).toBe("lanes")
    expect(all(root, "[data-hq-room]").length).toBe(6)
    expect(text(root, "[data-hq-room-name]")).toBe("IDENTIFIKASI")
    expect(root.querySelector("[data-hq-beacon]")?.textContent).toBe("D-07 · keputusan")
  })

  test("mission text is rendered as text, never markup; reduced motion stops the animations", () => {
    const m = model("research")
    m.agents["3"] = { ...m.agents["3"], title: "<img src=x onerror=alert(1)>" }
    m.phases[0] = { ...m.phases[0], name: "<b>x</b>" }
    const root = mount(m, 1280)
    expect(root.querySelector("img")).toBeNull()
    expect(root.querySelector("b")).toBeNull()
    expect(root.querySelector('[data-hq-agent="3"] [data-hq-label]')?.textContent).toBe("<img src=x o…")
    const css = root.querySelector("style")?.textContent ?? ""
    expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*\.hq-flow[^}]*animation:none\}/)
  })

  // Row 136 M3: the model is rebuilt on every poll; rooms and agents are keyed by phase id and row id, so the DOM nodes
  // stay mounted and keyboard focus on an agent survives an update (as swarm-view.tsx:361).
  for (const width of [1280, 420]) {
    test(`a model update keeps agent and room nodes and the focus (${width} px)`, () => {
      const [mission, setMission] = createSignal(model("feature-release", { decision: true }))
      const host = document.createElement("div")
      document.body.append(host)
      dispose = render(() => createComponent(MissionHQ, { get mission() { return mission() }, width }), host)
      const root = host.querySelector<HTMLElement>("[data-mission-hq]")!
      const agent = root.querySelector<SVGGElement>('[data-hq-agent="3"]')!
      const room = root.querySelector('[data-hq-room="research"]')!
      agent.focus()
      expect(document.activeElement).toBe(agent)
      // A fresh model object (as each poll builds) with one changed status and the same ids.
      const next = model("feature-release", { decision: true })
      next.agents["3"] = { ...next.agents["3"], status: "review" }
      setMission(next)
      expect(root.querySelector('[data-hq-agent="3"]')).toBe(agent)
      expect(root.querySelector('[data-hq-room="research"]')).toBe(room)
      expect(agent.getAttribute("data-status")).toBe("review")
      expect(document.activeElement).toBe(agent)
      // A removed row goes; the others stay mounted.
      const fewer = model("feature-release", { decision: true })
      for (const ph of fewer.phases) ph.rows = ph.rows.filter((r) => r !== "4")
      delete fewer.agents["4"]
      setMission(fewer)
      expect(root.querySelector('[data-hq-agent="4"]')).toBeNull()
      expect(root.querySelector('[data-hq-agent="3"]')).toBe(agent)
      expect(document.activeElement).toBe(agent)
    })
  }

  test("theme tokens are set on the root and point at the app's v2 tokens", () => {
    const root = mount(model("debug"), 1280)
    expect(root.style.getPropertyValue("--hq-run")).toContain("--v2-state-fg-info")
    expect(root.style.getPropertyValue("--hq-issue")).toContain("--v2-state-fg-danger")
    expect(root.style.getPropertyValue("--hq-done")).toContain("--v2-state-fg-success")
  })
})
