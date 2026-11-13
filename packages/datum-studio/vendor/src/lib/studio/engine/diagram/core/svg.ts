/**
 * Primitif SVG diagram Garis A (port `_esc`, `_svg_text`, `_shape_svg`, defs
 * arsiran/kepala panah, jalur konektor, lompatan silang, pita knockout label;
 * `datum_diagram.py:1040-1112, 1214-1231, 1271-1322, 1410-1421`).
 *
 * Teks tetap teks nyata berfon IBM Plex (tidak dikonturkan). Angka ditulis
 * seperti `"%s" % round(x, n)` Python (lihat `pyfmt.ts`). Urutan atribut =
 * urutan Python; atribut peran tanda (`data-mark`, 01_specs.md §3.5 N2)
 * ditambahkan SETELAH atribut Python pada elemen tanda: bentuk simpul
 * `data-mark="node"`, jalur konektor `data-mark="link"` + `data-series=<jenis>`.
 * Opsi `dataMarks: false` menghasilkan keluaran Python murni.
 */
import type { DiagramEdgeKind, FaceRole, ProvenanceMark } from "../../../contract";
import { symbolBody } from "../../symbols";
import { FONT_ASCENT_EM, FONT_DESCENT_EM, measure, tspanLines } from "../../chart/core/textfit";
import { diagramFitActive } from "../fit/state";
import { nodeTextLayout, type TextBlockLayout } from "../fit/text";
import { type PyNumber, pyLen, pyNum, pyStr, pyStrNum } from "./pyfmt";
import type { SheetNode } from "./sheet";
import { nodeStrokeToken, nodeSymbolId } from "./sheet";
import { DiagramDefect } from "./defect";
import { xmlCommentText, xmlEscapeText } from "./xml";
import {
  DASH_PATTERNS,
  DIAGRAM_TOKENS,
  EDGE_KINDS,
  EDGE_KIND_NAMES_SORTED,
  FACES,
  INK_TEXT,
  LATTICE_Y,
  LIMITS,
  MARKS,
  PAPER,
  STROKE_HAIR,
  STROKE_PRIMARY,
  colourOf,
  estTextMm,
  faceOf,
  pt2mm,
  role,
  snap,
} from "./tokens";

/**
 * Escape isi teks seperti `_esc` Python (&, <, >), ditambah pembuangan
 * karakter yang tidak sah di XML 1.0 (IP-39b, S84 #4; Python meneruskannya
 * sehingga SVG rusak — deviasi yang disengaja, keluaran sama untuk teks sah).
 */
export function escText(s: unknown): string {
  return xmlEscapeText(pyStr(s), false);
}

/**
 * Escape nilai atribut: `_esc` Python ditambah `"` (Python tidak meng-escape
 * kutip sehingga id berkutip menghasilkan XML rusak; selain kasus itu identik).
 */
export function escAttr(s: unknown): string {
  return escText(s).replace(/"/g, "&quot;");
}

export interface SvgMarkOptions {
  /** Tambah atribut peran tanda (default true). */
  dataMarks?: boolean;
  /** Indeks tanda dalam gambar (`data-index`). */
  index?: number;
  /**
   * Swarm 1.2.8 row 56 (VIS-4, register N8-469, R18-2): `data-route` of a connector drawn `straight` or `curved`;
   * absent for orthogonal, so a default edge keeps its bytes (01f §3.2.4). Read by `edgePathSvg` only.
   */
  route?: "straight" | "curved";
}

export interface SvgTextOptions {
  /** Peran tipografi token (`type.scale_pt`), default `caption`. */
  role?: string;
  /** Nama token warna interior (menimpa warna peran). */
  colourToken?: string;
  /** Warna heks langsung (menimpa token; di luar Garis A). */
  fill?: string;
  /** Default `middle` (Python). */
  anchor?: "start" | "middle" | "end";
  upper?: boolean;
  /** Tracking em; `null`/tidak ada = tracking peran. */
  track?: number | null;
  weight?: number;
  /** Ukuran pt (menimpa ukuran peran; di luar Garis A). */
  sizePt?: number;
  /** Wajah (menimpa wajah peran; di luar Garis A). */
  faceRole?: FaceRole;
}

const FACE_ROLE_KEY: Readonly<Record<FaceRole, string>> = {
  serif: "serif",
  condensed: "condensed",
  mono: "mono",
  workbookUi: "workbook_ui",
  symbolGlyph: "mono",
};

/** Teks SVG nyata berfon Plex (`_svg_text`). */
export function svgText(x: PyNumber, y: PyNumber, text: unknown, opts: SvgTextOptions = {}): string {
  const roleName = opts.role ?? "caption";
  const r = role(roleName);
  const sizePt = opts.sizePt ?? r.size;
  const size = pt2mm(sizePt);
  const face = opts.faceRole ? FACES[FACE_ROLE_KEY[opts.faceRole]] : faceOf(roleName);
  const col = opts.fill ?? colourOf(opts.colourToken || r.colour || INK_TEXT);
  let txt = pyStr(text);
  if (opts.upper || r.upper) txt = txt.toUpperCase();
  let ls = "";
  const tr = opts.track !== undefined && opts.track !== null ? opts.track : r.track_em;
  if (tr) ls = ` letter-spacing="${pyNum(pt2mm(sizePt) * tr, 3)}"`;
  const w = opts.weight || r.weight || 400;
  return (
    `<text x="${pyNum(x, 2)}" y="${pyNum(y, 2)}" font-family="${escAttr(face)}" font-size="${pyNum(size, 3)}" ` +
    `font-weight="${w}" fill="${col}" text-anchor="${opts.anchor ?? "middle"}"${ls}>${escText(txt)}</text>`
  );
}

/**
 * Teks berbaris (FIG-02b): SATU `<text>` dengan `<tspan x dy>` per baris (multiset teks tetap
 * satu entri per label, D-482/D-491). Satu baris = keluaran `svgText` biasa.
 */
export function svgTextLines(b: TextBlockLayout, opts: SvgTextOptions = {}): string {
  if (b.lines.length <= 1) return svgText(b.x, b.y, b.lines[0] ?? "", opts);
  const shell = svgText(b.x, b.y, "", opts);
  const x = Number(pyNum(b.x, 2));
  const lines = opts.upper || role(opts.role ?? "caption").upper ? b.lines.map((l) => l.toUpperCase()) : b.lines;
  return `${shell.slice(0, -"</text>".length)}${tspanLines(lines, x, Number(b.lineMm.toFixed(3)))}</text>`;
}

function markAttrs(kind: "node" | "link", opts: SvgMarkOptions, series?: string): string {
  if (opts.dataMarks === false) return "";
  let a = ` data-mark="${kind}"`;
  if (series !== undefined) a += ` data-series="${escAttr(series)}"`;
  if (opts.index !== undefined) a += ` data-index="${opts.index}"`;
  return a;
}

const r2 = (v: number): string => pyNum(v, 2);

/** Isian simpul: arsiran 45 (aksen), 135 (sekunder), atau none. */
export function nodeFill(nd: Pick<SheetNode, "spec">): string {
  const c = nd.spec.class ?? {};
  if (c.accent) return "url(#datum-hatch45)";
  if (c.secondary) return "url(#datum-hatch135)";
  return "none";
}

/**
 * Swarm 1.2.8 row 53 (VIS-1b, 01f §1.1). Geometry of the three Basic Flowchart shapes that have their own outline:
 * - predefined: side bars at the `doubled` inset (1.2 mm) from the left and right sides;
 * - document: top and both sides straight, the bottom one sine period sampled into `DOCUMENT_WAVE_SEGMENTS` straight
 *   pieces (G-1: closure lint reads outlines by end points, so no `C`/`Q`/`A`), amplitude a = 0.08 h around y + h - a,
 *   crest band [y + h - 2a, y + h]; the right half bulges up, the left half down (the Visio document shape);
 * - offpage: pentagon, point down, sides straight to 0.7 h.
 * The same fractions are in `fit/text.ts` (text box) and `build/route.ts` (connection points).
 */
const PREDEFINED_BAR_MM = 1.2;
const DOCUMENT_WAVE_FRAC = 0.08;
const DOCUMENT_WAVE_SEGMENTS = 16;
const OFFPAGE_SIDE_FRAC = 0.7;

type OutlinePt = readonly [number, number];

/** Document outline, clockwise from the top-left corner (closed by `Z`). */
function documentOutline(x: number, y: number, w: number, h: number): OutlinePt[] {
  const a = h * DOCUMENT_WAVE_FRAC;
  const pts: OutlinePt[] = [[x, y], [x + w, y], [x + w, y + h - a]];
  for (let i = 1; i <= DOCUMENT_WAVE_SEGMENTS; i++) {
    const u = i / DOCUMENT_WAVE_SEGMENTS; // 0 at the right side, 1 at the left side
    pts.push([x + w - w * u, y + h - a - a * Math.sin(2 * Math.PI * u)]);
  }
  return pts;
}

/** Off-page reference outline (pentagon, point down). */
function offpageOutline(x: number, y: number, w: number, h: number): OutlinePt[] {
  return [[x, y], [x + w, y], [x + w, y + h * OFFPAGE_SIDE_FRAC], [x + w / 2, y + h], [x, y + h * OFFPAGE_SIDE_FRAC]];
}

/** `M x y L ... Z` of a closed outline (2 decimals). */
function outlineD(pts: readonly OutlinePt[]): string {
  return `${polylineD(pts)} Z`;
}

/**
 * Bentuk simpul (`_shape_svg`): 10 bentuk P3; bentuk tak dikenal jatuh ke box.
 * Hanya `stadium` beradius. Row 53: + predefined, document, offpage (01f §1.1).
 */
export function shapeSvg(
  nd: SheetNode,
  strokeToken: string,
  fill: string,
  opts: SvgMarkOptions & { strokeW?: number } = {},
): string {
  const shape = nd.spec.shape ?? "box";
  const { x, y, w, h } = nd;
  const sw = opts.strokeW ?? STROKE_PRIMARY;
  const col = colourOf(strokeToken);
  const common = `data-node="${escAttr(nd.id)}" fill="${fill}" stroke="${col}" stroke-width="${pyStrNum(sw)}"${markAttrs("node", opts)}`;
  switch (shape) {
    case "stadium": {
      const rr = h / 2.0;
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(rr)}" ry="${r2(rr)}" ${common}/>`;
    }
    case "diamond": {
      const pts = `${r2(x + w / 2)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ${r2(x + w / 2)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}`;
      return `<polygon points="${pts}" ${common}/>`;
    }
    case "parallelogram": {
      const k = w * 0.18;
      const pts = `${r2(x + k)},${r2(y)} ${r2(x + w)},${r2(y)} ${r2(x + w - k)},${r2(y + h)} ${r2(x)},${r2(y + h)}`;
      return `<polygon points="${pts}" ${common}/>`;
    }
    case "hexagon": {
      const k = w * 0.22;
      const pts =
        `${r2(x + k)},${r2(y)} ${r2(x + w - k)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ` +
        `${r2(x + w - k)},${r2(y + h)} ${r2(x + k)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}`;
      return `<polygon points="${pts}" ${common}/>`;
    }
    case "cylinder": {
      const ry = h * 0.16;
      return (
        `<path d="M${r2(x)} ${r2(y + ry)} a${r2(w / 2)} ${r2(ry)} 0 0 0 ${r2(w)} 0 ` +
        `L${r2(x + w)} ${r2(y + h - ry)} a${r2(w / 2)} ${r2(ry)} 0 0 1 -${r2(w)} 0 Z" ${common}/>`
      );
    }
    case "circle":
      return `<circle cx="${r2(x + w / 2)}" cy="${r2(y + h / 2)}" r="${r2(Math.min(w, h) / 2)}" ${common}/>`;
    case "bus":
      // P3: rel berat, garis tebal penuh lebar (Python tidak memberi data-node).
      // Swarm row 165O (C204 item 4): stroke-only line with an explicit fill="none" (no default black fill).
      return `<line x1="${r2(x)}" y1="${r2(y + h / 2)}" x2="${r2(x + w)}" y2="${r2(y + h / 2)}" fill="none" stroke="${col}" stroke-width="${r2(STROKE_PRIMARY * 3)}"${markAttrs("node", opts)}/>`;
    case "doubled":
      return (
        `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${common}/>` +
        `<rect x="${r2(x + 1.2)}" y="${r2(y + 1.2)}" width="${r2(w - 2.4)}" height="${r2(h - 2.4)}" fill="none" stroke="${col}" stroke-width="${r2(STROKE_HAIR)}"/>` +
        `<line x1="${r2(x + 1.2)}" y1="${r2(y + h / 2)}" x2="${r2(x + w - 1.2)}" y2="${r2(y + h / 2)}" fill="none" stroke="${col}" stroke-width="${r2(STROKE_HAIR)}"/>`
      );
    case "shadowed": {
      const off = snap(LATTICE_Y / 2, 0.1);
      return (
        `<rect x="${r2(x + off)}" y="${r2(y + off)}" width="${r2(w)}" height="${r2(h)}" fill="none" stroke="${colourOf("ink200")}" stroke-width="${r2(STROKE_HAIR)}"/>` +
        `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${common}/>`
      );
    }
    // Swarm 1.2.8 row 53 (VIS-1b, 01f §1.1, G-1/G-2): Basic Flowchart predefined process, document, off-page reference.
    case "predefined": {
      // outline = the box; two hair side bars at the `doubled` inset (G-2: no data-node, no data-mark)
      const bar = (bx: number) =>
        `<line x1="${r2(bx)}" y1="${r2(y)}" x2="${r2(bx)}" y2="${r2(y + h)}" fill="none" stroke="${col}" stroke-width="${r2(STROKE_HAIR)}"/>`;
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${common}/>` + bar(x + PREDEFINED_BAR_MM) + bar(x + w - PREDEFINED_BAR_MM);
    }
    case "document":
      return `<path d="${outlineD(documentOutline(x, y, w, h))}" ${common}/>`;
    case "offpage":
      return `<polygon points="${offpageOutline(x, y, w, h).map(([px, py]) => `${r2(px)},${r2(py)}`).join(" ")}" ${common}/>`;
    default:
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" ${common}/>`;
  }
}

/**
 * Swarm patch (row 124, CP-29): colour token of each provenance mark, manual Rev A Table 7.1
 * (ID p.38; tokens.json provenance.marks): TERUKUR ink900, DITURUNKAN signal, PEMASOK ink400,
 * ASUMSI alert. The original drew all four glyphs in signal.
 */
export const MARK_COLOUR_TOKENS: Readonly<Record<ProvenanceMark, string>> = {
  TERUKUR: "ink900",
  DITURUNKAN: "signal",
  PEMASOK: "ink400",
  ASUMSI: "alert",
};

/**
 * Swarm 1.2.6 row 61b (T-05 follow-up, finding F61-1): ink box of the provenance glyph for an anchor
 * (text-anchor end x, baseline y), measured as the geometry lint measures text (Plex em box, 12 % shrink
 * top and bottom), and the shortest distance from that box to an outline segment.
 */
const GLYPH_INK_SHRINK = 0.12; // = svgscan INK_SHRINK (geometry lint)
type GlyphPt = readonly [number, number];

function glyphInk(mark: ProvenanceMark | undefined): { w: number; asc: number; desc: number } {
  const sizePt = role("register_block").size;
  const sizeMm = pt2mm(sizePt);
  const sh = (FONT_ASCENT_EM + FONT_DESCENT_EM) * sizeMm * GLYPH_INK_SHRINK;
  const w = mark ? measure(MARKS[mark] ?? "", sizePt, "data") : 0;
  return { w, asc: FONT_ASCENT_EM * sizeMm - sh, desc: FONT_DESCENT_EM * sizeMm - sh };
}

function pointSegDist(p: GlyphPt, a: GlyphPt, b: GlyphPt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Distance from the axis-aligned box [x0, y0, x1, y1] to segment ab (0 when they touch). */
function boxSegDist(b: readonly [number, number, number, number], a: GlyphPt, c: GlyphPt): number {
  const inside = (p: GlyphPt) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
  if (inside(a) || inside(c)) return 0;
  const corners: GlyphPt[] = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
  const cross = (p: GlyphPt, q: GlyphPt, r: GlyphPt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  let d = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = corners[i];
    const q = corners[(i + 1) % 4];
    if (cross(p, q, a) * cross(p, q, c) < 0 && cross(a, c, p) * cross(a, c, q) < 0) return 0;
    d = Math.min(d, pointSegDist(p, a, c), pointSegDist(a, p, q), pointSegDist(c, p, q));
  }
  return d;
}

/** Lower (front) half of the ellipse centred (cx, cy), radii rx, ry, as a polyline left to right. */
function frontArc(cx: number, cy: number, rx: number, ry: number): GlyphPt[] {
  const n = 48;
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = Math.PI - (Math.PI * i) / n;
    return [cx + rx * Math.cos(t), cy + ry * Math.sin(t)] as GlyphPt;
  });
}

/**
 * Swarm 1.2.6 row 61b (T-05 follow-up, finding F61-1, GEOM_TEXT_NODE): glyph anchor of a hexagon, cylinder,
 * circle or bus node. The box anchor is kept whenever the glyph's ink already clears the outline (outline
 * stroke half + 1.5 pt), so every output that was clean stays byte-identical; otherwise:
 * - hexagon: inside, same baseline, moved left until the ink clears both right sides (perpendicular);
 * - circle: inside, at the top right of the circle's own square (baseline = square top + caption size), moved
 *   left until the ink's outer corners clear the rim; centred on the rim's centre line when the top is too tight;
 * - cylinder: inside the body, at the right edge (box x), lowered until the ink clears the front rim of the top
 *   ellipse; centred between the two rims when the body is too short for the full clearance;
 * - bus: the rail is a line at mid-height, so the glyph rises until its ink clears the heavy rail.
 */
function curvedGlyphAnchor(
  nd: Pick<SheetNode, "x" | "y" | "w" | "h" | "spec">,
  shape: "hexagon" | "cylinder" | "circle" | "bus",
  boxX: number,
  boxY: number,
  pad: number,
  capMm: number,
): { x: number; y: number } {
  const { x, y, w, h } = nd;
  if (!(w > 0 && h > 0)) return { x: boxX, y: boxY };
  const ink = glyphInk(nd.spec.mark);
  const half = (shape === "bus" ? STROKE_PRIMARY * 3 : STROKE_PRIMARY) / 2;
  const need = pad + half;
  const inkBox = (ax: number, ay: number) => [ax - ink.w, ay - ink.asc, ax, ay + ink.desc] as const;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const segs: [GlyphPt, GlyphPt][] = [];
  const poly = (pts: GlyphPt[], closed: boolean) => {
    for (let i = 0; i + 1 < pts.length; i++) segs.push([pts[i], pts[i + 1]]);
    if (closed) segs.push([pts[pts.length - 1], pts[0]]);
  };
  const ry = h * 0.16; // as in shapeSvg
  const r = Math.min(w, h) / 2;
  const topRim = frontArc(cx, y + ry, w / 2, ry);
  const botRim = frontArc(cx, y + h - ry, w / 2, ry);
  if (shape === "hexagon") {
    const k = w * 0.22;
    poly([[x + k, y], [x + w - k, y], [x + w, cy], [x + w - k, y + h], [x + k, y + h], [x, cy]], true);
  } else if (shape === "cylinder") {
    poly(topRim, false);
    poly(botRim, false);
    segs.push([[x, y + ry], [x, y + h - ry]], [[x + w, y + ry], [x + w, y + h - ry]]);
  } else if (shape === "bus") {
    segs.push([[x, cy], [x + w, cy]]);
  }
  const clearance = (ax: number, ay: number) => {
    const b = inkBox(ax, ay);
    if (shape === "circle") {
      const far = Math.max(...[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(([px, py]) => Math.hypot(px - cx, py - cy)));
      const near = Math.hypot(Math.max(b[0] - cx, 0, cx - b[2]), Math.max(b[1] - cy, 0, cy - b[3]));
      return far <= r ? r - far : near >= r ? near - r : 0;
    }
    return Math.min(...segs.map(([a, c]) => boxSegDist(b, a, c)));
  };
  if (clearance(boxX, boxY) >= need) return { x: boxX, y: boxY };
  if (shape === "bus") return { x: boxX, y: Math.min(boxY, cy - need - ink.desc) };
  if (shape === "hexagon") {
    const k = w * 0.22;
    const off = (need * Math.hypot(h / 2, k)) / (h / 2);
    const right = (yy: number) => x + w - (k * Math.abs(yy - cy)) / (h / 2) - off;
    return { x: Math.min(boxX, right(boxY - ink.asc), right(boxY + ink.desc)), y: boxY };
  }
  if (shape === "circle") {
    const rIn = r - need;
    let ay = Math.max(boxY, cy - r + capMm);
    let dy = Math.max(Math.abs(ay - ink.asc - cy), Math.abs(ay + ink.desc - cy));
    if (dy > rIn) {
      ay = cy + (ink.asc - ink.desc) / 2; // ink centred on the rim's centre line
      dy = (ink.asc + ink.desc) / 2;
    }
    return { x: Math.min(boxX, cx + Math.sqrt(Math.max(0, rIn * rIn - dy * dy))), y: ay };
  }
  // cylinder: the ink top must clear every point of the top front rim by `need`, its bottom the bottom rim.
  const x0 = boxX - ink.w;
  const gap = (u: number) => Math.max(0, x0 - u, u - boxX);
  let topMin = -Infinity;
  for (const p of topRim) {
    const dx = gap(p[0]);
    if (dx < need) topMin = Math.max(topMin, p[1] + Math.sqrt(need * need - dx * dx));
  }
  let botMax = Infinity;
  for (const p of botRim) {
    const dx = gap(p[0]);
    if (dx < need) botMax = Math.min(botMax, p[1] - Math.sqrt(need * need - dx * dx));
  }
  const lo = topMin + ink.asc;
  const hi = botMax - ink.desc;
  return { x: boxX, y: lo <= hi ? Math.max(boxY, lo) : (lo + hi) / 2 };
}

/**
 * Swarm 1.2.6 row 61 (T-05, rev 183/184 GEOM_TEXT_NODE): anchor (text-anchor="end" x, baseline y) of the
 * provenance glyph. Every shape keeps the box anchor (right edge - 1.5 pt, top + caption size), except the two
 * shapes whose top-right corner is cut by a slanted side, where the glyph's ink touched the outline:
 * - parallelogram: the glyph stays inside and moves left by the slant at the glyph's bottom, plus the 1.5 pt
 *   clearance measured perpendicular to the slanted side;
 * - diamond: the glyph stays in the top-right corner of the box, outside the outline, and rises (never drops)
 *   until its bottom-left corner clears the upper-right side by the same perpendicular 1.5 pt.
 */
export function markGlyphAnchor(nd: Pick<SheetNode, "x" | "y" | "w" | "h" | "spec">): { x: number; y: number } {
  const pad = pt2mm(1.5);
  const capMm = pt2mm(role("caption").size);
  const boxX = nd.x + nd.w - pad;
  const boxY = nd.y + capMm;
  const shape = nd.spec.shape;
  // Swarm 1.2.8 row 53 (VIS-1b): on a predefined process the glyph sits inside the right side bar.
  if (shape === "predefined") return { x: boxX - PREDEFINED_BAR_MM, y: boxY };
  if (shape === "hexagon" || shape === "cylinder" || shape === "circle" || shape === "bus") {
    return curvedGlyphAnchor(nd, shape, boxX, boxY, pad, capMm);
  }
  if (shape !== "parallelogram" && shape !== "diamond") return { x: boxX, y: boxY };
  const { x, y, w, h } = nd;
  if (!(w > 0 && h > 0)) return { x: boxX, y: boxY };
  const sizeMm = pt2mm(role("register_block").size);
  const descMm = FONT_DESCENT_EM * sizeMm;
  if (shape === "parallelogram") {
    // right side: (x + w, y) -> (x + w - k, y + h), k as in shapeSvg
    const k = w * 0.18;
    const t = Math.min(1, (capMm + descMm) / h);
    return { x: boxX - k * t - pad * (Math.hypot(h, k) / h - 1), y: boxY };
  }
  // diamond, upper-right side: (x + w/2, y) -> (x + w, y + h/2), slope h / w
  const mk = nd.spec.mark;
  const glyphW = mk ? measure(MARKS[mk] ?? "", role("register_block").size, "data") : 0;
  const left = boxX - glyphW;
  const sideY = y + (h * Math.max(0, left - (x + w / 2))) / w;
  const bottom = sideY - (pad * Math.hypot(w, h)) / w;
  return { x: boxX, y: Math.min(boxY, bottom - descMm) };
}

/** Glif asal (mono; pitfall warisan: jangan tukar wajah). Row 124: warna per tanda (Tabel 7.1). */
export function markGlyphSvg(nd: SheetNode): string {
  const mk = nd.spec.mark;
  const glyph = mk ? MARKS[mk] : "";
  const fill = colourOf(mk ? (MARK_COLOUR_TOKENS[mk] ?? "signal") : "signal");
  const at = markGlyphAnchor(nd);
  return (
    `<text x="${r2(at.x)}" y="${r2(at.y)}" ` +
    `font-family="${escAttr(FACES.mono)}" font-size="${pyNum(pt2mm(role("register_block").size), 3)}" ` +
    `fill="${fill}" text-anchor="end">${escText(glyph)}</text>`
  );
}

/** Row 124 (CP-45): largest and smallest badge (mm) of a node symbol, and its inset from the box. */
const SYMBOL_BADGE_MAX_MM = 10;
const SYMBOL_BADGE_MIN_MM = 7;
const SYMBOL_INSET_X_MM = 0.6;
const SYMBOL_INSET_Y_MM = 0.4;

/**
 * Swarm patch (row 124, CP-45; manual Rev A Table 10.1 nodes[], SM-01, ID p.63, 66): draw the
 * library symbol a node specifies (e.g. `iec:battery` on the UPS) as a badge inside the box:
 * top-left, or bottom-left when the top-left corner holds the requirement tag. The 24 mm library
 * cell is scaled into the badge; stroke widths are divided by the scale so every printed line
 * keeps its library width (>= 0.18 mm photocopy floor, DT-11a), and a symbol whose own text would
 * print below 5.5 pt at that scale is refused (DATUM-28). `data-symbol` names the symbol,
 * `data-symbol-of` the node (not `data-node`: the badge is not a second node shape).
 * Empty string when the node names no symbol.
 */
export function nodeSymbolSvg(nd: SheetNode): string {
  const sid = nodeSymbolId(nd.spec);
  if (!sid) return "";
  const body = symbolBody(sid);
  const avail = Math.min(nd.h - 2 * SYMBOL_INSET_Y_MM, nd.w * 0.4);
  const want = Math.min(SYMBOL_BADGE_MAX_MM, Math.max(SYMBOL_BADGE_MIN_MM, nd.h * 0.5));
  let size = Math.min(want, avail);
  const fonts = [...body.markup.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
  const minFont = fonts.length ? Math.min(...fonts) : Infinity;
  const floorMm = pt2mm(LIMITS.diagram_type_min_pt);
  if (Number.isFinite(minFont)) size = Math.max(size, (floorMm / minFont) * body.cellMm);
  if (size > avail + 1e-9 || size <= 0) {
    throw new DiagramDefect(
      `CP-45: simbol ${body.id} pada simpul '${nd.id}' tidak muat terbaca (perlu ${pyNum(size, 2)} mm, tersedia ${pyNum(avail, 2)} mm); perbesar simpul atau pakai kotak bernama (SM-01)`,
      { checkId: "CP-45" },
    );
  }
  const sc = size / body.cellMm;
  const markup = body.markup.replace(/stroke-width="([\d.]+)"/g, (_, w: string) => `stroke-width="${pyNum(Number(w) / sc, 4)}"`);
  const x = nd.x + SYMBOL_INSET_X_MM;
  const y = nd.spec.tag ? nd.y + nd.h - size - SYMBOL_INSET_Y_MM : nd.y + SYMBOL_INSET_Y_MM;
  return (
    `<g data-symbol="${escAttr(body.id)}" data-symbol-of="${escAttr(nd.id)}" ` +
    `transform="translate(${r2(x)} ${r2(y)}) scale(${pyNum(sc, 4)})">${markup}</g>`
  );
}

/**
 * Semua elemen satu simpul, urutan `build_svg`: bentuk, label (caption ink900),
 * sub (source_line), glif asal, tag (table_header ink400 rata kiri).
 */
// ---------------------------------------------------------------- row 165C
/** Row 165C (F113-10): spacing and weight of the hatch lines, as the original `<pattern>` declared them. */
export const HATCH_PITCH_MM = 1.6;
export const HATCH_STROKE_MM = 0.3;

/** Row 165C (F113-10): hatch angle of a node (45 accent, 135 secondary, as `nodeFill`), null = no hatch. */
export function nodeHatchAngle(nd: Pick<SheetNode, "spec">): 45 | 135 | null {
  const c = nd.spec.class ?? {};
  if (c.accent) return 45;
  if (c.secondary) return 135;
  return null;
}

/**
 * Swarm patch (row 165C, F113-10, CP-47): hatch as plain vector `<line>`s instead of an SVG `<pattern>` fill.
 * Chromium prints a pattern fill into the PDF as a raster image (measured: a 363 x 554 px image block under the
 * whole figure, PyMuPDF get_image_info), so the figure was not fully vector. The lines lie where the pattern put
 * them (pattern space x = 0 mod 1.6 mm, rotated by `angle` about the origin: x cos a + y sin a = 1.6 k) and are
 * cut to the box `x, y, w, h` here (Liang-Barsky on the box); a non-rectangular node also gets a `clipPath`
 * (`clipSvg`). Weight 0.3 mm = the declared pattern line (the pattern tile showed only half of it, 0.15 mm,
 * below the 0.18 mm photocopy floor of tokens.json).
 */
export function hatchLinesSvg(x: number, y: number, w: number, h: number, angle: 45 | 135, clip?: { id: string; shape: string }): string {
  if (!(w > 0) || !(h > 0)) return "";
  const a = (angle * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const us = [x * cos + y * sin, (x + w) * cos + y * sin, x * cos + (y + h) * sin, (x + w) * cos + (y + h) * sin];
  const kMin = Math.ceil(Math.min(...us) / HATCH_PITCH_MM - 1e-9);
  const kMax = Math.floor(Math.max(...us) / HATCH_PITCH_MM + 1e-9);
  const dx = -sin;
  const dy = cos;
  const lines: string[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const c = k * HATCH_PITCH_MM;
    const px = c * cos;
    const py = c * sin;
    // t-range where (px + t dx, py + t dy) lies in the box.
    const tx = [(x - px) / dx, (x + w - px) / dx].sort((p, q) => p - q);
    const ty = [(y - py) / dy, (y + h - py) / dy].sort((p, q) => p - q);
    const t0 = Math.max(tx[0], ty[0]);
    const t1 = Math.min(tx[1], ty[1]);
    if (t1 - t0 < 0.05) continue; // shorter than 0.05 mm: a corner touch, nothing to print
    lines.push(`<line x1="${r2(px + t0 * dx)}" y1="${r2(py + t0 * dy)}" x2="${r2(px + t1 * dx)}" y2="${r2(py + t1 * dy)}"/>`);
  }
  if (!lines.length) return "";
  // Swarm row 165O (C204 item 4, F-Y3): explicit fill="none". Without it the group's lines inherit the SVG default fill
  // (black) and Chromium writes a #000000 fill colour into the PDF figure page, although a line has no area.
  const g = `fill="none" stroke="${colourOf("ink400")}" stroke-width="${pyStrNum(HATCH_STROKE_MM)}" data-hatch="${angle}"`;
  if (!clip) return `<g ${g}>${lines.join("")}</g>`;
  return `<clipPath id="${escAttr(clip.id)}">${clip.shape}</clipPath><g ${g} clip-path="url(#${escAttr(clip.id)})">${lines.join("")}</g>`;
}

/** Row 165C: shapes whose outline is the box itself (hatch cut to the box exactly, no clipPath). */
const BOX_SHAPES: ReadonlySet<string> = new Set(["box", "shadowed", "doubled", "predefined"]); // row 53: + predefined

/** Row 165C: outline of a non-box node as a bare clip element (same geometry as `shapeSvg`), null = box/unknown/bus. */
function clipShapeSvg(shape: string, x: number, y: number, w: number, h: number): string | null {
  switch (shape) {
    case "stadium":
      return `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${r2(h / 2)}" ry="${r2(h / 2)}"/>`;
    case "diamond":
      return `<polygon points="${r2(x + w / 2)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ${r2(x + w / 2)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}"/>`;
    case "parallelogram": {
      const k = w * 0.18;
      return `<polygon points="${r2(x + k)},${r2(y)} ${r2(x + w)},${r2(y)} ${r2(x + w - k)},${r2(y + h)} ${r2(x)},${r2(y + h)}"/>`;
    }
    case "hexagon": {
      const k = w * 0.22;
      return `<polygon points="${r2(x + k)},${r2(y)} ${r2(x + w - k)},${r2(y)} ${r2(x + w)},${r2(y + h / 2)} ${r2(x + w - k)},${r2(y + h)} ${r2(x + k)},${r2(y + h)} ${r2(x)},${r2(y + h / 2)}"/>`;
    }
    case "cylinder": {
      const ry = h * 0.16;
      return `<path d="M${r2(x)} ${r2(y + ry)} a${r2(w / 2)} ${r2(ry)} 0 0 0 ${r2(w)} 0 L${r2(x + w)} ${r2(y + h - ry)} a${r2(w / 2)} ${r2(ry)} 0 0 1 -${r2(w)} 0 Z"/>`;
    }
    case "circle":
      return `<circle cx="${r2(x + w / 2)}" cy="${r2(y + h / 2)}" r="${r2(Math.min(w, h) / 2)}"/>`;
    case "document": // row 53 (VIS-1b)
      return `<path d="${outlineD(documentOutline(x, y, w, h))}"/>`;
    case "offpage":
      return `<polygon points="${offpageOutline(x, y, w, h).map(([px, py]) => `${r2(px)},${r2(py)}`).join(" ")}"/>`;
    default:
      return null;
  }
}

/**
 * Swarm patch (row 165C, F113-9, CP-37): a node outline that lies on the sheet edge (x = 0 or x + w = W, the same
 * for y) had half of its stroke outside the canvas, so the PNG/SVG cut it. The DRAWN outline is moved inside by
 * half a stroke on the sides that would cross the edge; layout, routes and texts keep the placed geometry.
 */
export function insetForStroke<T extends Pick<SheetNode, "x" | "y" | "w" | "h">>(nd: T, canvas: { widthMm: number; heightMm: number } | undefined, sw: number): T {
  if (!canvas) return nd;
  // Limits on the 0.01 mm grid the SVG numbers are written on (r2), rounded inward, so rounding never puts the
  // stroke back across the edge.
  const lo = Math.ceil((sw / 2) * 100 - 1e-9) / 100;
  const hiX = Math.floor((canvas.widthMm - sw / 2) * 100 + 1e-9) / 100;
  const hiY = Math.floor((canvas.heightMm - sw / 2) * 100 + 1e-9) / 100;
  const x0 = Math.max(nd.x, lo);
  const y0 = Math.max(nd.y, lo);
  const x1 = Math.min(nd.x + nd.w, hiX);
  const y1 = Math.min(nd.y + nd.h, hiY);
  if (x0 === nd.x && y0 === nd.y && x1 === nd.x + nd.w && y1 === nd.y + nd.h) return nd;
  if (x1 <= x0 || y1 <= y0) return nd;
  return { ...nd, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// ---------------------------------------------------------------- row 53 (H-TAG)
/**
 * Swarm 1.2.8 row 53 (H-TAG, register N8-218, values R20-C37 / 01f §5.4): left inset (mm) of the requirement tag from
 * the node box, per shape, so the tag's ink lies inside the drawn outline. `TAG_INSET_MM.fixed` = 1.5 pt (0.53 mm), the
 * inset every shape had before; `TAG_INSET_MM.bar` = the inner line of `doubled` / side bar of `predefined`;
 * `TAG_INSET_MM.skew` = the slant of parallelogram and hexagon (fraction of w, as in `shapeSvg`). Stadium: the corner
 * radius h/2. Doubled: also 1.2 mm down (inside the inner rectangle). Cylinder: baseline lowered by the lid (2 ry = 0.32 h). Diamond and circle: centred one tag line above
 * the label block. Shapes not listed (box, shadowed, document, offpage, bus and the BPMN tokens until row 54 draws
 * them) keep the fixed inset; the bus tag stays at the top-left of its box, above the rail (OP-18-10, row 53).
 */
export const TAG_INSET_MM = {
  fixed: pt2mm(1.5),
  bar: PREDEFINED_BAR_MM,
  skew: { parallelogram: 0.18, hexagon: 0.22 },
  cylinderLidFrac: 0.32,
} as const;

/** Row 53 (H-TAG): anchor of the tag text of a node (x, baseline, text-anchor), from the shape and the label layout. */
export function tagAnchor(
  nd: Pick<SheetNode, "x" | "y" | "w" | "h" | "spec">,
  fit: ReturnType<typeof nodeTextLayout>,
): { x: number; y: number; anchor: "start" | "middle" } {
  const { x, y, w, h } = nd;
  const capMm = pt2mm(role("caption").size);
  const P = TAG_INSET_MM.fixed;
  switch (nd.spec.shape) {
    case "doubled": // inside the inner rectangle (its top line is 1.2 mm down too)
      return { x: x + TAG_INSET_MM.bar + P, y: y + TAG_INSET_MM.bar + capMm, anchor: "start" };
    case "predefined": // between the side bars
      return { x: x + TAG_INSET_MM.bar + P, y: y + capMm, anchor: "start" };
    case "stadium":
      return { x: x + h / 2, y: y + capMm, anchor: "start" };
    case "parallelogram":
    case "hexagon":
      return { x: x + w * TAG_INSET_MM.skew[nd.spec.shape] + P, y: y + capMm, anchor: "start" };
    case "cylinder":
      return { x: x + P, y: y + capMm + h * TAG_INSET_MM.cylinderLidFrac, anchor: "start" };
    case "diamond":
    case "circle": {
      // centred above the label block: first label baseline (fit layout, else the one-line label at the centre)
      // minus one tag line (`tagH` of fit/text.ts, caption x 1.2)
      const first = fit ? fit.label.y : y + h / 2;
      return { x: x + w / 2, y: first - capMm * 1.2, anchor: "middle" };
    }
    default:
      return { x: x + P, y: y + capMm, anchor: "start" };
  }
}

// ---------------------------------------------------------------- row 165J
/** Row 165J (F165H-2): paper margin around a text line on a hatched node (mm): beside the glyphs and above/below. */
export const TEXT_GROUND_PAD_X_MM = 0.5;
export const TEXT_GROUND_PAD_Y_MM = 0.3;
/** Row 165J: cap height and descender of IBM Plex (em) the ground covers; the line box (1.025/0.275 em) is not needed. */
const GROUND_ASCENT_EM = 0.78;
const GROUND_DESCENT_EM = 0.24;

interface GroundLine {
  x: number;
  y: number;
  s: string;
  role: string;
  anchor: "start" | "middle" | "end";
  face?: "struct" | "data";
  sizePt?: number;
}

/**
 * Swarm patch (row 165J, F165H-2; C191 ruling 1, verification/25 §5.3): on a hatched node the hatch (ink400, 0.3 mm)
 * ran through the node texts, and the sub-label and the requirement tag ARE ink400, so they were hard to read at print
 * size. Every text line of a hatched node (label, sub-label, tag, mark glyph) gets a `<rect>` in the paper colour
 * behind it: the glyph width (`measure`, the fit metric of the condensed face; mono for the mark glyph) plus
 * `TEXT_GROUND_PAD_X_MM`, from the cap height to the descender plus `TEXT_GROUND_PAD_Y_MM`. Each rect is cut to the
 * inside of the drawn outline (half a stroke in), and a non-box node clips the rects with its own outline clip, so no
 * ground reaches outside the node. Colours: paper only (already the figure ground), so CP-43 / DATUM-25 count no new
 * colour. Rects, not a paint-order stroke halo: Word's SVG renderer does not honour paint-order, and a paper stroke
 * painted over the glyphs would erode them. Returns "" when the node has no text.
 */
export function nodeTextGroundSvg(
  nd: SheetNode,
  g: Pick<SheetNode, "x" | "y" | "w" | "h">,
  fit: ReturnType<typeof nodeTextLayout>,
  clipId: string | null,
): string {
  const n = nd.spec;
  const cx = nd.x + nd.w / 2.0;
  const cy = nd.y + nd.h / 2.0;
  const capMm = pt2mm(role("caption").size);
  const lines: GroundLine[] = [];
  const block = (b: TextBlockLayout, roleName: string) => b.lines.forEach((s, i) => lines.push({ x: b.x, y: b.y + i * b.lineMm, s, role: roleName, anchor: "middle" }));
  if (fit) {
    block(fit.label, "caption");
    if (fit.sub) block(fit.sub, "source_line");
    else if (n.sub) lines.push({ x: cx, y: cy + capMm, s: pyStr(n.sub), role: "source_line", anchor: "middle" });
  } else {
    lines.push({ x: cx, y: cy, s: pyStr(n.label), role: "caption", anchor: "middle" });
    if (n.sub) lines.push({ x: cx, y: cy + capMm, s: pyStr(n.sub), role: "source_line", anchor: "middle" });
  }
  if (n.mark) {
    const glyph = MARKS[n.mark] ?? "";
    const at = markGlyphAnchor(nd);
    lines.push({ x: at.x, y: at.y, s: glyph, role: "register_block", anchor: "end", face: "data" });
  }
  if (n.tag) {
    const at = tagAnchor(nd, fit); // row 53 (H-TAG): drawn outline (sheet-edge inset)
    lines.push({ x: at.x, y: at.y, s: pyStr(n.tag), role: "table_header", anchor: at.anchor });
  }
  const half = STROKE_PRIMARY / 2;
  const bx0 = g.x + half;
  const by0 = g.y + half;
  const bx1 = g.x + g.w - half;
  const by1 = g.y + g.h - half;
  const rects: string[] = [];
  for (const ln of lines) {
    if (!ln.s.trim()) continue;
    const r = role(ln.role);
    const pt = ln.sizePt ?? r.size;
    const sizeMm = pt2mm(pt);
    const upper = !!r.upper;
    const trackMm = r.track_em ? sizeMm * r.track_em : 0;
    const w = measure(ln.s, pt, ln.face ?? "struct", { bold: (r.weight ?? 400) >= 600, trackMm, caps: upper });
    const lx = ln.anchor === "middle" ? ln.x - w / 2 : ln.anchor === "end" ? ln.x - w : ln.x;
    const x0 = Math.max(bx0, lx - TEXT_GROUND_PAD_X_MM);
    const x1 = Math.min(bx1, lx + w + TEXT_GROUND_PAD_X_MM);
    const y0 = Math.max(by0, ln.y - GROUND_ASCENT_EM * sizeMm - TEXT_GROUND_PAD_Y_MM);
    const y1 = Math.min(by1, ln.y + GROUND_DESCENT_EM * sizeMm + TEXT_GROUND_PAD_Y_MM);
    if (x1 - x0 < 0.05 || y1 - y0 < 0.05) continue;
    rects.push(`<rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(x1 - x0)}" height="${r2(y1 - y0)}" fill="${PAPER}"/>`);
  }
  if (!rects.length) return "";
  const clip = clipId !== null ? ` clip-path="url(#${escAttr(clipId)})"` : "";
  return `<g data-text-ground="1"${clip}>${rects.join("")}</g>`;
}

/**
 * Swarm 1.2.8 row 53 (VIS-1b, H-TAG): shapes whose text box is not centred on the node box get their text layout in the
 * first render as well (outside fit the label is otherwise drawn at the centre): document (above the wave), offpage
 * (top 0.7 h) and a cylinder with a tag (below the lid and the tag line). Every other node: null (unchanged output).
 */
function firstRenderLayout(nd: SheetNode): ReturnType<typeof nodeTextLayout> {
  const shape = nd.spec.shape;
  const tagged = nd.spec.tag !== undefined && nd.spec.tag !== null && nd.spec.tag !== "";
  if (shape === "document" || shape === "offpage" || (shape === "cylinder" && tagged)) return nodeTextLayout(nd);
  return null;
}

/** Row 165C: options of `nodeSvg` (sheet size for the half-stroke inset of F113-9). */
export interface NodeSvgOptions extends SvgMarkOptions {
  canvas?: { widthMm: number; heightMm: number };
}

export function nodeSvg(nd: SheetNode, opts: NodeSvgOptions = {}): string[] {
  const n = nd.spec;
  // Row 165C (F113-9/F113-10): outline inset at the sheet edge; hatch drawn as vector lines under the outline.
  const { canvas, ...markOpts } = opts;
  const g = insetForStroke(nd, canvas, STROKE_PRIMARY);
  const angle = (n.shape ?? "box") === "bus" ? null : nodeHatchAngle(nd);
  const out: string[] = [];
  const cx = nd.x + nd.w / 2.0;
  const cy = nd.y + nd.h / 2.0;
  const capMm = pt2mm(role("caption").size);
  // FIG-02b: hanya saat fit dan hanya bila label tidak muat satu baris (atau rel bus).
  const fit = diagramFitActive() ? nodeTextLayout(nd) : firstRenderLayout(nd);
  if (angle !== null) {
    const shape = n.shape ?? "box";
    const clipShape = BOX_SHAPES.has(shape) ? null : clipShapeSvg(shape, g.x, g.y, g.w, g.h);
    const clipId = `datum-hatch-clip-${opts.index ?? escAttr(nd.id).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const hatch = hatchLinesSvg(g.x, g.y, g.w, g.h, angle, clipShape !== null ? { id: clipId, shape: clipShape } : undefined);
    if (hatch) {
      out.push(hatch);
      // Row 165J (F165H-2): a paper ground behind every text line of a hatched node, so no hatch line runs through
      // a glyph (the sub-label and the ID were the hatch colour, ink400). Drawn after the hatch and before the outline.
      const ground = nodeTextGroundSvg(nd, g, fit, clipShape !== null ? clipId : null);
      if (ground) out.push(ground);
    }
  }
  out.push(shapeSvg(g, nodeStrokeToken(nd), "none", { ...markOpts, strokeW: STROKE_PRIMARY }));
  const sym = nodeSymbolSvg(nd); // row 124 (CP-45): specified symbol, drawn before the texts
  if (sym) out.push(sym);
  if (fit) {
    out.push(svgTextLines(fit.label, { role: "caption", colourToken: "ink900" }));
    if (fit.sub) out.push(svgTextLines(fit.sub, { role: "source_line" }));
    else if (n.sub) out.push(svgText(cx, cy + capMm, n.sub, { role: "source_line" }));
  } else {
    out.push(svgText(cx, cy, n.label, { role: "caption", colourToken: "ink900" }));
    if (n.sub) out.push(svgText(cx, cy + capMm, n.sub, { role: "source_line" }));
  }
  if (n.mark) out.push(markGlyphSvg(nd));
  if (n.tag) {
    const at = tagAnchor(nd, fit); // row 53 (H-TAG, N8-218): inset per shape, from the drawn outline (F113-9 sheet-edge inset)
    out.push(svgText(at.x, at.y, n.tag, { role: "table_header", colourToken: "ink400", anchor: at.anchor }));
  }
  return out;
}

/** Pola garis per jenis konektor (`stroke-dasharray` atau null untuk solid). */
export function edgeDash(kind: DiagramEdgeKind): string | null {
  return DASH_PATTERNS[EDGE_KINDS[kind].pattern];
}

/** Tebal garis konektor: aksen 1,6x primer. */
export function edgeStrokeWidth(kind: DiagramEdgeKind): number {
  return kind === "accent" ? STROKE_PRIMARY * 1.6 : STROKE_PRIMARY;
}

/** Atribut `d` polilinear "M x y L x y ..." (dibulatkan 2 desimal). */
export function polylineD(pts: ReadonlyArray<readonly [number, number]>): string {
  return `M ${pts.map(([px, py]) => `${r2(px)} ${r2(py)}`).join(" L ")}`;
}

/** Jalur konektor (6 jenis, pola garis ISO 128-2, kepala panah per jenis). */
export function edgePathSvg(
  pts: ReadonlyArray<readonly [number, number]>,
  kind: DiagramEdgeKind,
  opts: SvgMarkOptions = {},
): string {
  const meta = EDGE_KINDS[kind];
  const dash = DASH_PATTERNS[meta.pattern];
  let attrs = `fill="none" stroke="${colourOf(meta.colour)}" stroke-width="${r2(edgeStrokeWidth(kind))}"`;
  if (dash) attrs += ` stroke-dasharray="${dash}"`;
  const route = opts.route === "straight" || opts.route === "curved" ? ` data-route="${opts.route}"` : "";
  return `<path d="${polylineD(pts)}" ${attrs} marker-end="url(#head-${kind})"${markAttrs("link", opts, kind)}${route}/>`;
}

/** Kepala panah satu jenis (P4: solid terisi, open bergaris). */
export function edgeMarkerSvg(kind: DiagramEdgeKind): string {
  const meta = EDGE_KINDS[kind];
  const col = colourOf(meta.colour);
  if (meta.head === "solid") {
    return `<marker id="head-${kind}" markerWidth="4" markerHeight="4" refX="3.4" refY="1.6" orient="auto"><path d="M0,0 L3.6,1.6 L0,3.2 Z" fill="${col}"/></marker>`;
  }
  return `<marker id="head-${kind}" markerWidth="4" markerHeight="4" refX="3.4" refY="1.6" orient="auto"><path d="M0,0 L3.6,1.6 L0,3.2" fill="none" stroke="${col}" stroke-width="0.35"/></marker>`;
}

/** Pola arsiran 45/135 derajat (isian diagram tahan fotokopi). */
export function hatchPatternSvg(angle: 45 | 135): string {
  return (
    `<pattern id="datum-hatch${angle}" width="1.6" height="1.6" patternUnits="userSpaceOnUse" ` +
    `patternTransform="rotate(${angle})"><line x1="0" y1="0" x2="0" y2="1.6" stroke="${colourOf("ink400")}" stroke-width="0.3"/></pattern>`
  );
}

/** Row 124: what a figure actually draws from `<defs>`. */
export interface DiagramDefsUse {
  kinds: Iterable<DiagramEdgeKind>;
  hatch45: boolean;
  hatch135: boolean;
}

/**
 * Blok `<defs>` sebagai baris-baris terpisah (urutan Python: arsiran, kepala panah terurut).
 * Swarm patch (row 124, CP-43 / C23 check 25; DT-06 ID p.48): with `use`, only the hatch patterns
 * and arrow heads the figure references are defined, so no unused colour (the alert and verd
 * heads of the original) is printed into the file. Without `use` = the original full block.
 */
export function diagramDefs(use?: DiagramDefsUse): string[] {
  if (!use) return ["<defs>", hatchPatternSvg(45), hatchPatternSvg(135), ...EDGE_KIND_NAMES_SORTED.map(edgeMarkerSvg), "</defs>"];
  const kinds = new Set(use.kinds);
  const out: string[] = [];
  if (use.hatch45) out.push(hatchPatternSvg(45));
  if (use.hatch135) out.push(hatchPatternSvg(135));
  out.push(...EDGE_KIND_NAMES_SORTED.filter((k) => kinds.has(k)).map(edgeMarkerSvg));
  return out.length ? ["<defs>", ...out, "</defs>"] : [];
}

/**
 * Swarm patch (row 124, CP-28/CP-48; DT-15 ID p.41, 9.5 p.57): figure caption line. When the line
 * starts with the label (`GAMBAR 4.1`), the label is set in a SemiBold `<tspan>` and the sentence
 * follows at the caption weight, in the same `<text>` (one caption element, as before).
 */
export function captionSvg(x: PyNumber, y: PyNumber, line: string, label: string, opts: SvgTextOptions = {}): string {
  const shell = svgText(x, y, "", opts);
  if (!label || !line.startsWith(label)) return svgText(x, y, line, opts);
  const head = shell.slice(0, -"</text>".length);
  return `${head}<tspan font-weight="600">${escText(label)}</tspan>${escText(line.slice(label.length))}</text>`;
}

/**
 * Komentar generator (padanan baris komentar Python; bukan elemen). Nilai yang
 * disisipkan lewat `xmlCommentText`: tidak pernah memuat "--" (S84 #3), walau
 * `family` di jalur build sudah tervalidasi ke enum keluarga.
 */
export function generatorComment(family: string): string {
  const fam = xmlCommentText(escText(family));
  const tok = xmlCommentText(escText(DIAGRAM_TOKENS.sourceName));
  return `<!-- generator studio engine/diagram (port datum_diagram.py v2.0.0 Garis A, rebuild DHS-RB-04) | family=${fam} | token=${tok} -->`;
}

/** Komentar kewajiban apparatus page (P6, dilaporkan lint cek 36). */
export const APPARATUS_REQUIRED_COMMENT =
  "<!-- DATUM-APPARATUS-REQUIRED: caption, source dan baris kunci dicetak oleh halaman, bukan oleh SVG ini (P6, lint cek 36) -->";

/** Latar kertas penuh lembar. */
export function paperRectSvg(widthMm: number, heightMm: number): string {
  return `<rect x="0" y="0" width="${pyNum(widthMm, 3)}" height="${pyNum(heightMm, 3)}" fill="${PAPER}"/>`;
}

/** Garis lurus bertoken (pemisah lajur, parit, garis kehidupan). */
export function lineSvg(
  x1: PyNumber,
  y1: PyNumber,
  x2: PyNumber,
  y2: PyNumber,
  colourToken: string,
  strokeW: number,
  dash?: string | null,
): string {
  const d = dash ? ` stroke-dasharray="${dash}"` : "";
  // Swarm row 165O (C204 item 4): explicit fill="none" on a stroke-only line.
  return `<line x1="${pyNum(x1, 2)}" y1="${pyNum(y1, 2)}" x2="${pyNum(x2, 2)}" y2="${pyNum(y2, 2)}" fill="none" stroke="${colourOf(colourToken)}" stroke-width="${r2(strokeW)}"${d}/>`;
}

/** Lompatan silang pada lintasan horizontal (r = 0,9 mm). */
export function hopSvg(hx: number, hy: number, kind: DiagramEdgeKind): string {
  const r = LIMITS.hop_radius_mm;
  return (
    `<path d="M ${r2(hx - r)} ${r2(hy)} A ${r2(r)} ${r2(r)} 0 0 1 ${r2(hx + r)} ${r2(hy)}" ` +
    `fill="none" stroke="${colourOf(EDGE_KINDS[kind].colour)}" stroke-width="${r2(STROKE_PRIMARY)}"/>`
  );
}

/** Pita kertas pemutus garis di belakang label tepi (`_label_knockout`; my = garis dasar). */
export function labelKnockoutSvg(mx: number, my: number, text: unknown, sheetW: number, kwMm?: number): string {
  const r = role("evidence_rail");
  const size = pt2mm(r.size);
  const tr = r.track_em;
  // Python memakai pt2mm(size) atas size yang sudah mm (dipertahankan untuk paritas).
  const lw = estTextMm(text, "evidence_rail") + (tr ? pt2mm(size) * tr * pyLen(pyStr(text)) : 0.0);
  // FIG-02b: saat fit, lebar pita = lebar mono terukur 0,6 em + 1,6 (`fit/labels.ts knockWidthMm`).
  const kw = kwMm ?? lw + 1.6;
  const kh = size * 1.7;
  const kx = Math.min(Math.max(mx - kw / 2.0, 0.0), Math.max(0.0, sheetW - kw));
  const ky = my - size * 1.15;
  return `<rect x="${r2(kx)}" y="${r2(ky)}" width="${r2(kw)}" height="${r2(kh)}" fill="${PAPER}"/>`;
}

/** Label konektor: pita knockout lalu teks evidence_rail berwarna jenis. */
export function edgeLabelSvg(mx: number, my: number, label: unknown, kind: DiagramEdgeKind, sheetW: number, kwMm?: number): string[] {
  return [
    labelKnockoutSvg(mx, my, label, sheetW, kwMm),
    svgText(mx, my, label, { role: "evidence_rail", colourToken: EDGE_KINDS[kind].colour, anchor: "middle" }),
  ];
}
