// Row 112 of docs/2026-11-06_swarm_1_2_0_datum_installer (studio spec §8.2, decision U12): the rules behind the
// document preview shown inside the EXISTING file tab. Pure helpers only, so every rule is unit-tested without a
// renderer. The component that uses them is ./file-preview.tsx.
//
// Where the bytes come from: the file tab already reads files through `client.file.read` -> GET /file/content,
// whose FileSystem.read resolves the path against the session root and refuses anything whose realpath leaves it
// (packages/core/src/filesystem.ts:65-72). The preview adds no new way to read a file; it only renders what the tab
// already holds. `isPreviewPathAllowed` is a second, client-side check on the tab path itself.

export type PreviewKind = "pdf" | "html" | "docx" | "office"

const OFFICE_EXTENSIONS = new Set(["xlsx", "pptx"])

function extensionOf(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1)
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return ""
  return name.slice(dot + 1).toLowerCase()
}

/** The preview kind for a tab path, or undefined when the file keeps the existing text/media view (P3). */
export function previewKindFromPath(path: string | undefined): PreviewKind | undefined {
  if (!path) return
  const ext = extensionOf(path)
  if (ext === "pdf") return "pdf"
  if (ext === "html" || ext === "htm") return "html"
  if (ext === "docx") return "docx"
  if (OFFICE_EXTENSIONS.has(ext)) return "office"
}

/**
 * Studio's final output name, C51 (`<docNumberSafe>_rev<n>_<YYYYMMDDTHHMMSSZ>_<sha8>.<ext>`), copied verbatim from
 * packages/datum-studio/vendor/src/lib/studio/contract/env.ts `FINAL_FILENAME_PATTERN` (a unit test pins the copy).
 * Template previews use the same pattern (`GSP-Pratinjau-Templat_rev0_<ts>_<sha8>.<ext>`, storage/files.ts:117-118).
 */
export const STUDIO_FINAL_NAME_PATTERN =
  "^([A-Za-z0-9](?:[A-Za-z0-9.-]{0,78}[A-Za-z0-9])?)_rev(0|[1-9][0-9]{0,5})_([0-9]{8}T[0-9]{6}Z)_([0-9a-f]{8})\\.(docx|pdf|html|svg|png)$"
const STUDIO_FINAL_NAME = new RegExp(STUDIO_FINAL_NAME_PATTERN)

/**
 * Row 165D (F56-2, CP-17): the DATUM title name Studio now delivers outputs under (`<Judul> <nomor> Rev<X>.<ext>`,
 * `<Judul> <YYYY-MM-DD>.<ext>`, `Gambar <C.n> <Judul>.<ext>`, optional ` <sha8>` collision suffix; no `_`), copied
 * verbatim from packages/datum-studio/vendor/src/lib/studio/contract/env.ts `DATUM_FILENAME_PATTERN` (a unit test pins
 * the copy). One path segment only: separators, control/bidi characters and a leading dot or space never match.
 * Row 165I (C196, L2): C1 controls, ALM, zero-width, LS/PS, WJ and BOM never match either (same rule as Studio).
 */
export const STUDIO_DATUM_NAME_PATTERN =
  "^(?=[^\\u0000-\\u001f]{1,255}$)(?![ .])(?:(?:[^\\u0000-\\u001f\\u007f<>:\"/\\\\|?*_\\u0080-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff]+ )?(?:[0-9A-Za-z][0-9A-Za-z.-]* Rev[0-9A-Za-z]{1,8}|[0-9]{4}-[0-9]{2}-[0-9]{2})|(?:Gambar|Figure) [0-9A-Za-z]+(?:\\.[0-9A-Za-z]+)* [^\\u0000-\\u001f\\u007f<>:\"/\\\\|?*_\\u0080-\\u009f\\u061c\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\ufeff]+)(?: (?:[0-9a-f]{8}|[0-9a-f]{16}|[0-9a-f]{64}))?\\.(docx|pdf|html|svg|png)$"
const STUDIO_DATUM_NAME = new RegExp(STUDIO_DATUM_NAME_PATTERN)

/** Row 165D: a Studio output file name, final (C51) or delivered DATUM title name. */
export function isStudioOutputName(name: string | undefined) {
  if (!name) return false
  return STUDIO_FINAL_NAME.test(name) || STUDIO_DATUM_NAME.test(name)
}

/**
 * Row 112b (decision C101): whether a tab path is a Studio output. Only a Studio output `.html` opens rendered by
 * default; any other `.html` opens as code (the behaviour before row 112) with the preview toggle. PDF, DOCX, XLSX and
 * PPTX do not depend on this.
 * - The C51 store name (`<nomor>_rev<n>_<ts>Z_<sha8>`) is decided by FILE NAME alone, in any folder, as before: no
 *   ordinary user file is named like that.
 * - Row 165E (C192, security narrowing): a DATUM title name (`<Judul> <nomor> RevA.html`, `<Judul> 2026-11-02.html`,
 *   `Gambar 4.1 <Judul>.svg`) looks like a name a person would give a file, so the name alone never decides. It counts
 *   only when the exact path is in `registered`: the project paths of the session's Studio deliverables (the store's
 *   delivered `fileName` found in docs/<mission>/, see ./studio-output-registry.ts). An ordinary user
 *   `Laporan 2026-11-02.html` stays code view.
 */
export function isStudioOutputPath(path: string | undefined, registered: ReadonlySet<string> = NO_REGISTERED_OUTPUTS) {
  if (!path) return false
  const name = fileNameOf(path)
  if (STUDIO_FINAL_NAME.test(name)) return true
  return STUDIO_DATUM_NAME.test(name) && registered.has(path)
}
const NO_REGISTERED_OUTPUTS: ReadonlySet<string> = new Set()

/**
 * Client-side guard: a tab path is previewed only when it is relative to the session root and never climbs out of it.
 * Absolute paths, `..` segments, backslash tricks, NUL and URL schemes are refused. The server's realpath check
 * (packages/core/src/filesystem.ts:65-72) stays the authority for symlinks.
 */
export function isPreviewPathAllowed(path: string | undefined): path is string {
  if (!path || path.length > 4096) return false
  if (path.includes("\0") || path.includes("\\")) return false
  if (path.startsWith("/") || path.startsWith("~")) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path)) return false
  return path.split("/").every((segment) => segment !== "..")
}

/** Same-stem companions of a `.docx`, in the order spec §8.2 prefers them: `.pdf` first, then `.html`. */
export function companionCandidates(path: string): string[] {
  if (previewKindFromPath(path) !== "docx") return []
  const stem = path.slice(0, path.length - ".docx".length)
  return [`${stem}.pdf`, `${stem}.html`]
}

export function fileNameOf(path: string) {
  return path.slice(path.lastIndexOf("/") + 1)
}

type ContentLike = { type?: unknown; content?: unknown; encoding?: unknown; mimeType?: unknown } | undefined

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const raw = atob(value)
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  } catch {
    return
  }
}

/** PDF bytes from the tab's FileContent: binary, base64, and starting with `%PDF-`. Anything else is not a PDF. */
export function pdfBytesFromContent(content: ContentLike): Uint8Array | undefined {
  if (!content || content.type !== "binary" || content.encoding !== "base64") return
  if (typeof content.content !== "string" || content.content.length === 0) return
  const bytes = decodeBase64(content.content)
  if (!bytes || bytes.length < 5) return
  if (String.fromCharCode(...bytes.subarray(0, 5)) !== "%PDF-") return
  return bytes
}

/** HTML text from the tab's FileContent (the server returns valid UTF-8 as text). */
export function htmlTextFromContent(content: ContentLike): string | undefined {
  if (!content || content.type !== "text" || typeof content.content !== "string") return
  if (content.content.trim().length === 0) return
  return content.content
}

/**
 * Page count of a PDF: the largest `/Type /Pages ... /Count n` (page tree root), else the number of `/Type /Page`
 * objects. The same rule as Studio's render/pdf.ts `countPdfPages`
 * (packages/datum-studio/vendor/src/lib/studio/services/render/pdf.ts:50-58), so the count the tab reports for a
 * Studio PDF equals the count Studio recorded when it rendered it (P1).
 */
export function countPdfPages(pdf: Uint8Array): number {
  let s = ""
  const CHUNK = 0x8000
  for (let i = 0; i < pdf.length; i += CHUNK) s += String.fromCharCode(...pdf.subarray(i, i + CHUNK))
  let max = 0
  for (const m of s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g)) {
    max = Math.max(max, Number(m[1] ?? m[2]))
  }
  if (max > 0) return max
  return (s.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length
}

type ObjectUrlApi = { createObjectURL(blob: Blob): string; revokeObjectURL(url: string): void }

/**
 * A `blob:` URL for the PDF bytes, for Chromium's built-in viewer in an `<iframe>`. The caller revokes it when the
 * tab closes or the bytes change (P7); `revoke` is idempotent.
 */
export function createPdfObjectUrl(bytes: Uint8Array, api: ObjectUrlApi = URL) {
  const copy = new Uint8Array(bytes.length)
  copy.set(bytes)
  const url = api.createObjectURL(new Blob([copy.buffer], { type: "application/pdf" }))
  let revoked = false
  return {
    url,
    revoke() {
      if (revoked) return
      revoked = true
      api.revokeObjectURL(url)
    },
  }
}

/** The policy injected into every HTML preview (spec §8.2): nothing loads but inline styles and data: images/fonts. */
export const PREVIEW_HTML_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"

/** `sandbox=""`: no scripts, no same-origin, no forms, no popups, no top navigation. Never widened. */
export const PREVIEW_HTML_SANDBOX = ""

// Elements that execute, embed another document, or can fetch or navigate outside the CSP's reach
// (`<link rel=dns-prefetch|preconnect|prefetch>` is not governed by CSP; `<meta http-equiv=refresh>` navigates).
// Forms stay (their content is document text): the sandbox blocks submission and their URL attributes are dropped.
const REMOVED_ELEMENTS = [
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "portal",
  "link",
  "base",
  "meta[http-equiv]",
]
const URL_ATTRIBUTES = ["href", "xlink:href", "action", "formaction", "ping", "src", "srcset", "poster", "background"]

function keepsUrl(element: Element, attr: string, value: string) {
  const v = value.trim()
  // In-document anchors stay clickable; they navigate nowhere.
  if ((attr === "href" || attr === "xlink:href") && v.startsWith("#")) return true
  // Embedded images and fonts (Studio inlines its assets as data: URIs) stay; the CSP still limits them.
  if ((attr === "src" || attr === "xlink:href" || attr === "href") && /^data:image\//i.test(v)) {
    return element.localName === "img" || element.localName === "image" || element.localName === "use"
  }
  return false
}

/**
 * The `srcdoc` for an HTML preview. Defence in depth around the sandbox and the CSP:
 * - scripts, frames, embeds, links, base and every http-equiv meta (refresh, a second CSP) are removed;
 * - every `on*` handler and `javascript:` value is dropped;
 * - every navigating or fetching URL attribute is dropped, except in-document `#anchors` and `data:image/` sources,
 *   so a click on a link inside the preview navigates nowhere (P6) and nothing reaches the network (P2);
 * - the CSP meta is the first element of `<head>`.
 * DOMParser documents never run scripts, so parsing the untrusted HTML here is inert.
 */
export function buildHtmlPreviewDocument(html: string, parser: DOMParser = new DOMParser()): string {
  const doc = parser.parseFromString(html, "text/html")
  for (const selector of REMOVED_ELEMENTS) for (const node of Array.from(doc.querySelectorAll(selector))) node.remove()
  for (const element of Array.from(doc.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase()
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name)
        continue
      }
      if (/^\s*(javascript|vbscript):/i.test(attr.value)) {
        element.removeAttribute(attr.name)
        continue
      }
      if (URL_ATTRIBUTES.includes(name) && !keepsUrl(element, name, attr.value)) element.removeAttribute(attr.name)
    }
    // Inline styles may not fetch: url(...) other than data: is cut (the CSP would block it too).
    const style = element.getAttribute("style")
    if (style && /url\s*\(/i.test(style)) element.setAttribute("style", stripCssUrls(style))
  }
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    const text = style.textContent ?? ""
    if (/url\s*\(|@import/i.test(text)) style.textContent = stripCssUrls(text)
  }
  const meta = doc.createElement("meta")
  meta.setAttribute("http-equiv", "Content-Security-Policy")
  meta.setAttribute("content", PREVIEW_HTML_CSP)
  doc.head.insertBefore(meta, doc.head.firstChild)
  const referrer = doc.createElement("meta")
  referrer.setAttribute("name", "referrer")
  referrer.setAttribute("content", "no-referrer")
  meta.after(referrer)
  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`
}

/** Cuts `@import` rules and every `url(...)` that is not a `data:` URI out of CSS text. */
export function stripCssUrls(css: string) {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (whole, _quote: string, value: string) =>
      /^data:/i.test(value.trim()) ? whole : "none",
    )
}
