/**
 * engine/diagram/fit — lint geometri keluaran diagram (FIG-02b, audit research/18 §2.3, §6 P1-10..13).
 *
 * Port tanpa browser dari metrik harness FIG-01 (`measure.mjs`) untuk SVG diagram Garis A.
 * Kotak teks ditaksir dengan `textfit` (tabel glif IBM Plex terkalibrasi Chromium, mono 0,6 em),
 * tinggi = em box Plex (ascent 1,025 / descent 0,275) disusutkan 12 % tinggi kotak di atas/bawah,
 * seperti `getBBox` + susut harness. Teks diagram tidak pernah diputar, jadi kotaknya sejajar sumbu.
 *
 * Sembilan jenis cacat (nama = harness):
 * - `textOverlap`: irisan dua kotak teks > 0,2 mm² dan > 8 % kotak terkecil (per pasangan elemen);
 * - `textOutside`: sudut kotak teks di luar viewBox > 0,3 mm;
 * - `lineThroughText`: titik sampel teks kena goresan konektor (`data-mark="link"`); label tepi
 *   berpita knockout (rect kertas tepat sebelum `<text>`) dikecualikan;
 * - `textOverNode`: titik sampel teks kena garis tepi simpul (`data-mark="node"` / `data-node`);
 * - `textExceedsNode`: teks yang pusatnya di dalam kotak `data-node` tetapi lebih lebar dari kotak itu;
 * - `edgeCross`: perpotongan sejati segmen konektor berbeda, di luar 0,6 mm dari ujung konektor;
 * - `edgeCollinear`: dua konektor berimpit pada garis yang sama > 1 mm;
 * - `edgeThroughNode`: segmen konektor menembus interior simpul bukan-ujung (susut 0,3 mm);
 * - `textStraddleMark` tidak berlaku (diagram tidak punya tanda isian data) dan tidak dihitung.
 *
 * Murni dan deterministik. Parser hanya memahami keluaran `Sheet`/`core/svg.ts` (atribut
 * ber-kutip ganda, angka mm, tanpa transform) — bukan parser SVG umum. Satu-satunya transform yang
 * dipetakan: `translate(...)` pada `<g data-symbol>` dan grup di dalamnya (petak lembar simbol,
 * row 150c / C144); teks di grup berskala (lencana simpul) tetap dilewati.
 */
import {
  attrsOf,
  bboxOf,
  type Box,
  boxQuad,
  inkSamples,
  INK_SHRINK,
  MM_PER_PT,
  OUTSIDE_MIN_MM,
  OVERLAP_MIN_FRAC,
  OVERLAP_MIN_MM2,
  pathPolylines,
  type Pt,
  segDist,
  unescXml as unesc,
} from "../../chart/core/svgscan";
import { FONT_ASCENT_EM, FONT_DESCENT_EM, measure } from "../../chart/core/textfit";
import { LATTICE_X } from "../core/tokens";

export type { Box } from "../../chart/core/svgscan";

export type DiagramDefectKind =
  | "textOverlap"
  | "textOutside"
  | "lineThroughText"
  | "textOverNode"
  | "textExceedsNode"
  | "edgeCross"
  | "edgeCollinear"
  | "edgeThroughNode"
  | "edgeEntryCollision"
  | "stubSegment"
  | "arrowTangent";

export const DIAGRAM_DEFECT_KINDS: readonly DiagramDefectKind[] = [
  "textOverlap",
  "textOutside",
  "lineThroughText",
  "textOverNode",
  "textExceedsNode",
  "edgeCross",
  "edgeCollinear",
  "edgeThroughNode",
  "edgeEntryCollision",
  "stubSegment",
  "arrowTangent",
];

/**
 * Swarm 1.2.6 T-03 (register N-008..N-010). Thresholds of the three connector-end checks:
 * - `ENTRY_COLLISION_MM`: two connector ends on the same node border closer than this (one of them an
 *   entry, i.e. a polyline end) read as one point (`edgeEntryCollision`);
 * - `STUB_SEGMENT_MIN_MM`: a visible straight connector piece shorter than this that is not anchored at
 *   both ends (source border and arrowhead) reads as a stub leading nowhere (`stubSegment`);
 * - `ARROW_TANGENT_TOL_DEG`: an arrowhead whose last piece is within this angle of the border it lands on
 *   runs along the border instead of into it (`arrowTangent`).
 */
export const ENTRY_COLLISION_MM = 1.5;
/** T-03 kinds: counted and failed by the gate, not part of `score` (see `DiagramGeomLint.score`). */
const T03_KINDS: ReadonlySet<DiagramDefectKind> = new Set(["edgeEntryCollision", "stubSegment", "arrowTangent"]);
export const STUB_SEGMENT_MIN_MM = 2.0;
/** Row 53 (H-TAG): tolerance of the tag-inside-outline check (0.01 mm output grid plus float noise). */
const TAG_OUTSIDE_MIN_MM = 0.05;
export const ARROW_TANGENT_TOL_DEG = 15;

export interface DiagramGeomDefect {
  kind: DiagramDefectKind;
  /** Teks yang terdampak (atau "tepi i" untuk cacat konektor). */
  text: string;
  other?: string;
  amount?: number;
}

export interface DiagramGeomLint {
  widthMm: number;
  heightMm: number;
  counts: Record<DiagramDefectKind, number>;
  defects: DiagramGeomDefect[];
  /**
   * Jumlah cacat tata letak (0 = bersih) yang dibandingkan auto-fit. T-03 (Swarm 1.2.6): the
   * connector-end kinds (`T03_KINDS`) are in `counts` and `defects` (the FIGURE_FIT gate fails them)
   * but not in `score`, so figures the engine builds today keep their auto-fit path byte for byte (U3).
   */
  score: number;
}

interface TextEl {
  text: string;
  box: Box;
  area: number;
  knock: boolean;
  samples: Pt[];
  /** Row 53 (H-TAG): anchor point (x, baseline) of a requirement-tag-like text (start or middle, bold, tracked). */
  tagAt?: Pt;
  /**
   * Swarm 1.2.8 row 54 (VIS-3a, §5.3, N8-480): index in `nodes` of the outline a text is the label block of (text inside
   * `<g data-label-pos="below">`, which follows its node's outline element).
   */
  belowOf?: number;
}

interface NodeShape {
  id: string | null;
  /** Garis tepi (polilinear tertutup atau terbuka) dan setengah tebal goresan. */
  outline: Pt[][];
  circle?: { cx: number; cy: number; r: number };
  /** Row 53 (H-TAG): corner radius of a rounded `<rect>` (stadium), read only by the tag containment check. */
  rx?: number;
  half: number;
  box: Box;
}

function onPolylines(p: Pt, pls: readonly (readonly Pt[])[], half: number): boolean {
  for (const pl of pls) for (let k = 0; k + 1 < pl.length; k++) if (segDist(p, pl[k], pl[k + 1]) <= half + 1e-9) return true;
  return false;
}

/** Sampel 7 x 3 di dalam kotak teks (inset seperti harness; primitif bersama `svgscan`). */
function samplesOf(b: Box): Pt[] {
  return inkSamples(boxQuad(b));
}

/** Kotak satu elemen `<text>` (gabungan semua baris tspan, seperti `getBBox`). */
export function textBlockBox(
  lines: ReadonlyArray<{ x: number; y: number; s: string; segs?: ReadonlyArray<{ s: string; bold: boolean }> }>,
  sizeMm: number,
  anchor: string,
  face: "struct" | "data",
  bold: boolean,
  trackMm: number,
): Box | null {
  const pt = sizeMm / MM_PER_PT;
  let x0 = Infinity;
  let x1 = -Infinity;
  let top = Infinity;
  let bot = -Infinity;
  let any = false;
  for (const ln of lines) {
    if (!ln.s.trim()) continue;
    any = true;
    // Row 124: a line made of inline runs (bold caption label + sentence) is measured run by run.
    const w = ln.segs ? ln.segs.reduce((sum, g) => sum + measure(g.s, pt, face, { bold: g.bold, trackMm }), 0) : measure(ln.s, pt, face, { bold, trackMm });
    const lx = anchor === "middle" ? ln.x - w / 2 : anchor === "end" ? ln.x - w : ln.x;
    x0 = Math.min(x0, lx);
    x1 = Math.max(x1, lx + w);
    top = Math.min(top, ln.y - FONT_ASCENT_EM * sizeMm);
    bot = Math.max(bot, ln.y + FONT_DESCENT_EM * sizeMm);
  }
  if (!any) return null;
  const sh = (bot - top) * INK_SHRINK;
  return [x0, top + sh, x1, bot - sh];
}

/**
 * Row 150c: offset of a transform that is only `translate(x[, y])` (absent = no offset); null for any
 * other transform (scale, matrix, rotate, a chain), whose coordinates the lint does not map.
 */
export function translateOnly(tr: string | undefined): [number, number] | null {
  if (tr === undefined || !tr.trim()) return [0, 0];
  const m = /^\s*translate\(\s*([-+]?[\d.]+(?:e[-+]?\d+)?)(?:\s*[\s,]\s*([-+]?[\d.]+(?:e[-+]?\d+)?))?\s*\)\s*$/i.exec(tr);
  if (!m) return null;
  const x = Number(m[1]);
  const y = m[2] !== undefined ? Number(m[2]) : 0;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

interface Scan {
  W: number;
  H: number;
  texts: TextEl[];
  nodes: NodeShape[];
  links: Pt[][];
  linkHalf: number[];
  /** T-03: document order of each link (a knockout band drawn later hides it). */
  linkOrder: number[];
  /** Swarm 1.2.8 row 56 (VIS-4, OP-18-6): true for a link drawn with `data-route="curved"` (sampled Bezier). */
  linkCurved: boolean[];
  /** T-03: label knockout bands (paper rect right before a `<text>`) with their document order. */
  bands: { box: Box; order: number }[];
}

function scan(svg: string): Scan {
  const root = /<svg\b[^>]*viewBox="([^"]+)"/.exec(svg);
  const vb = root ? root[1].trim().split(/[\s,]+/).map(Number) : [0, 0, 0, 0];
  const W = vb[2] ?? 0;
  const H = vb[3] ?? 0;
  const texts: TextEl[] = [];
  const nodes: NodeShape[] = [];
  const links: Pt[][] = [];
  const linkHalf: number[] = [];
  const linkOrder: number[] = [];
  const linkCurved: boolean[] = [];
  const bands: { box: Box; order: number }[] = [];
  let pendingBand: { box: Box; order: number } | null = null;
  let inDefs = 0;
  // Row 150c (C144 A): one frame per open <g> inside a `data-symbol` group. A group whose transform is
  // only translate(...) (symbol-sheet cell, symbols/index.ts, sheet-fit.ts) prints at 1:1, so its text
  // (cell labels, letters drawn in the symbol) is read with the accumulated offset. A scaled group (node
  // badge, diagram/core/svg.ts nodeSymbolSvg) is cell units: its text stays skipped, as in row 124.
  const symStack: { read: boolean; dx: number; dy: number }[] = [];
  let prevKnock = false;
  // Row 54 (VIS-3a): node index of the open `<g data-label-pos="below">` (it holds only texts, so the next `</g>` closes it).
  let belowOf: number | null = null;
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>|<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g;
  for (let k = re.exec(svg); k; k = re.exec(svg)) {
    if (k[1] !== undefined) {
      const knock = prevKnock;
      prevKnock = false;
      if (knock && pendingBand && !inDefs && !symStack.length) bands.push(pendingBand);
      pendingBand = null;
      if (inDefs) continue;
      const sym = symStack.length ? symStack[symStack.length - 1] : null;
      if (sym && !sym.read) continue; // row 124: text of a scaled node symbol badge is symbol geometry
      const a = attrsOf(k[1]);
      const sizeMm = Number(a["font-size"] ?? 0);
      if (!(sizeMm > 0)) continue;
      const face = /mono/i.test(a["font-family"] ?? "") ? "data" : "struct";
      const bold = Number(a["font-weight"] ?? 400) >= 600;
      const track = Number(a["letter-spacing"] ?? 0) || 0;
      const anchor = a["text-anchor"] ?? "start";
      const body = k[2].replace(/<title>[\s\S]*?<\/title>/g, "");
      const ox = sym ? sym.dx : 0;
      const oy = sym ? sym.dy : 0;
      const x0 = Number(a.x ?? 0) + ox;
      const y0 = Number(a.y ?? 0) + oy;
      const spans = [...body.matchAll(/<tspan\b([^>]*)>([\s\S]*?)<\/tspan>/g)];
      const lines: { x: number; y: number; s: string; segs?: { s: string; bold: boolean }[] }[] = [];
      // Row 124 (CP-28/48): tspans without x, y and dy are inline runs of ONE line (the bold label of
      // a figure caption); the whole body is that line, measured run by run.
      const inline = spans.length > 0 && spans.every((sp) => {
        const sa = attrsOf(sp[1]);
        return sa.x === undefined && sa.y === undefined && sa.dy === undefined;
      });
      if (inline) {
        const segs: { s: string; bold: boolean }[] = [];
        let at = 0;
        for (const sp of spans) {
          const i = sp.index ?? 0;
          if (i > at) segs.push({ s: unesc(body.slice(at, i).replace(/<[^>]+>/g, "")), bold });
          segs.push({ s: unesc(sp[2].replace(/<[^>]+>/g, "")), bold: Number(attrsOf(sp[1])["font-weight"] ?? (bold ? 600 : 400)) >= 600 });
          at = i + sp[0].length;
        }
        if (at < body.length) segs.push({ s: unesc(body.slice(at).replace(/<[^>]+>/g, "")), bold });
        lines.push({ x: x0, y: y0, s: segs.map((g) => g.s).join(""), segs });
      } else if (spans.length) {
        let cy = y0;
        for (const sp of spans) {
          const sa = attrsOf(sp[1]);
          cy += Number(sa.dy ?? 0) || 0;
          lines.push({ x: sa.x !== undefined ? Number(sa.x) + ox : x0, y: sa.y !== undefined ? Number(sa.y) + oy : cy, s: unesc(sp[2]) });
        }
      } else lines.push({ x: x0, y: y0, s: unesc(body.replace(/<[^>]+>/g, "")) });
      const box = textBlockBox(lines, sizeMm, anchor, face, bold, track);
      if (!box) continue;
      // Row 53 (H-TAG): the tag (role table_header: weight 600, tracked) is the only bold tracked text a node draws.
      const tagLike = bold && track > 0 && (anchor === "start" || anchor === "middle") && lines.length === 1;
      texts.push({
        text: lines.map((l) => l.s).join(" "),
        box,
        area: Math.max(1e-9, (box[2] - box[0]) * (box[3] - box[1])),
        knock,
        samples: samplesOf(box),
        ...(tagLike ? { tagAt: [x0, y0] as Pt } : {}),
        ...(belowOf !== null ? { belowOf } : {}),
      });
      continue;
    }
    const closing = k[3] === "/";
    const tag = k[4];
    const selfClose = k[6] === "/";
    if (closing) {
      if (tag === "g" && belowOf !== null && !symStack.length) belowOf = null;
      if (tag === "defs") inDefs = Math.max(0, inDefs - 1);
      if (tag === "g" && symStack.length) symStack.pop();
      continue;
    }
    // Row 124 (CP-45): a node symbol badge (`<g data-symbol>`, scaled cell) is drawn inside its node;
    // its shapes are neither nodes nor connectors and its coordinates are cell units.
    // Row 150c: shapes stay skipped; texts are read when every group up to the symbol group is translate-only.
    if (tag === "g" && !selfClose && (symStack.length || /\bdata-symbol="/.test(k[5]))) {
      const parent = symStack.length ? symStack[symStack.length - 1] : { read: true, dx: 0, dy: 0 };
      const t = translateOnly(attrsOf(k[5]).transform);
      symStack.push(parent.read && t ? { read: true, dx: parent.dx + t[0], dy: parent.dy + t[1] } : { read: false, dx: 0, dy: 0 });
      continue;
    }
    if (symStack.length) continue;
    if (tag === "g" && !selfClose && /\bdata-label-pos="below"/.test(k[5]) && nodes.length) {
      belowOf = nodes.length - 1;
      continue;
    }
    if (tag === "defs" && !selfClose) {
      inDefs++;
      prevKnock = false;
      continue;
    }
    if (inDefs || tag === "svg" || tag === "g" || tag === "title" || tag === "tspan") continue;
    const a = attrsOf(k[5]);
    // pita knockout: rect berisi tanpa goresan/tanda tepat sebelum <text> (core/svg labelKnockoutSvg)
    prevKnock =
      tag === "rect" &&
      a["data-mark"] === undefined &&
      a["data-node"] === undefined &&
      a.stroke === undefined &&
      a.fill !== undefined &&
      a.fill !== "none" &&
      !(Number(a.x ?? 0) === 0 && Number(a.y ?? 0) === 0 && Math.abs(Number(a.width ?? 0) - W) < 1e-6);
    pendingBand = prevKnock
      ? { box: [Number(a.x ?? 0), Number(a.y ?? 0), Number(a.x ?? 0) + Number(a.width ?? 0), Number(a.y ?? 0) + Number(a.height ?? 0)], order: k.index }
      : null;
    const mark = a["data-mark"];
    const nodeId = a["data-node"];
    if (mark === "link" && tag === "path") {
      const pl = pathPolylines(a.d ?? "");
      if (pl.length && pl[0].length >= 2) {
        links.push(pl[0].map((p) => [p[0], p[1]] as Pt));
        linkHalf.push((Number(a["stroke-width"] ?? 0) || 0) / 2);
        linkOrder.push(k.index);
        linkCurved.push(a["data-route"] === "curved");
      }
      continue;
    }
    if (mark !== "node" && nodeId === undefined) continue;
    const half = (Number(a["stroke-width"] ?? 0) || 0) / 2;
    let outline: Pt[][] = [];
    let circle: NodeShape["circle"];
    let rx: number | undefined;
    if (tag === "rect") {
      const x = Number(a.x ?? 0);
      const y = Number(a.y ?? 0);
      const w = Number(a.width ?? 0);
      const h = Number(a.height ?? 0);
      outline = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
      if (Number(a.rx ?? 0) > 0) rx = Math.min(Number(a.rx), w / 2, h / 2);
    } else if (tag === "polygon") {
      const v = (a.points ?? "").trim().split(/[\s,]+/).map(Number);
      const pts: Pt[] = [];
      for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]);
      if (pts.length) outline = [[...pts, pts[0]]];
    } else if (tag === "path") {
      outline = pathPolylines(a.d ?? "").map((pl) => pl.map((p) => [p[0], p[1]] as Pt));
    } else if (tag === "circle") {
      circle = { cx: Number(a.cx ?? 0), cy: Number(a.cy ?? 0), r: Number(a.r ?? 0) };
    } else if (tag === "line") {
      outline = [[[Number(a.x1 ?? 0), Number(a.y1 ?? 0)], [Number(a.x2 ?? 0), Number(a.y2 ?? 0)]]];
    } else continue;
    const box: Box = circle
      ? [circle.cx - circle.r, circle.cy - circle.r, circle.cx + circle.r, circle.cy + circle.r]
      : bboxOf(outline.flat());
    if (!Number.isFinite(box[0])) continue;
    nodes.push({ id: nodeId ?? null, outline, circle, ...(rx !== undefined ? { rx } : {}), half, box });
  }
  return { W, H, texts, nodes, links, linkHalf, linkOrder, linkCurved, bands };
}

function segX(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const den = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / den;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / den;
  if (t <= 1e-6 || t >= 1 - 1e-6 || u <= 1e-6 || u >= 1 - 1e-6) return null;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Jumlah persilangan sejati dan pasangan segmen berimpit di antara polilinear konektor. */
export function edgeConflicts(polys: ReadonlyArray<ReadonlyArray<Pt>>): { cross: number; collinear: number } {
  let cross = 0;
  let collinear = 0;
  const near = (p: Pt, q: Pt) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.6;
  for (let i = 0; i < polys.length; i++) {
    for (let j = i + 1; j < polys.length; j++) {
      const P = polys[i];
      const Q = polys[j];
      const ends = [P[0], P[P.length - 1], Q[0], Q[Q.length - 1]];
      for (let a = 0; a + 1 < P.length; a++) {
        for (let b = 0; b + 1 < Q.length; b++) {
          const x = segX(P[a], P[a + 1], Q[b], Q[b + 1]);
          if (x && !ends.some((e) => near(e, x))) cross++;
          const A = P[a];
          const B = P[a + 1];
          const C = Q[b];
          const D = Q[b + 1];
          const hor = Math.abs(A[1] - B[1]) < 1e-6 && Math.abs(C[1] - D[1]) < 1e-6 && Math.abs(A[1] - C[1]) < 0.15;
          const ver = Math.abs(A[0] - B[0]) < 1e-6 && Math.abs(C[0] - D[0]) < 1e-6 && Math.abs(A[0] - C[0]) < 0.15;
          if (hor || ver) {
            const k = hor ? 0 : 1;
            const lo = Math.max(Math.min(A[k], B[k]), Math.min(C[k], D[k]));
            const hi = Math.min(Math.max(A[k], B[k]), Math.max(C[k], D[k]));
            if (hi - lo > 1.0) collinear++;
          }
        }
      }
    }
  }
  return { cross, collinear };
}

// ── T-03 (Swarm 1.2.6): connector ends ─────────────────────────────────────

/** Bend angle below which two consecutive polyline steps count as one straight piece (sampled curves). */
const STRAIGHT_TURN_DEG = 20;
/** A visible piece shorter than this is a sliver under a band edge, not a mark the reader sees. */
const SLIVER_MM = 0.25;
/** A connector end farther than this (plus half the node stroke) from every node outline is not on a border. */
const ON_BORDER_MM = 0.6;

/** Polyline without repeated points and with nearly straight steps merged (bends only). */
function straightPieces(pl: readonly Pt[]): Pt[] {
  const pts: Pt[] = [];
  for (const p of pl) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-6) pts.push(p);
  }
  if (pts.length < 3) return pts;
  const out: Pt[] = [pts[0]];
  for (let i = 1; i + 1 < pts.length; i++) {
    const a = out[out.length - 1];
    const b = pts[i];
    const c = pts[i + 1];
    const turn = Math.abs(angleDeg(b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]));
    if (turn >= STRAIGHT_TURN_DEG) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** Unsigned angle between two direction vectors, 0..180 degrees. */
function angleDeg(ax: number, ay: number, bx: number, by: number): number {
  const la = Math.hypot(ax, ay);
  const lb = Math.hypot(bx, by);
  if (la < 1e-9 || lb < 1e-9) return 0;
  const c = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)));
  return (Math.acos(c) * 180) / Math.PI;
}

/** Parameter interval [t0, t1] of segment a-b inside box b (Liang-Barsky), or null. */
function clipT(a: Pt, b: Pt, box: Box): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const ps = [-dx, dx, -dy, dy];
  const qs = [a[0] - box[0], box[2] - a[0], a[1] - box[1], box[3] - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(ps[i]) < 1e-12) {
      if (qs[i] < 0) return null;
      continue;
    }
    const r = qs[i] / ps[i];
    if (ps[i] < 0) t0 = Math.max(t0, r);
    else t1 = Math.min(t1, r);
    if (t0 > t1) return null;
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

/** Visible sub-intervals of [0, 1] after removing the covered intervals. */
function visibleT(covered: [number, number][]): [number, number][] {
  const c = [...covered].sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [s, e] of c) {
    if (s > at) out.push([at, s]);
    at = Math.max(at, e);
  }
  if (at < 1) out.push([at, 1]);
  return out;
}

/** Distance from p to the nearest outline of node n (circle: to its rim). */
function borderDist(p: Pt, n: NodeShape): number {
  if (n.circle) return Math.abs(Math.hypot(p[0] - n.circle.cx, p[1] - n.circle.cy) - n.circle.r);
  let d = Infinity;
  for (const pl of n.outline) for (let k = 0; k + 1 < pl.length; k++) d = Math.min(d, segDist(p, pl[k], pl[k + 1]));
  return d;
}

/** Node whose border carries p (nearest within tolerance), or -1. */
function borderNodeOf(p: Pt, nodes: readonly NodeShape[]): number {
  let best = -1;
  let bd = Infinity;
  nodes.forEach((n, i) => {
    if (p[0] < n.box[0] - 2 || p[0] > n.box[2] + 2 || p[1] < n.box[1] - 2 || p[1] > n.box[3] + 2) return;
    const d = borderDist(p, n);
    if (d <= n.half + ON_BORDER_MM && d < bd) {
      bd = d;
      best = i;
    }
  });
  return best;
}

/**
 * T-03 `edgeEntryCollision`: two connector ends on the border of the same node closer than
 * `ENTRY_COLLISION_MM`, at least one of them an entry (polyline end). Two exits sharing one port
 * (a fan-out) are not counted.
 */
function entryCollisions(links: ReadonlyArray<ReadonlyArray<Pt>>, nodes: readonly NodeShape[]): Array<{ a: number; b: number; node: number; gap: number }> {
  const ends: { p: Pt; link: number; entry: boolean; node: number }[] = [];
  links.forEach((pl, i) => {
    if (pl.length < 2) return;
    for (const [p, entry] of [[pl[pl.length - 1], true], [pl[0], false]] as const) {
      const node = borderNodeOf(p, nodes);
      if (node >= 0) ends.push({ p, link: i, entry, node });
    }
  });
  const out: Array<{ a: number; b: number; node: number; gap: number }> = [];
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      const A = ends[i];
      const B = ends[j];
      if (A.link === B.link || A.node !== B.node || !(A.entry || B.entry)) continue;
      const gap = Math.hypot(A.p[0] - B.p[0], A.p[1] - B.p[1]);
      if (gap < ENTRY_COLLISION_MM) out.push({ a: A.link, b: B.link, node: A.node, gap });
    }
  }
  return out;
}

/**
 * T-03 `stubSegment`: short connector pieces that lead nowhere. The connector is cut into visible
 * straight pieces (bends of the polyline and label knockout bands drawn over it end a piece). A piece
 * is a stub when it is shorter than `STUB_SEGMENT_MIN_MM` and
 *  (a) it is a jog: a polyline step between two bends;
 *  (b) it floats: both of its ends are under label bands;
 *  (c) it is a tick: one end on the source border or the arrowhead, the other under a band, and it is
 *      shorter than half the threshold;
 *  (d) it is detached: it leaves the source border into a band and the connector comes out of the band
 *      turned or displaced sideways by more than half a lattice column (`LATTICE_X` / 2), so the reader cannot
 *      join the two. A label sitting on a straight or half-column jog (the accepted rev 210 figure,
 *      fixture t03_n1) is not a stub.
 * Calibration (row 25): F1 fixtures t03_k1..k7 each give at least one stub; t03_n1/n2 give none.
 * Swarm 1.2.8 row 56 (VIS-4, 01f §7 (b), OP-18-6): on a link with `data-route="curved"` only the first and the last
 * straight piece are checked. Its `CURVE_SAMPLES` steps merge into pieces of about `STRAIGHT_TURN_DEG`, whose length
 * is the sampling of one smooth curve, not a routing stub.
 */
function stubSegments(
  links: ReadonlyArray<ReadonlyArray<Pt>>,
  bandsOver: ReadonlyArray<ReadonlyArray<Box>>,
  curved: ReadonlyArray<boolean> = [],
): Array<{ link: number; length: number }> {
  type End = "src" | "head" | "bend" | "cut";
  interface Piece { a: Pt; b: Pt; st: End; en: End; jog: boolean; len: number }
  const out: Array<{ link: number; length: number }> = [];
  links.forEach((raw, li) => {
    const pl = straightPieces(raw);
    const pieces: Piece[] = [];
    for (let s = 0; s + 1 < pl.length; s++) {
      if (curved[li] && s > 0 && s + 2 < pl.length) continue; // row 56: interior piece of a sampled curve
      const a = pl[s];
      const b = pl[s + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-9) continue;
      const covered: [number, number][] = [];
      for (const box of bandsOver[li] ?? []) {
        const t = clipT(a, b, box);
        if (t) covered.push(t);
      }
      const jog = s > 0 && s + 2 < pl.length;
      for (const [t0, t1] of visibleT(covered)) {
        const at = (t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        pieces.push({
          a: at(t0),
          b: at(t1),
          st: t0 < 1e-9 ? (s === 0 ? "src" : "bend") : "cut",
          en: t1 > 1 - 1e-9 ? (s + 2 === pl.length ? "head" : "bend") : "cut",
          jog: jog && t0 < 1e-9 && t1 > 1 - 1e-9,
          len: (t1 - t0) * len,
        });
      }
    }
    pieces.forEach((p, k) => {
      if (p.len < SLIVER_MM || p.len >= STUB_SEGMENT_MIN_MM) return;
      const anchored = (e: End) => e === "src" || e === "head";
      let stub = p.jog || (p.st === "cut" && p.en === "cut");
      if (!stub && ((anchored(p.st) && p.en === "cut") || (p.st === "cut" && anchored(p.en)))) stub = p.len < STUB_SEGMENT_MIN_MM / 2;
      if (!stub && p.st === "src" && p.en === "cut" && k + 1 < pieces.length) {
        const n = pieces[k + 1];
        const ux = (p.b[0] - p.a[0]) / p.len;
        const uy = (p.b[1] - p.a[1]) / p.len;
        const turned = angleDeg(ux, uy, n.b[0] - n.a[0], n.b[1] - n.a[1]) >= STRAIGHT_TURN_DEG;
        const side = Math.abs(ux * (n.a[1] - p.b[1]) - uy * (n.a[0] - p.b[0]));
        stub = turned || side > LATTICE_X / 2 + 0.1;
      }
      if (stub) out.push({ link: li, length: p.len });
    });
  });
  return out;
}

/**
 * T-03 `arrowTangent`: a connector whose last straight piece lands on a node border within
 * `ARROW_TANGENT_TOL_DEG` of that border's direction (it runs along the border, or into a corner
 * along the next side, instead of meeting the border head-on).
 */
function arrowTangents(links: ReadonlyArray<ReadonlyArray<Pt>>, nodes: readonly NodeShape[]): Array<{ link: number; node: number; deg: number }> {
  const out: Array<{ link: number; node: number; deg: number }> = [];
  links.forEach((raw, li) => {
    const pl = straightPieces(raw);
    if (pl.length < 2) return;
    const e = pl[pl.length - 1];
    const p = pl[pl.length - 2];
    const dx = e[0] - p[0];
    const dy = e[1] - p[1];
    const ni = borderNodeOf(e, nodes);
    if (ni < 0) return;
    const n = nodes[ni];
    const tol = n.half + ON_BORDER_MM;
    let worst = Infinity;
    if (n.circle) {
      // tangent of a circle at e is normal to the radius
      worst = 90 - angleDeg(dx, dy, e[0] - n.circle.cx, e[1] - n.circle.cy);
      worst = Math.abs(worst);
    } else {
      for (const ol of n.outline) {
        for (let k = 0; k + 1 < ol.length; k++) {
          if (segDist(e, ol[k], ol[k + 1]) > tol) continue;
          const sx = ol[k + 1][0] - ol[k][0];
          const sy = ol[k + 1][1] - ol[k][1];
          if (Math.hypot(sx, sy) < 1e-9) continue;
          const d = angleDeg(dx, dy, sx, sy);
          worst = Math.min(worst, Math.min(d, 180 - d));
        }
      }
    }
    if (worst <= ARROW_TANGENT_TOL_DEG) out.push({ link: li, node: ni, deg: worst });
  });
  return out;
}

/** Row 53 (H-TAG): ray-cast point-in-polygon on a closed ring (the last point may repeat the first). */
function inRing(p: Pt, ring: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Row 53 (H-TAG, 01f §5.4): how far (mm) the point lies outside the region the node outline encloses (0 inside), or
 * null when the outline encloses no area (bus rail, open path). Circle and rounded rect exact; else the outline ring.
 */
function outsideRegion(p: Pt, n: NodeShape): number | null {
  if (n.circle) return Math.max(0, Math.hypot(p[0] - n.circle.cx, p[1] - n.circle.cy) - n.circle.r);
  if (n.rx !== undefined) {
    const [x0, y0, x1, y1] = n.box;
    const r = n.rx;
    const qx = Math.max(x0 + r - p[0], 0, p[0] - (x1 - r));
    const qy = Math.max(y0 + r - p[1], 0, p[1] - (y1 - r));
    return Math.max(0, Math.hypot(qx, qy) - r);
  }
  const ring = n.outline[0];
  if (!ring || n.outline.length !== 1 || ring.length < 4) return null;
  const distinct = new Set(ring.map((q) => `${q[0]},${q[1]}`));
  if (distinct.size < 3) return null;
  if (inRing(p, ring)) return 0;
  let d = Infinity;
  for (let k = 0; k < ring.length; k++) d = Math.min(d, segDist(p, ring[k], ring[(k + 1) % ring.length]));
  return d;
}

function emptyCounts(): Record<DiagramDefectKind, number> {
  return {
    textOverlap: 0,
    textOutside: 0,
    lineThroughText: 0,
    textOverNode: 0,
    textExceedsNode: 0,
    edgeCross: 0,
    edgeCollinear: 0,
    edgeThroughNode: 0,
    edgeEntryCollision: 0,
    stubSegment: 0,
    arrowTangent: 0,
  };
}

/** Lint geometri SVG diagram (tanpa browser). `score` = jumlah semua cacat. */
export function lintDiagramGeometry(svg: string): DiagramGeomLint {
  const { W, H, texts, nodes, links, linkHalf, linkOrder, linkCurved, bands } = scan(svg);
  const defects: DiagramGeomDefect[] = [];
  // teks-teks
  for (let i = 0; i < texts.length; i++) {
    for (let j = i + 1; j < texts.length; j++) {
      const A = texts[i].box;
      const B = texts[j].box;
      const w = Math.min(A[2], B[2]) - Math.max(A[0], B[0]);
      const h = Math.min(A[3], B[3]) - Math.max(A[1], B[1]);
      if (w <= 0 || h <= 0) continue;
      const inter = w * h;
      if (inter > OVERLAP_MIN_MM2 && inter > OVERLAP_MIN_FRAC * Math.min(texts[i].area, texts[j].area)) {
        defects.push({ kind: "textOverlap", text: texts[i].text, other: texts[j].text, amount: Number(inter.toFixed(2)) });
      }
    }
  }
  for (const t of texts) {
    const [x0, y0, x1, y1] = t.box;
    const over = Math.max(0, -x0, x1 - W, -y0, y1 - H);
    if (over > OUTSIDE_MIN_MM) defects.push({ kind: "textOutside", text: t.text, amount: Number(over.toFixed(2)) });
    // Row 53 (H-TAG, 01f §5.4): a requirement tag whose anchor lies in a node's box must have its ink inside that
    // node's outline (stadium corner, diamond side, cylinder lid); else `textOutside` naming the node.
    const at = t.tagAt;
    if (!at || over > OUTSIDE_MIN_MM) continue;
    const host = nodes.find((n) => n.id !== null && at[0] > n.box[0] && at[0] < n.box[2] && at[1] > n.box[1] && at[1] < n.box[3]);
    if (!host) continue;
    const corners: Pt[] = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    const out = corners.map((c) => outsideRegion(c, host));
    if (out.some((v) => v === null)) continue;
    const worst = Math.max(...(out as number[]));
    if (worst > TAG_OUTSIDE_MIN_MM) defects.push({ kind: "textOutside", text: t.text, other: host.id ?? "", amount: Number(worst.toFixed(2)) });
  }
  // teks x konektor / garis tepi simpul
  for (const t of texts) {
    const b = t.box;
    if (!t.knock) {
      const hit = links.some((pl, li) => {
        const hw = linkHalf[li];
        const bb = bboxOf(pl);
        if (bb[2] + hw < b[0] || bb[0] - hw > b[2] || bb[3] + hw < b[1] || bb[1] - hw > b[3]) return false;
        return t.samples.some((p) => onPolylines(p, [pl], hw));
      });
      if (hit) defects.push({ kind: "lineThroughText", text: t.text });
    }
    const overNode = nodes.find((n) => {
      if (n.box[2] + n.half < b[0] || n.box[0] - n.half > b[2] || n.box[3] + n.half < b[1] || n.box[1] - n.half > b[3]) return false;
      if (n.circle) {
        const c = n.circle;
        return t.samples.some((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) <= n.half + 1e-9);
      }
      return t.samples.some((p) => onPolylines(p, n.outline, n.half));
    });
    const over = overNode !== undefined;
    // Row 54 (VIS-3a): a label-below text names the node whose outline it touches.
    if (over) defects.push({ kind: "textOverNode", text: t.text, ...(t.belowOf !== undefined ? { other: overNode.id ?? "" } : {}) });
    // Row 54 (VIS-3a, §5.3): a label-below block lies wholly under its own outline (stroke included) and inside no
    // other node; else `textOverNode` naming the node it overlaps. Its host is the cell, not the outline box, so the
    // `textExceedsNode` test below (centre inside a node box) does not apply to it.
    if (t.belowOf !== undefined) {
      const own = nodes[t.belowOf];
      if (own && !over && b[1] < own.box[3] + own.half - 1e-6 && b[0] < own.box[2] + own.half && b[2] > own.box[0] - own.half) {
        defects.push({ kind: "textOverNode", text: t.text, other: own.id ?? "" });
      }
      const hit = nodes.find((n, ni) => ni !== t.belowOf && n.id !== null && b[0] < n.box[2] + n.half && b[2] > n.box[0] - n.half && b[1] < n.box[3] + n.half && b[3] > n.box[1] - n.half);
      if (hit) defects.push({ kind: "textOverNode", text: t.text, other: hit.id ?? "" });
      continue;
    }
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const host = nodes.find((n) => n.id !== null && cx > n.box[0] && cx < n.box[2] && cy > n.box[1] && cy < n.box[3]);
    if (host) {
      const ex = Math.max(0, host.box[0] - b[0], b[2] - host.box[2]);
      if (ex > 0.3) defects.push({ kind: "textExceedsNode", text: t.text, amount: Number(ex.toFixed(2)) });
    }
  }
  // konektor
  const { cross, collinear } = edgeConflicts(links);
  for (let k = 0; k < cross; k++) defects.push({ kind: "edgeCross", text: "konektor" });
  for (let k = 0; k < collinear; k++) defects.push({ kind: "edgeCollinear", text: "konektor" });
  const rects = nodes.filter((n) => n.id !== null);
  links.forEach((P, i) => {
    const s = P[0];
    const e = P[P.length - 1];
    for (const r of rects) {
      const inf = 1.2;
      const isEnd = [s, e].some((p) => p[0] >= r.box[0] - inf && p[0] <= r.box[2] + inf && p[1] >= r.box[1] - inf && p[1] <= r.box[3] + inf);
      if (isEnd) continue;
      const x0 = r.box[0] + 0.3;
      const y0 = r.box[1] + 0.3;
      const x1 = r.box[2] - 0.3;
      const y1 = r.box[3] - 0.3;
      let hit = false;
      for (let a = 0; a + 1 < P.length && !hit; a++) {
        for (let q = 0; q <= 24; q++) {
          const t = q / 24;
          const x = P[a][0] + (P[a + 1][0] - P[a][0]) * t;
          const y = P[a][1] + (P[a + 1][1] - P[a][1]) * t;
          if (x > x0 && x < x1 && y > y0 && y < y1) {
            hit = true;
            break;
          }
        }
      }
      if (hit) defects.push({ kind: "edgeThroughNode", text: `konektor ${i}`, other: r.id ?? "" });
    }
  });
  // T-03 (Swarm 1.2.6): connector ends
  const nodeName = (i: number) => nodes[i]?.id ?? `simpul ${i}`;
  for (const c of entryCollisions(links, nodes)) {
    defects.push({ kind: "edgeEntryCollision", text: `konektor ${c.a}`, other: `konektor ${c.b} @ ${nodeName(c.node)}`, amount: Number(c.gap.toFixed(2)) });
  }
  const bandsOver = links.map((_, i) => bands.filter((b) => b.order > linkOrder[i]).map((b) => b.box));
  for (const s of stubSegments(links, bandsOver, linkCurved)) {
    defects.push({ kind: "stubSegment", text: `konektor ${s.link}`, amount: Number(s.length.toFixed(2)) });
  }
  for (const t of arrowTangents(links, nodes)) {
    defects.push({ kind: "arrowTangent", text: `konektor ${t.link}`, other: nodeName(t.node), amount: Number(t.deg.toFixed(1)) });
  }
  const counts = emptyCounts();
  for (const d of defects) counts[d.kind]++;
  return { widthMm: W, heightMm: H, counts, defects, score: defects.filter((d) => !T03_KINDS.has(d.kind)).length };
}
