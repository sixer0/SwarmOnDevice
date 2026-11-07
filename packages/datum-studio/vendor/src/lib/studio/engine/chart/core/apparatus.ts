/**
 * engine/chart/core — aparatus figur: penanda aparatus halaman, caption + SUMBER,
 * baris KUNCI, label langsung (S32).
 *
 * - `apparatus: "page"` (default, DC:146-150): halaman/dokumen mencetak caption dan
 *   SUMBER; SVG membawa komentar mesin `DATUM-APPARATUS-REQUIRED` agar lint rilis tidak
 *   membaca figur benar sebagai figur tanpa aparatus (lint 29, 30).
 * - `apparatus: "figure"`: SVG mandiri mencetak caption (`<id>   <judul>`) dan
 *   `SUMBER  <sumber>` sendiri (DC:235-240).
 * - Baris KUNCI menggantikan kotak legenda (CH-04, P7-13 "direct"): label "KUNCI"
 *   berhuruf kapital lalu petak warna + nama seri dalam satu baris, tanpa bingkai.
 */
import type { StudioChartV1 } from "../../../contract";
import type { ChartPalette } from "./palette";
import { fitActive, fitNote, fitState } from "./fit";
import { keyLabelText } from "./lang";
import { SvgDoc, escText, midBaseline, ptToMm, textWidthMm } from "./svg";
import { legendRows } from "./labelfit";
import { lineHeightMm, measure, wrapEllipsize } from "./textfit";

/** Pita aparatus "figure" gaya galeri/keluarga (mm). DC memakai 22 mm (DC:91). */
export const FIGURE_APPARATUS_BAND_MM = 10;
export const KEY_ROW_HEIGHT_MM = 4.2;

export function apparatusMarker(doc: SvgDoc, spec: Pick<StudioChartV1, "id" | "title" | "source">): void {
  // Isi komentar mengikuti DC:148-149 (esc tanpa kutip); "--" dinetralkan SvgDoc.comment.
  doc.comment(`DATUM-APPARATUS-REQUIRED: caption=${escText(spec.id ?? "")} ${escText(spec.title ?? "")} | source=${escText(spec.source ?? "")}`);
}

const CAPTION_PT = 7.0;
const SOURCE_PT = 6.2;
const CAPTION_MAX_LINES = 3;
const SOURCE_MAX_LINES = 2;

interface ApparatusLines {
  caption: string[];
  source: string[];
  /** Tinggi tambahan di atas pita satu baris (mm). */
  extraMm: number;
}

/**
 * Baris caption/SUMBER berbungkus (FIG-02a P2-15) — hanya saat fit aktif dan teks satu baris
 * lebih lebar dari kanvas; selain itu `null` (perilaku satu baris DC tetap).
 */
function apparatusLines(spec: Pick<StudioChartV1, "id" | "title" | "source">): ApparatusLines | null {
  const st = fitState();
  if (!st) return null;
  const W = st.widthMm;
  const cap = `${spec.id ?? ""}   ${spec.title ?? ""}`;
  const src = `SUMBER  ${spec.source ?? ""}`;
  const capW = measure(cap, CAPTION_PT);
  const srcW = measure(src, SOURCE_PT);
  if (capW <= W && srcW <= W) return null;
  const c = capW <= W ? { lines: [cap], truncated: false } : wrapEllipsize(cap, W - 0.5, CAPTION_MAX_LINES, { pt: CAPTION_PT });
  const s = srcW <= W ? { lines: [src], truncated: false } : wrapEllipsize(src, W - 0.5, SOURCE_MAX_LINES, { pt: SOURCE_PT });
  if (c.truncated || s.truncated) fitNote("CAPTION_TRUNCATED", "caption/SUMBER terlalu panjang; dipotong dengan elipsis");
  fitNote("CAPTION_WRAP", `caption ${c.lines.length} baris, SUMBER ${s.lines.length} baris (dibungkus ke lebar ${W} mm)`);
  const extraMm = (c.lines.length - 1) * lineHeightMm({ pt: CAPTION_PT }) + (s.lines.length - 1) * lineHeightMm({ pt: SOURCE_PT });
  return { caption: c.lines, source: s.lines, extraMm };
}

/**
 * Tinggi tambahan pita aparatus figure akibat caption/SUMBER berbungkus (mm); 0 bila
 * apparatus bukan "figure", fit tidak aktif, atau caption muat satu baris.
 */
export function figureExtraMm(spec: Pick<StudioChartV1, "apparatus" | "id" | "title" | "source">): number {
  if (spec.apparatus !== "figure" || !fitActive()) return 0;
  return apparatusLines(spec)?.extraMm ?? 0;
}

/** Pita kaki aparatus figure (mm): `FIGURE_APPARATUS_BAND_MM` + tambahan bungkus; 0 bila bukan "figure". */
export function figureFootMm(spec: Pick<StudioChartV1, "apparatus" | "id" | "title" | "source">): number {
  return spec.apparatus === "figure" ? FIGURE_APPARATUS_BAND_MM + figureExtraMm(spec) : 0;
}

/** Garis dasar baris caption pertama (apparatus "figure") pada kanvas setinggi `heightMm`. */
export function figureCaptionTopMm(spec: StudioChartV1, heightMm: number): number {
  const L = apparatusLines(spec);
  if (!L) return heightMm - 6;
  const srcTop = heightMm - 1.6 - (L.source.length - 1) * lineHeightMm({ pt: SOURCE_PT });
  return srcTop - 4.4 - (L.caption.length - 1) * lineHeightMm({ pt: CAPTION_PT });
}

/** Caption + SUMBER di dasar kanvas (apparatus "figure"), posisi DC:236-240. */
export function figureApparatus(doc: SvgDoc, spec: StudioChartV1, pal: ChartPalette, heightMm: number): void {
  const L = apparatusLines(spec);
  if (!L) {
    doc.text(0, heightMm - 6, `${spec.id ?? ""}   ${spec.title}`, { sizePt: CAPTION_PT, fill: pal.ink900 });
    doc.text(0, heightMm - 1.6, `SUMBER  ${spec.source}`, { sizePt: SOURCE_PT, fill: pal.ink400 });
    return;
  }
  // Disusun dari bawah: baris SUMBER terakhir tetap di H - 1,6; caption 4,4 mm di atas SUMBER pertama.
  const srcLh = lineHeightMm({ pt: SOURCE_PT });
  const capLh = lineHeightMm({ pt: CAPTION_PT });
  const srcTop = heightMm - 1.6 - (L.source.length - 1) * srcLh;
  const capTop = srcTop - 4.4 - (L.caption.length - 1) * capLh;
  doc.textLines(0, capTop, L.caption, { sizePt: CAPTION_PT, fill: pal.ink900 }, capLh);
  doc.textLines(0, srcTop, L.source, { sizePt: SOURCE_PT, fill: pal.ink400 }, srcLh);
}

/** Catatan kaki di dalam figur, tengah (DC:229-231). */
export function noteLine(doc: SvgDoc, note: string, widthMm: number, yMm: number, pal: ChartPalette): void {
  doc.text(widthMm / 2, yMm, note, { sizePt: 6.2, fill: pal.ink400, anchor: "middle" });
}

export interface KeyItem {
  label: string;
  color: string;
}

const KEY_TRACK_MM = 0.15;

/**
 * Tata letak KUNCI multi-baris (FIG-02a P1-7): hanya saat fit aktif dan baris tunggal melewati
 * tepi kanan kanvas; selain itu `null` (baris tunggal lama).
 */
function keyLayout(x: number, labels: readonly string[], sizePt: number): ReturnType<typeof legendRows> {
  const st = fitState();
  if (!st) return null;
  const sw = ptToMm(sizePt) * 0.9;
  const lead = measure(keyLabelText(), sizePt, "struct", { bold: true, caps: true, trackMm: KEY_TRACK_MM }) + 2.4;
  return legendRows(labels, st.widthMm - 0.5 - x, { pt: sizePt }, { lead, swatch: sw, gap: 1.0, after: 3.0 });
}

/**
 * Tinggi tambahan baris KUNCI multi-baris (mm) yang harus disediakan pemanggil di bawah baris
 * pertama; 0 di luar fit atau bila KUNCI muat satu baris.
 */
export function keyRowExtraMm(x: number, labels: readonly string[], sizePt = 6.2): number {
  const L = keyLayout(x, labels, sizePt);
  return L ? (L.rows - 1) * KEY_ROW_HEIGHT_MM : 0;
}

/**
 * Baris KUNCI di (x, y = garis dasar teks). Mengembalikan lebar terpakai (mm).
 * Dekorasi: tidak membawa `data-mark`; dibungkus `<g data-key="row">`. Saat fit aktif dan
 * baris melewati tepi kanan, item dibungkus ke baris berikutnya (turun `KEY_ROW_HEIGHT_MM`;
 * pemanggil menyediakan ruangnya lewat `keyRowExtraMm`).
 */
export function keyRow(doc: SvgDoc, x: number, y: number, items: readonly KeyItem[], pal: ChartPalette, sizePt = 6.2): number {
  const sw = ptToMm(sizePt) * 0.9;
  const track = KEY_TRACK_MM;
  const L = keyLayout(x, items.map((it) => it.label), sizePt);
  if (L) {
    doc.open('data-key="row"');
    doc.text(x, y, keyLabelText(), { sizePt, fill: pal.ink400, bold: true, caps: true, trackMm: track });
    let used = 0;
    for (const p of L.items) {
      const yy = y + p.row * KEY_ROW_HEIGHT_MM;
      const cx = x + p.dx;
      doc.rect(cx, yy - sw, sw, sw, items[p.i].color);
      doc.textLines(cx + sw + 1.0, yy, [p.label], { sizePt, fill: pal.ink700 }, 0, p.title);
      used = Math.max(used, p.dx + sw + 1.0 + measure(p.label, sizePt));
    }
    doc.close();
    return used;
  }
  doc.open('data-key="row"');
  doc.text(x, y, keyLabelText(), { sizePt, fill: pal.ink400, bold: true, caps: true, trackMm: track });
  let cx = x + textWidthMm(keyLabelText(), sizePt, "struct", track) + 2.4;
  for (const it of items) {
    doc.rect(cx, y - sw, sw, sw, it.color);
    cx += sw + 1.0;
    doc.text(cx, y, it.label, { sizePt, fill: pal.ink700 });
    cx += textWidthMm(it.label, sizePt) + 3.0;
  }
  doc.close();
  return cx - x;
}

/** Garis dasar teks yang tegak-tengah pada pita setinggi `bandMm` mulai `top`. */
export function centredBaseline(top: number, bandMm: number, sizePt: number): number {
  return midBaseline(top + bandMm / 2, sizePt);
}
