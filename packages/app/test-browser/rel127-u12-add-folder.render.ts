// U-12 (1.2.7 row U12), render half: the real session-ui PromptInputV2 add menu shows "Add folder" when the host can
// pick a folder, and choosing it puts the picked path into the draft as an `application/x-directory` file part (a
// reference, nothing uploaded). Both composers register the palette command `file.attachFolder`.
import { plugin } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import type { PromptInputV2PersistedState } from "@opencode-ai/session-ui/v2/prompt-input"
import { createStore } from "solid-js/store"
import { createComponent, render } from "solid-js/web"

const viteSolid = createRequire(createRequire(import.meta.url).resolve("vite-plugin-solid"))
const babel = viteSolid("@babel/core")
const presets = [
  [viteSolid.resolve("babel-preset-solid"), { generate: "dom" }],
  [viteSolid.resolve("@babel/preset-typescript"), { isTSX: true, allExtensions: true }],
]
plugin({
  name: "solid-jsx",
  setup(build) {
    build.onLoad({ filter: /packages\/(ui|session-ui)\/src\/.*\.tsx$/ }, async (args) => ({
      contents: babel.transformSync(await Bun.file(args.path).text(), { filename: args.path, presets }).code,
      loader: "js",
    }))
  },
})
const { PromptInputV2 } = await import("@opencode-ai/session-ui/v2/prompt-input")
const { createPromptInputV2Controller } = await import("@opencode-ai/session-ui/v2/prompt-input/interaction")

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

const disposers: (() => void)[] = []
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  document.body.innerHTML = ""
})

function renderComposer(pickFolder?: () => Promise<string | null | undefined>) {
  const host = document.createElement("div")
  document.body.append(host)
  const [state, setState] = createStore<PromptInputV2PersistedState>({
    prompt: [{ type: "text", content: "look at ", start: 0, end: 8 }],
    cursor: 8,
    context: { items: [] },
  })
  const dispose = render(() => {
    const controller = createPromptInputV2Controller({
      store: [state, setState],
      commands: () => [],
      context: () => [],
      searchContextFiles: () => [],
      pickFolder,
      view: {
        submit: { stopping: () => false, working: () => false, onSubmit: () => {}, onStop: () => {} },
      },
    })
    return createComponent(PromptInputV2, { controller })
  }, host)
  disposers.push(dispose)
  return state
}

async function openMenu() {
  const trigger = document.querySelector<HTMLElement>('[data-action="prompt-attach"]')!
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
  trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
  trigger.click()
  await tick(5)
  return document.querySelector<HTMLElement>('[data-action="prompt-add-folder"]')
}

async function choose(item: HTMLElement) {
  item.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
  item.click()
  await tick(5)
}

describe("U-12 Add folder", () => {
  test("the menu item is there, and the picked folder joins the draft as a directory reference", async () => {
    let asked = 0
    const state = renderComposer(async () => {
      asked++
      return "/work/project/docs"
    })
    const item = await openMenu()
    expect(item?.textContent).toBe("Add folder")
    await choose(item!)
    expect(asked).toBe(1)
    const folder = state.prompt.find((part) => part.type === "file")
    expect(folder).toMatchObject({
      type: "file",
      path: "/work/project/docs",
      content: "@docs",
      mime: "application/x-directory",
      filename: "docs",
    })
    expect(folder && "url" in folder ? folder.url : undefined).toBeUndefined()
    expect(state.prompt.some((part) => part.type === "image")).toBe(false)
    expect(state.prompt[0]).toMatchObject({ type: "text", content: "look at " })
  })

  test("a cancelled picker leaves the draft as it was", async () => {
    const state = renderComposer(async () => null)
    await choose((await openMenu())!)
    expect(state.prompt).toEqual([{ type: "text", content: "look at ", start: 0, end: 8 }])
  })

  test("a host without a folder picker shows no item", async () => {
    renderComposer()
    expect(await openMenu()).toBeNull()
    expect(document.body.textContent).toContain("Images and files")
  })

  test("both composers register the palette command file.attachFolder with the shared label", async () => {
    // Source check: the palette registration sits inside the app composers, which need the whole app context to mount.
    for (const file of ["../src/components/prompt-input-v2.tsx", "../src/components/prompt-input.tsx"]) {
      const source = await Bun.file(new URL(file, import.meta.url)).text()
      expect(source).toMatch(/id: "file\.attachFolder",\s*\n\s*title: language\.t\("ui\.promptInput\.addFolder"\)/)
    }
  })
})
