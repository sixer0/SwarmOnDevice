/**
 * engine/chart/core — gaya "gallery": panel Gambar 8.1-8.5 Manual 000 untuk P-01, P-02,
 * P-11, W-02 (research/06:219 pengamatan visual; permintaan S02/F-006).
 *
 * Ciri galeri: tanpa judul di plot; konteks latar ink200 dan satu aksen signal (P-01,
 * P-02, W-02); label kategori Plex Sans Condensed ink400; label nilai Plex Mono ink900
 * di ujung batang. Threshold (P-11): batang konteks utama ink400, batang melewati batas
 * ber-overLimitColour; GARIS BATAS HITAM (peran textAxis) putus-putus dengan label batas
 * DI ATAS plot; label nilai DI DALAM batang (kertas di atas batang), kecuali batang yang
 * melewati batas (di luar ujung, warna batas); sumbu x bertick.
 *
 * Garis dasar nol (CH-01): bar/column selalu dari 0. Threshold mengikuti P7-04
 * `chart.zeroBaseline` (kelas K, default true); bila false, domain dipotong rapi seperti
 * panel galeri (40..60) dan temuan REPORT CH-01 dicatat.
 *
 * Kanvas boleh selebar panel komposit (< 128 mm); ukuran huruf tetap pt fisik >= 6,0.
 */
import type { ChartCanvas, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "./apparatus";
import { drawGutterLabel, gutterPlan } from "./labelfit";
import type { CorePrep } from "./prepare";
import { axisDomain, decimalsFor, linearScale, niceDomain } from "./scale";
import { SvgDoc, textWidthMm, midBaseline } from "./svg";
import { measure } from "./textfit";

const LBL_PT = 6.4;
const VAL_PT = 6.4;
const TICK_PT = 6.0;
const HAIR_MM = 0.25;

const mid = midBaseline;

export function renderGallery(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, prep: CorePrep): SvgResult {
  void tpl;
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const { pal, pts, dec, unit } = prep;
  const issues: LintIssue[] = [];
  const doc = new SvgDoc(W, H, `data-chart="${prep.code}" data-style="gallery"`, prep.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);

  const series = unit || "nilai";
  const footBand = figureFootMm(spec) + (spec.note ? 5 : 0);
  const vals = pts.map((p) => fmt(p.value, dec));

  if (prep.family === "bar") {
    const top = 0.8;
    const bottom = H - footBand - 0.8;
    // IMPL-W5 D1: label terlebar diukur dengan metrik glif nyata (bukan taksiran rerata em).
    const labelW = Math.max(...pts.map((p) => measure(p.label, LBL_PT)));
    const x00 = Math.min(Math.max(labelW + 1.6, 6), W * 0.42);
    const gp = gutterPlan(
      pts.map((p) => p.label),
      { pt: LBL_PT },
      { currentMm: x00, capMm: W * 0.42, padMm: 1.6, pitchMm: (bottom - top) / pts.length },
    );
    const x0 = gp ? Math.max(x00, gp.gutterMm) : x00;
    const valW = Math.max(...vals.map((v) => textWidthMm(v, VAL_PT, "data")));
    const xr = prep.valueLabel === "barEnd" ? W - valW - 1.4 : W - 0.5;
    const maxV = Math.max(...pts.map((p) => p.value)) || 1;
    const sx = linearScale(0, maxV, x0, xr);
    const step = (bottom - top) / pts.length;
    const bh = step * 0.6;
    pts.forEach((p, i) => {
      const yc = top + step * (i + 0.5);
      const x1 = sx(p.value);
      if (gp) drawGutterLabel(doc, gp, i, x0 - 1.2, mid(yc, LBL_PT), { sizePt: LBL_PT, fill: pal.ink400, anchor: "end" });
      else doc.text(x0 - 1.2, mid(yc, LBL_PT), p.label, { sizePt: LBL_PT, fill: pal.ink400, anchor: "end" });
      doc.rect(x0, yc - bh / 2, x1 - x0, bh, p.accent ? pal.role.accent : pal.role.contextBackground, {
        mark: { mark: "bar", series, index: i },
      });
      if (prep.valueLabel === "none") return;
      const inside = prep.valueLabel === "inside" && x1 - x0 >= textWidthMm(vals[i], VAL_PT, "data") + 1.6;
      doc.text(inside ? x1 - 0.8 : x1 + 1.0, mid(yc, VAL_PT), vals[i], {
        face: "data",
        sizePt: VAL_PT,
        fill: inside ? pal.paper : pal.ink900,
        anchor: inside ? "end" : "start",
        attrs: ' data-label="value"',
      });
    });
    doc.open('data-axis="y"');
    doc.line(x0, top, x0, bottom, pal.role.textAxis, HAIR_MM);
    doc.close();
  } else if (prep.family === "column") {
    const hasSub = pts.some((p) => p.sub !== undefined && p.sub !== "");
    const topBand = 3.6 + (unit ? 2.8 : 0);
    const base = H - footBand - 4.6 - (hasSub ? 3.2 : 0);
    const left = 0.5;
    const step = (W - 2 * left) / pts.length;
    const cw = Math.min(step * 0.62, 14);
    const maxV = Math.max(...pts.map((p) => p.value)) || 1;
    const sy = linearScale(0, maxV, base, topBand);
    if (unit) doc.text(W - left, 2.4, unit, { sizePt: TICK_PT, fill: pal.ink400, anchor: "end" });
    pts.forEach((p, i) => {
      const cx = left + step * (i + 0.5);
      const y1 = sy(p.value);
      doc.rect(cx - cw / 2, y1, cw, base - y1, p.accent ? pal.role.accent : pal.role.contextBackground, {
        mark: { mark: "column", series, index: i },
      });
      if (prep.columnValueLabels) doc.text(cx, y1 - 1.0, vals[i], { face: "data", sizePt: VAL_PT, fill: pal.ink900, anchor: "middle", attrs: ' data-label="value"' });
      doc.text(cx, base + 3.4, p.label, { sizePt: LBL_PT, fill: pal.ink400, anchor: "middle" });
      if (p.sub) doc.text(cx, base + 6.6, p.sub, { face: "data", sizePt: 6.0, fill: pal.ink400, anchor: "middle" });
    });
    doc.open('data-axis="x"');
    doc.line(left, base, W - left, base, pal.role.textAxis, HAIR_MM);
    doc.close();
  } else {
    const limit = prep.limit as number;
    const top = 4.4;
    const base = H - footBand - 4.6;
    const labelW = Math.max(...pts.map((p) => measure(p.label, LBL_PT)));
    const x00 = Math.min(Math.max(labelW + 1.6, 6), W * 0.4);
    const gp = gutterPlan(
      pts.map((p) => p.label),
      { pt: LBL_PT },
      { currentMm: x00, capMm: W * 0.4, padMm: 1.6, pitchMm: (base - top) / pts.length },
    );
    const x0 = gp ? Math.max(x00, gp.gutterMm) : x00;
    // Talang kanan: label nilai batang yang melewati batas duduk di luar ujung batang.
    const overW = Math.max(0, ...pts.map((p, i) => (p.value > limit ? textWidthMm(vals[i], VAL_PT, "data") + 1.4 : 0)));
    const xr = W - Math.max(1.0, overW, textWidthMm("000", TICK_PT) / 2);
    const all = [...pts.map((p) => p.value), limit];
    const lo = Math.min(...all);
    const hi = Math.max(...all);
    // Domain terpotong (zeroBaseline=false): sisakan separuh rentang di bawah nilai terkecil
    // agar batang terpendek tetap tergambar (panel galeri: 48..57,5 -> 40..60).
    const padded = Math.max(lo >= 0 ? 0 : -Infinity, lo - 0.5 * (hi - lo || Math.abs(hi) || 1));
    // Petunjuk `axis` (IP-41c): domain tercetak tetap, tick rapi di dalamnya (panel 40..62).
    const ad = prep.axis ? axisDomain(all, { zero: prep.zero }, prep.axis) : undefined;
    const dom = ad ? ad.dom : niceDomain(prep.zero ? all : [...all, padded], { zero: prep.zero });
    if (ad?.widened) issues.push({ checkId: "AXIS_DOMAIN", status: "REPORT", detail: ad.widened });
    if (!prep.zero) {
      issues.push({ checkId: "CH-01", status: "REPORT", detail: `domain threshold ${dom.min}..${dom.max} tidak bermula nol (chart.zeroBaseline=false)` });
    }
    const sx = linearScale(dom.min, dom.max, x0, xr);
    const step = (base - top) / pts.length;
    const bh = step * 0.56;
    pts.forEach((p, i) => {
      const yc = top + step * (i + 0.5);
      const x1 = sx(p.value);
      const over = p.value > limit;
      const fill = over ? prep.overColour : p.accent ? pal.role.accent : pal.role.contextMain;
      if (gp) drawGutterLabel(doc, gp, i, x0 - 1.2, mid(yc, LBL_PT), { sizePt: LBL_PT, fill: pal.ink400, anchor: "end" });
      else doc.text(x0 - 1.2, mid(yc, LBL_PT), p.label, { sizePt: LBL_PT, fill: pal.ink400, anchor: "end" });
      doc.rect(x0, yc - bh / 2, x1 - x0, bh, fill, { mark: { mark: "bar", series, index: i } });
      const fits = x1 - x0 >= textWidthMm(vals[i], VAL_PT, "data") + 2.0;
      const inside = !over && fits;
      doc.text(inside ? x0 + 1.0 : x1 + 1.0, mid(yc, VAL_PT), vals[i], {
        face: "data",
        sizePt: VAL_PT,
        fill: inside ? pal.paper : over ? prep.overColour : pal.ink900,
        anchor: "start",
        attrs: ' data-label="value"',
      });
    });
    doc.open('data-axis="x"');
    doc.line(x0, base, xr, base, pal.role.textAxis, HAIR_MM);
    const tdec = decimalsFor(dom.step);
    for (const t of dom.ticks) {
      doc.text(sx(t), base + 3.6, fmt(t, tdec), { sizePt: TICK_PT, fill: pal.ink400, anchor: "middle" });
    }
    doc.close();
    if (prep.zero) {
      doc.open('data-axis="y"');
      doc.line(x0, top, x0, base, pal.role.textAxis, HAIR_MM);
      doc.close();
    }
    const xl = sx(limit);
    doc.line(xl, top - 1.4, xl, base, pal.role.textAxis, 0.3, { dashMm: [1.2, 0.9], attrs: ' data-limit="line"' });
    if (prep.limitLabelled) {
      // limitLabel yang sudah memuat angka batas terformat dipakai apa adanya
      // ("batas 55,0 dB(A)"); selain itu angka + satuan ditambahkan.
      const value = withUnit(fmt(limit, dec), unit);
      const name = prep.limitLabel ?? "batas";
      const s = name.includes(fmt(limit, dec)) ? name : `${name} ${value}`;
      const right = xl + 0.8 + textWidthMm(s, TICK_PT) <= W;
      doc.text(right ? xl + 0.8 : xl - 0.8, 2.6, s, { sizePt: TICK_PT, fill: pal.role.textAxis, anchor: right ? "start" : "end" });
    }
  }

  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);

  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun: [...new Set(issues.map((i) => i.checkId))], issues } };
}
