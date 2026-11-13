// DATUM render bridge: page images of an HTML render (row 151b, decision C130 GAP-1, output verification spec §11).
// Pure; no Electron import. The Electron side is electron-renderer.ts `pagePngs`, the op is dispatch.ts `pagePng`.
//
// How a page image is made (print emulation + per-page clip, no PDF rasteriser needed):
//   1. the HTML is loaded in the check window (page script off, V8 on for CDP Runtime.evaluate only);
//   2. CDP Emulation.setEmulatedMedia {media:"print"} applies the document's print CSS;
//   3. PAGE_LAYOUT_SCRIPT (fixed text owned by the bridge, never sent by a caller) reads the CSS @page size,
//      then returns one rectangle per page:
//        - "paged": the top-level `.page` / `[data-page]` elements (Studio's own HTML, html/base/markup.ts:241,
//          same page convention as Studio's MEASURE_SCRIPT, engine/browser/measure.ts:11);
//        - "flow": no page elements; the document is cut at the @page height at the @page width, and forced
//          breaks (break-before / break-after: page) are honoured by pushing the element to the next page top;
//   4. CDP Page.captureScreenshot with that rectangle as clip, at PAGE_PNG_DPI (deviceScaleFactor dpi/96). Chromium truncates the fractional
//      CSS clip first, so A4 at 150 dpi is 1239 x 1753 px (793 x 1122 css px), A5 873 x 1239 px.

import { deflateSync, inflateSync } from "node:zlib"
import { MAX_MM, MAX_PAGE_IMAGES, MAX_PAGE_INDEX } from "./protocol"

export { MAX_PAGE_IMAGES, MAX_PAGE_INDEX, PAGE_PNG_DPI, PAGE_PNG_MAX_DPI, PAGE_PNG_MIN_DPI } from "./protocol"
export const A4_MM = { wMm: 210, hMm: 297 } as const

export type PageSizeMm = { wMm: number; hMm: number }
export type PageRect = { x: number; y: number; w: number; h: number }
export type PageLayout = { layout: "paged" | "flow"; pageCount: number; rects: PageRect[] }

const KEYWORD_MM: Record<string, PageSizeMm> = {
  a5: { wMm: 148, hMm: 210 },
  a4: { wMm: 210, hMm: 297 },
  a3: { wMm: 297, hMm: 420 },
  b5: { wMm: 176, hMm: 250 },
  b4: { wMm: 250, hMm: 353 },
  "jis-b5": { wMm: 182, hMm: 257 },
  "jis-b4": { wMm: 257, hMm: 364 },
  letter: { wMm: 215.9, hMm: 279.4 },
  legal: { wMm: 215.9, hMm: 355.6 },
  ledger: { wMm: 279.4, hMm: 431.8 },
}

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, q: 0.25, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96 }

function lengthMm(token: string): number | null {
  const m = /^([0-9]*\.?[0-9]+)(mm|cm|q|in|pt|pc|px)$/.exec(token)
  if (!m) return null
  const v = parseFloat(m[1]) * UNIT_MM[m[2]]
  return v > 0 && v <= MAX_MM ? Math.round(v * 1000) / 1000 : null
}

/**
 * The CSS `size` value of an @page rule in mm (CSS Paged Media §7.1): `<length>{1,2}`, a page-size keyword with
 * an optional orientation, or an orientation alone (A4 then). `auto`, an unknown keyword or a bad length: null.
 */
export function parsePageSize(value: string | null | undefined): PageSizeMm | null {
  if (typeof value !== "string") return null
  const tokens = value.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || tokens.length > 2) return null
  let orientation: "portrait" | "landscape" | undefined
  const rest: string[] = []
  for (const t of tokens) {
    if (t === "portrait" || t === "landscape") {
      if (orientation) return null
      orientation = t
    } else rest.push(t)
  }
  let size: PageSizeMm | null
  if (rest.length === 0) size = orientation ? { ...A4_MM } : null
  else if (rest.length === 1 && KEYWORD_MM[rest[0]]) size = { ...KEYWORD_MM[rest[0]] }
  else if (orientation) return null
  else {
    const lens = rest.map(lengthMm)
    if (lens.some((l) => l === null)) return null
    size = { wMm: lens[0]!, hMm: (lens[1] ?? lens[0])! }
  }
  if (!size) return null
  if (orientation === "landscape" && size.wMm < size.hMm) size = { wMm: size.hMm, hMm: size.wMm }
  if (orientation === "portrait" && size.wMm > size.hMm) size = { wMm: size.hMm, hMm: size.wMm }
  return size
}

/** Which pages get an image: the requested ones that exist, else the first MAX_PAGE_IMAGES pages. */
export function selectPages(pageCount: number, requested: readonly number[] | null | undefined): number[] {
  if (requested && requested.length > 0) return [...new Set(requested)].filter((n) => n >= 1 && n <= pageCount).sort((a, b) => a - b)
  const out: number[] = []
  for (let n = 1; n <= Math.min(pageCount, MAX_PAGE_IMAGES); n++) out.push(n)
  return out
}

/** Width and height of a PNG from its IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString("latin1", 12, 16) !== "IHDR") {
    throw new Error("not a PNG")
  }
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}

/** 1.2.7 N-5 (N7-066): page images are witnesses of the printed page (an approximation), never deliverables. */
export const PAGE_WITNESS_PREFIX = "witness-"
export const pageFileName = (n: number) => `${PAGE_WITNESS_PREFIX}p${String(n).padStart(3, "0")}.png`

/** Validate what the page script returned (it runs inside an untrusted document). */
export function readLayout(raw: unknown): PageLayout {
  const o = raw as { layout?: unknown; pageCount?: unknown; rects?: unknown }
  if (!o || typeof o !== "object") throw new Error("page layout script returned nothing")
  if (o.layout !== "paged" && o.layout !== "flow") throw new Error("page layout script returned no layout")
  const pageCount = o.pageCount
  if (typeof pageCount !== "number" || !Number.isInteger(pageCount) || pageCount < 1) throw new Error("page count is not a positive integer")
  if (!Array.isArray(o.rects)) throw new Error("page rectangles missing")
  const rects = o.rects.slice(0, MAX_PAGE_INDEX).map((r: unknown) => {
    const q = r as Record<string, unknown>
    const vals = [q?.x, q?.y, q?.w, q?.h]
    if (!vals.every((v) => typeof v === "number" && Number.isFinite(v))) throw new Error("page rectangle is not numeric")
    return { x: q.x as number, y: q.y as number, w: q.w as number, h: q.h as number }
  })
  return { layout: o.layout, pageCount, rects }
}

/**
 * Fixed page script (string, not a TS function, so no transpiler helper ends up in it). Argument:
 *   {phase:"size"}                                -> {size: <CSS size of the last unnamed @page rule> | null}
 *   {phase:"layout", wMm, hMm, maxRects}          -> {layout, pageCount, rects:[{x,y,w,h}] in CSS px, document coords}
 * Only CSS-object-model reads, plus (flow layout only) empty spacer divs that move a forced-break element to the
 * next page top. It never fetches, never navigates and never reads anything outside the document.
 */
export const PAGE_LAYOUT_SCRIPT = String.raw`(function (o) {
  var PX = 96 / 25.4;
  if (o.phase === 'size') {
    var found = null, margins = null, background = null, marginBoxes = false;
    var walk = function (rules) {
      for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        if (typeof CSSPageRule !== 'undefined' && r instanceof CSSPageRule) {
          if (r.selectorText && r.selectorText.trim() !== '') continue;
          var s = r.style.getPropertyValue('size');
          if (s && s.trim()) found = s.trim();
          var mt = r.style.getPropertyValue('margin-top');
          if (mt && mt.trim()) margins = { top: mt.trim(), right: r.style.getPropertyValue('margin-right').trim(), bottom: r.style.getPropertyValue('margin-bottom').trim(), left: r.style.getPropertyValue('margin-left').trim() };
          var bg = r.style.getPropertyValue('background-color');
          if (bg && bg.trim()) background = bg.trim();
          if (r.cssRules && r.cssRules.length) marginBoxes = true;
        } else if (typeof CSSMediaRule !== 'undefined' && r instanceof CSSMediaRule) {
          if (window.matchMedia(r.media.mediaText).matches) walk(r.cssRules);
        } else if (r.cssRules) {
          try { walk(r.cssRules); } catch (e) {}
        }
      }
    };
    for (var k = 0; k < document.styleSheets.length; k++) {
      try { walk(document.styleSheets[k].cssRules); } catch (e) {}
    }
    var SEL0 = '.page,[data-page]';
    var named = false;
    var nodes = document.body ? document.body.querySelectorAll('*') : [];
    for (var q = 0; q < nodes.length && !named; q++) { var pg = getComputedStyle(nodes[q]).page; if (pg && pg !== 'auto') named = true; }
    // The canvas colour (CSS 2 §14.2: the root's background, else the body's, propagates to the whole page).
    var canvas = null;
    var rootBg = getComputedStyle(document.documentElement).backgroundColor;
    var bodyBg = document.body ? getComputedStyle(document.body).backgroundColor : '';
    if (rootBg && !/rgba\(.*,\s*0\)$/.test(rootBg) && rootBg !== 'transparent') canvas = rootBg;
    else if (bodyBg && !/rgba\(.*,\s*0\)$/.test(bodyBg) && bodyBg !== 'transparent') canvas = bodyBg;
    return { size: found, margins: margins, background: canvas || background, marginBoxes: marginBoxes, namedPages: named, paged: document.querySelectorAll(SEL0).length > 0 };
  }
  if (o.phase === 'flowcut') return flowCut(o);
  function flowCut(o) {
    // Row 151c (DEFECT-157-1): the viewport is the @page CONTENT width; cut at the content height the way the
    // printer fragments: never inside a line, an image, a table row or a break-inside:avoid box (when it fits),
    // honour forced breaks, orphans/widows and break-after:avoid, and drop the space at an unforced break.
    var H = o.hMm * PX;
    var body = document.body, sy = window.scrollY;
    var FB = { page: 1, left: 1, right: 1, recto: 1, verso: 1, always: 1 };
    var AV = { avoid: 1, 'avoid-page': 1 };
    var BLOCKD = { block: 1, 'list-item': 1, table: 1, 'table-cell': 1, 'table-caption': 1, 'table-row': 1, flex: 1, grid: 1, 'flow-root': 1, 'inline-block': 1 };
    var atoms = [], forced = [], blocks = [], blockIx = new Map();
    function blockOf(el) {
      for (var e = el; e && e !== body; e = e.parentElement) if (BLOCKD[getComputedStyle(e).display]) return e;
      return body;
    }
    var els = body ? body.querySelectorAll('*') : [];
    var range = document.createRange();
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.parentElement && el.parentElement.closest('svg')) continue;
      var cs = getComputedStyle(el);
      if (cs.display === 'none' || !el.getClientRects().length) continue;
      var r = el.getBoundingClientRect(), t = r.top + sy, b = r.bottom + sy;
      if (FB[cs.breakBefore] && t > 0.5) forced.push(t);
      if (FB[cs.breakAfter]) forced.push(b);
      var tag = el.tagName.toLowerCase();
      var atomic = tag === 'img' || tag === 'svg' || tag === 'canvas' || tag === 'video' || tag === 'tr' || tag === 'hr' || AV[cs.breakInside];
      if (atomic && b - t > 0.5 && b - t <= H) atoms.push({ t: t, b: b });
      if (tag === 'img' || tag === 'svg') continue;
      for (var n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType !== 3 || !/\S/.test(n.nodeValue)) continue;
        range.selectNodeContents(n);
        var rr = range.getClientRects();
        var blk = blockOf(el);
        if (!blockIx.has(blk)) { blockIx.set(blk, blocks.length); blocks.push({ el: blk, lines: [] }); }
        var L = blocks[blockIx.get(blk)].lines;
        for (var k = 0; k < rr.length; k++) if (rr[k].width > 0.5 && rr[k].height > 0.5) L.push({ t: rr[k].top + sy, b: rr[k].bottom + sy });
      }
    }
    var lineAt = [];
    blocks.forEach(function (bk) {
      var L = bk.lines.sort(function (a, b) { return a.t - b.t; }), bands = [];
      for (var j = 0; j < L.length; j++) {
        var last = bands[bands.length - 1], mid = (L[j].t + L[j].b) / 2;
        if (last && mid >= last.t && mid <= last.b) { last.t = Math.min(last.t, L[j].t); last.b = Math.max(last.b, L[j].b); }
        else bands.push({ t: L[j].t, b: L[j].b });
      }
      var bcs = getComputedStyle(bk.el);
      var orph = parseInt(bcs.orphans, 10) || 2, wid = parseInt(bcs.widows, 10) || 2;
      var avoidAfter = !!AV[bcs.breakAfter], top = bk.el.getBoundingClientRect().top + sy;
      for (var m = 0; m < bands.length; m++) {
        var a = { t: bands[m].t, b: bands[m].b, lines: bands, ix: m, orphans: orph, widows: wid, avoidAfter: avoidAfter && m === bands.length - 1, blockTop: top };
        atoms.push(a);
        lineAt.push(a);
      }
    });
    var bottom = 0;
    atoms.forEach(function (a) { if (a.b > bottom) bottom = a.b; });
    forced = forced.filter(function (f) { return f < bottom - 0.5; }).sort(function (a, b) { return a - b; });
    var W = document.documentElement.clientWidth;
    var rects = [], top = 0, guard = 0;
    while (guard++ < 4 * o.maxRects + 8) {
      var limit = top + H, cut = null, forcedCut = false;
      for (var f = 0; f < forced.length; f++) if (forced[f] > top + 0.5 && forced[f] <= limit + 0.5) { cut = forced[f]; forcedCut = true; break; }
      if (cut === null) {
        if (bottom <= limit + 0.5) { rects.push({ x: 0, y: top, w: W, h: Math.max(1, Math.min(H, bottom - top)) }); break; }
        cut = limit;
        for (var again = true, pass = 0; again && pass < 50; pass++) {
          again = false;
          for (var z = 0; z < atoms.length; z++) if (atoms[z].t < cut - 0.5 && atoms[z].b > cut + 0.5 && atoms[z].t > top + 0.5) { cut = atoms[z].t; again = true; }
        }
        for (var y = 0; y < lineAt.length; y++) {
          var la = lineAt[y];
          if (Math.abs(la.t - cut) > 0.5 || la.ix === 0) continue;
          var before = la.ix, after = la.lines.length - la.ix, c2 = null;
          if (before < la.orphans) c2 = la.lines[0].t;
          else if (after < la.widows) { var kk = la.lines.length - la.widows; c2 = kk >= la.orphans ? la.lines[kk].t : la.lines[0].t; }
          if (c2 !== null && c2 > top + 0.5) cut = c2;
          break;
        }
        var prev = null;
        for (var w = 0; w < lineAt.length; w++) if (lineAt[w].b <= cut + 0.5 && (!prev || lineAt[w].b > prev.b)) prev = lineAt[w];
        if (prev && prev.avoidAfter && prev.blockTop > top + 0.5 && prev.blockTop < cut) cut = prev.blockTop;
        if (cut <= top + 0.5) cut = limit;
      }
      rects.push({ x: 0, y: top, w: W, h: Math.max(1, cut - top) });
      if (rects.length >= o.maxRects) break;
      var next = cut;
      if (!forcedCut) { var nt = null; for (var u = 0; u < atoms.length; u++) if (atoms[u].t >= cut - 0.5 && (nt === null || atoms[u].t < nt)) nt = atoms[u].t; if (nt !== null && nt < cut + H) next = Math.max(cut, nt); }
      if (next >= bottom - 0.5) break;
      top = next;
    }
    if (!rects.length) rects.push({ x: 0, y: 0, w: W, h: H });
    return { layout: 'flow', pageCount: rects.length, rects: rects };
  }
  var SEL = '.page,[data-page]';
  var all = Array.prototype.slice.call(document.querySelectorAll(SEL));
  var pages = all.filter(function (p) { return !p.parentElement || !p.parentElement.closest(SEL); });
  var rects = [];
  if (pages.length > 0) {
    for (var i = 0; i < pages.length && i < o.maxRects; i++) {
      var b = pages[i].getBoundingClientRect();
      rects.push({ x: b.left + window.scrollX, y: b.top + window.scrollY, w: b.width, h: b.height });
    }
    return { layout: 'paged', pageCount: pages.length, rects: rects };
  }
  var W = o.wMm * PX, H = o.hMm * PX;
  var FORCED = { page: 1, left: 1, right: 1, recto: 1, verso: 1, always: 1 };
  var body = document.body;
  if (body) {
    var els = Array.prototype.slice.call(body.querySelectorAll('*'));
    var targets = [];
    for (var j = 0; j < els.length; j++) {
      var cs = getComputedStyle(els[j]);
      if (FORCED[cs.breakBefore]) targets.push(els[j]);
      if (FORCED[cs.breakAfter] && els[j].nextElementSibling) targets.push(els[j].nextElementSibling);
    }
    for (var t = 0; t < targets.length && t < o.maxRects; t++) {
      var el = targets[t];
      if (!el.parentNode) continue;
      var top0 = el.getBoundingClientRect().top + window.scrollY;
      var rem = top0 % H;
      if (top0 < 0.5 || rem < 0.5 || H - rem < 0.5) continue;
      var target = Math.ceil(top0 / H) * H;
      var sp = document.createElement('div');
      sp.setAttribute('data-datum-page-spacer', '');
      sp.style.cssText = 'display:block;margin:0;padding:0;border:0;height:0px';
      el.parentNode.insertBefore(sp, el);
      var h = 0;
      for (var pass = 0; pass < 3; pass++) {
        var d = target - (el.getBoundingClientRect().top + window.scrollY);
        if (Math.abs(d) < 0.5) break;
        h = Math.max(0, h + d);
        sp.style.height = h + 'px';
      }
    }
  }
  var root = document.documentElement;
  var docH = Math.max(root.scrollHeight, body ? body.scrollHeight : 0);
  var count = Math.max(1, Math.ceil(docH / H - 0.01));
  for (var n = 0; n < count && n < o.maxRects; n++) rects.push({ x: 0, y: n * H, w: W, h: H });
  return { layout: 'flow', pageCount: count, rects: rects };
})`

/** The expression evaluated in the page for one phase. */
export function pageLayoutExpression(arg: { phase: "size" } | { phase: "layout"; wMm: number; hMm: number; maxRects: number } | { phase: "flowcut"; hMm: number; maxRects: number }) {
  return `${PAGE_LAYOUT_SCRIPT}(${JSON.stringify(arg)})`
}

// ── Row 151c (DEFECT-157-1): flow layout cut at the @page content box ─────────

/** What the size phase reads besides `size` (strings straight from the CSSOM; validated here). */
export type PageSizeInfo = {
  size: string | null
  margins: { top: string; right: string; bottom: string; left: string } | null
  background: string | null
  marginBoxes: boolean
  namedPages: boolean
  paged: boolean
}

export function readSizeInfo(raw: unknown): PageSizeInfo {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  const m = o.margins && typeof o.margins === "object" ? (o.margins as Record<string, unknown>) : null
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 64) : "")
  return {
    size: typeof o.size === "string" ? o.size.slice(0, 64) : null,
    margins: m ? { top: str(m.top), right: str(m.right), bottom: str(m.bottom), left: str(m.left) } : null,
    background: typeof o.background === "string" ? o.background.slice(0, 64) : null,
    marginBoxes: o.marginBoxes === true,
    namedPages: o.namedPages === true,
    paged: o.paged === true,
  }
}

export type MarginsMm = { top: number; right: number; bottom: number; left: number }

/** One margin length in mm: `0` or `<number><unit>`; anything else (auto, %, calc) is null. */
export function marginMm(v: string): number | null {
  const t = v.trim().toLowerCase()
  if (t === "0") return 0
  const m = /^([0-9]*\.?[0-9]+)(mm|cm|q|in|pt|pc|px)$/.exec(t)
  if (!m) return null
  const mm = parseFloat(m[1]) * UNIT_MM[m[2]]
  return mm >= 0 && mm <= MAX_MM ? Math.round(mm * 1000) / 1000 : null
}

/**
 * The @page margins (CSS 1-4 value shorthand already expanded by the CSSOM). No rule: 0 on every side (the bridge
 * prints with margins 0). A side that cannot be read: null (the caller keeps 0 and marks the images approximate).
 */
export function parseMargins(m: PageSizeInfo["margins"]): MarginsMm | null {
  if (!m) return { top: 0, right: 0, bottom: 0, left: 0 }
  const v = [m.top, m.right, m.bottom, m.left].map(marginMm)
  if (v.some((x) => x === null)) return null
  return { top: v[0]!, right: v[1]!, bottom: v[2]!, left: v[3]! }
}

/** Page colour for the composed image: a CSS hex or rgb()/rgba() colour, else white. Never markup. */
export function pageBackground(v: string | null): string {
  const t = (v ?? "").trim()
  if (/^#[0-9a-fA-F]{3,8}$/.test(t)) return t
  const m = /^rgba?\(\s*[0-9.]+\s*,\s*[0-9.]+\s*,\s*[0-9.]+\s*(?:,\s*([0-9.]+)\s*)?\)$/.exec(t)
  if (m && (m[1] === undefined || parseFloat(m[1]) > 0)) return t
  return "#ffffff"
}

/** Why the flow images only approximate the printed pages (always non-empty for flow layout). */
export function flowApproximation(info: Pick<PageSizeInfo, "marginBoxes" | "namedPages">, marginsRead: boolean): string {
  const r = ["pages cut by the bridge's line-break estimate, not by the printer"]
  if (info.marginBoxes) r.push("running header and footer not drawn")
  if (info.namedPages) r.push("named pages drawn with the default page margins")
  if (!marginsRead) r.push("page margins unreadable, drawn as 0")
  return r.join("; ")
}

/** Page colour as RGB bytes (from pageBackground's output); anything unreadable is white. */
export function backgroundRgb(v: string | null): [number, number, number] {
  const t = pageBackground(v)
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(t)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16)) as [number, number, number]
    if (h.length === 6 || h.length === 8) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
    return [255, 255, 255]
  }
  const m = /^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)/.exec(t)
  if (m) return [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(255, Math.round(parseFloat(x))))) as [number, number, number]
  return [255, 255, 255]
}

// Minimal PNG codec for the bridge's own screenshots (8-bit RGB / RGBA, not interlaced): page images are composed
// pixel by pixel in main, never re-rendered, so colours are exactly the captured ones (no second colour management).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(b: Uint8Array) {
  let c = 0xffffffff
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export type RgbImage = { width: number; height: number; rgb: Uint8Array }

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG to RGB (alpha composited over `bg`). Throws on anything else. */
export function decodePngRgb(png: Uint8Array, bg: [number, number, number] = [255, 255, 255]): RgbImage {
  const b = Buffer.from(png.buffer, png.byteOffset, png.byteLength)
  const { width, height } = pngSize(b)
  const depth = b[24], colour = b[25], interlace = b[28]
  if (depth !== 8 || (colour !== 2 && colour !== 6) || interlace !== 0) throw new Error("unsupported PNG layout")
  const ch = colour === 6 ? 4 : 3
  const parts: Buffer[] = []
  for (let o = 8; o + 8 <= b.length; ) {
    const len = b.readUInt32BE(o)
    const type = b.toString("latin1", o + 4, o + 8)
    if (type === "IDAT") parts.push(b.subarray(o + 8, o + 8 + len))
    if (type === "IEND") break
    o += 12 + len
  }
  const raw = inflateSync(Buffer.concat(parts))
  const stride = width * ch
  if (raw.length < height * (stride + 1)) throw new Error("PNG data too short")
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride)
  const out = new Uint8Array(width * height * 3)
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]
    const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, up = prev[x], c = x >= ch ? prev[x - ch] : 0
      let v = row[x]
      if (f === 1) v += a
      else if (f === 2) v += up
      else if (f === 3) v += (a + up) >> 1
      else if (f === 4) {
        const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c
      } else if (f !== 0) throw new Error("bad PNG filter")
      cur[x] = v & 0xff
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3
      if (ch === 3) {
        out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1]; out[o + 2] = cur[x * 3 + 2]
      } else {
        const al = cur[x * 4 + 3] / 255
        for (let k = 0; k < 3; k++) out[o + k] = Math.round(cur[x * 4 + k] * al + bg[k] * (1 - al))
      }
    }
    prev.set(cur)
  }
  return { width, height, rgb: out }
}

/** Encode RGB pixels as an 8-bit RGB PNG (filter 0, deflate). */
export function encodePngRgb(img: RgbImage): Buffer {
  const stride = img.width * 3
  const raw = Buffer.alloc(img.height * (stride + 1))
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0
    raw.set(img.rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, "latin1")
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
    return Buffer.concat([head, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(img.width, 0)
  ihdr.writeUInt32BE(img.height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))])
}

/**
 * One whole page: a `width` x `height` px canvas in the page colour with the content cut placed at (`left`, `top`) px;
 * anything of the cut beyond the page edge is cropped.
 */
export function composePage(o: { width: number; height: number; bg: [number, number, number]; content: RgbImage; left: number; top: number }): Buffer {
  const out = new Uint8Array(o.width * o.height * 3)
  for (let i = 0; i < o.width * o.height; i++) out.set(o.bg, i * 3)
  const c = o.content
  for (let y = 0; y < c.height; y++) {
    const ty = o.top + y
    if (ty < 0 || ty >= o.height) continue
    const x0 = Math.max(0, -o.left), x1 = Math.min(c.width, o.width - o.left)
    if (x1 <= x0) continue
    out.set(c.rgb.subarray((y * c.width + x0) * 3, (y * c.width + x1) * 3), (ty * o.width + o.left + x0) * 3)
  }
  return encodePngRgb({ width: o.width, height: o.height, rgb: out })
}
