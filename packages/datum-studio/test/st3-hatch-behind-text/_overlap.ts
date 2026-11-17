// Swarm 1.3.3 row 41 (ST-3 item 2): structural label-on-hatch check on an emitted diagram SVG.
//
// A "case" is one text line whose glyph box is crossed by a hatch line that is still visible there: the hatch is
// painted before the text and no opaque rect painted between the two covers the crossing, or the hatch is painted
// after the text (nothing can then stand between them). Elements are read in document order = paint order.
//
// Glyph box of a line: width from the engine's own fit metric (`measure`, the metric the ground rect is sized with),
// height from 0.72 em above the baseline (cap height plus accents) to 0.20 em below it. The clip of a non-box node
// is not applied: hatch and ground are both taken at their unclipped extent, which can only over-report.
//
// A symbol badge (`<g data-symbol ... transform="translate(x y) scale(s)">`) is checked as one element: its whole cell
// (24 units x scale) must be free of visible hatch, because the hatch runs through the symbol's strokes and through
// the letters some symbols carry ("UPS", "M", "G"). Texts inside the badge are placed with the group transform.
import { measure } from "@/lib/studio/engine/chart/core/textfit";

const attrs = (tag: string): Record<string, string> => Object.fromEntries([...tag.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
const unesc = (s: string): string => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const MM_PER_PT = 25.4 / 72;
export const GLYPH_ASCENT_EM = 0.72;
export const GLYPH_DESCENT_EM = 0.2;
/** A crossing shorter than this (mm) is a corner touch, not ink through a glyph. */
export const MIN_VISIBLE_MM = 0.05;

export interface Seg { x1: number; y1: number; x2: number; y2: number; order: number; angle: string }
export interface Rect { x0: number; y0: number; x1: number; y1: number; order: number }
export interface TextLine { text: string; x0: number; y0: number; x1: number; y1: number; order: number; el: string }
export interface Hit { text: string; el: string; visibleMm: number; hatchAfterText: boolean }
/** Side of the symbol cell in symbol units (engine/symbols CELL). */
export const SYMBOL_CELL = 24;
interface Tf { tx: number; ty: number; s: number }

export function parse(svg: string): { segs: Seg[]; rects: Rect[]; texts: TextLine[] } {
  const body = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "").replace(/<clipPath\b[\s\S]*?<\/clipPath>/g, "");
  const segs: Seg[] = [];
  const rects: Rect[] = [];
  const texts: TextLine[] = [];
  let order = 0;
  let hatch: string | null = null;
  let depth = 0;
  let hatchDepth = -1;
  const tfs: Array<Tf | null> = [];
  const tf = (): Tf => tfs.reduce<Tf>((acc, t) => (t ? { tx: acc.tx + acc.s * t.tx, ty: acc.ty + acc.s * t.ty, s: acc.s * t.s } : acc), { tx: 0, ty: 0, s: 1 });
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>|<g\b([^>]*)>|<\/g>|<line\b([^>]*)\/>|<rect\b([^>]*)\/>/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    order++;
    if (m[0] === "</g>") {
      if (depth === hatchDepth) { hatch = null; hatchDepth = -1; }
      depth--;
      tfs.pop();
    } else if (m[3] !== undefined) {
      depth++;
      const a = attrs(m[3]);
      if (a["data-hatch"] !== undefined && hatch === null) { hatch = a["data-hatch"]; hatchDepth = depth; }
      const t = /translate\(([-\d.]+)[ ,]+([-\d.]+)\)(?:\s*scale\(([-\d.]+)\))?/.exec(a.transform ?? "");
      tfs.push(t ? { tx: +t[1], ty: +t[2], s: t[3] !== undefined ? +t[3] : 1 } : null);
      if (a["data-symbol"] !== undefined) {
        const c = tf();
        texts.push({ text: `symbol ${a["data-symbol"]} of ${a["data-symbol-of"]}`, x0: c.tx, y0: c.ty, x1: c.tx + SYMBOL_CELL * c.s, y1: c.ty + SYMBOL_CELL * c.s, order, el: m[0] });
      }
    } else if (m[4] !== undefined) {
      if (hatch === null) continue;
      const a = attrs(m[4]);
      segs.push({ x1: +a.x1, y1: +a.y1, x2: +a.x2, y2: +a.y2, order, angle: hatch });
    } else if (m[5] !== undefined) {
      const a = attrs(m[5]);
      const opaque = a.fill !== undefined && a.fill !== "none" && !a.fill.startsWith("url(") && a.opacity === undefined && a["fill-opacity"] === undefined;
      const c = tf();
      if (opaque) rects.push({ x0: c.tx + c.s * +a.x, y0: c.ty + c.s * +a.y, x1: c.tx + c.s * (+a.x + +a.width), y1: c.ty + c.s * (+a.y + +a.height), order });
    } else {
      const a = attrs(m[1]);
      const c = tf();
      const size = +a["font-size"] * c.s;
      const face = /Mono/.test(a["font-family"] ?? "") ? "data" : "struct";
      const bold = +(a["font-weight"] ?? 400) >= 600;
      const trackMm = a["letter-spacing"] !== undefined ? +a["letter-spacing"] : 0;
      const anchor = a["text-anchor"] ?? "start";
      const add = (s: string, x: number, y: number) => {
        const text = unesc(s);
        if (!text.trim()) return;
        const w = measure(text, size / MM_PER_PT, face as any, { bold, trackMm: trackMm * c.s });
        x = c.tx + c.s * x;
        y = c.ty + c.s * y;
        const lx = anchor === "middle" ? x - w / 2 : anchor === "end" ? x - w : x;
        texts.push({ text, x0: lx, y0: y - GLYPH_ASCENT_EM * size, x1: lx + w, y1: y + GLYPH_DESCENT_EM * size, order, el: m![0].slice(0, 200) });
      };
      const spans = [...m[2].matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)];
      if (!spans.length) add(m[2], +a.x, +a.y);
      else {
        let y = +a.y;
        for (const sp of spans) {
          const sa = attrs(sp[1]);
          if (sa.y !== undefined) y = +sa.y;
          if (sa.dy !== undefined) y += +sa.dy;
          add(sp[2], sa.x !== undefined ? +sa.x : +a.x, y);
        }
      }
    }
  }
  return { segs, rects, texts };
}

/** Parameter interval [t0, t1] of segment s inside the box, null when it misses. */
function clip(s: Seg, x0: number, y0: number, x1: number, y1: number): [number, number] | null {
  const dx = s.x2 - s.x1;
  const dy = s.y2 - s.y1;
  let t0 = 0;
  let t1 = 1;
  for (const [p, q] of [[-dx, s.x1 - x0], [dx, x1 - s.x1], [-dy, s.y1 - y0], [dy, y1 - s.y1]] as const) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) t0 = Math.max(t0, r); else t1 = Math.min(t1, r);
  }
  return t1 > t0 ? [t0, t1] : null;
}

export function labelOnHatch(svg: string): Hit[] {
  const { segs, rects, texts } = parse(svg);
  const hits: Hit[] = [];
  for (const t of texts) {
    let worst = 0;
    let after = false;
    for (const s of segs) {
      const inBox = clip(s, t.x0, t.y0, t.x1, t.y1);
      if (!inBox) continue;
      const len = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
      const cover: Array<[number, number]> = [];
      if (s.order < t.order) for (const r of rects) {
        if (r.order < s.order || r.order > t.order) continue;
        const c = clip(s, r.x0, r.y0, r.x1, r.y1);
        if (c) cover.push([Math.max(c[0], inBox[0]), Math.min(c[1], inBox[1])]);
      }
      cover.sort((p, q) => p[0] - q[0]);
      let at = inBox[0];
      let open = 0;
      for (const [c0, c1] of cover) {
        if (c1 <= at) continue;
        if (c0 > at) open += c0 - at;
        at = Math.max(at, c1);
      }
      if (at < inBox[1]) open += inBox[1] - at;
      const visible = open * len;
      if (visible > worst) { worst = visible; after = s.order > t.order; }
    }
    if (worst > MIN_VISIBLE_MM) hits.push({ text: t.text, el: t.el, visibleMm: Number(worst.toFixed(2)), hatchAfterText: after });
  }
  return hits;
}
