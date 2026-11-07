/**
 * S-04 Violin (S41). Acuan: pustakachart `v55_violin` (PC:884-896, kelas CB1 PENUH):
 * `violinplot(widths=0.7, showextrema=False)` matplotlib = KDE Gaussian bandwidth Scott
 * sigma(ddof 1) n^(-1/5), 100 titik dari min ke maks grup, lebar dinormalkan ke kerapatan
 * maksimum grup itu; badan ink100 bertepi ink700 0,8 pt; batang kuartil Q1-Q3 ink700
 * 6 pt; tick median 12 pt signal.
 *
 * Bandwidth berparameter: `chart.kind.S-04.bandwidth` (ParamDef mesin IP-25) = angka > 0 | "scott" (default) |
 * "silverman" (lihat density.ts). Kuartil = tipe 7 (stats.ts). Petunjuk
 * `params.medianTick` (default true) menyalakan tick median. `chart.kind.S-04.axis` (alias `params.axis`) = domain.
 * Acuan memakai tepat 3 grup (CHART_DATA_CONSTRAINTS, jalur paritas); mesin menerima >= 1.
 *
 * Aksen: grup beraksen -> badan aksen, batang kuartil ink900, tick median kertas. Tanpa
 * petunjuk: satu grup -> tick median aksen (acuan); beberapa grup -> tick ink900
 * (DATUM-26: maks 1 subjek; acuan mewarnai semua median signal).
 *
 * Gaya: datum = seperti acuan + garis kisi y ink200; gallery = badan ink200 tanpa tepi,
 * batang kuartil ink400, tanpa garis kisi.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { linearScale } from "../core/scale";
import { num, ptToMm } from "../core/svg";
import {
  EDGE_MM,
  HAIR_MM,
  MEDIAN_MM,
  accentGroupIndex,
  assertAccentCount,
  beginChart,
  drawYAxis,
  endChart,
  groupAxisPlan,
  groupLabel,
  hintBool,
  pathFrom,
  pt,
  report,
  requireDistribution,
  tickLabels,
  tickWidth,
  valueDomain,
} from "./common";
import { bandwidthRule } from "./density";
import { bandwidth, kde, linspace, quantile7, sortedAsc } from "./stats";

const POINTS = 100;
const PT_MM = 25.4 / 72;

export function renderViolin(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("S-04", spec, canvas, tpl);
  const { doc, pal, W } = ctx;
  const groups = requireDistribution(ctx);
  const rule = bandwidthRule(ctx, "scott");
  const showMedian = hintBool(ctx, "medianTick", true);

  const shapes = groups.map((g) => {
    const s = sortedAsc(g.values);
    const bw = bandwidth(s, rule);
    if (bw.degenerate) report(ctx, "S-04.bandwidth", `grup "${g.name}" bersimpangan baku 0; bandwidth cadangan ${num(bw.h)}`);
    const grid = s[0] === s[s.length - 1] ? [s[0]] : linspace(s[0], s[s.length - 1], POINTS);
    const dens = kde(s, grid, bw.h);
    const peak = Math.max(...dens) || 1;
    return { grid, rel: dens.map((d) => d / peak), q1: quantile7(s, 0.25), median: quantile7(s, 0.5), q3: quantile7(s, 0.75), lo: s[0], hi: s[s.length - 1] };
  });

  const acc = accentGroupIndex(ctx, groups.map((g) => g.name));
  const medianAccentGroup = acc < 0 && groups.length === 1 && showMedian && ctx.maxAccent >= 1 ? 0 : -1;
  assertAccentCount(ctx, acc >= 0 || medianAccentGroup >= 0 ? 1 : 0);

  const dom = valueDomain(ctx, Math.min(...shapes.map((s) => s.lo)), Math.max(...shapes.map((s) => s.hi)), false);
  const datum = ctx.style === "datum";
  const ty = pt(ctx, ctx.type.title);
  const labelPt = pt(ctx, ctx.type.label);

  const top = (datum && ctx.unit ? ptToMm(ty) + 1.4 : 0) + ptToMm(pt(ctx, ctx.type.tick)) * 0.5 + 0.8;
  const x0 = tickWidth(ctx, tickLabels(dom)) + 1.8;
  const x1 = W - 0.8;
  const lp = groupAxisPlan(ctx, groups.map((g) => g.name), x0, x1);
  const base = ctx.bottom - ptToMm(labelPt) - 2.2 - (lp?.extraBandMm ?? 0);
  const sy = linearScale(dom.min, dom.max, base, top);
  const slot = (x1 - x0) / groups.length;
  const half = Math.min(slot * 0.35, 12);
  const barW = Math.min(6 * PT_MM, half * 0.6);
  const tickHalf = Math.min(6 * PT_MM, half * 0.9);

  drawYAxis(ctx, dom, sy, x0, x1, { grid: datum, labels: true });
  if (datum && ctx.unit) doc.text(0, ptToMm(ty) + 0.4, ctx.unit, { sizePt: ty, fill: pal.ink400, anchor: "start" });

  shapes.forEach((s, gi) => {
    const name = groups[gi].name;
    const cx = x0 + slot * (gi + 0.5);
    const isAcc = gi === acc;
    const mark = (m: "area" | "box" | "segment") => ({ mark: m, series: name, index: gi });
    if (s.grid.length > 1) {
      const right: Array<[number, number]> = s.grid.map((v, i) => [cx + half * s.rel[i], sy(v)]);
      const left: Array<[number, number]> = s.grid.map((v, i) => [cx - half * s.rel[i], sy(v)] as [number, number]).reverse();
      const face = isAcc ? pal.role.accent : datum ? pal.ink100 : pal.role.contextBackground;
      doc.path(pathFrom([...right, ...left], true, (v) => num(v)), face, {
        mark: mark("area"),
        ...(datum ? { stroke: isAcc ? pal.role.accent : pal.ink700, strokeWidthMm: EDGE_MM } : {}),
      });
    } else {
      report(ctx, "S-04.shape", `grup "${name}" tanpa sebaran (semua nilai sama); badan violin diganti garis`);
      doc.line(cx - half, sy(s.lo), cx + half, sy(s.lo), isAcc ? pal.role.accent : pal.ink700, HAIR_MM, { mark: mark("area") });
    }
    const barInk = isAcc ? pal.ink900 : datum ? pal.ink700 : pal.ink400;
    doc.rect(cx - barW / 2, sy(s.q3), barW, sy(s.q1) - sy(s.q3), barInk, { mark: mark("box"), attrs: ' data-stat="iqr"' });
    if (showMedian) {
      const colour = isAcc ? pal.paper : gi === medianAccentGroup ? pal.role.accent : pal.ink900;
      doc.line(cx - tickHalf, sy(s.median), cx + tickHalf, sy(s.median), colour, MEDIAN_MM, { mark: mark("segment"), attrs: ' data-stat="median"' });
    }
    groupLabel(ctx, cx, base, name, lp, gi);
  });

  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.role.textAxis, HAIR_MM);
  doc.close();
  return endChart(ctx);
}
