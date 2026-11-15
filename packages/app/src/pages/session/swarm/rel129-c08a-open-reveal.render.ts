// Swarm 1.2.9 row 56b (AC-C08a residual, decision C53). Render half, run by rel129-c08a-open-reveal.test.ts in a child
// process (browser conditions + Solid JSX transform, the mission-control.render.ts pattern).
//
// A root mission (project dir R) seen from a session in group R/G: row 56 lists `x.md` from R's folder. Open and Reveal
// of that line must act on R's file, not on a file of the same name under the group. The fake disk holds both, so a
// lookup or an action that resolves against the group is visible as the group path. Synthetic paths only (syn129).
// Assertions are counts, booleans and strings only (C77).
import { plugin } from "bun"
import { afterEach, describe, expect, mock, test } from "bun:test"
import { createRequire } from "node:module"
import { createComponent, render } from "solid-js/web"
import { dict as en } from "@/i18n/en"
import { fixture } from "./mission-deliverables.fixture"
import type { MissionGetWire, MissionListItemWire } from "./mission-model"

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

const R = "/syn129/Default Project"
const G = `${R}/Golf`
const M = "2026-11-14_syn129-c08b"
const X = `docs/${M}/11_deliverables/x.md`
const SES = ["ses_syn129c08b"]

// The session's folder, as the SDK context gives it to the deliverables list (sdk().directory).
let sessionDir = G
// What the platform's reveal was asked for (MissionDeliverables falls back to platform.revealPath).
const platformRevealed: string[] = []

const table: Record<string, string> = en
const real = await import("@/context/language")
mock.module("@/context/language", () => ({
  ...real,
  useLanguage: () => ({
    t: (key: string, params?: Record<string, string>) =>
      (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_: string, name: string) => String(params?.[name] ?? "")),
    locale: () => "en",
    intl: () => "en-US",
  }),
}))
const realPlatform = await import("@/context/platform")
mock.module("@/context/platform", () => ({
  ...realPlatform,
  usePlatform: () => ({
    platform: "desktop",
    os: "macos",
    revealPath: async (abs: string) => {
      platformRevealed.push(abs)
      return true
    },
  }),
}))
const realSdk = await import("@/context/sdk")
mock.module("@/context/sdk", () => ({ ...realSdk, useSDK: () => () => ({ directory: sessionDir }) }))

const { MissionControl } = await import(new URL("./mission-control.tsx", import.meta.url).pathname)
const poll = await import(new URL("./mission-poll.ts", import.meta.url).pathname)

function wire(projectDir: string): MissionGetWire {
  const base = fixture()
  return {
    ...base,
    mission: { ...base.mission, id: M, title: "C08a open/reveal", project: { dir: projectDir } } as never,
    deliverables: [],
    requests: [],
  }
}

const item: MissionListItemWire = {
  id: M,
  title: "C08a open/reveal",
  type: "document",
  status: "running",
  progress: { done: 0, total: 1 },
  openRequests: [],
  updatedAt: "t1",
} as MissionListItemWire

// Both folders hold docs/<m>/11_deliverables/x.md. A bare name is a shown file (BASE's listing shape and HEAD's);
// the directory entry is what HEAD's presence check looks for.
const listing: Array<string | { name: string; type: "directory" }> = ["notes.md", { name: "11_deliverables", type: "directory" }]
const disk: Record<string, Array<string | { name: string; type: "directory" }>> = {
  [`${R}/docs/${M}`]: listing,
  [`${R}/docs/${M}/11_deliverables`]: ["x.md"],
  [`${G}/docs/${M}`]: listing,
  [`${G}/docs/${M}/11_deliverables`]: ["x.md"],
}

async function stateFor(session: string, projectDir: string) {
  const calls: string[] = []
  const states: Record<string, unknown>[] = []
  const poller = poll.createMissionPoller({
    source: {
      list: async () => ({ ok: true, data: { items: [item] } }),
      get: async () => ({ ok: true, data: wire(projectDir) }),
    },
    directory: () => session,
    sessions: () => SES,
    lang: () => "en",
    // A call without a directory resolves against the session's folder (the SDK's default), as at BASE.
    listFiles: async (path: string, directory?: string) => {
      const folder = directory ?? session
      calls.push(`${folder}/${path}`)
      return disk[`${folder}/${path}`] ?? []
    },
    openFolders: () => [R, G],
    onState: (s: Record<string, unknown>) => states.push(s),
  })
  poller.setMode("live")
  for (let i = 0; i < 60 && !(states.at(-1) as { mission?: unknown } | undefined)?.mission; i++)
    await new Promise((r) => setTimeout(r, 0))
  poller.dispose()
  return { state: states.at(-1) as Record<string, unknown>, calls }
}

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
  platformRevealed.length = 0
})

async function mount(session: string, projectDir: string) {
  sessionDir = session
  const { state, calls } = await stateFor(session, projectDir)
  const opened: string[] = []
  const revealed: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  const control = { state, available: true, select: () => {}, refresh: () => {} }
  dispose = render(
    () =>
      createComponent(MissionControl, {
        control,
        prompt: async () => {},
        openFile: (path: string) => opened.push(path),
        revealFile: (abs: string) => revealed.push(abs),
      }),
    host,
  )
  const line = () => host.querySelector<HTMLButtonElement>(`[data-mission-deliverable="folder:x.md"]`)
  const reveal = () => line()?.parentElement?.querySelector<HTMLButtonElement>("[data-deliverable-reveal]") ?? null
  /** The file each action reached: a file-tab open is relative to the session's folder; a reveal is absolute. */
  const targets = () => [
    ...opened.map((path) => `open ${session}/${path}`),
    ...[...revealed, ...platformRevealed].map((abs) => `reveal ${abs}`),
  ]
  return { calls, line, reveal, targets, opened, revealed, state }
}

describe("AC-C08a residual (row 56b): Open and Reveal act on the mission folder's file", () => {
  test("root mission, session in group: Open and Reveal reach R's x.md, never the group's", async () => {
    const view = await mount(G, R)
    expect(view.line() !== null).toBe(true)
    view.line()!.click()
    expect(view.targets().length).toBe(1)
    expect(view.targets()[0]).toBe(`reveal ${R}/${X}`)
    expect(view.reveal() !== null).toBe(true)
    view.reveal()!.click()
    expect(view.targets().length).toBe(2)
    expect(view.targets()[1]).toBe(`reveal ${R}/${X}`)
    // Nothing reached the group's copy, and no file tab of the group's folder was opened.
    expect(view.targets().filter((t) => t.includes(`${G}/`)).length).toBe(0)
    expect(view.opened.length).toBe(0)
    // The poll carries the folder the line was found in (MissionControlState).
    expect(view.state.deliverablesFolder as string | undefined).toBe(R)
  })

  test("mission in the session's own folder: Open opens the file tab, Reveal shows that folder's file (unchanged)", async () => {
    const view = await mount(R, R)
    expect(view.line() !== null).toBe(true)
    expect(view.state.deliverablesFolder === undefined).toBe(true)
    view.line()!.click()
    expect(view.opened.length).toBe(1)
    expect(view.opened[0]).toBe(X)
    view.reveal()!.click()
    expect(view.targets().length).toBe(2)
    expect(view.targets()[1]).toBe(`reveal ${R}/${X}`)
  })

  test("group mission seen from the root session: Open and Reveal reach the group's x.md", async () => {
    const view = await mount(R, G)
    expect(view.line() !== null).toBe(true)
    view.line()!.click()
    view.reveal()!.click()
    expect(view.targets().length).toBe(2)
    expect(view.targets()[0]).toBe(`reveal ${G}/${X}`)
    expect(view.targets()[1]).toBe(`reveal ${G}/${X}`)
  })
})
