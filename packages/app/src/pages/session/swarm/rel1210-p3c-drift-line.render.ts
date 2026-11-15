// Swarm 1.2.10 row 50 (N10-170, AC-P3c; 01c §3.6, S10-31 panel half). The existing mission-panel drift line also says
// how many steps were changed after approval (host `derived.drift.changed`, row 49), in en and id, through the plural
// key `session.mission.line.driftChanged` (row 41, N10-083/084, PluralKey N10-099). Change-only gets a line;
// dropped-only still gets none; an older host (no `changed`) keeps the 1.2.6 line. The panel never renders a `changes`
// value. Run by rel1210-p3c-drift-line.test.ts in its own process (Solid JSX through the app's babel preset, the language
// context replaced with `mock.module`), like mission-control.render.ts. Synthetic fixtures only.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import { fixture } from "./mission-deliverables.fixture"
import type { MissionGetWire, MissionListItemWire } from "./mission-model"

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

// The real catalogues; `plural` mirrors language.tsx (Intl plural category, `.other` fallback, `count` filled in).
type Params = Record<string, string | number | boolean>
const lang = { table: en as Record<string, string>, locale: "en", intl: "en-US" }
const fill = (text: string, params: Params = {}) =>
  text.replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params[name] ?? ""))
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Params) => fill(lang.table[key] ?? key, params),
    plural: (key: string, count: number, params?: Params) => {
      const category = new Intl.PluralRules(lang.intl).select(count)
      return fill(lang.table[`${key}.${category}`] ?? lang.table[`${key}.other`] ?? `${key}.other`, { ...params, count })
    },
    locale: () => lang.locale,
    intl: () => lang.intl,
  }),
}))
const realPlatform = await import("@/context/platform")
mock.module("@/context/platform", () => ({ ...realPlatform, usePlatform: () => ({ platform: "web" }) }))

const { MissionControl } = await import(new URL("./mission-control.tsx", import.meta.url).pathname)
const { createMissionControl } = await import(new URL("./mission-poll.ts", import.meta.url).pathname)
const RENDER_SES = ["ses_p3c00001"]

// ── Fixtures: an approved mission (status line shown) carrying the row 49 wire shape

type Drift = NonNullable<MissionGetWire["derived"]["drift"]>
function approved(missionId: string, drift: unknown): MissionGetWire {
  const wire = fixture()
  return {
    ...wire,
    mission: { ...wire.mission, id: missionId, title: "syn1210 drift kajian", status: "approved" },
    derived: {
      ...wire.derived,
      approval: { decision: "U1", by: "user", autonomous: false, label: "approved (decision by: user)" },
      drift: drift as Drift,
    },
    requests: [],
  }
}
const change = (row: string, seq: number, fields: string[], changes?: unknown[]) => ({
  row,
  timeChanged: String(seq),
  decision: `C${seq}`,
  fields,
  ...(changes ? { changes } : {}),
})
const WIRES: Record<string, () => MissionGetWire> = {
  // one deps change on row 2 after approval, no row added
  "m-p3c-change": () =>
    approved("m-p3c-change", {
      count: 0,
      rows: [],
      dropped: [],
      changed: [change("2", 3, ["deps"], [{ field: "deps", from: ["1:B"], to: ["1:B", "3:C"] }])],
    }),
  // two rows added, one dropped, three change events on rows 3, 3, 4 (two distinct rows)
  "m-p3c-mixed": () =>
    approved("m-p3c-mixed", {
      count: 2,
      rows: [
        { row: "5", timeCreated: "2", decision: "U2" },
        { row: "6", timeCreated: "3", decision: "U3" },
      ],
      dropped: [{ row: "2", timeDropped: "4", decision: "U4" }],
      changed: [change("3", 5, ["agent"]), change("3", 6, ["output"]), change("4", 7, ["size"])],
    }),
  // only a dropped row: no line (1.2.6 rule)
  "m-p3c-dropped": () =>
    approved("m-p3c-dropped", {
      count: 0,
      rows: [],
      dropped: [{ row: "2", timeDropped: "4", decision: "U4" }],
      changed: [],
    }),
  // older host: no `changed` key at all
  "m-p3c-old-added": () =>
    approved("m-p3c-old-added", {
      count: 2,
      rows: [
        { row: "5", timeCreated: "2", decision: "U2" },
        { row: "6", timeCreated: "3", decision: "U3" },
      ],
      dropped: [],
    }),
  "m-p3c-old-none": () => approved("m-p3c-old-none", { count: 0, rows: [], dropped: [] }),
  // S10-31: a change whose structured values are marker strings; the panel must never render them
  "m-p3c-values": () =>
    approved("m-p3c-values", {
      count: 0,
      rows: [],
      dropped: [],
      changed: [change("2", 3, ["phase"], [{ field: "phase", from: "OLD-P3C", to: "NEW-P3C" }])],
    }),
}
const item = (wire: MissionGetWire): MissionListItemWire => ({
  id: wire.mission.id,
  title: wire.mission.title,
  type: wire.mission.type,
  status: wire.mission.status,
  progress: wire.derived.progress,
  openRequests: [],
  updatedAt: "t1",
})
const source = (missionId: string) => ({
  list: async () => ({ ok: true as const, data: { items: [item(WIRES[missionId]!())] } }),
  get: async (input: { mission: string }) => ({ ok: true as const, data: WIRES[input.mission]!() }),
})
const writer = {
  answer: async () => ({ ok: true as const, data: { decision: "U1", released: [] } }),
  instruct: async () => ({ ok: true as const, data: { seq: 1 } }),
}

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
  Object.assign(lang, { table: en, locale: "en", intl: "en-US" })
})

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the DOM")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const q = (sel: string) => document.querySelector<HTMLElement>(sel)
async function mount(missionId: string, locale: "en" | "id" = "en") {
  Object.assign(lang, locale === "en" ? { table: en, locale: "en", intl: "en-US" } : { table: id, locale: "id", intl: "id-ID" })
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => {
    const control = createMissionControl({
      source: source(missionId),
      directory: () => "/repo",
      sessions: () => RENDER_SES,
      lang: () => locale,
      watching: () => true,
      mapOpen: () => true,
    })
    return createComponent(MissionControl, { control, writer, prompt: async () => {}, width: 1280 })
  }, host)
  await until(() => !!q("[data-mission-hq]") && !!q("[data-mission-status-line]"))
}
function oneLine() {
  const lines = document.querySelectorAll<HTMLElement>("[data-mission-drift-line]")
  expect(lines.length).toBe(1)
  const line = lines[0]!
  expect(line.tagName).toBe("P") // one line, not a panel
  expect(line.getAttribute("role")).toBe("status")
  expect(line.parentElement).toBe(q("[data-mission-status-line]")!.parentElement) // next to the status line
  return line
}
const statusCount = () => q("[data-mission-status-line]")!.parentElement!.querySelectorAll('[role="status"]').length

describe("P3-c: the drift line names changed steps, en and id", () => {
  test("change-only (en): one line '1 step changed after approval.', count attribute 0, changed 1", async () => {
    await mount("m-p3c-change")
    const line = oneLine()
    expect(line.textContent).toBe(fill(en["session.mission.line.driftChanged.one"], { count: 1 }))
    expect(line.textContent).toBe("1 step changed after approval.")
    expect(line.dataset.missionDriftLine).toBe("0")
    expect(line.dataset.missionDriftChanged).toBe("1")
    expect(line.hasAttribute("data-mission-drift-dropped")).toBe(false)
  })
  test("added 2 + dropped 1 + changes on rows 3, 3, 4 (en): one line with both sentences, changed counts distinct rows", async () => {
    await mount("m-p3c-mixed")
    const line = oneLine()
    expect(line.textContent).toBe("2 steps added after approval. 2 steps changed after approval.")
    expect(line.dataset.missionDriftLine).toBe("2")
    expect(line.dataset.missionDriftDropped).toBe("1")
    expect(line.dataset.missionDriftChanged).toBe("2")
  })
  test("change-only and mixed (id)", async () => {
    await mount("m-p3c-change", "id")
    expect(oneLine().textContent).toBe("1 langkah diubah setelah persetujuan.")
    dispose()
    document.body.innerHTML = ""
    await mount("m-p3c-mixed", "id")
    const line = oneLine()
    expect(line.textContent).toBe("2 langkah ditambahkan setelah persetujuan. 2 langkah diubah setelah persetujuan.")
    expect(line.dataset.missionDriftChanged).toBe("2")
  })
  test("S10-31: the panel never renders a `changes` value (from OLD-P3C, to NEW-P3C), en and id", async () => {
    for (const locale of ["en", "id"] as const) {
      await mount("m-p3c-values", locale)
      const line = oneLine()
      expect(line.dataset.missionDriftChanged).toBe("1")
      const html = document.body.innerHTML
      expect(html.includes("OLD-P3C")).toBe(false)
      expect(html.includes("NEW-P3C")).toBe(false)
      expect(document.body.textContent!.includes("OLD-P3C")).toBe(false)
      dispose()
      document.body.innerHTML = ""
    }
  })
  test("change-only adds no element besides the one <p>: same status count as an added-only line", async () => {
    await mount("m-p3c-change")
    const changed = statusCount()
    dispose()
    document.body.innerHTML = ""
    await mount("m-p3c-old-added")
    expect(changed).toBe(statusCount())
  })
})

describe("P3-c controls: dropped-only and an older host keep the 1.2.6 behaviour", () => {
  test("dropped-only: no line", async () => {
    await mount("m-p3c-dropped")
    expect(q("[data-mission-drift-line]")).toBeNull()
  })
  test("older host without `changed`, count 0: no line", async () => {
    await mount("m-p3c-old-none")
    expect(q("[data-mission-drift-line]")).toBeNull()
  })
  test("older host without `changed`, two added: the added-only text unchanged, en and id, no changed attribute", async () => {
    await mount("m-p3c-old-added")
    const line = oneLine()
    expect(line.textContent).toBe("2 steps added after approval.")
    expect(line.dataset.missionDriftLine).toBe("2")
    expect(line.hasAttribute("data-mission-drift-changed")).toBe(false)
    expect(statusCount()).toBe(2) // the status line and the drift line, as at BASE
    dispose()
    document.body.innerHTML = ""
    await mount("m-p3c-old-added", "id")
    expect(oneLine().textContent).toBe("2 langkah ditambahkan setelah persetujuan.")
  })
})
