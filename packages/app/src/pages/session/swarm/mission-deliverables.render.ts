// Row 132: the Deliverables panel rendered in a DOM (happy-dom, Solid browser build, JSX through babel-preset-solid as
// in test-browser/file-preview.render.ts). Run by mission-deliverables.test.ts in a child process, because the browser
// build and the JSX plugin must not reach the rest of the unit suite. Not picked up by the unit glob (*.render.ts).
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { dict as id } from "@/i18n/id"
import { buildMission } from "./mission-model"
import { fixture, HTML_C, PDF_A } from "./mission-deliverables.fixture"

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

// The panel's only context is the language; replaced here (this process only).
let table: Record<string, string> = en
const translate = (key: string, params?: Record<string, string | number>) =>
  (table[key] ?? key).replace(/{{\s*(\w+)\s*}}/g, (_, name: string) => String(params?.[name] ?? ""))
mock.module("@/context/language", () => ({ useLanguage: () => ({ t: translate }) }))

const { MissionDeliverables } = await import("./mission-deliverables")

const present = new Set([PDF_A, HTML_C])
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  table = en
})

function mount(input: { lang?: "en" | "id"; empty?: boolean } = {}) {
  const host = document.createElement("div")
  document.body.append(host)
  const get = fixture()
  if (input.empty) get.deliverables = []
  const mission = buildMission(get, input.lang ?? "en", present)
  const [selected, setSelected] = createSignal<string | undefined>()
  const opened: string[] = []
  const selects: string[] = []
  dispose = render(
    () =>
      createComponent(MissionDeliverables, {
        mission,
        get selected() {
          return selected()
        },
        onSelectAgent: (row: string) => {
          selects.push(row)
          setSelected(row)
        },
        openFile: (path: string) => opened.push(path),
      }),
    host,
  )
  const line = (doc: string) => host.querySelector<HTMLButtonElement>(`[data-mission-deliverable="${doc}"]`)!
  const text = (doc: string, part: string) => line(doc).querySelector(`[data-mission-deliverable-${part}]`)?.textContent
  return { host, line, text, opened, selects, setSelected }
}

describe("row 132 Deliverables panel", () => {
  test("list rendering: one line per deliverable with tile, name, meta, status", () => {
    const ui = mount()
    const lines = ui.host.querySelectorAll("[data-mission-deliverable]")
    expect([...lines].map((el) => el.getAttribute("data-mission-deliverable"))).toEqual([
      "doc-a",
      "doc-b",
      "doc-c",
      "doc-d",
      "doc-e",
    ])
    expect(ui.host.querySelector("h2")?.textContent).toBe("Deliverables")
    expect(ui.text("doc-a", "format")).toBe("PDF")
    expect(ui.text("doc-a", "name")).toBe("Kajian DATUM")
    expect(ui.text("doc-a", "meta")).toBe("+ DOCX · Write kajian · Rev A")
    expect(ui.text("doc-a", "status")).toBe("Final")
    expect(ui.text("doc-b", "status")).toBe("In review")
    expect(ui.text("doc-d", "status")).toBe("Draft")
    expect(ui.text("doc-d", "format")).toBe("-")
    expect(ui.text("doc-d", "meta")).toBe("- · Rev A")
  })

  test("agent text is rendered as text, never as markup (§12)", () => {
    const ui = mount()
    expect(ui.text("doc-b", "name")).toBe("Laporan Uji <b>Kontrak</b>")
    expect(ui.line("doc-b").querySelector("b")).toBeNull()
  })

  test("verified vs unverified label (C127: any other state shows Unverified)", () => {
    const ui = mount()
    expect(ui.text("doc-a", "verified")).toBe("Verified")
    expect(ui.text("doc-b", "verified")).toBe("Unverified")
    expect(ui.text("doc-c", "verified")).toBe("Verified")
    expect(ui.text("doc-d", "verified")).toBe("Unverified")
    expect(ui.text("doc-e", "verified")).toBe("Unverified")
    expect(ui.line("doc-e").dataset.status).toBe("draft")
  })

  test("n/m final in the head", () => {
    const ui = mount()
    expect(ui.host.querySelector("[data-mission-deliverables-count]")?.textContent).toBe("1/5 final")
  })

  test("Indonesian labels", () => {
    table = id
    const ui = mount({ lang: "id" })
    expect(ui.host.querySelector("h2")?.textContent).toBe("Hasil kerja")
    expect(ui.text("doc-b", "verified")).toBe("Belum terverifikasi")
    expect(ui.text("doc-b", "status")).toBe("Ditinjau")
  })

  test("selection: clicking marks the line and selects the row; an outside selection follows", () => {
    const ui = mount()
    expect(ui.line("doc-b").getAttribute("aria-pressed")).toBe("false")
    ui.line("doc-b").click()
    expect(ui.selects).toEqual(["2"])
    expect(ui.line("doc-b").getAttribute("aria-pressed")).toBe("true")
    ui.setSelected("1") // the HQ deck selects another agent
    expect(ui.line("doc-a").getAttribute("aria-pressed")).toBe("true")
    expect(ui.line("doc-b").getAttribute("aria-pressed")).toBe("false")
  })

  test("open in tab: a present Studio output opens its project path; an absent one shows the not-in-project state", () => {
    const ui = mount()
    ui.line("doc-a").click()
    ui.line("doc-c").click()
    expect(ui.opened).toEqual([`docs/m-doc-1/${PDF_A}`, `docs/m-doc-1/${HTML_C}`])
    expect(ui.line("doc-a").getAttribute("aria-label")).toBe("Open Kajian DATUM")
    expect(ui.text("doc-a", "absent")).toBeUndefined()

    ui.line("doc-b").click()
    expect(ui.opened.length).toBe(2)
    expect(ui.selects).toEqual(["1", "3", "2"])
    expect(ui.line("doc-b").dataset.openable).toBe("false")
    expect(ui.text("doc-b", "absent")).toBe("Not in this project yet. The agent saves it to docs/m-doc-1.")
  })

  test("no deliverables: the panel is not shown", () => {
    const ui = mount({ empty: true })
    expect(ui.host.querySelector("[data-mission-deliverables]")).toBeNull()
  })
})
