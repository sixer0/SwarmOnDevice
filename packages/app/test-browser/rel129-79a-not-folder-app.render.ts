import { plugin } from "bun"
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { createSignal, ErrorBoundary, type JSX } from "solid-js"
import { createComponent, render } from "solid-js/web"
import { dict } from "@/i18n/en"

// 1.2.9 row 79a (LIVE-C07 FAIL, C112). A file sat at the Default Project path at launch. Row 55 makes the server answer
// the directory's loads with 400 LOCATION_NOT_FOLDER; the desktop check calls the path "missing", so the folder-missing
// notice shows (Restore / Recreate / Choose). But the restored session read (`api.session.get`, route lineage) threw
// that 400 into its error boundary, which rendered the full "Something went wrong" page behind the notice. After the
// folder came back, Restore cleared the notice and re-ran the load (row 55a), but nothing reset the boundary, so the
// page stayed until a restart.
// Green: a LOCATION_NOT_FOLDER failure under an open notice shows no error page, and Restore / Recreate reset the
// boundary so the project renders again. The live boundaries (app.tsx top level, session.tsx route) use it.
// Synthetic paths; the check is injected. Counts and booleans only (C77). Red at d4282fcfd8: the boundary is Solid's
// plain ErrorBoundary (no FolderNoticeBoundary), so the error page shows and stays.

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

const DIR = "/syn129-79a/Default Project"
const SID = "ses_syn129_79a"

type Toast = {
  id: number
  title?: string
  actions?: { label: string; onClick: unknown }[]
  onDismiss?: () => void
}
const world = { file: true, toasts: [] as Toast[], reads: 0, reloads: 0, opened: 0 }

// As the toast libraries do (row 79a2): a dismissal removes the toast and calls its `onDismiss` once, whatever closed
// it (its X, an action button, `dismissToast`).
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
const { createSessionLineage } = await import(new URL("../src/pages/session/session-lineage.ts", import.meta.url).pathname)

type BoundaryProps = {
  fallback: (error: unknown, reset: () => void) => JSX.Element
  children: JSX.Element
  directory?: string
}
// BASE has no FolderNoticeBoundary: the live boundaries were Solid's ErrorBoundary.
const Boundary: (props: BoundaryProps) => JSX.Element =
  folderMissing.FolderNoticeBoundary ?? ((props: BoundaryProps) => createComponent(ErrorBoundary, props))

// The SDK's wrapped 400 (sdk/js/src/error-interceptor.ts), as the renderer log of LIVE-C07 step 3 shows it.
const notFolder = () =>
  new Error("location is not a folder", {
    cause: {
      body: { name: "LocationNotFolderError", data: { code: "LOCATION_NOT_FOLDER", message: "location is not a folder" } },
      status: 400,
    },
  })

// The session route's lineage store (reactive, as the sync store is): a session read of the directory fails while a
// file sits at its path.
const [sessions, setSessions] = createSignal(new Map<string, { id: string }>())
const store = {
  peek: (id: string) => sessions().get(id),
  resolve: async (id: string) => {
    world.reads++
    if (world.file) throw notFolder()
    setSessions((map) => new Map(map).set(id, { id }))
  },
}

function ProjectView() {
  const lineage = createSessionLineage(
    () => SID,
    () => store,
  )
  return (() => {
    if (!lineage()) return null
    const view = document.createElement("div")
    view.setAttribute("data-project-view", "")
    return view
  }) as unknown as JSX.Element
}

function errorPage(error: unknown) {
  const page = document.createElement("div")
  page.setAttribute("data-error-page", "")
  page.textContent = error instanceof Error ? error.message : "error"
  return page
}

const notice = () =>
  folderMissing.createFolderMissingNotice({
    check: () => async () => (world.file ? "missing" : "exists"),
    recreate: () => async () => {
      world.file = false
      return true
    },
    stored: () => true,
    t: (key: keyof typeof dict, params?: { path: string }) =>
      String(dict[key] ?? key).replace(/{{(\w+)}}/g, (_, name: string) => (name === "path" ? (params?.path ?? "") : "")),
    choose: () => {},
    reload: async () => {
      world.reloads++
    },
  })

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
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
  await tick()
}
// The toast's own X: the toast library dismisses it, no action runs.
const closeX = async () => {
  removeToast(notices().at(-1)!.id)
  await tick()
}

let dispose = () => {}
const mount = (fallback: BoundaryProps["fallback"] = errorPage, directory?: string) => {
  const root = document.createElement("div")
  document.body.appendChild(root)
  dispose = render(
    () =>
      createComponent(Boundary, {
        fallback,
        directory,
        get children() {
          return createComponent(ProjectView, {})
        },
      }),
    root,
  )
}

beforeEach(() => {
  setSessions(new Map())
  world.file = true
  world.toasts = []
  world.reads = 0
  world.reloads = 0
  world.opened = 0
})

afterEach(async () => {
  // Close every notice a test left open (the open-notice count is window-wide), the way a person would.
  world.file = false
  while (notices().length > 0) await click(dict["toast.project.folderMissing.restore"])
  dispose()
  dispose = () => {}
  document.body.innerHTML = ""
})

const onOpen = () => {
  world.opened++
}

describe("79a a 400 LOCATION_NOT_FOLDER at launch", () => {
  test("(a) notice first, then the failed read: the notice shows and the error page does not", async () => {
    const helper = notice()
    expect(await helper.notice(DIR, onOpen)).toBe(true)
    mount()
    await tick()
    expect(world.reads).toBe(1)
    expect(notices().length).toBe(1)
    expect(count("[data-error-page]")).toBe(0)
    expect(count("[data-project-view]")).toBe(0)
  })

  test("(a) failed read first, then the notice: the error page goes once the notice shows", async () => {
    const helper = notice()
    mount()
    await tick()
    await helper.notice(DIR, onOpen)
    await tick()
    expect(notices().length).toBe(1)
    expect(count("[data-error-page]")).toBe(0)
  })

  test("(b) Restore with the folder back: no error page, the project view renders, no restart", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    mount()
    await tick()
    world.file = false
    await click(dict["toast.project.folderMissing.restore"])
    expect(notices().length).toBe(0)
    expect(world.reloads).toBe(1)
    expect(world.opened).toBe(1)
    expect(world.reads).toBe(2)
    expect(count("[data-error-page]")).toBe(0)
    expect(count("[data-project-view]")).toBe(1)
  })

  test("(b) Restore with the file still there keeps the notice and shows no error page; the second Restore works", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    mount()
    await tick()
    await click(dict["toast.project.folderMissing.restore"])
    expect(notices().length).toBe(1)
    expect(count("[data-error-page]")).toBe(0)
    world.file = false
    await click(dict["toast.project.folderMissing.restore"])
    expect(notices().length).toBe(0)
    expect(count("[data-error-page]")).toBe(0)
    expect(count("[data-project-view]")).toBe(1)
  })

  test("(b) Recreate resets the boundary too", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    mount()
    await tick()
    await click(dict["toast.project.folderMissing.recreate"])
    expect(notices().length).toBe(0)
    expect(count("[data-error-page]")).toBe(0)
    expect(count("[data-project-view]")).toBe(1)
  })

  test("CHAR: with no notice open (web, a remote server) the error page still shows", async () => {
    mount()
    await tick()
    expect(count("[data-error-page]")).toBe(1)
  })

  test("CHAR: another error under an open notice still shows the error page", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    const root = document.createElement("div")
    document.body.appendChild(root)
    dispose = render(
      () =>
        createComponent(Boundary, {
          fallback: errorPage,
          get children() {
            return createComponent(() => {
              throw new Error("syn129 other failure")
            }, {})
          },
        }),
      root,
    )
    await tick()
    expect(count("[data-error-page]")).toBe(1)
  })
})

// 1.2.9 row 79a2 (S9E-01, C116). The open-notice count only dropped in the notice's own close(): the toast's X and its
// Choose button closed the notice without it, so a later LOCATION_NOT_FOLDER rendered an empty panel until Restore,
// Recreate or a reload; and the count was window-wide, so a notice for one path hid the error page for another.
// Red at 3ff8bc9af7 (79a): after X or Choose the error page count is 0; a notice for A hides the error for B.
describe("79a2 open notices per path, dropped on every dismissal", () => {
  const OTHER = "/syn129-79a2/Other Project"

  test("after the notice's X, a later LOCATION_NOT_FOLDER shows the error page", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    await closeX()
    expect(notices().length).toBe(0)
    mount()
    await tick()
    expect(world.reads).toBe(1)
    expect(count("[data-error-page]")).toBe(1)
  })

  test("after Choose, a later LOCATION_NOT_FOLDER shows the error page", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    await click(dict["toast.project.folderMissing.choose"])
    expect(notices().length).toBe(0)
    mount()
    await tick()
    expect(count("[data-error-page]")).toBe(1)
  })

  test("after X, an error page already hidden behind the notice comes back", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    mount()
    await tick()
    expect(count("[data-error-page]")).toBe(0)
    await closeX()
    expect(count("[data-error-page]")).toBe(1)
  })

  test("a notice for path A does not hide the error of a boundary for path B", async () => {
    const helper = notice()
    await helper.notice(OTHER, onOpen)
    mount(errorPage, DIR)
    await tick()
    expect(notices().length).toBe(1)
    expect(count("[data-error-page]")).toBe(1)
  })

  test("a notice for path A does not hide an error that names path B", async () => {
    const helper = notice()
    await helper.notice(OTHER, onOpen)
    const root = document.createElement("div")
    document.body.appendChild(root)
    dispose = render(
      () =>
        createComponent(Boundary, {
          fallback: errorPage,
          get children() {
            return createComponent(() => {
              const error = notFolder()
              ;((error.cause as { body: { data: Record<string, unknown> } }).body.data).directory = DIR
              throw error
            }, {})
          },
        }),
      root,
    )
    await tick()
    expect(count("[data-error-page]")).toBe(1)
  })

  test("CHAR: a notice for the boundary's own path still hides its error; Restore still resets it", async () => {
    const helper = notice()
    await helper.notice(DIR, onOpen)
    mount(errorPage, DIR)
    await tick()
    expect(count("[data-error-page]")).toBe(0)
    world.file = false
    await click(dict["toast.project.folderMissing.restore"])
    expect(notices().length).toBe(0)
    expect(count("[data-error-page]")).toBe(0)
    expect(count("[data-project-view]")).toBe(1)
  })

  test("the real toasts (legacy and v2) call onDismiss once, on X and on dismiss", async () => {
    // Imported from ui directly: `@/utils/toast` is mocked in this file.
    const legacy = await import("@opencode-ai/ui/toast")
    const v2 = await import("@opencode-ai/ui/v2/toast-v2")
    const calls = { x: 0, dismiss: 0, v2: 0 }
    const root = document.createElement("div")
    document.body.appendChild(root)
    dispose = render(() => createComponent(legacy.Toast.Region, {}), root)
    legacy.showToast({ title: "syn129 x", persistent: true, onDismiss: () => calls.x++ })
    await tick(50)
    const close = document.querySelector<HTMLElement>('[data-slot="toast-close-button"]')
    expect(close === null).toBe(false)
    close?.click()
    await tick(50)
    // The X closes the toast and waits for its exit animation (solid-presence), which happy-dom never runs: end it.
    const ended = Object.assign(new Event("animationend"), { animationName: "" })
    document.querySelector('[data-component="toast"]')?.dispatchEvent(ended)
    await tick(400)
    const id = legacy.showToast({ title: "syn129 dismiss", persistent: true, onDismiss: () => calls.dismiss++ })
    await tick(50)
    legacy.toaster.dismiss(id)
    await tick(400)
    const v2id = v2.showToastV2({ title: "syn129 v2", persistent: true, onDismiss: () => calls.v2++ })
    v2.toasterV2.dismiss(v2id)
    v2.toasterV2.dismiss(v2id)
    await tick(50)
    expect(calls).toEqual({ x: 1, dismiss: 1, v2: 1 })
  })

  test("CHAR: two notices, X on one: the other still hides a path-free error", async () => {
    const helper = notice()
    await helper.notice(OTHER, onOpen)
    await helper.notice(DIR, onOpen)
    await closeX()
    expect(notices().length).toBe(1)
    mount()
    await tick()
    expect(count("[data-error-page]")).toBe(0)
  })
})

describe("79a wiring: the live boundaries use it", () => {
  const source = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8")
  const between = (text: string, start: string, end: string) => {
    const from = text.indexOf(start)
    const to = text.indexOf(end, from + start.length)
    return from >= 0 && to > from ? text.slice(from, to) : ""
  }

  test("app.tsx: the top-level boundary around the app is a FolderNoticeBoundary with the ErrorPage fallback", () => {
    const block = between(source("../src/app.tsx"), "<UiI18nBridge>", "</UiI18nBridge>")
    expect(block.includes("<FolderNoticeBoundary")).toBe(true)
    expect(block.includes("<ErrorPage error={error} />")).toBe(true)
    expect(block.includes("<ErrorBoundary")).toBe(false)
  })

  test("session.tsx: SessionRouteErrorBoundary is a FolderNoticeBoundary", () => {
    const block = between(source("../src/pages/session.tsx"), "export function SessionRouteErrorBoundary(", "\n}\n")
    expect(block.includes("<FolderNoticeBoundary")).toBe(true)
    expect(block.includes("<ErrorBoundary")).toBe(false)
  })
})
