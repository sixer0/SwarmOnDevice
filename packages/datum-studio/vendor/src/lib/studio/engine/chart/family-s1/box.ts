/**
 * S-02 Box plot (S41). Acuan: pustakachart `v54_box` (PC:871-882, kelas CB1 PENUH),
 * `ax.boxplot` matplotlib: kuartil = `numpy.percentile` linier (tipe 7), kumis = data
 * terjauh di dalam 1,5 IQR, pencilan = di luar (lihat stats.ts). Lebar kotak 0,5 slot
 * grup, tutup kumis 0,5 lebar kotak (default matplotlib).
 *
 * Parameter registri: `median` (garis median), `box50` (kotak 50 persen tengah; false =
 * hanya garis rentang kumis), `outlierPoints` (titik pencilan; false = kumis sampai
 * min/maks agar tidak ada data yang hilang tanpa jejak), `whisker` = pengali IQR (> 0,
 * default 1,5; ParamDef mesin IP-25). `chart.kind.S-02.axis` (alias `params.axis`) = domain sumbu nilai.
 *
 * Aksen: grup beraksen (`accent.group`/`point`/`series` atau alias) -> kotak berwarna
 * aksen, median kertas. Tanpa petunjuk: satu grup -> median beraksen (seperti acuan);
 * lebih dari satu grup -> tanpa aksen (acuan mewarnai SEMUA median signal; DATUM-26
 * membatasi 1 subjek).
 *
 * Gaya: datum = kotak ink100 bertepi ink700 0,8 pt, kumis ink700, pencilan ink400,
 * garis kisi y; gallery = kotak ink200 tanpa tepi, kumis ink400, tanpa garis kisi.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { kindKey } from "../core/palette";
import { linearScale } from "../core/scale";
import { ptToMm } from "../core/svg";
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
  invalidParam,
  kindBool,
  kindParam,
  pt,
  requireDistribution,
  tickLabels,
  tickWidth,
  valueDomain,
} from "./common";
import { boxStats } from "./stats";

export function renderBox(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("S-02", spec, canvas, tpl);
  const { doc, pal, W } = ctx;
  const groups = requireDistribution(ctx);
  const showMedian = kindBool(ctx, "median", true);
  const showBox = kindBool(ctx, "box50", true);
  const showOutliers = kindBool(ctx, "outlierPoints", true);
  const wh = kindParam(ctx, "whisker");
  if (wh !== undefined && !(typeof wh === "number" && Number.isFinite(wh) && wh > 0)) throw invalidParam(ctx, kindKey("S-02", "whisker"), wh, "angka > 0");
  const k = showOutliers ? ((wh as number | undefined) ?? 1.5) : Infinity;
  const stats = groups.map((g) => boxStats(g.values, k));

  const acc = accentGroupIndex(ctx, groups.map((g) => g.name));
  const medianAccentGroup = acc < 0 && groups.length === 1 && showMedian && ctx.maxAccent >= 1 ? 0 : -1;
  assertAccentCount(ctx, acc >= 0 || medianAccentGroup >= 0 ? 1 : 0);

  const lo = Math.min(...stats.map((s) => s.min));
  const hi = Math.max(...stats.map((s) => s.max));
  const dom = valueDomain(ctx, lo, hi, false);
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
  const bw = Math.min(slot * 0.5, 14);

  drawYAxis(ctx, dom, sy, x0, x1, { grid: datum, labels: true });
  if (datum && ctx.unit) doc.text(0, ptToMm(ty) + 0.4, ctx.unit, { sizePt: ty, fill: pal.ink400, anchor: "start" });

  const whiskerInk = datum ? pal.ink700 : pal.ink400;
  stats.forEach((s, gi) => {
    const name = groups[gi].name;
    const cx = x0 + slot * (gi + 0.5);
    const mark = (m: "box" | "whisker" | "segment" | "point") => ({ mark: m, series: name, index: gi });
    const isAcc = gi === acc;
    const yq1 = sy(s.q1);
    const yq3 = sy(s.q3);
    if (showBox) {
      doc.line(cx, sy(s.whiskerLo), cx, yq1, whiskerInk, HAIR_MM, { mark: mark("whisker") });
      doc.line(cx, yq3, cx, sy(s.whiskerHi), whiskerInk, HAIR_MM, { mark: mark("whisker") });
    } else {
      doc.line(cx, sy(s.whiskerLo), cx, sy(s.whiskerHi), whiskerInk, HAIR_MM, { mark: mark("whisker") });
    }
    doc.line(cx - bw / 4, sy(s.whiskerLo), cx + bw / 4, sy(s.whiskerLo), whiskerInk, HAIR_MM, { mark: mark("whisker") });
    doc.line(cx - bw / 4, sy(s.whiskerHi), cx + bw / 4, sy(s.whiskerHi), whiskerInk, HAIR_MM, { mark: mark("whisker") });
    if (showBox) {
      const face = isAcc ? pal.role.accent : datum ? pal.ink100 : pal.role.contextBackground;
      doc.rect(cx - bw / 2, yq3, bw, yq1 - yq3, face, {
        mark: mark("box"),
        ...(datum ? { stroke: isAcc ? pal.role.accent : pal.ink700, strokeWidthMm: EDGE_MM } : {}),
      });
    }
    if (showMedian) {
      const colour = isAcc ? (showBox ? pal.paper : pal.role.accent) : gi === medianAccentGroup ? pal.role.accent : pal.ink900;
      const half = showBox ? bw / 2 : bw / 4;
      doc.line(cx - half, sy(s.median), cx + half, sy(s.median), colour, MEDIAN_MM, { mark: mark("segment"), attrs: ' data-stat="median"' });
    }
    if (showOutliers) {
      for (const v of s.outliers) doc.circle(cx, sy(v), 0.45, datum ? pal.ink400 : pal.ink700, { mark: mark("point"), attrs: ' data-stat="outlier"' });
    }
    groupLabel(ctx, cx, base, name, lp, gi);
  });

  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, pal.role.textAxis, HAIR_MM);
  doc.close();
  return endChart(ctx);
}
