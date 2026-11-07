/**
 * P-03 Grouped column — beberapa batang per kategori (dua sampai tiga seri).
 *
 * Acuan: pustakachart `v04_grouped_column` (PC:226, kelas CB1): kolom berkelompok,
 * seri 1 ink900, seri 2 ink400, lebar kelompok 0,72 jarak kategori, gridline y ink200,
 * tick angka mono, legenda teks di atas (di sini baris KUNCI, CH-04).
 * Galeri (Gambar 8.1 panel P-03): seri target = `targetColour` (ink200), seri lain
 * konteks utama ink400, satu batang aksen; tanpa sumbu y; label seri langsung di atas
 * kelompok pertama; label kategori di bawah garis dasar.
 *
 * Parameter: `maxSeries` (1..3, struktural: berlaku di kedua gaya; lebih -> penjaga,
 * ganti small multiples P-12), `targetColour` (seri pertama = seri target/acuan);
 * petunjuk galeri `seriesLabelsInPlot` (IP-41c; tidak diset = gallery label langsung,
 * datum baris KUNCI; diset = berlaku di kedua gaya).
 * Garis dasar nol selalu (CH-01); nilai negatif ditolak (pakai K-03 / P-10).
 */
import { keyRow } from "../core/apparatus";
import { categoryAxisPlan, drawCategoryLabel } from "../core/labelfit";
import { defect } from "../core/guards";
import { type SvgDoc, textWidthMm } from "../core/svg";
import {
  type P1Ctx,
  GRID_MM,
  HAIR_MM,
  SERIES_ACCENT_ATTR,
  SPINE_MM,
  TYPE_PT,
  accentHint,
  assertAccentCount,
  axisY,
  gridY,
  hintMiss,
  keyRowWidth,
  kindBool,
  kindColour,
  kindInt,
  linearScale,
  pt,
  requireSeries,
  resolveTarget,
  tickWidth,
  valueDomain,
} from "./common";
import { kindKey } from "../core/palette";

export function renderGroupedColumn(ctx: P1Ctx): void {
  const { pal, doc, W, style } = ctx;
  const data = requireSeries(ctx, 1);
  const maxSeries = kindInt(ctx, "maxSeries", 3, true);
  if (data.series.length > maxSeries) {
    throw defect(kindKey("P-03", "maxSeries"), `${ctx.fid} — ${data.series.length} seri > ${maxSeries}; ganti small multiples (P-12)`, {
      code: "P-03",
      series: data.series.length,
    });
  }
  data.series.forEach((s) =>
    s.values.forEach((v, i) => {
      if (v !== null && v < 0) {
        throw defect("CH-01", `${ctx.fid} — P-03: nilai negatif pada seri "${s.name}" kategori ${i}; pakai diverging bar (K-03)`, {
          code: "P-03",
          index: i,
        });
      }
    }),
  );
  const nS = data.series.length;
  const nC = data.categories.length;

  // Warna seri.
  const target = kindColour(ctx, "targetColour", style === "gallery" ? pal.ink200 : pal.ink900);
  const colours: string[] =
    style === "gallery"
      ? nS === 1
        ? [pal.role.contextMain]
        : [target, pal.role.contextMain, pal.ink700]
      : [target, pal.ink400, pal.ink200];

  // Aksen: batang tunggal (seri + kategori), kategori saja (batang seri terakhir), atau seri penuh.
  const accentBars = new Set<string>();
  const accentSeries = new Set<number>(data.series.flatMap((s, si) => (s.accent ? [si] : [])));
  const hint = accentHint(ctx.spec);
  if (hint) {
    const si = hint.series !== undefined ? data.series.findIndex((s) => s.name === hint.series) : -1;
    const ci = resolveTarget(hint.target, data.categories);
    if (hint.target !== undefined && ci >= 0) accentBars.add(`${si >= 0 ? si : nS - 1}#${ci}`);
    else if (hint.target === undefined && si >= 0) accentSeries.add(si);
    else hintMiss(ctx, JSON.stringify(hint));
  }
  assertAccentCount(ctx, new Set([...[...accentSeries].map((s) => `seri ${data.series[s].name}`), ...accentBars]));
  const fillOf = (si: number, ci: number): string =>
    accentSeries.has(si) || accentBars.has(`${si}#${ci}`) ? pal.role.accent : colours[si];

  const values = data.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const maxV = Math.max(0, ...values) || 1;
  const direct = kindBool(ctx, "seriesLabelsInPlot", style === "gallery", true);
  const keyItems = () => data.series.map((s, si) => ({ label: s.name, color: accentSeries.has(si) ? pal.role.accent : colours[si] }));

  if (style === "gallery") {
    const T = TYPE_PT.gallery;
    const left = 0.5;
    const step = (W - 2 * left) / nC;
    const lp = categoryAxisPlan(data.categories, step, { pt: pt(ctx, T.label) }, { maxRotateBandMm: Math.max(10, ctx.bottom * 0.4) });
    const base = ctx.bottom - 4.6 - (lp?.extraBandMm ?? 0);
    const labelBand = 1.2 + 2.6 * nS;
    const groupW = Math.min(step * 0.78, 9 * nS);
    const bw = groupW / nS;
    const sy = linearScale(0, maxV, base, labelBand);
    const tops: number[] = [];
    data.categories.forEach((c, ci) => {
      const gx = left + step * (ci + 0.5) - groupW / 2;
      data.series.forEach((s, si) => {
        const v = s.values[ci];
        if (v === null) return;
        const y1 = sy(v);
        doc.rect(gx + bw * si, y1, bw, base - y1, fillOf(si, ci), { mark: { mark: "column", series: s.name, index: ci }, attrs: accentSeries.has(si) ? SERIES_ACCENT_ATTR : "" });
        if (ci === 0) tops[si] = y1;
      });
      if (lp) drawCategoryLabel(doc, lp, ci, left + step * (ci + 0.5), base + 3.4, { sizePt: pt(ctx, T.label), fill: pal.ink400, anchor: "middle" });
      else doc.text(left + step * (ci + 0.5), base + 3.4, c, { sizePt: pt(ctx, T.label), fill: pal.ink400, anchor: "middle" });
    });
    // Label seri langsung di atas kelompok pertama (CH-04); ditumpuk bila bertabrakan.
    if (nS > 1 && direct) directLabels(doc, data.series.map((s) => s.name), left + step * 0.5 - groupW / 2, bw, tops, base, pt(ctx, T.key), pal.ink700);
    else if (nS > 1) keyRow(doc, left, 2.4, keyItems(), pal, pt(ctx, T.key));
    doc.open('data-axis="x"');
    doc.line(left, base, W - left, base, pal.role.textAxis, HAIR_MM);
    doc.close();
    return;
  }

  // Gaya datum (resep v04_grouped_column).
  const T = TYPE_PT.datum;
  const top = 6.4;
  const dom = valueDomain(values.length ? values : [0], true);
  const x0 = 0.5 + tickWidth(dom, T.tick, "data") + 1.6;
  const x1 = W - 0.5;
  const lpd = categoryAxisPlan(data.categories, (x1 - x0) / nC, { pt: pt(ctx, 6.2) }, { maxRotateBandMm: Math.max(10, ctx.bottom * 0.4) });
  const base = ctx.bottom - 5.2 - (lpd?.extraBandMm ?? 0);
  const sy = linearScale(dom.min, dom.max, base, top);
  gridY(ctx, dom, sy, x0, x1, pal.ink200);
  const step = (x1 - x0) / nC;
  const groupW = step * 0.72;
  const bw = groupW / nS;
  const datumTops: number[] = [];
  data.categories.forEach((c, ci) => {
    const gx = x0 + step * (ci + 0.5) - groupW / 2;
    data.series.forEach((s, si) => {
      const v = s.values[ci];
      if (v === null) return;
      doc.rect(gx + bw * si, sy(v), bw, sy(0) - sy(v), fillOf(si, ci), { mark: { mark: "column", series: s.name, index: ci }, attrs: accentSeries.has(si) ? SERIES_ACCENT_ATTR : "" });
      if (ci === 0) datumTops[si] = sy(v);
    });
    if (lpd) drawCategoryLabel(doc, lpd, ci, x0 + step * (ci + 0.5), base + 3.4, { sizePt: pt(ctx, 6.2), fill: pal.ink700, anchor: "middle" });
    else doc.text(x0 + step * (ci + 0.5), base + 3.4, c, { sizePt: pt(ctx, 6.2), fill: pal.ink700, anchor: "middle" });
  });
  axisY(ctx, dom, sy, x0, top, base, { colour: pal.ink400, widthMm: SPINE_MM, sizePt: T.tick, face: "data" });
  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.ink400, Math.max(SPINE_MM, GRID_MM));
  doc.close();
  const unitEnd = ctx.unit ? x0 + textWidthMm(ctx.unit, pt(ctx, T.title)) + 3.0 : x0;
  if (ctx.unit) doc.text(x0, 3.4, ctx.unit, { sizePt: pt(ctx, T.title), fill: pal.ink700 });
  if (nS > 1 && direct) {
    directLabels(doc, data.series.map((s) => s.name), x0 + step * 0.5 - groupW / 2, bw, datumTops, base, pt(ctx, T.key), pal.ink700);
  } else if (nS > 1) {
    const names = data.series.map((s) => s.name);
    const kw = keyRowWidth(names, pt(ctx, T.key));
    keyRow(doc, Math.max(unitEnd, x1 - kw), 3.4, keyItems(), pal, pt(ctx, T.key));
  }
}

/** Label seri langsung di atas batang kelompok pertama; ditumpuk 2,6 mm bila bertabrakan. */
function directLabels(doc: SvgDoc, names: readonly string[], gx: number, bw: number, tops: readonly number[], base: number, sizePt: number, fill: string): void {
  let prev: { x0: number; x1: number; y: number } | undefined;
  doc.open('data-key="direct"');
  names.forEach((name, si) => {
    const cx = gx + bw * (si + 0.5);
    const w = textWidthMm(name, sizePt);
    let y = (tops[si] ?? base) - 1.0;
    if (prev && cx - w / 2 < prev.x1 && cx + w / 2 > prev.x0 && Math.abs(y - prev.y) < 2.6) y = prev.y - 2.6;
    doc.text(cx, y, name, { sizePt, fill, anchor: "middle" });
    prev = { x0: cx - w / 2, x1: cx + w / 2, y };
  });
  doc.close();
}
