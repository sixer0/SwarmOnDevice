// Shared clipboard rules for both prompt composers: the app's v1 handler
// (packages/app/src/components/prompt-input/attachments.ts) and the v2 handler beside this file.
// Swarm 1.2.7 item U-13, decisions U7 and C63 (D-13a-d).
//
// Why: MS Word puts text/plain, text/html AND a rendered image/png on the clipboard. Chromium exposes
// the image as an item of kind "file", and the old handlers took any file first, so long text from Word
// arrived as a picture. Word's picture is black text on a transparent background, which most vision
// providers read as black on black.
//
// Rules:
// - D-13a: when the clipboard carries non-empty plain text, the text is pasted and clipboard images are
//   not attached. An image is attached only when there is no text.
// - D-13b: plain text only; text/html is never read or inserted.
// - D-13c: a pasted PNG/WebP with an alpha channel is flattened onto white before it is attached.
// - Files copied in a file manager (a file item whose real path is known) stay attachments: such a copy
//   also carries the file name as text/plain, and pasting that name instead of the file would break
//   attaching copied files.

type ClipboardItemLike = { kind: string; getAsFile(): File | null }
type ClipboardLike = {
  getData(format: string): string
  items?: ArrayLike<ClipboardItemLike> | null
}

export type PromptPasteContent =
  | { kind: "text"; text: string }
  | { kind: "files"; files: File[] }
  | { kind: "empty" }

/** Decide what a paste carries. `pathOf` returns the file's real path for a copied file, "" otherwise. */
export function readPromptPaste(data: ClipboardLike, pathOf?: (file: File) => string): PromptPasteContent {
  const files = Array.from(data.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
  if (files.length > 0 && pathOf && files.some((file) => safePath(pathOf, file))) return { kind: "files", files }
  const text = data.getData("text/plain") ?? ""
  if (text.trim().length > 0) return { kind: "text", text }
  if (files.length > 0) return { kind: "files", files }
  if (text.length > 0) return { kind: "text", text }
  return { kind: "empty" }
}

function safePath(pathOf: (file: File) => string, file: File) {
  try {
    return !!pathOf(file)
  } catch {
    return false
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function ascii(bytes: Uint8Array, at: number, length: number) {
  return String.fromCharCode(...bytes.subarray(at, at + length))
}

function uint32be(bytes: Uint8Array, at: number) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0
}

/**
 * True when the image bytes declare an alpha channel: PNG colour type 4/6 or a tRNS chunk before the
 * first IDAT; WebP VP8X alpha flag or VP8L alpha_is_used bit. Other formats: false (JPEG has no alpha;
 * GIF is left alone so animations survive).
 */
export function imageHasAlpha(bytes: Uint8Array): boolean {
  if (bytes.length >= 33 && PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    const colorType = bytes[25]
    if (colorType === 4 || colorType === 6) return true
    let at = 8
    while (at + 8 <= bytes.length) {
      const length = uint32be(bytes, at)
      const type = ascii(bytes, at + 4, 4)
      if (type === "tRNS") return true
      if (type === "IDAT" || type === "IEND") return false
      at += 12 + length
    }
    return false
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const chunk = ascii(bytes, 12, 4)
    if (chunk === "VP8X") return (bytes[20] & 0x10) !== 0
    if (chunk === "VP8L" && bytes[20] === 0x2f) return ((bytes[24] >> 4) & 1) === 1
    return false
  }
  return false
}

type FlattenContext = {
  fillStyle: unknown
  fillRect(x: number, y: number, width: number, height: number): void
  drawImage(image: never, x: number, y: number): void
}

/** The canvas pieces flattening needs; injectable so tests can run without a rasterising canvas. */
export type PromptPasteRaster = {
  decode(file: File): Promise<{ width: number; height: number; image: unknown; close?: () => void }>
  surface(width: number, height: number): { context: FlattenContext | null; encode(): Promise<Blob | null> }
}

/** The renderer's canvas: OffscreenCanvas when present, else a DOM canvas. Undefined outside a renderer. */
export function browserPasteRaster(): PromptPasteRaster | undefined {
  if (typeof createImageBitmap !== "function") return
  if (typeof OffscreenCanvas !== "function" && typeof document === "undefined") return
  return {
    async decode(file) {
      const bitmap = await createImageBitmap(file)
      return { width: bitmap.width, height: bitmap.height, image: bitmap, close: () => bitmap.close() }
    },
    surface(width, height) {
      if (typeof OffscreenCanvas === "function") {
        const canvas = new OffscreenCanvas(width, height)
        return {
          context: canvas.getContext("2d") as unknown as FlattenContext | null,
          encode: () => canvas.convertToBlob({ type: "image/png" }),
        }
      }
      const canvas = document.createElement("canvas")
      canvas.width = width
      canvas.height = height
      return {
        context: canvas.getContext("2d") as unknown as FlattenContext | null,
        encode: () => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png")),
      }
    },
  }
}

const FLATTEN_MIMES = new Set(["image/png", "image/webp"])
// tRNS must precede IDAT and the WebP flags sit in the first chunk, so the head of the file is enough.
const HEADER_BYTES = 64 * 1024

/**
 * Returns the pasted image drawn onto an opaque white background (as PNG) when it has an alpha channel;
 * otherwise, or when the canvas is unavailable or fails, returns the file unchanged. `onError` receives
 * a failure so the caller can log it; the paste itself still goes through with the original file.
 */
export async function flattenPastedImage(
  file: File,
  options: { raster?: PromptPasteRaster | null; onError?: (error: unknown) => void } = {},
): Promise<File> {
  const mime = file.type.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  if (!FLATTEN_MIMES.has(mime)) return file
  const raster = options.raster === undefined ? browserPasteRaster() : options.raster
  if (!raster) return file
  try {
    const head = new Uint8Array(await file.slice(0, HEADER_BYTES).arrayBuffer())
    if (!imageHasAlpha(head)) return file
    const decoded = await raster.decode(file)
    try {
      if (!(decoded.width > 0 && decoded.height > 0)) return file
      const surface = raster.surface(decoded.width, decoded.height)
      if (!surface.context) return file
      surface.context.fillStyle = "#ffffff"
      surface.context.fillRect(0, 0, decoded.width, decoded.height)
      surface.context.drawImage(decoded.image as never, 0, 0)
      const blob = await surface.encode()
      if (!blob || blob.size === 0) return file
      return new File([blob], file.name || "image.png", { type: "image/png", lastModified: file.lastModified })
    } finally {
      decoded.close?.()
    }
  } catch (error) {
    options.onError?.(error)
    return file
  }
}
