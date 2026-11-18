// Static branch of the office bridge (row 48, plan M2-02; server-delta spec §9.1 stage 5 and §9.4; register rev 5
// §4 and §4.1; SEC SC-07, SC-41). `GET`/`HEAD` on `/` (302 to `/pane/index.html`) and `/pane/*` only, a realpath
// prefix check against the pane root, no directory listing, a fixed MIME map, and the pane CSP on every served file.
//
// Pure over a minimal request/response shape so server.ts (row 47) can mount it without this module knowing about
// node:http. The bridge runs in an Electron utility process (Node), so files are read with node:fs, not Bun.file.

import { readFile, realpath, stat } from "node:fs/promises"
import { extname, join, sep } from "node:path"
import { OFFICE_ERROR_ROUTE_NOT_ALLOWED, OFFICE_PANE_CSP, OFFICE_PATH_PANE, OFFICE_PATH_PANE_PAGE } from "@swarm/office-addin/constants"

/** The request fields the static branch reads. `url` is the raw request-target (path plus optional query). */
export type BridgeRequestLine = {
  method: string
  url: string
}

/** A complete response. `body` is null for `HEAD` and for the redirect. Header names are written as given. */
export type BridgeResponse = {
  status: number
  headers: Record<string, string>
  body: Uint8Array | null
}

/** The subset of node:http `ServerResponse` that `sendBridgeResponse` needs. */
export type BridgeResponseTarget = {
  writeHead(status: number, headers: Record<string, string>): unknown
  end(body?: Uint8Array): unknown
}

/** Register §4.1 / SD §9.3: the bridge's own headers on every non-static response (SSE overrides Cache-Control). */
export const BRIDGE_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Referrer-Policy": "no-referrer",
}

/**
 * Fixed MIME map (SD §9.4). An extension not listed here is never served (404), so no file is ever sent as a sniffable
 * or default type. Text types carry an explicit charset.
 */
const PANE_MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
}

/** `resourcesDir` holds `office-addin/pane/` (protocol.ts `BridgeStartConfig.resourcesDir`, register §3). */
export function paneRootFor(resourcesDir: string) {
  return join(resourcesDir, "office-addin", "pane")
}

/** Stage 5 test: `GET`/`HEAD` on `/` or under `/pane`. Anything else is not the static branch and goes on to stage 6. */
/** @internal test seam */
export function isStaticRequest(request: BridgeRequestLine) {
  if (request.method !== "GET" && request.method !== "HEAD") return false
  const path = pathOf(request.url)
  return path === "/" || path === OFFICE_PATH_PANE || path.startsWith(OFFICE_PATH_PANE + "/")
}

/**
 * Answer a static-branch request, or return null when the request is not one (the caller continues the pipeline).
 * Every failure inside the branch, traversal included, is `404 ROUTE_NOT_ALLOWED` with no detail about why.
 */
export async function serveStatic(request: BridgeRequestLine, paneRoot: string): Promise<BridgeResponse | null> {
  if (!isStaticRequest(request)) return null
  const path = pathOf(request.url)
  if (path === "/") return { status: 302, headers: { ...BRIDGE_SECURITY_HEADERS, Location: OFFICE_PATH_PANE_PAGE }, body: null }
  const segments = paneSegments(path)
  if (!segments) return notFound()
  const type = PANE_MIME_TYPES[extname(segments[segments.length - 1]).toLowerCase()]
  if (!type) return notFound()
  const file = await resolveInsideRoot(paneRoot, segments)
  if (!file) return notFound()
  const content = await readFile(file).catch(() => null)
  if (!content) return notFound()
  return {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(content.byteLength),
      "Content-Security-Policy": OFFICE_PANE_CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
    body: request.method === "HEAD" ? null : new Uint8Array(content.buffer, content.byteOffset, content.byteLength),
  }
}

/** `{ "error": "<CODE>" }` (register §7.6) with the security headers and a computed Content-Length. */
export function errorResponse(status: number, code: string): BridgeResponse {
  return jsonResponse(status, { error: code })
}

export function jsonResponse(status: number, value: unknown): BridgeResponse {
  const body = new TextEncoder().encode(JSON.stringify(value))
  return {
    status,
    headers: {
      ...BRIDGE_SECURITY_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": String(body.byteLength),
    },
    body,
  }
}

/** Write a `BridgeResponse` to a node:http response. */
export function sendBridgeResponse(target: BridgeResponseTarget, response: BridgeResponse) {
  target.writeHead(response.status, response.headers)
  if (response.body) return target.end(response.body)
  return target.end()
}

function notFound() {
  return errorResponse(404, OFFICE_ERROR_ROUTE_NOT_ALLOWED)
}

/** Path part of an origin-form request-target. An absolute-form or empty target never matches the static branch. */
function pathOf(url: string) {
  if (!url.startsWith("/")) return ""
  return url.split(/[?#]/, 1)[0]
}

/**
 * Decoded segments below `/pane/`, or null when the path is not a plain file path: empty segments (`//`, trailing `/`,
 * `/pane` itself: no listing), dot segments, dot files, or any segment that holds `/`, `\`, NUL or a control
 * character once decoded (catches `%2e%2e`, `%2f`, `%5c`, `%00`). A malformed escape is rejected too.
 */
function paneSegments(path: string) {
  if (!path.startsWith(OFFICE_PATH_PANE + "/")) return null
  const raw = path.slice(OFFICE_PATH_PANE.length + 1).split("/")
  const decoded = raw.map(decodeSegment)
  if (decoded.some((segment) => segment === null || !isPlainSegment(segment))) return null
  return decoded.filter((segment): segment is string => segment !== null)
}

function decodeSegment(segment: string) {
  // decodeURIComponent throws on a malformed escape such as `%E0%A4%A`; that is a 404, not an error.
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function isPlainSegment(segment: string) {
  if (segment === "" || segment.startsWith(".")) return false
  return !/[/\\\u0000-\u001f\u007f]/.test(segment)
}

/** Realpath of root and file, then a prefix check, then a regular-file check. Any failure gives null. */
async function resolveInsideRoot(paneRoot: string, segments: string[]) {
  const root = await realpath(paneRoot).catch(() => null)
  if (!root) return null
  const file = await realpath(join(root, ...segments)).catch(() => null)
  if (!file || !file.startsWith(root + sep)) return null
  const info = await stat(file).catch(() => null)
  if (!info || !info.isFile()) return null
  return file
}
