// Swarm 1.2.7 row 26, AC-U2 render half (N7-124; U3, C10). Run by rel127-u2-deliverable-reveal.test.ts in a child
// process (browser conditions + Solid JSX transform), the mission-deliverables.render.ts pattern.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { buildMission } from "./mission-model"
import { DOCX_X, PDF_P, REVEAL_FIXTURE_DIR as DIR, revealFixture } from "./rel127-u2-deliverable-reveal.fixture"

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
const translate = (key: string, params?: Record<string, string | number>) =>
  (table[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => String(params?.[name] ?? ""))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: translate }) }))

const { MissionDeliverables } = await import("./mission-deliverables")

const M = "m-u2"
const FOLDER = ["Tandatangani.command", "Tool.app", "notes.md", PDF_P]
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

function mount(os: "macos" | "windows" | "linux" = "macos") {
  const host = document.createElement("div")
  document.body.append(host)
  const mission = buildMission(revealFixture(), "en", new Set([DOCX_X]), new Set(FOLDER))
  const opened: string[] = []
  const revealed: string[] = []
  dispose = render(
    () =>
      createComponent(MissionDeliverables, {
        mission,
        openFile: (path: string) => opened.push(path),
        revealFile: (abs: string) => revealed.push(abs),
        directory: DIR,
        os,
      }),
    host,
  )
  const items = () => [...host.querySelectorAll<HTMLLIElement>("[data-mission-deliverables] li")]
  const item = (name: string) =>
    items().find((li) => li.querySelector("[data-mission-deliverable-name]")?.textContent === name)!
  return { host, items, item, opened, revealed }
}

describe("1.2.7 U-2 Deliverables reveal", () => {
  test("each line has exactly one sibling [data-deliverable-reveal], never inside the line button", () => {
    const ui = mount()
    expect(ui.items().length).toBe(5)
    for (const li of ui.items()) {
      expect(li.querySelectorAll("[data-deliverable-reveal]").length).toBe(1)
      expect(li.querySelector("[data-mission-deliverable] [data-deliverable-reveal]")).toBeNull()
      expect(li.querySelector("[data-deliverable-reveal]")!.tagName).toBe("BUTTON")
    }
  })

  test("label follows the OS: Reveal in Finder / Reveal in File Explorer", () => {
    let ui = mount("macos")
    const mac = ui.item("Tool.app").querySelector("[data-deliverable-reveal]")!
    expect(mac.getAttribute("aria-label")).toBe(en["session.header.reveal.finder"])
    expect(mac.getAttribute("aria-label")).toBe("Reveal in Finder")
    dispose?.()
    document.body.innerHTML = ""
    ui = mount("windows")
    const win = ui.item("Tool.app").querySelector("[data-deliverable-reveal]")!
    expect(win.getAttribute("aria-label")).toBe("Reveal in File Explorer")
  })

  test("a click reveals the absolute path; the .command line reveals and never opens", () => {
    const ui = mount()
    ui.item("Tandatangani.command").querySelector<HTMLButtonElement>("[data-deliverable-reveal]")!.click()
    ui.item("Kajian U2").querySelector<HTMLButtonElement>("[data-deliverable-reveal]")!.click()
    expect(ui.revealed).toEqual([
      `${DIR}/docs/${M}/11_deliverables/Tandatangani.command`,
      `${DIR}/docs/${M}/11_deliverables/${PDF_P}`,
    ])
    ui.item("Tandatangani.command").querySelector<HTMLButtonElement>("[data-mission-deliverable]")!.click()
    ui.item("Tool.app").querySelector<HTMLButtonElement>("[data-mission-deliverable]")!.click()
    expect(ui.opened).toEqual([])
    ui.item("notes.md").querySelector<HTMLButtonElement>("[data-mission-deliverable]")!.click()
    ui.item("Lampiran U2").querySelector<HTMLButtonElement>("[data-mission-deliverable]")!.click()
    expect(ui.opened).toEqual([`docs/${M}/11_deliverables/notes.md`, `docs/${M}/${DOCX_X}`])
    expect(ui.revealed.length).toBe(2) // the line click never reveals
  })

  test("executables carry the reveal-only tooltip; folder lines have no status badge and no not-in-project text", () => {
    const ui = mount()
    const cmd = ui.item("Tandatangani.command")
    expect(cmd.querySelector("[data-deliverable-reveal]")!.getAttribute("title")).toContain(
      en["session.mission.deliverable.revealOnly"],
    )
    expect(ui.item("notes.md").querySelector("[data-deliverable-reveal]")!.getAttribute("title")).not.toContain(
      en["session.mission.deliverable.revealOnly"],
    )
    expect(cmd.querySelector("[data-mission-deliverable-status]")).toBeNull()
    expect(cmd.querySelector("[data-mission-deliverable-verified]")).toBeNull()
    expect(cmd.querySelector("[data-mission-deliverable-absent]")).toBeNull()
    expect(cmd.querySelector("[data-mission-deliverable-format]")!.textContent).toBe("COMMAND")
    expect(ui.host.querySelector("[data-mission-deliverables-count]")!.textContent).toBe("1/2 final")
  })
})
