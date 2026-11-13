// Swarm 1.2.7 U-13 (C63 D-13a-d): unit tests of the shared paste helper. The flatten test drives an
// injected raster (bun has no rasterising canvas); the real pixel check runs in Chromium:
// packages/app/test-browser/rel127-u13-flatten-pixel.test.ts.
import { describe, expect, test } from "bun:test"
import { flattenPastedImage, imageHasAlpha, readPromptPaste, type PromptPasteRaster } from "./paste-source"

function pngHeader(colorType: number, extra: number[][] = []) {
  const ihdr = [0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 2, 8, colorType, 0, 0, 0, 0, 0, 0, 0]
  const idat = [0, 0, 0, 0, 73, 68, 65, 84, 0, 0, 0, 0]
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...ihdr, ...extra.flat(), ...idat])
}
const trns = [0, 0, 0, 1, 116, 82, 78, 83, 0, 0, 0, 0, 0]

function clipboard(text: string, files: File[]) {
  return {
    getData: (format: string) => (format === "text/plain" ? text : format === "text/html" ? "<b>x</b>" : ""),
    items: [
      ...(text ? [{ kind: "string", getAsFile: () => null }] : []),
      ...files.map((file) => ({ kind: "file", getAsFile: () => file })),
    ],
  }
}

describe("readPromptPaste", () => {
  const image = new File([pngHeader(6)], "image.png", { type: "image/png" })

  test("plain text wins over an anonymous clipboard image (Word)", () => {
    expect(readPromptPaste(clipboard("long text", [image]))).toEqual({ kind: "text", text: "long text" })
  })

  test("image only: attached", () => {
    expect(readPromptPaste(clipboard("", [image]))).toEqual({ kind: "files", files: [image] })
  })

  test("whitespace-only text does not hide an image", () => {
    expect(readPromptPaste(clipboard(" \n", [image]))).toEqual({ kind: "files", files: [image] })
  })

  test("a file copied in a file manager stays an attachment even though its name is the text", () => {
    const copied = new File(["x"], "report.pdf", { type: "application/pdf" })
    const result = readPromptPaste(clipboard("report.pdf", [copied]), (file) => (file === copied ? "/tmp/report.pdf" : ""))
    expect(result).toEqual({ kind: "files", files: [copied] })
  })

  test("nothing: empty", () => {
    expect(readPromptPaste(clipboard("", []))).toEqual({ kind: "empty" })
  })
})

describe("imageHasAlpha", () => {
  test("PNG colour types", () => {
    expect(imageHasAlpha(pngHeader(6))).toBe(true)
    expect(imageHasAlpha(pngHeader(4))).toBe(true)
    expect(imageHasAlpha(pngHeader(2))).toBe(false)
    expect(imageHasAlpha(pngHeader(3, [trns]))).toBe(true)
    expect(imageHasAlpha(pngHeader(3))).toBe(false)
  })

  test("WebP VP8X alpha flag and VP8L alpha bit", () => {
    const riff = (chunk: string, bytes: number[]) =>
      Uint8Array.from([..."RIFF"].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [..."WEBP" + chunk].map((c) => c.charCodeAt(0)), bytes))
    const pad = (values: number[]) => values.concat(new Array(20).fill(0))
    expect(imageHasAlpha(riff("VP8X", pad([10, 0, 0, 0, 0x10])))).toBe(true)
    expect(imageHasAlpha(riff("VP8X", pad([10, 0, 0, 0, 0x00])))).toBe(false)
    expect(imageHasAlpha(riff("VP8L", pad([5, 0, 0, 0, 0x2f, 0, 0, 0, 0x10])))).toBe(true)
    expect(imageHasAlpha(riff("VP8L", pad([5, 0, 0, 0, 0x2f, 0, 0, 0, 0x00])))).toBe(false)
  })

  test("JPEG and junk: false", () => {
    expect(imageHasAlpha(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0))).toBe(false)
    expect(imageHasAlpha(new Uint8Array(0))).toBe(false)
  })
})

function fakeRaster() {
  const calls: string[] = []
  const context = {
    fillStyle: "" as unknown,
    fillRect: (x: number, y: number, w: number, h: number) => calls.push(`fill ${context.fillStyle} ${x},${y},${w},${h}`),
    drawImage: (_image: never, x: number, y: number) => calls.push(`draw ${x},${y}`),
  }
  const raster: PromptPasteRaster = {
    decode: async () => ({ width: 2, height: 2, image: {}, close: () => calls.push("close") }),
    surface: () => ({ context, encode: async () => new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" }) }),
  }
  return { raster, calls }
}

describe("flattenPastedImage", () => {
  test("an image with alpha is painted on white first, then drawn, and re-encoded as PNG", async () => {
    const { raster, calls } = fakeRaster()
    const file = new File([pngHeader(6)], "image.png", { type: "image/png" })
    const result = await flattenPastedImage(file, { raster })
    expect(calls).toEqual(["fill #ffffff 0,0,2,2", "draw 0,0", "close"])
    expect(result).not.toBe(file)
    expect(result.type).toBe("image/png")
    expect(result.name).toBe("image.png")
    expect(Array.from(new Uint8Array(await result.arrayBuffer()))).toEqual([1, 2, 3])
  })

  test("an image without alpha is returned unchanged and never drawn", async () => {
    const { raster, calls } = fakeRaster()
    const file = new File([pngHeader(2)], "image.png", { type: "image/png" })
    expect(await flattenPastedImage(file, { raster })).toBe(file)
    expect(calls).toEqual([])
  })

  test("JPEG and GIF are never touched", async () => {
    const { raster, calls } = fakeRaster()
    const jpeg = new File([Uint8Array.of(0xff, 0xd8)], "a.jpg", { type: "image/jpeg" })
    expect(await flattenPastedImage(jpeg, { raster })).toBe(jpeg)
    expect(calls).toEqual([])
  })

  test("no canvas or a failing canvas keeps the original and reports the error", async () => {
    const file = new File([pngHeader(6)], "image.png", { type: "image/png" })
    expect(await flattenPastedImage(file, { raster: null })).toBe(file)
    const errors: unknown[] = []
    const broken: PromptPasteRaster = {
      decode: async () => {
        throw new Error("decode failed")
      },
      surface: () => ({ context: null, encode: async () => null }),
    }
    expect(await flattenPastedImage(file, { raster: broken, onError: (error) => errors.push(error) })).toBe(file)
    expect(errors).toHaveLength(1)
  })
})
