// N7-095 (Swarm 1.2.7 row 32, AC-U8 desktop half, SR7-13 rules 1-4): `check-directory-exists` (N7-037) and
// `recreate-directory` (N7-039).
// Red at 04067a9d02: missing-directory.ts and both channels do not exist (import-level red, the named exception in
// 01_specs §2.8); the behaviour assertions below then fail for the stated reason. Green: check stats only, recreate
// makes only the leaf a window found missing, nothing is created without the recreate call, and system, Swarm-state
// and credential places, UNC and /net paths are refused (the latter without any stat). Synthetic temp folders only.

import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECK_DIRECTORY_EXISTS, RECREATE_DIRECTORY, registerMissingDirectoryHandlers } from "./missing-directory"

const T = realpathSync(mkdtempSync(join(tmpdir(), "r127u8-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const home = join(T, "home")
const docs = join(home, "Documents")
const swarmConfig = join(home, ".config", "swarm")
mkdirSync(docs, { recursive: true })
mkdirSync(swarmConfig, { recursive: true })
mkdirSync(join(home, ".ssh"), { recursive: true })
mkdirSync(join(T, "outside"), { recursive: true })
writeFileSync(join(docs, "a-file.txt"), "synthetic")

type Handler = (event: { sender: object }, ...args: unknown[]) => Promise<unknown>

function setup(opts: { trusted?: boolean; platform?: NodeJS.Platform } = {}) {
  const handlers = new Map<string, Handler>()
  const stats: string[] = []
  const mkdirs: string[] = []
  const logs: Array<{ level: string; message: string; context?: Record<string, unknown> }> = []
  const { stat, mkdir } = require("node:fs/promises") as typeof import("node:fs/promises")
  registerMissingDirectoryHandlers({
    ipcMain: { handle: ((channel: string, fn: Handler) => void handlers.set(channel, fn)) as never },
    home,
    excluded: [swarmConfig],
    platform: opts.platform,
    isTrustedSender: opts.trusted === false ? () => false : undefined,
    fs: {
      stat: (p) => {
        stats.push(p)
        return stat(p)
      },
      mkdir: (p) => {
        mkdirs.push(p)
        return mkdir(p)
      },
    },
    log: (level, message, context) => void logs.push({ level, message, context }),
  })
  const call = (channel: string, sender: object, path: unknown) => handlers.get(channel)!({ sender }, path)
  return { handlers, stats, mkdirs, logs, call }
}

describe("N7-095 check-directory-exists / recreate-directory (SR7-13 rules 1-4)", () => {
  test("registering creates nothing and stats nothing; both channels exist", () => {
    const before = readdirSync(docs).sort()
    const { handlers, stats, mkdirs } = setup()
    expect([...handlers.keys()].sort()).toEqual([CHECK_DIRECTORY_EXISTS, RECREATE_DIRECTORY].sort())
    expect(CHECK_DIRECTORY_EXISTS).toBe("check-directory-exists")
    expect(RECREATE_DIRECTORY).toBe("recreate-directory")
    expect(stats).toEqual([])
    expect(mkdirs).toEqual([])
    expect(readdirSync(docs).sort()).toEqual(before)
  })

  test("check: existing folder true, missing folder false, a file false; check never creates", async () => {
    const { call, mkdirs } = setup()
    const sender = {}
    const gone = join(docs, "Default Project")
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, docs)).toBe(true)
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, gone)).toBe(false)
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, join(docs, "a-file.txt"))).toBe(false)
    // asking again, many times, still creates nothing (startup = stat only)
    for (let i = 0; i < 3; i++) expect(await call(CHECK_DIRECTORY_EXISTS, sender, gone)).toBe(false)
    expect(existsSync(gone)).toBe(false)
    expect(mkdirs).toEqual([])
  })

  test("no folder is created without the recreate call; recreate makes the leaf once", async () => {
    const { call, mkdirs, logs } = setup()
    const sender = {}
    const gone = join(docs, "Proj One")
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, gone)).toBe(false)
    expect(existsSync(gone)).toBe(false)
    expect(await call(RECREATE_DIRECTORY, sender, gone)).toBe(true)
    expect(existsSync(gone)).toBe(true)
    expect(realpathSync(gone)).toBe(join(realpathSync(docs), "Proj One"))
    expect(mkdirs).toEqual([gone])
    expect(readdirSync(gone)).toEqual([]) // an empty folder, nothing else
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, gone)).toBe(true)
    // a second recreate is refused: the path is no longer in this window's missing set
    expect(await call(RECREATE_DIRECTORY, sender, gone)).toBe(false)
    expect(mkdirs).toEqual([gone])
    // the path itself is never logged
    expect(JSON.stringify(logs)).not.toContain("Proj One")
  })

  test("rule 4: recreate refuses a path this sender did not find missing (deep link / other window)", async () => {
    const { call, mkdirs } = setup()
    const a = {}
    const b = {}
    const never = join(docs, "Never Checked")
    expect(await call(RECREATE_DIRECTORY, a, never)).toBe(false)
    const seenByA = join(docs, "Seen By A")
    expect(await call(CHECK_DIRECTORY_EXISTS, a, seenByA)).toBe(false)
    expect(await call(RECREATE_DIRECTORY, b, seenByA)).toBe(false)
    expect(existsSync(never)).toBe(false)
    expect(existsSync(seenByA)).toBe(false)
    expect(mkdirs).toEqual([])
  })

  test("rule 1 (R-2): leaf only, never parents; EEXIST gives false", async () => {
    const { call, mkdirs } = setup()
    const sender = {}
    const deep = join(docs, "Gone Parent", "Gone Leaf")
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, deep)).toBe(false)
    expect(await call(RECREATE_DIRECTORY, sender, deep)).toBe(false)
    expect(existsSync(join(docs, "Gone Parent"))).toBe(false)
    expect(mkdirs).toEqual([])
    // the folder came back between check and click: EEXIST path gives false and touches nothing
    const back = join(docs, "Came Back")
    expect(await call(CHECK_DIRECTORY_EXISTS, sender, back)).toBe(false)
    mkdirSync(back)
    writeFileSync(join(back, "keep.txt"), "synthetic")
    expect(await call(RECREATE_DIRECTORY, sender, back)).toBe(false)
    expect(readFileSync(join(back, "keep.txt"), "utf8")).toBe("synthetic")
  })

  test("rule 2: input rules, system, Swarm-state, credential places and home refused (no stat)", async () => {
    const { call, stats, mkdirs } = setup()
    const sender = {}
    const refused: unknown[] = [
      "relative/path",
      "",
      42,
      null,
      `${docs}/../Documents/x`,
      join(docs, "bad\u0000name"),
      join(docs, "bad\nname"),
      "/",
      "/System/Gone",
      "/Library/Gone",
      "/usr/local/gone",
      "/private/etc/gone",
      "/private/var/db/gone",
      "/Volumes",
      join(swarmConfig, "gone"),
      join(home, ".ssh"),
      join(home, ".ssh", "gone"),
      join(home, "Library", "Keychains", "gone"),
      home,
      T,
    ]
    for (const p of refused) {
      expect(await call(CHECK_DIRECTORY_EXISTS, sender, p)).toBe(false)
      expect(await call(RECREATE_DIRECTORY, sender, p)).toBe(false)
    }
    expect(stats).toEqual([])
    expect(mkdirs).toEqual([])
  })

  test("rule 2: a symlinked parent that lands in an excluded place is refused", async () => {
    const { call, stats, mkdirs } = setup()
    const sender = {}
    symlinkSync(swarmConfig, join(docs, "looks-harmless"))
    symlinkSync(join(home, ".ssh"), join(docs, "keys-link"))
    for (const p of [join(docs, "looks-harmless", "gone"), join(docs, "keys-link", "gone")]) {
      expect(await call(CHECK_DIRECTORY_EXISTS, sender, p)).toBe(false)
      expect(await call(RECREATE_DIRECTORY, sender, p)).toBe(false)
    }
    expect(stats).toEqual([])
    expect(mkdirs).toEqual([])
    expect(readdirSync(swarmConfig)).toEqual([])
  })

  test("rule 3: no stat on /net, /Network or UNC paths", async () => {
    const posix = setup()
    for (const p of ["/net/host/share/proj", "/Network/Servers/host/proj", "/NET/host/proj"]) {
      expect(await posix.call(CHECK_DIRECTORY_EXISTS, {}, p)).toBe(false)
    }
    expect(posix.stats).toEqual([])
    const win = setup({ platform: "win32" })
    for (const p of ["\\\\host\\share\\proj", "//host/share/proj", "\\\\?\\C:\\proj", "\\\\.\\C:\\proj", "C:\\proj\\CON"]) {
      expect(await win.call(CHECK_DIRECTORY_EXISTS, {}, p)).toBe(false)
      expect(await win.call(RECREATE_DIRECTORY, {}, p)).toBe(false)
    }
    expect(win.stats).toEqual([])
    expect(win.mkdirs).toEqual([])
  })

  test("an untrusted sender gets false and nothing is touched", async () => {
    const { call, stats, mkdirs } = setup({ trusted: false })
    expect(await call(CHECK_DIRECTORY_EXISTS, {}, docs)).toBe(false)
    expect(await call(RECREATE_DIRECTORY, {}, join(docs, "x"))).toBe(false)
    expect(stats).toEqual([])
    expect(mkdirs).toEqual([])
  })

  test("wiring: ipc.ts registers the channels, preload exposes them, the renderer platform maps them", () => {
    const src = (p: string) => readFileSync(join(import.meta.dir, p), "utf8")
    expect(src("ipc.ts").includes("registerMissingDirectoryHandlers(")).toBe(true)
    const preload = src("../preload/index.ts")
    expect(preload).toContain(`ipcRenderer.invoke("check-directory-exists", path)`)
    expect(preload).toContain(`ipcRenderer.invoke("recreate-directory", path)`)
    const types = src("../preload/types.ts")
    expect(types).toContain("checkDirectoryExists: (path: string) => Promise<boolean>")
    expect(types).toContain("recreateDirectory: (path: string) => Promise<boolean>")
    const renderer = src("../renderer/index.tsx")
    expect(renderer).toContain("window.api.checkDirectoryExists(path)")
    expect(renderer).toContain("window.api.recreateDirectory(path)")
    const platform = readFileSync(join(import.meta.dir, "../../../app/src/context/platform.tsx"), "utf8")
    expect(platform).toContain("checkDirectoryExists?(path: string): Promise<boolean>")
    expect(platform).toContain("recreateDirectory?(path: string): Promise<boolean>")
    // nothing at startup: the main process never calls the handlers itself
    expect(src("index.ts")).not.toContain("check-directory-exists")
    expect(src("index.ts")).not.toContain("recreate-directory")
  })
})
