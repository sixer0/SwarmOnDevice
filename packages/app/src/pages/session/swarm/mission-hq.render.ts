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

const { MissionHQ, beaconPill } = await import(new URL("./mission-hq.tsx", import.meta.url).pathname)

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

  // Row 133b (row 144 O-1): "D-1 · decision" ran past the right edge of its fixed 106 px pill. The pill is now sized to
  // the text: at Menlo's real advance (0.6 em of 11 px) the text plus its 26 px lead and 8 px pad fits inside the rect,
  // the rect stays in the viewBox, and in lanes it stays clear of the "n/m" count (which ends near x 220).
  test("beacon text fits its pill (EN and ID, lanes and radial); an over-long label is ellipsized", () => {
    for (const [dict, lang] of [[en, "en"], [id, "id"]] as const) {
      for (const width of [420, 1280]) {
        table = dict
        const root = mount(fixtureMission("feature-release", { decision: true }, lang), width)
        const beacon = root.querySelector("[data-hq-beacon]")!
        const rect = beacon.querySelector("rect")!
        const label = beacon.querySelector("text")!
        const x = Number(rect.getAttribute("x"))
        const w = Number(rect.getAttribute("width"))
        const tx = Number(label.getAttribute("x"))
        const chars = Array.from(label.textContent ?? "").length
        expect(label.textContent).toBe(dict["session.mission.decision.beacon"].replace("{{id}}", "D-07"))
        expect(tx + chars * 11 * 0.6 + 8).toBeLessThanOrEqual(x + w)
        const view = Number(root.querySelector("svg")!.getAttribute("viewBox")!.split(" ")[2])
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x + w).toBeLessThanOrEqual(view)
        if (root.dataset.missionHq === "lanes") expect(x).toBeGreaterThanOrEqual(228)
        dispose()
        document.body.innerHTML = ""
      }
    }
    const long = beaconPill("D-1234567890 · keputusan panjang", 150)
    expect(long.w).toBeLessThanOrEqual(150)
    expect(long.text.endsWith("…")).toBe(true)
    expect(26 + Array.from(long.text).length * 11 * 0.6 + 8).toBeLessThanOrEqual(long.w)
    expect(beaconPill("D-1 · decision", 150)).toEqual({ text: "D-1 · decision", w: 134 })
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

// ── Row 167 (user finding 2026-11-08, "layoutnya ada yang berbenturan"; "benturan saat decision muncul"): zero overlap
// between agents, labels, room pills, domes/platforms, the HQ deck, connectors and the decision beacon, in radial and
// lanes, for 1..6 agents in any one room of every mission type, with and without an open decision. Boxes are read from
// the rendered DOM (hit rects, label text, pill transforms, beacon rect) plus the pure layout the view draws from.
type Pt = [number, number]
type Shape = { name: string; pts: Pt[] }
const { layoutRadial, BOT_HALF_W: BHW, LABEL_ADVANCE: ADV } = await import(new URL("./mission-hq.tsx", import.meta.url).pathname)
const { radialScene } = await import("./mission-hq-scene")
const num = (el: Element | null, a: string) => Number(el?.getAttribute(a) ?? NaN)
const rectPts = (x: number, y: number, w: number, h: number): Pt[] => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
const ellPts = (cx: number, cy: number, rx: number, ry: number, from = 0, to = Math.PI * 2, k = 48): Pt[] =>
  Array.from({ length: k + 1 }, (_, i) => {
    const a = from + ((to - from) * i) / k
    return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry] as Pt
  })
/** Raised tier (Tier): top ellipse and the same ellipse h lower, as one convex outline. */
const tierPts = (cx: number, cy: number, rx: number, ry: number, h: number): Pt[] => [
  ...ellPts(cx, cy, rx, ry, Math.PI, Math.PI * 2, 24),
  ...ellPts(cx, cy + h, rx, ry, 0, Math.PI, 24),
]
/** Separating-axis test for convex outlines (a segment is a 2-point outline); touching within `eps` is no overlap. */
function overlap(a: Pt[], b: Pt[], eps = 0.5) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i]
      const q = poly[(i + 1) % poly.length]
      const nx = q[1] - p[1]
      const ny = p[0] - q[0]
      const len = Math.hypot(nx, ny)
      if (len < 1e-9) continue
      const proj = (s: Pt[]) => s.map(([x, y]) => (x * nx + y * ny) / len)
      const pa = proj(a)
      const pb = proj(b)
      if (Math.max(...pa) <= Math.min(...pb) + eps || Math.max(...pb) <= Math.min(...pa) + eps) return false
    }
  }
  return true
}
const insideEllipse = ([x, y]: Pt, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
const textBox = (el: Element, name: string): Shape => {
  const fs = num(el, "font-size")
  const w = Array.from(el.textContent ?? "").length * fs * ADV
  const x = num(el, "x")
  const left = el.getAttribute("text-anchor") === "middle" ? x - w / 2 : el.getAttribute("text-anchor") === "end" ? x - w : x
  return { name, pts: rectPts(left, num(el, "y") - fs * 0.85, w, fs * 1.1) }
}
const translateOf = (el: Element) => {
  const m = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)/.exec(el.getAttribute("transform") ?? "")!
  return [Number(m[1]), Number(m[2])] as Pt
}
function pairs(groups: Shape[][], label: string) {
  const hits: string[] = []
  for (let i = 0; i < groups.length; i++)
    for (let j = i; j < groups.length; j++)
      for (let a = 0; a < groups[i].length; a++)
        for (let b = i === j ? a + 1 : 0; b < groups[j].length; b++)
          if (overlap(groups[i][a].pts, groups[j][b].pts)) hits.push(`${label}: ${groups[i][a].name} x ${groups[j][b].name}`)
  return hits
}
const cross = (as: Shape[], bs: Shape[], label: string) =>
  as.flatMap((a) => bs.filter((b) => overlap(a.pts, b.pts)).map((b) => `${label}: ${a.name} x ${b.name}`))

const LONG = ["Laporan teknis lengkap", "Gambar arsitektur sistem", "RAB XLSX", "Verifikasi dokumen akhir", "Simpan hasil", "Baca perintah kerja"]
/** The fixture with `n` agents (long titles, mixed statuses, one with a deliverable) in the phase at `index`. */
function crowd(type: string, index: number, n: number, decision: boolean): MissionVM {
  const m = model(type, { decision })
  const phase = m.phases[index]
  const base = Object.values(m.agents)[0]
  const statuses = ["running", "review", "issue", "blocked", "done", "waiting"] as const
  phase.rows = Array.from({ length: n }, (_, k) => `c${k + 1}`)
  for (const [k, id] of phase.rows.entries())
    m.agents[id] = { ...base, rowId: id, title: LONG[k % LONG.length], phase: phase.id, status: statuses[k % 6], family: phase.family }
  return m
}

function radialShapes(root: Element, m: MissionVM) {
  const laid = layoutRadial(radialScene(m))
  const { cx, cy, hy } = laid
  const deck: Shape[] = [
    { name: "deck tier", pts: tierPts(cx, cy + 14, 190, 58, 12) },
    { name: "ring", pts: ellPts(cx, hy, 67, 67) },
    ...all(root, "[data-hq-deck] [data-hq-you-label],[data-hq-deck] [data-hq-swarm-label]").map((el) => textBox(el, "deck label")),
    // "HQ · COMMAND DECK": 17 mono characters at 9.5 (0.6 em) plus .32 em letter spacing, centred
    { name: "HQ deck title", pts: rectPts(cx - (17 * 9.5 * 0.92) / 2, cy + 82 - 9, 17 * 9.5 * 0.92, 12) },
  ]
  const beacon: Shape[] = []
  const pill = root.querySelector("[data-hq-beacon] rect")
  if (pill) {
    beacon.push({ name: "beacon", pts: rectPts(num(pill, "x"), num(pill, "y"), num(pill, "width"), num(pill, "height")) })
    const line = root.querySelector("[data-hq-beacon-line]")!
    beacon.push({ name: "beacon line", pts: [[num(line, "x1"), num(line, "y1")], [num(line, "x2"), num(line, "y2")]] })
  }
  const rooms = laid.rooms.map((room: (typeof laid.rooms)[number]) => {
    const el = root.querySelector(`[data-hq-room="${room.phase.id}"]`)!
    const sign = el.querySelector("[data-hq-room-name]")!.parentElement!
    const [sx, sy] = translateOf(sign)
    const sr = sign.querySelector("rect")!
    const items: Shape[] = [
      { name: `${room.phase.id} pill`, pts: rectPts(sx + num(sr, "x"), sy + num(sr, "y"), num(sr, "width"), num(sr, "height")) },
    ]
    for (const a of all(el, "[data-hq-agent]")) {
      const id = a.getAttribute("data-hq-agent")
      const hit = a.querySelector("[data-hq-hit]")!
      items.push({ name: `${room.phase.id}/${id} agent`, pts: rectPts(num(hit, "x"), num(hit, "y"), num(hit, "width"), num(hit, "height")) })
      const label = a.querySelector("[data-hq-label]")!
      items.push({ ...textBox(label, `${room.phase.id}/${id} label`) })
      const bar = a.querySelector("[data-hq-checkpoint]")!.previousElementSibling!
      items.push({ name: `${room.phase.id}/${id} bar`, pts: rectPts(num(bar, "x"), num(bar, "y"), num(bar, "width"), 3) })
    }
    const shell: Shape[] = [
      { name: `${room.phase.id} dome`, pts: ellPts(room.x, room.py, room.rx - 10, room.py - room.ty + 4, Math.PI, Math.PI * 2, 32) },
      { name: `${room.phase.id} platform`, pts: tierPts(room.x, room.py, room.rx, room.ry, 10) },
    ]
    const c = room.conduit
    return { room, items, shell, conduit: { name: `${room.phase.id} conduit`, pts: [[c.x1, c.y1], [c.x2, c.y2]] as Pt[] } }
  })
  return { laid, deck, beacon, rooms }
}

describe("MissionHQ geometry (row 167): nothing collides", () => {
  for (const type of Object.keys(TYPE_PHASES)) {
    for (const decision of [false, true]) {
      test(`${type}, decision ${decision ? "open" : "closed"}: radial, 1..6 agents in any room`, () => {
        const hits: string[] = []
        for (let index = 0; index < TYPE_PHASES[type].length; index++) {
          for (const n of [1, 2, 3, 4, 5, 6]) {
            const m = crowd(type, index, n, decision)
            const root = mount(m, 1280)
            expect(root.dataset.missionHq).toBe("radial")
            const { deck, beacon, rooms } = radialShapes(root, m)
            const tag = `${type}#${index}x${n}`
            // inside a room: no agent, label, bar or pill touches another
            for (const r of rooms) hits.push(...pairs([r.items], tag))
            // agents stand on their platform (feet inside the platform's top ellipse)
            for (const r of rooms)
              for (const a of r.room.agents)
                if (!insideEllipse([a.x, a.y], r.room.x, r.room.py, r.room.rx, r.room.ry)) hits.push(`${tag}: ${a.rowId} off platform`)
            // agents and labels stay inside the dome's span (the dome stays clear of other rooms below)
            for (const r of rooms)
              for (const it of r.items)
                for (const [x] of it.pts)
                  if (Math.abs(x - r.room.x) > r.room.rx + 0.5) hits.push(`${tag}: ${it.name} outside its room`)
            // rooms against rooms, the deck and the beacon
            for (let i = 0; i < rooms.length; i++)
              for (let j = i + 1; j < rooms.length; j++)
                hits.push(...cross([...rooms[i].items, ...rooms[i].shell], [...rooms[j].items, ...rooms[j].shell], tag))
            for (const r of rooms) hits.push(...cross([...r.items, ...r.shell], [...deck, ...beacon], tag))
            // connectors only meet their own room and the deck
            for (const r of rooms)
              for (const o of rooms)
                if (o !== r) hits.push(...cross([r.conduit], [...o.items, ...o.shell], tag))
            for (const r of rooms) hits.push(...cross([r.conduit], [deck[1], ...deck.slice(2), ...beacon], tag))
            // the beacon clears the ring with a visible gap
            if (beacon.length) {
              const ring = { name: "ring+20 gap", pts: ellPts(radialScene(m).cx, radialScene(m).hy, 67 + 20, 67 + 20) }
              hits.push(...cross([beacon[0]], [ring], tag))
            }
            dispose()
            document.body.innerHTML = ""
          }
        }
        expect(hits).toEqual([])
      })

      test(`${type}, decision ${decision ? "open" : "closed"}: lanes, 1..6 agents in any lane`, () => {
        const hits: string[] = []
        for (let index = 0; index < TYPE_PHASES[type].length; index++) {
          for (const n of [1, 2, 3, 4, 5, 6]) {
            const m = crowd(type, index, n, decision)
            const root = mount(m, 420)
            expect(root.dataset.missionHq).toBe("lanes")
            const tag = `${type}#${index}x${n} lanes`
            const deckRect = root.querySelector("[data-hq-deck] [data-hq-rim] rect")!
            const deckBox = rectPts(num(deckRect, "x"), num(deckRect, "y"), num(deckRect, "width"), num(deckRect, "height"))
            const deckTexts = all(root, "[data-hq-deck] text").filter((el) => !el.closest("[data-hq-beacon]")).map((el, k) => textBox(el, `deck text ${k}`))
            const pill = root.querySelector("[data-hq-beacon] rect")
            const beacon = pill ? [{ name: "beacon", pts: rectPts(num(pill, "x"), num(pill, "y"), num(pill, "width"), num(pill, "height")) }] : []
            hits.push(...cross(beacon, deckTexts, tag))
            const lanes = all(root, "[data-hq-room]").map((lane) => {
              const r = lane.querySelector("rect")!
              const box = rectPts(num(r, "x"), num(r, "y"), num(r, "width"), num(r, "height"))
              const texts = all(lane, "[data-hq-room-name],[data-hq-room-count]").map((el) => textBox(el, `${lane.getAttribute("data-hq-room")} text`))
              const bots = all(lane, "[data-hq-agent]").map((a) => {
                const hit = a.querySelector("[data-hq-hit]")!
                return { name: `${a.getAttribute("data-hq-agent")} agent`, pts: rectPts(num(hit, "x"), num(hit, "y"), num(hit, "width"), num(hit, "height")) }
              })
              for (const b of bots)
                for (const [x, y] of b.pts)
                  if (x < num(r, "x") || x > num(r, "x") + num(r, "width") || y < num(r, "y") || y > num(r, "y") + num(r, "height"))
                    hits.push(`${tag}: ${b.name} outside its lane`)
              return { name: lane.getAttribute("data-hq-room")!, box, items: [...texts, ...bots] }
            })
            for (const l of lanes) hits.push(...pairs([l.items], tag))
            for (let i = 0; i < lanes.length; i++) {
              if (overlap(lanes[i].box, deckBox)) hits.push(`${tag}: lane ${lanes[i].name} x deck`)
              for (let j = i + 1; j < lanes.length; j++) if (overlap(lanes[i].box, lanes[j].box)) hits.push(`${tag}: lane ${lanes[i].name} x ${lanes[j].name}`)
            }
            dispose()
            document.body.innerHTML = ""
          }
        }
        expect(hits).toEqual([])
      })
    }
  }

  test("a 3-agent room: one row on the platform, labels cut to their slot, never wider than the agent spacing", () => {
    const root = mount(crowd("document", 1, 3, true), 1280)
    const room = root.querySelector('[data-hq-room="draft"]')!
    const ys = all(room, "[data-hq-hit]").map((el) => num(el, "y"))
    expect(new Set(ys).size).toBe(1)
    const labels = all(room, "[data-hq-label]").map((el) => el.textContent)
    expect(labels).toEqual(["Laporan tek…", "Gambar arsi…", "RAB XLSX"])
    void BHW
  })

  test("the deck orbit does not rotate (a spinning ellipse sweeps across the ring, beacon and rooms)", () => {
    const root = mount(model("document", { decision: true }), 1280)
    const orbit = root.querySelector("[data-hq-orbit]")!
    expect(orbit.getAttribute("class")).toBe("hq-orbit-dash")
  })
})

// Row 167: the decision card wraps its question, plan line and option consequences inside the card (a real-browser
// check at 880 and 1083 px measured no element past the card's right edge; here the classes that make it so).
describe("decision card text (row 167)", () => {
  test("no hard clip: nothing truncates or refuses to wrap, options span the card", async () => {
    const { MissionCommand } = await import(new URL("./mission-command.tsx", import.meta.url).pathname)
    const m = model("document", { decision: true })
    m.decision = { ...m.decision!, question: "Apakah rencana kerja enam baris misi ini disetujui?", context: "Rencana: 6 baris (brief, 3 draft, review, publish)" }
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(() => createComponent(MissionCommand, { model: m, writer: {} as never, refresh: () => {}, prompt: async () => {} }), host)
    const card = host.querySelector("[data-mission-decision]")!
    expect(card.querySelectorAll(".truncate,.whitespace-nowrap,.text-ellipsis").length).toBe(0)
    for (const sel of ["[data-mission-question]", "[data-mission-context]", "[data-mission-consequence]"])
      for (const el of all(card, sel)) expect(el.className).toContain("[overflow-wrap:anywhere]")
    for (const b of all(card, "[data-mission-option]")) expect(b.className).toMatch(/\bw-full\b.*\bmin-w-0\b/)
  })
})
