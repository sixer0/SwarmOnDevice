/**
 * engine/diagram/fit — teks simpul: lebar berbasis label + bungkus `<tspan>` (FIG-02b,
 * audit research/18 §6 P1-10) dan label rel bus di atas batang (P2-16).
 *
 * Ukuran memakai `textfit` grafik (tabel glif IBM Plex Sans Condensed terkalibrasi Chromium).
 * Pagar lokal: label yang muat satu baris (lebar terukur <= lebar dalam + setengah rem) tidak
 * pernah dibungkus, jadi simpul yang sudah benar menghasilkan teks yang sama persis.
 * Modul ini hanya menghitung tata letak teks; penulisan SVG tetap di `core/svg.ts`.
 */
import type { DiagramNode, DiagramShape } from "../../../contract";
import { FONT_ASCENT_EM, FONT_DESCENT_EM, LINE_HEIGHT_EM, measure, wrap } from "../../chart/core/textfit";
import { pyStr } from "../core/pyfmt";
import {
  ANNOTATION_BRACKET_MM,
  BPMN_EVENT_DIAMETER_MM,
  BPMN_GATEWAY_SIZE_MM,
  LABEL_BELOW_GAP_MM,
  LABEL_BELOW_SHAPES,
  pt2mm,
  role,
  SHAPE_GLYPH_MM,
  snapCeil,
  STROKE_PRIMARY,
  SUBPROCESS_GLYPH_CLEAR_MM,
} from "../core/tokens";

// Swarm 1.2.8 row 57b (C86, C101): the label-below names and the row 54b constants live in `core/tokens.ts`; they are
// re-exported here so the importers of this module (core/svg.ts, build/route.ts, chart flowchart) keep their imports.
export {
  ANNOTATION_BRACKET_MM,
  BPMN_EVENT_DIAMETER_MM,
  BPMN_GATEWAY_SIZE_MM,
  LABEL_BELOW_GAP_MM,
  LABEL_BELOW_SHAPES,
  SHAPE_GLYPH_MM,
  SUBPROCESS_GLYPH_CLEAR_MM,
};

/** Baris label simpul paling banyak sebelum lebar/tinggi dilaporkan (audit §6 P1-10). */
export const NODE_MAX_LINES = 3;
/** Batas keras baris saat label tetap tidak muat 3 baris (dilaporkan, tidak meluap). */
export const NODE_HARD_MAX_LINES = 6;
/** Rem vertikal minimum di atas dan di bawah blok teks simpul (mm). */
const V_MARGIN_MM = 0.8;

const capPt = (): number => role("caption").size;
const subPt = (): number => role("source_line").size;
const capMm = (): number => pt2mm(capPt());
/** Rem caption simpul (`core/geometry.ts capPad`): pt2mm(caption) x 1,2, total kiri + kanan. */
const padMm = (): number => capMm() * 1.2;

export const capLineMm = (): number => capMm() * LINE_HEIGHT_EM;
export const subLineMm = (): number => pt2mm(subPt()) * LINE_HEIGHT_EM;

const textOf = (v: unknown): string => (v === undefined || v === null ? "" : pyStr(v));
const truthy = (v: unknown): boolean => v !== undefined && v !== null && v !== "" && v !== false && v !== 0;

export function capWidthMm(s: string): number {
  return measure(s, capPt(), "struct");
}

export function subWidthMm(s: string): number {
  return measure(s, subPt(), "struct");
}

// ---------------------------------------------------------------- row 54 (VIS-3a, label below)
// Swarm 1.2.8 row 54 (VIS-3a, C12 OP-18-4, 01_specs.md §5.3): BPMN events and gateways draw their label below a fixed
// outline; the names (LABEL_BELOW_SHAPES, LABEL_BELOW_GAP_MM, BPMN_EVENT_DIAMETER_MM, BPMN_GATEWAY_SIZE_MM) are in
// core/tokens.ts since row 57b (C86).
export function isLabelBelow(shape: string | undefined): boolean {
  return shape !== undefined && LABEL_BELOW_SHAPES.has(shape);
}

/** Outline size (mm) of a label-below shape: event diameter or gateway square. */
export function labelBelowSizeMm(shape: string | undefined): number {
  return shape !== undefined && shape.startsWith("gateway_") ? BPMN_GATEWAY_SIZE_MM : BPMN_EVENT_DIAMETER_MM;
}

/** Stroke width (mm) of the outline of a label-below shape (01f §1.3: end event 2 x primary). */
export function labelBelowStrokeMm(shape: string | undefined): number {
  return shape === "event_end" ? STROKE_PRIMARY * 2 : STROKE_PRIMARY;
}

/**
 * Outline box of a label-below node inside its layout cell: a square of `labelBelowSizeMm`, centred horizontally, its
 * top on the cell top (the cell is never narrower: `nodeSize` keeps w >= 3 lattice columns).
 */
export function labelBelowOutline(nd: { x: number; y: number; w: number; spec: Pick<DiagramNode, "shape"> }): { x: number; y: number; w: number; h: number } {
  const d = labelBelowSizeMm(nd.spec.shape);
  return { x: nd.x + nd.w / 2 - d / 2, y: nd.y, w: d, h: d };
}

/**
 * Top (mm, from the cell top) of the label block of a label-below shape: outline, the outer half of the thickest outline
 * stroke (end event, 2 x primary), gap. One value for every event, so labels of one rank share their baseline.
 */
function labelBelowTop(shape: string | undefined): number {
  return labelBelowSizeMm(shape) + STROKE_PRIMARY + LABEL_BELOW_GAP_MM;
}

// ---------------------------------------------------------------- row 54b (VIS-3b)
// Swarm 1.2.8 row 54b (VIS-3b, 01f §1.3): SHAPE_GLYPH_MM (N8-470), SUBPROCESS_GLYPH_CLEAR_MM and ANNOTATION_BRACKET_MM
// are in core/tokens.ts since row 57b (C101). Gateway markers are sized from the gateway (core/svg.ts), not from them.

/** Row 54b (01f §1.3): corner radius (mm) of a BPMN task / sub-process, rx = ry = min(1.6 mm, h / 4). */
export function taskRadiusMm(h: number): number {
  return Math.min(1.6, h / 4);
}

/** Row 54b (01f §1.3): fold (mm) of a BPMN data object, f = min(0.25 w, 2.4 mm). */
export function dataFoldMm(w: number): number {
  return Math.min(0.25 * w, 2.4);
}

/** Row 54b: height (mm) of the bottom band of a sub-process: half the outline stroke, clearance, [+] square, clearance. */
export function subprocessBandMm(): number {
  return STROKE_PRIMARY / 2 + SUBPROCESS_GLYPH_CLEAR_MM + SHAPE_GLYPH_MM + SUBPROCESS_GLYPH_CLEAR_MM;
}

/** Lebar dalam bentuk simpul tempat teks dibungkus (mm), di garis tengah vertikal. */
export function innerWidthMm(shape: DiagramShape | undefined, w: number, h: number): number {
  const pad = padMm();
  if (isLabelBelow(shape)) return w - pad; // row 54: the label block wraps to the layout cell width
  switch (shape) {
    case "task": // row 54b (VIS-3b, 01f §1.3): w - pad - 2 rx x 0.3
    case "subprocess":
      return w - pad - 2 * taskRadiusMm(h) * 0.3;
    case "data_object": // row 54b: w - pad - f / 2
      return w - pad - dataFoldMm(w) / 2;
    case "diamond":
      return w * 0.5 - pad * 0.5;
    case "hexagon":
      return w * 0.7 - pad * 0.5;
    case "parallelogram":
      return w * 0.82 - pad;
    case "circle":
      return Math.min(w, h) * 0.7 - pad * 0.5;
    case "stadium":
      return w - Math.min(h, w) * 0.3 - pad;
    case "predefined": // row 53 (VIS-1b, 01f §1.1): between the two side bars (b = 1.2 mm, core/svg.ts)
      return w - 2 * PREDEFINED_BAR_MM - pad;
    default:
      return w - pad;
  }
}

/** Pagar lokal: teks satu baris dianggap muat bila <= lebar dalam + setengah rem. */
function fitsOneLine(widthMm: number, inner: number): boolean {
  return widthMm <= inner + padMm() * 0.5 + 1e-9;
}

/**
 * Tinggi blok teks simpul (ascent baris label pertama s.d. descent baris terakhir), mm:
 * `L` baris label, lalu `S` baris sub dengan garis dasar sub pertama satu baris label di bawah.
 */
function blockMm(L: number, S: number): number {
  const asc = FONT_ASCENT_EM * capMm();
  if (S <= 0) return asc + (L - 1) * capLineMm() + FONT_DESCENT_EM * capMm();
  return asc + L * capLineMm() + (S - 1) * subLineMm() + FONT_DESCENT_EM * pt2mm(subPt());
}

export interface NodeTextPlan {
  label: string[];
  sub: string[];
  /** Tinggi minimum simpul agar blok teks muat (mm, belum dikunci kisi). */
  needH: number;
  /** Label tetap lebih dari `NODE_MAX_LINES` baris atau lebih lebar dari lebar dalam. */
  overflow: boolean;
  /** Ada perubahan terhadap tata letak satu baris bawaan. */
  wrapped: boolean;
}

function tagH(n: Pick<DiagramNode, "tag">): number {
  return truthy(n.tag) ? capMm() * 1.2 : 0;
}

/**
 * Swarm 1.2.8 row 53 (VIS-1b, 01f §1.1): share of the node height below the text box. Document: the wave band 2a,
 * a = 0.08 h; off-page reference: the point below the straight sides (0.3 h). Same fractions as `core/svg.ts`.
 */
const PREDEFINED_BAR_MM = 1.2; // = the doubled inner-line inset
function footFrac(shape: DiagramShape | undefined): number {
  if (shape === "document") return 2 * 0.08;
  if (shape === "offpage") return 1 - 0.7;
  return 0;
}

/** Tinggi minimum simpul untuk `label`/`sub` berbaris (bentuk diamond butuh dua kali blok). */
function neededHeight(n: Pick<DiagramNode, "shape" | "tag">, labelLines: number, subLines: number): number {
  const b = blockMm(labelLines, subLines);
  // row 54 (VIS-3a, §5.3): cell = outline + gap + label block (+ tag line) + the bottom margin
  if (isLabelBelow(n.shape)) return labelBelowTop(n.shape) + tagH(n) + b + V_MARGIN_MM;
  const core = n.shape === "diamond" || n.shape === "hexagon" ? b * 2 : b;
  // row 53: document / offpage need the text box above the wave / point (needed height / (1 - foot))
  // row 54b (VIS-3b, G-3): a sub-process adds its bottom [+] band below the text box
  return (core + 2 * V_MARGIN_MM + tagH(n)) / (1 - footFrac(n.shape)) + (n.shape === "subprocess" ? subprocessBandMm() : 0);
}

/**
 * Swarm 1.2.6 row 63 (T-07, N-017): height a diamond needs so a TWO-line label (plus its `sub` line and
 * `tag`) lies inside the polygon. Text is wrapped to at most half the diamond width (`innerWidthMm`), and a
 * centred block of height T whose lines are at most w/2 wide stays inside the diamond when h >= 2 T.
 * Not lattice-locked (the caller snaps up).
 */
export function diamondTwoLineHeightMm(n: Pick<DiagramNode, "sub" | "tag">): number {
  return blockMm(2, truthy(n.sub) ? 1 : 0) * 2 + tagH(n);
}

/**
 * Rencana teks simpul pada lebar `w` (tinggi `h` hanya untuk bentuk circle/stadium).
 * `maxLines` = batas baris label (bawaan 3; render memakai batas tinggi nyata simpul).
 */
export function planNodeText(
  n: Pick<DiagramNode, "label" | "sub" | "shape" | "tag">,
  w: number,
  h: number,
  maxLines: number = NODE_MAX_LINES,
): NodeTextPlan {
  const label = textOf(n.label);
  const sub = truthy(n.sub) ? textOf(n.sub) : "";
  const inner = Math.max(1, innerWidthMm(n.shape, w, h));
  const font = { pt: capPt(), face: "struct" as const };
  let labelLines = [label];
  let overflow = false;
  let wrapped = false;
  if (n.shape !== "bus" && !fitsOneLine(capWidthMm(label), inner)) {
    let r = wrap(label, inner, Math.max(1, maxLines), font);
    if (!r.fits && maxLines < NODE_HARD_MAX_LINES) {
      const r2 = wrap(label, inner, NODE_HARD_MAX_LINES, font);
      if (r2.fits || r2.widthMm < r.widthMm - 1e-9) r = r2;
      overflow = true;
    }
    if (!r.fits) overflow = true;
    labelLines = r.lines;
    wrapped = r.lines.length > 1;
  }
  let subLines = sub ? [sub] : [];
  if (sub && n.shape !== "bus" && !fitsOneLine(subWidthMm(sub), inner)) {
    const r = wrap(sub, inner, 2, { pt: subPt(), face: "struct" });
    subLines = r.lines;
    wrapped = wrapped || r.lines.length > 1;
  }
  return { label: labelLines, sub: subLines, needH: neededHeight(n, labelLines.length, subLines.length), overflow, wrapped };
}

/** Tinggi simpul setelah bungkus: tinggi dasar atau kebutuhan blok teks, dikunci kisi vertikal. */
export function grownHeight(baseH: number, plan: NodeTextPlan, latY: number): number {
  return plan.wrapped && plan.needH > baseH + 1e-9 ? Math.max(baseH, snapCeil(plan.needH - 1e-9, latY)) : baseH;
}

/**
 * Lebar seragam satu tingkat (layered/topology/stack) saat fit: lebar bawaan dipertahankan bila
 * semua label muat satu baris; selain itu lebar terkecil kelipatan kisi (<= `wMax`) tempat semua
 * label muat <= 3 baris. Tidak ada yang muat -> `wMax` (dibungkus lebih dari 3 baris, dilaporkan).
 */
export function fitTierWidth(
  group: ReadonlyArray<Pick<DiagramNode, "label" | "sub" | "shape" | "tag">>,
  w0: number,
  wMax: number,
  latX: number,
  baseH: number,
): { w: number; changed: boolean } {
  const clean = (w: number) => group.every((n) => !planNodeText(n, w, baseH).wrapped);
  if (clean(w0)) return { w: w0, changed: false };
  const ok = (w: number) => group.every((n) => !planNodeText(n, w, baseH).overflow);
  for (let w = w0; w <= wMax + 1e-6; w += latX) if (ok(w)) return { w, changed: w !== w0 };
  const w = Math.max(w0, wMax);
  return { w, changed: w !== w0 };
}

export interface TextBlockLayout {
  x: number;
  /** Garis dasar baris pertama. */
  y: number;
  lines: string[];
  lineMm: number;
}

export interface NodeTextLayout {
  label: TextBlockLayout;
  sub?: TextBlockLayout;
  plan: NodeTextPlan;
}

/** Baris label maksimum yang muat pada tinggi simpul `h` (minimal 1). */
function linesForHeight(n: Pick<DiagramNode, "shape" | "tag">, h: number, subLines: number): number {
  let k = 1;
  while (k < NODE_HARD_MAX_LINES && neededHeight(n, k + 1, subLines) <= h + 1e-9) k++;
  return k;
}

/**
 * Tata letak teks simpul saat fit, atau `null` bila teks bawaan (satu baris di pusat) sudah muat
 * (pagar byte-identik per unsur). Rel bus: label dipindah ke atas batang (P2-16).
 */
export function nodeTextLayout(nd: { x: number; y: number; w: number; h: number; spec: DiagramNode }): NodeTextLayout | null {
  const n = nd.spec;
  const cx = nd.x + nd.w / 2.0;
  if (n.shape === "bus") {
    if (!textOf(n.label).trim()) return null;
    const barTop = nd.y + nd.h / 2.0 - (STROKE_PRIMARY * 3) / 2.0;
    const y = barTop - FONT_DESCENT_EM * capMm() - 0.6;
    const plan: NodeTextPlan = { label: [textOf(n.label)], sub: [], needH: nd.h, overflow: false, wrapped: false };
    return { label: { x: cx, y, lines: plan.label, lineMm: capLineMm() }, plan };
  }
  if (isLabelBelow(n.shape)) return labelBelowLayout(nd);
  // Silinder: busur tutup atas (ry = 0,16 h, digambar sampai y + 2 ry) memotong label di pusat.
  const lid = n.shape === "cylinder" ? nd.h * 0.16 * 2 + 0.3 : 0;
  // Row 53 (VIS-1b): document / offpage keep their text above the wave / point, so they always get a layout.
  // Row 54b (VIS-3b): a sub-process keeps its text above the [+] band, so it always gets a layout too.
  const foot = nd.h * footFrac(n.shape) + (n.shape === "subprocess" ? subprocessBandMm() : 0);
  const probe = planNodeText(n, nd.w, nd.h, NODE_HARD_MAX_LINES);
  // Row 53 (H-TAG): with a tag the cylinder's free top is below the lid AND the tag line.
  const lidTop = lid > 0 && tagH(n) > 0 ? lid + tagH(n) : lid;
  const lidHit = (lid > 0 && nd.y + nd.h / 2.0 - FONT_ASCENT_EM * capMm() * (1 - 0.12) < nd.y + lidTop) || foot > 0;
  if (!probe.wrapped && !lidHit) return null;
  const maxLines = linesForHeight(n, nd.h - lid, probe.sub.length);
  const plan = planNodeText(n, nd.w, nd.h, maxLines);
  if (!plan.wrapped && !lidHit) return null;
  // Blok label + sub dipusatkan vertikal di area di bawah tag (atau di bawah tutup silinder).
  // Row 53 (H-TAG): a cylinder's tag sits below the lid (core/svg.ts tagAnchor), so the block starts below both.
  // Row 53 (H-TAG): a doubled node's tag sits inside its inner rectangle (1.2 mm down, core/svg.ts tagAnchor).
  const tagTop = n.shape === "doubled" && tagH(n) > 0 ? PREDEFINED_BAR_MM + tagH(n) : tagH(n);
  const top = nd.y + (lidTop > lid ? lidTop : Math.max(tagTop, lid));
  const L = plan.label.length;
  const S = plan.sub.length;
  const total = blockMm(L, S);
  const blockTop = top + (nd.y + nd.h - foot - top - total) / 2.0;
  const y = blockTop + FONT_ASCENT_EM * capMm();
  const out: NodeTextLayout = { label: { x: cx, y, lines: plan.label, lineMm: capLineMm() }, plan };
  if (S > 0) out.sub = { x: cx, y: y + L * capLineMm(), lines: plan.sub, lineMm: subLineMm() };
  return out;
}

/**
 * Row 54 (VIS-3a, §5.3): text layout of a label-below node, always present (outside fit too). The block starts
 * `labelBelowTop` under the cell top: the tag line first (core/svg.ts `tagAnchor` puts the tag one line above the label),
 * then the label lines wrapped to the cell width, then the sub line(s); all centred on the cell (= the outline) centre.
 */
function labelBelowLayout(nd: { x: number; y: number; w: number; h: number; spec: DiagramNode }): NodeTextLayout {
  const n = nd.spec;
  const probe = planNodeText(n, nd.w, nd.h, NODE_HARD_MAX_LINES);
  const plan = planNodeText(n, nd.w, nd.h, linesForHeight(n, nd.h, probe.sub.length));
  const cx = nd.x + nd.w / 2.0;
  const y = nd.y + labelBelowTop(n.shape) + tagH(n) + FONT_ASCENT_EM * capMm();
  const out: NodeTextLayout = { label: { x: cx, y, lines: plan.label, lineMm: capLineMm() }, plan };
  if (plan.sub.length > 0) out.sub = { x: cx, y: y + plan.label.length * capLineMm(), lines: plan.sub, lineMm: subLineMm() };
  return out;
}

/** Row 54 (VIS-3a, §5.3): height (mm, not lattice-locked) of the layout cell of a label-below node of width `w`. */
export function labelBelowHeightMm(n: Pick<DiagramNode, "label" | "sub" | "shape" | "tag">, w: number): number {
  return planNodeText(n, w, Infinity, NODE_HARD_MAX_LINES).needH;
}
