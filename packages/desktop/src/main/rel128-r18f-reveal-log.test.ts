// N8-327 (Swarm 1.2.8 row 30c, AC-R18f, SR8-24): a successful reveal is logged, and no reveal log carries the path.
// Red at e1f9673772: revealInFolder logs only refusals and failures, so a successful reveal makes 0 log calls.
// Green: exactly one `info` call "revealed in folder" (N8-219, corrected) with context { source: "reveal-path" } and
// no path, no basename, no hash (reveal-path.ts: "The path itself is never logged"). Refusal log unchanged (CHAR);
// a failure says what failed, with the path removed from the error text. Synthetic temp folders only.

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { revealInFolder } from "./reveal-path"

const T = realpathSync(mkdtempSync(join(tmpdir(), "r128r18f-")))
afterAll(() => rmSync(T, { recursive: true, force: true }))

const home = join(T, "home")
const proj = join(T, "proj")
const deliver = join(proj, "docs", "m1", "11_deliverables")
const other = join(T, "other")
mkdirSync(deliver, { recursive: true })
mkdirSync(join(home, "Notes"), { recursive: true })
mkdirSync(join(deliver, "Tool.app", "Contents"), { recursive: true })
mkdirSync(other, { recursive: true })
writeFileSync(join(deliver, "LaporanRahasiaR18f.pdf"), "%PDF-1.7\n")
writeFileSync(join(home, "Notes", "attachmentR18f.txt"), "synthetic")
writeFileSync(join(other, "secretR18f.txt"), "synthetic")

const roots = [proj, home]
type Entry = { level: string; message: string; context?: Record<string, unknown> }
let logs: Entry[]
let shown: string[]
beforeEach(() => {
  logs = []
  shown = []
})
const log = (level: string, message: string, context?: Record<string, unknown>) =>
  void logs.push({ level, message, context })
const okShell = { showItemInFolder: (p: string) => void shown.push(p) }
// Cast: at BASE the log type is "warn" | "error"; the test passes a wider logger.
const reveal = (path: string, shell: { showItemInFolder: (p: string) => void } = okShell) =>
  revealInFolder(path, roots, { shell, home, platform: "darwin", log } as Parameters<typeof revealInFolder>[2])

/** No full path, no folder or file name, no hash of any kind in what was logged. */
function noPathIn(entries: Entry[], path: string) {
  const text = JSON.stringify(entries)
  expect(text).not.toContain(T)
  for (const part of path.slice(T.length).split("/").filter(Boolean)) expect(text).not.toContain(part)
  expect(text).not.toMatch(/[0-9a-f]{16,}/i)
}

describe("N8-327 AC-R18f success log", () => {
  test("a successful reveal makes exactly one info call with source only", () => {
    const path = join(deliver, "LaporanRahasiaR18f.pdf")
    expect(reveal(path)).toBe(true)
    expect(shown).toEqual([path])
    expect(logs).toEqual([{ level: "info", message: "revealed in folder", context: { source: "reveal-path" } }])
    noPathIn(logs, path)
  })
  test("an .app folder and a home attachment (root b) log the same line, no path", () => {
    const app = join(deliver, "Tool.app")
    const note = join(home, "Notes", "attachmentR18f.txt")
    expect(reveal(app)).toBe(true)
    expect(reveal(note)).toBe(true)
    expect(logs).toEqual([
      { level: "info", message: "revealed in folder", context: { source: "reveal-path" } },
      { level: "info", message: "revealed in folder", context: { source: "reveal-path" } },
    ])
    noPathIn(logs, app)
    noPathIn(logs, note)
  })
})

describe("N8-327 AC-R18f refusal and failure logs carry no path", () => {
  test("refusal: one warn line, unchanged, no path (CHAR)", () => {
    const path = join(other, "secretR18f.txt")
    expect(reveal(path)).toBe(false)
    expect(logs).toEqual([
      { level: "warn", message: "reveal-path refused a path outside the allowed roots", context: { source: "reveal-path", roots: 2 } },
    ])
    noPathIn(logs, path)
  })
  test("failure: one error line saying what failed, the path removed from the error text", () => {
    const path = join(deliver, "LaporanRahasiaR18f.pdf")
    const failing = {
      showItemInFolder: (p: string) => {
        throw new Error(`cannot show ${p} in the file manager`)
      },
    }
    expect(reveal(path, failing)).toBe(false)
    expect(logs.length).toBe(1)
    expect(logs[0].level).toBe("error")
    expect(logs[0].message).toBe("reveal-path showItemInFolder failed")
    expect(logs[0].context?.source).toBe("reveal-path")
    expect(String(logs[0].context?.message)).toContain("in the file manager")
    noPathIn(logs, path)
  })
})
