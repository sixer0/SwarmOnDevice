/**
 * Row 150 (spec masterplan/01_specs_output_verification.md §3.5, §3.6): browser-free scans of a stored Studio output.
 *
 * Reads only what the Studio engine itself writes, by its own markers:
 * - HTML placeholders: class `st-slot-empty` (unit) and `st-placeholder` (its text), both carrying `data-slot-key`
 *   (V/engine/html/assemble/classes.ts:33, :35; slots.ts:173-184, :196-197).
 * - HTML figures: `<figure class="st-figure ..." data-block-id data-block-type data-figure data-graphic-source>`
 *   (V/engine/html/tables/figure.ts:217-227). A figure the FigureStore did not hold is drawn as a labelled
 *   `div.st-figure-missing` with no `svg`/`img` (figure.ts:160-178).
 * - DOCX placeholders: a paragraph border `w:val="dashed"` with `w:color="B45309"`
 *   (V/engine/docx/blocks/source-register.ts:33-34, :81-90; written by docx/package/xml.ts:242-246).
 *
 * Not a general HTML or XML parser: it understands the engine's own double-quoted attribute output. Inline SVGs are
 * cut out with the engine's own `extractInlineSvgs` (V/engine/lint/render/svg.ts:575), not a copy.
 * Everything taken from the document (labels, slot keys, text) is untrusted and is cut to SCAN_TEXT_MAX characters.
 */
import { strFromU8, unzipSync } from "fflate"
import { extractInlineSvgs } from "../../../vendor/src/lib/studio/engine/lint/render/svg"

/** Longest document-derived string kept in a finding. */
export const SCAN_TEXT_MAX = 200

/** Figure block types rendered by `renderFigureBlock` (figure.ts:205, :221). */
export const FIGURE_BLOCK_TYPES = ["chart", "diagram", "symbolSheet", "image"] as const
export type FigureBlockType = (typeof FIGURE_BLOCK_TYPES)[number]

export function clip(s: string | null | undefined): string | null {
  if (typeof s !== "string" || s === "") return null
  return s.length > SCAN_TEXT_MAX ? `${s.slice(0, SCAN_TEXT_MAX - 1)}…` : s
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" }
function unescAttr(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, k: string) => ENTITIES[k] ?? "")
}

/** Double-quoted attributes of one opening tag (the engine escapes `"` inside values). */
export function tagAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)="([^"]*)"/g
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1]] = unescAttr(m[2])
  return out
}

/** Markup without `<style>`, `<script>` and comments, so CSS selectors such as `.st-placeholder` are never read as elements. */
export function stripNonMarkup(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
}

function hasClass(attrs: Record<string, string>, cls: string): boolean {
  const c = attrs.class
  return typeof c === "string" && c.split(/\s+/).includes(cls)
}

export interface HtmlPlaceholder {
  /** `data-slot-key` of the unit or the placeholder text block; null when absent. */
  slotKey: string | null
  address: string | null
  /** Which engine marker was found: the unit class, the text class, or both for one slot. */
  marker: "st-slot-empty" | "st-placeholder" | "both"
}

/**
 * Placeholders left in an HTML output. One entry per slot key (a placeholder unit holds a placeholder text block for
 * the same slot, slots.ts:178 + :197; they are one finding, not two). Markers without a slot key are listed each.
 */
export function findHtmlPlaceholders(html: string): HtmlPlaceholder[] {
  const src = stripNonMarkup(html)
  const bySlot = new Map<string, HtmlPlaceholder>()
  const loose: HtmlPlaceholder[] = []
  const re = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const attrs = tagAttrs(m[2])
    const unit = hasClass(attrs, "st-slot-empty")
    const text = hasClass(attrs, "st-placeholder")
    if (!unit && !text) continue
    const marker: HtmlPlaceholder["marker"] = unit && text ? "both" : unit ? "st-slot-empty" : "st-placeholder"
    const slotKey = attrs["data-slot-key"] || null
    const address = attrs["data-address"] || null
    if (!slotKey) {
      loose.push({ slotKey: null, address, marker })
      continue
    }
    const seen = bySlot.get(slotKey)
    if (!seen) bySlot.set(slotKey, { slotKey, address, marker })
    else if (seen.marker !== marker) seen.marker = "both"
  }
  return [...bySlot.values(), ...loose]
}

export interface HtmlFigure {
  type: FigureBlockType
  blockId: string | null
  address: string | null
  /** `data-figure`: the artifact label (or block id). Document-derived. */
  label: string | null
  /** `data-graphic-source` (figure.ts:223): store / symbols / asset / missing ... */
  graphicSource: string | null
  /** Inline SVGs of the figure, in order (symbol sheets may have several). */
  svgs: string[]
  hasImg: boolean
}

const FIGURE_TYPE_SET: ReadonlySet<string> = new Set(FIGURE_BLOCK_TYPES)

/** Figure blocks of an HTML output, in document order. `<figure>` does not nest in Studio markup. */
export function findHtmlFigures(html: string): HtmlFigure[] {
  const src = stripNonMarkup(html)
  const out: HtmlFigure[] = []
  const open = /<figure\b([^>]*)>/gi
  for (let m = open.exec(src); m; m = open.exec(src)) {
    const attrs = tagAttrs(m[1])
    const type = attrs["data-block-type"]
    if (!type || !FIGURE_TYPE_SET.has(type)) continue
    const start = open.lastIndex
    const end = src.indexOf("</figure>", start)
    const inner = src.slice(start, end < 0 ? src.length : end)
    out.push({
      type: type as FigureBlockType,
      blockId: attrs["data-block-id"] || null,
      address: attrs["data-address"] || null,
      label: attrs["data-figure"] || null,
      graphicSource: attrs["data-graphic-source"] || null,
      svgs: extractInlineSvgs(inner),
      hasImg: /<img\b/i.test(inner),
    })
    if (end >= 0) open.lastIndex = end
  }
  return out
}

export interface DocxPlaceholder {
  /** 1-based index of the paragraph among the body paragraphs of word/document.xml. */
  paragraph: number
  /** Paragraph text (w:t), document-derived. */
  text: string | null
}

/** Thrown when the DOCX cannot be read; the caller maps it to UNKNOWN (PARSE_FAILED). */
export class DocxParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DocxParseError"
  }
}

/** `word/document.xml` of a DOCX package as text. */
export function docxDocumentXml(bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" })
  } catch (e) {
    throw new DocxParseError(`docx unzip failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  const xml = files["word/document.xml"]
  if (!xml) throw new DocxParseError("docx has no word/document.xml")
  const text = strFromU8(xml)
  if (!/<w:body\b/.test(text)) throw new DocxParseError("word/document.xml has no w:body")
  return text
}

const BORDER_SIDE = /<w:(?:top|left|bottom|right|between|bar)\b([^>]*)\/?>/g

/** Paragraphs drawn with the engine's draft placeholder border (dashed, B45309). */
export function findDocxPlaceholders(documentXml: string): DocxPlaceholder[] {
  const out: DocxPlaceholder[] = []
  const para = /<w:p(?=[\s>/])(?:[^>]*\/>|[^>]*>([\s\S]*?)<\/w:p>)/g
  let n = 0
  for (let m = para.exec(documentXml); m; m = para.exec(documentXml)) {
    n++
    const body = m[1] ?? ""
    const pBdr = /<w:pBdr>([\s\S]*?)<\/w:pBdr>/.exec(body)
    if (!pBdr) continue
    let marked = false
    BORDER_SIDE.lastIndex = 0
    for (let b = BORDER_SIDE.exec(pBdr[1]); b; b = BORDER_SIDE.exec(pBdr[1])) {
      const a = tagAttrs(b[1])
      if (a["w:val"] === "dashed" && (a["w:color"] ?? "").toUpperCase() === "B45309") {
        marked = true
        break
      }
    }
    if (!marked) continue
    const text = [...body.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((t) => unescAttr(t[1])).join("")
    out.push({ paragraph: n, text: clip(text) })
  }
  return out
}
