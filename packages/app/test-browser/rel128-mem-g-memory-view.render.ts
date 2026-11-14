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
const state: { items: Item[]; refused?: string; added: unknown[] } = { items: [], added: [] }
const client = {
  memory: {
    get: async () => ({ data: { enabled: true, items: state.items } }),
    add: async (input: unknown) => {
      state.added.push(input)
      return { data: state.refused ? { refused: state.refused } : { item: state.items[0] } }
    },
    remove: async () => ({ data: true }),
    update: async () => ({ data: state.refused ? { refused: state.refused } : {} }),
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
  state.added = []
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

// Synthetic store (no user data): 12 archived Q1 entries behind one roll-up, two live entries, two notes.
const entry = (id: string, date: string, extra: Item = {}): Item => ({
  id,
  text: `${date} ${id} | done | triggers: memory, index | docs/${id}/10_report/report.md`,
  source: "agent",
  deviceOnly: false,
  time: Date.parse(date),
  kind: "index",
  missionId: id,
  ...extra,
})
const archived = Array.from({ length: 12 }, (_, i) =>
  entry(`2026-01-${String(i + 1).padStart(2, "0")}_m${i + 1}`, `2026-01-${String(i + 1).padStart(2, "0")}`, {
    rolledInto: "r1",
    body: i === 0 ? "decided: keep it whole" : undefined,
  }),
)
const rollup: Item = {
  id: "r1",
  text: "2026-Q1 roll-up | 12 missions | triggers: memory, index | body",
  body: archived.map((item) => `[${item.id}] ${item.text}`).join("\n"),
  source: "agent",
  deviceOnly: false,
  time: Date.parse("2026-04-01"),
  kind: "index_rollup",
}
const store = () => [
  note("n-old"),
  rollup,
  entry("2026-04-10_a", "2026-04-10"),
  ...archived,
  note("n-future", { kind: "future" }),
  entry("2026-05-02_b", "2026-05-02"),
]

const ids = (root: ParentNode) =>
  [...root.querySelectorAll("[data-memory-item]")].map((item) => item.getAttribute("data-memory-item"))

describe("the mission index group", () => {
  test("renders first, headed Mission index, newest first; notes follow in today's order", async () => {
    state.items = store()
    await open()
    const group = document.querySelector("[data-memory-index]")
    expect(group).not.toBeNull()
    if (!group) return
    expect(group.querySelector("h3")?.textContent).toBe("Mission index")
    expect(ids(group)).toEqual(["2026-05-02_b", "2026-04-10_a", "r1"])
    // The group comes before every ordinary note, and the notes keep today's order (reversed store order).
    expect(ids(document)).toEqual(["2026-05-02_b", "2026-04-10_a", "r1", "n-future", "n-old"])
    // Unknown kinds read as notes (01e §2.1); archived members are not rows of their own.
    expect(group.querySelector('[data-memory-item="n-future"]')).toBeNull()
    expect(document.querySelectorAll("[data-memory-item^='2026-01-']").length).toBe(0)
  })

  test("an index row shows Mission index on its source line and can be edited", async () => {
    state.items = store()
    await open()
    const row = document.querySelector('[data-memory-item="2026-05-02_b"]')!
    expect(row.querySelector("[data-memory-kind-label]")?.textContent).toBe("Mission index")
    expect(row.querySelector("[data-memory-edit-button]")).not.toBeNull()
    expect(row.querySelector("[data-memory-delete]")).not.toBeNull()
    expect(document.querySelector('[data-memory-item="n-old"] [data-memory-kind-label]')).toBeNull()
  })

  test("a roll-up is labelled as a summary; its archived members sit read-only inside its details", async () => {
    state.items = store()
    await open()
    const row = document.querySelector('[data-memory-item="r1"]')!
    const details = row.querySelector("details")!
    expect(details.open).toBe(false)
    expect(details.querySelector("summary")?.textContent).toBe("Summary of 12 missions, 2026-Q1")
    const members = [...details.querySelectorAll("[data-memory-archived]")]
    expect(members.map((member) => member.getAttribute("data-memory-archived"))).toEqual(
      archived.map((a) => a.id as string),
    )
    expect(members[0].textContent).toContain("docs/2026-01-01_m1/10_report/report.md")
    expect(members[0].querySelector("[data-memory-body]")?.textContent).toBe("decided: keep it whole")
    expect(details.querySelectorAll("input, textarea, [contenteditable], button").length).toBe(0)
    expect(row.querySelector("[data-memory-edit-button]")).toBeNull()
    expect(row.querySelector("[data-memory-delete]")).not.toBeNull()
  })

  test("the hidden notice names the archived count under the index group", async () => {
    state.items = store()
    await open()
    const hidden = document.querySelector("[data-memory-index] [data-memory-index-hidden]")
    expect(hidden?.textContent).toBe(
      "12 older mission entries are not loaded into new sessions. They are kept and can still be recalled.",
    )
  })

  test("without index entries there is no group and no notice", async () => {
    state.items = [note("n1"), note("n2")]
    await open()
    expect(document.querySelector("[data-memory-index]")).toBeNull()
    expect(document.querySelector("[data-memory-index-hidden]")).toBeNull()
    expect(ids(document)).toEqual(["n2", "n1"])
  })
})

describe("index refusals and the add form", () => {
  test("an index_long refusal on an edit shows the index text with max 300", async () => {
    state.items = store()
    await open()
    const row = document.querySelector('[data-memory-item="2026-05-02_b"]')!
    row.querySelector<HTMLElement>("[data-memory-edit-button]")!.click()
    await tick(20)
    const input = row.querySelector<HTMLInputElement>("[data-memory-edit] input, input[data-memory-edit]")!
    input.value = `${"x".repeat(301)}`
    state.refused = "index_long"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    await tick(20)
    expect(document.querySelector("[data-memory-problem]")?.textContent).toBe(
      "A mission index entry is one line of at most 300 characters. Shorten the outcome or the triggers.",
    )
  })

  for (const [refusal, expected] of [
    ["index_body_long", "Keep the index entry detail under 2000 characters; link the final report instead."],
    ["index_format", "An index entry reads: date mission-id | outcome | triggers: words | report path."],
    ["index_full", "The mission index is full and its older entries cannot be summarised"],
  ] as const) {
    test(`${refusal} is mapped`, async () => {
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

  test("the add form stays notes-only: it sends the text and nothing else", async () => {
    state.items = store()
    await open()
    const input = document.querySelector<HTMLInputElement>("[data-memory-add] input, input[data-memory-add]")!
    input.value = "a plain note"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    await tick(20)
    expect(state.added).toEqual([{ text: "a plain note" }])
  })
})

describe("the privacy line (SR8-19, N8-482)", () => {
  test("names the backup copy kept when a mission moves into a group", async () => {
    state.items = store()
    await open()
    const text = document.body.textContent ?? ""
    expect(text).toContain("Kept on this device, never in the repository.")
    expect(text).toContain(
      "When a mission moves into a group, Swarm keeps a backup copy of this project's memory file in its data folder.",
    )
  })
})
