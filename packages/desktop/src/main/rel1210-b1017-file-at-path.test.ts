// N10-205 part 3 (Swarm 1.2.10 row 84, AC-B1017, B10-17; security S10-42): a regular file, or a symlink to one,
// that sat at the project folder's path no longer blocks the first Recreate after it is removed.
// Red at a3e3c4c93a: the check answers "missing" for a non-directory but does not record the path for Recreate
// (SR7-13 rule 4), so D2 and D5 get `false` after the file or link is removed, and no `NOT_A_FOLDER` line is logged.
// Green: the path is recorded; rule 1 still refuses while anything is at the leaf (D1, D5), the set stays per window
// (D3), and the log line is the missing-case line with `code: "NOT_A_FOLDER"` and no path (D4).
// Harness as rel127-u8-missing-directory.test.ts:30-58. Synthetic temp folders only.

import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHECK_DIRECTORY_EXISTS, RECREATE_DIRECTORY, registerMissingDirectoryHandlers } from "./missing-directory"

const T = realpathSync(mkdtempSync(join(tmpdir(), "r1210b1017-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const home = join(T, "home")
const docs = join(home, "Documents")
const swarmConfig = join(home, ".config", "swarm")
mkdirSync(docs, { recursive: true })
mkdirSync(swarmConfig, { recursive: true })

type Handler = (event: { sender: object }, ...args: unknown[]) => Promise<unknown>
type LogLine = { level: string; message: string; context?: Record<string, unknown> }

function setup() {
  const handlers = new Map<string, Handler>()
  const mkdirs: string[] = []
  const logs: LogLine[] = []
  const { stat, mkdir } = require("node:fs/promises") as typeof import("node:fs/promises")
  registerMissingDirectoryHandlers({
    ipcMain: { handle: ((channel: string, fn: Handler) => void handlers.set(channel, fn)) as never },
    home,
    excluded: [swarmConfig],
    fs: {
      stat: (p) => stat(p),
      mkdir: (p) => {
        mkdirs.push(p)
        return mkdir(p)
      },
    },
    log: (level, message, context) => void logs.push({ level, message, context }),
  })
  const call = (channel: string, sender: object, path: unknown) => handlers.get(channel)!({ sender }, path)
  return { mkdirs, logs, call }
}

describe("N10-205 part 3: a file at the project path, then removed (AC-B1017)", () => {
  const filed = join(docs, "Filed")
  // one handler set and one window (sender) shared by D1-D4, as the app keeps one window open across the steps
  const h = setup()
  const sender = {}

  test("D1 a regular file at the path: check missing, Recreate refused, the file untouched", async () => {
    writeFileSync(filed, "synthetic")
    expect(await h.call(CHECK_DIRECTORY_EXISTS, sender, filed)).toBe("missing")
    expect(await h.call(RECREATE_DIRECTORY, sender, filed)).toBe(false)
    expect(lstatSync(filed).isFile()).toBe(true)
    expect(readFileSync(filed, "utf8")).toBe("synthetic")
    expect(h.mkdirs).toEqual([])
  })

  test("D2 the file removed: the first Recreate (same window) creates the folder, once", async () => {
    unlinkSync(filed)
    expect(await h.call(RECREATE_DIRECTORY, sender, filed)).toBe(true)
    expect(lstatSync(filed).isDirectory()).toBe(true)
    expect(readdirSync(filed)).toEqual([])
    expect(h.mkdirs).toEqual([filed])
    expect(await h.call(CHECK_DIRECTORY_EXISTS, sender, filed)).toBe("exists")
    // the path left the set: a second Recreate is refused
    expect(await h.call(RECREATE_DIRECTORY, sender, filed)).toBe(false)
    expect(h.mkdirs).toEqual([filed])
  })

  test("D3 another window that never checked cannot Recreate (rule 4 per window)", async () => {
    const other = join(docs, "Filed Two")
    writeFileSync(other, "synthetic")
    const first = setup()
    expect(await first.call(CHECK_DIRECTORY_EXISTS, {}, other)).toBe("missing")
    unlinkSync(other)
    expect(await first.call(RECREATE_DIRECTORY, {}, other)).toBe(false)
    expect(existsSync(other)).toBe(false)
    expect(first.mkdirs).toEqual([])
  })

  test("D4 the logs carry no folder name and no temp path", () => {
    const text = JSON.stringify(h.logs)
    expect(text).not.toContain("Filed")
    expect(text).not.toContain(T)
    expect(text).not.toContain(tmpdir())
  })

  test("D4 (S10-42) a non-directory at the path logs the missing-case line with code NOT_A_FOLDER, path-free", async () => {
    const at = join(docs, "Filed Three")
    writeFileSync(at, "synthetic")
    const s = setup()
    expect(await s.call(CHECK_DIRECTORY_EXISTS, {}, at)).toBe("missing")
    const line = s.logs.find((l) => l.context?.code === "NOT_A_FOLDER")
    expect(line).toEqual({
      level: "info",
      message: "check-directory-exists: project folder missing",
      context: { source: "missing-directory.check", code: "NOT_A_FOLDER" },
    })
    expect(JSON.stringify(s.logs)).not.toContain("Filed Three")
    expect(JSON.stringify(s.logs)).not.toContain(T)
    rmSync(at)
  })

  test("D5 (S10-42) a symlink to a regular file at the leaf: missing, Recreate refused, link and target untouched; removed: Recreate works", async () => {
    const target = join(T, "target.txt")
    writeFileSync(target, "synthetic")
    const link = join(docs, "Linked")
    symlinkSync(target, link)
    const s = setup()
    const win = {}
    expect(await s.call(CHECK_DIRECTORY_EXISTS, win, link)).toBe("missing")
    expect(await s.call(RECREATE_DIRECTORY, win, link)).toBe(false)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(target)
    expect(readFileSync(target, "utf8")).toBe("synthetic")
    expect(s.mkdirs).toEqual([])
    unlinkSync(link)
    expect(await s.call(RECREATE_DIRECTORY, win, link)).toBe(true)
    expect(lstatSync(link).isDirectory()).toBe(true)
    expect(readdirSync(link)).toEqual([])
    expect(s.mkdirs).toEqual([link])
    // the former target is untouched
    expect(lstatSync(target).isFile()).toBe(true)
    expect(readFileSync(target, "utf8")).toBe("synthetic")
    expect(JSON.stringify(s.logs)).not.toContain("Linked")
  })
})
