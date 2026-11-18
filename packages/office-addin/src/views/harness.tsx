// Test-only harness for the pane component tests (M8-05). Renders the real App over the in-memory
// bridge (api/fake-bridge.ts), an in-memory host adapter (host/memory.ts), an in-memory Web
// Storage and manual timers. Load it through `await import()` after ./solid-test.
import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { createOfficeApi } from "../api/client"
import { fakeBridge } from "../api/fake-bridge"
import type { PerfMarkName } from "../api/marks"
import { App } from "../app"
import { memoryExcelHost, memoryWordHost } from "../host/memory"
import type { ExcelHost, WordHost } from "../host/types"
import { convertCell } from "../excel"
import { I18nProvider } from "../i18n"
import { Grid } from "./preview"
import type { Locale } from "../i18n"
import type { ContextScope } from "../state/prompt"
import { memoryStore } from "../state/test-store"
import { readToken, type PaneStore } from "../state/storage"
import { createPaneController, type Timers } from "./controller"
import type { PreviewSlot } from "./thread"

export const TOKEN = "swo1_" + "A".repeat(43)

function manualTimers() {
  const intervals = new Map<number, { fn: () => void; ms: number }>()
  const timeouts = new Map<number, () => void>()
  const next = { id: 0 }
  const timers: Timers = {
    setInterval: (fn, ms) => {
      intervals.set(++next.id, { fn, ms })
      return next.id
    },
    clearInterval: (id) => void intervals.delete(id as number),
    setTimeout: (fn) => {
      timeouts.set(++next.id, fn)
      return next.id
    },
    clearTimeout: (id) => void timeouts.delete(id as number),
  }
  return {
    timers,
    // Runs every interval callback registered with `ms` once.
    tick: (ms: number) => [...intervals.values()].filter((entry) => entry.ms === ms).forEach((entry) => entry.fn()),
    flushTimeouts: () => {
      const all = [...timeouts.values()]
      timeouts.clear()
      all.forEach((fn) => fn())
    },
    intervals,
  }
}

export const settle = async (rounds = 20) => {
  for (const _ of Array.from({ length: rounds })) await new Promise((resolve) => setTimeout(resolve, 0))
}

/** @internal test seam */
export type MountOptions = {
  host?: "Word" | "Excel" | "PowerPoint"
  token?: boolean
  acknowledged?: boolean
  readOnly?: boolean
  locale?: Locale
  reducedMotion?: boolean
  documentUrl?: string
  bridge?: Parameters<typeof fakeBridge>[0]
  word?: Parameters<typeof memoryWordHost>[0]
  excel?: Parameters<typeof memoryExcelHost>[0]
  preview?: PreviewSlot
  // Skip Office.onReady (stay in `loading`).
  noOffice?: boolean
  now?: () => number
  // M8-06: reuse a storage across mounts (remount persistence, U-UI-09).
  storage?: ReturnType<typeof memoryStore>
  // M8-06: replace the recording clipboard (refusal paths).
  clipboard?: (text: string) => Promise<boolean>
  // M8-07: Office.context.partitionKey, so keys such as disclosureAck are per host (REG §5).
  partitionKey?: string
  // M8-07: awaited before every adapter write, so a test can hold a write "running".
  writeGate?: () => Promise<void>
}

export async function mount(options: MountOptions = {}) {
  const storage = options.storage ?? memoryStore()
  const store: PaneStore = { storage, partitionKey: options.partitionKey }
  const prefix = options.partitionKey ? `${options.partitionKey}:` : ""
  if (options.token) storage.setItem(`${prefix}swarm.office.token`, TOKEN)
  if (options.acknowledged) storage.setItem(`${prefix}swarm.office.disclosureAck`, "1")
  const bridge = fakeBridge(options.bridge)
  const api = createOfficeApi({ token: () => readToken(store), fetch: bridge.fetch })
  const word = memoryWordHost({ selection: "Selected text\r", body: "Body text", ...options.word })
  const excel = memoryExcelHost(options.excel)
  const clock = manualTimers()
  const marks: PerfMarkName[] = []
  const copied: string[] = []
  const errors: string[] = []
  // Every adapter read, in order (FR-01: reads happen only at a user action, U-UI-16).
  const reads: string[] = []
  const counted = <T extends { read: (scope: ContextScope) => Promise<unknown> }>(adapter: T): T => ({
    ...adapter,
    read: (scope: ContextScope) => {
      reads.push(scope)
      return adapter.read(scope)
    },
  })
  // M8-07: previews are logged as `preview:<action>`; writes wait for the optional gate.
  const gate = options.writeGate ?? (async () => {})
  const wordAdapter: WordHost = {
    ...counted(word),
    preview: (action, text) => {
      reads.push(`preview:${action}`)
      return word.preview(action, text)
    },
    write: async (action, text, expected) => {
      await gate()
      return word.write(action, text, expected)
    },
  }
  const excelAdapter: ExcelHost = {
    ...counted(excel),
    preview: (action, text) => {
      reads.push(`preview:${action}`)
      return excel.preview(action, text)
    },
    write: async (action, text, expected) => {
      await gate()
      return excel.write(action, text, expected)
    },
  }
  const controller = createPaneController({
    api,
    store,
    adapter: (host) => (host === "Excel" ? excelAdapter : wordAdapter),
    documentUrl: () => options.documentUrl ?? "/Users/test/Doc.docx",
    officePresent: () => !options.noOffice,
    timers: clock.timers,
    mark: (name) => void marks.push(name),
    clipboard:
      options.clipboard ??
      (async (text) => {
        copied.push(text)
        return true
      }),
    onError: (source) => void errors.push(source),
    now: options.now,
  })
  const [reduced] = createSignal(options.reducedMotion === true)
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => (
      <App
        controller={controller}
        locale={options.locale ?? "en"}
        reducedMotion={reduced}
        preview={options.preview}
      />
    ),
    container,
  )
  const stop = controller.start()
  if (!options.noOffice) {
    controller.officeReady({ host: options.host ?? "Word", readOnly: options.readOnly === true })
  }
  await settle()
  return {
    controller,
    container,
    bridge,
    storage,
    word,
    excel,
    clock,
    marks,
    copied,
    errors,
    reads,
    q: <T extends Element = HTMLElement>(selector: string) => container.querySelector<T>(selector),
    qa: <T extends Element = HTMLElement>(selector: string) => [...container.querySelectorAll<T>(selector)],
    controls: () => [...container.querySelectorAll("[data-control]")].map((el) => el.getAttribute("data-control")),
    unmount: () => {
      stop()
      dispose()
      container.remove()
    },
  }
}

// Message frames as the server sends them (REG §7.7; shapes of 14_s4_capture_thinker.txt).
export const frames = {
  connected: { type: "server.connected", properties: {} },
  message: (sessionID: string, id: string, role: string, extra: Record<string, unknown> = {}) => ({
    type: "message.updated",
    properties: { sessionID, info: { id, role, sessionID, ...extra } },
  }),
  part: (sessionID: string, messageID: string, id: string, type: string) => ({
    type: "message.part.updated",
    properties: { sessionID, part: { id, messageID, sessionID, type, text: "" } },
  }),
  delta: (sessionID: string, messageID: string, partID: string, delta: string) => ({
    type: "message.part.delta",
    properties: { sessionID, messageID, partID, field: "text", delta },
  }),
  idle: (sessionID: string) => ({ type: "session.idle", properties: { sessionID } }),
  // M8-06
  error: (sessionID: string) => ({ type: "session.error", properties: { sessionID, error: { name: "UnknownError" } } }),
  noise: (sessionID: string) => [
    { type: "plugin.added", properties: { name: "x" } },
    { type: "session.status", properties: { sessionID, status: { type: "busy" } } },
    { type: "session.diff", properties: { sessionID, diff: [] } },
    { type: "lsp.updated", properties: {} },
  ],
}

// M8-07: the Excel preview grid alone, one row of cells converted as the planner does (U-UI-23
// cases a TSV reply cannot carry, such as a leading tab).
/** @internal test seam */
export function renderGrid(values: string[]) {
  const container = document.createElement("div")
  document.body.append(container)
  const dispose = render(
    () => (
      <I18nProvider locale="en">
        <Grid cells={[values.map(convertCell)]} rowIndex={0} columnIndex={0} />
      </I18nProvider>
    ),
    container,
  )
  return {
    container,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}
