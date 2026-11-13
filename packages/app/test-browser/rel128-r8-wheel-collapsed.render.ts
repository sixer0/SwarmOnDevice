// Swarm 1.2.8 row 30 (AC-R8, N8-323), render half. Run by rel128-r8-wheel-collapsed.test.ts.
// R-8: a mouse wheel over a collapsed Decisions entry did not scroll the list. Each entry's body
// `[data-map-decision-body]` is an `overflow-y-auto` box with `overscroll-contain`. A collapsed body has nothing to
// scroll, and Chromium still stops the wheel there instead of passing it on to the list `[data-map-decisions]`.
// happy-dom has no layout, so this half pins the class rule (a collapsed body carries no `overscroll-contain`, an
// expanded one keeps it) and, when R8_DUMP_DIR is set, writes the rendered list for the Chromium half to scroll.
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { writeFileSync } from "node:fs"
import path from "node:path"
import type { AutonomyAuditLine } from "@opencode-ai/sdk/v2"
import { createSignal } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict } from "@/i18n/en"
import { decisionGroups } from "@/pages/session/map/session-map-model"

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

// The message parts pull in a Vite worker URL, which Bun cannot load. Nothing drawn here uses them.
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
const { DecisionList } = await import(
  new URL("../src/pages/session/map/session-map-view.tsx", import.meta.url).pathname
)

// The 2nd entry carries a long pattern, for an expanded body that has something to scroll.
const LONG = Array.from({ length: 375 }, (_, i) => `seg${String(i).padStart(4, "0")}-`).join("")
const COUNT = 12
const LONG_ID = "r8_01"
const dump = process.env.R8_DUMP_DIR

let dispose = () => {}
afterEach(() => {
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})

const classes = (el: Element | null | undefined) =>
  new Set((el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean))

function mount() {
  const lines = Array.from({ length: COUNT }, (_, i) => {
    const seq = i + 1
    const id = `r8_${String(i).padStart(2, "0")}`
    return {
      v: 1,
      seq,
      prev: "",
      at: seq,
      type: "decision",
      rootID: "root",
      sessionID: "root",
      requestID: id,
      messageID: `msg_${seq}`,
      agent: "build",
      directory: "/repo",
      permission: "bash",
      patterns: [id === LONG_ID ? `echo r8 ${LONG}` : `echo r8 entry ${seq}`],
      patternsTruncated: false,
      class: "D",
      risk: "",
      canUndo: true,
      decidedBy: "gate",
      decision: "defer",
      category: "outward",
      memo: false,
      follows: [],
    }
  }) as unknown as AutonomyAuditLine[]
  const [groups] = createSignal(decisionGroups(lines, "root"))
  const decisions = {
    store: { state: { externalChange: [], intact: true, lines, rootID: "root", on: true }, failed: false },
    groups,
    consent: () => undefined,
    archive: () => undefined,
    ticked: () => new Set<string>(),
    consentBusy: () => false,
    tick: () => {},
    allowConsent: () => {},
    archiveBusy: () => false,
    emptyArchive: () => {},
    calls: () => [],
    canAlways: () => false,
    replyBusy: () => false,
    undoBusy: () => false,
    reply: () => {},
    undo: () => {},
    canRetry: () => true,
    retry: () => {},
    refresh: () => {},
    confirm: () => {},
  }
  const el = document.createElement("div")
  document.body.append(el)
  dispose = render(() => createComponent(DecisionList, { decisions, directory: "/repo" }), el)
  const list = el.querySelector<HTMLElement>("[data-map-decisions]")!
  expect(list).not.toBeNull()
  return list
}

const write = (name: string, list: HTMLElement) => {
  if (dump) writeFileSync(path.join(dump, name), list.outerHTML)
}

describe("1.2.8 row 30 R-8: Decisions entry bodies and the wheel", () => {
  test("12 collapsed entries: no body carries overscroll-contain, so a wheel over one reaches the list", () => {
    const list = mount()
    write("collapsed.html", list)
    const bodies = [...list.querySelectorAll("[data-map-decision-body]")]
    expect(bodies.length).toBe(COUNT)
    for (const body of bodies) expect(classes(body).has("overscroll-contain")).toBe(false)
    // The body stays a bounded scroll box for what Details adds (1.2.7 U-5); only the wheel stop goes.
    for (const body of bodies) for (const c of ["overflow-y-auto", "min-h-0"]) expect(classes(body).has(c)).toBe(true)
  })

  test("an expanded entry keeps overscroll-contain on its body; the collapsed ones around it do not", () => {
    const list = mount()
    const row = list.querySelector<HTMLElement>(`[data-decision="${LONG_ID}"]`)!
    expect(row).not.toBeNull()
    row.querySelector<HTMLButtonElement>("[data-decision-details-toggle]")!.click()
    write("expanded.html", list)
    const body = row.querySelector("[data-map-decision-body]")!
    expect(body.querySelector("[data-decision-details]")).not.toBeNull()
    expect(classes(body).has("overscroll-contain")).toBe(true)
    const others = [...list.querySelectorAll("[data-map-decision-body]")].filter((b) => !row.contains(b))
    expect(others.length).toBe(COUNT - 1)
    for (const b of others) expect(classes(b).has("overscroll-contain")).toBe(false)
  })
})
