/**
 * P-06 Dumbbell — dua titik dihubungkan garis (selisih dua kondisi, sebelum dan sesudah).
 *
 * Data `series`: kategori = baris (objek), seri ke-1 = awal, seri ke-2 = akhir; seri
 * lebih dari dua diabaikan (REPORT); baris dengan nilai null dilewati (REPORT).
 * Acuan: pustakachart `v07_dumbbell` (PC:268, kelas CB1): segmen ink200 lw 1,6 pt, titik
 * awal ink400, akhir ink900 (ms 5,5 pt), urutan alami, legenda di atas (baris KUNCI),
 * gridline x. Galeri (Gambar 8.1 panel P-06): awal `startColour` (ink400), akhir
 * `endColour` (signal), segmen ink200, sumbu x bertick, label baris di kiri.
 *
 * Parameter: `startColour`, `endColour`, `sort` (byDifference = selisih akhir - awal menurun;
 * valueDesc/valueAsc = nilai akhir). Gaya datum memakai resep acuan kecuali diset eksplisit.
 * Aksen: baris (titik akhir signal) atau seri penuh (`series[].accent`, `accent.series`).
 */
import { keyRow } from "../core/apparatus";
import { defect } from "../core/guards";
import { ptToMm } from "../core/svg";
import {
  type P1Ctx,
  HAIR_MM,
  SERIES_ACCENT_ATTR,
  SORT,
  SPINE_MM,
  TYPE_PT,
  accentHint,
  assertAccentCount,
  axisX,
  gridX,
  hintMiss,
  keyRowWidth,
  kindColour,
  kindEnum,
  labelGutter,
  linearScale,
  mid,
  pt,
  report,
  requireSeries,
  resolveTarget,
  stableSort,
  tickWidth,
  valueDomain,
  hintedDomain,
} from "./common";

export function renderDumbbell(ctx: P1Ctx): void {
  const { pal, doc, W, style } = ctx;
  const data = requireSeries(ctx, 2);
  if (data.series.length > 2) report(ctx, "P-06.series", `${data.series.length} seri; hanya dua seri pertama (awal, akhir) digambar`);
  const [s0, s1] = data.series;
  let rows = data.categories.flatMap((label, i) => {
    const a = s0.values[i];
    const b = s1.values[i];
    return a === null || b === null ? [] : [{ label, a, b, i, accent: false }];
  });
  if (rows.length < data.categories.length) report(ctx, "P-06.null", `${data.categories.length - rows.length} baris tanpa pasangan nilai dilewati`);
  if (!rows.length) throw defect("DC-G1", `${ctx.fid} — P-06: tidak ada baris dengan pasangan nilai awal dan akhir`, { code: "P-06" });

  // Aksen.
  const accentSeries = new Set<number>([s0, s1].flatMap((s, si) => (s.accent ? [si] : [])));
  const hint = accentHint(ctx.spec);
  if (hint) {
    const ri = resolveTarget(hint.target, rows.map((r) => r.label));
    const si = hint.series === s0.name ? 0 : hint.series === s1.name ? 1 : -1;
    if (ri >= 0) rows = rows.map((r, k) => (k === ri ? { ...r, accent: true } : r));
    else if (hint.target === undefined && si >= 0) accentSeries.add(si);
    else hintMiss(ctx, JSON.stringify(hint));
  }
  assertAccentCount(ctx, new Set([...[...accentSeries].map((s) => `seri ${data.series[s].name}`), ...rows.filter((r) => r.accent).map((r) => r.label)]));

  const sort = kindEnum(ctx, "sort", SORT, "natural");
  if (sort === "byDifference") rows = stableSort(rows, (r) => r.b - r.a, -1);
  else if (sort !== "natural") rows = stableSort(rows, (r) => r.b, sort === "valueAsc" ? 1 : -1);

  const cStart = accentSeries.has(0) ? pal.role.accent : kindColour(ctx, "startColour", pal.ink400);
  const cEnd = accentSeries.has(1) ? pal.role.accent : kindColour(ctx, "endColour", pal.ink900);

  // Seri berwarna aksen (seri beraksen, atau startColour/endColour = peran aksen) = satu subjek.
  const startAttr = cStart === pal.role.accent ? SERIES_ACCENT_ATTR : "";
  const endAttr = cEnd === pal.role.accent ? SERIES_ACCENT_ATTR : "";
  if (startAttr && endAttr) report(ctx, "DATUM-26", "warna awal dan akhir sama-sama peran aksen; dua seri beraksen");

  const T = style === "gallery" ? TYPE_PT.gallery : TYPE_PT.datum;
  const labelPt = pt(ctx, T.label);
  const dom = hintedDomain(ctx, rows.flatMap((r) => [r.a, r.b]), false, () => valueDomain(rows.flatMap((r) => [r.a, r.b]), false));
  // IMPL-W10: label berujung di x0 - 1,6 mm. Galeri: talang + 1,0 mm (anchorGap bawaan 1,2 -> tepi 1,0 mm, tidak berubah);
  // datum: anchorGap 1,6 -> ruang tepi kiri 0,4 mm (sebelumnya 0 mm).
  const x0 = style === "gallery" ? labelGutter(ctx, rows.map((r) => r.label), labelPt) + 1.0 : labelGutter(ctx, rows.map((r) => r.label), labelPt, 0.42, 1.6);
  const x1 = W - Math.max(1.0, tickWidth(dom, T.tick, style === "gallery" ? "struct" : "data") / 2 + 0.3);
  const keyBand = style === "datum" ? 5.0 : 0;
  const unitBand = style === "datum" && ctx.unit ? ptToMm(TYPE_PT.datum.title) + 1.6 : 0;
  const top = 0.8 + keyBand;
  const base = ctx.bottom - 4.6 - unitBand;
  const sx = linearScale(dom.min, dom.max, x0, x1);
  const step = (base - top) / rows.length;
  const r = style === "gallery" ? Math.min(0.8, step * 0.3) : Math.min(2.75 * (25.4 / 72), step * 0.4);
  const segMm = style === "gallery" ? 0.55 : 1.6 * (25.4 / 72);

  if (style === "datum") gridX(ctx, dom, sx, top, base, pal.ink200);
  rows.forEach((row, k) => {
    const yc = top + step * (k + 0.5);
    doc.text(x0 - 1.6, mid(yc, labelPt), row.label, { sizePt: labelPt, fill: style === "gallery" ? pal.ink400 : pal.ink700, anchor: "end" });
    doc.line(sx(row.a), yc, sx(row.b), yc, pal.role.contextBackground, segMm, { mark: { mark: "segment", series: `${s0.name}-${s1.name}`, index: row.i } });
    doc.circle(sx(row.a), yc, r, cStart, { mark: { mark: "point", series: s0.name, index: row.i }, attrs: startAttr });
    doc.circle(sx(row.b), yc, r, row.accent ? pal.role.accent : cEnd, {
      mark: { mark: "point", series: s1.name, index: row.i },
      attrs: row.accent && cEnd !== pal.role.accent ? "" : endAttr,
    });
  });

  if (style === "gallery") {
    axisX(ctx, dom, sx, base, x0, x1, { colour: pal.role.textAxis, widthMm: HAIR_MM, sizePt: T.tick, face: "struct" });
    return;
  }
  axisX(ctx, dom, sx, base, x0, x1, { colour: pal.ink400, widthMm: SPINE_MM, sizePt: T.tick, face: "data" });
  doc.open('data-axis="y"');
  doc.line(x0, top, x0, base, pal.ink400, SPINE_MM);
  doc.close();
  const keyPt = pt(ctx, T.key);
  const names = [s0.name, s1.name];
  const kw = keyRowWidth(names, keyPt);
  keyRow(doc, Math.max(0.5, Math.min(x0, W - kw)), 3.4, [
    { label: s0.name, color: cStart },
    { label: s1.name, color: cEnd },
  ], pal, keyPt);
  if (ctx.unit) doc.text((x0 + x1) / 2, ctx.bottom - 1.0, ctx.unit, { sizePt: pt(ctx, TYPE_PT.datum.title), fill: pal.ink700, anchor: "middle" });
}
