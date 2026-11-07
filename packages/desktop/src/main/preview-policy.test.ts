// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2): P5 (main window prefs) and P6 (a click
// inside a preview frame neither navigates the app nor reaches the network). The same functions run in a real
// Electron window in packages/desktop/test/file-preview-electron.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  handlePreviewFrameNavigation,
  mainWindowWebPreferences,
  previewFrameNavigationAllowed,
} from "./preview-policy"

// The same test as windows.ts isRendererUrl (protocol `oc:` and host `renderer`; a non-special scheme has origin "null").
const renderer = (url: string) => URL.canParse(url) && new URL(url).protocol === "oc:" && new URL(url).host === "renderer"

describe("P5: the main window's webPreferences", () => {
  test("contextIsolation true, nodeIntegration false, sandbox true, plugins true, webviewTag absent", () => {
    const prefs = mainWindowWebPreferences("/app/preload/index.js")
    expect(prefs).toEqual({
      preload: "/app/preload/index.js",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      plugins: true,
    })
    expect("webviewTag" in prefs).toBe(false)
  })

  test("windows.ts builds the main window from exactly these prefs, and nothing else turns on webviewTag", () => {
    const source = readFileSync(join(import.meta.dir, "windows.ts"), "utf8")
    expect(source).toContain('webPreferences: mainWindowWebPreferences(join(root, "../preload/index.js")),')
    expect(source.split("webPreferences").length - 1).toBe(1)
    expect(source).not.toContain("webviewTag")
    expect(source).toContain("wirePreviewFramePolicy(")
  })
})

describe("P6: sub-frame navigation policy", () => {
  test("preview documents, the renderer's own blobs and the PDF viewer's internal frames are allowed", () => {
    for (const url of [
      "about:srcdoc",
      "about:blank",
      "blob:oc://renderer/5d1c2b7e-0000-4000-8000-000000000000",
      "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html",
      "oc://renderer/index.html",
    ])
      expect({ url, ok: previewFrameNavigationAllowed(url, renderer) }).toEqual({ url, ok: true })
  })

  test("web, file, other apps' blobs and unknown schemes are refused", () => {
    for (const url of [
      "https://example.invalid/page",
      "http://127.0.0.1:9/x",
      "file:///etc/hosts",
      "blob:https://example.invalid/5d1c2b7e",
      "ftp://example.invalid/",
      "javascript:alert(1)",
      // Row 48a (C103, L3): a frame may not become a data: document (script-capable, inside the main window).
      "data:text/html,<script>alert(1)</script>",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "data:application/pdf;base64,JVBERi0=",
      "oc://other/index.html",
      "not a url",
    ])
      expect({ url, ok: previewFrameNavigationAllowed(url, renderer) }).toEqual({ url, ok: false })
  })

  test("a sub-frame link click is prevented and logged; the main frame is left to will-navigate", () => {
    const logs: unknown[] = []
    let prevented = 0
    const event = (url: string, isMainFrame: boolean) => ({ url, isMainFrame, preventDefault: () => void prevented++ })
    expect(handlePreviewFrameNavigation(event("https://example.invalid/page", false), renderer, (m, d) => logs.push([m, d]))).toBe(true)
    expect(prevented).toBe(1)
    expect(logs).toEqual([["blocked sub-frame navigation", { url: "https://example.invalid/page" }]])
    expect(handlePreviewFrameNavigation(event("https://example.invalid/page", true), renderer, () => {})).toBe(false)
    expect(handlePreviewFrameNavigation(event("about:srcdoc", false), renderer, () => {})).toBe(false)
    expect(prevented).toBe(1)
    expect(handlePreviewFrameNavigation(event("data:text/html,<b>x</b>", false), renderer, () => {})).toBe(true)
    expect(prevented).toBe(2)
  })
})
