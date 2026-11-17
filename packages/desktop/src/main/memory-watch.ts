// SB-1 (row 19): main-process memory watch. The incident (04_hang_trace.md) was the main process running out of heap
// near 3.8 GB with no memory line in any log. This module logs main-process memory once per interval, raises one
// event per threshold, and offers a controlled reopen through the dialog it is given. Nothing is forced: the only
// way to a relaunch is the person choosing the Reopen button, and the relaunch itself is the app's existing path
// (index.ts `relaunch`), passed in.
//
// No Electron import: clock, memory reader, dialog, relaunch and log are injected (the test runs without Electron).
// Numbers and log line shapes: masterplan/03_register.md section 10.

export const MEMORY_WATCH_INTERVAL_MS = 60_000
export const MEMORY_WARN_MB = 2_700
export const MEMORY_URGENT_MB = 3_300

export type MemoryLevel = "warn" | "urgent"

// Bytes, the shape of `process.memoryUsage()`. The watched metric is `rss` (logged as `rssMb`); the same value is
// used for the log line and for the thresholds.
export type MemoryReading = { rss: number; heapUsed: number; heapTotal: number; external: number }

export type MemoryThresholdEvent = { level: MemoryLevel; rssMb: number; thresholdMb: number }

// A subset of Electron's MessageBoxOptions, so `dialog.showMessageBox` fits without a cast.
export type MemoryWatchDialogOptions = {
  type: "warning"
  message: string
  buttons: string[]
  defaultId: number
  cancelId: number
  noLink: boolean
}

export type MemoryWatchDeps = {
  clock: {
    setInterval: (fn: () => void, ms: number) => unknown
    clearInterval: (handle: unknown) => void
  }
  readMemory: () => MemoryReading
  showMessageBox: (options: MemoryWatchDialogOptions) => Promise<{ response: number }>
  // The app's existing relaunch (stops the sidecars, then app.relaunch + app.quit). Called only after Reopen.
  relaunch: () => void
  // The main-process logger's `write(name, message, extra, level)` (logging.ts).
  log: (name: string, message: string, extra?: Record<string, unknown>, level?: "info" | "warn" | "error") => void
  onEvent?: (event: MemoryThresholdEvent) => void
  locale?: () => string
}

const LOG_NAME = "memory"
const REOPEN_BUTTON = 0
const LATER_BUTTON = 1
// Highest first: a reading above both thresholds raises the highest one only.
const THRESHOLDS: ReadonlyArray<{ level: MemoryLevel; mb: number }> = [
  { level: "urgent", mb: MEMORY_URGENT_MB },
  { level: "warn", mb: MEMORY_WARN_MB },
]

const OFFER_TEXT = {
  en: {
    message: "Swarm is using a lot of memory ({{gb}} GB). Reopen now to keep working safely?",
    reopen: "Reopen",
    later: "Later",
  },
  id: {
    message: "Swarm memakai banyak memori ({{gb}} GB). Buka ulang sekarang agar tetap aman?",
    reopen: "Buka ulang",
    later: "Nanti",
  },
} as const

const toMb = (bytes: number) => Math.round(bytes / (1024 * 1024))

// Register section 10 texts. Indonesian for locale "id", English for every other locale. 2 700 MB reads "2.7 GB",
// the way the register and the spec name the thresholds.
export function memoryReopenOffer(locale: string, rssMb: number) {
  const indonesian = locale.toLowerCase().startsWith("id")
  const text = indonesian ? OFFER_TEXT.id : OFFER_TEXT.en
  const tenths = (Math.round(rssMb / 100) / 10).toFixed(1)
  const gb = indonesian ? tenths.replace(".", ",") : tenths
  return { message: text.message.replace("{{gb}}", gb), reopen: text.reopen, later: text.later }
}

const errorFields = (error: unknown) => ({
  error: error instanceof Error ? error.message : String(error),
  ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
})

export function createMemoryWatch(deps: MemoryWatchDeps) {
  let timer: unknown
  let running = false
  // Once per run: a level that was raised is never raised again, an offer for it is never shown again, also when
  // memory falls below the threshold and rises again (register: "once per run").
  const raised = new Set<MemoryLevel>()
  const offered = new Set<MemoryLevel>()
  let dialogOpen = false
  let reopening = false

  const stop = () => {
    if (!running) return
    running = false
    deps.clock.clearInterval(timer)
    timer = undefined
  }

  const offer = (level: MemoryLevel, rssMb: number) => {
    // An offer for a level covers the levels below it.
    offered.add(level)
    if (level === "urgent") offered.add("warn")
    dialogOpen = true
    const text = memoryReopenOffer(deps.locale?.() ?? "en", rssMb)
    let shown: Promise<{ response: number }>
    try {
      shown = deps.showMessageBox({
        type: "warning",
        message: text.message,
        buttons: [text.reopen, text.later],
        defaultId: REOPEN_BUTTON,
        cancelId: LATER_BUTTON,
        noLink: true,
      })
    } catch (error) {
      shown = Promise.reject(error)
    }
    void shown.then(
      (result) => {
        dialogOpen = false
        if (result?.response !== REOPEN_BUTTON) {
          deps.log(LOG_NAME, "main memory reopen declined", { level, rssMb })
          return
        }
        if (reopening) return
        reopening = true
        deps.log(LOG_NAME, "main memory reopen accepted", { level, rssMb })
        stop()
        try {
          deps.relaunch()
        } catch (error) {
          reopening = false
          deps.log(LOG_NAME, "main memory reopen failed", { level, rssMb, ...errorFields(error) }, "error")
        }
      },
      (error) => {
        // No dialog was answered, so nothing is relaunched. The level stays offered: no retry loop of dialogs.
        dialogOpen = false
        deps.log(LOG_NAME, "main memory reopen offer failed", { level, rssMb, ...errorFields(error) }, "error")
      },
    )
  }

  const tick = () => {
    try {
      const reading = deps.readMemory()
      const rssMb = toMb(reading.rss)
      deps.log(LOG_NAME, "main memory", {
        rssMb,
        heapUsedMb: toMb(reading.heapUsed),
        heapTotalMb: toMb(reading.heapTotal),
        externalMb: toMb(reading.external),
      })

      const crossed = THRESHOLDS.find((t) => rssMb >= t.mb)
      if (crossed && !raised.has(crossed.level)) {
        raised.add(crossed.level)
        if (crossed.level === "urgent") raised.add("warn")
        const event: MemoryThresholdEvent = { level: crossed.level, rssMb, thresholdMb: crossed.mb }
        deps.log(LOG_NAME, "main memory threshold", { ...event }, "warn")
        deps.onEvent?.(event)
      }

      // One dialog at a time. A level raised while an offer is open is offered at the first interval after that
      // offer was answered with Later.
      if (dialogOpen || reopening) return
      const due = THRESHOLDS.find((t) => raised.has(t.level) && !offered.has(t.level))
      if (due) offer(due.level, rssMb)
    } catch (error) {
      deps.log(LOG_NAME, "main memory watch failed", errorFields(error), "error")
    }
  }

  return {
    start: () => {
      if (running) return
      running = true
      timer = deps.clock.setInterval(tick, MEMORY_WATCH_INTERVAL_MS)
    },
    stop,
  }
}
