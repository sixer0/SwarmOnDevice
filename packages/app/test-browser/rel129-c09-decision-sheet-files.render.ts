// Swarm 1.2.9 row 57 (AC-C09, N9-138), render half. Run by rel129-c09-decision-sheet-files.test.ts.
// The real MissionControl (real poll controller, real MissionCommand) at the narrow Activity pane width (sheet mode).
// happy-dom has no layout, so this half pins counts and booleans only (C77): the dock's Files opens the sheet; with an
// open decision it does not call scrollIntoView and the side panel stays at scrollTop 0 (the clamp of rule (b), 01c
// §3.10, yields 0 without layout); without one, scrollIntoView is called once. It writes for the Chromium half the
// rendered section (sheet closed, with and without a decision) and the source of the function showFiles runs.
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
    plural: (key: string, _count: number, params?: Record<string, string>) =>
      (table[`${key}.other`] ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params?.[name] ?? "")),
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
const controlModule = await import(new URL("../src/pages/session/swarm/mission-control.tsx", import.meta.url).pathname)
const { MissionControl } = controlModule
const { createMissionControl } = await import(
  new URL("../src/pages/session/swarm/mission-poll.ts", import.meta.url).pathname
)

const dump = process.env.C09_DUMP_DIR

// Synthetic (syn129): one open decision with three options, and the fixture's deliverables (the dock offers Files).
function wire(decision: boolean): MissionGetWire {
  const base = fixture()
  if (!decision) return { ...base, requests: [] }
  return {
    ...base,
    requests: [
      {
        id: "D-1",
        question: "Which draft goes to review first?",
        options: [
          { id: "O1", label: "Draft one", consequence: "Review starts today" },
          { id: "O2", label: "Draft two", consequence: "Review starts tomorrow" },
          { id: "O3", label: "Both together", consequence: "Review takes longer" },
        ],
        recommended: "O2",
        status: "open",
        createdAt: "2026-11-14T08:00:00Z",
      },
    ],
  }
}
const item = (w: MissionGetWire, decision: boolean): MissionListItemWire => ({
  id: w.mission.id,
  title: w.mission.title,
  type: w.mission.type,
  status: w.mission.status,
  progress: w.derived.progress,
  openRequests: decision ? ["D-1"] : [],
  updatedAt: "t1",
})

let dispose = () => {}
let restore = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  restore()
  restore = () => {}
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

// Counts scrollIntoView calls on any element (happy-dom has no layout; the call itself is what is pinned).
function spyScrollIntoView() {
  const proto = HTMLElement.prototype as unknown as { scrollIntoView?: (arg?: unknown) => void }
  const had = Object.prototype.hasOwnProperty.call(proto, "scrollIntoView")
  const before = proto.scrollIntoView
  const calls = { count: 0 }
  proto.scrollIntoView = function () {
    calls.count++
  }
  restore = () => {
    if (had) proto.scrollIntoView = before
    else delete proto.scrollIntoView
  }
  return calls
}

// 355 px: the 372 px Activity pane less the section's margins (row 144), as at 1280x800 and 1024x640 live.
async function mount(decision: boolean) {
  const w = wire(decision)
  const source = {
    list: async () => ({ ok: true as const, data: { items: [item(w, decision)] } }),
    get: async () => ({ ok: true as const, data: w }),
  }
  const writer = {
    answer: async () => ({ ok: true as const, data: { decision: "U1", released: [] } }),
    instruct: async () => ({ ok: true as const, data: { seq: 1 } }),
  }
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => {
    const control = createMissionControl({
      source,
      directory: () => "/repo",
      sessions: () => ["ses_c09a0001"],
      lang: () => "en",
      watching: () => true,
      mapOpen: () => true,
    })
    return createComponent(MissionControl, { control, writer, prompt: async () => {}, width: 355 })
  }, host)
  await until(() => !!q("[data-mission-dock-item='files']") && (!decision || !!q("[data-mission-option]")))
  return host
}

describe("1.2.9 row 57 (AC-C09): the dock's Files in sheet mode", () => {
  test("with an open decision: Files opens the sheet and keeps the side panel at the options (no scrollIntoView)", async () => {
    const host = await mount(true)
    expect(q("[data-mission-control]")!.dataset.missionLayout).toBe("sheet")
    expect(q("[data-mission-control]")!.dataset.missionSheet).toBe("closed")
    expect(document.querySelectorAll("[data-mission-decision] [data-mission-option]").length).toBe(3)
    expect(document.querySelectorAll("[data-mission-side] [data-mission-decision-actions]").length).toBe(1)
    if (dump) writeFileSync(path.join(dump, "decision.html"), host.innerHTML)
    const calls = spyScrollIntoView()
    click(q("[data-mission-dock-item='files']"))
    await until(() => q("[data-mission-control]")!.dataset.missionSheet === "open")
    expect(q("[data-mission-side]")!.hasAttribute("inert")).toBe(false)
    expect(calls.count).toBe(0)
    expect(q("[data-mission-side]")!.scrollTop).toBe(0)
    expect(document.querySelectorAll("[data-mission-option]").length).toBe(3)
  })

  test("without an open decision: Files opens the sheet and brings the deliverables into view (scrollIntoView once)", async () => {
    const host = await mount(false)
    expect(document.querySelectorAll("[data-mission-option]").length).toBe(0)
    expect(document.querySelectorAll("[data-mission-decision-actions]").length).toBe(0)
    if (dump) writeFileSync(path.join(dump, "nodecision.html"), host.innerHTML)
    const calls = spyScrollIntoView()
    click(q("[data-mission-dock-item='files']"))
    await until(() => q("[data-mission-control]")!.dataset.missionSheet === "open")
    expect(calls.count).toBe(1)
  })

  test("the side panel scroll that showFiles runs is one self-contained function (the Chromium half runs it)", () => {
    const fn = controlModule.missionFilesScroll as unknown
    expect(typeof fn).toBe("function")
    if (dump) writeFileSync(path.join(dump, "files-scroll.js"), String(fn))
  })
})
