import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test"
import { createRequire } from "node:module"
import type { JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"

// 1.3.0 row 82 (AC-B1015, B10-15 item 3, N10-205 part 1). Restore and Recreate re-run the failed load of a folder this
// window saw missing (`deps.reload`, 1.2.9 row 55a) and wait for it before the boundary resets, the notice closes and
// `onOpen` runs. A reload that never settled kept the notice's open entry (and the person's project) waiting forever.
// Green: the wait is bounded by FOLDER_RELOAD_TIMEOUT_MS (10,000 ms, N10-142); a reload that settles first (resolve or
// reject) behaves exactly as before and its timer is cleared. Driven with Bun's fake clock.
// Red at a3e3c4c93a: R1 and R2 have `onOpen` 0 calls after 10,000 ms and the notice still open.
// Synthetic paths; the check is injected. Counts and booleans only (C77).

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

type Toast = {
  id: number
  title?: string
  actions?: { label: string; onClick: unknown }[]
  onDismiss?: () => void
}
const world = { file: true, toasts: [] as Toast[], renders: 0, opened: 0, reloads: 0 }

// As the toast libraries do: a dismissal removes the toast and calls its `onDismiss` once.
const removeToast = (id: number) => {
  const toast = world.toasts.find((item) => item.id === id)
  world.toasts = world.toasts.filter((item) => item.id !== id)
  toast?.onDismiss?.()
}

let toastSeq = 0
const real = await import("@/utils/toast")
mock.module("@/utils/toast", () => ({
  ...real,
  showToast: (options: Omit<Toast, "id">) => {
    const id = ++toastSeq
    world.toasts.push({ ...options, id })
    return id
  },
  dismissToast: removeToast,
}))

const folderMissing = await import(new URL("../src/pages/layout/folder-missing.ts", import.meta.url).pathname)

const notFolder = () =>
  new Error("location is not a folder", {
    cause: {
      body: { name: "LocationNotFolderError", data: { code: "LOCATION_NOT_FOLDER", message: "location is not a folder" } },
      status: 400,
    },
  })

// The project content: it throws the 400 while a file sits at the path; each render after the first is one boundary
// reset (the listener Restore / Recreate run when the folder is back).
function ProjectView() {
  world.renders++
  if (world.file) throw notFolder()
  const view = document.createElement("div")
  view.setAttribute("data-project-view", "")
  return view as unknown as JSX.Element
}

const errorPage = () => {
  const page = document.createElement("div")
  page.setAttribute("data-error-page", "")
  return page as unknown as JSX.Element
}

const notice = (reload: () => Promise<unknown>) =>
  folderMissing.createFolderMissingNotice({
    check: () => async () => (world.file ? "missing" : "exists"),
    recreate: () => async () => {
      world.file = false
      return true
    },
    stored: () => true,
    t: (key: keyof typeof dict) => String(dict[key] ?? key),
    choose: () => {},
    reload: () => {
      world.reloads++
      return reload()
    },
  })

// Microtasks only: the fake clock owns every timer.
const flush = async () => {
  for (let index = 0; index < 50; index++) await Promise.resolve()
}
const count = (selector: string) => document.querySelectorAll(selector).length
const notices = () => world.toasts.filter((item) => item.title === dict["toast.project.folderMissing.title"])
const click = async (label: string) => {
  const action = notices()
    .at(-1)
    ?.actions?.find((item) => item.label === label)
  if (!action || typeof action.onClick !== "function") throw new Error(`no "${label}" action`)
  const id = notices().at(-1)!.id
  action.onClick()
  // The toast's action button dismisses its toast right after the handler (ui toast.tsx, toast-v2.tsx).
  removeToast(id)
  await flush()
}
const advance = async (ms: number) => {
  jest.advanceTimersByTime(ms)
  await flush()
}

let dispose = () => {}
const mount = (directory: string) => {
  const root = document.createElement("div")
  document.body.appendChild(root)
  dispose = render(
    () =>
      createComponent(folderMissing.FolderNoticeBoundary, {
        fallback: errorPage,
        directory,
        get children() {
          return createComponent(ProjectView, {})
        },
      }),
    root,
  )
}

// The notice for `directory` is still open: the boundary hides its error page and nothing renders.
const stillOpen = () => count("[data-error-page]") === 0 && count("[data-project-view]") === 0

const onOpen = () => {
  world.opened++
}

// One folder per case, so a notice entry a red run leaves behind cannot reach the next case.
async function start(directory: string, reload: () => Promise<unknown>) {
  const helper = notice(reload)
  expect(await helper.notice(directory, onOpen)).toBe(true)
  mount(directory)
  await flush()
  expect(world.renders).toBe(1)
  expect(stillOpen()).toBe(true)
  // The folder is back.
  world.file = false
  return helper
}

beforeEach(() => {
  world.file = true
  world.toasts = []
  world.renders = 0
  world.opened = 0
  world.reloads = 0
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})

describe("AC-B1015 the Restore / Recreate reload wait is bounded", () => {
  test("constant: FOLDER_RELOAD_TIMEOUT_MS is 10,000", () => {
    expect(folderMissing.FOLDER_RELOAD_TIMEOUT_MS).toBe(10_000)
  })

  test("R1 Restore with a reload that never settles opens after 10,000 ms, not before", async () => {
    await start("/syn1210-b1015/R1", () => new Promise(() => {}))
    await click(dict["toast.project.folderMissing.restore"])
    expect(world.reloads).toBe(1)
    await advance(9_999)
    expect(world.opened).toBe(0)
    expect(stillOpen()).toBe(true)
    expect(world.renders).toBe(1)
    await advance(1)
    expect(world.opened).toBe(1)
    expect(stillOpen()).toBe(false)
    expect(count("[data-project-view]")).toBe(1)
    expect(count("[data-error-page]")).toBe(0)
    // The boundary reset listener ran once.
    expect(world.renders).toBe(2)
    expect(notices().length).toBe(0)
  })

  test("R2 Recreate with a reload that never settles opens after 10,000 ms, not before", async () => {
    await start("/syn1210-b1015/R2", () => new Promise(() => {}))
    world.file = true
    await click(dict["toast.project.folderMissing.recreate"])
    expect(world.file).toBe(false)
    expect(world.reloads).toBe(1)
    await advance(9_999)
    expect(world.opened).toBe(0)
    expect(stillOpen()).toBe(true)
    expect(world.renders).toBe(1)
    await advance(1)
    expect(world.opened).toBe(1)
    expect(stillOpen()).toBe(false)
    expect(count("[data-project-view]")).toBe(1)
    expect(world.renders).toBe(2)
    expect(notices().length).toBe(0)
  })

  test("R3 control: a reload that resolves at 50 ms opens at 50 ms and its timer is cleared", async () => {
    await start("/syn1210-b1015/R3", () => new Promise((resolve) => setTimeout(resolve, 50)))
    await click(dict["toast.project.folderMissing.restore"])
    await advance(49)
    expect(world.opened).toBe(0)
    expect(stillOpen()).toBe(true)
    await advance(1)
    expect(world.opened).toBe(1)
    expect(count("[data-project-view]")).toBe(1)
    expect(world.renders).toBe(2)
    // The timer is cleared: the 10,000 ms mark passes without a second open, reset or reload. (`jest.getTimerCount()`
    // is not used: under the happydom preload a fired happy-dom timer stays counted.)
    await advance(10_000)
    expect(world.opened).toBe(1)
    expect(world.renders).toBe(2)
    expect(world.reloads).toBe(1)
    expect(notices().length).toBe(0)
  })

  test("R4 control: a reload that rejects still opens at once (BASE behaviour)", async () => {
    await start("/syn1210-b1015/R4", () => Promise.reject(new Error("synthetic reload failure")))
    await click(dict["toast.project.folderMissing.restore"])
    expect(world.reloads).toBe(1)
    expect(world.opened).toBe(1)
    expect(count("[data-project-view]")).toBe(1)
    expect(world.renders).toBe(2)
    expect(notices().length).toBe(0)
    await advance(10_000)
    expect(world.opened).toBe(1)
    expect(world.renders).toBe(2)
  })
})
