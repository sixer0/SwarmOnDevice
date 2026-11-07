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
 * ber-kutip ganda, angka mm, tanpa transform) — bukan parser SVG umum.
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

export type { Box } from "../../chart/core/svgscan";

export type DiagramDefectKind =
  | "textOverlap"
  | "textOutside"
  | "lineThroughText"
  | "textOverNode"
  | "textExceedsNode"
  | "edgeCross"
  | "edgeCollinear"
  | "edgeThroughNode";

export const DIAGRAM_DEFECT_KINDS: readonly DiagramDefectKind[] = [
  "textOverlap",
  "textOutside",
  "lineThroughText",
  "textOverNode",
  "textExceedsNode",
  "edgeCross",
  "edgeCollinear",
  "edgeThroughNode",
];

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
  /** Jumlah semua cacat (0 = bersih). */
  score: number;
}

interface TextEl {
  text: string;
  box: Box;
  area: number;
  knock: boolean;
  samples: Pt[];
}

interface NodeShape {
  id: string | null;
  /** Garis tepi (polilinear tertutup atau terbuka) dan setengah tebal goresan. */
  outline: Pt[][];
  circle?: { cx: number; cy: number; r: number };
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

interface Scan {
  W: number;
  H: number;
  texts: TextEl[];
  nodes: NodeShape[];
  links: Pt[][];
  linkHalf: number[];
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
  let inDefs = 0;
  let inSymbol = 0;
  let prevKnock = false;
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>|<(\/?)([a-zA-Z]+)\b([^>]*?)(\/?)>/g;
  for (let k = re.exec(svg); k; k = re.exec(svg)) {
    if (k[1] !== undefined) {
      const knock = prevKnock;
      prevKnock = false;
      if (inDefs || inSymbol) continue; // row 124: text of a node symbol cell is symbol geometry
      const a = attrsOf(k[1]);
      const sizeMm = Number(a["font-size"] ?? 0);
      if (!(sizeMm > 0)) continue;
      const face = /mono/i.test(a["font-family"] ?? "") ? "data" : "struct";
      const bold = Number(a["font-weight"] ?? 400) >= 600;
      const track = Number(a["letter-spacing"] ?? 0) || 0;
      const anchor = a["text-anchor"] ?? "start";
      const body = k[2].replace(/<title>[\s\S]*?<\/title>/g, "");
      const x0 = Number(a.x ?? 0);
      const y0 = Number(a.y ?? 0);
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
          lines.push({ x: sa.x !== undefined ? Number(sa.x) : x0, y: sa.y !== undefined ? Number(sa.y) : cy, s: unesc(sp[2]) });
        }
      } else lines.push({ x: x0, y: y0, s: unesc(body.replace(/<[^>]+>/g, "")) });
      const box = textBlockBox(lines, sizeMm, anchor, face, bold, track);
      if (!box) continue;
      texts.push({
        text: lines.map((l) => l.s).join(" "),
        box,
        area: Math.max(1e-9, (box[2] - box[0]) * (box[3] - box[1])),
        knock,
        samples: samplesOf(box),
      });
      continue;
    }
    const closing = k[3] === "/";
    const tag = k[4];
    const selfClose = k[6] === "/";
    if (closing) {
      if (tag === "defs") inDefs = Math.max(0, inDefs - 1);
      if (tag === "g" && inSymbol) inSymbol--;
      continue;
    }
    // Row 124 (CP-45): a node symbol badge (`<g data-symbol>`, scaled cell) is drawn inside its node;
    // its shapes are neither nodes nor connectors and its coordinates are cell units.
    if (tag === "g" && !selfClose && (inSymbol || /\bdata-symbol="/.test(k[5]))) {
      inSymbol++;
      continue;
    }
    if (inSymbol) continue;
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
    const mark = a["data-mark"];
    const nodeId = a["data-node"];
    if (mark === "link" && tag === "path") {
      const pl = pathPolylines(a.d ?? "");
      if (pl.length && pl[0].length >= 2) {
        links.push(pl[0].map((p) => [p[0], p[1]] as Pt));
        linkHalf.push((Number(a["stroke-width"] ?? 0) || 0) / 2);
      }
      continue;
    }
    if (mark !== "node" && nodeId === undefined) continue;
    const half = (Number(a["stroke-width"] ?? 0) || 0) / 2;
    let outline: Pt[][] = [];
    let circle: NodeShape["circle"];
    if (tag === "rect") {
      const x = Number(a.x ?? 0);
      const y = Number(a.y ?? 0);
      const w = Number(a.width ?? 0);
      const h = Number(a.height ?? 0);
      outline = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]];
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
    nodes.push({ id: nodeId ?? null, outline, circle, half, box });
  }
  return { W, H, texts, nodes, links, linkHalf };
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
  };
}

/** Lint geometri SVG diagram (tanpa browser). `score` = jumlah semua cacat. */
export function lintDiagramGeometry(svg: string): DiagramGeomLint {
  const { W, H, texts, nodes, links, linkHalf } = scan(svg);
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
    const over = nodes.some((n) => {
      if (n.box[2] + n.half < b[0] || n.box[0] - n.half > b[2] || n.box[3] + n.half < b[1] || n.box[1] - n.half > b[3]) return false;
      if (n.circle) {
        const c = n.circle;
        return t.samples.some((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) <= n.half + 1e-9);
      }
      return t.samples.some((p) => onPolylines(p, n.outline, n.half));
    });
    if (over) defects.push({ kind: "textOverNode", text: t.text });
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
  const counts = emptyCounts();
  for (const d of defects) counts[d.kind]++;
  return { widthMm: W, heightMm: H, counts, defects, score: defects.length };
}
