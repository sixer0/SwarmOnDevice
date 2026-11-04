import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
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

// The message parts pull in a Vite worker URL, which Bun cannot load. Nothing the row draws uses them.
mock.module("@opencode-ai/session-ui/message-part", () => ({ getToolInfo: () => ({}) }))
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({ t: (key: keyof typeof dict) => dict[key] ?? String(key) }),
}))

// The row the Activity panel draws for each held decision, not a copy of it. The computed path keeps the view out of
// this folder's typecheck, which reads `import.meta.env` differently from the app's own.
const { DecisionRow } = await import(new URL("../src/pages/session/map/session-map-view.tsx", import.meta.url).pathname)

const entry = { id: "per_1", sessionID: "ses_1", at: 1, permission: "bash", patterns: ["git push origin main"] }
let dispose = () => {}

afterEach(() => {
  dispose()
  document.body.innerHTML = ""
})

function mount(props: { canAlways?: boolean; waiting?: boolean }) {
  const replies: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  dispose = render(
    () =>
      createComponent(DecisionRow, {
        entry,
        busy: false,
        canAlways: props.canAlways,
        onReply: props.waiting === false ? undefined : (reply: string) => replies.push(reply),
        onUndo: () => {},
      }),
    host,
  )
  // The answer buttons. The Details toggle (1.1.1) sits beside them on every row and is not an answer.
  const buttons = () =>
    [...host.querySelectorAll("button:not([data-decision-details-toggle])")].map((button) => button.textContent?.trim())
  const always = () => host.querySelector<HTMLButtonElement>("[data-decision-always]")
  return { replies, buttons, always }
}

describe("row 258: Always allow in this session on a held decision", () => {
  test("shows beside Allow and Decline and sends the reply always", () => {
    const row = mount({ canAlways: true })
    expect(row.buttons()).toEqual([
      dict["session.movedOn.allow"],
      dict["session.movedOn.alwaysInSession"],
      expect.any(String),
    ])
    expect(dict["session.movedOn.alwaysInSession"]).toBe("Always allow in this session")
    row.always()!.click()
    expect(row.replies).toEqual(["always"])
  })

  test("is not there when the entry offers no always, or nothing waits on an answer", () => {
    const plain = mount({ canAlways: false })
    expect(plain.always()).toBeNull()
    expect(plain.buttons()).toHaveLength(2)
    dispose()
    const decided = mount({ canAlways: true, waiting: false })
    expect(decided.always()).toBeNull()
    expect(decided.buttons()).toEqual([])
  })
})
