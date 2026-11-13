// N7-128 (AC-U9, row 34), render half of N7-097: the real session-ui MessagePart draws a reasoning block with its own
// toggle. Click, Enter and Space flip `aria-expanded`; the default open state is the one the caller passes
// (`showReasoningSummaries` in the app timeline); the per-part store keeps the choice across a remount.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { AssistantMessage, Part } from "@opencode-ai/sdk/v2"
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
    build.onLoad({ filter: /packages\/(ui|session-ui|app)\/src\/.*\.tsx$/ }, async (args) => ({
      contents: babel.transformSync(await Bun.file(args.path).text(), { filename: args.path, presets }).code,
      loader: "js",
    }))
  },
})

// The markdown renderer runs a Vite worker; a stand-in draws the text it is given so its presence can be checked.
const sessionUi = new URL("../../session-ui/src/components/", import.meta.url).pathname
mock.module(sessionUi + "markdown.tsx", () => ({
  Markdown: (props: { text: string }) => {
    const el = document.createElement("div")
    el.setAttribute("data-probe-markdown", "")
    el.textContent = props.text
    return el
  },
}))

const { Part: MessagePart } = await import("@opencode-ai/session-ui/message-part")
const { DataProvider } = await import("@opencode-ai/session-ui/context")
// The timeline's row builder, with session-ui's real `renderable` (no stand-in), for the busy "Thinking" row.
const { Timeline, TimelineRow } = await import("@/pages/session/timeline/rows")

const TEXT = "Weighing the two options"
const part = { id: "prt_r1", sessionID: "ses_1", messageID: "msg_1", type: "reasoning", text: TEXT, time: { start: 1 } }
const message = {
  id: "msg_1",
  sessionID: "ses_1",
  role: "assistant",
  time: { created: 1, completed: 2 },
} as unknown as AssistantMessage

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function mount(props: {
  defaultOpen: boolean
  store?: Record<string, boolean | undefined>
  onChange?: (v: boolean) => void
}) {
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(DataProvider, {
        data: { session: [], session_status: {}, session_diff: {}, message: {}, part: {} },
        directory: "/repo",
        get children() {
          return createComponent(MessagePart, {
            part: part as Part,
            message,
            defaultOpen: props.defaultOpen,
            get toolOpen() {
              return props.store ? (props.store[part.id] ?? props.defaultOpen) : undefined
            },
            onToolOpenChange: props.onChange,
          })
        },
      }),
    host,
  )
  return host
}

const toggle = () => document.querySelector<HTMLElement>('[data-slot="reasoning-toggle"]')!
// Kobalte's presence keeps closing content in the DOM (marked `data-closed`) until an exit animation ends, which
// happy-dom never reports; shown means the content is present and not closing.
const shown = () => {
  const content = document.querySelector('[data-component="reasoning-part"] [data-slot="collapsible-content"]')
  if (!content || content.hasAttribute("data-closed")) return false
  return content.querySelector("[data-probe-markdown]")?.textContent === TEXT
}
const tick = () => new Promise((r) => setTimeout(r, 0))
// happy-dom has no keyboard activation for buttons. A browser turns Enter (keydown) and Space (keyup) on a focused,
// enabled native <button> into a click unless a handler cancels the key; the helper checks those preconditions on the
// real element and then performs the browser's activation step.
const key = async (name: "Enter" | " ") => {
  const el = toggle()
  el.focus()
  expect(document.activeElement).toBe(el)
  expect(el.tagName).toBe("BUTTON")
  expect(el.hasAttribute("disabled")).toBe(false)
  expect(el.getAttribute("tabindex")).not.toBe("-1")
  const code = name === " " ? "Space" : "Enter"
  const down = new KeyboardEvent("keydown", { key: name, code, bubbles: true, cancelable: true })
  const up = new KeyboardEvent("keyup", { key: name, code, bubbles: true, cancelable: true })
  el.dispatchEvent(down)
  el.dispatchEvent(up)
  expect(down.defaultPrevented).toBe(false)
  expect(up.defaultPrevented).toBe(false)
  el.click()
  await tick()
}

describe("U-9 reasoning toggle (render half)", () => {
  test("setting off: one collapsed toggle, text hidden; click opens, click again closes", async () => {
    mount({ defaultOpen: false })
    expect(toggle()).toBeTruthy()
    expect(toggle().tagName).toBe("BUTTON")
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(toggle().textContent).toContain("Show thinking")
    expect(shown()).toBe(false)

    toggle().click()
    await tick()
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(toggle().textContent).toContain("Hide thinking")
    expect(shown()).toBe(true)

    toggle().click()
    await tick()
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(shown()).toBe(false)
  })

  test("Enter and Space on the focused toggle open and close it", async () => {
    mount({ defaultOpen: false })
    await key("Enter")
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(shown()).toBe(true)
    await key(" ")
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(shown()).toBe(false)
  })

  test("setting on: the block starts open and a click closes it", async () => {
    mount({ defaultOpen: true })
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(shown()).toBe(true)
    toggle().click()
    await tick()
    expect(toggle().getAttribute("aria-expanded")).toBe("false")
    expect(shown()).toBe(false)
  })

  test("the per-part store keeps the choice when the row is drawn again (virtualised scroll)", async () => {
    const [store, setStore] = createStore<Record<string, boolean | undefined>>({})
    const onChange = (v: boolean) => setStore(part.id, v)
    mount({ defaultOpen: false, store, onChange })
    toggle().click()
    await tick()
    expect(store[part.id]).toBe(true)
    dispose()
    document.body.innerHTML = ""
    mount({ defaultOpen: false, store, onChange })
    expect(toggle().getAttribute("aria-expanded")).toBe("true")
    expect(shown()).toBe(true)
  })

  test("setting off, busy, reasoning still streaming: the block is drawn and the Thinking row still shows", () => {
    const user = { id: "msg_0", sessionID: "ses_1", role: "user", time: { created: 1 } } as never
    const live = { ...message, time: { created: 2 } } as unknown as AssistantMessage
    const rows = (show: boolean) =>
      Timeline.constructMessageRows(
        user,
        (id) => (id === live.id ? [part as Part] : []),
        [live],
        0,
        show,
        "busy",
        true,
        true,
      )
    const kinds = (show: boolean) => rows(show).map((row) => TimelineRow.key(row))
    expect(kinds(false).some((k) => k.startsWith("assistant-part:") && k.endsWith(part.id))).toBe(true)
    expect(kinds(false).some((k) => k.startsWith("thinking"))).toBe(true)
    // Setting on: the open block itself is the working indicator, as before.
    expect(kinds(true).some((k) => k.startsWith("thinking"))).toBe(false)
  })
})
