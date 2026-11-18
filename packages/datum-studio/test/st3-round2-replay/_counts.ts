// Swarm 1.3.3 row 49 (ST-3 acceptance): the four structural counts of the round-2 replay, on one emitted SVG.
//
// Reused, not rewritten:
//   (2) labels on hatch      -> row 41's checker `labelOnHatch` (test/st3-hatch-behind-text/_overlap.ts), imported as is.
//   (1) text glyph boxes      -> row 41's `parse` (same file): every text line with its glyph box from the engine's own
//                                fit metric, transforms applied, in paint order.
//   (3) edge label on border  -> the rule rows 42 and 135 both use (identical in the two test files, which cannot be
//                                imported because importing a test file registers its tests): a zone frame is the
//                                dashed `fill="none"` rect without `data-node`; an edge-label band is the filled rect
//                                without a `stroke` attribute drawn right before a middle-anchored text; a band counts
//                                when a frame side runs through its inside (print tolerance 0.01 mm).
//   (4) letter case           -> row 43's rule: an edge label must equal some printed `<text>` character for character
//                                (on its connector or as a numbered note row); a key row must be contained, with runs of
//                                spaces squashed, in the printed key (a key line may wrap).
// New here, because no earlier row measured it: (1) a foot row (KUNCI / KEY / SUMBER / SOURCE line and its wrapped
// lines, row 40's definition: texts at x = 0 from the first such line down, the caption excluded) is struck when a
// drawn stroke (line, connector or outline path, polyline or polygon edge, side of a stroked rect) crosses its glyph
// box for more than 0.05 mm (row 41's MIN_VISIBLE_MM). Row 40 checked a stronger property (every foot row starts below
// every drawn element); that clearance is reported here as a separate, informative number.
import { MIN_VISIBLE_MM, labelOnHatch, parse } from "../st3-hatch-behind-text/_overlap"

type J = Record<string, any>
type Box = [number, number, number, number]
type P = [number, number]

const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
const unesc = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#160;|&nbsp;/g, " ").replace(/&amp;/g, "&")
const squash = (s: string): string => s.replace(/\s+/g, " ").trim()
const PRINT_TOL = 0.01
const FOOT_HEAD = /^(KUNCI|KEY|SUMBER|SOURCE)\b/

/** Parameter interval of segment a-b inside box r (Liang-Barsky), null when it misses. */
function clipLen(a: P, b: P, r: Box): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  let t0 = 0
  let t1 = 1
  for (const [p, q] of [[-dx, a[0] - r[0]], [dx, r[2] - a[0]], [-dy, a[1] - r[1]], [dy, r[3] - a[1]]] as const) {
    if (Math.abs(p) < 1e-12) {
      if (q < 0) return 0
      continue
    }
    const t = q / p
    if (p < 0) t0 = Math.max(t0, t)
    else t1 = Math.min(t1, t)
  }
  return t1 > t0 ? (t1 - t0) * Math.hypot(dx, dy) : 0
}

/** Every drawn stroke of the figure as segments (outside <defs> and clip paths), with the element it came from. */
export function strokes(svg: string): Array<{ a: P; b: P; el: string }> {
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "").replace(/<clipPath\b[\s\S]*?<\/clipPath>/g, "")
  const out: Array<{ a: P; b: P; el: string }> = []
  const tfStack: Array<[number, number]> = []
  const off = (): [number, number] => tfStack.reduce<[number, number]>((acc, t) => [acc[0] + t[0], acc[1] + t[1]], [0, 0])
  const re = /<g\b([^>]*)>|<\/g>|<line\b([^>]*)\/>|<rect\b([^>]*)\/>|<path\b([^>]*)\/>|<(?:polyline|polygon)\b([^>]*)\/>/g
  let first = true
  for (let m = re.exec(body); m; m = re.exec(body)) {
    if (m[0] === "</g>") { tfStack.pop(); continue }
    if (m[1] !== undefined) {
      const t = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)/.exec(attrs(m[1]).transform ?? "")
      // a scaled group is a symbol badge: its strokes are part of the node, not lines across the sheet
      tfStack.push(t && !/scale\(/.test(attrs(m[1]).transform ?? "") ? [+t[1], +t[2]] : [0, 0])
      continue
    }
    const [ox, oy] = off()
    const el = m[0].slice(0, 160)
    const add = (a: P, b: P) => out.push({ a: [a[0] + ox, a[1] + oy], b: [b[0] + ox, b[1] + oy], el })
    if (m[2] !== undefined) {
      const a = attrs(m[2])
      if (a.stroke === "none") continue
      add([+a.x1, +a.y1], [+a.x2, +a.y2])
    } else if (m[3] !== undefined) {
      const a = attrs(m[3])
      if (first) { first = false; continue } // paper
      if (a.stroke === undefined || a.stroke === "none" || +(a["stroke-width"] ?? 1) === 0) continue
      const x0 = +a.x, y0 = +a.y, x1 = x0 + +a.width, y1 = y0 + +a.height
      add([x0, y0], [x1, y0]); add([x1, y0], [x1, y1]); add([x1, y1], [x0, y1]); add([x0, y1], [x0, y0])
    } else if (m[4] !== undefined) {
      const a = attrs(m[4])
      if (a.stroke === "none" || a.stroke === undefined) continue
      // absolute M/L/H/V/Z polylines; curves (A/Q/C) are taken through their coordinate pairs (a chord approximation)
      const toks = (a.d ?? "").match(/[A-Za-z]|-?\d+(?:\.\d+)?/g) ?? []
      let cmd = "M"
      let cur: P | null = null
      let start: P | null = null
      for (let i = 0; i < toks.length; ) {
        if (/[A-Za-z]/.test(toks[i])) { cmd = toks[i++]; if (cmd === "Z" || cmd === "z") { if (cur && start) add(cur, start); cur = start } continue }
        if (cmd === "H") { const p: P = [+toks[i++], cur ? cur[1] : 0]; if (cur) add(cur, p); cur = p; continue }
        if (cmd === "V") { const p: P = [cur ? cur[0] : 0, +toks[i++]]; if (cur) add(cur, p); cur = p; continue }
        if (cmd === "A") { i += 5 }
        const p: P = [+toks[i++], +toks[i++]]
        if (cmd === "M") { cur = p; start = p; cmd = "L"; continue }
        if (cur) add(cur, p)
        cur = p
      }
    } else if (m[5] !== undefined) {
      const a = attrs(m[5])
      if (a.stroke === "none" || a.stroke === undefined) continue
      const pts = (a.points ?? "").trim().split(/\s+/).map((s) => s.split(",").map(Number) as P)
      for (let i = 1; i < pts.length; i++) add(pts[i - 1], pts[i])
      if (m[0].startsWith("<polygon") && pts.length > 2) add(pts[pts.length - 1], pts[0])
    }
  }
  return out
}

export interface FootRow { text: string; box: Box }
/** The foot rows the SVG draws (KUNCI / KEY / SUMBER / SOURCE lines and their wrapped lines), row 40's definition. */
export function footRows(svg: string): FootRow[] {
  const texts = parse(svg).texts.filter((t) => !t.text.startsWith("symbol "))
  const atZero = texts.filter((t) => attrs(t.el).x === "0" && !t.el.includes("data-st-caption"))
  const heads = atZero.filter((t) => FOOT_HEAD.test(t.text))
  if (!heads.length) return []
  const first = Math.min(...heads.map((t) => t.y0))
  return atZero.filter((t) => t.y0 >= first - 1e-6).map((t) => ({ text: t.text, box: [t.x0, t.y0, t.x1, t.y1] as Box }))
}

export interface Struck { text: string; by: string; mm: number }
/** (1) Foot rows whose glyph box a drawn stroke crosses for more than MIN_VISIBLE_MM. */
export function struckFootRows(svg: string): Struck[] {
  const rows = footRows(svg)
  if (!rows.length) return []
  const segs = strokes(svg)
  const out: Struck[] = []
  for (const r of rows) {
    let worst = { mm: 0, by: "" }
    for (const s of segs) {
      const len = clipLen(s.a, s.b, r.box)
      if (len > worst.mm) worst = { mm: len, by: s.el }
    }
    if (worst.mm > MIN_VISIBLE_MM) out.push({ text: r.text, by: worst.by, mm: Number(worst.mm.toFixed(2)) })
  }
  return out
}
/** Informative (row 40's property): drawn strokes that reach below the top of the first foot row. */
export function footClearance(svg: string): number {
  const rows = footRows(svg)
  if (!rows.length) return 0
  const top = Math.min(...rows.map((r) => r.box[1]))
  return strokes(svg).filter((s) => Math.max(s.a[1], s.b[1]) > top + PRINT_TOL).length
}

/** (2) Text lines or symbol badges on a visible accent hatch: row 41's checker. */
export const onHatch = (svg: string): string[] => labelOnHatch(svg).map((h) => `${h.text} (${h.visibleMm} mm)`)

/** (3) Edge-label bands a zone frame side runs through: the rule of rows 42 and 135. */
export function edgeLabelsOnBorder(svg: string): string[] {
  const els = [...svg.matchAll(/<(rect|text|line|path)\b([^>]*?)(\/>|>([\s\S]*?)<\/text>)/g)].map((m) => ({ tag: m[1], a: attrs(m[2]), c: (m[4] ?? "").replace(/<[^>]+>/g, "") }))
  const zones: Box[] = []
  const bands: Array<{ box: Box; text: string }> = []
  els.forEach((e, i) => {
    if (e.tag === "rect" && e.a.fill === "none" && e.a["stroke-dasharray"] && !e.a["data-node"]) zones.push([+e.a.x, +e.a.y, +e.a.x + +e.a.width, +e.a.y + +e.a.height])
    const n = els[i + 1]
    if (e.tag === "rect" && e.a.fill && e.a.fill !== "none" && e.a.stroke === undefined && !e.a["data-node"] && n && n.tag === "text" && n.a["text-anchor"] === "middle") {
      bands.push({ box: [+e.a.x, +e.a.y, +e.a.x + +e.a.width, +e.a.y + +e.a.height], text: unesc(n.c) })
    }
  })
  const sides = (z: Box): Box[] => [[z[0], z[1], z[2], z[1]], [z[2], z[1], z[2], z[3]], [z[0], z[3], z[2], z[3]], [z[0], z[1], z[0], z[3]]]
  const through = (s: Box, r: Box) => s[2] > r[0] + PRINT_TOL && s[0] < r[2] - PRINT_TOL && s[3] > r[1] + PRINT_TOL && s[1] < r[3] - PRINT_TOL
  return bands.filter((b) => zones.some((z) => sides(z).some((s) => through(s, b.box)))).map((b) => b.text)
}

/** Printed text of every `<text>` in document order; a wrapped text (tspans) is its lines joined by one space (row 43). */
export function svgTexts(svg: string): string[] {
  return (svg.match(/<text\b[^>]*>[\s\S]*?<\/text>/g) ?? []).map((t) => unesc(t.replace(/<\/tspan>\s*<tspan/g, "</tspan> <tspan").replace(/<[^>]+>/g, "")))
}
/** The key the SVG prints: from the line that opens with the key word up to the source line, joined (row 43). */
export function svgKey(svg: string, keyWord: string): string {
  const all = svgTexts(svg)
  const at = all.findIndex((t) => t.startsWith(`${keyWord}  `))
  if (at < 0) return ""
  const out: string[] = []
  for (let i = at; i < all.length; i++) {
    if (i > at && /^(SUMBER|SOURCE)\b/.test(all[i])) break
    out.push(all[i])
  }
  return out.join(" ")
}

export interface CaseResult { labels: number; keyRows: number; mismatches: string[] }
/**
 * (4) Letter case. Edge labels: each spec label equals some printed text exactly. Key rows (only when the SVG prints a
 * key): each spec row, or its document-language wording (`wording(row)`: the engine's edge-kind word swap, which keeps
 * the author's text after `=`), is contained in the squashed printed key.
 */
export function caseMismatches(spec: J, svg: string, keyWord: string, wording: (row: string) => string): CaseResult {
  const printed = svgTexts(svg)
  const r: CaseResult = { labels: 0, keyRows: 0, mismatches: [] }
  for (const e of (spec.edges ?? []) as J[]) {
    if (e.label === undefined || String(e.label).trim() === "") continue
    r.labels++
    if (!printed.includes(String(e.label))) r.mismatches.push(`edge "${e.label}"`)
  }
  const key = squash(svgKey(svg, keyWord))
  if (key) for (const row of (spec.legend ?? []) as string[]) {
    r.keyRows++
    if (!key.includes(squash(row)) && !key.includes(squash(wording(row)))) r.mismatches.push(`key "${row}"`)
  }
  return r
}

/** Key rows of the page KUNCI row (HTML text of the document's key row), same containment rule. */
export function pageKeyMismatches(rows: string[], html: string, wording: (row: string) => string): string[] {
  const text = squash(unesc(html.replace(/<[^>]+>/g, " ")))
  return rows.filter((row) => !text.includes(squash(row)) && !text.includes(squash(wording(row)))).map((row) => `page key "${row}"`)
}
