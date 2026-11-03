import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, insert, render } from "solid-js/web"
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

// The Kobalte dialog needs its root and portal; this test reads the body the tools dialog puts inside it.
mock.module("@opencode-ai/ui/dialog", () => ({
  Dialog: (props: { title?: unknown; children?: unknown }) => {
    const body = document.createElement("div")
    body.dataset.slot = "dialog-body"
    insert(body, () => props.children as never)
    return [props.title, body]
  },
}))
mock.module("@opencode-ai/ui/context/dialog", () => ({ useDialog: () => ({ close: () => {} }) }))
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: keyof typeof dict, params?: Record<string, unknown>) =>
      String(dict[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) => String(params?.[name] ?? "")),
  }),
}))
mock.module("@/context/server-sdk", () => ({
  useServerSDK: () => () => ({ client: { global: { dispose: async () => {} }, app: { log: async () => {} } } }),
}))

// The dialog itself, not a copy of it. The computed path keeps the view out of this folder's typecheck.
const { DialogInstallTools } = await import(
  new URL("../src/components/dialog-install-tools.tsx", import.meta.url).pathname
)

const reason =
  'FAILED — formula docker: brew reports "29.8.0", tools.lock.json pins a different version, and the runtime step stops here'
const run = { exitCode: 1, stdout: `step runtime: ${reason}\nRESULT FAILED`, stderr: "swarm-setup: failed" }
const api = {
  preview: async () => ({ exitCode: 3, stdout: "runtime: installs Colima\nRESULT REFUSED_NO_CONSENT", stderr: "" }),
  install: async () => run,
  state: async () => ({ components: { node: "healthy" }, offerPending: false }),
  onProgress: () => () => {},
  markOffered: async () => {},
}

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

const settle = async (check: () => boolean) => {
  for (let i = 0; i < 50 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
}

async function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(() => createComponent(DialogInstallTools, { api }), host)
  const install = () =>
    [...host.querySelectorAll("button")].find((button) => button.textContent?.includes(dict["dialog.tools.install"]))
  await settle(() => install()?.disabled === false)
  return {
    host,
    install,
    actions: () => host.querySelector<HTMLElement>("[data-tools-actions]")!,
    scroll: () => host.querySelector<HTMLElement>("[data-tools-scroll]")!,
    list: () => host.querySelector<HTMLElement>("[data-tools-scroll] [data-component='checkbox']")!,
  }
}

const precedes = (a: Node, b: Node) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe("row 265: the tools dialog keeps Install in view", () => {
  test("the action row comes before the tool list and outside the scrolling body", async () => {
    const dialog = await mount()
    const install = dialog.install()!
    expect(install.disabled).toBe(false)
    expect(dialog.actions().contains(install)).toBe(true)
    expect(dialog.scroll().contains(install)).toBe(false)
    expect(dialog.list()).not.toBeNull()
    expect(precedes(install, dialog.list())).toBe(true)
    expect(precedes(dialog.actions(), dialog.scroll())).toBe(true)
    expect(dialog.actions().className).toContain("shrink-0")
    const buttons = [...dialog.actions().querySelectorAll("button")].map((button) => button.textContent?.trim())
    expect(buttons).toEqual([dict["dialog.tools.later"], dict["dialog.tools.install"]])
  })

  test("the body is a scroll container that can shrink inside the dialog", async () => {
    const dialog = await mount()
    const scroll = dialog.scroll().className.split(/\s+/)
    expect(scroll).toEqual(expect.arrayContaining(["overflow-y-auto", "min-h-0", "flex-1"]))
    const root = dialog.host.querySelector<HTMLElement>("[data-tools-dialog]")!.className.split(/\s+/)
    expect(root).toEqual(expect.arrayContaining(["min-h-0", "flex-1"]))
    expect(dialog.scroll().textContent).toContain(dict["dialog.tools.terminal"])
  })

  test("after a failed run the long reason stays on one line with the full text on hover; Close stays on top", async () => {
    const dialog = await mount()
    dialog.install()!.click()
    await settle(() => dialog.host.textContent?.includes("RESULT FAILED") === true)
    const status = [...dialog.host.querySelectorAll<HTMLElement>("[data-tools-status]")].find((node) =>
      node.textContent?.startsWith("Failed:"),
    )!
    expect(status.textContent).toBe(`Failed: ${reason}`)
    expect(status.title).toBe(`Failed: ${reason}`)
    expect(status.className.split(/\s+/)).toEqual(expect.arrayContaining(["truncate", "min-w-0"]))
    const result = [...dialog.host.querySelectorAll("pre")].find((node) => node.textContent?.includes("RESULT FAILED"))!
    expect(dialog.scroll().contains(result)).toBe(true)
    const buttons = [...dialog.actions().querySelectorAll("button")].map((button) => button.textContent?.trim())
    expect(buttons).toEqual([dict["common.close"], dict["dialog.tools.install"]])
    expect(precedes(dialog.actions(), result)).toBe(true)
  })
})
