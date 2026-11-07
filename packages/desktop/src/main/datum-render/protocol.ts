// DATUM render bridge: wire protocol and request validation (row 24, runtime spec §3.2, studio spec §4).
//
// One request per line, UTF-8 JSON, over the Unix socket named by DATUM_RENDER_SOCKET:
//   {"token":"<DATUM_RENDER_TOKEN>","id":"<optional>","op":"png",...}
// One response per line:
//   {"id":...,"ok":true,...result}            or
//   {"id":...,"ok":false,"code":"<CODE>","message":"<text>"}
// This file is pure (no Electron, no fs) so it can be unit-tested under bun.

export const MAX_LINE_BYTES = 24 * 1024 * 1024
export const MAX_INPUT_BYTES = 16 * 1024 * 1024
export const MAX_SCRIPT_BYTES = 256 * 1024
export const MAX_PX = 16384
export const MAX_MM = 5000

export type PngRequest = { op: "png"; src: string; dst: string; width: number; height?: number }
export type PdfRequest = {
  op: "pdf"
  src: string
  dst: string
  widthMm?: number
  heightMm?: number
  preferCSSPageSize?: boolean
}
export type CheckPageRequest = {
  op: "checkPage"
  html?: string
  src?: string
  wMm: number
  hMm: number
  script: string
  arg?: unknown
  viewportWidth?: number
  viewportHeight?: number
}
export type HelloRequest = { op: "hello" }
export type RenderRequest = PngRequest | PdfRequest | CheckPageRequest | HelloRequest

export type BridgeErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "UNKNOWN_OP"
  | "PATH_REFUSED"
  | "INPUT_TOO_LARGE"
  | "SVG_INVALID"
  | "SCRIPT_NOT_ALLOWED"
  | "FONTS_MISSING"
  | "RENDER_FAILED"
  | "RENDER_TIMEOUT"
  | "LINE_TOO_LONG"

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message)
    this.name = "BridgeError"
  }
}

const ALLOWED_KEYS: Record<RenderRequest["op"], readonly string[]> = {
  png: ["op", "src", "dst", "width", "height"],
  pdf: ["op", "src", "dst", "widthMm", "heightMm", "preferCSSPageSize"],
  // width/height: viewport px as sent by the row 106 shim (render.py:166 new_page viewport); alias of viewport*.
  checkPage: ["op", "html", "src", "wMm", "hMm", "script", "arg", "viewportWidth", "viewportHeight", "width", "height"],
  hello: ["op"],
}

const ENVELOPE_KEYS = ["token", "id"]

function bad(message: string): never {
  throw new BridgeError("BAD_REQUEST", message)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function str(o: Record<string, unknown>, key: string, required: true): string
function str(o: Record<string, unknown>, key: string, required: false): string | undefined
function str(o: Record<string, unknown>, key: string, required: boolean) {
  const v = o[key]
  if (v === undefined && !required) return undefined
  if (typeof v !== "string" || v.length === 0) bad(`${key} must be a non-empty string`)
  return v
}

function int(o: Record<string, unknown>, key: string, max: number, required: boolean) {
  const v = o[key]
  if (v === undefined && !required) return undefined
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > max) bad(`${key} must be an integer 1..${max}`)
  return v
}

function mm(o: Record<string, unknown>, key: string, required: boolean) {
  const v = o[key]
  if (v === undefined && !required) return undefined
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > MAX_MM) bad(`${key} must be a number in (0, ${MAX_MM}]`)
  return v
}

function hasExt(p: string, exts: readonly string[]) {
  const lower = p.toLowerCase()
  return exts.some((e) => lower.endsWith(e))
}

export const SVG_EXT = [".svg"] as const
export const HTML_EXT = [".html", ".htm"] as const

/** Validate the op-specific part of a request. Path reach is checked later (paths.ts). */
export function validateRequest(raw: unknown): RenderRequest {
  if (!isRecord(raw)) bad("request must be a JSON object")
  const op = raw.op
  if (typeof op !== "string" || !(op in ALLOWED_KEYS)) {
    throw new BridgeError("UNKNOWN_OP", `unknown op ${JSON.stringify(op)}`)
  }
  const allowed = ALLOWED_KEYS[op as RenderRequest["op"]]
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key) && !ENVELOPE_KEYS.includes(key)) bad(`unknown field ${key} for op ${op}`)
  }

  if (op === "hello") return { op }

  if (op === "png") {
    const src = str(raw, "src", true)
    const dst = str(raw, "dst", true)
    if (!hasExt(src, SVG_EXT)) bad("png src must end .svg")
    if (!hasExt(dst, [".png"])) bad("png dst must end .png")
    const width = int(raw, "width", MAX_PX, true)!
    const height = int(raw, "height", MAX_PX, false)
    return height === undefined ? { op, src, dst, width } : { op, src, dst, width, height }
  }

  if (op === "pdf") {
    const src = str(raw, "src", true)
    const dst = str(raw, "dst", true)
    if (!hasExt(src, [...SVG_EXT, ...HTML_EXT])) bad("pdf src must end .svg, .html or .htm")
    if (!hasExt(dst, [".pdf"])) bad("pdf dst must end .pdf")
    const widthMm = mm(raw, "widthMm", false)
    const heightMm = mm(raw, "heightMm", false)
    if ((widthMm === undefined) !== (heightMm === undefined)) bad("widthMm and heightMm go together")
    const pref = raw.preferCSSPageSize
    if (pref !== undefined && typeof pref !== "boolean") bad("preferCSSPageSize must be boolean")
    const out: PdfRequest = { op, src, dst }
    if (widthMm !== undefined) Object.assign(out, { widthMm, heightMm })
    if (pref !== undefined) out.preferCSSPageSize = pref
    return out
  }

  // checkPage
  // Row 106 shim compatibility: it sends `html` as the absolute path of the page file
  // (render.py goto target). A value that is an absolute .html/.htm path with no markup is a path.
  let html = raw.html
  let src = str(raw, "src", false)
  if (typeof html === "string" && looksLikeHtmlPath(html)) {
    if (src !== undefined) bad("checkPage takes html or src, not both")
    src = html
    html = undefined
  }
  for (const k of ["width", "height", "viewportWidth", "viewportHeight"]) if (raw[k] === null) delete raw[k]
  if (raw.width !== undefined || raw.height !== undefined) {
    if (raw.viewportWidth !== undefined || raw.viewportHeight !== undefined) bad("use width/height or viewportWidth/viewportHeight, not both")
    raw.viewportWidth = raw.width
    raw.viewportHeight = raw.height
  }
  if (html !== undefined && src !== undefined) bad("checkPage takes html or src, not both")
  if (html === undefined && src === undefined) bad("checkPage needs html or src")
  if (html !== undefined && (typeof html !== "string" || html.length === 0)) bad("html must be a non-empty string")
  if (typeof html === "string" && Buffer.byteLength(html, "utf8") > MAX_INPUT_BYTES) {
    throw new BridgeError("INPUT_TOO_LARGE", "html is larger than the input cap")
  }
  if (src !== undefined && !hasExt(src, HTML_EXT)) bad("checkPage src must end .html or .htm")
  const script = str(raw, "script", true)
  if (Buffer.byteLength(script, "utf8") > MAX_SCRIPT_BYTES) bad("script is larger than the script cap")
  const wMm = mm(raw, "wMm", true)!
  const hMm = mm(raw, "hMm", true)!
  const viewportWidth = int(raw, "viewportWidth", MAX_PX, false)
  const viewportHeight = int(raw, "viewportHeight", MAX_PX, false)
  if ((viewportWidth === undefined) !== (viewportHeight === undefined)) bad("viewportWidth and viewportHeight go together")
  const out: CheckPageRequest = { op: "checkPage", wMm, hMm, script }
  if (typeof html === "string") out.html = html
  if (src !== undefined) out.src = src
  if (raw.arg !== undefined) out.arg = raw.arg
  if (viewportWidth !== undefined) Object.assign(out, { viewportWidth, viewportHeight })
  return out
}

function looksLikeHtmlPath(v: string) {
  return v.startsWith("/") && !/[<>\n\r]/.test(v) && hasExt(v, HTML_EXT)
}

export type Envelope = { id?: string | number; token: string; body: unknown }

/** Parse one line into its envelope. Throws BridgeError on malformed input. */
export function parseLine(line: string): Envelope {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    bad("line is not valid JSON")
  }
  if (!isRecord(raw)) bad("request must be a JSON object")
  const id = raw.id
  if (id !== undefined && !(typeof id === "number" && Number.isFinite(id)) && !(typeof id === "string" && id.length <= 64)) {
    bad("id must be a number or a string of at most 64 chars")
  }
  const token = typeof raw.token === "string" ? raw.token : ""
  return { id: id as string | number | undefined, token, body: raw }
}

export function errorResponse(id: string | number | undefined, error: unknown) {
  // `error` is the field the row 106 shim reads; `code`/`message` are for Studio's twins.
  if (error instanceof BridgeError) return { id, ok: false as const, code: error.code, message: error.message, error: error.message }
  return { id, ok: false as const, code: "RENDER_FAILED" as const, message: "render failed", error: "render failed" }
}
