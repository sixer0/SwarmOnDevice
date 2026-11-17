import { describe, expect, test } from "bun:test"
import {
  createMemoryWatch,
  MEMORY_URGENT_MB,
  MEMORY_WARN_MB,
  MEMORY_WATCH_INTERVAL_MS,
  memoryReopenOffer,
  type MemoryReading,
  type MemoryThresholdEvent,
  type MemoryWatchDialogOptions,
} from "./memory-watch"

// Row 19 (SB-1): main-process memory watch. Injected clock, memory reader and dialog: no Electron, no real timer.

const MB = 1024 * 1024

type LogLine = { name: string; message: string; extra?: Record<string, unknown>; level: string }

function harness(input: { answers?: Array<number | Error>; locale?: string; holdDialog?: boolean } = {}) {
  let rssMb = 500
  let tick: (() => void) | undefined
  let intervalMs: number | undefined
  let cleared = 0
  let relaunched = 0
  let readFails = false
  const logs: LogLine[] = []
  const events: MemoryThresholdEvent[] = []
  const dialogs: MemoryWatchDialogOptions[] = []
  const pending: Array<(value: { response: number }) => void> = []
  const answers = [...(input.answers ?? [])]

  const watch = createMemoryWatch({
    clock: {
      setInterval: (fn, ms) => {
        tick = fn
        intervalMs = ms
        return "handle"
      },
      clearInterval: (handle) => {
        if (handle === "handle") cleared += 1
        tick = undefined
      },
    },
    readMemory: (): MemoryReading => {
      if (readFails) throw new Error("reader broke")
      return { rss: rssMb * MB, heapUsed: 100.4 * MB, heapTotal: 200.6 * MB, external: 3 * MB }
    },
    showMessageBox: (options) => {
      dialogs.push(options)
      if (input.holdDialog) return new Promise((resolve) => pending.push(resolve))
      const answer = answers.shift() ?? 1
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ response: answer })
    },
    relaunch: () => {
      relaunched += 1
    },
    log: (name, message, extra, level = "info") => logs.push({ name, message, extra, level }),
    onEvent: (event) => events.push(event),
    locale: () => input.locale ?? "en",
  })

  return {
    watch,
    logs,
    events,
    dialogs,
    pending,
    setRss: (mb: number) => (rssMb = mb),
    failReads: (on: boolean) => (readFails = on),
    // One interval elapses, then pending promise callbacks (the dialog answer) run.
    elapse: async () => {
      tick?.()
      await new Promise((resolve) => setTimeout(resolve, 0))
    },
    hasTimer: () => tick !== undefined,
    intervalMs: () => intervalMs,
    cleared: () => cleared,
    relaunched: () => relaunched,
    memoryLines: () => logs.filter((l) => l.message === "main memory"),
    thresholdLines: () => logs.filter((l) => l.message === "main memory threshold"),
  }
}

describe("memory watch constants (register section 10)", () => {
  test("interval and thresholds are the register's numbers", () => {
    expect(MEMORY_WATCH_INTERVAL_MS).toBe(60_000)
    expect(MEMORY_WARN_MB).toBe(2_700)
    expect(MEMORY_URGENT_MB).toBe(3_300)
  })
})

describe("periodic log", () => {
  test("nothing is logged before the first interval; the timer uses the register interval", () => {
    const h = harness()
    h.watch.start()
    expect(h.intervalMs()).toBe(60_000)
    expect(h.logs).toEqual([])
  })

  test("one line per interval, in the register's shape, integers only", async () => {
    const h = harness()
    h.watch.start()
    await h.elapse()
    await h.elapse()
    await h.elapse()
    expect(h.memoryLines()).toHaveLength(3)
    expect(h.memoryLines()[0]).toEqual({
      name: "memory",
      message: "main memory",
      extra: { rssMb: 500, heapUsedMb: 100, heapTotalMb: 201, externalMb: 3 },
      level: "info",
    })
    expect(h.thresholdLines()).toEqual([])
    expect(h.dialogs).toEqual([])
    expect(h.events).toEqual([])
  })

  test("start twice keeps one timer; stop clears it", () => {
    const h = harness()
    h.watch.start()
    h.watch.start()
    h.watch.stop()
    expect(h.cleared()).toBe(1)
    expect(h.hasTimer()).toBe(false)
  })
})

describe("warn threshold", () => {
  test("below the threshold by 1 MB: no event, no offer", async () => {
    const h = harness()
    h.watch.start()
    h.setRss(2_699)
    await h.elapse()
    expect(h.events).toEqual([])
    expect(h.dialogs).toEqual([])
  })

  test("at the threshold: one event, one threshold line, one offer through the dialog", async () => {
    const h = harness()
    h.watch.start()
    h.setRss(2_700)
    await h.elapse()
    expect(h.events).toEqual([{ level: "warn", rssMb: 2_700, thresholdMb: 2_700 }])
    expect(h.thresholdLines()).toEqual([
      {
        name: "memory",
        message: "main memory threshold",
        extra: { level: "warn", rssMb: 2_700, thresholdMb: 2_700 },
        level: "warn",
      },
    ])
    expect(h.dialogs).toHaveLength(1)
    expect(h.dialogs[0]).toEqual({
      type: "warning",
      message: "Swarm is using a lot of memory (2.7 GB). Reopen now to keep working safely?",
      buttons: ["Reopen", "Later"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
  })

  test("declining (Later) does not relaunch and the watch keeps logging", async () => {
    const h = harness({ answers: [1] })
    h.watch.start()
    h.setRss(2_800)
    await h.elapse()
    expect(h.relaunched()).toBe(0)
    await h.elapse()
    expect(h.memoryLines()).toHaveLength(2)
    expect(h.relaunched()).toBe(0)
    expect(h.logs.some((l) => l.message === "main memory reopen declined")).toBe(true)
  })

  test("accepting (Reopen) calls the injected relaunch once and stops the watch", async () => {
    const h = harness({ answers: [0] })
    h.watch.start()
    h.setRss(2_800)
    await h.elapse()
    expect(h.relaunched()).toBe(1)
    expect(h.hasTimer()).toBe(false)
    expect(h.logs.some((l) => l.message === "main memory reopen accepted")).toBe(true)
  })

  test("no repeat: warn is offered once per run, also after memory falls and rises again", async () => {
    const h = harness({ answers: [1, 1, 1] })
    h.watch.start()
    h.setRss(2_750)
    await h.elapse()
    for (let i = 0; i < 30; i++) await h.elapse()
    h.setRss(1_000)
    await h.elapse()
    h.setRss(2_900)
    await h.elapse()
    expect(h.dialogs).toHaveLength(1)
    expect(h.events).toHaveLength(1)
    expect(h.thresholdLines()).toHaveLength(1)
    expect(h.memoryLines()).toHaveLength(33)
  })
})

describe("urgent threshold", () => {
  test("crossing urgent after a declined warn: second event and the offer again, then never again", async () => {
    const h = harness({ answers: [1, 1] })
    h.watch.start()
    h.setRss(2_700)
    await h.elapse()
    h.setRss(3_300)
    await h.elapse()
    await h.elapse()
    await h.elapse()
    expect(h.events.map((e) => e.level)).toEqual(["warn", "urgent"])
    expect(h.events[1]).toEqual({ level: "urgent", rssMb: 3_300, thresholdMb: 3_300 })
    expect(h.dialogs).toHaveLength(2)
    expect(h.relaunched()).toBe(0)
  })

  test("first reading already above urgent: one event (urgent) and one offer, not two", async () => {
    const h = harness({ answers: [1] })
    h.watch.start()
    h.setRss(3_500)
    await h.elapse()
    await h.elapse()
    expect(h.events.map((e) => e.level)).toEqual(["urgent"])
    expect(h.dialogs).toHaveLength(1)
  })

  test("urgent while the warn offer is still open: event at once, no second dialog on top; offered after Later", async () => {
    const h = harness({ holdDialog: true })
    h.watch.start()
    h.setRss(2_800)
    await h.elapse()
    h.setRss(3_400)
    await h.elapse()
    expect(h.events.map((e) => e.level)).toEqual(["warn", "urgent"])
    expect(h.dialogs).toHaveLength(1)
    h.pending[0]({ response: 1 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.dialogs).toHaveLength(1)
    await h.elapse()
    expect(h.dialogs).toHaveLength(2)
    h.pending[1]({ response: 0 })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(h.relaunched()).toBe(1)
  })
})

describe("failure paths are logged, never thrown, never a relaunch", () => {
  test("dialog rejects: error line, no relaunch, watch continues", async () => {
    const h = harness({ answers: [new Error("no window")] })
    h.watch.start()
    h.setRss(2_800)
    await h.elapse()
    expect(h.relaunched()).toBe(0)
    const line = h.logs.find((l) => l.message === "main memory reopen offer failed")
    expect(line?.level).toBe("error")
    expect(line?.extra?.error).toBe("no window")
    await h.elapse()
    expect(h.memoryLines()).toHaveLength(2)
  })

  test("memory reader throws: error line, the next interval works again", async () => {
    const h = harness()
    h.watch.start()
    h.failReads(true)
    await h.elapse()
    expect(h.logs).toHaveLength(1)
    expect(h.logs[0].message).toBe("main memory watch failed")
    expect(h.logs[0].level).toBe("error")
    expect(h.logs[0].extra?.error).toBe("reader broke")
    h.failReads(false)
    await h.elapse()
    expect(h.memoryLines()).toHaveLength(1)
  })
})

describe("offer text (register section 10)", () => {
  test("English", () => {
    expect(memoryReopenOffer("en", 2_740)).toEqual({
      message: "Swarm is using a lot of memory (2.7 GB). Reopen now to keep working safely?",
      reopen: "Reopen",
      later: "Later",
    })
  })

  test("Indonesian, decimal comma", () => {
    expect(memoryReopenOffer("id", 3_349)).toEqual({
      message: "Swarm memakai banyak memori (3,3 GB). Buka ulang sekarang agar tetap aman?",
      reopen: "Buka ulang",
      later: "Nanti",
    })
  })

  test("any other locale falls back to English; the dialog follows the locale at offer time", async () => {
    expect(memoryReopenOffer("fr", 2_765).reopen).toBe("Reopen")
    const h = harness({ locale: "id" })
    h.watch.start()
    h.setRss(2_765)
    await h.elapse()
    expect(h.dialogs[0].buttons).toEqual(["Buka ulang", "Nanti"])
    expect(h.dialogs[0].message).toContain("(2,8 GB)")
  })
})
