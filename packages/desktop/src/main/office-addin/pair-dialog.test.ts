import { describe, expect, setDefaultTimeout, test } from "bun:test"
import type { BrowserWindow, MessageBoxOptions, MessageBoxReturnValue } from "electron"
import { DESKTOP_NATIVE_ENGLISH } from "@opencode-ai/app/i18n/desktop-native"
import { OFFICE_PAIR_REQUEST_TTL_MS } from "@swarm/office-addin/constants"
import { nativeT } from "../native-translations"
import type { PairRequest } from "../office-bridge/protocol"
import {
  electronPairDialogDeps,
  pairDecoys,
  pairDialogLayout,
  showPairDialog,
  type PairDialogDeps,
  type PairRandomInt,
} from "./pair-dialog"

// U-DT-07 three-code variant (C9 SC-11, C12 OQ-T1) plus DLG-1 and outcome mapping (spec §11.2). Electron is injected;
// no mock.module (patch-menu-wiring.test.ts row 64b: module mocks leak across files).

// Hang guard: every test fails fast instead of blocking the folder run.
setDefaultTimeout(5_000)

const REQUEST: PairRequest = { requestId: "AAAAAAAAAAAAAAAAAAAAAA", host: "Excel", code: "0427" }
const FAKE_WINDOW = { id: 1 } as unknown as BrowserWindow

type Call = { win: BrowserWindow | null; options: MessageBoxOptions }

function harness(input: {
  response?: number | ((options: MessageBoxOptions) => number)
  window?: BrowserWindow | null
  fail?: boolean
  clock?: { t: number }
  advanceOnShow?: number
  randomInt?: PairRandomInt
  hang?: boolean
}) {
  const calls: Call[] = []
  const order: string[] = []
  const timers: { fn: () => void; ms: number }[] = []
  const clock = input.clock ?? { t: 1_000_000 }
  const deps: PairDialogDeps = {
    window: () => input.window ?? null,
    focus: () => order.push("focus"),
    now: () => clock.t,
    randomInt: input.randomInt,
    setTimer: (fn, ms) => {
      timers.push({ fn, ms })
      return timers.length
    },
    clearTimer: () => {},
    showMessageBox: (win, options) => {
      order.push("show")
      calls.push({ win, options })
      if (input.fail) return Promise.reject(new Error("boom"))
      if (input.hang) {
        return new Promise<MessageBoxReturnValue>((resolve) => {
          options.signal?.addEventListener("abort", () =>
            resolve({ response: Number(options.cancelId), checkboxChecked: false }),
          )
        })
      }
      clock.t += input.advanceOnShow ?? 0
      const response = typeof input.response === "function" ? input.response(options) : (input.response ?? 0)
      return Promise.resolve({ response, checkboxChecked: false })
    },
  }
  return { deps, calls, order, timers, clock }
}

function correctIndex(options: MessageBoxOptions) {
  return options.buttons!.indexOf(REQUEST.code)
}
function decoyIndex(options: MessageBoxOptions) {
  return options.buttons!.findIndex((label, i) => i < 3 && label !== REQUEST.code)
}

describe("U-DT-07 three-code dialog options", () => {
  test("four buttons: three codes, real code once, distinct decoys, Deny last as default and cancel", async () => {
    for (let run = 0; run < 200; run++) {
      const h = harness({ response: 3 })
      await showPairDialog(REQUEST, h.deps)
      const options = h.calls[0]!.options
      const buttons = options.buttons!
      expect(buttons).toHaveLength(4)
      expect(buttons[3]).toBe(DESKTOP_NATIVE_ENGLISH["desktop.officeAddin.pair.deny"])
      expect(options.defaultId).toBe(3)
      expect(options.cancelId).toBe(3)
      const codes = buttons.slice(0, 3)
      for (const code of codes) expect(code).toMatch(/^\d{4}$/)
      expect(codes.filter((code) => code === REQUEST.code)).toHaveLength(1)
      expect(new Set(codes).size).toBe(3)
    }
  })

  test("M4-03a: message is the title, detail names the host via nativeT; no code in either", async () => {
    const h = harness({ response: 3 })
    await showPairDialog(REQUEST, h.deps)
    const options = h.calls[0]!.options
    expect(options.message).toBe(nativeT("desktop.officeAddin.pair.title"))
    expect(options.title).toBe(nativeT("desktop.officeAddin.pair.title"))
    expect(options.detail).toBe(nativeT("desktop.officeAddin.pair.message", { host: "Excel" }))
    expect(options.detail).toContain("Excel")
    for (const code of options.buttons!.slice(0, 3)) {
      expect(options.message).not.toContain(code)
      expect(options.detail).not.toContain(code)
    }
  })

  test("injected t is used for every string", async () => {
    const h = harness({ response: 3 })
    await showPairDialog(REQUEST, { ...h.deps, t: (key, params) => `[${key}|${params?.host ?? ""}]` })
    const options = h.calls[0]!.options
    expect(options.title).toBe("[desktop.officeAddin.pair.title|]")
    expect(options.message).toBe("[desktop.officeAddin.pair.title|]")
    expect(options.detail).toBe("[desktop.officeAddin.pair.message|Excel]")
    expect(options.buttons![3]).toBe("[desktop.officeAddin.pair.deny|]")
  })

  test("the correct code lands in every code position (random order)", () => {
    const seen = new Set<number>()
    for (let run = 0; run < 300; run++) seen.add(pairDialogLayout(REQUEST.code, "Deny").correctIndex)
    expect([...seen].sort()).toEqual([0, 1, 2])
  })
})

describe("decoys", () => {
  test("rejection sampling skips the code and the first decoy", () => {
    const draws = [427, 427, 1, 1, 1, 9999]
    const randomInt: PairRandomInt = () => draws.shift()!
    expect(pairDecoys("0427", randomInt)).toEqual(["0001", "9999"])
  })

  test("leading zeros are kept and an invalid code is refused", () => {
    const draws = [7, 42]
    expect(pairDecoys("0000", () => draws.shift()!)).toEqual(["0007", "0042"])
    expect(() => pairDecoys("12a4")).toThrow()
  })

  test("a constant random source throws instead of looping forever", () => {
    expect(() => pairDecoys("0000", () => 7)).toThrow("decoy draw limit")
  })

  test("decoys are roughly uniform over the code space", () => {
    const buckets = new Array<number>(10).fill(0)
    const N = 20_000
    for (let i = 0; i < N; i++) {
      for (const decoy of pairDecoys("5000")) buckets[Number(decoy[0])]!++
    }
    for (const count of buckets) expect(Math.abs(count - (2 * N) / 10)).toBeLessThan((2 * N) / 10 / 10)
  })
})

describe("outcome mapping", () => {
  test("correct code allows", async () => {
    const h = harness({ response: correctIndex })
    expect(await showPairDialog(REQUEST, h.deps)).toEqual({
      kind: "decided",
      choice: "code",
      decision: { requestId: REQUEST.requestId, allow: true },
    })
  })

  test("decoy denies", async () => {
    const h = harness({ response: decoyIndex })
    const out = await showPairDialog(REQUEST, h.deps)
    expect(out).toEqual({ kind: "decided", choice: "decoy", decision: { requestId: REQUEST.requestId, allow: false } })
  })

  test("Deny, Escape and close (cancelId) deny", async () => {
    const h = harness({ response: (o) => Number(o.cancelId) })
    const out = await showPairDialog(REQUEST, h.deps)
    expect(out).toEqual({ kind: "decided", choice: "deny", decision: { requestId: REQUEST.requestId, allow: false } })
  })

  test("a dialog that fails to show denies", async () => {
    const h = harness({ fail: true })
    const out = await showPairDialog(REQUEST, h.deps)
    expect(out).toEqual({ kind: "decided", choice: "error", decision: { requestId: REQUEST.requestId, allow: false } })
  })

  test("a malformed code denies without showing a dialog", async () => {
    const h = harness({ response: 0 })
    const out = await showPairDialog({ ...REQUEST, code: "12345" }, h.deps)
    expect(out.kind).toBe("decided")
    expect(h.calls).toHaveLength(0)
  })

  test("focus with steal runs before the dialog", async () => {
    const h = harness({ response: 3 })
    await showPairDialog(REQUEST, h.deps)
    expect(h.order).toEqual(["focus", "show"])
    const focusArgs: unknown[] = []
    const deps = electronPairDialogDeps({
      dialog: { showMessageBox: (() => Promise.resolve({ response: 0, checkboxChecked: false })) as never },
      app: { focus: (options?: unknown) => focusArgs.push(options) },
      window: () => null,
    })
    deps.focus()
    expect(focusArgs).toEqual([{ steal: true }])
  })

  test("a throwing focus does not stop the dialog", async () => {
    const h = harness({ response: 3 })
    await showPairDialog(REQUEST, { ...h.deps, focus: () => { throw new Error("no focus") } })
    expect(h.calls).toHaveLength(1)
  })
})

describe("DLG-1 parent window and expiry", () => {
  test("with a Swarm window: sheet on it, signal set, timer at the expiry", async () => {
    const h = harness({ response: 3, window: FAKE_WINDOW })
    await showPairDialog(REQUEST, h.deps)
    expect(h.calls[0]!.win).toBe(FAKE_WINDOW)
    expect(h.calls[0]!.options.signal).toBeInstanceOf(AbortSignal)
    expect(h.timers[0]!.ms).toBe(OFFICE_PAIR_REQUEST_TTL_MS)
  })

  test("without a window: app-modal, no signal, no timer", async () => {
    const h = harness({ response: 3 })
    await showPairDialog(REQUEST, h.deps)
    expect(h.calls[0]!.win).toBeNull()
    expect(h.calls[0]!.options.signal).toBeUndefined()
    expect(h.timers).toHaveLength(0)
  })

  test("sheet: expiry aborts the dialog and sends no decision", async () => {
    const h = harness({ window: FAKE_WINDOW, hang: true })
    const pending = showPairDialog(REQUEST, h.deps)
    await Promise.resolve()
    h.timers[0]!.fn()
    expect(await pending).toEqual({ kind: "expired", requestId: REQUEST.requestId })
  })

  test("app-modal: a click after expiry is ignored, even on the correct code", async () => {
    const h = harness({ response: correctIndex, advanceOnShow: OFFICE_PAIR_REQUEST_TTL_MS })
    expect(await showPairDialog(REQUEST, h.deps)).toEqual({ kind: "expired", requestId: REQUEST.requestId })
  })

  test("explicit expiresAt is honoured; an already expired request shows nothing", async () => {
    const clock = { t: 5_000 }
    const h = harness({ response: 3, window: FAKE_WINDOW, clock })
    await showPairDialog(REQUEST, h.deps, 35_000)
    expect(h.timers[0]!.ms).toBe(30_000)
    const late = harness({ response: correctIndex, clock })
    expect(await showPairDialog(REQUEST, late.deps, 5_000)).toEqual({ kind: "expired", requestId: REQUEST.requestId })
    expect(late.calls).toHaveLength(0)
  })

  test("adapter picks the window overload or the app-modal overload", async () => {
    const seen: unknown[][] = []
    const deps = electronPairDialogDeps({
      dialog: {
        showMessageBox: ((...args: unknown[]) => {
          seen.push(args)
          return Promise.resolve({ response: 0, checkboxChecked: false })
        }) as never,
      },
      app: { focus: () => {} },
      window: () => null,
    })
    await deps.showMessageBox(FAKE_WINDOW, { message: "a" })
    await deps.showMessageBox(null, { message: "b" })
    expect(seen[0]).toEqual([FAKE_WINDOW, { message: "a" }])
    expect(seen[1]).toEqual([{ message: "b" }])
  })
})
