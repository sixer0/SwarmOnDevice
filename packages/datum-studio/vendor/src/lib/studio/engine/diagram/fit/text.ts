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
import { pt2mm, role, snapCeil, STROKE_PRIMARY } from "../core/tokens";

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

/** Lebar dalam bentuk simpul tempat teks dibungkus (mm), di garis tengah vertikal. */
export function innerWidthMm(shape: DiagramShape | undefined, w: number, h: number): number {
  const pad = padMm();
  switch (shape) {
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

/** Tinggi minimum simpul untuk `label`/`sub` berbaris (bentuk diamond butuh dua kali blok). */
function neededHeight(n: Pick<DiagramNode, "shape" | "tag">, labelLines: number, subLines: number): number {
  const b = blockMm(labelLines, subLines);
  const core = n.shape === "diamond" || n.shape === "hexagon" ? b * 2 : b;
  return core + 2 * V_MARGIN_MM + tagH(n);
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
  // Silinder: busur tutup atas (ry = 0,16 h, digambar sampai y + 2 ry) memotong label di pusat.
  const lid = n.shape === "cylinder" ? nd.h * 0.16 * 2 + 0.3 : 0;
  const probe = planNodeText(n, nd.w, nd.h, NODE_HARD_MAX_LINES);
  const lidHit = lid > 0 && nd.y + nd.h / 2.0 - FONT_ASCENT_EM * capMm() * (1 - 0.12) < nd.y + lid;
  if (!probe.wrapped && !lidHit) return null;
  const maxLines = linesForHeight(n, nd.h - lid, probe.sub.length);
  const plan = planNodeText(n, nd.w, nd.h, maxLines);
  if (!plan.wrapped && !lidHit) return null;
  // Blok label + sub dipusatkan vertikal di area di bawah tag (atau di bawah tutup silinder).
  const top = nd.y + Math.max(tagH(n), lid);
  const L = plan.label.length;
  const S = plan.sub.length;
  const total = blockMm(L, S);
  const blockTop = top + (nd.y + nd.h - top - total) / 2.0;
  const y = blockTop + FONT_ASCENT_EM * capMm();
  const out: NodeTextLayout = { label: { x: cx, y, lines: plan.label, lineMm: capLineMm() }, plan };
  if (S > 0) out.sub = { x: cx, y: y + L * capLineMm(), lines: plan.sub, lineMm: subLineMm() };
  return out;
}
