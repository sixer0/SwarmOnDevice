/**
 * 1.3.4 T-06 (heap snapshot 2026-11-18): electron-context-menu called without `window` registers every
 * BrowserWindow through `browser-window-created` and keeps one disposer per window in an array that never shrinks.
 * Every hidden DATUM render window (one per render job) stayed alive with the page HTML its listeners close over,
 * 9-18 MB per job, until the main process ran out of heap (two crashes on 2026-11-18).
 *
 * These pins hold the fix: the menu is attached per app window with `window`, never app-wide, and the render window
 * factory keeps the page out of its listener closures and drops its listeners before destroying the window.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const MAIN = import.meta.dir
const read = (...p: string[]) => readFileSync(path.join(MAIN, ...p), "utf8")
const code = (text: string) => text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")

describe("T-06 context menu scope", () => {
  test("index.ts no longer installs the context menu app-wide", () => {
    const index = code(read("index.ts"))
    expect(index).not.toContain("electron-context-menu")
    expect(index).not.toMatch(/\bcontextMenu\s*\(/)
  })

  test("windows.ts attaches it per app window with `window` and disposes it on close", () => {
    const windows = code(read("windows.ts"))
    expect(windows).toContain('import contextMenu from "electron-context-menu"')
    expect(windows).toMatch(/contextMenu\(\{\s*\.\.\.CONTEXT_MENU_OPTIONS,\s*window:\s*win\s*\}\)/)
    expect(windows).toMatch(/win\.once\("closed",\s*\(\)\s*=>\s*dispose\(\)\)/)
    expect(windows).toContain("wireContextMenu(win)")
  })

  test("no other main-process file calls contextMenu without `window`", () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of require("node:fs").readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name)
        if (name.isDirectory()) walk(full)
        else if (name.name.endsWith(".ts") && !name.name.endsWith(".test.ts")) {
          const text = code(readFileSync(full, "utf8"))
          for (const m of text.matchAll(/\bcontextMenu\s*\(([^)]*)\)/g)) if (!m[1]!.includes("window")) hits.push(full)
        }
      }
    }
    walk(MAIN)
    expect(hits).toEqual([])
  })

  test("the render window never closes over the page html and drops its listeners before destroy", () => {
    const renderer = code(read("datum-render", "electron-renderer.ts"))
    const open = renderer.slice(renderer.indexOf("function openRenderWindow("), renderer.indexOf("async function inWindow<T>("))
    expect(open.length).toBeGreaterThan(200)
    expect(open).not.toMatch(/\bhtml\b/)
    expect(open).toContain("wc.removeAllListeners()")
    expect(open.indexOf("wc.removeAllListeners()")).toBeLessThan(open.indexOf("win.destroy()"))
  })
})
