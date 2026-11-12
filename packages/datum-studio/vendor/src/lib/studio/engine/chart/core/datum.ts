/**
 * engine/chart/core — gaya "datum": port langsung datumchart.py Rev L (RL, Garis B),
 * keluarga `bar`, `column`, `threshold` (DC:73-243). Kelas paritas CA (research/06 §6.2):
 * urutan dan jenis elemen identik dengan DC, geometri sama dalam mm (DC menulis px 96 dpi;
 * di sini 1 satuan pengguna = 1 mm, sehingga koordinat = px DC / 3,7795275591).
 *
 * Penyimpangan yang disengaja (dicatat di catatan S32):
 * - ukuran huruf ditulis dalam pt FISIK (angka font-size DC dibaca sebagai pt, §6.4-N1);
 *   lebar garis dan jarak putus tetap px DC yang dikonversi ke mm;
 * - `sub` (pita label kedua kolom) aktif bila ADA titik ber-`sub`; DC membaca kunci
 *   tingkat atas `spec.sub` untuk tinggi tetapi `x.sub` per titik untuk gambar (DC:86, 218);
 * - huruf kapital diterapkan SEBELUM escape (DC meng-escape lalu mengapitalkan, yang
 *   merusak entitas `&amp;`);
 * - nilai negatif ditolak (CH-01) karena DC menggambar lebar negatif;
 * - P-01: parameter sort/accent/valueLabel registri berlaku (lihat prepare.ts);
 *   `valueLabel: "barEnd"` = kolom nilai tetap DC:179-182, `inside` = di dalam ujung batang.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt } from "../../bind";
import { apparatusMarker, figureApparatus, figureCaptionTopMm, figureExtraMm, noteLine } from "./apparatus";
import { fitActive } from "./fit";
import { drawGutterLabel, gutterPlan } from "./labelfit";
import type { CorePrep } from "./prepare";
import { axisDomain } from "./scale";
import { SvgDoc, dcPx, textWidthMm } from "./svg";

/** Token geometri batang DC (DC:150-156): jarak antarbaris, tebal batang, pita atas+bawah (mm). */
export const DC_BAR_PITCH_MM = 7.2;
export const DC_BAR_THICK_MM = 4.4;
export const DC_BAR_PAD_MM = 6;

/**
 * T-09 (1.2.6 U14, membalik D-322/FIX-H8): AMBANG badan terbaca keluarga batang (bar/threshold),
 * = tinggi plot panel bawaan Manual 000 Gambar 8.1 (`PANEL_DEFAULT_PLOT_MM` composite.ts; tidak
 * diimpor agar tidak membentuk siklus impor, kesamaan dijaga uji unit). Geometri tetap jujur
 * (DC `tinggi()`: badan = n * 7,2 + 6 mm, batang 4,4 mm, panjang sebanding data, nol = nol);
 * badan di bawah ambang ini (n <= 3 kategori) hanya DILAPORKAN sebagai REPORT `BAR_SUBMIN`,
 * badan tidak dinaikkan dan batang tidak ditebalkan.
 */
export const BAR_MIN_BODY_MM = 32;

/** Geometri baris batang: jarak antarbaris + tebal + geser ke tengah slot. `scaled` selalu false sejak 1.2.6 (U14); dipertahankan demi stabilitas tipe. */
export interface BarRows {
  pitch: number;
  thick: number;
  inset: number;
  scaled: boolean;
}

/** Geometri DC tetap. */
export const DC_BAR_ROWS: Readonly<BarRows> = Object.freeze({ pitch: DC_BAR_PITCH_MM, thick: DC_BAR_THICK_MM, inset: 0, scaled: false });

/** Geometri baris batang: DC persis untuk setiap jumlah kategori (U14; `n` dipertahankan demi stabilitas API). */
export function barRows(n: number): BarRows {
  void n;
  return { ...DC_BAR_ROWS };
}

/** Taksiran tinggi DC `tinggi()` (DC:76-92) tanpa batas bawah, mm (gaya gallery memakai ini). */
export function dcHeightMm(spec: StudioChartV1, family: "bar" | "column" | "threshold"): number {
  const pts = spec.data?.shape === "categorical" ? spec.data.points : [];
  const n = pts.length;
  let badan = family === "column" ? 46 + (pts.some((p) => p.sub !== undefined && p.sub !== "") ? 12 : 0) : n * 7.2 + 6;
  if (spec.note) badan += 6;
  if (family === "threshold") badan += 5;
  return badan + (spec.apparatus === "figure" ? 22 + figureExtraMm(spec) : 0);
}

/**
 * Tinggi kanvas gaya datum, mm: DC `tinggi()` persis untuk semua keluarga (U14: badan batang
 * tidak lagi dinaikkan ke `BAR_MIN_BODY_MM`; badan di bawahnya dilaporkan `BAR_SUBMIN`).
 */
export function datumHeightMm(spec: StudioChartV1, family: "bar" | "column" | "threshold"): number {
  return dcHeightMm(spec, family);
}

/** `puncak` DC:139-140: maks |nilai| (dan |limit| bila limit bukan 0/None) x 1,14, atau 1. */
function peak(prep: CorePrep): number {
  const vals = prep.pts.map((p) => Math.abs(p.value));
  if (prep.limit) vals.push(Math.abs(prep.limit));
  return Math.max(...vals) * 1.14 || 1;
}

export function renderDatum(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, prep: CorePrep): SvgResult {
  void tpl;
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const { pal, pts, dec, unit, limit } = prep;
  const puncak = peak(prep);
  const issues: SvgResult["report"]["issues"] = [];
  // Petunjuk `axis` P-11 (IP-41c): batang bermula di tepi kiri domain [lo, hi]; tanpa
  // petunjuk tetap DC `lebar * v / puncak` (byte-identik).
  let lo = 0;
  let span = puncak;
  if (prep.axis) {
    const ad = axisDomain([...pts.map((p) => p.value), ...(limit !== null ? [limit] : [])], { zero: prep.zero }, prep.axis);
    lo = ad.dom.min;
    span = ad.dom.max - ad.dom.min || 1;
    if (ad.widened) issues.push({ checkId: "AXIS_DOMAIN", status: "REPORT", detail: ad.widened });
    if (lo > 0) issues.push({ checkId: "CH-01", status: "REPORT", detail: `domain threshold ${lo}..${ad.dom.max} tidak bermula nol (petunjuk axis)` });
  }
  const doc = new SvgDoc(W, H, `data-chart="${prep.code}" data-style="datum"`, prep.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);

  const D = "data" as const;
  const series = spec.unit ? spec.unit : "nilai";

  if (prep.family === "bar" || prep.family === "threshold") {
    // T-09 (U14): geometri DC jujur untuk setiap n; tidak ada pita diperbesar.
    const rows = DC_BAR_ROWS;
    // FIG-02a P1-5: talang terukur + bungkus hanya saat fit aktif dan label melewati 22 mm DC.
    const gp = gutterPlan(
      pts.map((p) => p.label),
      { pt: 6.6, face: D },
      { currentMm: 22, capMm: W * 0.42, padMm: 2.2, pitchMm: rows.pitch },
    );
    const kiri = gp ? Math.max(22, gp.gutterMm) : 22;
    const kanan = W - 24;
    const lebar = kanan - kiri;
    let y = 3;
    const tb = rows.thick;
    const jarak = rows.pitch;
    // Garis dasar label: DC `y + tb * 0,78`.
    const baseline = (top: number): number => top + tb * 0.78;
    // T-09 (U14, register N-025): badan jujur di bawah ambang hanya dilaporkan; geometri tidak diubah.
    const badan = pts.length * DC_BAR_PITCH_MM + DC_BAR_PAD_MM;
    if (pts.length > 0 && badan < BAR_MIN_BODY_MM) {
      issues.push({
        checkId: "BAR_SUBMIN",
        status: "REPORT",
        detail: `${pts.length} kategori: badan batang ${badan.toFixed(1)} mm di bawah ambang terbaca ${BAR_MIN_BODY_MM} mm; geometri tetap jujur (tidak dinaikkan)`,
      });
    }
    pts.forEach((x, i) => {
      const v = x.value;
      const L = (lebar * (v - lo)) / span;
      const lewat = limit !== null && v > limit;
      const warna = lewat ? prep.overColour : x.accent ? pal.role.accent : pal.ink700;
      const tinta = lewat ? prep.overColour : x.accent ? pal.role.accent : pal.ink900;
      const top = y + rows.inset;
      if (gp) drawGutterLabel(doc, gp, i, kiri - 2.2, baseline(top), { face: D, sizePt: 6.6, fill: pal.ink400, anchor: "end" });
      else doc.text(kiri - 2.2, baseline(top), x.label, { face: D, sizePt: 6.6, fill: pal.ink400, anchor: "end" });
      doc.rect(kiri, top, L, tb, warna, { mark: { mark: "bar", series, index: i } });
      if (prep.valueLabel !== "none") {
        const s = fmt(v, dec);
        const fits = L >= textWidthMm(s, 6.8, "data") + 2;
        if (prep.valueLabel === "inside" && fits) {
          doc.text(kiri + L - 1.0, baseline(top), s, { face: D, sizePt: 6.8, fill: pal.paper, anchor: "end", attrs: ' data-label="value"' });
        } else {
          doc.text(W - 1.5, baseline(top), s, { face: D, sizePt: 6.8, fill: tinta, anchor: "end", attrs: ' data-label="value"' });
        }
      }
      y += jarak;
    });
    const dasar = y - jarak + rows.inset + tb + 1.4;
    doc.open('data-axis="y"');
    doc.line(kiri, 3, kiri, dasar, pal.ink900, dcPx(1.1));
    doc.close();
    if (limit !== null) {
      const xl = kiri + (lebar * (limit - lo)) / span;
      doc.line(xl, 2, xl, dasar, pal.role.limitExceeded, dcPx(0.9), { dashMm: [dcPx(3), dcPx(2)], attrs: ' data-limit="line"' });
      if (prep.limitLabelled) {
        // Nama batas dikapitalkan, angka dan satuan tidak (DC:192-193: "m" bukan "M").
        doc.text(xl, dasar + 3.4, (prep.limitLabel ?? "BATAS").toUpperCase(), {
          sizePt: 6.2,
          fill: pal.role.limitExceeded,
          anchor: "end",
          bold: true,
          trackMm: dcPx(0.6),
        });
        doc.text(xl + 1.4, dasar + 3.4, fmt(limit, dec) + (unit ? ` ${unit}` : ""), {
          face: D,
          sizePt: 6.2,
          fill: pal.role.limitExceeded,
          anchor: "start",
        });
      }
    }
    if (unit) doc.text(W - 1.5, dasar + 3.4, unit, { face: D, sizePt: 6.2, fill: pal.ink400, anchor: "end" });
  } else {
    const hasSub = pts.some((p) => p.sub !== undefined && p.sub !== "");
    const dasar = H - (hasSub ? 10 : 6);
    const atas = 6;
    const kiri = 4;
    const lebar = W - 8;
    const langkah = lebar / pts.length;
    const lk = Math.min(langkah * 0.52, 14);
    pts.forEach((x, i) => {
      const v = x.value;
      const h = ((dasar - atas) * v) / puncak;
      const cx = kiri + langkah * (i + 0.5);
      const warna = x.accent ? pal.role.accent : pal.ink700;
      doc.rect(cx - lk / 2, dasar - h, lk, h, warna, { mark: { mark: "column", series, index: i } });
      if (prep.columnValueLabels) {
        doc.text(cx, dasar - h - 1.6, fmt(v, dec), {
          face: D,
          sizePt: 6.8,
          fill: x.accent ? pal.role.accent : pal.ink900,
          anchor: "middle",
          attrs: ' data-label="value"',
        });
      }
      doc.text(cx, dasar + 3.6, x.label, { sizePt: 6.4, fill: pal.ink400, anchor: "middle", caps: true, trackMm: dcPx(0.5) });
      if (x.sub) doc.text(cx, dasar + 7.2, x.sub, { face: D, sizePt: 6.0, fill: pal.ink400, anchor: "middle" });
    });
    doc.open('data-axis="x"');
    doc.line(kiri, dasar, W - kiri, dasar, pal.ink900, dcPx(1.1));
    doc.close();
    if (unit) doc.text(kiri, atas - 1.6, unit, { face: D, sizePt: 6.2, fill: pal.ink400, anchor: "start" });
  }

  // DC menaruh catatan di H - 1,6 (bertumpuk dengan SUMBER pada apparatus figure); saat fit
  // (FIG-02a) catatan dinaikkan satu baris di atas caption.
  const noteY = fitActive() && spec.apparatus === "figure" ? figureCaptionTopMm(spec, H) - 4.2 : H - 1.6;
  if (spec.note) noteLine(doc, spec.note, W, noteY, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);

  return {
    svg: doc.toString(),
    widthMm: W,
    heightMm: H,
    report: { checksRun: [...new Set(issues.map((i) => i.checkId))], issues },
  };
}
