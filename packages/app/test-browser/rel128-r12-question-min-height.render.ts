// Swarm 1.2.8 row 51d (L1-R12 readability, C124), render half. Run by rel128-r12-question-min-height.test.ts.
// At 1024x640 with 8 long options the decision card's actions took the whole card and the bounded body
// `[data-mission-decision-body]` (question + context) shrank to 0 px, so the question could not be read. happy-dom
// has no layout, so this half pins the structure (question inside the body, 8 options outside it) and writes the
// rendered card for the Chromium half to measure.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createComponent, render } from "solid-js/web"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict } from "@/i18n/en"
import { buildMission } from "@/pages/session/swarm/mission-model"
import { fixture } from "@/pages/session/swarm/mission-deliverables.fixture"

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

mock.module("@opencode-ai/session-ui/message-part", () => ({ getToolInfo: () => ({}) }))
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: keyof typeof dict, params?: Record<string, string>) =>
      dict[key] === undefined ? String(key) : resolveTemplate(dict[key], params ?? {}),
    locale: () => "en",
    intl: () => "en",
  }),
}))
const dialogs = await import("@opencode-ai/ui/context/dialog")
mock.module("@opencode-ai/ui/context/dialog", () => ({
  ...dialogs,
  useDialog: () => ({ show: () => {}, close: () => {} }),
}))

// The real surface, not a copy. A computed path keeps the view out of this folder's typecheck.
const { MissionCommand } = await import(
  new URL("../src/pages/session/swarm/mission-command.tsx", import.meta.url).pathname
)

// The live L1-R12 shape (synthetic): a 1,000-character question, 300-character context, 8 options with
// 300-character labels and consequences.
const text = (n: number, tag: string) =>
  Array.from({ length: Math.ceil(n / 10) }, (_, i) => `${tag}${String(i).padStart(4, "0")}q `).join("").slice(0, n)
const dump = process.env.R12_DUMP_DIR

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})

function mount(options: number, long = true) {
  const wire = fixture()
  wire.requests = [
    {
      id: "D-1",
      question: long ? `QSTART ${text(1000, "qu")}` : "QSTART Kilo or Lima?",
      context: long ? text(300, "cx") : undefined,
      options: Array.from({ length: options }, (_, i) => ({
        id: `O${i + 1}`,
        label: long ? `Option ${i + 1} ${text(300, "lb")}` : `Option ${i + 1}`,
        consequence: long ? text(300, "co") : "keeps the form",
      })),
      recommended: "O1",
      status: "open",
      createdAt: "2026-11-14T08:00:00Z",
    },
  ]
  const el = document.createElement("div")
  document.body.append(el)
  dispose = render(
    () =>
      createComponent(MissionCommand, {
        model: buildMission(wire, "en"),
        writer: { answer: async () => ({ ok: false }), instruct: async () => ({ ok: false }) } as never,
        refresh: () => {},
        prompt: async () => undefined,
      }),
    el,
  )
  return el
}

describe("1.2.8 row 51d L1-R12: decision card with 8 long options", () => {
  test("the question sits in [data-mission-decision-body]; the 8 options are outside it", () => {
    const el = mount(8)
    const card = el.querySelector("[data-mission-decision]")
    expect(card === null).toBe(false)
    const body = card!.querySelector("[data-mission-decision-body]")
    expect(body === null).toBe(false)
    expect(body!.querySelectorAll("[data-mission-question]").length).toBe(1)
    expect((body!.textContent ?? "").includes("QSTART")).toBe(true)
    expect(body!.querySelectorAll("[data-mission-option]").length).toBe(0)
    expect(card!.querySelectorAll("[data-mission-decision-actions] [data-mission-option]").length).toBe(8)
    if (dump) writeFileSync(path.join(dump, "eight.html"), el.innerHTML)
  })

  test("a short decision (one-line question, 2 short options) for the normal-size check", () => {
    const el = mount(2, false)
    expect(el.querySelectorAll("[data-mission-option]").length).toBe(2)
    if (dump) writeFileSync(path.join(dump, "two.html"), el.innerHTML)
  })
})
