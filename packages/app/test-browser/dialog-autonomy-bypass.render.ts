import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as id } from "@/i18n/id"

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
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? String(key) }),
}))

// The real dialog stack, so close, Escape and a replacing dialog behave as they do in the app.
const { DialogProvider, useDialog } = await import("@opencode-ai/ui/context/dialog")
const { confirmAutonomyBypass, emphasised } = await import(
  new URL("../src/components/dialog-autonomy-bypass.tsx", import.meta.url).pathname
)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function mount() {
  let dialog!: ReturnType<typeof useDialog>
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(DialogProvider, {
        get children() {
          dialog = useDialog()
          return null
        },
      }),
    host,
  )
  return { dialog: () => dialog }
}

const button = (text: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)

async function ask() {
  const view = mount()
  let answer: boolean | undefined
  const pending = confirmAutonomyBypass(view.dialog()).then((value: boolean) => (answer = value))
  await tick(5)
  return { ...view, pending, answer: () => answer }
}

describe("the consent dialog before autonomous mode turns on", () => {
  test("it shows the title, the intro and the six paragraphs in order, and waits for an answer", async () => {
    const view = await ask()
    expect(document.body.textContent).toContain(dict["dialog.autonomyBypass.title"])
    expect(document.body.textContent).toContain(dict["dialog.autonomyBypass.intro"])
    const paragraphs = [...document.querySelectorAll("[data-autonomy-bypass-paragraph]")].map((item) =>
      item.getAttribute("data-autonomy-bypass-paragraph"),
    )
    expect(paragraphs).toEqual([
      "dialog.autonomyBypass.archive",
      "dialog.autonomyBypass.refused",
      "dialog.autonomyBypass.waits",
      "dialog.autonomyBypass.secrets",
      "dialog.autonomyBypass.report",
      "dialog.autonomyBypass.scope",
    ])
    expect(document.querySelector("[data-autonomy-bypass-accept]")?.textContent?.trim()).toBe(
      dict["dialog.autonomyBypass.accept"],
    )
    expect(view.answer()).toBeUndefined()
  })

  test("agree resolves true", async () => {
    const view = await ask()
    document.querySelector<HTMLButtonElement>("[data-autonomy-bypass-accept]")!.click()
    await view.pending
    expect(view.answer()).toBe(true)
  })

  test("cancel resolves false", async () => {
    const view = await ask()
    button(dict["common.cancel"])!.click()
    await view.pending
    expect(view.answer()).toBe(false)
  })

  test("Escape resolves false", async () => {
    const view = await ask()
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await view.pending
    expect(view.answer()).toBe(false)
  })

  test("another dialog replacing it is a no, never a question left open", async () => {
    const view = await ask()
    view.dialog().show(() => null)
    await view.pending
    expect(view.answer()).toBe(false)
  })
})

// Gate 2 N2 / P15: the Indonesian text keeps loanwords in italics, so the dialog shows them as <em> and no asterisk.
// 1.1.3 row 5: the list follows the rewritten intro, archive, refused, waits and report texts.
// 1.2.6 row 109-fix (intended change): row 109 rewrote archive/refused/secrets (U6/U12/U16), adding
// branch, checkpoint, ref, remote, cloud and dropping snapshot.
describe("the consent text in Indonesian", () => {
  const keys = [
    "dialog.autonomyBypass.intro",
    "dialog.autonomyBypass.archive",
    "dialog.autonomyBypass.refused",
    "dialog.autonomyBypass.waits",
    "dialog.autonomyBypass.secrets",
    "dialog.autonomyBypass.report",
    "dialog.autonomyBypass.scope",
  ] as const

  test("loanwords render in italics and no asterisk reaches the screen", () => {
    const host = document.createElement("div")
    document.body.append(host)
    dispose = render(() => keys.map((key) => emphasised(id[key])), host)
    expect([...host.querySelectorAll("em")].map((item) => item.textContent)).toEqual([
      "bypass",
      "build",
      "branch",
      "checkpoint",
      "ref",
      "force push",
      "remote",
      "cloud",
      "upload",
      "token",
      "force",
      "deploy",
      "publish",
      "script",
    ])
    expect(host.textContent).not.toContain("*")
  })

  test("English text has no markers and is shown as it is", () => {
    for (const key of keys) {
      expect(dict[key]).not.toContain("*")
      expect(emphasised(dict[key])).toBe(dict[key])
    }
  })
})
