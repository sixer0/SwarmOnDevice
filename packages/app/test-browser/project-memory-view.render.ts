import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import * as i18n from "@solid-primitives/i18n"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"
import { dict as uiDict } from "@opencode-ai/ui/i18n/en"

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

// The same translator the app builds (context/language.tsx): flattened app + ui dictionaries, templates resolved.
const translate = i18n.translator(() => i18n.flatten({ ...dict, ...uiDict }), i18n.resolveTemplate) as (
  key: string,
  params?: Record<string, string | number | boolean>,
) => string
const real = await import("@/context/language")
mock.module("@/context/language", () => ({ ...real, useLanguage: () => ({ t: translate }) }))

type Item = Record<string, unknown>
const state: { items: Item[]; refused?: string } = { items: [] }
const client = {
  memory: {
    get: async () => ({ data: { enabled: true, items: state.items } }),
    add: async () => ({ data: state.refused ? { refused: state.refused } : { item: state.items[0] } }),
    remove: async () => ({ data: true }),
    update: async () => ({ data: {} }),
    settings: async () => ({ data: true }),
  },
}
const sdk = { client, event: { on: () => () => {} } }
const realSdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...realSdk, useSDK: () => () => sdk }))

const { DialogProvider, useDialog } = await import("@opencode-ai/ui/context/dialog")
const { DialogProjectMemory } = await import(new URL("../src/components/project-memory.tsx", import.meta.url).pathname)

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

let dispose = () => {}
afterEach(() => {
  dispose()
  document.body.innerHTML = ""
  state.items = []
  state.refused = undefined
})

async function open() {
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
  dialog.show(() => createComponent(DialogProjectMemory, {}))
  await tick(20)
}

const note = (id: string, extra: Item = {}): Item => ({
  id,
  text: `hook ${id}`,
  source: "agent",
  deviceOnly: false,
  time: 1,
  ...extra,
})

describe("a note's body and refs", () => {
  test("show read-only under the hook, collapsed, with refs as path:line or symbol", async () => {
    state.items = [
      note("n1", {
        body: "first line\nsecond line",
        refs: [
          { path: "src/a.ts", line: 12 },
          { path: "README.md" },
          { symbol: "Memory.add", path: "src/m.ts" },
          { symbol: "remember" },
        ],
      }),
    ]
    await open()
    const item = document.querySelector('[data-memory-item="n1"]')!
    const details = item.querySelector("details")
    expect(details).not.toBeNull()
    expect(details!.open).toBe(false)
    expect(details!.querySelector("summary")?.textContent).toContain("hook n1")
    expect(details!.querySelector("[data-memory-body]")?.textContent).toBe("first line\nsecond line")
    expect([...details!.querySelectorAll("[data-memory-ref]")].map((ref) => ref.textContent)).toEqual([
      "src/a.ts:12",
      "README.md",
      "Memory.add (src/m.ts)",
      "remember",
    ])
    // Read-only: nothing inside the detail can be typed into.
    expect(details!.querySelectorAll("input, textarea, [contenteditable]").length).toBe(0)
  })

  test("a note with refs only still shows them; a plain note has no detail", async () => {
    state.items = [note("plain"), note("refs", { refs: [{ path: "a/b.ts", line: 3 }] })]
    await open()
    expect(document.querySelector('[data-memory-item="plain"] details')).toBeNull()
    expect(document.querySelector('[data-memory-item="plain"]')?.textContent).toContain("hook plain")
    const refs = document.querySelector('[data-memory-item="refs"] details')
    expect(refs).not.toBeNull()
    if (!refs) return
    expect(refs.querySelector("[data-memory-body]")).toBeNull()
    expect(refs.querySelector("[data-memory-ref]")?.textContent).toBe("a/b.ts:3")
  })
})

describe("refusal texts name the limit", () => {
  for (const [refusal, expected] of [
    ["long", "Keep the note under 2000 characters."],
    ["body_long", "Keep the note body under 10000 characters"],
    ["too_many_refs", "A note can link at most 10 files or symbols."],
  ] as const) {
    test(refusal, async () => {
      state.items = [note("n1")]
      state.refused = refusal
      await open()
      const input = document.querySelector<HTMLInputElement>("[data-memory-add] input, input[data-memory-add]")!
      input.value = "x"
      input.dispatchEvent(new Event("input", { bubbles: true }))
      input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
      await tick(20)
      const problem = document.querySelector("[data-memory-problem]")?.textContent ?? ""
      expect(problem).toContain(expected)
      expect(problem).not.toContain("{{max}}")
    })
  }
})
