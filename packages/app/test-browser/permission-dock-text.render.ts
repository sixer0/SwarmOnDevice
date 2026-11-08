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
  return {
    hint: () => host.querySelector("[data-slot='permission-hint']")?.textContent ?? "",
    patterns: () => [...host.querySelectorAll("[data-slot='permission-patterns'] code")].map((code) => code.textContent),
    text: () => host.textContent ?? "",
  }
}

describe("row 171: a permission prompt always says what it asks", () => {
  test("an MCP tool call names the tool and its server and shows no lone *", () => {
    const dock = mount({
      permission: "datum-studio_studio_mission_create",
      patterns: ["*"],
      metadata: { mcp: { server: "datum-studio", transport: "local", origin: "global" } },
    })
    expect(dock.hint()).toBe("Run the tool studio_mission_create from datum-studio")
    expect(dock.patterns()).toEqual([])
    expect(dock.text()).not.toContain("*")
  })

  test("a permission with no description shows its readable name, still without *", () => {
    const dock = mount({ permission: "code_mode", patterns: ["*"] })
    expect(dock.hint()).toBe("Use code mode")
    expect(dock.patterns()).toEqual([])
  })

  test("a normal permission keeps its description and its patterns", () => {
    const dock = mount({ permission: "bash", patterns: ["git status"] })
    expect(dock.hint()).toBe(dict["settings.permissions.tool.bash.description"])
    expect(dock.patterns()).toEqual(["git status"])
  })
})
