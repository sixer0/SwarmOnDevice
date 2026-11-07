/**
 * S-01 Histogram (S41). Acuan: pustakachart `v52_hist` (PC:844-850, kelas CB2 PARSIAL:
 * acuan memakai 24 bin literal tanpa penanda median; manual meminta 10-20 bin + median).
 *
 * Data: `distribution`, grup PERTAMA dibaca (CHART_DATA_CONSTRAINTS S-01); grup lain
 * dilaporkan REPORT `S-01.groups`.
 *
 * Aturan bin (terdokumentasi, berparameter):
 * 1. `params.binEdges` (petunjuk data, larik naik ketat >= 2 angka) -> tepi eksplisit;
 *    nilai di luar tepi tidak dihitung (REPORT);
 * 2. selain itu `chart.kind.S-01.bins` (alias pendek `bins`): bilangan bulat k -> k bin
 *    lebar sama; pasangan [min, maks] (default registri [10, 20]) -> aturan Sturges
 *    ceil(log2 n) + 1 dibatasi ke [min, maks]. k di luar [10, 20] dilaporkan (REPORT);
 * 3. bin lebar sama di [min data, maks data], bin terakhir tertutup kanan (= numpy).
 *
 * Penanda median (`chart.kind.S-01.medianMarker`, default true): garis putus-putus pada
 * median (kuantil tipe 7) berwarna aksen + label "median <nilai>" (`params.medianLabel`
 * menggantikan teks). Aksen bin lewat `accent.point` = indeks bin; bila ada, penanda
 * median memakai ink900 (maks 1 aksen).
 *
 * Gaya: datum = batang ink900 (PC), garis kisi y ink200, judul y "frekuensi", satuan di
 * ujung sumbu x; gallery = batang ink200 (konteks latar), tanpa garis kisi, tanpa teks
 * satuan (panel galeri membawa `axisNote` komposit).
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt, withUnit } from "../../bind";
import { linearScale, niceDomain } from "../core/scale";
import { num, ptToMm, textWidthMm } from "../core/svg";
import {
  type S1Ctx,
  assertAccentCount,
  accentTarget,
  beginChart,
  drawXAxis,
  drawYAxis,
  endChart,
  hint,
  hintString,
  invalidParam,
  kindBool,
  kindParam,
  pt,
  report,
  requireDistribution,
  tickLabels,
  tickWidth,
  valueDomain,
  xTickBand,
} from "./common";
import { equalEdges, histogram, quantile7, sortedAsc, sturgesBins } from "./stats";

const BIN_GAP_MM = 0.25;
const MAX_BINS = 200;
/** Rentang anjuran manual (registri S-01 bins, L1826-1827). */
const RECOMMENDED: readonly [number, number] = [10, 20];

function binCount(ctx: S1Ctx, n: number): number {
  const key = "chart.kind.S-01.bins";
  const v = kindParam(ctx, "bins");
  let k: number;
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 1 || v > MAX_BINS) throw invalidParam(ctx, key, v, `bilangan bulat 1..${MAX_BINS}`);
    k = v;
  } else if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number" && Number.isInteger(x))) {
    const lo = v[0] as number;
    const hi = v[1] as number;
    if (lo < 1 || hi < lo || hi > MAX_BINS) throw invalidParam(ctx, key, v, `pasangan bulat [min, maks] dengan 1 <= min <= maks <= ${MAX_BINS}`);
    k = Math.min(hi, Math.max(lo, sturgesBins(n)));
  } else if (v === undefined) {
    k = Math.min(RECOMMENDED[1], Math.max(RECOMMENDED[0], sturgesBins(n)));
  } else {
    throw invalidParam(ctx, key, v, "bilangan bulat atau pasangan [min, maks]");
  }
  if (k < RECOMMENDED[0] || k > RECOMMENDED[1]) report(ctx, key, `${k} bin di luar anjuran manual ${RECOMMENDED[0]}-${RECOMMENDED[1]} bin`);
  return k;
}

function explicitEdges(ctx: S1Ctx): number[] | undefined {
  const v = hint(ctx, "binEdges");
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length < 2 || v.length > MAX_BINS + 1 || !v.every((x) => typeof x === "number" && Number.isFinite(x))) {
    throw invalidParam(ctx, "params.binEdges", v, `larik 2..${MAX_BINS + 1} angka hingga`);
  }
  const e = v as number[];
  for (let i = 1; i < e.length; i++) {
    if (!(e[i] > e[i - 1])) throw invalidParam(ctx, "params.binEdges", v, "larik naik ketat");
  }
  return [...e];
}

export function renderHistogram(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const ctx = beginChart("S-01", spec, canvas, tpl);
  const { doc, pal, W } = ctx;
  const groups = requireDistribution(ctx);
  if (groups.length > 1) report(ctx, "S-01.groups", `${groups.length} grup; histogram membaca grup pertama "${groups[0].name}"`);
  const g = groups[0];
  const sorted = sortedAsc(g.values);

  const given = explicitEdges(ctx);
  let edges: number[];
  if (given) {
    edges = given;
    const v = kindParam(ctx, "bins");
    if (typeof v === "number" && v !== edges.length - 1) report(ctx, "chart.kind.S-01.bins", `bins ${v} diabaikan; params.binEdges memberi ${edges.length - 1} bin`);
  } else {
    edges = equalEdges(sorted, binCount(ctx, sorted.length));
  }
  const k = edges.length - 1;
  const hist = histogram(sorted, edges);
  if (hist.outside > 0) report(ctx, "S-01.binEdges", `${hist.outside} nilai di luar params.binEdges ${edges[0]}..${edges[k]} tidak dihitung`);

  // Aksen: indeks bin (accent.point numerik). Selain itu penanda median memegang aksen.
  const t = accentTarget(spec);
  let accentBin = -1;
  if (t !== undefined) {
    if (typeof t === "number" && t >= 0 && t < k) accentBin = t;
    else report(ctx, "ACCENT_HINT", `petunjuk aksen ${JSON.stringify(t)} bukan indeks bin 0..${k - 1}; diabaikan`);
  }
  const showMedian = kindBool(ctx, "medianMarker", true);
  const median = quantile7(sorted, 0.5);
  const medianAccent = showMedian && accentBin < 0 && ctx.maxAccent >= 1;
  assertAccentCount(ctx, (accentBin >= 0 ? 1 : 0) + (medianAccent ? 1 : 0));

  // Domain: x = tepi bin (petunjuk axis bila ada); y = frekuensi dari nol (CH-01).
  const xdom = valueDomain(ctx, edges[0], edges[k], false);
  const ydom = niceDomain(hist.counts, { zero: true, target: 4 });
  const ty = pt(ctx, ctx.type.title);
  const valPt = pt(ctx, ctx.type.value);
  const datum = ctx.style === "datum";

  const yTitleBand = datum ? ptToMm(ty) + 1.4 : 0.8;
  const medianBand = showMedian ? ptToMm(valPt) + 1.2 : 0;
  const top = yTitleBand + medianBand + 0.8;
  const xTitleBand = datum && ctx.unit ? ptToMm(ty) + 1.0 : 0;
  const base = ctx.bottom - xTickBand(ctx) - xTitleBand - 0.6;
  const x0 = tickWidth(ctx, tickLabels(ydom)) + 1.8;
  const lastTick = tickLabels(xdom).slice(-1)[0] ?? "";
  const x1 = W - Math.max(1.2, tickWidth(ctx, [lastTick]) / 2 + 0.4);
  const sx = linearScale(xdom.min, xdom.max, x0, x1);
  const sy = linearScale(ydom.min, ydom.max, base, top);

  drawYAxis(ctx, ydom, sy, x0, x1, { grid: datum, labels: true });
  if (datum) doc.text(0, ptToMm(ty) + 0.4, "frekuensi", { sizePt: ty, fill: pal.ink400, anchor: "start" });

  const fill = datum ? pal.ink900 : pal.role.contextBackground;
  for (let i = 0; i < k; i++) {
    const a = sx(edges[i]);
    const b = sx(edges[i + 1]);
    const gap = b - a > BIN_GAP_MM * 4 ? BIN_GAP_MM : 0;
    const yv = sy(hist.counts[i]);
    doc.rect(a + gap / 2, yv, b - a - gap, base - yv, i === accentBin ? pal.role.accent : fill, {
      mark: { mark: "column", series: g.name, index: i },
      attrs: ` data-count="${hist.counts[i]}"`,
    });
  }

  drawXAxis(ctx, xdom, sx, base);
  if (datum && ctx.unit) {
    doc.text(x1, base + xTickBand(ctx) + ptToMm(ty) + 0.4, ctx.unit, { sizePt: ty, fill: pal.ink400, anchor: "end" });
  }

  if (showMedian) {
    const xm = sx(median);
    const colour = medianAccent ? pal.role.accent : pal.role.textAxis;
    doc.line(xm, top - 0.4, xm, base, colour, 0.35, { mark: { mark: "segment", series: "median", index: 0 }, dashMm: [1.2, 0.9] });
    const label = hintString(ctx, "medianLabel") ?? `median ${withUnit(fmt(median, ctx.dec), ctx.unit)}`;
    const right = xm + 0.8 + textWidthMm(label, valPt) <= W;
    doc.text(right ? xm + 0.8 : xm - 0.8, top - 1.0, label, {
      sizePt: valPt,
      fill: colour,
      anchor: right ? "start" : "end",
      attrs: ` data-label="value" data-median="${num(median)}"`,
    });
  }

  return endChart(ctx);
}
