import { plugin } from "bun"
import { afterEach, describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import type { PromptInputV2Autonomy, PromptInputV2PersistedState } from "@opencode-ai/session-ui/v2/prompt-input"
import { createStore } from "solid-js/store"
import { createComponent, render } from "solid-js/web"

// Bun compiles JSX for React, so nothing here could render the real tray. These are the compilers the app's own build
// uses, reached through its Vite plugin so no dependency is added for one test.
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

function renderTray(autonomy?: PromptInputV2Autonomy) {
  const host = document.createElement("div")
  document.body.append(host)
  const store = createStore<PromptInputV2PersistedState>({
    prompt: [{ type: "text", content: "", start: 0, end: 0 }],
    cursor: 0,
    context: { items: [] },
  })
  const dispose = render(() => {
    const controller = createPromptInputV2Controller({
      store,
      commands: () => [],
      context: () => [],
      searchContextFiles: () => [],
      view: {
        submit: { stopping: () => false, working: () => false, onSubmit: () => {}, onStop: () => {} },
      },
    })
    return createComponent(PromptInputV2, { controller, autonomy })
  }, host)
  disposers.push(dispose)
  return host
}

const marker = () => document.querySelector<HTMLButtonElement>('[data-action="prompt-autonomy-marker"]')

async function openMenu() {
  const trigger = document.querySelector<HTMLElement>('[data-action="prompt-attach"]')!
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerType: "mouse" }))
  trigger.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
  trigger.click()
  await tick(5)
  return document.querySelector<HTMLElement>('[data-action="prompt-autonomy-toggle"]')
}

describe("the tray", () => {
  const props = (over: object = {}) => ({
    label: "Autonomous mode",
    on: false,
    disabled: false,
    onToggle: () => {},
    ...over,
  })

  test("shows no marker while the mode is off", () => {
    renderTray(props())
    expect(marker()).toBeNull()
  })

  test("shows the host's words while it is on, and the click opens the decisions", () => {
    let opened = 0
    renderTray(props({ on: true, marker: "Autonomous, waiting: 2", onMarker: () => opened++ }))
    expect(marker()?.textContent).toBe("Autonomous, waiting: 2")
    expect(marker()?.disabled).toBe(false)
    marker()?.click()
    expect(opened).toBe(1)
  })

  test("on a draft the marker only reads", () => {
    renderTray(props({ on: true, marker: "Autonomous, waiting: 0" }))
    expect(marker()?.disabled).toBe(true)
  })

  test("the add menu has one switch, and it asks the host to change the mode", async () => {
    let toggled = 0
    renderTray(props({ onToggle: () => toggled++ }))
    const item = await openMenu()
    expect(item?.textContent).toContain("Autonomous mode")
    expect(document.querySelectorAll('[data-action="prompt-autonomy-toggle"]').length).toBe(1)
    expect(item?.getAttribute("aria-checked")).toBe("false")
    item?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerType: "mouse" }))
    item?.click()
    await tick(5)
    expect(toggled).toBe(1)
  })

  test("the menu says so when the mode is on, and refuses while it is unknown", async () => {
    renderTray(props({ on: true }))
    expect((await openMenu())?.getAttribute("aria-checked")).toBe("true")
    disposers.splice(0).forEach((dispose) => dispose())
    document.body.innerHTML = ""

    renderTray(props({ disabled: true }))
    expect((await openMenu())?.hasAttribute("data-disabled")).toBe(true)
  })

  test("a host that knows nothing of the mode gets the menu it had", async () => {
    renderTray()
    expect(await openMenu()).toBeNull()
    expect(marker()).toBeNull()
  })
})
