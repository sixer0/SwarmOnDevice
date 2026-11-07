/**
 * Pengurai SVG statis (tanpa DOM, tanpa eval) untuk lint R pada `SvgResult`
 * dan SVG inline di HTML: warna tercetak (DATUM-25), ukuran huruf terhitung
 * setelah skala viewBox dan transform (DATUM-28), serta geometri simpul
 * (`data-mark="node"`) dan konektor (`data-mark="link"`) untuk DATUM-32
 * (konvensi markup S30, kontrak §3.5).
 *
 * Satuan internal: satuan pengguna SVG (uu); `mmPerUu` mengubah ke mm.
 * Batas: aturan `<style>` per kelas tidak dipetakan ke elemen (warna di
 * dalamnya tetap dihitung, ukuran huruf tidak); `<use>` tidak diikuti.
 */
import { normaliseColour } from "./colour";

/** Matriks afine 2D [a, b, c, d, e, f]. */
export type Affine = readonly [number, number, number, number, number, number];

const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];
const PX_PER_MM = 96 / 25.4;
const PT_PER_MM = 72 / 25.4;
/** Batas masukan lokal (bukan kontrak). */
export const SVG_MAX_BYTES = 32 * 1024 * 1024;
const MAX_TAGS = 400_000;

export interface Pt {
  x: number;
  y: number;
}

export type NodeShape =
  | { kind: "rect"; x: number; y: number; w: number; h: number }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | { kind: "polygon"; points: Pt[] };

export interface SvgNode {
  id: string;
  shape: NodeShape;
  /** Kotak batas (uu, setelah transform). */
  box: { x0: number; y0: number; x1: number; y1: number };
}

export interface SvgLink {
  index: string;
  /** Polilinia (uu, setelah transform); busur dicuplik sepanjang lengkungnya, kurva diwakili titik ujungnya. */
  points: Pt[];
}

export interface SvgText {
  sizePt: number;
  text: string;
}

export interface SvgAnalysis {
  widthMm: number;
  heightMm: number;
  mmPerUu: number;
  colours: string[];
  texts: SvgText[];
  /** Teks tanpa ukuran huruf terbaca (mis. hanya lewat kelas CSS). */
  unresolvedTexts: number;
  nodes: SvgNode[];
  links: SvgLink[];
}

function mul(m: Affine, n: Affine): Affine {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Affine, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

function nums(s: string): number[] {
  const out: number[] = [];
  const re = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push(parseFloat(m[0]));
  return out;
}

/** Urai atribut `transform` SVG. Fungsi tak dikenal diabaikan. */
export function parseTransform(t: string | undefined): Affine {
  if (!t) return IDENTITY;
  let m: Affine = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let f: RegExpExecArray | null;
  while ((f = re.exec(t))) {
    const a = nums(f[2]);
    let n: Affine = IDENTITY;
    switch (f[1].toLowerCase()) {
      case "matrix":
        if (a.length >= 6) n = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case "translate":
        n = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const r = ((a[0] ?? 0) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        const rot: Affine = [cos, sin, -sin, cos, 0, 0];
        if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]);
        else n = rot;
        break;
      }
      case "skewx":
        n = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewy":
        n = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, n);
  }
  return m;
}

function scaleOf(m: Affine): number {
  return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

/** Panjang CSS ke px (= uu SVG). `rel` = nilai induk untuk em/%. */
function lengthPx(v: string | undefined, rel?: number): number | null {
  if (!v) return null;
  const m = /^\s*([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)\s*(px|mm|cm|in|pt|pc|em|%)?\s*$/i.exec(v);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] ?? "").toLowerCase()) {
    case "mm":
      return n * PX_PER_MM;
    case "cm":
      return n * PX_PER_MM * 10;
    case "in":
      return n * 96;
    case "pt":
      return (n * 96) / 72;
    case "pc":
      return n * 16;
    case "em":
      return rel !== undefined ? n * rel : null;
    case "%":
      return rel !== undefined ? (n * rel) / 100 : null;
    default:
      return n;
  }
}

function lengthMm(v: string | undefined): number | null {
  const px = lengthPx(v);
  return px === null ? null : px / PX_PER_MM;
}

const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseAttrs(src: string): Map<string, string> {
  const out = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(src))) {
    out.set(m[1].toLowerCase(), decodeEntities(m[2] ?? m[3] ?? m[4] ?? ""));
  }
  return out;
}

function parseStyle(s: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!s) return out;
  for (const decl of s.split(";")) {
    const i = decl.indexOf(":");
    if (i <= 0) continue;
    out.set(decl.slice(0, i).trim().toLowerCase(), decl.slice(i + 1).trim());
  }
  return out;
}

/** Nilai properti presentasi: gaya inline menang atas atribut (aturan CSS). */
function prop(attrs: Map<string, string>, style: Map<string, string>, name: string): string | undefined {
  return style.get(name) ?? attrs.get(name);
}

function zeroish(v: string | undefined): boolean {
  if (v === undefined) return false;
  const n = parseFloat(v);
  return Number.isFinite(n) && n <= 0;
}

/** Langkah sudut maks cuplikan busur (5 derajat) dan batas cuplikan per busur. */
const ARC_STEP_RAD = Math.PI / 36;
const ARC_MAX_SAMPLES = 720;

/**
 * Argumen perintah busur `A`/`a` dengan bendera ringkas (`a5 5 0 016 6`):
 * bendera ke-4 dan ke-5 tiap grup selalu satu karakter `0`/`1`.
 */
function arcArgs(s: string): number[] {
  const out: number[] = [];
  const numRe = /[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/iy;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/[\s,]/.test(c)) {
      i++;
      continue;
    }
    const slot = out.length % 7;
    if (slot === 3 || slot === 4) {
      if (c !== "0" && c !== "1") break;
      out.push(c === "1" ? 1 : 0);
      i++;
      continue;
    }
    numRe.lastIndex = i;
    const m = numRe.exec(s);
    if (!m) break;
    out.push(parseFloat(m[0]));
    i = numRe.lastIndex;
  }
  return out;
}

/**
 * Cuplikan busur eliptik SVG (parameterisasi titik ujung ke pusat, SVG 1.1
 * lampiran F.6.5-F.6.6) tanpa titik awal, diakhiri tepat di titik ujung.
 */
function arcSamples(p0: Pt, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, p1: Pt): Pt[] {
  if (p0.x === p1.x && p0.y === p1.y) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ ...p1 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (p0.x - p1.x) / 2;
  const dy = (p0.y - p1.y) / 2;
  const x1 = cos * dx + sin * dy;
  const y1 = -sin * dx + cos * dy;
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lambda > 1) {
    const k = Math.sqrt(lambda);
    rx *= k;
    ry *= k;
  }
  const nm = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, nm / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1) / ry;
  const cyp = (-co * ry * x1) / rx;
  const cx = cos * cxp - sin * cyp + (p0.x + p1.x) / 2;
  const cy = sin * cxp + cos * cyp + (p0.y + p1.y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const ux = (x1 - cxp) / rx;
  const uy = (y1 - cyp) / ry;
  const vx = (-x1 - cxp) / rx;
  const vy = (-y1 - cyp) / ry;
  const t0 = ang(1, 0, ux, uy);
  let dt = ang(ux, uy, vx, vy);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  if (!Number.isFinite(t0) || !Number.isFinite(dt)) return [{ ...p1 }];
  const n = Math.min(ARC_MAX_SAMPLES, Math.max(2, Math.ceil(Math.abs(dt) / ARC_STEP_RAD)));
  const out: Pt[] = [];
  for (let i = 1; i < n; i++) {
    const t = t0 + (dt * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push({ x: cos * ex - sin * ey + cx, y: sin * ex + cos * ey + cy });
  }
  out.push({ ...p1 });
  return out;
}

/**
 * Urai `d` path ke titik-titik (absolut). Kurva = titik ujung. Busur `A`/`a`
 * = titik ujung, kecuali `o.arcs`: dicuplik sebagai polilinia sepanjang busur
 * (konektor DATUM-32; bentuk simpul tetap memakai titik ujung).
 */
export function pathPoints(d: string, o: { arcs?: boolean } = {}): Pt[] {
  const out: Pt[] = [];
  const re = /([MmLlHhVvCcSsQqTtAaZz])([^MmLlHhVvCcSsQqTtAaZz]*)/g;
  let cur: Pt = { x: 0, y: 0 };
  let start: Pt = { x: 0, y: 0 };
  let m: RegExpExecArray | null;
  const ARITY: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  while ((m = re.exec(d))) {
    const cmd = m[1];
    const lc = cmd.toLowerCase();
    const rel = cmd !== cmd.toUpperCase();
    const a = lc === "a" && o.arcs ? arcArgs(m[2]) : nums(m[2]);
    if (lc === "z") {
      cur = { ...start };
      out.push({ ...cur });
      continue;
    }
    const k = ARITY[lc];
    for (let i = 0; i + k <= a.length; i += k) {
      let nx = cur.x;
      let ny = cur.y;
      if (lc === "h") nx = rel ? cur.x + a[i] : a[i];
      else if (lc === "v") ny = rel ? cur.y + a[i] : a[i];
      else {
        const ex = a[i + k - 2];
        const ey = a[i + k - 1];
        nx = rel ? cur.x + ex : ex;
        ny = rel ? cur.y + ey : ey;
      }
      if (lc === "a" && o.arcs) {
        const arc = arcSamples(cur, a[i], a[i + 1], a[i + 2], a[i + 3] !== 0, a[i + 4] !== 0, { x: nx, y: ny });
        cur = { x: nx, y: ny };
        out.push(...arc);
        continue;
      }
      cur = { x: nx, y: ny };
      if (lc === "m" && i === 0) start = { ...cur };
      out.push({ ...cur });
    }
  }
  return out;
}

function pointsAttr(v: string | undefined): Pt[] {
  const a = nums(v ?? "");
  const out: Pt[] = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push({ x: a[i], y: a[i + 1] });
  return out;
}

function num(v: string | undefined, dflt = 0): number {
  const n = v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : dflt;
}

function boxOf(points: readonly Pt[]): SvgNode["box"] | null {
  if (points.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/** Bentuk simpul dalam koordinat akhir. Transform non-sumbu memakai poligon. */
function nodeShape(tag: string, at: Map<string, string>, m: Affine): NodeShape | null {
  const axisAligned = Math.abs(m[1]) < 1e-9 && Math.abs(m[2]) < 1e-9;
  const poly = (pts: Pt[]): NodeShape | null => (pts.length >= 3 ? { kind: "polygon", points: pts.map((p) => apply(m, p)) } : null);
  switch (tag) {
    case "rect": {
      const x = num(at.get("x"));
      const y = num(at.get("y"));
      const w = num(at.get("width"));
      const h = num(at.get("height"));
      const corners = [
        { x, y },
        { x: x + w, y },
        { x: x + w, y: y + h },
        { x, y: y + h },
      ];
      if (!axisAligned) return poly(corners);
      const b = boxOf(corners.map((p) => apply(m, p)));
      return b ? { kind: "rect", x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 } : null;
    }
    case "circle":
    case "ellipse": {
      const cx = num(at.get("cx"));
      const cy = num(at.get("cy"));
      const rx = tag === "circle" ? num(at.get("r")) : num(at.get("rx"));
      const ry = tag === "circle" ? rx : num(at.get("ry"), rx);
      if (tag === "circle" && axisAligned) {
        const c = apply(m, { x: cx, y: cy });
        return { kind: "circle", cx: c.x, cy: c.y, r: rx * scaleOf(m) };
      }
      const pts: Pt[] = [];
      for (let i = 0; i < 24; i++) {
        const t = (i * Math.PI) / 12;
        pts.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
      }
      return poly(pts);
    }
    case "polygon":
    case "polyline":
      return poly(pointsAttr(at.get("points")));
    case "path":
      return poly(pathPoints(at.get("d") ?? ""));
    case "line": {
      const a = apply(m, { x: num(at.get("x1")), y: num(at.get("y1")) });
      const b = apply(m, { x: num(at.get("x2")), y: num(at.get("y2")) });
      // Garis (mis. bus) tanpa luas: kotak degeneratif, tidak pernah "dilewati".
      return { kind: "rect", x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
    }
    default:
      return null;
  }
}

function shapeBox(s: NodeShape): SvgNode["box"] {
  if (s.kind === "rect") return { x0: s.x, y0: s.y, x1: s.x + s.w, y1: s.y + s.h };
  if (s.kind === "circle") return { x0: s.cx - s.r, y0: s.cy - s.r, x1: s.cx + s.r, y1: s.cy + s.r };
  return boxOf(s.points) ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
}

function linkPoints(tag: string, at: Map<string, string>, m: Affine): Pt[] {
  let pts: Pt[] = [];
  if (tag === "path") pts = pathPoints(at.get("d") ?? "", { arcs: true });
  else if (tag === "polyline" || tag === "polygon") pts = pointsAttr(at.get("points"));
  else if (tag === "line") pts = [
    { x: num(at.get("x1")), y: num(at.get("y1")) },
    { x: num(at.get("x2")), y: num(at.get("y2")) },
  ];
  return pts.map((p) => apply(m, p));
}

const COLOUR_PROPS = ["fill", "stroke", "stop-color", "flood-color", "lighting-color", "color"] as const;
const CSS_COLOUR_RE = /(?:^|[;{\s])(?:fill|stroke|stop-color|flood-color|color)\s*:\s*([^;}]+)/gi;
const VOID_TEXT = new Set(["text", "tspan", "textpath"]);

interface Frame {
  tag: string;
  m: Affine;
  fontPx: number | null;
  hidden: boolean;
  /** Indeks teks terbuka (untuk mengisi isi teks). */
  textIdx: number;
}

/**
 * Analisis satu dokumen SVG. `sizeMm` = ukuran tampil kontrak (`SvgResult.widthMm/heightMm`);
 * bila tidak diberi, dibaca dari atribut width/height root.
 */
export function analyseSvg(svg: string, sizeMm?: { widthMm: number; heightMm: number }): SvgAnalysis {
  if (typeof svg !== "string") throw new TypeError("svg must be a string");
  if (svg.length > SVG_MAX_BYTES) throw new RangeError(`svg exceeds ${SVG_MAX_BYTES} bytes`);
  const src = svg.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, c: string) => c.replace(/</g, "&lt;"));
  const res: SvgAnalysis = { widthMm: 0, heightMm: 0, mmPerUu: 25.4 / 96, colours: [], texts: [], unresolvedTexts: 0, nodes: [], links: [] };
  const colours = new Set<string>();
  const stack: Frame[] = [];
  let rootSeen = false;
  let tags = 0;
  const tagRe = /<(\/?)([a-zA-Z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let styleOpen = false;

  const flushText = (chunk: string) => {
    if (styleOpen) {
      CSS_COLOUR_RE.lastIndex = 0;
      let c: RegExpExecArray | null;
      while ((c = CSS_COLOUR_RE.exec(chunk))) {
        const h = normaliseColour(c[1]);
        if (h) colours.add(h);
      }
      return;
    }
    const top = stack[stack.length - 1];
    if (top && top.textIdx >= 0 && !top.hidden) {
      const t = decodeEntities(chunk).replace(/\s+/g, " ");
      if (t.trim()) res.texts[top.textIdx].text = (res.texts[top.textIdx].text + t).slice(0, 80);
    }
  };

  while ((m = tagRe.exec(src))) {
    if (++tags > MAX_TAGS) throw new RangeError(`svg exceeds ${MAX_TAGS} tags`);
    flushText(src.slice(last, m.index));
    last = tagRe.lastIndex;
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase().replace(/^svg:/, "");
    const selfClose = m[4] === "/";
    if (closing) {
      if (tag === "style") styleOpen = false;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const at = parseAttrs(m[3]);
    const st = parseStyle(at.get("style"));
    const parent = stack[stack.length - 1];
    let mtx = parent ? parent.m : IDENTITY;

    if (tag === "svg" && !rootSeen) {
      rootSeen = true;
      const vb = nums(at.get("viewbox") ?? "");
      const wMm = sizeMm?.widthMm ?? lengthMm(at.get("width")) ?? (vb.length === 4 ? vb[2] / PX_PER_MM : 0);
      const hMm = sizeMm?.heightMm ?? lengthMm(at.get("height")) ?? (vb.length === 4 ? vb[3] / PX_PER_MM : 0);
      res.widthMm = wMm;
      res.heightMm = hMm;
      if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        const sx = wMm > 0 ? wMm / vb[2] : 25.4 / 96;
        const sy = hMm > 0 ? hMm / vb[3] : sx;
        res.mmPerUu = Math.min(sx, sy);
        mtx = [1, 0, 0, 1, -vb[0], -vb[1]];
      }
    }
    mtx = mul(mtx, parseTransform(at.get("transform")));

    const hidden =
      (parent?.hidden ?? false) ||
      prop(at, st, "display") === "none" ||
      prop(at, st, "visibility") === "hidden" ||
      zeroish(prop(at, st, "opacity"));
    const parentFont = parent?.fontPx ?? null;
    const fsRaw = prop(at, st, "font-size");
    const fontPx = fsRaw !== undefined ? (lengthPx(fsRaw, parentFont ?? undefined) ?? parentFont) : parentFont;

    if (!hidden) {
      for (const p of COLOUR_PROPS) {
        const raw = prop(at, st, p);
        if (raw === undefined) continue;
        if (p === "fill" && zeroish(prop(at, st, "fill-opacity"))) continue;
        if (p === "stroke" && (zeroish(prop(at, st, "stroke-opacity")) || zeroish(prop(at, st, "stroke-width")))) continue;
        const h = normaliseColour(raw);
        if (h) colours.add(h);
      }
    }

    let textIdx = -1;
    if (VOID_TEXT.has(tag) && !hidden) {
      if (fontPx === null) {
        if (tag === "text") res.unresolvedTexts++;
      } else {
        const sizeMmVal = fontPx * scaleOf(mtx) * res.mmPerUu;
        res.texts.push({ sizePt: Math.round(sizeMmVal * PT_PER_MM * 1000) / 1000, text: "" });
        textIdx = res.texts.length - 1;
      }
    }

    const mark = at.get("data-mark");
    if (mark === "node" && !hidden) {
      const shape = nodeShape(tag, at, mtx);
      if (shape) res.nodes.push({ id: at.get("data-node") ?? at.get("id") ?? `#${res.nodes.length}`, shape, box: shapeBox(shape) });
    } else if (mark === "link" && !hidden) {
      const pts = linkPoints(tag, at, mtx);
      if (pts.length >= 2) res.links.push({ index: at.get("data-index") ?? String(res.links.length), points: pts });
    }

    if (tag === "style" && !selfClose) styleOpen = true;
    if (!selfClose) stack.push({ tag, m: mtx, fontPx, hidden, textIdx: textIdx >= 0 ? textIdx : VOID_TEXT.has(tag) ? -1 : (parent?.textIdx ?? -1) });
  }
  flushText(src.slice(last));
  res.colours = [...colours].sort();
  return res;
}

/**
 * Ambil blok `<svg>...</svg>` tingkat atas dari HTML (SVG bersarang ikut di dalam induknya).
 */
export function extractInlineSvgs(html: string, max = 500): string[] {
  const out: string[] = [];
  const re = /<(\/?)svg\b[^>]*?(\/?)>/gi;
  let depth = 0;
  let start = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    if (m[1] !== "/") {
      if (m[2] === "/") {
        if (depth === 0) out.push(m[0]);
        continue;
      }
      if (depth === 0) start = m.index;
      depth++;
    } else if (depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(html.slice(start, re.lastIndex));
        start = -1;
      }
    }
  }
  return out;
}
