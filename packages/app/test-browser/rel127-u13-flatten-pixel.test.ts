// Swarm 1.2.7 U-13 (C63 D-13c): pixel check of the paste flatten in a real browser. happy-dom has no
// rasterising canvas, so this test bundles the shared helper and runs it in headless Chromium
// (Playwright's browser, or the installed Chrome): a transparent PNG with black text-like pixels must come back with
// those pixels black and every transparent pixel opaque white.
import { expect, test } from "bun:test"
import { chromium } from "@playwright/test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const helper = new URL("../../session-ui/src/v2/components/prompt-input/paste-source.ts", import.meta.url).pathname

async function bundle() {
  const dir = await mkdtemp(path.join(tmpdir(), "u13-"))
  try {
    const entry = path.join(dir, "entry.ts")
    await writeFile(entry, `import * as paste from ${JSON.stringify(helper)}\n;(globalThis as any).__paste = paste\n`)
    const built = await Bun.build({ entrypoints: [entry], format: "iife", target: "browser" })
    if (!built.success) throw new Error(built.logs.map(String).join("\n"))
    return await built.outputs[0].text()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test("a transparent pasted PNG is flattened onto white with its dark pixels kept", async () => {
  const script = await bundle()
  // Playwright's pinned headless shell first; an installed Chrome when that build is not downloaded.
  const browser = await chromium
    .launch({ headless: true })
    .catch(() => chromium.launch({ headless: true, channel: "chrome" }))
  try {
    const page = await browser.newPage()
    await page.setContent("<!doctype html><html><body></body></html>")
    await page.addScriptTag({ content: script })
    const result = await page.evaluate(async () => {
      const paste = (globalThis as any).__paste
      // Word-like bitmap: transparent background, opaque black "ink", one half-transparent edge pixel.
      const source = document.createElement("canvas")
      source.width = 4
      source.height = 1
      const ctx = source.getContext("2d")!
      ctx.clearRect(0, 0, 4, 1)
      ctx.fillStyle = "rgba(0,0,0,1)"
      ctx.fillRect(1, 0, 1, 1)
      ctx.fillStyle = "rgba(0,0,0,0.5)"
      ctx.fillRect(2, 0, 1, 1)
      const blob: Blob = await new Promise((resolve) => source.toBlob((b) => resolve(b!), "image/png"))
      const file = new File([blob], "image.png", { type: "image/png" })
      const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())

      const pixels = async (input: Blob) => {
        const bitmap = await createImageBitmap(input)
        const canvas = document.createElement("canvas")
        canvas.width = bitmap.width
        canvas.height = bitmap.height
        const c = canvas.getContext("2d")!
        c.drawImage(bitmap, 0, 0)
        return Array.from(c.getImageData(0, 0, bitmap.width, bitmap.height).data)
      }

      const errors: string[] = []
      const flat: File = await paste.flattenPastedImage(file, { onError: (e: unknown) => errors.push(String(e)) })
      return {
        hasAlpha: paste.imageHasAlpha(head),
        changed: flat !== file,
        type: flat.type,
        before: await pixels(file),
        after: await pixels(flat),
        errors,
      }
    })

    expect(result.errors).toEqual([])
    expect(result.hasAlpha).toBe(true)
    expect(result.changed).toBe(true)
    expect(result.type).toBe("image/png")
    // Before: pixel 0 fully transparent (what a provider reads as black).
    expect(result.before.slice(0, 4)).toEqual([0, 0, 0, 0])
    const px = (i: number) => result.after.slice(i * 4, i * 4 + 4)
    expect(px(0)).toEqual([255, 255, 255, 255])
    expect(px(1)).toEqual([0, 0, 0, 255])
    const half = px(2)
    expect(half[3]).toBe(255)
    expect(half[0]).toBeGreaterThan(110)
    expect(half[0]).toBeLessThan(145)
    expect(px(3)).toEqual([255, 255, 255, 255])
    for (let i = 3; i < result.after.length; i += 4) expect(result.after[i]).toBe(255)
  } finally {
    await browser.close()
  }
}, 60_000)
