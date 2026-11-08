import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict } from "@/i18n/en"

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

const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: keyof typeof dict, params?: Record<string, string>) =>
      dict[key] === undefined ? String(key) : resolveTemplate(dict[key], params ?? {}),
    intl: () => "en",
  }),
}))

// The dock the session composer draws for every permission prompt, not a copy of it.
const { SessionPermissionDock } = await import(
  new URL("../src/pages/session/composer/session-permission-dock.tsx", import.meta.url).pathname
)

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function mount(request: Record<string, unknown>) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(SessionPermissionDock, {
        request: { id: "per_1", sessionID: "ses_1", metadata: {}, always: [], ...request },
        responding: false,
        onDecide: () => {},
      }),
    host,
  )
  return host
}

const classes = (el: Element | null | undefined) => new Set((el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))

// Row 173 (F146b-4, row 146b shot 03): the footer of session-ui's DockPrompt is one nowrap flex row; with the hint and
// the buttons as two siblings the buttons kept their width and squeezed the hint to a 0-wide column painted over Deny.
// Geometry was measured in headless Chromium (implementation/154 report); this pins the structure that gives it.
describe("row 173: the permission dock footer wraps instead of squeezing its hint", () => {
  test("one full-width wrapping row holds the hint (12rem basis, grows) and the wrapping buttons", () => {
    const host = mount({
      permission: "datum-studio_studio_mission_create",
      patterns: ["*"],
      always: ["*"],
      metadata: { mcp: { server: "datum-studio", transport: "local", origin: "global" } },
      movesOnAt: Date.parse("2026-11-08T04:36:00Z"),
    })
    expect(host.querySelector("[data-slot='permission-hint']")?.textContent).toBe("Run the tool studio_mission_create from datum-studio")
    const footer = host.querySelector("[data-slot='permission-footer']")!
    expect(footer.children.length).toBe(1)
    const row = footer.children[0]
    expect(row.hasAttribute("data-permission-footer-row")).toBe(true)
    for (const c of ["flex", "w-full", "flex-wrap", "min-w-0"]) expect(classes(row).has(c)).toBe(true)
    const hint = row.querySelector("[data-permission-footer-hint]")
    expect(hint?.textContent).toContain("No answer by")
    for (const c of ["grow", "basis-48", "min-w-0"]) expect(classes(hint).has(c)).toBe(true)
    const actions = row.querySelector("[data-slot='permission-footer-actions']")
    expect(classes(actions).has("flex-wrap")).toBe(true)
    expect(actions?.querySelectorAll("button").length).toBe(3)
    // the hint comes first, so the buttons wrap BELOW it, never beside a squeezed column
    expect(row.firstElementChild).toBe(hint)
  })

  test("no moves-on time: no empty hint box, the buttons alone in the row", () => {
    const host = mount({ permission: "bash", patterns: ["git status"] })
    const row = host.querySelector("[data-permission-footer-row]")!
    expect(row.querySelector("[data-permission-footer-hint]")).toBeNull()
    expect(row.children.length).toBe(1)
  })
})
