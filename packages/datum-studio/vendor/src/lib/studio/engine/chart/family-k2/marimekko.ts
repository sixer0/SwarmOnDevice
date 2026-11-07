/**
 * K-12 Marimekko — stacked bar 100 % dengan lebar kolom bervariasi (Tabel 8.3). Acuan
 * pustakachart v31_marimekko (PC:539, CB1).
 *
 * Data `series` (CHART_DATA_CONSTRAINTS K-12): kategori = kolom, seri = bagian (ditumpuk
 * dari bawah dalam urutan seri). Lebar kolom dari kunci lokal `params.widths` (panjang =
 * jumlah kategori, nilai > 0; panjang salah -> SCHEMA_INVALID); tanpa `widths` dibagi rata.
 * Tinggi bagian = nilai / jumlah kolom (porsi); kolom berjumlah nol dilaporkan. `null` = 0.
 *
 * Gaya `gallery` (panel Gambar 8.3): kolom rapat tanpa celah, tanpa label bagian; seri
 * beraksen signal, seri lain ink400, ink200, ink700, ink100; nama kategori di bawah kolom.
 * Gaya `datum`: celah kolom 6 % (PC `lebar * 0,94`), sumbu y porsi 0-100 bertick 25,
 * label nilai bagian Plex Mono di tengah bagian bila muat, baris KUNCI seri di atas;
 * rona ink900, ink400, ink200, ink100.
 *
 * Aksen: seri (`accent: true`, `accent.series`) atau satu bagian (`accent.point` = kategori,
 * dengan `accent.series` bila ada; tanpa seri = seri pertama). Atribut tanda: `data-mark=
 * "column"`, `data-series` = nama seri, `data-index` = indeks SERI, `data-category` = indeks
 * kategori — sehingga aksen satu seri dihitung satu subjek pada lint 26 (core lintChartSvg).
 */
import type { ChartRenderer } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt, withUnit } from "../../bind";
import { keyRow, keyRowExtraMm } from "../core/apparatus";
import { defect } from "../core/guards";
import { textWidthMm } from "../core/svg";
import {
  HAIR_MM,
  KEY_BAND_MM,
  type K2Ctx,
  accentHint,
  assertAccentCount,
  beginChart,
  contextShades,
  endChart,
  hintMiss,
  inkOn,
  invalidParam,
  kindParam,
  mid,
  pt,
  report,
  resolveTarget,
  sum,
} from "./common";
import { categoryAxisPlan, drawCategoryLabel } from "../core/labelfit";

interface Mekko {
  categories: string[];
  series: Array<{ name: string; values: number[]; accent: boolean }>;
}

function mekkoData(ctx: K2Ctx): Mekko {
  const d = ctx.spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — K-12: data wajib`, { code: ctx.code });
  if (d.shape !== "series") {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — K-12 membutuhkan data "series", diterima "${d.shape}"`, { code: ctx.code, shape: d.shape });
  }
  if (!Array.isArray(d.categories) || d.categories.length === 0 || !Array.isArray(d.series) || d.series.length === 0) {
    throw defect("DC-G1", `${ctx.fid} — marimekko tanpa kategori atau seri`, { code: ctx.code });
  }
  const nC = d.categories.length;
  const series = d.series.map((s, si) => {
    if (typeof s?.name !== "string" || !Array.isArray(s.values) || s.values.length !== nC) {
      throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — seri ${si}: nama wajib dan ${nC} nilai (satu per kategori)`, { code: ctx.code, index: si });
    }
    const values = s.values.map((v, ci) => {
      if (v === null) return 0;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw defect("K-12", `${ctx.fid} — seri ${s.name}, kategori ${ci}: nilai bukan bilangan hingga >= 0`, { code: ctx.code, index: si });
      }
      return v;
    });
    return { name: s.name, values, accent: s.accent === true };
  });
  return { categories: d.categories.map(String), series };
}

export const renderMarimekko: ChartRenderer = (spec, canvas, tpl) => {
  const ctx = beginChart("K-12", spec, canvas, tpl);
  const { doc, pal, dec, unit } = ctx;
  const T = { label: pt(ctx, ctx.style === "gallery" ? 6.4 : 6.2), value: pt(ctx, 6.0), tick: pt(ctx, 6.0) };
  const { categories, series } = mekkoData(ctx);
  const nC = categories.length;

  const wRaw = kindParam(ctx, "widths");
  let widths = categories.map(() => 1);
  if (wRaw !== undefined) {
    if (!Array.isArray(wRaw) || wRaw.length !== nC || !wRaw.every((w) => typeof w === "number" && Number.isFinite(w) && w > 0)) {
      throw invalidParam(ctx, "widths", wRaw, `${nC} bilangan > 0 (satu per kategori)`);
    }
    widths = wRaw as number[];
  }
  const colSum = categories.map((_, ci) => sum(series.map((s) => s.values[ci])));
  const empty = categories.filter((_, ci) => !(colSum[ci] > 0));
  if (empty.length === nC) throw defect("DC-G1", `${ctx.fid} — marimekko tanpa nilai positif`, { code: ctx.code });
  if (empty.length) report(ctx, "K-12", `kolom berjumlah nol: ${empty.join(", ")}`);

  // Aksen: seri penuh atau satu bagian.
  const accSeries = new Set<number>(series.flatMap((s, si) => (s.accent ? [si] : [])));
  let accCell: { si: number; ci: number } | undefined;
  const hint = accentHint(spec);
  if (hint) {
    const si = hint.series !== undefined ? series.findIndex((s) => s.name === hint.series) : -1;
    if (hint.series !== undefined && si < 0) hintMiss(ctx, `seri ${JSON.stringify(hint.series)}`);
    else if (hint.point !== undefined) {
      const ci = resolveTarget(hint.point, categories);
      if (ci < 0) hintMiss(ctx, `kategori ${JSON.stringify(hint.point)}`);
      else accCell = { si: Math.max(si, 0), ci };
    } else if (si >= 0) accSeries.add(si);
    else if (hint.group !== undefined) hintMiss(ctx, `grup ${JSON.stringify(hint.group)} (K-12 memakai seri)`);
  }
  assertAccentCount(
    ctx,
    new Set([...[...accSeries].map((si) => `seri ${series[si].name}`), ...(accCell ? [`${series[accCell.si].name}#${categories[accCell.ci]}`] : [])]),
  );
  const shades = contextShades(ctx, [pal.ink400, pal.ink200, pal.ink700, pal.ink100]);
  if (series.length - accSeries.size > shades.length) {
    throw defect("DATUM-25", `${ctx.fid} — ${series.length} seri; maks ${shades.length} seri non-aksen yang terbedakan`, { code: ctx.code });
  }
  let sh = 0;
  const seriesColour = series.map((_, si) => (accSeries.has(si) ? pal.role.accent : shades[sh++]));
  const fillOf = (si: number, ci: number): string => (accCell && accCell.si === si && accCell.ci === ci ? pal.role.accent : seriesColour[si]);

  let { x0, y0 } = ctx;
  const { x1 } = ctx;
  const datum = ctx.style === "datum";
  // FIG-02a P1-4: slot terkecil menentukan rencana label kategori (hanya saat fit).
  const wTot0 = sum(widths);
  const fullW0 = x1 - x0 - (datum ? textWidthMm("100", T.tick, "data") + 1.8 : 0);
  const lp = categoryAxisPlan(categories, Math.min(...widths.map((w) => (w / wTot0) * fullW0)), { pt: T.label }, { maxRotateBandMm: Math.max(10, (ctx.y1 - y0) * 0.4) });
  const catBand = 4.4 + (lp?.extraBandMm ?? 0);
  const y1 = ctx.y1 - catBand;
  if (datum) {
    const keyItems = series.map((s, si) => ({ label: s.name, color: seriesColour[si] }));
    keyRow(doc, x0, y0 + 3.0, keyItems, pal, T.label);
    y0 += KEY_BAND_MM + keyRowExtraMm(x0, keyItems.map((k) => k.label), T.label);
    x0 += textWidthMm("100", T.tick, "data") + 1.8;
  }
  const wTot = sum(widths);
  const fullW = x1 - x0;
  const colGap = datum ? 0.06 : 0;
  const plotH = y1 - y0;

  let cx = x0;
  categories.forEach((cat, ci) => {
    const cw = (widths[ci] / wTot) * fullW;
    const bw = cw * (1 - colGap);
    let yb = y1;
    series.forEach((s, si) => {
      const v = s.values[ci];
      const h = colSum[ci] > 0 ? (v / colSum[ci]) * plotH : 0;
      const fill = fillOf(si, ci);
      doc.rect(cx, yb - h, bw, h, fill, { mark: { mark: "column", series: s.name, index: si }, attrs: ` data-category="${ci}"` });
      if (datum && h > 0) {
        const lbl = withUnit(fmt(v, dec), unit);
        if (textWidthMm(lbl, T.value, "data") <= bw - 1.2 && h >= 3.0) {
          doc.text(cx + bw / 2, mid(yb - h / 2, T.value), lbl, { face: "data", sizePt: T.value, fill: inkOn(ctx, fill), anchor: "middle", attrs: ' data-label="value"' });
        }
      }
      yb -= h;
    });
    if (lp) drawCategoryLabel(doc, lp, ci, cx + bw / 2, y1 + 3.4, { sizePt: T.label, fill: pal.ink700, anchor: "middle" });
    else doc.text(cx + bw / 2, y1 + 3.4, cat, { sizePt: T.label, fill: pal.ink700, anchor: "middle" });
    cx += cw;
  });

  if (datum) {
    doc.open('data-axis="y"');
    doc.line(x0 - 0.6, y0, x0 - 0.6, y1, pal.role.textAxis, HAIR_MM);
    for (const t of [0, 25, 50, 75, 100]) {
      doc.text(x0 - 1.4, mid(y1 - (t / 100) * plotH, T.tick), String(t), { face: "data", sizePt: T.tick, fill: pal.ink400, anchor: "end" });
    }
    doc.close();
  }
  return endChart(ctx);
};
