// Row 133: the mission control mount rendered in the test DOM with a fake `window.api.missions` source, through the real
// row 129 controller (createMissionControl) and the real row 130-132 components. Run by mission-control.test.ts in its
// own process (`bun test --conditions=browser --preload ./happydom.ts ./src/pages/session/swarm/mission-control.render.ts`)
// because it compiles Solid JSX with the app's babel preset and replaces the language context with `mock.module`.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
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

const table: Record<string, string> = en
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params?.[name] ?? "")),
    locale: () => "en",
    intl: () => "en-US",
  }),
}))

const { MissionControl } = await import(new URL("./mission-control.tsx", import.meta.url).pathname)
const { SwarmAgents } = await import(new URL("./swarm-view.tsx", import.meta.url).pathname)
const { createMissionControl } = await import(new URL("./mission-poll.ts", import.meta.url).pathname)

// ── Fake source: two missions in the project, one with an open decision

function secondMission(): MissionGetWire {
  const wire = fixture()
  return {
    ...wire,
    mission: { ...wire.mission, id: "m-debug-2", title: "Fix the login loop", type: "debug", status: "paused" },
    requests: [
      {
        id: "D-1",
        question: "Ship the hotfix now?",
        options: [
          { id: "A", label: "Ship", consequence: "Users get the fix today" },
          { id: "B", label: "Wait", consequence: "One more review" },
        ],
        recommended: "A",
        status: "open",
        createdAt: "2026-11-07T10:00:00Z",
      },
    ],
  }
}
const WIRES: Record<string, () => MissionGetWire> = { "m-doc-1": fixture, "m-debug-2": secondMission }
const item = (wire: MissionGetWire, updatedAt = "t1"): MissionListItemWire => ({
  id: wire.mission.id,
  title: wire.mission.title,
  type: wire.mission.type,
  status: wire.mission.status,
  progress: wire.derived.progress,
  openRequests: (wire.requests ?? []).filter((r) => r.status === "open").map((r) => r.id),
  updatedAt,
})

function fakeSource(ids: string[]) {
  const calls: string[] = []
  return {
    calls,
    list: async (input: { directory: string }) => {
      calls.push(`list ${input.directory}`)
      return { ok: true as const, data: { items: ids.map((id) => item(WIRES[id]())) } }
    },
    get: async (input: { mission: string }) => {
      calls.push(`get ${input.mission}`)
      return { ok: true as const, data: WIRES[input.mission]() }
    },
  }
}
const writer = {
  answer: async () => ({ ok: true as const, data: { decision: "U1", released: [] } }),
  instruct: async () => ({ ok: true as const, data: { seq: 1 } }),
}

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})

async function until(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting for the DOM")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type MountOptions = { width: number; ids?: string[]; source?: unknown; watching?: boolean }
async function mount(options: MountOptions) {
  const source = options.source === undefined ? fakeSource(options.ids ?? ["m-doc-1"]) : options.source
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => {
    const control = createMissionControl({
      source: source ?? undefined,
      directory: () => "/repo",
      lang: () => "en",
      watching: () => options.watching ?? true,
      mapOpen: () => true,
    })
    return createComponent(MissionControl, { control, writer, prompt: async () => {}, width: options.width })
  }, host)
  return { host, source: source as ReturnType<typeof fakeSource> | null }
}
const q = (sel: string) => document.querySelector<HTMLElement>(sel)
const click = (el: Element | null) => el!.dispatchEvent(new MouseEvent("click", { bubbles: true }))

describe("MissionControl mount", () => {
  test("renders a mission from a fake source at 1280 px: sidebar, header, HQ, command and deliverables", async () => {
    const { source } = await mount({ width: 1280 })
    await until(() => !!q("[data-mission-hq]"))
    const root = q("[data-mission-control]")!
    expect(root.dataset.missionLayout).toBe("sidebar")
    expect(root.dataset.missionSheet).toBeUndefined()
    expect(q("[data-mission-title]")!.textContent).toBe("Kajian DATUM")
    expect(q("[data-mission-eyebrow]")!.textContent).toBe("Document")
    expect(q("[data-mission-select]")).toBeNull() // one mission: nothing to choose
    expect(q("[data-mission-waves]")!.textContent).toContain("W1 2/4")
    expect(q("[data-mission-command]")).not.toBeNull()
    expect(q("[data-mission-side]")!.hasAttribute("inert")).toBe(false)
    expect(q("[data-mission-dock]")).toBeNull()
    expect(source!.calls).toEqual(["list /repo", "get m-doc-1"])
  })

  // Row 136 M6: the section is not full height; its height is capped below one screen so the existing Agents view
  // (lanes, questions, tell) stays visible under it. Inside it the sidebar/sheet layout keeps one fixed box.
  for (const width of [1280, 420]) {
    test(`section height is capped, not full height (${width} px)`, async () => {
      await mount({ width })
      await until(() => !!q("[data-mission-hq]"))
      const cls = q("[data-mission-control]")!.className.split(/\s+/)
      expect(cls).not.toContain("h-full")
      expect(cls).toContain("h-[60vh]")
      expect(cls).toContain("max-h-[720px]")
      expect(cls).toContain("min-h-[320px]")
      expect(cls).toContain("overflow-hidden")
      const main = q("[data-mission-main]")!.className.split(/\s+/)
      expect(main).toContain("min-h-0")
      expect(main).toContain("flex-1")
      expect(q("[data-mission-stage]")!.className.split(/\s+/)).toContain("overflow-y-auto")
    })
  }

  test("900 px is still the sidebar (above 760)", async () => {
    await mount({ width: 900 })
    await until(() => !!q("[data-mission-hq]"))
    expect(q("[data-mission-control]")!.dataset.missionLayout).toBe("sidebar")
  })

  test("420 px: bottom sheet, closed by default; dock opens and toggles it; a stage click puts it away", async () => {
    await mount({ width: 420, ids: ["m-debug-2"] })
    await until(() => !!q("[data-mission-hq]"))
    const root = q("[data-mission-control]")!
    const side = () => q("[data-mission-side]")!
    expect(root.dataset.missionLayout).toBe("sheet")
    expect(root.dataset.missionSheet).toBe("closed")
    expect(side().hasAttribute("inert")).toBe(true)
    expect(side().classList.contains("translate-y-[105%]")).toBe(true)
    expect(q("[data-mission-waves]")).toBeNull() // V6 hides the waves bar in the narrow pane
    expect(q("[data-mission-eyebrow]")!.textContent).toBe("Debug · Paused")
    expect(q('[data-mission-dock-item="decisions"]')!.textContent).toBe("Decisions: 1")
    expect(q('[data-mission-dock-item="files"]')!.textContent).toMatch(/^Files \d+\/5$/)

    click(q('[data-mission-dock-item="command"]'))
    expect(root.dataset.missionSheet).toBe("open")
    expect(side().hasAttribute("inert")).toBe(false)
    expect(q('[data-mission-dock-item="command"]')!.getAttribute("aria-expanded")).toBe("true")
    click(q('[data-mission-dock-item="command"]'))
    expect(root.dataset.missionSheet).toBe("closed")

    click(q('[data-mission-dock-item="files"]'))
    expect(root.dataset.missionSheet).toBe("open")
    click(q("[data-mission-stage]"))
    expect(root.dataset.missionSheet).toBe("closed")

    // the decision beacon and an agent open the sheet; a click on an agent does not count as a stage click
    click(q("[data-hq-beacon]"))
    expect(root.dataset.missionSheet).toBe("open")
    click(q("[data-mission-stage]"))
    click(q(".hq-agent"))
    expect(root.dataset.missionSheet).toBe("open")
  })

  test("the selector lists both missions and switches the shown mission", async () => {
    const { source } = await mount({ width: 1280, ids: ["m-doc-1", "m-debug-2"] })
    await until(() => !!q("[data-mission-hq]"))
    const select = q("[data-mission-select]") as HTMLSelectElement
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Kajian DATUM", "Fix the login loop"])
    expect(q("[data-mission-title]")!.textContent).toBe("Kajian DATUM")
    select.value = "m-debug-2"
    select.dispatchEvent(new Event("change", { bubbles: true }))
    await until(() => q("[data-mission-title]")?.textContent === "Fix the login loop")
    expect(source!.calls).toContain("get m-debug-2")
    expect(q("[data-mission-decision]")).not.toBeNull()
  })

  test("absent without window.api.missions, and absent when the project has no mission", async () => {
    await mount({ width: 1280, source: null })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(q("[data-mission-control]")).toBeNull()
    dispose()
    document.body.innerHTML = ""
    const { source } = await mount({ width: 1280, ids: [] })
    await until(() => source!.calls.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(q("[data-mission-control]")).toBeNull()
  })
})

describe("SwarmAgents mount line", () => {
  const swarm = {
    model: () => undefined,
    view: { discoverFailed: false, failed: {}, folded: true },
    selectedLane: () => undefined,
    retry: () => {},
  }
  test("mission control sits at the top of the existing Agents view; without it the view is unchanged", async () => {
    const host = document.createElement("div")
    document.body.append(host)
    const source = fakeSource(["m-doc-1"])
    dispose = render(() => {
      const control = createMissionControl({
        source,
        directory: () => "/repo",
        lang: () => "en",
        watching: () => true,
        mapOpen: () => true,
      })
      return createComponent(SwarmAgents, { swarm, missions: { control, writer, prompt: async () => {} } })
    }, host)
    await until(() => !!q("[data-mission-control]"))
    const view = q('[data-component="session-swarm"]')!
    expect(view.firstElementChild?.hasAttribute("data-mission-control")).toBe(true)
    dispose()
    document.body.innerHTML = ""
    const plain = document.createElement("div")
    document.body.append(plain)
    dispose = render(() => createComponent(SwarmAgents, { swarm }), plain)
    expect(q('[data-component="session-swarm"]')).not.toBeNull()
    expect(q("[data-mission-control]")).toBeNull()
  })
})
