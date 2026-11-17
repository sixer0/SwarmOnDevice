// Swarm 1.3.3 row 72, render half (MC-8 item 5). Run by row72-mc8-open-preview.test.ts in a child process (browser
// conditions + Solid JSX transform), the mission-deliverables.render.ts pattern.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import { buildMission } from "./mission-model"
import { DIR72, DOCX_D, fixture72, HTML_D, M72, PDF_C, PDF_D } from "./row72-mc8-open-preview.fixture"

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
const translate = (key: string, params?: Record<string, string | number>) =>
  (table[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => String(params?.[name] ?? ""))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: translate }) }))

const { MissionDeliverables, MissionDeliverableLinks } = await import("./mission-deliverables")
const { deliverableLinks } = await import("./mission-deliverables-model")

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  table = en
})

function mount(input: { session?: string; bridge?: boolean } = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  const mission = buildMission(fixture72(), "en", new Set())
  const opened: string[] = []
  const system: string[] = []
  const revealed: string[] = []
  const panes: string[] = []
  dispose = render(
    () =>
      createComponent(MissionDeliverables, {
        mission,
        openFile: (path: string) => opened.push(path),
        openPane: (path: string) => panes.push(path),
        revealFile: (abs: string) => revealed.push(abs),
        openSystem: input.bridge === false ? undefined : (abs: string) => system.push(abs),
        directory: DIR72,
        sessionDirectory: input.session,
        os: "macos",
      }),
    host,
  )
  const item = (doc: string) => host.querySelector<HTMLElement>(`[data-mission-deliverable="${doc}"]`)!.closest("li")!
  const link = (doc: string, name: string) =>
    item(doc).querySelector<HTMLElement>(`[data-deliverable-link="deliverables/${M72}/${name}"]`)!
  return { host, item, link, opened, system, revealed, panes }
}

describe("1.3.3 row 72 deliverable links (DOM)", () => {
  test("no new panel: the links sit inside the existing list item, outside the line button", () => {
    const ui = mount()
    expect(ui.host.querySelectorAll("section").length).toBe(1)
    expect(ui.host.querySelectorAll("[data-mission-deliverables] > ul > li").length).toBe(3)
    expect(ui.item("doc-d").querySelectorAll("[data-deliverable-links]").length).toBe(1)
    expect(ui.item("doc-d").querySelector("[data-mission-deliverable] [data-deliverable-links]")).toBeNull()
    expect(ui.item("doc-none").querySelector("[data-deliverable-links]")).toBeNull()
  })

  test("PDF and HTML have Open and Preview; DOCX has Open only", () => {
    const ui = mount()
    const buttons = (name: string) => [...ui.link("doc-d", name).querySelectorAll("button")].map((b) => b.textContent)
    expect(buttons(PDF_D)).toEqual(["Open", "Preview"])
    expect(buttons(HTML_D)).toEqual(["Open", "Preview"])
    expect(buttons(DOCX_D)).toEqual(["Open"])
    expect(ui.link("doc-d", PDF_D).querySelector("[data-deliverable-open]")!.getAttribute("aria-label")).toBe(
      "Open PDF Rev D · rev 256",
    )
  })

  test("Open hands the absolute path to the bridge; Preview opens the project path in the file tab", () => {
    const ui = mount()
    ui.link("doc-d", PDF_D).querySelector<HTMLButtonElement>("[data-deliverable-open]")!.click()
    ui.link("doc-d", DOCX_D).querySelector<HTMLButtonElement>("[data-deliverable-open]")!.click()
    expect(ui.system).toEqual([`${DIR72}/deliverables/${M72}/${PDF_D}`, `${DIR72}/deliverables/${M72}/${DOCX_D}`])
    expect(ui.opened).toEqual([])
    ui.link("doc-d", HTML_D).querySelector<HTMLButtonElement>("[data-deliverable-preview]")!.click()
    expect(ui.opened).toEqual([`deliverables/${M72}/${HTML_D}`])
    expect(ui.panes).toEqual([`deliverables/${M72}/${HTML_D}`])
    expect(ui.system.length).toBe(2)
  })

  test("the revision is printed and the latest is marked; older revisions are reachable in a closed <details>", () => {
    const ui = mount()
    const groups = [...ui.item("doc-d").querySelectorAll<HTMLElement>("[data-deliverable-revision]")]
    expect(groups.map((g) => [g.dataset.deliverableRevision, g.dataset.latest])).toEqual([
      ["Rev D · rev 256", "true"],
      ["Rev C · rev 201", "false"],
    ])
    expect(groups[0].querySelector("[data-deliverable-latest]")!.textContent).toBe("Latest")
    expect(groups[1].querySelector("[data-deliverable-latest]")).toBeNull()
    const older = ui.item("doc-d").querySelector<HTMLDetailsElement>("details[data-deliverable-older]")!
    expect(older.open).toBe(false)
    expect(older.querySelector("summary")!.textContent).toBe("Older revisions (1)")
    expect(older.contains(groups[1])).toBe(true)
    expect(older.contains(groups[0])).toBe(false)
    ui.link("doc-d", PDF_C).querySelector<HTMLButtonElement>("[data-deliverable-open]")!.click()
    expect(ui.system).toEqual([`${DIR72}/deliverables/${M72}/${PDF_C}`])
  })

  test("a file that is not in the project folder: the plain state, no action", () => {
    const ui = mount()
    const gone = ui.item("doc-gone")
    expect(gone.querySelectorAll("[data-deliverable-links] button").length).toBe(0)
    expect(gone.querySelector("[data-deliverable-link-absent]")!.textContent).toBe(
      `PDF Not in this project yet. Swarm saves it to deliverables/${M72}.`,
    )
    expect(gone.querySelector("[data-deliverable-reveal]")).toBeNull()
    // a deliverable with no project copy keeps the existing line-level text
    expect(ui.item("doc-none").querySelector("[data-mission-deliverable-absent]")!.textContent).toBe(
      `Not in this project yet. Swarm saves it to deliverables/${M72}.`,
    )
  })

  test("existing open-in-tab and Reveal keep working, now on the latest project copy", () => {
    const ui = mount()
    ui.item("doc-d").querySelector<HTMLButtonElement>("[data-mission-deliverable]")!.click()
    expect(ui.opened).toEqual([`deliverables/${M72}/${PDF_D}`])
    ui.item("doc-d").querySelector<HTMLButtonElement>("[data-deliverable-reveal]")!.click()
    expect(ui.revealed).toEqual([`${DIR72}/deliverables/${M72}/${PDF_D}`])
    expect(ui.system).toEqual([])
  })

  test("no desktop bridge: no Open; mission folder is not the session folder: no Preview", () => {
    let ui = mount({ bridge: false })
    expect([...ui.link("doc-d", PDF_D).querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Preview"])
    dispose?.()
    document.body.innerHTML = ""
    ui = mount({ session: "/work/other-session" })
    expect([...ui.link("doc-d", PDF_D).querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Open"])
    expect(ui.item("doc-d").querySelector<HTMLElement>("[data-mission-deliverable]")!.dataset.openable).toBe("false")
  })

  test("Indonesian labels; the reusable link piece renders alone with latestOnly", () => {
    table = id
    const host = document.createElement("div")
    document.body.append(host)
    const mission = buildMission(fixture72(), "id", new Set())
    const links = deliverableLinks(mission.deliverables[0].projectFiles, DIR72)
    const calls: string[] = []
    dispose = render(
      () =>
        createComponent(MissionDeliverableLinks, {
          links,
          mission: M72,
          t: translate as never,
          latestOnly: true,
          openSystem: (abs: string) => calls.push(abs),
          previewFile: (path: string) => calls.push(path),
        }),
      host,
    )
    expect([...host.querySelectorAll("[data-deliverable-link] button")].map((b) => b.textContent)).toEqual([
      "Buka",
      "Pratinjau",
      "Buka",
      "Buka",
      "Pratinjau",
    ])
    expect(host.querySelector("[data-deliverable-latest]")!.textContent).toBe("Terbaru")
    expect(host.querySelector("[data-deliverable-older]")).toBeNull()
    host.querySelector<HTMLButtonElement>("[data-deliverable-preview]")!.click()
    expect(calls).toEqual([`deliverables/${M72}/${PDF_D}`])
  })
})
