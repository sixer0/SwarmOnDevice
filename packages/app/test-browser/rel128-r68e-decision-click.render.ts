// Swarm 1.2.8 row 68e (C175, live RC2 line 16), render half. Run by rel128-r68e-decision-click.test.ts.
// The real MissionControl (real poll controller, real MissionCommand) at the narrow Activity pane width (sheet mode),
// with one open decision. happy-dom has no layout, so this half pins what the Chromium half relies on and writes the
// rendered section in two states for it: the sheet closed (first paint) and open (after the person's "Decisions" click).
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { fixture } from "@/pages/session/swarm/mission-deliverables.fixture"
import type { MissionGetWire, MissionListItemWire } from "@/pages/session/swarm/mission-model"

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
const dialogs = await import("@opencode-ai/ui/context/dialog")
mock.module("@opencode-ai/ui/context/dialog", () => ({
  ...dialogs,
  useDialog: () => ({ show: () => {}, close: () => {} }),
}))

// The real surface, not a copy. A computed path keeps the views out of this folder's typecheck.
const { MissionControl } = await import(
  new URL("../src/pages/session/swarm/mission-control.tsx", import.meta.url).pathname
)
const { createMissionControl } = await import(
  new URL("../src/pages/session/swarm/mission-poll.ts", import.meta.url).pathname
)

const dump = process.env.R68E_DUMP_DIR

// The live LPR shape (synthetic): one open decision with three options.
function wire(): MissionGetWire {
  const base = fixture()
  return {
    ...base,
    requests: [
      {
        id: "D-1",
        question: "Where should this mission live?",
        options: [
          { id: "O1", label: "Join Alfa", consequence: "Product" },
          { id: "O2", label: "New group Bravo", consequence: "Research theme" },
          { id: "O3", label: "Keep at the root", consequence: "Nothing moves" },
        ],
        recommended: "O2",
        status: "open",
        createdAt: "2026-11-14T08:00:00Z",
      },
    ],
  }
}
const item = (w: MissionGetWire): MissionListItemWire => ({
  id: w.mission.id,
  title: w.mission.title,
  type: w.mission.type,
  status: w.mission.status,
  progress: w.derived.progress,
  openRequests: ["D-1"],
  updatedAt: "t1",
})
const source = {
  list: async () => ({ ok: true as const, data: { items: [item(wire())] } }),
  get: async () => ({ ok: true as const, data: wire() }),
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
const q = (sel: string) => document.querySelector<HTMLElement>(sel)
const click = (el: Element | null) => el!.dispatchEvent(new MouseEvent("click", { bubbles: true }))

// 355 px: the 372 px Activity pane less the section's margins (row 144), as at 1280x800 and 1024x640 live.
async function mount() {
  const answers: string[] = []
  const writer = {
    answer: async (input: { option?: string }) => {
      answers.push(String(input?.option ?? "?"))
      return { ok: true as const, data: { decision: "U1", released: [] } }
    },
    instruct: async () => ({ ok: true as const, data: { seq: 1 } }),
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => {
    const control = createMissionControl({
      source,
      directory: () => "/repo",
      sessions: () => ["ses_r68e0001"],
      lang: () => "en",
      watching: () => true,
      mapOpen: () => true,
    })
    return createComponent(MissionControl, { control, writer, prompt: async () => {}, width: 355 })
  }, host)
  await until(() => !!q("[data-mission-option]"))
  return { host, answers }
}

describe("1.2.8 row 68e: the decision sheet in sheet mode", () => {
  test("closed on first paint: the side panel is inert and moved out; the dock offers Decisions", async () => {
    const { host } = await mount()
    expect(q("[data-mission-control]")!.dataset.missionLayout).toBe("sheet")
    expect(q("[data-mission-control]")!.dataset.missionSheet).toBe("closed")
    expect(q("[data-mission-side]")!.hasAttribute("inert")).toBe(true)
    expect(q("[data-mission-side]")!.className.includes("translate-y-[105%]")).toBe(true)
    expect(document.querySelectorAll("[data-mission-dock-item='decisions']").length).toBe(1)
    expect(document.querySelectorAll("[data-mission-decision] [data-mission-option]").length).toBe(3)
    if (dump) writeFileSync(path.join(dump, "closed.html"), host.innerHTML)
  })

  test("open after the Decisions click: not inert, in place; an option click reaches its handler (answer)", async () => {
    const { host, answers } = await mount()
    click(q("[data-mission-dock-item='decisions']"))
    await until(() => q("[data-mission-control]")!.dataset.missionSheet === "open")
    expect(q("[data-mission-side]")!.hasAttribute("inert")).toBe(false)
    expect(q("[data-mission-side]")!.className.includes("translate-y-[105%]")).toBe(false)
    if (dump) writeFileSync(path.join(dump, "open.html"), host.innerHTML)
    // The handler is a delegated Solid click on the button: a click whose target is the button answers.
    click(q("[data-mission-option='O1']"))
    await until(() => answers.length > 0)
    expect(answers.length).toBe(1)
  })
})
