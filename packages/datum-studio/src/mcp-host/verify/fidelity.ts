/**
 * Row 153 (spec masterplan/01_specs_output_verification.md §3.3, decision C130): the FIDELITY check.
 *
 * Question answered: is every text, number and table the agent submitted present and unchanged in the output?
 * Direction is one way only, submitted -> output. Engine-made text (cover furniture, register, numbering, caption
 * label prefixes, provenance-mark labels, page fields) is never expected content and is tolerated wherever it
 * appears, because it is never compared.
 *
 * Expected content = the addressed blocks of the revision snapshot, exactly the rows the store writes into `block`
 * (`blockRowsFromSnapshot`, V/services/revisions/rows.ts:62; written by ingest/repository.ts:180 and
 * revisions/index.ts:495). The snapshot is used, not the `block` table, because the renderer reads the snapshot
 * (pure/render.ts:208-214) and v2 dual-writes may skip or fall back for `block` (structure/repository.ts:296-330).
 *
 * Per format (§3.3 table; §3.7 matrix):
 * - HTML / PDF: the element carrying `data-block` (text renderers, html/blocks/common.ts:39, text.ts:136, :197,
 *   :385, wrapper.ts:187, :236) or `data-block-id` (tables, figures, derivations: html/tables/table.ts:422,
 *   figure.ts:220, derivation.ts:160, reproduction.ts:143; contract-record.ts:108). PDF is checked on the same-job
 *   HTML it was printed from (F3, decision D-3), basis `same-job-html`.
 * - DOCX: `word/document.xml` (fflate unzip), `w:t` text with `w:tab`/`w:br`/`w:cr` read as a space, paragraph by
 *   paragraph; segments searched in block order; tables matched by shape in order, then compared cell by cell.
 * - SVG / PNG: `<text>`/`<tspan>` content of the figure; every label of the figure's spec must appear. PNG uses the
 *   same-job SVG of the same figure (pure/render.ts:497-500), basis `same-job-svg`.
 *
 * Matching rule (the "prefix rule" of §3.3, generalised and stated): a block's submitted text is a list of
 * segments, one per Inline (`text` md-lite-parsed with the engine's own `parseMdLiteHtml`,
 * html/blocks/inline.ts:31, or `runs` read run by run). Every segment must occur, as one contiguous normalised
 * substring, inside the block's output text, in submission order. Engine text before, between or after segments
 * (prefixes such as "Tabel 1.1", mark labels, numbering) is therefore allowed; a missing, cut or edited segment is
 * not. Tables are compared structurally as well (shape, then cell by cell at the same grid position).
 *
 * Numbers: a segment that is not found literally is searched again with every number token masked. If the masked
 * text is found, the only difference is in numbers: the tokens are canonicalised by the document language (ID: `.`
 * groups, `,` decimal; EN the other way) and compared by value. Equal values = formatting only (no finding);
 * different values = NUMBER_CHANGED; a token that cannot be read = UNKNOWN NUMBER_UNPARSED for that block (never
 * skipped). A literal match needs no number parsing: the digits are byte-identical.
 *
 * Everything taken from the document (text in `detail`, labels) is untrusted and cut short.
 * No browser, no network, no model: pure functions over bytes.
 */
import { strFromU8, unzipSync } from "fflate"
import { apparatusLabelRunText, keyLineText } from "../../../vendor/src/lib/studio/engine/front/texts"
import { parseMdLiteHtml } from "../../../vendor/src/lib/studio/engine/html/blocks/inline"
import { blockRowsFromSnapshot } from "../../../vendor/src/lib/studio/services/revisions/rows"
import type { NormDocSnapshot } from "../../../vendor/src/lib/studio/contract"
import {
  VERIFY_FINDINGS_CAP,
  type VerifyBasis,
  type VerifyCheck,
  type VerifyFinding,
  type VerifyUnknownReason,
} from "./types"

// ── Normalisation (spec §3.3, fixed list) ──────────────────────────────────────────────────────────────────

/**
 * Explicit transform table (spec §3.3: "every text change ... goes into an explicit transform table").
 * Steps 1-4 are the spec's own list. Step 5 is the only addition, and it is NOT an engine transform: a grep of
 * V/engine for U+2018/U+2019/U+201C/U+201D finds no quote rewriting (A9, services/ingest/util.ts:1-5 "tidak ada
 * transformasi teks"). It exists because the brief requires smart quotes never to be flagged, and a quote style
 * change carries no content. Dashes are NOT folded: a dash replacing a hyphen or minus is reported.
 */
export const FIDELITY_TRANSFORMS: ReadonlyArray<{ step: number; what: string; why: string }> = [
  { step: 1, what: "Unicode NFKC", why: "spec §3.3; folds NBSP U+00A0 and narrow NBSP U+202F to a space (engine writes &#160;: html/tables/inline.ts:91, apparatus.ts:94, :113, :120, :156; register separator U+00A0: html/base/markup.ts:128, docx/package/header-footer.ts:231)" },
  { step: 2, what: "remove U+00AD soft hyphen and U+200B zero-width space", why: "spec §3.3; hyphenation and break opportunities, not content" },
  { step: 3, what: "collapse every whitespace run (incl. tab, line break) to one space", why: "spec §3.3; w:tab / w:br / <br> / run tab and break all read as a space on both sides" },
  { step: 4, what: "trim", why: "spec §3.3" },
  { step: 5, what: "fold typographic quotes: U+2018 U+2019 U+201A U+201B U+2032 -> ', U+201C U+201D U+201E U+201F U+2033 -> \"", why: "row 153 brief: smart quotes are legitimate typography; no engine site rewrites quotes (grep, see report)" },
]

const QUOTE_FOLD: Record<string, string> = {
  "‘": "'", "’": "'", "‚": "'", "‛": "'", "′": "'",
  "“": '"', "”": '"', "„": '"', "‟": '"', "″": '"',
}

/** Normalise one side of the comparison (transform table steps 1-5). */
export function normalizeFidelityText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[­​]/g, "")
    .replace(/[‘’‚‛′“”„‟″]/g, (c) => QUOTE_FOLD[c] ?? c)
    .replace(/\s+/g, " ")
    .trim()
}

// ── Numbers (spec §3.3) ────────────────────────────────────────────────────────────────────────────────────

/** Spec §3.3 token pattern, applied after normalisation (NBSP and narrow NBSP are already a space). */
const NUMBER_TOKEN_RE = /[-+]?\d[\d., ]*\d%?|[-+]?\d%?/g
/** Placeholder of a masked number token (a private-use character never written by the engine). */
const MASK = "\uE000"

export type FidelityLanguage = "ID" | "EN"

/**
 * Canonical value of one number token for the document language, or null when the token cannot be read.
 * ID: `.` and space group thousands (groups of exactly 3), `,` is the decimal mark. EN: `,` and space group,
 * `.` is the decimal mark. A trailing `%` is kept as part of the value.
 */
export function canonicalNumber(token: string, language: string): string | null {
  if (language !== "ID" && language !== "EN") return null
  let t = token.trim()
  const pct = t.endsWith("%")
  if (pct) t = t.slice(0, -1).trim()
  let sign = ""
  if (t.startsWith("-") || t.startsWith("+")) {
    sign = t[0] === "-" ? "-" : ""
    t = t.slice(1)
  }
  const group = language === "ID" ? "." : ","
  const decimal = language === "ID" ? "," : "."
  const parts = t.split(decimal)
  if (parts.length > 2) return null
  const intPart = parts[0]
  const frac = parts.length === 2 ? parts[1] : null
  if (frac !== null && !/^\d+$/.test(frac)) return null
  let digits: string
  if (/^\d+$/.test(intPart)) digits = intPart
  else {
    const groups = intPart.split(new RegExp(`[${group === "." ? "\\." : ","} ]`))
    if (groups.length < 2 || !/^\d{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^\d{3}$/.test(g))) return null
    digits = groups.join("")
  }
  digits = digits.replace(/^0+(?=\d)/, "")
  const f = frac === null ? "" : frac.replace(/0+$/, "")
  const value = f ? `${digits}.${f}` : digits
  return `${sign && value !== "0" ? sign : ""}${value}${pct ? "%" : ""}`
}

interface Masked {
  text: string
  tokens: Array<{ at: number; token: string }>
}

function maskNumbers(s: string): Masked {
  const tokens: Masked["tokens"] = []
  let text = ""
  let last = 0
  for (const m of s.matchAll(NUMBER_TOKEN_RE)) {
    const idx = m.index ?? 0
    text += s.slice(last, idx)
    tokens.push({ at: text.length, token: m[0] })
    text += MASK
    last = idx + m[0].length
  }
  text += s.slice(last)
  return { text, tokens }
}

// ── Expected content ─────────────────────────────────────────────────────────────────────────────────────

/** One addressed submitted block, as stored in `block` / produced by `blockRowsFromSnapshot`. */
export interface FidelityBlock {
  blockId: string
  address: string
  type: string
  content: unknown
  artifactLabel?: string | null
  ordinal?: number
}

export interface FidelityExpectation {
  /** `doc.meta.language` of the snapshot ("ID" | "EN"; anything else makes number comparison UNKNOWN). */
  language: string
  blocks: FidelityBlock[]
}

/** Expected content of a revision: its snapshot's addressed blocks in ordinal order (A-1 resolution, see header). */
export function fidelityExpectationFromSnapshot(snapshot: unknown): FidelityExpectation {
  const s = snapshot as NormDocSnapshot
  const rows = blockRowsFromSnapshot(s)
  rows.sort((a, b) => a.ordinal - b.ordinal)
  const language = (s?.doc?.meta as { language?: unknown } | undefined)?.language
  return {
    language: typeof language === "string" ? language : "",
    blocks: rows.map((r) => ({ blockId: r.blockId, address: r.address, type: r.type, content: r.content, artifactLabel: r.artifactLabel, ordinal: r.ordinal })),
  }
}

/** Table-family block types (V/contract/enums.ts:69-81). */
const TABLE_TYPES: ReadonlySet<string> = new Set([
  "table", "specTable", "registerTable", "exampleWrongRight", "ruleTable", "checklist", "glossary",
  "sourceRegister", "ruleIndex", "referenceScale", "financialTable",
])
/** Figure block types whose drawing is a spec (V/contract/enums.ts:85). */
export const FIDELITY_FIGURE_TYPES: ReadonlySet<string> = new Set(["chart", "diagram", "symbolSheet", "image"])

/**
 * Keys that never hold submitted prose: the engine walker's own list (V/engine/lint/scan/walk.ts:44-59, not
 * exported there) plus `blockId` and `id` (identities; the derivation id is reworded by the engine,
 * html/tables/derivation.ts:139). `spec` holds figure data: figure labels are checked on SVG outputs only.
 */
const SKIP_KEYS: ReadonlySet<string> = new Set([
  "spec", "format", "runDefaults", "x", "labelProps", "setup", "layout", "columns", "marker", "headingFormat",
  "signRowFormat", "colsTw", "borders", "shading", "marginsTw", "blockId", "id",
])

/**
 * One submitted Inline. `visible` = md-lite parsed text (the form reported); `forms` = every form the engine may
 * print for it (visible, raw verbatim, and the engine's own apparatus wording, see `apparatusForms`).
 */
interface Segment {
  visible: string
  forms: string[]
}

function segment(visible: string, ...more: string[]): Segment {
  return { visible, forms: [...new Set([visible, ...more].filter((f) => f.length > 0))] }
}

function runsVisible(runs: readonly unknown[]): string {
  let s = ""
  for (const r of runs) {
    if (!r || typeof r !== "object") continue
    const o = r as Record<string, unknown>
    if (typeof o.t === "string") s += o.t
    else if (o.tab === true) s += " "
    else if (o.br !== undefined) s += " "
  }
  return s
}

/**
 * Wording the engine itself puts on apparatus lines (transform table step A1/A2; engine functions called, not copied):
 * - figure key row, ID documents: `keyLineText` ("KEY" -> "KUNCI", "DATA =" -> "PENUH =", ...), V/engine/front/texts.ts:817,
 *   applied by html/tables/apparatus.ts:139-150 and the DOCX figure key line;
 * - key row and SUMBER line, EN documents: `apparatusLabelRunText` per run (texts.ts:718), applied by
 *   html/tables/apparatus.ts:26-30 (`localizedApparatus`).
 */
function apparatusForms(key: string | null, texts: string[], language: string): string[] {
  if (key !== "keyRow" && key !== "source" && key !== "inline") return []
  const lang = language === "EN" ? "EN" : "ID"
  const out: string[] = []
  for (const t of texts) {
    if (key === "keyRow") out.push(normalizeFidelityText(keyLineText(t, lang)))
    out.push(normalizeFidelityText(apparatusLabelRunText(t, lang)))
  }
  return out
}

function inlineSegment(node: Record<string, unknown>, key: string | null, language: string): Segment | null {
  if (Array.isArray(node.runs)) {
    const t = normalizeFidelityText(runsVisible(node.runs))
    if (!t) return null
    const runTexts = (node.runs as Array<{ t?: unknown }>).map((r) => (typeof r?.t === "string" ? r.t : " "))
    const localized = language === "EN" ? normalizeFidelityText(runTexts.map((r) => apparatusLabelRunText(r, "EN")).join("")) : ""
    return segment(t, localized, ...(key === "keyRow" ? apparatusForms(key, [runTexts.join("")], language) : []))
  }
  if (typeof node.text === "string") {
    const raw = normalizeFidelityText(node.text)
    if (!raw) return null
    // The engine parses md-lite for prose and keeps `text` verbatim for titles/labels/code (docx/blocks/runs.ts:94-99).
    const visibleText = parseMdLiteHtml(node.text).map((r) => ("t" in r && typeof r.t === "string" ? r.t : "")).join("")
    const visible = normalizeFidelityText(visibleText) || raw
    return segment(visible, raw, ...apparatusForms(key, [visibleText, node.text], language))
  }
  return null
}

/*
 * Provenance marks (`mark`, `provenance`: plain strings, not Inlines) are NOT expected text: the engine prints them as
 * a glyph only in some places (derivation lines in HTML: manual000 4.6.2 prints "◈" without "DITURUNKAN") and as a
 * label in others (DOCX assumption lines). Tried and measured in row 153 (14 false findings on manual000 HTML);
 * a clipped mark label (row 98 "[TERUKU") is OVERLAP_CLIP BOX_CLIP territory (row 151), see the row report.
 */

/**
 * Front-page apparatus fields whose wording the engine/template sets (issue stamp, identity string): the engine's
 * own list `APPARATUS_DATA_KEYS` minus `control` (V/engine/lint/scan/walk.ts:195-197, D-263). The issue stamp is
 * rebuilt from the document meta (e.g. "// 20261106 ID T — TERBITAN 1" for a submitted "// 20261106 ID A · TERBITAN 1").
 */
const FRONT_APPARATUS_KEYS: ReadonlySet<string> = new Set(["colophon", "identityString"])

function collectSegments(node: unknown, out: Segment[], skipRows: boolean, language: string, key: string | null = null, front = false): void {
  if (Array.isArray(node)) {
    for (const v of node) collectSegments(v, out, skipRows, language, key, front)
    return
  }
  if (!node || typeof node !== "object") return
  const o = node as Record<string, unknown>
  const seg = inlineSegment(o, key, language)
  if (seg) out.push(seg)
  for (const [k, v] of Object.entries(o)) {
    if (k === "text" || k === "runs" || SKIP_KEYS.has(k)) continue
    if (skipRows && k === "rows") continue
    if (front && FRONT_APPARATUS_KEYS.has(k)) continue

    if (v !== null && typeof v === "object") collectSegments(v, out, false, language, k === "inline" && key !== null ? key : k, front)
  }
}

interface ExpectedCell {
  segments: Segment[]
  /** vMerge continuation: covered by the cell above, never compared. */
  covered: boolean
}
interface ExpectedTable {
  rows: Array<Array<ExpectedCell | undefined>>
  maxCols: number
}

function cellSegments(cell: unknown, language: string): Segment[] {
  const out: Segment[] = []
  if (!cell || typeof cell !== "object") return out
  const c = cell as Record<string, unknown>
  if (Array.isArray(c.paragraphs)) collectSegments(c.paragraphs, out, false, language)
  else {
    const seg = inlineSegment(c, null, language)
    if (seg) out.push(seg)
  }
  if (c.nested) collectSegments(c.nested, out, false, language)
  return out
}

function expectedTable(content: unknown, language: string): ExpectedTable | null {
  if (!content || typeof content !== "object") return null
  const rows = (content as { rows?: unknown }).rows
  if (!Array.isArray(rows)) return null
  const grid: ExpectedTable["rows"] = []
  let maxCols = 0
  for (const r of rows) {
    const cells = r && typeof r === "object" && Array.isArray((r as { cells?: unknown }).cells) ? ((r as { cells: unknown[] }).cells) : []
    const line: Array<ExpectedCell | undefined> = []
    let col = 0
    for (const c of cells) {
      const span = Math.max(1, Math.trunc(Number((c as { gridSpan?: unknown })?.gridSpan) || 1))
      line[col] = { segments: cellSegments(c, language), covered: (c as { vMerge?: unknown })?.vMerge === "continue" }
      col += span
    }
    maxCols = Math.max(maxCols, col)
    grid.push(line)
  }
  return { rows: grid, maxCols }
}

interface ExpectedBlock {
  block: FidelityBlock
  segments: Segment[]
  table: ExpectedTable | null
  /** Forms of the table's SUMBER text (the DOCX writer may merge it into a last table row); empty when none. */
  sourceForms: string[]
}

function expectBlock(b: FidelityBlock, language: string): ExpectedBlock {
  const isTable = TABLE_TYPES.has(b.type)
  const segments: Segment[] = []
  collectSegments(b.content, segments, isTable, language, null, typeof b.address === "string" && b.address.startsWith("F:"))
  const sourceSegs: Segment[] = []
  if (isTable && b.content && typeof b.content === "object") collectSegments((b.content as { source?: unknown }).source, sourceSegs, false, language, "source")
  return { block: b, segments, table: isTable ? expectedTable(b.content, language) : null, sourceForms: sourceSegs.flatMap((x) => x.forms) }
}

// ── Markup tree (HTML and WordprocessingML) ─────────────────────────────────────────────────────────────────

/** Minimal element tree. Not a general parser: it reads the engine's own well-formed output. */
export interface MNode {
  tag: string
  attrs: Record<string, string>
  children: Array<MNode | string>
}

const HTML_VOID: ReadonlySet<string> = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])
const HTML_RAW: ReadonlySet<string> = new Set(["style", "script", "textarea", "title"])
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " }

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s
  return s.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (all, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all
    }
    return NAMED_ENTITIES[e] ?? all
  })
}

const ATTR_RE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(ATTR_RE)) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? "")
  return out
}

/** Parse markup into a tree. `html`: void elements and raw-text elements; tags are lower-cased. */
export function parseMarkup(src: string, mode: "html" | "xml"): MNode {
  const root: MNode = { tag: "#root", attrs: {}, children: [] }
  const stack: MNode[] = [root]
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<![^>]*>|<\?[\s\S]*?\?>|<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g
  let last = 0
  const text = (t: string) => {
    if (t) stack[stack.length - 1].children.push(decodeEntities(t))
  }
  for (let m = re.exec(src); m; m = re.exec(src)) {
    text(src.slice(last, m.index))
    last = re.lastIndex
    if (m[1] !== undefined) {
      stack[stack.length - 1].children.push(m[1])
      continue
    }
    if (m[3] === undefined) continue // comment, doctype, processing instruction
    const tag = mode === "html" ? m[3].toLowerCase() : m[3]
    if (m[2] === "/") {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    let rest = m[4] ?? ""
    const selfClose = /\/\s*$/.test(rest)
    if (selfClose) rest = rest.replace(/\/\s*$/, "")
    const node: MNode = { tag, attrs: parseAttrs(rest), children: [] }
    stack[stack.length - 1].children.push(node)
    if (selfClose || (mode === "html" && HTML_VOID.has(tag))) continue
    if (mode === "html" && HTML_RAW.has(tag)) {
      const end = src.toLowerCase().indexOf(`</${tag}`, last)
      const stop = end < 0 ? src.length : end
      node.children.push(src.slice(last, stop))
      const gt = end < 0 ? src.length : src.indexOf(">", end)
      last = gt < 0 ? src.length : gt + 1
      re.lastIndex = last
      continue
    }
    stack.push(node)
  }
  text(src.slice(last))
  return root
}

function walk(n: MNode, visit: (n: MNode) => boolean | void): void {
  for (const c of n.children) {
    if (typeof c === "string") continue
    if (visit(c) === false) continue
    walk(c, visit)
  }
}

/** HTML block-level elements: a space is put at their boundaries so text of adjacent blocks never fuses. */
const HTML_BLOCKISH: ReadonlySet<string> = new Set([
  "p", "div", "li", "ul", "ol", "td", "th", "tr", "table", "thead", "tbody", "tfoot", "caption", "header", "footer",
  "section", "article", "aside", "figure", "figcaption", "h1", "h2", "h3", "h4", "h5", "h6", "dl", "dt", "dd", "pre",
  "blockquote", "nav", "main", "text", "tspan", "svg", "g", "title",
])
const HTML_SKIP: ReadonlySet<string> = new Set(["style", "script", "template", "head", "desc", "metadata", "defs"])

/** Visible text of an HTML element (entities decoded, `<br>` and block boundaries as spaces). */
export function htmlText(n: MNode): string {
  let s = ""
  const rec = (x: MNode) => {
    for (const c of x.children) {
      if (typeof c === "string") {
        s += c
        continue
      }
      if (HTML_SKIP.has(c.tag)) continue
      if (c.tag === "br") {
        s += " "
        continue
      }
      const blockish = HTML_BLOCKISH.has(c.tag)
      if (blockish) s += " "
      rec(c)
      if (blockish) s += " "
    }
  }
  rec(n)
  return s
}

// ── Segment search ────────────────────────────────────────────────────────────────────────────────────────

type SegmentResult =
  | { kind: "found"; end: number; at: number }
  | { kind: "numbers-equal"; end: number; at: number }
  | { kind: "number-changed"; at: number; expected: string; found: string }
  | { kind: "number-unparsed"; token: string }
  | { kind: "missing"; matchedPrefix: number }

/** Find `seg` in `hay` from `from`. Literal first (visible, then raw form), then the number-masked comparison. */
function findSegment(seg: Segment, hay: string, maskedHay: Masked, from: number, language: string): SegmentResult {
  for (const form of seg.forms) {
    const at = hay.indexOf(form, from)
    if (at >= 0) return { kind: "found", at, end: at + form.length }
  }
  const me = maskNumbers(seg.visible)
  if (me.tokens.length > 0) {
    // masked positions map 1:1 to hay positions only through the token table; search the masked hay
    let firstChanged: SegmentResult | null = null
    const fromMasked = maskedIndex(maskedHay, from)
    for (let at = maskedHay.text.indexOf(me.text, fromMasked); at >= 0; at = maskedHay.text.indexOf(me.text, at + 1)) {
      const found = maskedHay.tokens.filter((t) => t.at >= at && t.at < at + me.text.length).map((t) => t.token)
      if (found.length !== me.tokens.length) continue
      let equal = true
      for (let i = 0; i < found.length; i++) {
        const want = me.tokens[i].token
        if (want === found[i]) continue
        const a = canonicalNumber(want, language)
        const b = canonicalNumber(found[i], language)
        if (a === null) return { kind: "number-unparsed", token: want }
        if (b === null) return { kind: "number-unparsed", token: found[i] }
        if (a !== b) {
          equal = false
          firstChanged ??= { kind: "number-changed", at, expected: want, found: found[i] }
          break
        }
      }
      if (equal) {
        const end = hayIndex(maskedHay, at + me.text.length)
        return { kind: "numbers-equal", at: hayIndex(maskedHay, at), end }
      }
    }
    if (firstChanged) return firstChanged
  }
  return { kind: "missing", matchedPrefix: longestPrefix(seg.visible, hay, from) }
}

/** Masked-text index of hay position `pos` (hay and masked text differ only inside number tokens). */
function maskedIndex(m: Masked, pos: number): number {
  let delta = 0
  for (const t of m.tokens) {
    const hayStart = t.at + delta
    if (pos <= hayStart) return pos - delta
    if (pos < hayStart + t.token.length) return t.at
    delta += t.token.length - 1
  }
  return pos - delta
}

/** Hay position of masked index `mi`. */
function hayIndex(m: Masked, mi: number): number {
  let delta = 0
  for (const t of m.tokens) {
    if (t.at >= mi) break
    delta += t.token.length - 1
  }
  return mi + delta
}

/** Length of the longest prefix of `seg` found in `hay` at or after `from` (locates a cut, e.g. "[TERUKU"). */
function longestPrefix(seg: string, hay: string, from: number): number {
  let lo = 0
  let hi = seg.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (hay.indexOf(seg.slice(0, mid), from) >= 0) lo = mid
    else hi = mid - 1
  }
  return lo
}

// ── Findings ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Longest document-derived excerpt kept in a finding detail. */
export const FIDELITY_EXCERPT_MAX = 60

function excerpt(s: string, at = 0): string {
  const part = s.slice(Math.max(0, at), Math.max(0, at) + FIDELITY_EXCERPT_MAX)
  return `${at > 0 ? "…" : ""}${part}${at + FIDELITY_EXCERPT_MAX < s.length ? "…" : ""}`
}

class Collector {
  findings: VerifyFinding[] = []
  total = 0
  unknown: VerifyUnknownReason | null = null
  stats = { blocks: 0, segments: 0, tables: 0, cells: 0 }
  add(f: VerifyFinding): void {
    this.total++
    if (this.findings.length < VERIFY_FINDINGS_CAP) this.findings.push(f)
  }
}

function finding(code: string, b: FidelityBlock, detail: string, amount?: number): VerifyFinding {
  const f: VerifyFinding = { code, page: null, address: b.address ?? null, label: b.artifactLabel ?? null, detail }
  if (amount !== undefined) f.amount = amount
  return f
}

/** Search every segment of a block in order; report the first loss per segment. Returns the hay position after the last match. */
function checkSegments(col: Collector, b: FidelityBlock, segs: Segment[], hay: string, from: number, language: string, where = "", maskedHay?: Masked): number {
  const masked = maskedHay ?? maskNumbers(hay)
  let cursor = from
  for (const seg of segs) {
    col.stats.segments++
    let r = findSegment(seg, hay, masked, cursor, language)
    // Out of order inside one block (e.g. a caption the engine places after its table) is not a loss.
    if ((r.kind === "missing" || r.kind === "number-changed") && cursor > from) {
      const again = findSegment(seg, hay, masked, from, language)
      if (again.kind === "found" || again.kind === "numbers-equal") r = again
    }
    switch (r.kind) {
      case "found":
      case "numbers-equal":
        cursor = r.end
        break
      case "number-changed":
        col.add(finding("NUMBER_CHANGED", b, `${where}expected ${excerpt(r.expected)} found ${excerpt(r.found)}`))
        break
      case "number-unparsed":
        col.unknown ??= "NUMBER_UNPARSED"
        break
      case "missing":
        col.add(
          finding(
            "TEXT_CHANGED",
            b,
            r.matchedPrefix > 0
              ? `${where}output ends or differs after ${r.matchedPrefix} of ${seg.visible.length} characters: expected "${excerpt(seg.visible, Math.max(0, r.matchedPrefix - 20))}"`
              : `${where}text not found: "${excerpt(seg.visible)}"`,
            seg.visible.length - r.matchedPrefix,
          ),
        )
        break
    }
  }
  return cursor
}

/** Cell-by-cell comparison of two grids (expected vs output). */
function checkCells(col: Collector, b: FidelityBlock, exp: ExpectedTable, out: Array<Array<string | undefined>>, language: string): void {
  for (let r = 0; r < exp.rows.length; r++) {
    const line = exp.rows[r]
    for (let c = 0; c < line.length; c++) {
      const cell = line[c]
      if (!cell || cell.covered || cell.segments.length === 0) continue
      col.stats.cells++
      const got = out[r]?.[c]
      const where = `row ${r + 1}, column ${c + 1}: `
      if (got === undefined) {
        col.add(finding("TABLE_CELL_CHANGED", b, `${where}cell missing`))
        continue
      }
      const sub = new Collector()
      checkSegments(sub, b, cell.segments, normalizeFidelityText(got), 0, language, where)
      if (sub.unknown) col.unknown ??= sub.unknown
      for (const f of sub.findings) col.add({ ...f, code: f.code === "NUMBER_CHANGED" ? "NUMBER_CHANGED" : "TABLE_CELL_CHANGED" })
      col.total += sub.total - sub.findings.length
    }
  }
}

function result(col: Collector, basis: VerifyBasis, t0: number): VerifyCheck {
  const failed = col.total > 0
  return {
    id: "FIDELITY",
    status: failed ? "FAIL" : col.unknown ? "UNKNOWN" : "PASS",
    basis,
    reason: failed ? null : col.unknown,
    findings: col.findings,
    truncated: col.total - col.findings.length,
    ms: Math.round(performance.now() - t0),
  }
}

function unknown(reason: VerifyUnknownReason, basis: VerifyBasis, t0: number, detail?: string): VerifyCheck {
  return {
    id: "FIDELITY",
    status: "UNKNOWN",
    basis,
    reason,
    findings: detail ? [{ code: reason, page: null, address: null, label: null, detail }] : [],
    truncated: 0,
    ms: Math.round(performance.now() - t0),
  }
}

// ── HTML (and PDF through its same-job HTML) ─────────────────────────────────────────────────────────────────

/** Rows of a table element: direct `tr` children of the table or its thead/tbody/tfoot, never of a nested table. */
function tableRows(table: MNode): MNode[] {
  const rows: MNode[] = []
  for (const c of table.children) {
    if (typeof c === "string") continue
    if (c.tag === "tr") rows.push(c)
    else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") for (const r of c.children) if (typeof r !== "string" && r.tag === "tr") rows.push(r)
  }
  return rows
}

/** Engine-added table rows (not submitted rows): the merged SUMBER row (html/tables/table.ts:389). */
function isEngineRow(tr: MNode): boolean {
  return (tr.attrs.class ?? "").split(/\s+/).includes("st-row-source")
}

/** Grid of cell texts with colspan/rowspan applied (a spanned position holds undefined except at its origin). */
function htmlGrid(rows: MNode[]): { grid: Array<Array<string | undefined>>; maxCols: number } {
  const grid: Array<Array<string | undefined>> = []
  const taken: boolean[][] = []
  let maxCols = 0
  rows.forEach((tr, r) => {
    grid[r] ??= []
    taken[r] ??= []
    let col = 0
    for (const td of tr.children) {
      if (typeof td === "string" || (td.tag !== "td" && td.tag !== "th")) continue
      while (taken[r][col]) col++
      const cs = Math.max(1, Number.parseInt(td.attrs.colspan ?? "1", 10) || 1)
      const rs = Math.max(1, Number.parseInt(td.attrs.rowspan ?? "1", 10) || 1)
      grid[r][col] = htmlText(td)
      for (let i = 0; i < rs; i++) {
        taken[r + i] ??= []
        for (let j = 0; j < cs; j++) taken[r + i][col + j] = true
      }
      col += cs
    }
    maxCols = Math.max(maxCols, taken[r].length)
  })
  return { grid, maxCols }
}

/** Columns a row occupies (colspan counted), the §3.3 "max cells per row" measure. */
function rowWidth(tr: MNode): number {
  let n = 0
  for (const td of tr.children) if (typeof td !== "string" && (td.tag === "td" || td.tag === "th")) n += Math.max(1, Number.parseInt(td.attrs.colspan ?? "1", 10) || 1)
  return n
}

function firstTable(n: MNode): MNode | null {
  let found: MNode | null = null
  walk(n, (c) => {
    if (found) return false
    if (c.tag === "table") {
      found = c
      return false
    }
  })
  return found
}

function checkTableShape(col: Collector, b: FidelityBlock, exp: ExpectedTable, rows: number, maxCols: number): boolean {
  col.stats.tables++
  if (rows === exp.rows.length && maxCols === exp.maxCols) return true
  col.add(finding("TABLE_SHAPE", b, `expected ${exp.rows.length} rows x ${exp.maxCols} columns, found ${rows} x ${maxCols}`, Math.abs(rows - exp.rows.length) + Math.abs(maxCols - exp.maxCols)))
  return false
}

/** FIDELITY on an HTML output (or on the same-job HTML of a PDF). */
export function checkHtmlFidelity(html: string, expected: FidelityExpectation, basis: VerifyBasis = "self"): VerifyCheck {
  const t0 = performance.now()
  let root: MNode
  try {
    root = parseMarkup(html, "html")
  } catch {
    return unknown("PARSE_FAILED", basis, t0)
  }
  const byBlock = new Map<string, MNode[]>()
  const byAddress = new Map<string, MNode[]>()
  const push = (m: Map<string, MNode[]>, k: string, n: MNode) => {
    const list = m.get(k)
    if (list) list.push(n)
    else m.set(k, [n])
  }
  walk(root, (n) => {
    const id = n.attrs["data-block"] ?? n.attrs["data-block-id"]
    if (id) push(byBlock, id, n)
    else if (n.attrs["data-address"]) push(byAddress, n.attrs["data-address"], n)
  })
  const col = new Collector()
  for (const b of expected.blocks) {
    const eb = expectBlock(b, expected.language)
    col.stats.blocks++
    // Located by `data-block` / `data-block-id`; blocks whose renderer writes only `data-address` (slot entries,
    // html/assemble/slots.ts:204-206, :228; the address wrapper index.ts:148-153) by their address.
    const els = byBlock.get(b.blockId) ?? byAddress.get(b.address)
    const expectsText = eb.segments.length > 0 || (eb.table !== null && eb.table.rows.length > 0)
    if (!els || els.length === 0) {
      if (expectsText) col.add(finding("BLOCK_MISSING", b, `no element with data-block ${excerpt(b.blockId)} (${b.type})`))
      continue
    }
    // `st-missing` = the engine's stand-in for a block that failed or has no renderer (html/assemble/index.ts:141-146,
    // classes.ts:25): the submitted block was not rendered.
    if (expectsText && els.every((e) => (e.attrs.class ?? "").split(/\s+/).includes("st-missing"))) {
      col.add(finding("BLOCK_MISSING", b, `block not rendered: engine stand-in st-missing (${b.type})`))
      continue
    }
    const hay = normalizeFidelityText(els.map(htmlText).join(" "))
    checkSegments(col, b, eb.segments, hay, 0, expected.language)
    if (eb.table) {
      const table = els.map(firstTable).find((t) => t !== null) ?? null
      if (!table) {
        col.add(finding("TABLE_SHAPE", b, `expected ${eb.table.rows.length} rows x ${eb.table.maxCols} columns, found no table`))
        continue
      }
      const rows = tableRows(table).filter((tr) => !isEngineRow(tr))
      const maxCols = rows.reduce((m, tr) => Math.max(m, rowWidth(tr)), 0)
      // Cells are compared only when the shape holds; otherwise every shifted row would be listed.
      if (checkTableShape(col, b, eb.table, rows.length, maxCols)) checkCells(col, b, eb.table, htmlGrid(rows).grid, expected.language)
    }
  }
  return result(col, basis, t0)
}

// ── DOCX ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface DocxTable {
  /** Position of the table's first and last character in the body string. */
  at: number
  end: number
  rows: Array<Array<string | undefined>>
  rowCount: number
  maxCols: number
  /** Number of `w:tc` and grid width (gridSpan counted) per row. */
  rowCells: number[]
  rowWidths: number[]
  /** The engine's merged SUMBER row was recognised and removed. */
  sourceDropped?: boolean
}

/** Text of a `w:p` (or any subtree): `w:t` only (not `w:delText`/`w:instrText`); `w:tab`, `w:br`, `w:cr` as a space. */
function docxText(n: MNode): string {
  let s = ""
  const rec = (x: MNode) => {
    for (const c of x.children) {
      if (typeof c === "string") continue
      if (c.tag === "w:t") s += c.children.filter((t): t is string => typeof t === "string").join("")
      else if (c.tag === "w:tab" || c.tag === "w:br" || c.tag === "w:cr") s += " "
      else if (c.tag === "w:p") {
        s += " "
        rec(c)
        s += " "
      } else if (c.tag !== "w:pPr" && c.tag !== "w:rPr" && c.tag !== "w:instrText" && c.tag !== "w:delText") rec(c)
    }
  }
  rec(n)
  return s
}

function docxTable(tbl: MNode, at: number): DocxTable {
  const rows: Array<Array<string | undefined>> = []
  const rowCells: number[] = []
  const rowWidths: number[] = []
  let maxCols = 0
  for (const tr of tbl.children) {
    if (typeof tr === "string" || tr.tag !== "w:tr") continue
    const line: Array<string | undefined> = []
    let col = 0
    let cells = 0
    for (const tc of tr.children) {
      if (typeof tc === "string" || tc.tag !== "w:tc") continue
      cells++
      let span = 1
      let cont = false
      const pr = tc.children.find((x): x is MNode => typeof x !== "string" && x.tag === "w:tcPr")
      if (pr) {
        for (const p of pr.children) {
          if (typeof p === "string") continue
          if (p.tag === "w:gridSpan") span = Math.max(1, Number.parseInt(p.attrs["w:val"] ?? "1", 10) || 1)
          if (p.tag === "w:vMerge" && (p.attrs["w:val"] ?? "continue") === "continue") cont = true
        }
      }
      line[col] = cont ? undefined : docxText(tc)
      col += span
    }
    maxCols = Math.max(maxCols, col)
    rows.push(line)
    rowCells.push(cells)
    rowWidths.push(col)
  }
  return { at, end: at, rows, rowCount: rows.length, maxCols, rowCells, rowWidths }
}

/**
 * The DOCX writer appends the SUMBER line as a last row of one cell spanning every column when the source placement
 * is `lastRowMerged` (V/engine/docx/tables/render.ts:435-454, :653-654). That row is engine-made: it is dropped when
 * the last row is one cell spanning the full grid width and holds the block's own SUMBER text.
 */
function dropMergedSourceRow(t: DocxTable, sourceForms: string[]): void {
  if (t.rowCount < 1 || t.sourceDropped) return
  const last = t.rowCount - 1
  const width = Math.max(...t.rowWidths)
  if (t.rowCells[last] !== 1 || t.rowWidths[last] !== width) return
  const text = normalizeFidelityText(t.rows[last][0] ?? "")
  if (!sourceForms.some((f) => text.includes(f))) return
  t.rows = t.rows.slice(0, last)
  t.rowCells = t.rowCells.slice(0, last)
  t.rowWidths = t.rowWidths.slice(0, last)
  t.rowCount = last
  t.maxCols = last > 0 ? Math.max(...t.rowWidths) : 0
  t.sourceDropped = true
}

/** Body text (normalised, paragraphs separated by a space) and the top-level tables with their body position. */
function docxBody(xml: string): { hay: string; tables: DocxTable[] } {
  const root = parseMarkup(xml, "xml")
  let body: MNode | null = null
  walk(root, (n) => {
    if (body) return false
    if (n.tag === "w:body") {
      body = n
      return false
    }
  })
  if (!body) throw new Error("no w:body")
  let hay = ""
  const tables: DocxTable[] = []
  const add = (t: string) => {
    const s = normalizeFidelityText(t)
    if (s) hay += (hay ? " " : "") + s
  }
  for (const c of (body as MNode).children) {
    if (typeof c === "string") continue
    if (c.tag === "w:tbl") {
      const t = docxTable(c, hay.length + (hay ? 1 : 0))
      add(docxText(c))
      t.end = hay.length
      tables.push(t)
    } else if (c.tag !== "w:sectPr") add(docxText(c))
  }
  return { hay, tables }
}

/** FIDELITY on a DOCX output. */
export function checkDocxFidelity(bytes: Uint8Array, expected: FidelityExpectation): VerifyCheck {
  const t0 = performance.now()
  let parsed: { hay: string; tables: DocxTable[] }
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" })
    const doc = files["word/document.xml"]
    if (!doc) return unknown("PARSE_FAILED", "self", t0, "word/document.xml missing")
    parsed = docxBody(strFromU8(doc))
  } catch {
    return unknown("PARSE_FAILED", "self", t0)
  }
  const { hay, tables } = parsed
  const masked = maskNumbers(hay)
  const col = new Collector()
  let cursor = 0
  let tableIdx = 0
  for (const b of expected.blocks) {
    const eb = expectBlock(b, expected.language)
    col.stats.blocks++
    const all: Segment[] = [...eb.segments]
    if (eb.table) for (const line of eb.table.rows) for (const cell of line) if (cell && !cell.covered) all.push(...cell.segments)
    if (all.length === 0 && !eb.table) continue
    // Block found = at least one of its segments occurs at or after the block cursor.
    const hits = all.map((s) => findSegment(s, hay, masked, cursor, expected.language))
    const hitAts = hits.flatMap((h) => (h.kind === "found" || h.kind === "numbers-equal" ? [h.at] : []))
    const firstHit = hitAts.length > 0 ? { at: Math.min(...hitAts) } : undefined
    if (all.length > 0 && !firstHit && !hits.some((h) => h.kind === "number-changed")) {
      // Nothing of the block found. A long enough prefix of one of its segments means the block is there but cut or
      // edited (TEXT_CHANGED below, which says where the output stops); otherwise the block is missing.
      const prefix = Math.max(...hits.map((h, i) => (h.kind === "missing" ? h.matchedPrefix / Math.max(1, all[i].visible.length) : 0)))
      const longest = Math.max(...hits.map((h) => (h.kind === "missing" ? h.matchedPrefix : 0)))
      if (!(longest >= 20 && prefix >= 0.3)) {
        col.add(finding("BLOCK_MISSING", b, `no text of this ${b.type} block found in word/document.xml: "${excerpt(all[0].visible)}"`))
        continue
      }
    }
    const blockStart = firstHit ? firstHit.at : cursor
    if (eb.segments.length > 0) checkSegments(col, b, eb.segments, hay, blockStart, expected.language, "", masked)
    if (eb.table) {
      // Candidate = the next unused DOCX table that ends at or after this block's first text. The first two
      // candidates are tried for an exact shape (an engine-made table may sit in between); else TABLE_SHAPE.
      col.stats.tables++
      const cands: number[] = []
      for (let i = tableIdx; i < tables.length && cands.length < 2; i++) if (tables[i].end >= blockStart) cands.push(i)
      if (eb.sourceForms.length > 0) for (const i of cands) dropMergedSourceRow(tables[i], eb.sourceForms)
      const match = cands.find((i) => tables[i].rowCount === eb.table!.rows.length && tables[i].maxCols === eb.table!.maxCols)
      if (match === undefined) {
        const near = cands.length > 0 ? tables[cands[0]] : undefined
        col.add(
          finding(
            "TABLE_SHAPE",
            b,
            near
              ? `expected ${eb.table.rows.length} rows x ${eb.table.maxCols} columns, found ${near.rowCount} x ${near.maxCols}`
              : `expected ${eb.table.rows.length} rows x ${eb.table.maxCols} columns, no table left in the document`,
            near ? Math.abs(near.rowCount - eb.table.rows.length) + Math.abs(near.maxCols - eb.table.maxCols) : undefined,
          ),
        )
        // Cells are not compared against a table of another shape: every shifted row would be listed.
        if (near) tableIdx = cands[0] + 1
      } else {
        tableIdx = match + 1
        checkCells(col, b, eb.table, tables[match].rows, expected.language)
      }
    }
    cursor = Math.max(cursor, blockStart)
  }
  return result(col, "self", t0)
}

// ── SVG (and PNG through its same-job SVG) ────────────────────────────────────────────────────────────────────

/**
 * Labels of a figure spec that the figure must draw (§3.3 SVG row): diagram node, edge and zone labels
 * (V/contract/types/diagram.ts:18-48); chart series identity (series, group and set names of `data` and of composite
 * `panels[].data`, V/contract/types/chart.ts:97-118). Data values are not required (§3.3). Titles are page apparatus
 * (caption), not figure text. `spec: { artifactId }` references carry no labels (doc.ts:467-479).
 */
export function figureSpecLabels(content: unknown): Array<{ label: string; forms: string[]; series: boolean }> {
  const spec = content && typeof content === "object" ? (content as { spec?: unknown }).spec : undefined
  if (!spec || typeof spec !== "object") return []
  const sp = spec as Record<string, unknown>
  const raw: Array<{ text: string; series: boolean }> = []
  const str = (v: unknown, series = false) => {
    if (typeof v === "string") raw.push({ text: v, series })
  }
  const list = (v: unknown): Array<Record<string, unknown>> => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === "object") : [])
  if (Array.isArray(sp.nodes) && !sp.data) {
    for (const n of list(sp.nodes)) str(n.label)
    for (const e of list(sp.edges)) str(e.label)
    for (const z of list(sp.zones)) str(z.label)
  }
  const short = new Map<string, string>()
  // A label with a `labelShort` entry may be drawn in its short form (chart.ts:75-90).
  // Charts: only the series identity is required (series, distribution group and set names). Category, point,
  // item and node labels are NOT required: the chart engine thins category ticks on purpose
  // (engine/chart/core/labelfit.ts `categoryAxisPlan`; parity chart p12 draws Jan/Apr/Jul/Okt of 12 months) and the
  // `gallery` style draws no category or node labels at all (parity k08, h07 @gallery). Stated limit, see report.
  const chartData = (d: unknown) => {
    if (!d || typeof d !== "object") return
    const o = d as Record<string, unknown>
    for (const x of list(o.series)) str(x.name, true)
    for (const x of list(o.groups)) str(x.name, true)
    for (const x of list(o.sets)) str(x.name, true)
  }
  const chartSpec = (c: Record<string, unknown>) => {
    chartData(c.data)
    for (const ls of list(c.labelShort)) if (typeof ls.label === "string" && typeof ls.short === "string") short.set(normalizeFidelityText(ls.label), normalizeFidelityText(ls.short))
  }
  if (sp.data) chartSpec(sp)
  for (const p of list(sp.panels)) chartSpec(p)
  const seen = new Set<string>()
  const out: Array<{ label: string; forms: string[]; series: boolean }> = []
  for (const r of raw) {
    const label = normalizeFidelityText(r.text)
    if (!label || seen.has(label)) continue
    seen.add(label)
    const s = short.get(label)
    out.push({ label, forms: s ? [label, s] : [label], series: r.series })
  }
  return out
}

/** Text of every `<text>` element of an SVG, one string per element (tspans joined with a space). */
export function svgTexts(svg: string): string[] {
  const root = parseMarkup(svg, "xml")
  const out: string[] = []
  const textOf = (n: MNode): string => n.children.map((c) => (typeof c === "string" ? c : ` ${textOf(c)} `)).join("")
  walk(root, (n) => {
    if (n.tag === "text") {
      out.push(normalizeFidelityText(textOf(n)))
      return false
    }
  })
  return out
}

/** The figure block an SVG/PNG output belongs to: `figure_label` against the block's label, id or address. */
export function figureBlockFor(expected: FidelityExpectation, figureLabel: string | null | undefined): FidelityBlock | null {
  if (!figureLabel) return null
  return expected.blocks.find((b) => FIDELITY_FIGURE_TYPES.has(b.type) && (b.artifactLabel === figureLabel || b.blockId === figureLabel || b.address === figureLabel)) ?? null
}

/**
 * FIDELITY on an SVG output (or the same-job SVG of a PNG): every spec label must appear in the figure's text.
 * Labels the engine wraps over several lines are matched with whitespace removed on both sides.
 */
export function checkSvgFidelity(
  svg: string,
  expected: FidelityExpectation,
  figureLabel: string | null | undefined,
  basis: VerifyBasis = "self",
  figureSpec?: unknown,
): VerifyCheck {
  const t0 = performance.now()
  const found = figureBlockFor(expected, figureLabel)
  if (!found) return unknown("SOURCE_MISSING", basis, t0, "no submitted figure block for this figure label")
  // A block whose spec is an artifact reference (`{ artifactId }`, doc.ts:467-479) carries no labels itself: the
  // caller passes the resolved spec, else the check cannot know what to expect (UNKNOWN, never a silent pass).
  const spec = (found.content as { spec?: unknown } | null)?.spec
  const isRef = !!spec && typeof spec === "object" && typeof (spec as { artifactId?: unknown }).artifactId === "string" && Object.keys(spec).length === 1
  if (isRef && (figureSpec === undefined || figureSpec === null)) return unknown("SOURCE_MISSING", basis, t0, "figure spec is an artifact reference and was not supplied")
  const b: FidelityBlock = isRef ? { ...found, content: { ...(found.content as object), spec: figureSpec } } : found
  let texts: string[]
  try {
    texts = svgTexts(svg)
  } catch {
    return unknown("PARSE_FAILED", basis, t0)
  }
  // SVG transform S1: case is folded. The engines set capitals on purpose (diagram role `upper`,
  // V/engine/diagram/core/svg.ts:104, :123: edge labels and key rows; chart tick labels such as "JAN").
  const joined = texts.join(" ").toUpperCase()
  const squeezed = joined.replace(/\s+/g, "")
  // SVG transform S2: series identity. Some chart styles draw no series name by design (one series:
  // engine/chart/family-w1/render.ts:244-245; `gallery` bump: family-w2/bump.ts:14, :158); the series is then
  // carried only by the engine's mark attribute `data-series` (V/contract/types/chart.ts:7). A series name counts as
  // present when drawn as text or carried there; a dropped series has neither.
  const seriesAttrs = new Set([...svg.matchAll(/\bdata-series="([^"]*)"/g)].map((m) => normalizeFidelityText(decodeEntities(m[1])).toUpperCase()))
  const col = new Collector()
  col.stats.blocks = 1
  for (const { label, forms, series } of figureSpecLabels(b.content)) {
    col.stats.segments++
    const up = forms.map((f) => f.toUpperCase())
    if (up.some((f) => joined.includes(f) || squeezed.includes(f.replace(/\s+/g, "")))) continue
    if (series && up.some((f) => seriesAttrs.has(f))) continue
    col.add(finding("LABEL_MISSING", b, `label not drawn: "${excerpt(label)}"`))
  }
  return result(col, basis, t0)
}

// ── Entry point used by the render wrapper (row 154) ─────────────────────────────────────────────────────────

export type FidelityFormat = "DOCX" | "PDF" | "HTML" | "SVG" | "PNG"

export interface FidelityInput {
  format: FidelityFormat
  /**
   * The bytes the check reads (§3.7): HTML -> the HTML output; PDF -> the same-job HTML; DOCX -> the DOCX output;
   * SVG -> the SVG output; PNG -> the same-job SVG of the same figure. null when that source does not exist.
   */
  source: Uint8Array | string | null
  expected: FidelityExpectation
  /** `output_file.figure_label` (SVG/PNG). */
  figureLabel?: string | null
  /** SVG/PNG: the resolved spec when the figure block references an artifact (`spec: { artifactId }`). */
  figureSpec?: unknown
}

const BASIS: Record<FidelityFormat, VerifyBasis> = { HTML: "self", PDF: "same-job-html", DOCX: "self", SVG: "self", PNG: "same-job-svg" }

/** Run FIDELITY for one output. Never throws: an internal error gives UNKNOWN VERIFY_INTERNAL. */
export function checkFidelity(input: FidelityInput): VerifyCheck {
  const t0 = performance.now()
  const basis = BASIS[input.format]
  if (input.source === null || input.source === undefined) return unknown("SOURCE_MISSING", basis, t0)
  try {
    const asText = () => (typeof input.source === "string" ? input.source : strFromU8(input.source as Uint8Array))
    switch (input.format) {
      case "HTML":
      case "PDF":
        return checkHtmlFidelity(asText(), input.expected, basis)
      case "DOCX":
        if (typeof input.source === "string") return unknown("PARSE_FAILED", basis, t0)
        return checkDocxFidelity(input.source, input.expected)
      case "SVG":
      case "PNG":
        return checkSvgFidelity(asText(), input.expected, input.figureLabel, basis, input.figureSpec)
    }
  } catch {
    return unknown("VERIFY_INTERNAL", basis, t0)
  }
  return unknown("VERIFY_INTERNAL", basis, t0)
}
