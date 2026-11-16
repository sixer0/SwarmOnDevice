// Number-matching Allow dialog for Office add-in pairing (plan M4-03; server-delta spec §11.2, DLG-1; security SC-11,
// SC-15, RC-1; register rev 5 §5, §8.3).
//
// The bridge sends `pair-request {requestId, host, code}`; this module shows four buttons: the correct code and two
// decoys in random order, then Deny last. Deny is both `defaultId` and `cancelId`, so Enter, Escape and closing the
// dialog all deny. Only a click on the correct code allows. The decoys are generated here (RM-19): uniformly random
// 4-digit codes, distinct from each other and from the correct code.
//
// No runtime Electron import: `dialog`, `app` and the window lookup are injected (TR-5 style, like wef.ts and
// patch-update-flow.ts), so tests need no `mock.module("electron")`. `electronPairDialogDeps` adapts the real modules;
// the controller (M7-03) passes them in.

import type { App, BrowserWindow, Dialog, MessageBoxOptions, MessageBoxReturnValue } from "electron"
import { randomInt as cryptoRandomInt } from "node:crypto"
import { OFFICE_PAIR_CODE_DIGITS, OFFICE_PAIR_REQUEST_TTL_MS } from "@swarm/office-addin/constants"
import { nativeT } from "../native-translations"
import type { PairDecision, PairRequest } from "../office-bridge/protocol"

const CODE_SPACE = 10 ** OFFICE_PAIR_CODE_DIGITS
const DRAW_LIMIT = 64
const CODE_PATTERN = new RegExp(`^\\d{${OFFICE_PAIR_CODE_DIGITS}}$`)

/** Uniform integer in [0, max). */
/** @internal test seam */
export type PairRandomInt = (max: number) => number

type PairDialogKeys = "desktop.officeAddin.pair.title" | "desktop.officeAddin.pair.message" | "desktop.officeAddin.pair.deny"

export type PairDialogDeps = {
  /** The Swarm window to attach a sheet to, or null for an app-modal dialog (DLG-1). */
  window: () => BrowserWindow | null
  /** Shows the box; `win` null means app-modal. Must honour `options.signal` when given. */
  showMessageBox: (win: BrowserWindow | null, options: MessageBoxOptions) => Promise<MessageBoxReturnValue>
  /** `app.focus({ steal: true })`, so the dialog is not hidden behind Word or Excel. */
  focus: () => void
  t?: (key: PairDialogKeys, params?: Record<string, string | number>) => string
  randomInt?: PairRandomInt
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/** What the user did. `expired`: the request lifetime passed first; main sends no decision (the bridge would discard it). */
type PairDialogChoice = "code" | "decoy" | "deny" | "error"
type PairDialogOutcome =
  | { kind: "decided"; choice: PairDialogChoice; decision: PairDecision }
  | { kind: "expired"; requestId: string }

type PairDialogLayout = {
  /** Codes then Deny, in display order. */
  buttons: string[]
  /** Index of the correct code in `buttons`. */
  correctIndex: number
  /** Index of Deny: always the last button. */
  denyIndex: number
}

function drawCode(randomInt: PairRandomInt) {
  return String(randomInt(CODE_SPACE)).padStart(OFFICE_PAIR_CODE_DIGITS, "0")
}

/** Two decoys, each uniform over the codes not yet taken (rejection sampling keeps uniformity). */
/** @internal test seam */
export function pairDecoys(code: string, randomInt: PairRandomInt = cryptoRandomInt): [string, string] {
  if (!CODE_PATTERN.test(code)) throw new Error("pair-dialog: invalid code")
  const taken = new Set([code])
  // Bounded so a broken injected source cannot spin forever; with a uniform source the chance of 64 straight
  // collisions is (2/10000)^64, so the cap never changes the distribution in practice.
  const draw = () => {
    for (let attempt = 0; attempt < DRAW_LIMIT; attempt++) {
      const next = drawCode(randomInt)
      if (taken.has(next)) continue
      taken.add(next)
      return next
    }
    throw new Error("pair-dialog: decoy draw limit")
  }
  const first = draw()
  return [first, draw()]
}

/** Fisher-Yates shuffle of the three codes, then Deny last. */
/** @internal test seam */
export function pairDialogLayout(code: string, denyLabel: string, randomInt: PairRandomInt = cryptoRandomInt): PairDialogLayout {
  const codes = [code, ...pairDecoys(code, randomInt)]
  for (let i = codes.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    const swap = codes[i]!
    codes[i] = codes[j]!
    codes[j] = swap
  }
  const buttons = [...codes, denyLabel]
  return { buttons, correctIndex: codes.indexOf(code), denyIndex: buttons.length - 1 }
}

function pairDialogOptions(
  request: PairRequest,
  layout: PairDialogLayout,
  t: NonNullable<PairDialogDeps["t"]>,
  signal?: AbortSignal,
): MessageBoxOptions {
  const options: MessageBoxOptions = {
    type: "question",
    // M4-03a (C44): macOS shows `message` bold and `detail` below it, and ignores `title`; the title goes in both.
    title: t("desktop.officeAddin.pair.title"),
    message: t("desktop.officeAddin.pair.title"),
    detail: t("desktop.officeAddin.pair.message", { host: request.host }),
    buttons: layout.buttons,
    defaultId: layout.denyIndex,
    cancelId: layout.denyIndex,
    noLink: true,
    normalizeAccessKeys: false,
  }
  if (!signal) return options
  return { ...options, signal }
}

/**
 * Shows the dialog for one request and maps the answer to a `pair-decision` (spec §11.2 "Outcome").
 * `expiresAt` defaults to now + 120 s (the bridge's own lifetime; `pair-request` carries no expiry).
 */
export async function showPairDialog(
  request: PairRequest,
  deps: PairDialogDeps,
  expiresAt?: number,
): Promise<PairDialogOutcome> {
  const t = deps.t ?? nativeT
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  const deadline = expiresAt ?? now() + OFFICE_PAIR_REQUEST_TTL_MS
  const deny = (choice: PairDialogChoice): PairDialogOutcome => ({
    kind: "decided",
    choice,
    decision: { requestId: request.requestId, allow: false },
  })
  const expired: PairDialogOutcome = { kind: "expired", requestId: request.requestId }

  if (!CODE_PATTERN.test(request.code)) return deny("error")
  if (now() >= deadline) return expired

  const layout = pairDialogLayout(request.code, t("desktop.officeAddin.pair.deny"), deps.randomInt ?? cryptoRandomInt)

  try {
    deps.focus()
  } catch {
    // Focus is best effort (spec §11.2 "Focus" is an E2E hypothesis); the dialog still shows.
  }

  const win = deps.window()
  // DLG-1: a sheet on the Swarm window can be closed at expiry; an app-modal box cannot (S-27), so a late click is ignored.
  const controller = win ? new AbortController() : undefined
  const timer = controller ? setTimer(() => controller.abort(), Math.max(0, deadline - now())) : undefined
  const answer = await deps
    .showMessageBox(win, pairDialogOptions(request, layout, t, controller?.signal))
    .then((result) => result.response)
    .catch(() => undefined)
  if (timer !== undefined) clearTimer(timer)

  if (controller?.signal.aborted || now() >= deadline) return expired
  if (answer === undefined) return deny("error")
  if (answer === layout.correctIndex) {
    return { kind: "decided", choice: "code", decision: { requestId: request.requestId, allow: true } }
  }
  if (answer === layout.denyIndex) return deny("deny")
  if (answer >= 0 && answer < layout.denyIndex) return deny("decoy")
  return deny("deny")
}

/** Adapts the real Electron modules. `window` picks the Swarm window to attach to (null: app-modal). */
export function electronPairDialogDeps(electron: {
  dialog: Pick<Dialog, "showMessageBox">
  app: Pick<App, "focus">
  window: () => BrowserWindow | null
}): PairDialogDeps {
  return {
    window: electron.window,
    showMessageBox: (win, options) => {
      if (win) return electron.dialog.showMessageBox(win, options)
      return electron.dialog.showMessageBox(options)
    },
    focus: () => electron.app.focus({ steal: true }),
  }
}
