// Row 203: PDF text for models that take no PDF input (GSP AI declares ["text","image"], no "pdf").
//
// A small, dependency-free text extractor: indirect objects (direct and in object streams), the page tree,
// FlateDecode / ASCIIHex / ASCII85 streams (node:zlib only), ToUnicode CMaps (bfchar / bfrange), simple-font
// WinAnsi bytes, the text operators Tj TJ ' " and line breaks from Td TD T* Tm, and Form XObjects.
// It is best effort: layout, tables and pictures are not kept, encrypted files and scanned pages yield no text.
// No page images: the repository has no PDF rasteriser (no pdf.js / mupdf / poppler dependency, and the DATUM
// render bridge renders HTML, not PDF), so a model that takes images still gets text only, and the note says so.

import { inflateSync, constants as zlibConstants } from "node:zlib"

type Name = { n: string }
type Ref = { r: number }
type Str = { s: string }
type Op = { op: string }
type Dict = { d: Map<string, Value> }
type Value = number | boolean | null | Name | Ref | Str | Dict | Op | Value[]

type PdfObject = { value: Value; stream?: string }

export const MAX_PDF_BYTES = 64 * 1024 * 1024
export const MAX_PDF_TEXT_CHARS = 120_000
const MAX_DEPTH = 32
const MAX_FORM_DEPTH = 4
const MAX_RANGE = 65_536

export type PdfText =
  | { ok: true; pages: string[]; pageCount: number }
  | { ok: false; reason: "encrypted" | "unreadable" | "too-large" }

const isName = (v: unknown): v is Name => typeof v === "object" && v !== null && "n" in v
const isRef = (v: unknown): v is Ref => typeof v === "object" && v !== null && "r" in v
const isStr = (v: unknown): v is Str => typeof v === "object" && v !== null && "s" in v
const isDict = (v: unknown): v is Dict => typeof v === "object" && v !== null && "d" in v
const isOp = (v: unknown): v is Op => typeof v === "object" && v !== null && "op" in v

const WS = new Set([0, 9, 10, 12, 13, 32])
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)))

class Lexer {
  pos: number
  constructor(
    readonly src: string,
    pos = 0,
    readonly content = false,
  ) {
    this.pos = pos
  }

  skip() {
    const s = this.src
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (WS.has(c)) this.pos++
      else if (c === 37) {
        while (this.pos < s.length && s[this.pos] !== "\n" && s[this.pos] !== "\r") this.pos++
      } else break
    }
  }

  word() {
    const s = this.src
    const start = this.pos
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos)
      if (WS.has(c) || DELIM.has(c)) break
      this.pos++
    }
    return s.slice(start, this.pos)
  }

  /** The next value or (in a content stream) operator; undefined at the end or on `]` / `>>`. */
  next(depth = 0): Value | undefined {
    if (depth > MAX_DEPTH) throw new Error("pdf: nesting too deep")
    this.skip()
    const s = this.src
    if (this.pos >= s.length) return undefined
    const c = s[this.pos]
    if (c === "<" && s[this.pos + 1] === "<") {
      this.pos += 2
      const d = new Map<string, Value>()
      for (;;) {
        this.skip()
        if (this.pos >= s.length) break
        if (s[this.pos] === ">" && s[this.pos + 1] === ">") {
          this.pos += 2
          break
        }
        const key = this.next(depth + 1)
        // Every undefined return has already moved past what it read, so a stray token cannot loop forever.
        if (!isName(key)) continue
        const value = this.next(depth + 1)
        if (value === undefined) break
        d.set(key.n, value)
      }
      return { d }
    }
    if (c === "<") {
      const end = s.indexOf(">", this.pos)
      const hex = s.slice(this.pos + 1, end === -1 ? s.length : end).replace(/[^0-9a-fA-F]/g, "")
      this.pos = end === -1 ? s.length : end + 1
      return { s: hexToLatin1(hex) }
    }
    if (c === "[") {
      this.pos++
      const out: Value[] = []
      for (;;) {
        this.skip()
        if (this.pos >= s.length) break
        if (s[this.pos] === "]") {
          this.pos++
          break
        }
        const v = this.next(depth + 1)
        if (v !== undefined) out.push(v)
      }
      return out
    }
    if (c === "(") return { s: this.literal() }
    if (c === "/") {
      this.pos++
      return { n: this.word().replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }
    }
    if (c === "]" || c === ">" || c === ")" || c === "{" || c === "}") {
      this.pos++
      return this.content ? { op: c } : undefined
    }
    const w = this.word()
    if (w === "") {
      this.pos++
      return undefined
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      const num = parseFloat(w)
      if (!this.content && /^\d+$/.test(w)) {
        const save = this.pos
        const m = /^\s+(\d+)\s+R(?=[\s\/\[\]<>()%]|$)/.exec(s.slice(this.pos, this.pos + 24))
        if (m) {
          this.pos += m[0].length
          return { r: num }
        }
        this.pos = save
      }
      return num
    }
    if (w === "true") return true
    if (w === "false") return false
    if (w === "null") return null
    return { op: w }
  }

  literal() {
    const s = this.src
    this.pos++
    let depth = 1
    let out = ""
    while (this.pos < s.length) {
      const c = s[this.pos++]
      if (c === "\\") {
        const e = s[this.pos++]
        if (e === undefined) break
        if (e === "n") out += "\n"
        else if (e === "r") out += "\r"
        else if (e === "t") out += "\t"
        else if (e === "b") out += "\b"
        else if (e === "f") out += "\f"
        else if (e === "\r") {
          if (s[this.pos] === "\n") this.pos++
        } else if (e === "\n") {
          // line continuation
        } else if (e >= "0" && e <= "7") {
          let oct = e
          while (oct.length < 3 && s[this.pos] >= "0" && s[this.pos] <= "7") oct += s[this.pos++]
          out += String.fromCharCode(parseInt(oct, 8) & 0xff)
        } else out += e
        continue
      }
      if (c === "(") depth++
      if (c === ")" && --depth === 0) break
      out += c
    }
    return out
  }
}

function hexToLatin1(hex: string) {
  const h = hex.length % 2 ? hex + "0" : hex
  let out = ""
  for (let i = 0; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16))
  return out
}

function get(dict: Value | undefined, key: string): Value | undefined {
  return isDict(dict) ? dict.d.get(key) : undefined
}

// ---- streams ----------------------------------------------------------------------------------------------------

function inflate(data: string) {
  const buf = Buffer.from(data, "latin1")
  try {
    return inflateSync(buf).toString("latin1")
  } catch {
    // A truncated or slightly damaged stream: keep what inflates.
    return inflateSync(buf, { finishFlush: zlibConstants.Z_SYNC_FLUSH }).toString("latin1")
  }
}

function asciiHex(data: string) {
  const end = data.indexOf(">")
  return hexToLatin1((end === -1 ? data : data.slice(0, end)).replace(/[^0-9a-fA-F]/g, ""))
}

function ascii85(data: string) {
  let s = data.replace(/\s+/g, "")
  if (s.startsWith("<~")) s = s.slice(2)
  const end = s.indexOf("~>")
  if (end !== -1) s = s.slice(0, end)
  let out = ""
  let group: number[] = []
  const flush = (n: number) => {
    while (group.length < 5) group.push(84)
    let v = 0
    for (const g of group) v = v * 85 + g
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
    out += String.fromCharCode(...bytes.slice(0, n))
    group = []
  }
  for (const ch of s) {
    if (ch === "z" && group.length === 0) {
      out += "\0\0\0\0"
      continue
    }
    const code = ch.charCodeAt(0) - 33
    if (code < 0 || code > 84) continue
    group.push(code)
    if (group.length === 5) flush(4)
  }
  if (group.length > 1) flush(group.length - 1)
  return out
}

function decodeStream(obj: PdfObject, resolve: (v: Value | undefined) => Value | undefined): string | undefined {
  if (obj.stream === undefined) return undefined
  const filter = resolve(get(obj.value, "Filter"))
  const filters = (Array.isArray(filter) ? filter : filter === undefined || filter === null ? [] : [filter])
    .map((f) => resolve(f))
    .filter(isName)
    .map((f) => f.n)
  let data = obj.stream
  for (const f of filters) {
    if (f === "FlateDecode" || f === "Fl") data = inflate(data)
    else if (f === "ASCIIHexDecode" || f === "AHx") data = asciiHex(data)
    else if (f === "ASCII85Decode" || f === "A85") data = ascii85(data)
    else return undefined
  }
  return data
}

// ---- document -----------------------------------------------------------------------------------------------------

class Doc {
  readonly objects = new Map<number, PdfObject>()

  constructor(readonly src: string) {
    const re = /(\d+)\s+(\d+)\s+obj\b/g
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      try {
        const lex = new Lexer(src, m.index + m[0].length)
        const value = lex.next()
        if (value === undefined) continue
        lex.skip()
        let stream: string | undefined
        if (src.startsWith("stream", lex.pos)) {
          let p = lex.pos + 6
          if (src[p] === "\r" && src[p + 1] === "\n") p += 2
          else if (src[p] === "\n" || src[p] === "\r") p++
          const length = get(value, "Length")
          let end = -1
          if (typeof length === "number" && length >= 0 && /^\s*endstream/.test(src.slice(p + length, p + length + 24)))
            end = p + length
          if (end === -1) {
            const idx = src.indexOf("endstream", p)
            end = idx === -1 ? src.length : idx
            if (src[end - 1] === "\n") end--
            if (src[end - 1] === "\r") end--
          }
          stream = src.slice(p, end)
          re.lastIndex = Math.max(re.lastIndex, end)
        }
        this.objects.set(Number(m[1]), { value, stream })
      } catch {
        // a damaged object: skip it
      }
    }
    for (const obj of [...this.objects.values()]) {
      const type = get(obj.value, "Type")
      if (!isName(type) || type.n !== "ObjStm") continue
      try {
        const data = decodeStream(obj, (v) => this.resolve(v))
        const n = this.resolve(get(obj.value, "N"))
        const first = this.resolve(get(obj.value, "First"))
        if (data === undefined || typeof n !== "number" || typeof first !== "number") continue
        const head = new Lexer(data, 0, true)
        const pairs: number[] = []
        for (let i = 0; i < n * 2; i++) {
          const v = head.next()
          if (typeof v !== "number") break
          pairs.push(v)
        }
        for (let i = 0; i + 1 < pairs.length; i += 2) {
          if (this.objects.has(pairs[i])) continue
          const value = new Lexer(data, first + pairs[i + 1]).next()
          if (value !== undefined) this.objects.set(pairs[i], { value })
        }
      } catch {
        // a damaged object stream: skip it
      }
    }
  }

  resolve(v: Value | undefined, depth = 0): Value | undefined {
    if (isRef(v) && depth < MAX_DEPTH) return this.resolve(this.objects.get(v.r)?.value, depth + 1)
    return v
  }

  object(v: Value | undefined): PdfObject | undefined {
    if (isRef(v)) return this.objects.get(v.r)
    return undefined
  }

  encrypted() {
    return /\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(this.src)
  }

  /** Pages in document order with their inherited Resources. */
  pages(): Array<{ page: Dict; resources: Value | undefined }> {
    const out: Array<{ page: Dict; resources: Value | undefined }> = []
    let catalog: Value | undefined
    for (const obj of this.objects.values()) {
      const type = get(obj.value, "Type")
      if (isName(type) && type.n === "Catalog") catalog = obj.value
    }
    const seen = new Set<Value>()
    const walk = (node: Value | undefined, resources: Value | undefined, depth: number) => {
      const n = this.resolve(node)
      if (!isDict(n) || seen.has(n) || depth > MAX_DEPTH) return
      seen.add(n)
      const res = n.d.get("Resources") ?? resources
      const kids = this.resolve(n.d.get("Kids"))
      if (Array.isArray(kids)) {
        for (const kid of kids) walk(kid, res, depth + 1)
        return
      }
      const type = n.d.get("Type")
      if (!isName(type) || type.n === "Page") out.push({ page: n, resources: res })
    }
    if (catalog) walk(get(catalog, "Pages"), undefined, 0)
    if (out.length > 0) return out
    // No usable page tree: every Page object in object-number order.
    return [...this.objects.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, obj]) => obj.value)
      .filter((v): v is Dict => isDict(v) && isName(v.d.get("Type")) && (v.d.get("Type") as Name).n === "Page")
      .map((page) => ({ page, resources: page.d.get("Resources") }))
  }
}

// ---- fonts --------------------------------------------------------------------------------------------------------

const WIN_ANSI: Record<number, string> = {
  0x80: "€",
  0x82: "‚",
  0x83: "ƒ",
  0x84: "„",
  0x85: "…",
  0x86: "†",
  0x87: "‡",
  0x88: "ˆ",
  0x89: "‰",
  0x8a: "Š",
  0x8b: "‹",
  0x8c: "Œ",
  0x8e: "Ž",
  0x91: "‘",
  0x92: "’",
  0x93: "“",
  0x94: "”",
  0x95: "•",
  0x96: "–",
  0x97: "—",
  0x98: "˜",
  0x99: "™",
  0x9a: "š",
  0x9b: "›",
  0x9c: "œ",
  0x9e: "ž",
  0x9f: "Ÿ",
}

const GLYPHS: Record<string, string> = {
  space: " ",
  period: ".",
  comma: ",",
  hyphen: "-",
  colon: ":",
  semicolon: ";",
  quoteright: "’",
  quoteleft: "‘",
  quotedblleft: "“",
  quotedblright: "”",
  endash: "–",
  emdash: "—",
  bullet: "•",
  ellipsis: "…",
  parenleft: "(",
  parenright: ")",
  slash: "/",
  fi: "fi",
  fl: "fl",
  zero: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
}

type Font = {
  ranges: Array<{ len: number; lo: number; hi: number }>
  map?: Map<number, string>
  differences?: Map<number, string>
  /** Glyph widths in 1/1000 em; undefined when the font gives none (then advances are unknown). */
  widths?: Map<number, number>
  missingWidth: number
}

function utf16be(bytes: string) {
  let out = ""
  for (let i = 0; i + 1 < bytes.length; i += 2)
    out += String.fromCharCode((bytes.charCodeAt(i) << 8) | bytes.charCodeAt(i + 1))
  return out
}

function parseCMap(text: string): { ranges: Font["ranges"]; map: Map<number, string> } {
  const ranges: Font["ranges"] = []
  const map = new Map<number, string>()
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const r of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g))
      ranges.push({ len: Math.ceil(r[1].length / 2), lo: parseInt(r[1], 16), hi: parseInt(r[2], 16) })
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const r of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g))
      map.set(parseInt(r[1], 16), utf16be(hexToLatin1(r[2])))
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = parseInt(r[1], 16)
      const hi = Math.min(parseInt(r[2], 16), lo + MAX_RANGE)
      if (r[3].startsWith("[")) {
        const items = [...r[3].matchAll(/<([0-9a-fA-F]*)>/g)]
        items.forEach((item, i) => lo + i <= hi && map.set(lo + i, utf16be(hexToLatin1(item[1]))))
        continue
      }
      const base = utf16be(hexToLatin1(r[3].slice(1, -1)))
      if (base.length === 0) continue
      const head = base.slice(0, -1)
      const last = base.charCodeAt(base.length - 1)
      for (let code = lo; code <= hi; code++) map.set(code, head + String.fromCharCode(last + code - lo))
    }
  }
  return { ranges, map }
}

function loadFont(doc: Doc, ref: Value | undefined): Font {
  const font = doc.resolve(ref)
  const subtype = doc.resolve(get(font, "Subtype"))
  const composite = isName(subtype) && subtype.n === "Type0"
  const fallback: Font["ranges"] = [composite ? { len: 2, lo: 0, hi: 0xffff } : { len: 1, lo: 0, hi: 0xff }]
  const toUnicode = doc.object(get(font, "ToUnicode"))
  let parsed: ReturnType<typeof parseCMap> | undefined
  if (toUnicode) {
    try {
      const text = decodeStream(toUnicode, (v) => doc.resolve(v))
      if (text) parsed = parseCMap(text)
    } catch {
      parsed = undefined
    }
  }
  let differences: Map<number, string> | undefined
  const encoding = doc.resolve(get(font, "Encoding"))
  const diffs = doc.resolve(get(encoding, "Differences"))
  if (Array.isArray(diffs)) {
    differences = new Map()
    let code = 0
    for (const item of diffs) {
      if (typeof item === "number") code = item
      else if (isName(item)) {
        const g = item.n
        const uni = /^uni([0-9A-Fa-f]{4})$/.exec(g)
        const ch = uni ? String.fromCharCode(parseInt(uni[1], 16)) : g.length === 1 ? g : GLYPHS[g]
        if (ch !== undefined) differences.set(code, ch)
        code++
      }
    }
  }
  const metrics = composite ? cidWidths(doc, font) : simpleWidths(doc, font)
  return {
    ranges: parsed && parsed.ranges.length > 0 ? parsed.ranges.sort((a, b) => a.len - b.len) : fallback,
    map: parsed?.map,
    differences,
    widths: metrics.widths,
    missingWidth: metrics.missing,
  }
}

/** A CIDFont's /W array (`c [w1 w2 ...]` or `cFirst cLast w`) and /DW. */
function cidWidths(doc: Doc, font: Value | undefined) {
  const descendants = doc.resolve(get(font, "DescendantFonts"))
  const cid = doc.resolve(Array.isArray(descendants) ? descendants[0] : undefined)
  const dw = doc.resolve(get(cid, "DW"))
  const w = doc.resolve(get(cid, "W"))
  const widths = new Map<number, number>()
  if (Array.isArray(w)) {
    let i = 0
    while (i < w.length) {
      const first = doc.resolve(w[i])
      const next = doc.resolve(w[i + 1])
      if (typeof first !== "number") break
      if (Array.isArray(next)) {
        next.forEach((x, k) => {
          const v = doc.resolve(x)
          if (typeof v === "number") widths.set(first + k, v)
        })
        i += 2
        continue
      }
      const width = doc.resolve(w[i + 2])
      if (typeof next === "number" && typeof width === "number")
        for (let c = first; c <= Math.min(next, first + MAX_RANGE); c++) widths.set(c, width)
      i += 3
    }
  }
  return { widths, missing: typeof dw === "number" ? dw : 1000 }
}

/** A simple font's /FirstChar + /Widths; none for a standard-14 font that leaves them out. */
function simpleWidths(doc: Doc, font: Value | undefined) {
  const first = doc.resolve(get(font, "FirstChar"))
  const list = doc.resolve(get(font, "Widths"))
  const missing = doc.resolve(get(doc.resolve(get(font, "FontDescriptor")), "MissingWidth"))
  if (typeof first !== "number" || !Array.isArray(list)) return { widths: undefined, missing: 0 }
  const widths = new Map<number, number>()
  list.forEach((x, k) => {
    const v = doc.resolve(x)
    if (typeof v === "number") widths.set(first + k, v)
  })
  return { widths, missing: typeof missing === "number" ? missing : 0 }
}

/** The text of a string operand and its advance in 1/1000 em (undefined when the font has no widths). */
function decodeText(font: Font | undefined, bytes: string): { text: string; width?: number } {
  if (!font) return { text: [...bytes].map((c) => WIN_ANSI[c.charCodeAt(0)] ?? c).join("") }
  let out = ""
  let width = 0
  let i = 0
  while (i < bytes.length) {
    let len = font.ranges[0].len
    let code = -1
    for (const r of font.ranges) {
      if (i + r.len > bytes.length) continue
      let c = 0
      for (let k = 0; k < r.len; k++) c = (c << 8) | bytes.charCodeAt(i + k)
      if (c >= r.lo && c <= r.hi) {
        len = r.len
        code = c
        break
      }
    }
    if (code === -1) {
      code = 0
      for (let k = 0; k < len && i + k < bytes.length; k++) code = (code << 8) | bytes.charCodeAt(i + k)
    }
    i += len
    width += font.widths?.get(code) ?? font.missingWidth
    const mapped = font.map?.get(code) ?? font.differences?.get(code)
    if (mapped !== undefined) out += mapped
    else if (!font.map && len === 1) out += WIN_ANSI[code] ?? String.fromCharCode(code)
  }
  return { text: out, width: font.widths ? width : undefined }
}

// ---- content ------------------------------------------------------------------------------------------------------

function pageText(doc: Doc, contents: string[], resources: Value | undefined): string {
  const lines: string[] = []
  let cur = ""
  const newline = () => {
    if (cur) lines.push(cur)
    cur = ""
  }
  const space = () => {
    if (cur && !cur.endsWith(" ")) cur += " "
  }
  const fontCache = new Map<Value, Font>()
  // Text position, approximately in page space: the line origin (Tm, Td), where the next glyph goes (undefined
  // when a font without widths made it unknown), where the last drawn text ended, and on which line it was.
  const pos = {
    lineX: 0,
    lineY: 0,
    x: 0 as number | undefined,
    end: undefined as number | undefined,
    drawnY: undefined as number | undefined,
    moved: false,
  }
  const text = { size: 0, scale: 1, leading: 0, font: undefined as Font | undefined }

  const draw = (bytes: string) => {
    const decoded = decodeText(text.font, bytes)
    if (pos.drawnY !== undefined && Math.abs(pos.lineY - pos.drawnY) > 0.5) newline()
    else if (pos.x !== undefined && pos.end !== undefined) {
      // Glyphs placed one by one (Skia writes a Td per glyph): a space only where the gap is wider than kerning.
      const gap = pos.x - pos.end
      if (gap > 0.2 * text.size * text.scale || gap < -text.size * text.scale) space()
    } else if (pos.moved) space()
    cur += decoded.text
    pos.x =
      pos.x === undefined || decoded.width === undefined
        ? undefined
        : pos.x + (decoded.width / 1000) * text.size * text.scale
    pos.end = pos.x
    pos.drawnY = pos.lineY
    pos.moved = false
  }
  const moveTo = (x: number, y: number) => {
    pos.lineX = x
    pos.lineY = y
    pos.x = x
    pos.moved = true
  }

  const run = (content: string, res: Value | undefined, depth: number, visited: Set<number>) => {
    const fonts = doc.resolve(get(doc.resolve(res), "Font"))
    const xobjects = doc.resolve(get(doc.resolve(res), "XObject"))
    const lex = new Lexer(content, 0, true)
    let stack: Value[] = []
    for (;;) {
      const t = lex.next()
      if (t === undefined) {
        if (lex.pos >= content.length) break
        continue
      }
      if (!isOp(t)) {
        stack.push(t)
        continue
      }
      const args = stack
      stack = []
      const num = (i: number) => (typeof args[i] === "number" ? (args[i] as number) : 0)
      switch (t.op) {
        case "BI": {
          const id = content.indexOf("ID", lex.pos)
          const ei = id === -1 ? -1 : content.slice(id + 2).search(/\sEI(?=\s|$)/)
          lex.pos = id === -1 || ei === -1 ? content.length : id + 2 + ei + 3
          break
        }
        case "BT":
          moveTo(0, 0)
          text.scale = 1
          break
        case "Tf": {
          const name = args[0]
          text.size = num(1)
          const ref = isName(name) ? get(fonts, name.n) : undefined
          if (ref === undefined) {
            text.font = undefined
            break
          }
          const key = (isRef(ref) ? ref.r : ref) as Value
          const cached = fontCache.get(key) ?? loadFont(doc, ref)
          fontCache.set(key, cached)
          text.font = cached
          break
        }
        case "TL":
          text.leading = num(0)
          break
        case "Td":
        case "TD":
          if (t.op === "TD") text.leading = -num(1)
          moveTo(pos.lineX + num(0) * text.scale, pos.lineY + num(1) * text.scale)
          break
        case "Tm":
          text.scale = Math.hypot(num(0), num(1)) || 1
          moveTo(num(4), num(5))
          break
        case "T*":
          moveTo(pos.lineX, pos.lineY - (text.leading || text.size || 1) * text.scale)
          break
        case "'":
        case '"': {
          moveTo(pos.lineX, pos.lineY - (text.leading || text.size || 1) * text.scale)
          const s = args[args.length - 1]
          if (isStr(s)) draw(s.s)
          break
        }
        case "Tj": {
          const s = args[0]
          if (isStr(s)) draw(s.s)
          break
        }
        case "TJ": {
          const arr = args[0]
          if (!Array.isArray(arr)) break
          for (const item of arr) {
            if (isStr(item)) draw(item.s)
            if (typeof item !== "number") continue
            if (pos.x !== undefined) pos.x -= (item / 1000) * text.size * text.scale
            if (item < -250) space()
          }
          break
        }
        case "Do": {
          if (depth >= MAX_FORM_DEPTH) break
          const name = args[0]
          const ref = isName(name) ? get(xobjects, name.n) : undefined
          if (!isRef(ref) || visited.has(ref.r)) break
          const obj = doc.objects.get(ref.r)
          const subtype = get(obj?.value, "Subtype")
          if (!obj || !isName(subtype) || subtype.n !== "Form") break
          const data = decodeStream(obj, (v) => doc.resolve(v))
          if (data !== undefined) run(data, get(obj.value, "Resources") ?? res, depth + 1, new Set([...visited, ref.r]))
          break
        }
      }
    }
  }

  run(contents.join("\n"), resources, 0, new Set())
  newline()
  return lines
    .map((l) => l.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim()
}

/** The text of each page of a PDF, best effort. Never throws. */
export function extractPdfText(bytes: Uint8Array): PdfText {
  if (bytes.byteLength > MAX_PDF_BYTES) return { ok: false, reason: "too-large" }
  try {
    const doc = new Doc(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1"))
    if (doc.encrypted()) return { ok: false, reason: "encrypted" }
    const pages = doc.pages()
    if (pages.length === 0) return { ok: false, reason: "unreadable" }
    const texts = pages.map(({ page, resources }) => {
      try {
        const contents = doc.resolve(page.d.get("Contents"))
        const refs = Array.isArray(contents) ? contents : [page.d.get("Contents")]
        const streams = refs
          .map((r) => doc.object(r))
          .filter((o): o is PdfObject => o !== undefined)
          .map((o) => decodeStream(o, (v) => doc.resolve(v)) ?? "")
        return pageText(doc, streams, resources)
      } catch {
        return ""
      }
    })
    return { ok: true, pages: texts, pageCount: texts.length }
  } catch {
    return { ok: false, reason: "unreadable" }
  }
}

/**
 * What a model without PDF input is given in place of a PDF: a note saying what Swarm did, then the text with
 * page markers. `images` is whether the model takes images (said in the note: no page images are made).
 */
export function pdfTextForModel(bytes: Uint8Array, input: { filename?: string; images: boolean; maxChars?: number }) {
  const name = input.filename ? `"${input.filename}"` : "this PDF"
  const result = extractPdfText(bytes)
  const noImages = input.images
    ? " No page images were added: Swarm has no PDF page renderer, so pictures, charts and scanned pages are not visible."
    : ""
  if (!result.ok) {
    const why =
      result.reason === "encrypted"
        ? "it is encrypted (password-protected)"
        : result.reason === "too-large"
          ? `it is larger than ${MAX_PDF_BYTES / 1024 / 1024} MB`
          : "its structure could not be read"
    return `[PDF ${name}: this model does not take PDF files and Swarm could not extract its text because ${why}. Tell the user, and suggest a text, DOCX or image version of the document.]`
  }
  const limit = input.maxChars ?? MAX_PDF_TEXT_CHARS
  const parts: string[] = []
  let used = 0
  let shown = 0
  for (let i = 0; i < result.pages.length; i++) {
    const block = `--- Page ${i + 1} of ${result.pageCount} ---\n${result.pages[i] || "(no text on this page)"}`
    if (used + block.length > limit && shown > 0) break
    parts.push(block.length > limit ? block.slice(0, limit) : block)
    used += block.length
    shown++
  }
  const empty = result.pages.every((p) => p.trim() === "")
  const header =
    `[PDF ${name}: this model does not take PDF files, so Swarm extracted the text of its ${result.pageCount} page(s) below.` +
    ` Layout, tables and pictures may be lost.${noImages}` +
    (empty
      ? " No text layer was found (likely a scanned document): tell the user the content cannot be read this way."
      : "") +
    (shown < result.pageCount ? ` Text shown for pages 1-${shown} only (length limit).` : "") +
    "]"
  return [header, ...parts].join("\n\n")
}
