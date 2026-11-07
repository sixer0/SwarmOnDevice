/**
 * S-03 Density (S41). Acuan: pustakachart `v53_density` + `_kde` (PC:852-869, kelas CB1
 * PENUH): KDE Gaussian, bandwidth Silverman 1,06 sigma n^(-1/5), area ink200 + kurva
 * ink900 1,2 pt, tanpa tick y. Gaya datum juga tanpa tick x (acuan `ax.set_xticks([]);
 * ax.set_yticks([])`, PC:865; D-296 FIX-C2, D-300): spine kiri + bawah (garis dasar) tetap digambar
 * seperti acuan (`patch_3`/`patch_4`, ink400 0,6 pt) tanpa tick dan tanpa label tick, masing-masing
 * dalam grup `data-axis` bertanda `data-spine="1"` (sumbu tanpa tick); kurva mengisi lebar plot
 * (domain = rentang kurva, atau `axis` bila ada), satuan tetap sebagai judul sumbu x. Gaya gallery
 * tetap bersumbu x bertick (panel galeri).
 *
 * Bandwidth berparameter (deterministik): `chart.kind.S-03.bandwidth` (ParamDef mesin IP-25) = angka > 0
 * (mutlak, satuan data) | "silverman" (default) | "scott". Sigma 0 -> cadangan 5 persen
 * |rerata| (REPORT `S-03.bandwidth`). Kurva dievaluasi pada 200 titik berjarak sama di
 * [min - 2h, maks + 2h] (dipotong ke `chart.kind.S-03.axis`/alias `params.axis` bila ada); acuan memakai [min, p99].
 *
 * Grup: semua grup digambar (acuan membaca grup pertama; CHART_DATA_CONSTRAINTS hanya
 * untuk jalur paritas). Satu grup: area ink200 + kurva ink900. Beberapa grup: area ink100
 * (satu warna, tumpang tindih tidak menyembunyikan), kurva konteks (datum ink700, gallery
 * ink400), grup beraksen = kurva aksen lebih tebal; label langsung nama grup di puncak
 * kurva (tanpa kotak legenda, CH-04). Sampel < 10 nilai dilaporkan (Tabel 8.5 "hindari
 * sampel kecil").
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { kindKey } from "../core/palette";
import { linearScale } from "../core/scale";
import { num, ptToMm, textWidthMm } from "../core/svg";
import {
  type S1Ctx,
  accentGroupIndex,
  assertAccentCount,
  beginChart,
  drawXAxis,
  endChart,
  hintAxis,
  invalidParam,
  kindParam,
  pathFrom,
  pt,
  report,
  requireDistribution,
  tickLabels,
  tickWidth,
  valueDomain,
  xTickBand,
} from "./common";
import { type BandwidthRule, bandwidth, kde, linspace, sortedAsc } from "./stats";
import { fitActive } from "../core/fit";
import { placePointLabels } from "../core/labelfit";

const GRID_POINTS = 200;
const MIN_SAMPLE = 10;
/** Spine acuan PC (axes.linewidth 0,6 pt, ink400). */
const SPINE_MM = 0.6 * (25.4 / 72);

/** Aturan bandwidth dari `chart.kind.<KODE>.bandwidth` (S-03 default silverman, S-04 default scott). */
export function bandwidthRule(ctx: S1Ctx, fallback: BandwidthRule): BandwidthRule | number {
  const v = kindParam(ctx, "bandwidth");
  if (v === undefined) return fallback;
  if (v === "silverman" || v === "scott") return v;
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  throw invalidParam(ctx, kindKey(ctx.code, "bandwidth"), v, 'angka > 0 atau "silverman" | "scott"');
}

export function renderDensity(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("S-03", spec, canvas, tpl);
  const { doc, pal, W } = ctx;
  const groups = requireDistribution(ctx);
  const rule = bandwidthRule(ctx, "silverman");
  const ax = hintAxis(ctx);

  const curves = groups.map((g) => {
    const s = sortedAsc(g.values);
    if (s.length < MIN_SAMPLE) report(ctx, "S-03.sample", `grup "${g.name}" hanya ${s.length} nilai; density tidak dianjurkan untuk sampel kecil`);
    const bw = bandwidth(s, rule);
    if (bw.degenerate) report(ctx, "S-03.bandwidth", `grup "${g.name}" bersimpangan baku 0; bandwidth cadangan ${num(bw.h)}`);
    let a = s[0] - 2 * bw.h;
    let b = s[s.length - 1] + 2 * bw.h;
    if (ax) {
      a = Math.max(a, ax[0]);
      b = Math.min(b, ax[1]);
    }
    const grid = linspace(a, b, GRID_POINTS);
    return { name: g.name, grid, dens: kde(s, grid, bw.h), lo: s[0], hi: s[s.length - 1] };
  });

  const acc = accentGroupIndex(ctx, groups.map((g) => g.name));
  assertAccentCount(ctx, acc >= 0 ? 1 : 0);

  const gridLo = Math.min(...curves.map((c) => c.grid[0]));
  const gridHi = Math.max(...curves.map((c) => c.grid[c.grid.length - 1]));
  const peak = Math.max(...curves.map((c) => Math.max(...c.dens))) || 1;
  const datum = ctx.style === "datum";
  // Sumbu x bertick hanya di gaya gallery; datum mengikuti acuan PC tanpa tick (PC:865).
  const xTicks = !datum;
  const xdom = xTicks ? valueDomain(ctx, gridLo, gridHi, false) : undefined;
  const ty = pt(ctx, ctx.type.title);
  const lblPt = pt(ctx, ctx.type.label);
  const multi = curves.length > 1;

  const top = (datum ? ptToMm(ty) + 1.4 : 0.8) + (multi ? ptToMm(lblPt) + 1.0 : 0.6);
  const xTitleBand = datum && ctx.unit ? ptToMm(ty) + 1.0 : 0;
  const tickBand = xdom ? xTickBand(ctx) : 0;
  const base = ctx.bottom - tickBand - xTitleBand - 0.6;
  const labels = xdom ? tickLabels(xdom) : [];
  const x0 = Math.max(1.0, tickWidth(ctx, labels.slice(0, 1)) / 2 + 0.4);
  const x1 = W - Math.max(1.0, tickWidth(ctx, labels.slice(-1)) / 2 + 0.4);
  const span: [number, number] = xdom ? [xdom.min, xdom.max] : ax ?? [gridLo, gridHi];
  const sx = linearScale(span[0], span[1], x0, x1);
  // Kerapatan dari nol (area, CH-01); puncak tertinggi 92 persen tinggi plot.
  const sy = linearScale(0, peak / 0.92, base, top);

  if (datum) doc.text(0, ptToMm(ty) + 0.4, "kerapatan", { sizePt: ty, fill: pal.ink400, anchor: "start" });

  const areaFill = multi ? pal.ink100 : pal.role.contextBackground;
  const pts = (c: (typeof curves)[number]): Array<[number, number]> => c.grid.map((x, i) => [sx(x), sy(c.dens[i])]);
  curves.forEach((c, gi) => {
    const p = pts(c);
    const poly: Array<[number, number]> = [[p[0][0], base], ...p, [p[p.length - 1][0], base]];
    doc.path(pathFrom(poly, true, (v) => num(v)), areaFill, { mark: { mark: "area", series: c.name, index: gi } });
  });
  if (!xdom) {
    // Spine acuan tanpa tick (PC `style_ax` + `set_xticks([])`): di atas isian, di bawah kurva.
    doc.open('data-axis="y" data-spine="1"');
    doc.line(x0, top, x0, base, pal.ink400, SPINE_MM);
    doc.close();
    doc.open('data-axis="x" data-spine="1"');
    doc.line(x0, base, x1, base, pal.ink400, SPINE_MM);
    doc.close();
  }
  const context = multi ? (datum ? pal.ink700 : pal.ink400) : pal.ink900;
  curves.forEach((c, gi) => {
    const isAcc = gi === acc;
    doc.path(pathFrom(pts(c), false, (v) => num(v)), "none", {
      mark: { mark: "line", series: c.name, index: gi },
      stroke: isAcc ? pal.role.accent : context,
      strokeWidthMm: isAcc ? 0.55 : 1.2 * (25.4 / 72) * (multi ? 0.75 : 1),
    });
  });

  if (multi && fitActive()) {
    // FIG-02a P1-8: label puncak tanpa tabrakan (hanya saat fit).
    const peaks = curves.map((c) => {
      let im = 0;
      c.dens.forEach((d, i) => {
        if (d > c.dens[im]) im = i;
      });
      return { x: sx(c.grid[im]), y: sy(c.dens[im]), r: 0.4, text: c.name };
    });
    const placed = placePointLabels(peaks, { pt: lblPt }, [0.3, 0.3, W - 0.3, base]);
    placed.forEach((pl, gi) => {
      if (!pl) return;
      doc.text(pl.x, pl.y, curves[gi].name, { sizePt: lblPt, fill: gi === acc ? pal.role.accent : datum ? pal.ink700 : pal.ink400, anchor: pl.anchor, attrs: ' data-label="series"' });
    });
  } else if (multi) {
    curves.forEach((c, gi) => {
      let im = 0;
      c.dens.forEach((d, i) => {
        if (d > c.dens[im]) im = i;
      });
      const xp = sx(c.grid[im]);
      const half = textWidthMm(c.name, lblPt) / 2;
      const xc = Math.min(W - half, Math.max(half, xp));
      doc.text(xc, sy(c.dens[im]) - 1.0, c.name, {
        sizePt: lblPt,
        fill: gi === acc ? pal.role.accent : datum ? pal.ink700 : pal.ink400,
        anchor: "middle",
        attrs: ' data-label="series"',
      });
    });
  }

  if (xdom) drawXAxis(ctx, xdom, sx, base);
  if (datum && ctx.unit) doc.text(x1, base + tickBand + ptToMm(ty) + 0.4, ctx.unit, { sizePt: ty, fill: pal.ink400, anchor: "end" });
  return endChart(ctx);
}
