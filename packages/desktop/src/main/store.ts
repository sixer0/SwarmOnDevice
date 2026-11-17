import Store from "electron-store"
import electron from "electron"
import { rmSync } from "node:fs"
import { join } from "node:path"

import { SETTINGS_STORE } from "./store-keys"
import { deleteStoreFileIfEmpty } from "./store-cleanup"

const cache = new Map<string, Store>()

// Row 18 (SB-1). Importing electron-store installs JS listeners for 13 POSIX signals, through
// electron-store -> conf -> atomically -> when-exit (when-exit/dist/node/interceptor.js:31-33:
// `process.once(signal, () => this.exit(signal))`, at import time, not at store creation). A JS listener makes
// libuv catch the signal and queue it for the event loop. For a signal the main thread raises on itself (V8 aborts
// with a trap when the heap is exhausted) the loop never gets to run it: the trap repeats, the process neither exits
// nor dumps, and SIGTERM is ignored as well. With no JS listener the default action applies and the process ends.
//
// Only these fatal signals are cleared. The dependency's listeners on SIGHUP, SIGINT, SIGTERM (and SIGALRM,
// SIGVTALRM, SIGUSR2) stay, as does its `exit` listener, which is what removes atomically's leftover temp files on
// every normal quit. What is given up: that temp-file sweep when the process dies of one of the signals below. The
// settings file itself is safe either way (write to a temp file, then rename).
/** @internal test seam */
export const CRASH_SIGNALS = ["SIGTRAP", "SIGABRT", "SIGIOT", "SIGSYS", "SIGQUIT", "SIGXCPU", "SIGXFSZ"] as const

type SignalTarget = {
  rawListeners(signal: string): Function[]
  removeListener(signal: string, listener: (...args: any[]) => void): unknown
}

type CrashSignalListenerReport = {
  removed: Record<string, number>
  /** Dependency listeners still present on a crash signal after the pass (0 when the change holds). */
  remaining: number
  /** Set when the pass threw; the caller that owns logging (index.ts, row 19) writes it to the main log. */
  error?: string
}

// Removes the dependency's listeners and nothing else. A listener is the dependency's when (a) its source is exactly
// when-exit's hook, `() => this.exit(<name>)`, and (b) a listener of that same source sits on every crash signal,
// which is the footprint of the import-time hook. Anything else on these signals is left alone. Self-contained on
// purpose (no reference outside its arguments): the test runs this exact function in a plain Node process.
/** @internal test seam */
export function removeDependencyCrashSignalListeners(
  target: SignalTarget = process,
  signals: readonly string[] = CRASH_SIGNALS,
): CrashSignalListenerReport {
  const removed: Record<string, number> = {}
  for (const signal of signals) removed[signal] = 0
  try {
    const hook = /^\(\)\s*=>\s*this\.exit\(\s*[A-Za-z_$][\w$]*\s*\)$/
    // Node wraps a `once` listener and keeps the original in `.listener`; Bun returns the original itself.
    const source = (fn: Function) => String((fn as { listener?: Function }).listener ?? fn).trim()
    const candidates = (signal: string) => target.rawListeners(signal).filter((fn) => hook.test(source(fn)))
    const everywhere = signals.length > 0 && signals.every((signal) => candidates(signal).length > 0)
    if (!everywhere) return { removed, remaining: 0 }
    for (const signal of signals) {
      for (const fn of candidates(signal)) {
        target.removeListener(signal, fn as (...args: any[]) => void)
        removed[signal]++
      }
    }
    const remaining = signals.reduce((sum, signal) => sum + candidates(signal).length, 0)
    return { removed, remaining }
  } catch (error) {
    return { removed, remaining: -1, error: error instanceof Error ? (error.stack ?? error.message) : String(error) }
  }
}

let lastReport: CrashSignalListenerReport = { removed: {}, remaining: 0 }

function clearCrashSignalListeners() {
  const next = removeDependencyCrashSignalListeners()
  const removed = { ...lastReport.removed }
  for (const [signal, count] of Object.entries(next.removed)) removed[signal] = (removed[signal] ?? 0) + count
  lastReport = { removed, remaining: next.remaining, error: next.error ?? lastReport.error }
}

/** Totals since process start, for the main log (seam for row 19: `writeLog("main", "crash signal listeners", report)`). */
export function crashSignalListenerReport(): CrashSignalListenerReport {
  return { ...lastReport, removed: { ...lastReport.removed } }
}

// The listeners exist as soon as the import above has run, so clear them now: nothing may hang before the first store.
clearCrashSignalListeners()

// We cannot instantiate the electron-store at module load time because
// module import hoisting causes this to run before app.setPath("userData", ...)
// in index.ts has executed, which would result in files being written to the default directory
// (e.g. bad: %APPDATA%\@opencode-ai\desktop\opencode.settings vs good: %APPDATA%\id.co.gsp.swarm.desktop.dev\opencode.settings).
export function getStore(name = SETTINGS_STORE) {
  const cached = cache.get(name)
  if (cached) return cached
  const next = new Store({
    name,
    cwd: electron.app.getPath("userData"),
    fileExtension: "",
    accessPropertiesByDotNotation: false,
  })
  cache.set(name, next)
  // Again right after store initialisation: a no-op unless something re-installed the hook since module load.
  clearCrashSignalListeners()
  return next
}

export async function removeStoreFileIfEmpty(name: string) {
  if (await deleteStoreFileIfEmpty(electron.app.getPath("userData"), name)) cache.delete(name)
}

export function removeStoreFile(name: string) {
  rmSync(join(electron.app.getPath("userData"), name), { force: true })
  cache.delete(name)
}
