/**
 * Swarm 1.3.3 row 116 (ST-8, owner decision Q4 = U4): a framed SVG sheet (output of the bundled frame script
 * `gsp-diagram-standard/scripts/bingkai_lembar.py`) becomes a PNG image asset. Image blocks stay PNG/JPEG only
 * (`ImageV2`, `AssetInputV2`); the SVG is never stored as a document image, only the PNG made from it.
 *
 * Security: an SVG is code. It is accepted ONLY for this conversion and is parsed by a strict tokenizer before any
 * raster. Every unsafe construct is REFUSED BY NAME; nothing is stripped silently:
 *   - `<script>`, `<foreignObject>`, and every element outside a static SVG allowlist (`<a>`, `<set>`, `<animate*>`,
 *     `<feImage>`, `<iframe>` ...), and any prefixed (namespaced) element;
 *   - event-handler attributes (`on*`);
 *   - external references: `href` / `xlink:href` to anything but an internal `#id` (on every element) or an inline
 *     `data:image/png|jpeg;base64` URI (on `<image>` only); CSS `url()` (in `<style>`, `style=` and presentation
 *     attributes) to anything but `#id` or such a data URI; `xml:base`; namespace declarations other than SVG/XLink;
 *   - external stylesheets: `@import`, `<?xml-stylesheet?>` and every other processing instruction, CSS escape
 *     sequences (they could hide `url(` or `@import`), CSS image functions (`image-set()`, `image()`, `element()`,
 *     `cross-fade()`), legacy `expression()` / `-moz-binding` / `behavior`;
 *   - `<!DOCTYPE>` (and with it every entity declaration), `<!ENTITY>`, other `<!` declarations, and entity
 *     references other than the five XML ones and numeric character references;
 *   - size: see {@link SVG_INTAKE_LIMITS};
 *   - render cost (row 149, security L3): elements and `<use>` instances AFTER expansion, reference chain depth,
 *     reference cycles (refused), filter primitives, filtered elements, kernel (`stdDeviation`, `radius`) and region
 *     size. The engine raster also has its own timeout (30 s + 250 ms per label, at most 120 s, contract/env.ts).
 * The raster input is a RE-SERIALISATION of the validated tree (comments and the XML declaration dropped), so the
 * renderer sees exactly what was checked, not the original text (no parser differential).
 *
 * Placement (skill `references/cara_bingkai_lembar.md`): sheet width = figure width + 14 mm. The chosen block width
 * (row 149: compose's `figureWidthMm` for the document's template; without a document the A4 defaults `text` 128 mm,
 * `full` 166 mm, and the result says so) must hold the figure: a 142 mm sheet (128 mm figure)
 * prints at 128 mm (factor 0.90) or 166 mm; a 180 mm sheet (166 mm figure) at `text` is refused
 * `FIGURE_OVER_CAPACITY` (its 5.4 pt text would fall under the 5.5 pt floor), never shrunk silently.
 *
 * Raster: the engine's own `rasterizeSvg` (engine/browser, through the Swarm render bridge in Electron main; there is
 * no resvg/sharp in this package) at 300 dpi at the PRINTED size, so the PNG has the pixels of the printed width
 * (128 mm -> 1512 px, 166 mm -> 1961 px) and pHYs 300 dpi. Fonts: `rasterFontCss` embeds the Studio template faces
 * the SVG names (IBM Plex), so a sheet needs no `@font-face` of its own.
 */
import { rasterizeSvg } from "../../vendor/src/lib/studio/engine/browser"
import { FIGURE_WIDTH_VALUES } from "../../vendor/src/lib/studio/contract/schema/v2/common.schema"
import type { FigureWidthV2 } from "../../vendor/src/lib/studio/contract/types/v2/doc"
import type { ParamMap } from "../../vendor/src/lib/studio/contract"
import { figureWidthMm } from "../../vendor/src/lib/studio/services/compose"

/** Stated limits of the SVG intake. */
export const SVG_INTAKE_LIMITS = {
  /** SVG text, UTF-8 bytes (the frame script's sheets are 9-23 KB). */
  maxBytes: 2 * 1024 * 1024,
  /** Elements in the document. */
  maxElements: 20_000,
  /** Element nesting depth. */
  maxDepth: 64,
  /** Attributes on one element. */
  maxAttributes: 64,
  /** Characters in one attribute value (long path data). */
  maxAttrValueChars: 256 * 1024,
  /** Root width and height, mm (image `widthMm` <= 400 in `image.schema.ts`). */
  minSideMm: 10,
  maxSideMm: 400,
  // Swarm 1.3.3 row 149 (security L3): render cost after expansion, not only the element count of the text.
  /** Elements after expansion: every `<use>`, `href` and `url(#id)` reference counts the referenced subtree again. */
  maxExpandedElements: 50_000,
  /** `<use>` instances after expansion (a `<use>` of a `<use>` of ... counts every instance). */
  maxUseInstances: 2_000,
  /** Reference chain length (`<use>` -> `<use>` -> ... or `href` / `url(#id)` hops). A cycle is refused outright. */
  maxReferenceDepth: 16,
  /** Filter primitives (`fe*` except `feMergeNode`) in one `<filter>` and in the whole document. */
  maxFilterPrimitivesPerFilter: 16,
  maxFilterPrimitives: 64,
  /** Elements that draw through a filter, after expansion. */
  maxFilteredElements: 64,
  /** `stdDeviation` / `radius`: at most this share of the larger root viewBox side (0.02 of the box with primitiveUnits="objectBoundingBox"). */
  maxFilterKernelFraction: 0.02,
  /** Filter region and primitive subregion `width` / `height`: at most 3 x (box units, %, or the root viewBox side). */
  maxFilterRegionFactor: 3,
} as const

/** Frame script: sheet = figure + 2 x 7 mm (skill `cara_bingkai_lembar.md`, "lebar gambar + 14 mm"). */
export const FRAME_MARGIN_MM = 14
/** Tolerance on the figure-in-column check (rounding of the sheet width to 3 decimals). */
const FIT_TOLERANCE_MM = 0.5
/** dpi of the PNG; `rasterizeSvg` takes 300 only. */
export const SVG_RASTER_DPI = 300

export { FIGURE_WIDTH_VALUES }

export type SvgIntakeCode = "ASSET_TYPE_UNSUPPORTED" | "ASSET_TOO_LARGE" | "FIGURE_OVER_CAPACITY"

export class SvgIntakeRefusal extends Error {
  constructor(
    readonly code: SvgIntakeCode,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message)
    this.name = "SvgIntakeRefusal"
  }
}

const SVG_NS = "http://www.w3.org/2000/svg"
const XLINK_NS = "http://www.w3.org/1999/xlink"
const ALLOWED_NS: ReadonlySet<string> = new Set([SVG_NS, XLINK_NS])

/** Static SVG elements the Studio engine and the frame script draw with (case-sensitive, SVG is). */
const ALLOWED_ELEMENTS: ReadonlySet<string> = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "style",
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon",
  "text", "tspan", "textPath",
  "marker", "clipPath", "mask", "pattern", "linearGradient", "radialGradient", "stop", "image",
  "filter", "feGaussianBlur", "feOffset", "feFlood", "feComposite", "feMerge", "feMergeNode", "feBlend",
  "feColorMatrix", "feMorphology", "feDropShadow",
])
/** Named first so the refusal says what it is, whatever the case. */
const NAMED_FORBIDDEN: Readonly<Record<string, string>> = { script: "script element", foreignobject: "foreignObject element" }

const ID_REF_RE = /^#[A-Za-z_][\w.:-]*$/
const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=\s]+$/i
const NAME_RE = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/
const MM_RE = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*mm\s*$/

type El = { name: string; attrs: Array<[string, string]>; children: Node[] }
type Node = El | { text: string }

export interface SanitisedSvg {
  /** Re-serialised validated tree (raster input before placement). */
  svg: string
  widthMm: number
  heightMm: number
  viewBox: [number, number, number, number]
  elements: number
  /** Parsed root (for placement). */
  root: El
}

const clipTxt = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n)}...` : s)

function unsafe(construct: string, message?: string): never {
  throw new SvgIntakeRefusal("ASSET_TYPE_UNSUPPORTED", `SVG refused: ${message ?? construct} is not allowed; the SVG is not converted (nothing is stripped). Remove it and send the sheet again.`, {
    reason: "svg_unsafe",
    construct,
  })
}
function malformed(why: string): never {
  throw new SvgIntakeRefusal("ASSET_TYPE_UNSUPPORTED", `SVG refused: not a well-formed SVG document (${why})`, { reason: "svg_malformed", why })
}
function tooLarge(reason: string, message: string, extra: Record<string, unknown> = {}): never {
  throw new SvgIntakeRefusal("ASSET_TOO_LARGE", `SVG refused: ${message}`, { reason, ...extra })
}

const ENTITIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" }
function decodeEntities(s: string): string {
  return s.replace(/&([^;&\s]{0,32});?/g, (whole, name: string) => {
    if (!whole.endsWith(";")) malformed("bare '&'")
    if (name in ENTITIES) return ENTITIES[name]
    const num = /^#(?:x([0-9a-fA-F]{1,6})|(\d{1,7}))$/.exec(name)
    if (num) {
      const cp = num[1] !== undefined ? parseInt(num[1], 16) : parseInt(num[2], 10)
      if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) malformed(`character reference &${name};`)
      return String.fromCodePoint(cp)
    }
    return unsafe(`entity reference &${clipTxt(name, 32)};`)
  })
}

/** Strict tokenizer: one `<svg>` root, comments and a leading XML declaration only around it. */
function parse(text: string): { root: El; elements: number } {
  let s = text.replace(/^﻿/, "")
  let i = 0
  const n = s.length
  const ws = () => {
    while (i < n && /\s/.test(s[i])) i++
  }
  ws()
  if (s.startsWith("<?xml", i) && /\s|\?/.test(s[i + 5] ?? "")) {
    const end = s.indexOf("?>", i)
    if (end < 0) malformed("unterminated XML declaration")
    i = end + 2
  }
  const stack: El[] = []
  let root: El | null = null
  let elements = 0
  const push = (node: Node) => {
    const top = stack[stack.length - 1]
    if (top) top.children.push(node)
  }
  while (i < n) {
    const lt = s.indexOf("<", i)
    const textEnd = lt < 0 ? n : lt
    if (textEnd > i) {
      const raw = s.slice(i, textEnd)
      if (stack.length === 0) {
        if (raw.trim() !== "") malformed("text outside the root element")
      } else push({ text: decodeEntities(raw) })
      i = textEnd
      continue
    }
    // s[i] === "<"
    if (s.startsWith("<!--", i)) {
      const end = s.indexOf("-->", i + 4)
      if (end < 0) malformed("unterminated comment")
      i = end + 3
      continue
    }
    if (s.startsWith("<![CDATA[", i)) {
      if (stack.length === 0) malformed("CDATA outside the root element")
      const end = s.indexOf("]]>", i + 9)
      if (end < 0) malformed("unterminated CDATA section")
      push({ text: s.slice(i + 9, end) })
      i = end + 3
      continue
    }
    if (s.startsWith("<!", i)) {
      const word = /^<!([A-Za-z]*)/.exec(s.slice(i, i + 20))?.[1]?.toUpperCase() ?? ""
      if (word === "DOCTYPE") unsafe("DOCTYPE declaration", "a DOCTYPE declaration (and with it every entity declaration)")
      if (word === "ENTITY") unsafe("entity declaration")
      unsafe(`markup declaration <!${clipTxt(word, 20)}`)
    }
    if (s.startsWith("<?", i)) {
      const name = /^<\?([^\s?>]*)/.exec(s.slice(i, i + 64))?.[1] ?? ""
      unsafe(`processing instruction <?${clipTxt(name, 40)}`)
    }
    if (s.startsWith("</", i)) {
      const m = NAME_RE.exec(s.slice(i + 2, i + 2 + 256))
      if (!m) malformed("bad end tag")
      const close = s.indexOf(">", i)
      if (close < 0 || s.slice(i + 2 + m[0].length, close).trim() !== "") malformed("bad end tag")
      const top = stack.pop()
      if (!top || top.name !== m[0]) malformed(`end tag </${clipTxt(m[0], 40)}> does not match`)
      i = close + 1
      continue
    }
    // Start tag.
    const m = NAME_RE.exec(s.slice(i + 1, i + 1 + 256))
    if (!m) malformed("bad start tag")
    const name = m[0]
    if (stack.length === 0 && root !== null) malformed("more than one root element")
    if (stack.length === 0 && name !== "svg") malformed(`the root element is <${clipTxt(name, 40)}>, not <svg>`)
    checkElementName(name)
    i += 1 + name.length
    const attrs: Array<[string, string]> = []
    const seen = new Set<string>()
    let selfClose = false
    for (;;) {
      const before = i
      ws()
      if (i >= n) malformed("unterminated start tag")
      if (s[i] === ">") {
        i++
        break
      }
      if (s.startsWith("/>", i)) {
        i += 2
        selfClose = true
        break
      }
      if (i === before) malformed(`no space before an attribute of <${clipTxt(name, 40)}>`)
      const an = NAME_RE.exec(s.slice(i, i + 256))
      if (!an) malformed(`bad attribute in <${clipTxt(name, 40)}>`)
      i += an[0].length
      ws()
      if (s[i] !== "=") malformed(`attribute ${clipTxt(an[0], 40)} has no value`)
      i++
      ws()
      const q = s[i]
      if (q !== '"' && q !== "'") malformed(`attribute ${clipTxt(an[0], 40)} value is not quoted`)
      const end = s.indexOf(q, i + 1)
      if (end < 0) malformed("unterminated attribute value")
      const rawVal = s.slice(i + 1, end)
      if (rawVal.includes("<")) malformed(`'<' in attribute ${clipTxt(an[0], 40)}`)
      if (rawVal.length > SVG_INTAKE_LIMITS.maxAttrValueChars) {
        tooLarge("svg_attribute_too_long", `attribute ${clipTxt(an[0], 40)} is longer than ${SVG_INTAKE_LIMITS.maxAttrValueChars} characters`, { limit: SVG_INTAKE_LIMITS.maxAttrValueChars })
      }
      i = end + 1
      if (seen.has(an[0])) malformed(`duplicate attribute ${clipTxt(an[0], 40)}`)
      seen.add(an[0])
      attrs.push([an[0], decodeEntities(rawVal)])
      if (attrs.length > SVG_INTAKE_LIMITS.maxAttributes) {
        tooLarge("svg_too_many_attributes", `<${clipTxt(name, 40)}> has more than ${SVG_INTAKE_LIMITS.maxAttributes} attributes`, { limit: SVG_INTAKE_LIMITS.maxAttributes })
      }
    }
    const el: El = { name, attrs, children: [] }
    if (++elements > SVG_INTAKE_LIMITS.maxElements) {
      tooLarge("svg_too_many_elements", `more than ${SVG_INTAKE_LIMITS.maxElements} elements`, { limit: SVG_INTAKE_LIMITS.maxElements })
    }
    if (stack.length === 0) {
      if (name !== "svg") malformed(`the root element is <${clipTxt(name, 40)}>, not <svg>`)
      root = el
    } else push(el)
    for (const [an, av] of attrs) checkAttribute(name, an, av)
    if (!selfClose) {
      stack.push(el)
      if (stack.length > SVG_INTAKE_LIMITS.maxDepth) {
        tooLarge("svg_too_deep", `elements nested deeper than ${SVG_INTAKE_LIMITS.maxDepth}`, { limit: SVG_INTAKE_LIMITS.maxDepth })
      }
    }
  }
  if (stack.length > 0) malformed(`<${clipTxt(stack[stack.length - 1].name, 40)}> is not closed`)
  if (!root) malformed("no <svg> root element")
  // Style element bodies: CSS rules.
  const walk = (e: El) => {
    if (e.name === "style") checkCss(e.children.map((c) => ("text" in c ? c.text : "")).join(""), "<style>")
    if (e.name === "style" && e.children.some((c) => !("text" in c))) unsafe("element inside <style>")
    for (const c of e.children) if (!("text" in c)) walk(c)
  }
  walk(root)
  s = ""
  return { root, elements }
}

function checkElementName(name: string): void {
  const named = NAMED_FORBIDDEN[name.toLowerCase()]
  if (named) unsafe(named)
  if (name.includes(":")) unsafe(`namespaced element <${clipTxt(name, 40)}>`)
  if (!ALLOWED_ELEMENTS.has(name)) unsafe(`element <${clipTxt(name, 40)}>`)
}

function checkReference(attr: string, value: string, el: string): void {
  const v = value.trim()
  if (ID_REF_RE.test(v)) return
  if (el === "image" && DATA_IMAGE_RE.test(v)) return
  unsafe(`external reference ${attr}`, `external reference ${attr}="${clipTxt(v, 60)}" (only an internal #id, or a data:image/png|jpeg URI on <image>)`)
}

function checkAttribute(el: string, name: string, value: string): void {
  const lower = name.toLowerCase()
  if (/^on/.test(lower)) unsafe(`event-handler attribute ${clipTxt(name, 40)}`)
  if (lower === "xmlns" || lower.startsWith("xmlns:")) {
    if (!ALLOWED_NS.has(value.trim())) unsafe(`namespace ${clipTxt(value.trim(), 80)}`)
    return
  }
  if (lower === "href" || lower.endsWith(":href")) {
    if (lower !== "href" && lower !== "xlink:href") unsafe(`attribute ${clipTxt(name, 40)}`)
    checkReference(name, value, el)
    return
  }
  if (lower === "xml:base") unsafe("xml:base", "xml:base (an external base URI)")
  if (name.includes(":")) {
    const prefix = lower.split(":")[0]
    if (prefix !== "xml" && prefix !== "xlink") unsafe(`attribute ${clipTxt(name, 40)}`)
  }
  if (/javascript\s*:/i.test(value)) unsafe("javascript: URL", `a javascript: URL in ${clipTxt(name, 40)}`)
  if (lower === "style") checkCss(value, `style attribute of <${el}>`)
  else if (/url\s*\(/i.test(value)) checkCss(value, `attribute ${name} of <${el}>`)
}

const CSS_FUNCS_FORBIDDEN = ["image-set", "-webkit-image-set", "image", "element", "-moz-element", "cross-fade", "-webkit-cross-fade", "expression"]

function checkCss(css: string, where: string): void {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, " ")
  if (body.includes("\\")) unsafe("CSS escape sequence", `a CSS escape sequence in ${where} (it can hide url( or @import)`)
  if (/@import/i.test(body)) unsafe("@import", `@import in ${where} (external stylesheet)`)
  if (/-moz-binding|\bbehavior\s*:/i.test(body)) unsafe("CSS binding", `a CSS binding in ${where}`)
  for (const m of body.matchAll(/([A-Za-z-]+)\s*\(/g)) {
    const fn = m[1].toLowerCase()
    if (CSS_FUNCS_FORBIDDEN.includes(fn)) unsafe(`CSS function ${fn}()`, `CSS function ${fn}() in ${where}`)
  }
  for (const m of body.matchAll(/url\s*\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi)) {
    const target = (m[1] ?? m[2] ?? m[3] ?? "").trim()
    if (ID_REF_RE.test(target) || DATA_IMAGE_RE.test(target)) continue
    unsafe("external reference url()", `external reference url(${clipTxt(target, 70)}) in ${where} (only url(#id) or a data:image/png|jpeg URI)`)
  }
  if (/url\s*\(/i.test(body.replace(/url\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, ""))) unsafe("external reference url()", `an unterminated url( in ${where}`)
}

const attrOf = (e: El, name: string) => e.attrs.find(([k]) => k === name)?.[1]

const URL_ID_RE = /url\s*\(\s*["']?#([^"')\s]+)["']?\s*\)/gi
const isEl = (n: Node): n is El => !("text" in n)

/**
 * Row 149 (security L3): bound what the rasteriser would draw, not only what the text holds. A billion-laughs sheet of
 * nested `<use>` is a few hundred elements of text and billions of drawn elements; a huge blur or morphology kernel is
 * one attribute. Every refusal names its reason and states the limit; all checks run on the parsed tree in linear time
 * (memoised per element), so a refusal is immediate whatever the expansion would have been.
 */
function checkRenderCost(root: El, viewBox: readonly number[]): void {
  const L = SVG_INTAKE_LIMITS
  const all: El[] = []
  const parentOf = new Map<El, El>()
  const stack: El[] = [root]
  while (stack.length > 0) {
    const e = stack.pop() as El
    all.push(e)
    for (const c of e.children) if (isEl(c)) {
      parentOf.set(c, e)
      stack.push(c)
    }
  }
  const byId = new Map<string, El>()
  for (const e of all) {
    const id = attrOf(e, "id")
    if (id !== undefined && !byId.has(id)) byId.set(id, e)
  }

  // References an element makes: `href` / `xlink:href` (#id) and `url(#id)` in any attribute (style= included).
  const refsOf = (e: El): El[] => {
    const out: El[] = []
    for (const [k, v] of e.attrs) {
      const lower = k.toLowerCase()
      if (lower === "href" || lower === "xlink:href") {
        const m = /^\s*#(.+?)\s*$/.exec(v)
        const t = m ? byId.get(m[1]) : undefined
        if (t) out.push(t)
        continue
      }
      for (const m of v.matchAll(URL_ID_RE)) {
        const t = byId.get(m[1])
        if (t) out.push(t)
      }
    }
    return out
  }
  // `url(#id)` in a <style> rule applies to elements the intake cannot resolve (selectors): counted below as if the
  // rule hit every element of the sheet (worst case), so no reference escapes the expansion caps.
  const styleTargets: El[] = []
  for (const e of all) {
    if (e.name !== "style") continue
    const css = e.children.map((c) => ("text" in c ? c.text : "")).join("")
    for (const m of css.matchAll(URL_ID_RE)) {
      const t = byId.get(m[1])
      if (t) styleTargets.push(t)
    }
  }

  // Expanded cost, memoised: elements, <use> instances and filtered elements below e, references included.
  type Cost = { elements: number; uses: number; filtered: number; hops: number }
  const done = new Map<El, Cost>()
  const visiting = new Set<El>()
  const cost = (e: El, depth: number): Cost => {
    const known = done.get(e)
    if (known) return known
    if (visiting.has(e)) {
      const id = attrOf(e, "id") ?? "?"
      throw new SvgIntakeRefusal("ASSET_TYPE_UNSUPPORTED", `SVG refused: <${clipTxt(e.name, 40)} id="${clipTxt(id, 40)}"> is referenced from inside itself (a <use>, href or url(#id) cycle); recursion is not allowed.`, {
        reason: "svg_reference_cycle",
        element: e.name,
        id,
      })
    }
    if (depth > L.maxReferenceDepth) {
      tooLarge("svg_reference_too_deep", `a chain of more than ${L.maxReferenceDepth} references (<use> of <use> ..., href or url(#id))`, { limit: L.maxReferenceDepth })
    }
    visiting.add(e)
    const c: Cost = { elements: 1, uses: e.name === "use" ? 1 : 0, filtered: /url\s*\(/i.test(attrOf(e, "filter") ?? "") ? 1 : 0, hops: 0 }
    const add = (x: Cost, hop: number) => {
      c.elements += x.elements
      c.uses += x.uses
      c.filtered += x.filtered
      c.hops = Math.max(c.hops, x.hops + hop)
    }
    for (const ch of e.children) if (isEl(ch)) add(cost(ch, depth), 0)
    for (const t of refsOf(e)) add(cost(t, depth + 1), 1)
    visiting.delete(e)
    // `hops` is memoised with the element, so the chain is measured whatever order the definitions come in.
    if (c.hops > L.maxReferenceDepth) {
      tooLarge("svg_reference_too_deep", `a chain of more than ${L.maxReferenceDepth} references (<use> of <use> ..., href or url(#id))`, { limit: L.maxReferenceDepth })
    }
    if (c.elements > L.maxExpandedElements) {
      tooLarge("svg_expansion_too_large", `the sheet expands to more than ${L.maxExpandedElements} drawn elements (each <use>, href and url(#id) counts the referenced elements again)`, { limit: L.maxExpandedElements })
    }
    if (c.uses > L.maxUseInstances) {
      tooLarge("svg_use_too_many", `more than ${L.maxUseInstances} <use> instances after expansion (a <use> of a <use> counts every instance)`, { limit: L.maxUseInstances })
    }
    if (c.filtered > L.maxFilteredElements) {
      tooLarge("svg_filter_too_many_uses", `more than ${L.maxFilteredElements} elements drawn through a filter after expansion`, { limit: L.maxFilteredElements })
    }
    done.set(e, c)
    return c
  }
  // Per-element recursion is bounded: tree depth <= maxDepth, reference hops <= maxReferenceDepth.
  const total = { ...cost(root, 0) }
  for (const t of styleTargets) {
    const c = cost(t, 1)
    total.elements += c.elements * all.length
    total.uses += c.uses * all.length
    total.filtered += c.filtered * all.length
  }
  if (styleTargets.length > 0) {
    if (total.elements > L.maxExpandedElements) {
      tooLarge("svg_expansion_too_large", `the sheet expands to more than ${L.maxExpandedElements} drawn elements (a url(#id) in <style> is counted once per element of the sheet)`, { limit: L.maxExpandedElements })
    }
    if (total.uses > L.maxUseInstances) {
      tooLarge("svg_use_too_many", `more than ${L.maxUseInstances} <use> instances after expansion (a url(#id) in <style> is counted once per element of the sheet)`, { limit: L.maxUseInstances })
    }
    if (total.filtered > L.maxFilteredElements) {
      tooLarge("svg_filter_too_many_uses", `more than ${L.maxFilteredElements} elements drawn through a filter after expansion (a url(#id) in <style> is counted once per element of the sheet)`, { limit: L.maxFilteredElements })
    }
  }

  // Filters: primitive count, kernel size, region size.
  const vbSide = Math.max(viewBox[2], viewBox[3])
  let primitives = 0
  const regionCheck = (e: El, bbox: boolean) => {
    for (const k of ["width", "height"]) {
      const raw = attrOf(e, k)
      if (raw === undefined) continue
      const pct = /^\s*([+-]?\d*\.?\d+(?:e[+-]?\d+)?)\s*%\s*$/i.exec(raw)
      const v = pct ? Number(pct[1]) / 100 : Number(raw)
      const cap = pct || bbox ? L.maxFilterRegionFactor : L.maxFilterRegionFactor * vbSide
      if (!Number.isFinite(v) || Math.abs(v) > cap) {
        tooLarge("svg_filter_region_too_large", `<${e.name}> ${k}="${clipTxt(raw, 30)}" exceeds the filter region limit (${L.maxFilterRegionFactor} x the ${pct || bbox ? "element box" : "viewBox side"})`, {
          limit: L.maxFilterRegionFactor,
          element: e.name,
          attribute: k,
        })
      }
    }
  }
  for (const f of all) {
    if (f.name !== "filter") continue
    regionCheck(f, (attrOf(f, "filterUnits") ?? "objectBoundingBox").trim() === "objectBoundingBox")
    const primBox = (attrOf(f, "primitiveUnits") ?? "userSpaceOnUse").trim() === "objectBoundingBox"
    const kernelCap = primBox ? L.maxFilterKernelFraction : L.maxFilterKernelFraction * vbSide
    const prims = f.children.filter(isEl).filter((c) => c.name.startsWith("fe") && c.name !== "feMergeNode")
    if (prims.length > L.maxFilterPrimitivesPerFilter) {
      tooLarge("svg_filter_too_many_primitives", `a <filter> has ${prims.length} primitives (limit ${L.maxFilterPrimitivesPerFilter} per filter)`, { limit: L.maxFilterPrimitivesPerFilter, count: prims.length })
    }
    primitives += prims.length
    for (const p of prims) {
      regionCheck(p, primBox)
      for (const k of ["stdDeviation", "radius"]) {
        const raw = attrOf(p, k)
        if (raw === undefined) continue
        const nums = raw.trim().split(/[\s,]+/).filter((x) => x !== "").map(Number)
        if (nums.some((x) => !Number.isFinite(x) || x > kernelCap)) {
          tooLarge("svg_filter_kernel_too_large", `<${p.name}> ${k}="${clipTxt(raw, 30)}" exceeds ${round3(kernelCap)} (${L.maxFilterKernelFraction * 100}% of the ${primBox ? "element box" : "larger viewBox side"})`, {
            limit: round3(kernelCap),
            element: p.name,
            attribute: k,
          })
        }
      }
    }
  }
  // A primitive outside a <filter> draws nothing, but counts toward the document total all the same.
  primitives += all.filter((e) => e.name.startsWith("fe") && e.name !== "feMergeNode" && parentOf.get(e)?.name !== "filter").length
  if (primitives > L.maxFilterPrimitives) {
    tooLarge("svg_filter_too_many_primitives", `${primitives} filter primitives in the sheet (limit ${L.maxFilterPrimitives})`, { limit: L.maxFilterPrimitives, count: primitives })
  }
}

/** Parse and validate; throws {@link SvgIntakeRefusal}. */
export function sanitiseSvg(text: string): SanitisedSvg {
  if (typeof text !== "string" || text.trim() === "") malformed("empty input")
  const bytes = Buffer.byteLength(text, "utf8")
  if (bytes > SVG_INTAKE_LIMITS.maxBytes) tooLarge("svg_too_large", `${bytes} B exceeds the ${SVG_INTAKE_LIMITS.maxBytes} B SVG limit`, { bytes, limit: SVG_INTAKE_LIMITS.maxBytes })
  const { root, elements } = parse(text)
  const w = MM_RE.exec(attrOf(root, "width") ?? "")
  const h = MM_RE.exec(attrOf(root, "height") ?? "")
  if (!w || !h) {
    throw new SvgIntakeRefusal("ASSET_TYPE_UNSUPPORTED", 'SVG refused: the root <svg> must state width and height in mm (the frame script writes width="142.000mm")', { reason: "svg_size_units" })
  }
  const widthMm = Number(w[1])
  const heightMm = Number(h[1])
  const vb = (attrOf(root, "viewBox") ?? "").trim().split(/[\s,]+/).filter((x) => x !== "").map(Number)
  if (vb.length !== 4 || vb.some((x) => !Number.isFinite(x)) || vb[2] <= 0 || vb[3] <= 0) {
    throw new SvgIntakeRefusal("ASSET_TYPE_UNSUPPORTED", "SVG refused: the root <svg> needs a viewBox of four numbers with a positive width and height", { reason: "svg_viewbox_missing" })
  }
  const { minSideMm, maxSideMm } = SVG_INTAKE_LIMITS
  if (!(widthMm >= minSideMm && widthMm <= maxSideMm && heightMm >= minSideMm && heightMm <= maxSideMm)) {
    tooLarge("svg_dimensions", `sheet ${widthMm} x ${heightMm} mm is outside ${minSideMm}..${maxSideMm} mm per side`, { widthMm, heightMm, minSideMm, maxSideMm })
  }
  checkRenderCost(root, vb)
  return { svg: serialise(root), widthMm, heightMm, viewBox: vb as [number, number, number, number], elements, root }
}

const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const escAttr = (s: string) => escText(s).replace(/"/g, "&quot;")

function serialise(e: El, rootOverride?: Record<string, string>): string {
  const attrs = e.attrs.map(([k, v]) => [k, rootOverride && k in rootOverride ? rootOverride[k] : v] as const)
  const head = `<${e.name}${attrs.map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("")}`
  if (e.children.length === 0) return `${head}/>`
  return `${head}>${e.children.map((c) => ("text" in c ? escText(c.text) : serialise(c))).join("")}</${e.name}>`
}

const round3 = (x: number) => Math.round(x * 1000) / 1000

/**
 * Row 149 (senior S10): where the column width came from. `document-template`: compose's own `figureWidthMm` over the
 * document's template parameters (the same function and keys compose uses for the image block, so intake and print
 * agree for any template). `a4-default`: the image is not tied to a document yet, so the registry defaults are used
 * (A4 DATUM: text 128 mm, full 166 mm) and the result says so.
 */
export type FigureWidthSource = "document-template" | "a4-default"
export interface FigureColumns {
  text: number
  full: number
  source: FigureWidthSource
}

/** Column widths from compose for the given template parameters (none: the registry's A4 defaults). */
export function figureColumns(params?: ParamMap): FigureColumns {
  const p = params ?? {}
  return { text: figureWidthMm("image", p, "text"), full: figureWidthMm("image", p, "full"), source: params ? "document-template" : "a4-default" }
}

/**
 * Printed size at the chosen block width. The sheet's figure (sheet - 14 mm) must fit the column; else
 * `FIGURE_OVER_CAPACITY` (refused, not shrunk). Returns the raster input with the root size set to the printed mm.
 * `columns` (row 149): the document template's widths from {@link figureColumns}; absent = A4 defaults.
 */
export function placeFramedSvg(
  s: SanitisedSvg,
  width: FigureWidthV2,
  columns: FigureColumns = figureColumns(),
): { svg: string; widthMm: number; heightMm: number; figureWidthMm: number; columnMm: number; widthSource: FigureWidthSource } {
  if (!(FIGURE_WIDTH_VALUES as readonly string[]).includes(width)) {
    throw new SvgIntakeRefusal("ASSET_TYPE_UNSUPPORTED", `width must be one of ${FIGURE_WIDTH_VALUES.join(", ")}`, { reason: "width_invalid" })
  }
  const columnMm = columns[width]
  const figureWidthMm = round3(s.widthMm - FRAME_MARGIN_MM)
  if (figureWidthMm > columnMm + FIT_TOLERANCE_MM) {
    const hint =
      width === "text" && columns.full > columns.text
        ? ` Place it with width "full" (${columns.full} mm), or frame a ${columns.text} mm figure (${round3(columns.text + FRAME_MARGIN_MM)} mm sheet) for the text column.`
        : ` Frame a figure of at most ${columns.full} mm (${round3(columns.full + FRAME_MARGIN_MM)} mm sheet).`
    throw new SvgIntakeRefusal(
      "FIGURE_OVER_CAPACITY",
      `framed sheet ${s.widthMm} mm holds a ${figureWidthMm} mm figure, which does not fit width "${width}" (${columnMm} mm column); it is refused, not shrunk.${hint}`,
      { reason: "framed_sheet_too_wide", sheetWidthMm: s.widthMm, figureWidthMm, width, columnMm, frameMarginMm: FRAME_MARGIN_MM, widthSource: columns.source },
    )
  }
  const widthMm = columnMm
  const heightMm = round3((s.heightMm * columnMm) / s.widthMm)
  if (heightMm > SVG_INTAKE_LIMITS.maxSideMm) {
    tooLarge("svg_dimensions", `printed height ${heightMm} mm exceeds ${SVG_INTAKE_LIMITS.maxSideMm} mm`, { heightMm, maxSideMm: SVG_INTAKE_LIMITS.maxSideMm })
  }
  return { svg: serialise(s.root, { width: `${widthMm}mm`, height: `${heightMm}mm` }), widthMm, heightMm, figureWidthMm, columnMm, widthSource: columns.source }
}

export interface FramedSvgPng {
  png: Uint8Array
  dpi: number
  width: FigureWidthV2
  sheetWidthMm: number
  sheetHeightMm: number
  widthMm: number
  heightMm: number
  /** Row 149: `document-template` (compose's width for the document's template) or `a4-default` (no document). */
  widthSource: FigureWidthSource
}

export type SvgRasterizer = (svg: string, i: { widthMm: number; heightMm: number; dpi: 300 }) => Promise<Uint8Array>

/** Sanitise, place at `width`, rasterise at 300 dpi. Throws {@link SvgIntakeRefusal} or the raster's own error. */
export async function framedSvgToPng(text: string, width: FigureWidthV2, opts: { rasterize?: SvgRasterizer; templateParams?: ParamMap } = {}): Promise<FramedSvgPng> {
  const s = sanitiseSvg(text)
  const p = placeFramedSvg(s, width, figureColumns(opts.templateParams))
  const rasterize = opts.rasterize ?? ((svg, i) => rasterizeSvg(svg, i))
  const png = await rasterize(p.svg, { widthMm: p.widthMm, heightMm: p.heightMm, dpi: SVG_RASTER_DPI })
  return { png, dpi: SVG_RASTER_DPI, width, sheetWidthMm: s.widthMm, sheetHeightMm: s.heightMm, widthMm: p.widthMm, heightMm: p.heightMm, widthSource: p.widthSource }
}

/** Input check for the `svg` + `width` pair (tool and route). Returns a message, or null when valid. */
export function svgInputProblem(svg: unknown, width: unknown): { pointer: string; message: string } | null {
  if (typeof svg !== "string" || svg.trim() === "") return { pointer: "/svg", message: "svg must be the SVG text of a framed sheet" }
  if (width === undefined) return { pointer: "/width", message: `width is required with svg: one of ${FIGURE_WIDTH_VALUES.join(", ")} (the image block must use the same width)` }
  if (typeof width !== "string" || !(FIGURE_WIDTH_VALUES as readonly string[]).includes(width)) return { pointer: "/width", message: `width must be one of ${FIGURE_WIDTH_VALUES.join(", ")}` }
  return null
}
