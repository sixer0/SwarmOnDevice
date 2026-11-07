/**
 * P-08 Slope — dua sumbu tegak dihubungkan garis (tepat dua titik waktu).
 *
 * Data `series`, dua orientasi (keduanya dipakai di repo):
 * - A (galeri S94): `categories` = dua periode, tiap seri = satu objek dengan dua nilai;
 * - B (adapter paritas S65, CHART_DATA_CONSTRAINTS): `categories` = objek, seri ke-1 dan
 *   ke-2 = periode (nama seri = label periode); seri lebih dari dua diabaikan (REPORT).
 * Aturan: tepat dua kategori -> A (termasuk kasus 2 x 2); selain itu -> B.
 *
 * Acuan: pustakachart `v11_slope` (PC:299, kelas CB1): garis verd naik / alert turun
 * lw 1,2 pt, label nama mono 6,2 pt di kanan, tick periode di bawah, sumbu y bertick,
 * gridline y. Galeri (Gambar 8.1 panel P-08): judul periode di atas, titik di kedua ujung,
 * label "nama nilai" di kiri dan nilai di kanan, tanpa sumbu.
 *
 * Parameter: `upColour` (verd), `downColour` (alert), `labelsBothSides` (galeri default
 * true; datum tanpa set eksplisit = label nama di kanan seperti acuan; false = "nama nilai"
 * di kanan). Nilai sama = ink400. Aksen: objek (garis + titik signal).
 */
import { fmt } from "../../bind";
import { defect } from "../core/guards";
import { ptToMm, textWidthMm } from "../core/svg";
import {
  type P1Ctx,
  SPINE_MM,
  TYPE_PT,
  accentHint,
  assertAccentCount,
  axisY,
  gridY,
  hintMiss,
  kindColour,
  kindParam,
  linearScale,
  pt,
  report,
  requireSeries,
  resolveTarget,
  spreadLabels,
  tickWidth,
  valueDomain,
} from "./common";

interface SlopeObj {
  name: string;
  a: number;
  b: number;
  accent: boolean;
  index: number;
}

export function renderSlope(ctx: P1Ctx): void {
  const { pal, doc, W, style } = ctx;
  const data = requireSeries(ctx, 1);
  let periods: [string, string];
  let objs: SlopeObj[];
  let skipped = 0;
  if (data.categories.length === 2) {
    periods = [data.categories[0], data.categories[1]];
    objs = data.series.flatMap((s, i) => {
      const [a, b] = s.values;
      if (a === null || b === null) {
        skipped++;
        return [];
      }
      return [{ name: s.name, a, b, accent: s.accent, index: i }];
    });
  } else {
    if (data.series.length < 2) {
      throw defect("P-08.periods", `${ctx.fid} — slope membutuhkan tepat dua titik waktu (dua kategori, atau dua seri); ganti line (W-01)`, {
        code: "P-08",
      });
    }
    if (data.series.length > 2) report(ctx, "P-08.series", `${data.series.length} seri; hanya dua seri pertama (periode) digambar`);
    const [s0, s1] = data.series;
    periods = [s0.name, s1.name];
    objs = data.categories.flatMap((name, i) => {
      const a = s0.values[i];
      const b = s1.values[i];
      if (a === null || b === null) {
        skipped++;
        return [];
      }
      return [{ name, a, b, accent: false, index: i }];
    });
  }
  if (skipped) report(ctx, "P-08.null", `${skipped} objek tanpa pasangan nilai dilewati`);
  if (!objs.length) throw defect("DC-G1", `${ctx.fid} — P-08: tidak ada objek dengan dua nilai`, { code: "P-08" });

  const hint = accentHint(ctx.spec);
  if (hint) {
    const i = resolveTarget(hint.target ?? hint.series, objs.map((o) => o.name));
    if (i >= 0) objs = objs.map((o, k) => (k === i ? { ...o, accent: true } : o));
    else hintMiss(ctx, JSON.stringify(hint));
  }
  assertAccentCount(ctx, new Set(objs.filter((o) => o.accent).map((o) => o.name)));

  const up = kindColour(ctx, "upColour", pal.verd, true);
  const down = kindColour(ctx, "downColour", pal.alert, true);
  const colourOf = (o: SlopeObj): string => (o.accent ? pal.role.accent : o.b > o.a ? up : o.b < o.a ? down : pal.ink400);
  const both = kindParam(ctx, "labelsBothSides");
  const labelMode: "both" | "rightName" | "rightNameValue" =
    both === undefined ? "rightName" : both === true ? "both" : both === false ? "rightNameValue" : "both";
  if (both !== undefined && typeof both !== "boolean") report(ctx, "P-08.labelsBothSides", `nilai ${JSON.stringify(both)} bukan boolean; dipakai true`);

  const T = style === "gallery" ? TYPE_PT.gallery : TYPE_PT.datum;
  const lblPt = pt(ctx, style === "gallery" ? T.label : 6.2);
  const face = style === "gallery" ? "struct" : "data";
  const leftText = (o: SlopeObj): string => (labelMode === "both" ? `${o.name} ${fmt(o.a, ctx.dec)}` : "");
  const rightText = (o: SlopeObj): string =>
    labelMode === "both" ? fmt(o.b, ctx.dec) : labelMode === "rightName" ? o.name : `${o.name} ${fmt(o.b, ctx.dec)}`;
  const leftW = Math.max(0, ...objs.map((o) => textWidthMm(leftText(o), lblPt, face)));
  const rightW = Math.max(0, ...objs.map((o) => textWidthMm(rightText(o), lblPt, face)));
  const vals = objs.flatMap((o) => [o.a, o.b]);
  const gap = ptToMm(lblPt) * 1.2;
  const series = (o: SlopeObj): string => o.name;

  if (style === "gallery") {
    const top = 6.4;
    const base = ctx.bottom - 1.6;
    const xa = Math.max(leftW + 2.6, W * 0.2);
    const xb = Math.min(W - rightW - 2.6, W * 0.8);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const sy = linearScale(lo, hi === lo ? lo + 1 : hi, base, top);
    doc.open('data-axis="x"');
    doc.text(xa, 3.0, periods[0], { sizePt: pt(ctx, T.label), fill: pal.ink400, anchor: "middle" });
    doc.text(xb, 3.0, periods[1], { sizePt: pt(ctx, T.label), fill: pal.ink400, anchor: "middle" });
    doc.close();
    objs.forEach((o, k) => {
      const c = colourOf(o);
      doc.line(xa, sy(o.a), xb, sy(o.b), c, 0.4, { mark: { mark: "line", series: series(o), index: k } });
    });
    objs.forEach((o, k) => {
      const c = colourOf(o);
      doc.circle(xa, sy(o.a), 0.75, c, { mark: { mark: "point", series: series(o), index: k } });
      doc.circle(xb, sy(o.b), 0.75, c, { mark: { mark: "point", series: series(o), index: k } });
    });
    const yl = spreadLabels(objs.map((o) => sy(o.a)), gap, top, base);
    const yr = spreadLabels(objs.map((o) => sy(o.b)), gap, top, base);
    objs.forEach((o, k) => {
      if (labelMode === "both") doc.text(xa - 1.4, yl[k] + ptToMm(lblPt) * 0.35, leftText(o), { sizePt: lblPt, fill: pal.ink700, anchor: "end", attrs: ' data-label="value"' });
      doc.text(xb + 1.4, yr[k] + ptToMm(lblPt) * 0.35, rightText(o), { sizePt: lblPt, fill: pal.ink700, attrs: ' data-label="value"' });
    });
    return;
  }

  // Gaya datum (resep v11_slope): xlim -0,1..1,5 -> periode di 1/16 dan 11/16 lebar plot.
  const top = 6.0;
  const base = ctx.bottom - 5.2;
  const dom = valueDomain(vals, false);
  const x0 = 0.5 + tickWidth(dom, T.tick, "data") + 1.6;
  const x1 = W - 0.5;
  const span = x1 - x0;
  const xa = labelMode === "both" ? x0 + leftW + 2.8 : x0 + span * (0.1 / 1.6);
  const xb = Math.min(x0 + span * (1.1 / 1.6), x1 - rightW - 1.4);
  const sy = linearScale(dom.min, dom.max, base, top);
  gridY(ctx, dom, sy, x0, x1, pal.ink200);
  objs.forEach((o, k) => {
    doc.line(xa, sy(o.a), xb, sy(o.b), colourOf(o), 1.2 * (25.4 / 72), { mark: { mark: "line", series: series(o), index: k } });
  });
  const yr = spreadLabels(objs.map((o) => sy(o.b)), gap, top, base);
  const yl = spreadLabels(objs.map((o) => sy(o.a)), gap, top, base);
  objs.forEach((o, k) => {
    doc.text(xb + 1.4, yr[k] + ptToMm(lblPt) * 0.35, rightText(o), { face: "data", sizePt: lblPt, fill: pal.ink700, attrs: ' data-label="value"' });
    if (labelMode === "both") doc.text(xa - 1.4, yl[k] + ptToMm(lblPt) * 0.35, leftText(o), { face: "data", sizePt: lblPt, fill: pal.ink700, anchor: "end", attrs: ' data-label="value"' });
  });
  axisY(ctx, dom, sy, x0, top, base, { colour: pal.ink400, widthMm: SPINE_MM, sizePt: T.tick, face: "data" });
  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.ink400, SPINE_MM);
  doc.text(xa, base + 3.6, periods[0], { sizePt: pt(ctx, T.label), fill: pal.ink700, anchor: "middle" });
  doc.text(xb, base + 3.6, periods[1], { sizePt: pt(ctx, T.label), fill: pal.ink700, anchor: "middle" });
  doc.close();
  if (ctx.unit) doc.text(x0, top - ptToMm(TYPE_PT.datum.title) - 0.4, ctx.unit, { sizePt: pt(ctx, TYPE_PT.datum.title), fill: pal.ink700 });
}
