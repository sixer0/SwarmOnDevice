// Row 18 (SB-1): the settings store dependency must not leave JS listeners on crash signals.
//
// Chain (real packages, nothing below is mocked except Electron's `app`/`ipcMain`, which electron-store reads for
// the userData path): electron-store 11.0.2 -> conf 15.1.0 -> atomically 2.1.1 -> when-exit 2.1.5. when-exit's
// interceptor runs at import time and does `process.once(signal, () => this.exit(signal))` for 13 signals on macOS.
// A JS listener on SIGTRAP/SIGABRT makes libuv queue the signal for the event loop instead of ending the process;
// when the main thread itself raised it (V8 out of memory) the loop never runs and the app hangs.
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mock } from "bun:test"

// Row 158: the measurements run only in a child `bun test` process (the layout of office-addin-menu.test.ts).
// bun's mock.module is process-wide and the first mock of a module fixes its export names: in the full suite
// onboarding.test.ts and rel128-r18c-missing-folder-desktop.test.ts (both earlier in src/main) mock "electron" as
// `{ app }` without `default`, so electron-store's `import electron from "electron"` failed to link here
// ("Missing 'default' export in module .../electron/index.js") and this file's own mock could not add the name. The
// listener counts also need a process in which electron-store was not loaded yet. The parent only starts the child.
const CHILD = process.env.SWARM_ROW18_CHILD === "1"

// What when-exit 2.1.5 hooks on macOS/Linux (dist/node/signals.js:5-7); Linux adds four more that are not crash signals.
const WHEN_EXIT_POSIX = ["SIGHUP", "SIGINT", "SIGTERM", "SIGALRM", "SIGABRT", "SIGVTALRM", "SIGXCPU", "SIGXFSZ", "SIGUSR2", "SIGTRAP", "SIGSYS", "SIGQUIT", "SIGIOT"] as const
const CRASH = ["SIGTRAP", "SIGABRT", "SIGIOT", "SIGSYS", "SIGQUIT", "SIGXCPU", "SIGXFSZ"] as const
const posix = process.platform !== "win32"

const counts = (signals: readonly string[]) => Object.fromEntries(signals.map((s) => [s, process.listenerCount(s)]))
type Counts = ReturnType<typeof counts>

const userData = CHILD ? mkdtempSync(join(tmpdir(), "row18-store-")) : ""
let pristine: Counts = {}
let afterDependencyImport: Counts = {}
let beforeStore: Counts = {}
let afterStoreImport: Counts = {}
let afterStoreInit: Counts = {}
let storeModule = {} as typeof import("./store")
let settings = {} as ReturnType<typeof import("./store").getStore>

let quitCalls = 0
const quit = () => {
  quitCalls++
}
const foreignOn = () => {}
const foreignOnce = () => {
  /* foreign once listener */
}

if (CHILD) {
  mock.module("electron", () => {
    const app = { getPath: () => userData, getVersion: () => "0.0.0-test", getName: () => "row18" }
    const ipcMain = { on: () => {} }
    return { default: { app, ipcMain }, app, ipcMain }
  })

  // 1. Baseline: nothing of ours yet.
  pristine = counts(WHEN_EXIT_POSIX)

  // 2. The real dependency, imported the way store.ts imports it. Its listeners appear at import, before any store exists.
  await import("electron-store")
  afterDependencyImport = counts(WHEN_EXIT_POSIX)

  // 3. Foreign listeners, registered the way src/main/index.ts registers the app's quit handler (process.on, one function
  //    for SIGINT and SIGTERM), plus two foreign listeners on a crash signal that the change must not touch.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, quit)
  process.on("SIGTRAP", foreignOn)
  process.once("SIGTRAP", foreignOnce)
  beforeStore = counts(WHEN_EXIT_POSIX)

  // 4. The module under test. Loading it runs the removal once; getStore runs it again after the store is created.
  storeModule = await import("./store")
  afterStoreImport = counts(WHEN_EXIT_POSIX)
  settings = storeModule.getStore("row18.settings")
  afterStoreInit = counts(WHEN_EXIT_POSIX)
}

afterAll(() => {
  if (!CHILD) return
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeListener(signal, quit)
  process.removeListener("SIGTRAP", foreignOn)
  process.removeListener("SIGTRAP", foreignOnce)
  rmSync(userData, { recursive: true, force: true })
})

describe.if(CHILD)("row 18: crash-signal listeners from the settings store dependency", () => {
  test("diagnosis: importing electron-store alone adds one listener per hooked signal", () => {
    console.log("row18 listener counts", JSON.stringify({ pristine, afterDependencyImport, beforeStore, afterStoreImport, afterStoreInit }))
    if (!posix) return
    for (const signal of WHEN_EXIT_POSIX) expect(afterDependencyImport[signal] - pristine[signal]).toBe(1)
  })

  test("the crash signal list is the fatal subset of what the dependency hooks", () => {
    expect([...storeModule.CRASH_SIGNALS].sort()).toEqual([...CRASH].sort())
    for (const signal of storeModule.CRASH_SIGNALS) expect(WHEN_EXIT_POSIX as readonly string[]).toContain(signal)
    for (const keep of ["SIGINT", "SIGTERM", "SIGHUP"]) expect(storeModule.CRASH_SIGNALS as readonly string[]).not.toContain(keep)
  })

  test("after store init the dependency has 0 listeners on every crash signal", () => {
    if (!posix) return
    for (const signal of CRASH) {
      const foreign = signal === "SIGTRAP" ? 2 : 0
      expect(afterStoreImport[signal]).toBe(pristine[signal] + foreign)
      expect(afterStoreInit[signal]).toBe(pristine[signal] + foreign)
    }
    const report = storeModule.crashSignalListenerReport()
    expect(report.error).toBeUndefined()
    expect(report.remaining).toBe(0)
    for (const signal of CRASH) expect(report.removed[signal]).toBe(1)
  })

  test("foreign listeners on a crash signal are not removed", () => {
    const left = process.listeners("SIGTRAP")
    expect(left).toContain(foreignOn)
    expect(left).toContain(foreignOnce)
  })

  test("SIGINT and SIGTERM quit handlers remain, and nothing else on the non-crash signals was touched", () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      expect(process.listeners(signal)).toContain(quit)
      expect(afterStoreInit[signal]).toBe(beforeStore[signal])
    }
    for (const signal of ["SIGHUP", "SIGALRM", "SIGVTALRM", "SIGUSR2"]) expect(afterStoreInit[signal]).toBe(beforeStore[signal])
    process.emit("SIGTERM", "SIGTERM")
    expect(quitCalls).toBeGreaterThanOrEqual(1)
  })

  test("the removal is idempotent and a second store does not bring listeners back", () => {
    storeModule.getStore("row18.other")
    const again = storeModule.removeDependencyCrashSignalListeners()
    expect(Object.values(again.removed).reduce((a, b) => a + b, 0)).toBe(0)
    if (!posix) return
    for (const signal of CRASH) expect(process.listenerCount(signal)).toBe(afterStoreInit[signal])
  })

  test("a listener of another shape on all crash signals is not taken for the dependency's", () => {
    const calls: string[] = []
    const fake = {
      lists: new Map<string, Function[]>(),
      rawListeners(signal: string) {
        return this.lists.get(signal) ?? []
      },
      removeListener(signal: string, fn: Function) {
        calls.push(signal)
        this.lists.set(signal, (this.lists.get(signal) ?? []).filter((x) => x !== fn))
        return this
      },
    }
    for (const signal of CRASH) fake.lists.set(signal, [() => console.log("other library", signal)])
    // dependency shape, but only on one signal: not the import-time hook of the dependency either
    const self = { exit: (_: string) => {} }
    const partial = function (this: typeof self) {
      return () => this.exit("SIGTRAP")
    }.call(self)
    fake.lists.get("SIGTRAP")!.push(partial)
    const result = storeModule.removeDependencyCrashSignalListeners(fake as never)
    expect(calls).toEqual([])
    expect(Object.values(result.removed).reduce((a, b) => a + b, 0)).toBe(0)
  })

  test("store data path still works (set, read back, file on disk, no temp file left)", () => {
    settings.set("k", "v")
    expect(settings.get("k")).toBe("v")
    expect(existsSync(join(userData, "row18.settings"))).toBe(true)
    expect(readdirSync(userData).filter((name) => name.includes(".tmp-"))).toEqual([])
  })
})

// Real Node (libuv signal handling as in the Electron main process), real when-exit, no Electron. The child imports
// conf (so when-exit hooks), optionally runs the removal function taken from store.ts, raises SIGTRAP at itself and then
// never returns to the event loop: the situation of the hang, where the thread that received the signal cannot run JS.
const node = (() => {
  const found = spawnSync("node", ["-e", "process.stdout.write(process.version)"], { encoding: "utf8" })
  return found.status === 0 && /^v\d+/.test(found.stdout) ? found.stdout : undefined
})()

function runChild(mode: "untouched" | "removed") {
  const confEntry = join(dirname(realpathSync(fileURLToPath(import.meta.resolve("electron-store")))), "..", "conf", "dist", "source", "index.js")
  const script = join(userData, `child-${mode}.mjs`)
  writeFileSync(
    script,
    [
      `import fs from "node:fs"`,
      `await import(${JSON.stringify(pathToFileURL(confEntry).href)})`,
      `const remove = ${storeModule.removeDependencyCrashSignalListeners.toString()}`,
      `const before = process.listenerCount("SIGTRAP")`,
      mode === "removed" ? `remove(process, ${JSON.stringify(CRASH)})` : ``,
      `fs.writeSync(1, JSON.stringify({ before, after: process.listenerCount("SIGTRAP"), sigterm: process.listenerCount("SIGTERM") }) + "\\n")`,
      `process.kill(process.pid, "SIGTRAP")`,
      `const end = Date.now() + 30000`,
      `while (Date.now() < end) {}`,
      `fs.writeSync(1, "loop ended\\n")`,
    ].join("\n"),
  )
  return new Promise<{ out: string; exit: number | null; signal: string | null; hungFor?: number }>((resolve) => {
    const child = spawn("node", [script], { stdio: ["ignore", "pipe", "pipe"] })
    let out = ""
    child.stdout.on("data", (chunk) => (out += chunk))
    const started = Date.now()
    let hungFor: number | undefined
    const timer = setTimeout(() => {
      hungFor = Date.now() - started
      child.kill("SIGKILL")
    }, 3000)
    child.on("exit", (exit, signal) => {
      clearTimeout(timer)
      resolve({ out: out.trim(), exit, signal, hungFor })
    })
  })
}

describe.if(CHILD && posix && !!node)("row 18: real Node process, signal raised while the event loop cannot run", () => {
  test("untouched dependency: SIGTRAP is absorbed and the process spins until SIGKILL", async () => {
    const result = await runChild("untouched")
    console.log("row18 node child untouched", node, JSON.stringify(result))
    expect(JSON.parse(result.out)).toEqual({ before: 1, after: 1, sigterm: 1 })
    expect(result.hungFor).toBeGreaterThanOrEqual(3000)
    expect(result.signal).toBe("SIGKILL")
  }, 15000)

  test("after the removal: SIGTRAP ends the process at once with the default action", async () => {
    const result = await runChild("removed")
    console.log("row18 node child removed", node, JSON.stringify(result))
    expect(JSON.parse(result.out)).toEqual({ before: 1, after: 0, sigterm: 1 })
    expect(result.hungFor).toBeUndefined()
    expect(result.signal).toBe("SIGTRAP")
  }, 15000)
})

// Row 158: the parent run. 8 in-process cases, plus the 2 real-Node cases where `node` is on PATH (POSIX only).
test.if(!CHILD)("row 18 cases pass in an isolated child bun process (electron mocked there only)", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "row18-child-")))
  const child = spawnSync(process.execPath, ["test", import.meta.path], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, HOME: home, SWARM_ROW18_CHILD: "1" },
    encoding: "utf8",
    timeout: 60_000,
  })
  rmSync(home, { recursive: true, force: true })
  const out = `${child.stdout}\n${child.stderr}`
  const expected = posix && node ? 10 : 8
  expect({ status: child.status, out }).toMatchObject({ status: 0 })
  expect(out).toMatch(new RegExp(`\\b${expected} pass\\b`))
  expect(out).toMatch(/\b0 fail\b/)
  expect(out).not.toContain("Missing 'default' export")
}, 70_000)
