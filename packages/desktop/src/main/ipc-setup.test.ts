import { beforeEach, describe, expect, test } from "bun:test"
import type { BrowserWindow, IpcMainInvokeEvent, MessageBoxOptions, WebContents } from "electron"
import { SETUP_TOOLS_IPC } from "../preload/setup-tools-channels"
import type { SetupComponentStates, SetupResult } from "./setup-runner"
import {
  createInstallConfirm,
  registerSetupToolsHandlers,
  SETUP_CONFIRM_KEYS,
  type SetupToolsIpcDeps,
} from "./setup-tools-ipc"

// Real handlers from setup-tools-ipc.ts against a fake ipcMain, fake windows and a fake runner.
// No module mocks: the file imports only electron types, so nothing here spawns swarm-setup.

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
type FakeSender = { mainFrame: { url: string }; destroyed: boolean; sent: unknown[][] }

const RENDERER_URL = "oc://renderer/index.html"

const ran = (): SetupResult => ({
  kind: "ran",
  args: [],
  exitCode: 0,
  signal: null,
  stdout: "step node: OK\nRESULT OK\n",
  stderr: "warn\n",
  truncated: false,
  steps: [],
  wire: [],
  states: {},
})

const handlers = new Map<string, Handler>()
const windows = new Map<object, { isDestroyed: () => boolean; webContents: object }>()
const calls = {
  install: [] as string[][],
  preview: [] as unknown[][],
  marked: 0,
  pendingHomes: [] as string[],
  confirms: [] as string[][],
  logs: [] as string[],
}
let result = ran()
let progress: SetupComponentStates[] = []
let pending = true
let busy = false
// What the native confirmation answers; a function so a test can hold it open.
let confirm: (ids: readonly string[]) => Promise<boolean> = async () => true
// Runs when the fake runner starts an install, after the confirmation.
let onRun = () => {}

registerSetupToolsHandlers({
  ipcMain: { handle: (name: string, fn: Handler) => void handlers.set(name, fn) },
  windowOf: (sender) => windows.get(sender) ?? null,
  runner: () => ({
    home: "/fixture-home",
    busy: () => busy,
    state: () => ({ graft: "healthy" }),
    preview: async (...args: unknown[]) => (calls.preview.push(args), result),
    install: async (ids: readonly string[], onProgress?: (states: SetupComponentStates) => void) => {
      calls.install.push([...ids])
      onRun()
      progress.forEach((states) => onProgress?.(states))
      return result
    },
  }),
  isRendererUrl: (url) => url === RENDERER_URL,
  confirmInstall: (_sender, ids) => (calls.confirms.push([...ids]), confirm(ids)),
  isOfferPending: (home) => (calls.pendingHomes.push(home), pending),
  markOffered: () => void calls.marked++,
  log: (message) => void calls.logs.push(message),
} satisfies SetupToolsIpcDeps as unknown as SetupToolsIpcDeps)

function sender(opts: { subframe?: boolean; noWindow?: boolean; closedWindow?: boolean; url?: string; noFrame?: boolean } = {}) {
  const fake: FakeSender = { mainFrame: { url: opts.url ?? RENDERER_URL }, destroyed: false, sent: [] }
  const contents = {
    mainFrame: fake.mainFrame,
    isDestroyed: () => fake.destroyed,
    send: (...args: unknown[]) => void fake.sent.push(args),
  }
  if (!opts.noWindow) windows.set(contents, { isDestroyed: () => !!opts.closedWindow, webContents: contents })
  const senderFrame = opts.noFrame ? null : opts.subframe ? { url: RENDERER_URL } : fake.mainFrame
  const event = { sender: contents as unknown as WebContents, senderFrame }
  // Closing the window: Electron destroys its webContents.
  const close = () => {
    fake.destroyed = true
  }
  return { event: event as unknown as IpcMainInvokeEvent, fake, close }
}

const call = (name: string, event: IpcMainInvokeEvent, ...args: unknown[]) =>
  Promise.resolve().then(() => handlers.get(name)!(event, ...args))

beforeEach(async () => {
  // The offer claim lives in the registered handlers; marking the offer releases it between tests.
  await call(SETUP_TOOLS_IPC.markOffered, sender().event)
  calls.install = []
  calls.preview = []
  calls.marked = 0
  calls.pendingHomes = []
  calls.confirms = []
  calls.logs = []
  result = ran()
  progress = [{ node: "installed" }]
  pending = true
  busy = false
  confirm = async () => true
  onRun = () => {}
})

describe("setup-tools IPC", () => {
  test("registers the four register names and C74's mark-offered", () => {
    expect([...handlers.keys()].sort()).toEqual(
      ["setup-tools-install", "setup-tools-preview", "setup-tools-state", "setup-tools:mark-offered"].sort(),
    )
    expect(SETUP_TOOLS_IPC.progress).toBe("setup-tools-progress")
  })

  test("install passes only the ticked ids and returns output unedited", async () => {
    const a = sender()
    expect(await call("setup-tools-install", a.event, ["node", "rtk"])).toEqual({
      exitCode: 0,
      stdout: "step node: OK\nRESULT OK\n",
      stderr: "warn\n",
    })
    expect(calls.install).toEqual([["node", "rtk"]])
  })

  test("progress goes only to the window that asked", async () => {
    const a = sender()
    const b = sender()
    progress = [{ node: "installed" }, { node: "healthy" }]
    await call("setup-tools-install", a.event, ["node"])
    expect(a.fake.sent).toEqual([
      ["setup-tools-progress", { components: { node: "installed" }, offerPending: true }],
      ["setup-tools-progress", { components: { node: "healthy" }, offerPending: true }],
    ])
    expect(b.fake.sent).toEqual([])
    expect(new Set(calls.pendingHomes)).toEqual(new Set(["/fixture-home"]))
  })

  test("a destroyed sender gets no progress and the run still resolves", async () => {
    const a = sender()
    onRun = () => a.close()
    expect(await call("setup-tools-install", a.event, ["node"])).toMatchObject({ exitCode: 0 })
    expect(a.fake.sent).toEqual([])
  })

  const bad: unknown[] = [
    ["node", "--shell"],
    ["node; rm -rf ~"],
    "node",
    [1],
    null,
    { 0: "node" },
    ["Node"],
    Array(15).fill("node"),
  ]
  for (const ids of bad) {
    test(`refuses ids ${JSON.stringify(ids)} before the runner`, async () => {
      await expect(call("setup-tools-install", sender().event, ids)).rejects.toThrow("SETUP_TOOLS_INVALID_IDS")
      expect(calls.install).toEqual([])
    })
  }

  test("an empty list reaches the runner, whose refusal becomes a code token", async () => {
    result = { kind: "refused", reason: "nothing_selected" }
    await expect(call("setup-tools-install", sender().event, [])).rejects.toThrow(
      "SETUP_TOOLS_REFUSED:nothing_selected",
    )
  })

  for (const reason of ["root", "busy"] as const) {
    test(`runner refusal ${reason} rejects with a code token`, async () => {
      result = { kind: "refused", reason }
      await expect(call("setup-tools-preview", sender().event)).rejects.toThrow(`SETUP_TOOLS_REFUSED:${reason}`)
    })
  }

  for (const [label, opts] of [
    ["subframe", { subframe: true }],
    ["no window", { noWindow: true }],
    ["closed window", { closedWindow: true }],
  ] as const) {
    test(`an invalid sender (${label}) is refused on every channel`, async () => {
      const a = sender(opts)
      for (const name of handlers.keys()) {
        await expect(call(name, a.event, ["node"])).rejects.toThrow("SETUP_TOOLS_INVALID_SENDER")
      }
      expect(calls.install).toEqual([])
      expect(calls.preview).toEqual([])
      expect(calls.marked).toBe(0)
    })
  }

  test("preview passes no renderer argument to the runner", async () => {
    const run = await call("setup-tools-preview", sender().event, "--evil", ["x"])
    expect(calls.preview).toEqual([[]])
    expect(Object.keys(run as object).sort()).toEqual(["exitCode", "stderr", "stdout"])
  })

  test("state reads components and offerPending without marking", async () => {
    expect(await call("setup-tools-state", sender().event)).toEqual({
      components: { graft: "healthy" },
      offerPending: true,
    })
    expect(calls.marked).toBe(0)
  })

  test("mark-offered marks once and ignores arguments", async () => {
    await call("setup-tools:mark-offered", sender().event, "anything")
    expect(calls.marked).toBe(1)
  })
})

describe("F1: main's native confirmation before any install (C80, C82 a)", () => {
  test("Install pressed: the dialog lists the ticked ids in register order, then one install runs", async () => {
    await call("setup-tools-install", sender().event, ["rtk", "node"])
    expect(calls.confirms).toEqual([["node", "rtk"]])
    expect(calls.install).toEqual([["rtk", "node"]])
  })

  test("Cancel: the invoke rejects SETUP_TOOLS_REFUSED:cancelled and nothing reaches the runner", async () => {
    confirm = async () => false
    await expect(call("setup-tools-install", sender().event, ["node"])).rejects.toThrow("SETUP_TOOLS_REFUSED:cancelled")
    expect(calls.confirms).toEqual([["node"]])
    expect(calls.install).toEqual([])
    expect(calls.logs).toEqual(["swarm-setup install cancelled in the native confirmation"])
  })

  test("a confirmation that fails or never answers yes starts nothing", async () => {
    confirm = async () => {
      throw new Error("dialog failed")
    }
    await expect(call("setup-tools-install", sender().event, ["node"])).rejects.toThrow("dialog failed")
    expect(calls.install).toEqual([])
  })

  test("a window closed while its confirmation is open is a cancel, even if the answer is Install", async () => {
    const a = sender()
    confirm = async () => (a.close(), true)
    await expect(call("setup-tools-install", a.event, ["node"])).rejects.toThrow("SETUP_TOOLS_REFUSED:cancelled")
    expect(calls.install).toEqual([])
  })

  test("a second install while a confirmation is open is busy, with no second dialog", async () => {
    const answers: ((value: boolean) => void)[] = []
    confirm = () => new Promise((resolve) => answers.push(resolve))
    const first = call("setup-tools-install", sender().event, ["node"])
    for (let i = 0; i < 500 && calls.confirms.length === 0; i++) await Bun.sleep(1)
    const second = call("setup-tools-install", sender().event, ["rtk"]).catch((error: Error) => error.message)
    await Bun.sleep(5)
    const dialogsOpen = calls.confirms.length
    answers.forEach((answer) => answer(true))
    expect(await second).toBe("SETUP_TOOLS_REFUSED:busy")
    expect(dialogsOpen).toBe(1)
    await first
    expect(calls.confirms).toEqual([["node"]])
    expect(calls.install).toEqual([["node"]])
  })

  test("no dialog while a run is already going", async () => {
    busy = true
    await expect(call("setup-tools-install", sender().event, ["node"])).rejects.toThrow("SETUP_TOOLS_REFUSED:busy")
    expect(calls.confirms).toEqual([])
    expect(calls.install).toEqual([])
  })

  test("invalid ids are refused before any dialog", async () => {
    await expect(call("setup-tools-install", sender().event, ["node", "--x"])).rejects.toThrow("SETUP_TOOLS_INVALID_IDS")
    expect(calls.confirms).toEqual([])
  })

  test("preview, state and mark-offered never show the confirmation", async () => {
    const a = sender()
    await call("setup-tools-preview", a.event)
    await call("setup-tools-state", a.event)
    await call("setup-tools:mark-offered", a.event)
    expect(calls.confirms).toEqual([])
  })
})

describe("createInstallConfirm", () => {
  const t = (key: string, params?: Record<string, string | number>) => `${key}${params ? ` ${JSON.stringify(params)}` : ""}`
  const win = {} as BrowserWindow
  const make = (answer: () => Promise<{ response: number; checkboxChecked: boolean }>) => {
    const shown: { win: BrowserWindow | null; options: MessageBoxOptions }[] = []
    const confirmInstall = createInstallConfirm({
      windowOf: () => win,
      showMessageBox: (w, options) => (shown.push({ win: w, options }), answer()),
      t,
    })
    return { confirmInstall, shown }
  }
  const contents = {} as WebContents

  test("lists each ticked id on its own line, Cancel is the default and the Escape answer", async () => {
    const box = make(async () => ({ response: 0, checkboxChecked: false }))
    expect(await box.confirmInstall(contents, ["node", "rtk"])).toBe(true)
    expect(box.shown).toHaveLength(1)
    expect(box.shown[0]!.win).toBe(win)
    expect(box.shown[0]!.options).toEqual({
      type: "question",
      title: SETUP_CONFIRM_KEYS.title,
      message: SETUP_CONFIRM_KEYS.message,
      detail: `${SETUP_CONFIRM_KEYS.detail} {"components":"node\\nrtk"}`,
      buttons: [SETUP_CONFIRM_KEYS.install, SETUP_CONFIRM_KEYS.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    })
  })

  for (const response of [1, -1, 2, Number.NaN]) {
    test(`answer ${response} is not consent`, async () => {
      expect(await make(async () => ({ response, checkboxChecked: true })).confirmInstall(contents, ["node"])).toBe(false)
    })
  }

  test("a dialog that cannot be shown is not consent", async () => {
    expect(await make(() => Promise.reject(new Error("no display"))).confirmInstall(contents, ["node"])).toBe(false)
  })
})

describe("C82 (b): one window shows the offer", () => {
  test("the first window to read a pending offer holds it; a second window reads offerPending false", async () => {
    const a = sender()
    const b = sender()
    expect(await call("setup-tools-state", a.event)).toMatchObject({ offerPending: true })
    expect(await call("setup-tools-state", b.event)).toMatchObject({ offerPending: false })
    // The holder keeps reading true (a remount in the same window), the other window keeps reading false.
    expect(await call("setup-tools-state", a.event)).toMatchObject({ offerPending: true })
    expect(await call("setup-tools-state", b.event)).toMatchObject({ offerPending: false })
    expect(calls.marked).toBe(0)
  })

  test("progress in the other window also carries offerPending false", async () => {
    const a = sender()
    const b = sender()
    await call("setup-tools-state", a.event)
    await call("setup-tools-install", b.event, ["node"])
    expect(b.fake.sent.map((args) => (args[1] as { offerPending: boolean }).offerPending)).toEqual([false])
  })

  test("closing the holder releases the claim to the next window that reads", async () => {
    const a = sender()
    const b = sender()
    await call("setup-tools-state", a.event)
    a.close()
    expect(await call("setup-tools-state", b.event)).toMatchObject({ offerPending: true })
    const c = sender()
    expect(await call("setup-tools-state", c.event)).toMatchObject({ offerPending: false })
  })

  test("marking the offer releases the claim; main's persisted flag then decides for every window", async () => {
    const a = sender()
    const b = sender()
    await call("setup-tools-state", a.event)
    await call("setup-tools:mark-offered", a.event)
    pending = false
    expect(await call("setup-tools-state", a.event)).toMatchObject({ offerPending: false })
    expect(await call("setup-tools-state", b.event)).toMatchObject({ offerPending: false })
    // A later due offer (a new release) is claimable again, by whichever window reads first.
    pending = true
    expect(await call("setup-tools-state", b.event)).toMatchObject({ offerPending: true })
    expect(await call("setup-tools-state", a.event)).toMatchObject({ offerPending: false })
  })

  test("an offer that is not due claims nothing", async () => {
    pending = false
    const a = sender()
    expect(await call("setup-tools-state", a.event)).toMatchObject({ offerPending: false })
    pending = true
    const b = sender()
    expect(await call("setup-tools-state", b.event)).toMatchObject({ offerPending: true })
  })
})

describe("F9 and senior 8", () => {
  for (const [label, opts] of [
    ["a foreign origin in the main frame", { url: "https://example.com/" }],
    ["a file URL", { url: "file:///tmp/x.html" }],
    ["no sender frame", { noFrame: true }],
  ] as const) {
    test(`${label} is refused on every channel`, async () => {
      const a = sender(opts)
      for (const name of handlers.keys())
        await expect(call(name, a.event, ["node"])).rejects.toThrow("SETUP_TOOLS_INVALID_SENDER")
      expect(calls.install).toEqual([])
      expect(calls.confirms).toEqual([])
    })
  }

  test("main registers exactly the channel names the preload invokes", async () => {
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(SETUP_TOOLS_IPC).filter((name) => name !== SETUP_TOOLS_IPC.progress).sort(),
    )
    const preload = await Bun.file(new URL("../preload/index.ts", import.meta.url)).text()
    const block = preload.slice(preload.indexOf("setupTools: {"), preload.indexOf("consumeInitialDeepLinks"))
    // Every channel in the setupTools block goes through the shared constant, none as a literal.
    expect(block).not.toMatch(/"setup-tools/)
    for (const key of Object.keys(SETUP_TOOLS_IPC)) expect(block).toContain(`SETUP_TOOLS_IPC.${key}`)
  })
})
