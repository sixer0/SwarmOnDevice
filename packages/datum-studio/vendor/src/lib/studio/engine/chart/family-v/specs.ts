/**
 * Swarm addition (row 163, U24 C; security C2, C7): Studio builds every Vega-Lite / Vega spec from the
 * validated, typed agent input (./input). Agent strings only ever appear as DATA VALUES (`values` rows) or as
 * literal text that Vega draws; never as field names, expressions, sort arrays, colours or fonts.
 * Geometry that Vega-Lite has no native mark for (calendar cells, radar polygons, parallel axes, polar labels)
 * is computed here in millimetres and drawn with `scale: null` positions. The few expression strings in the Vega
 * specs (V-07 label placement and filtering) are Studio template constants that reference precomputed fields.
 *
 * Capacity (U24 B, row 158 code FIGURE_OVER_CAPACITY): each builder refuses input it cannot draw cleanly with
 * the measured quantity, the limit and a concrete suggestion, instead of squeezing.
 */
import { fmt, withUnit, type NumberLanguage } from "../../bind/format";
import { ChartOverCapacity } from "../../figure-capacity";
import { measure } from "../core/textfit";
import type {
  CalendarInput,
  EcdfInput,
  ParallelInput,
  PartitionInput,
  PolarAreaInput,
  RadarInput,
  StreamInput,
  TreeInput,
  VegaChartInput,
} from "./input";
import { hierarchyCheck } from "./input";
import { LABEL_PT, SMALL_PT, STROKE, type VegaTheme, mmOfPt, u, uPt, vgConfig, vlConfig } from "./theme";
import { VEGA_FONT_DATA, VEGA_FONT_STRUCT } from "./sandbox";

export interface BuiltSpec {
  engine: "vega-lite" | "vega";
  spec: Record<string, unknown>;
  /** Plot height in mm (the Vega view); the figure apparatus is added below it. */
  plotHeightMm: number;
}

export interface BuildCtx {
  th: VegaTheme;
  widthMm: number;
  /** Largest plot height that still fits the text block with the apparatus band (mm). */
  maxPlotMm: number;
  /** Plot height asked for by the agent (heightMm minus apparatus), if any. */
  askedPlotMm?: number;
  lang: NumberLanguage;
}

/** Font sizes in Vega units (1/10 mm); geometry below is computed in mm and emitted with `u()`. */
const L = uPt(LABEL_PT);
const S = uPt(SMALL_PT);
const textW = (s: string, pt = LABEL_PT, face: "struct" | "data" = "struct") => measure(s, pt, face);
const round = (v: number) => Math.round(v * 1000) / 1000;

function over(kind: string, base: string, d: { quantity: string; unit: string; limit: number; measured: number; suggestion: string; checkId?: string }): ChartOverCapacity {
  return new ChartOverCapacity(`[${d.checkId ?? `CAPACITY-${kind}`}] ${base}`, { checkId: d.checkId ?? `CAPACITY-${kind}`, family: kind, quantity: d.quantity, unit: d.unit, limit: d.limit, measured: d.measured, suggestion: d.suggestion });
}

function capCount(kind: string, what: string, unit: string, n: number, max: number, suggestion: string): void {
  if (n > max) throw over(kind, `${n} ${unit} melebihi kapasitas ${kind} (${max})`, { quantity: what, unit, limit: max, measured: n, suggestion });
}

function plotHeight(ctx: BuildCtx, kind: string, wanted: number): number {
  const h = round(ctx.askedPlotMm ?? wanted);
  if (h > ctx.maxPlotMm + 1e-9) {
    throw over(kind, `tinggi plot ${h.toFixed(1)} mm melampaui blok teks`, {
      checkId: "DATUM-33",
      quantity: "tinggi plot",
      unit: "mm",
      limit: round(ctx.maxPlotMm),
      measured: h,
      suggestion: "kurangi butir data atau pisah menjadi dua gambar",
    });
  }
  return h;
}

const num = (v: number, dec: number, ctx: BuildCtx, unit?: string) => (unit ? withUnit(fmt(v, dec, ctx.lang), unit, ctx.lang) : fmt(v, dec, ctx.lang));

function vl(ctx: BuildCtx, plotH: number, body: Record<string, unknown>, autosize: "fit" | "none" = "fit"): BuiltSpec {
  return {
    engine: "vega-lite",
    plotHeightMm: plotH,
    spec: {
      width: u(ctx.widthMm),
      height: u(plotH),
      padding: 0,
      autosize: autosize === "fit" ? { type: "fit", contains: "padding" } : { type: "none" },
      config: vlConfig(ctx.th),
      ...body,
    },
  };
}

/** Identity-position channel in mm (Vega-Lite `scale: null`). */
const mm = (field: string) => ({ field, type: "quantitative", scale: null });

// ── V-01 calendar heatmap ───────────────────────────────────────────────
const DAY_MS = 86_400_000;
const MONTHS: Record<"id" | "en", string[]> = {
  id: ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"],
  en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
};
const DAYS: Record<"id" | "en", string[]> = {
  // Monday first.
  id: ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};

function calendar(input: CalendarInput, ctx: BuildCtx, dec: number): BuiltSpec {
  const K = "V-01";
  const days = [...input.data.days].map((d) => ({ t: Date.parse(`${d.date}T00:00:00Z`), date: d.date, v: d.value })).sort((a, b) => a.t - b.t);
  const span = Math.round((days[days.length - 1].t - days[0].t) / DAY_MS) + 1;
  capCount(K, "rentang hari", "hari", span, 371, "pisah per tahun (satu gambar per 12 bulan)");
  const monday = (input.options?.weekStart ?? "monday") === "monday";
  const dow = (t: number) => (monday ? (new Date(t).getUTCDay() + 6) % 7 : new Date(t).getUTCDay());
  const start = days[0].t - dow(days[0].t) * DAY_MS;
  const week = (t: number) => Math.floor((t - start) / (7 * DAY_MS));
  const weeks = week(days[days.length - 1].t) + 1;
  const lang = ctx.th.lang;
  const dayNames = monday ? DAYS[lang] : [DAYS[lang][6], ...DAYS[lang].slice(0, 6)];
  const shownRows = monday ? [0, 2, 4] : [1, 3, 5];
  const labelW = Math.max(...shownRows.map((r) => textW(dayNames[r], SMALL_PT))) + 1.2;
  const cell = Math.min(3.6, (ctx.widthMm - labelW) / weeks);
  if (cell < 2.0) throw over(K, `sel ${cell.toFixed(2)} mm terlalu kecil`, { quantity: "minggu", unit: "minggu", limit: Math.floor((ctx.widthMm - labelW) / 2.0), measured: weeks, suggestion: "pisah per semester atau pakai lebar 166 mm" });
  const top = 3.6;
  const gridBottom = top + 7 * cell;
  const plotH = plotHeight(ctx, K, gridBottom + 8.4);
  const gap = Math.min(0.4, cell * 0.12);
  const accent = input.accent?.point;
  const cells = days.map((d) => {
    const x = labelW + week(d.t) * cell;
    const y = top + dow(d.t) * cell;
    return { x: u(x), x2: u(x + cell - gap), y: u(y), y2: u(y + cell - gap), v: d.v, acc: d.date === accent };
  });
  // Month labels at the week of each month's first shown day; skipped when they would touch the previous one.
  const months: Array<{ x: number; y: number; t: string }> = [];
  let lastEnd = -Infinity;
  for (const d of days) {
    const date = new Date(d.t);
    const first = months.length === 0 || date.getUTCDate() === 1;
    if (!first) continue;
    const t = MONTHS[lang][date.getUTCMonth()];
    const x = labelW + week(d.t) * cell;
    if (x < lastEnd + 1) continue;
    months.push({ x: u(x), y: u(top - 0.9), t });
    lastEnd = x + textW(t, SMALL_PT);
  }
  const rows = shownRows.map((r) => ({ x: u(labelW - 1.2), y: u(top + r * cell + cell / 2), t: dayNames[r] }));
  const ramp = [ctx.th.ink200, ctx.th.ink400, ctx.th.ink700, ctx.th.ink900];
  const layer: Record<string, unknown>[] = [
    {
      data: { values: cells },
      mark: { type: "rect" },
      encoding: {
        x: mm("x"),
        x2: { field: "x2" },
        y: mm("y"),
        y2: { field: "y2" },
        color: {
          field: "v",
          type: "quantitative",
          scale: { type: "quantize", range: ramp, nice: true },
          legend: { orient: "none", legendX: u(labelW), legendY: u(gridBottom + 2.6), direction: "horizontal", format: `,.${dec}f`, title: input.unit ?? null, titleOrient: "left", titlePadding: u(1.6) },
        },
      },
    },
    { data: { values: months }, mark: { type: "text", align: "left", baseline: "bottom", fontSize: S, color: ctx.th.ink700 }, encoding: { x: mm("x"), y: mm("y"), text: { field: "t" } } },
    { data: { values: rows }, mark: { type: "text", align: "right", baseline: "middle", fontSize: S, color: ctx.th.ink700 }, encoding: { x: mm("x"), y: mm("y"), text: { field: "t" } } },
  ];
  if (accent !== undefined && cells.some((c) => c.acc)) {
    layer.push({
      data: { values: cells.filter((c) => c.acc) },
      mark: { type: "rect", fill: null, filled: false, stroke: ctx.th.accent, strokeWidth: u(STROKE.accentLine) },
      encoding: { x: mm("x"), x2: { field: "x2" }, y: mm("y"), y2: { field: "y2" } },
    });
  }
  return vl(ctx, plotH, { layer }, "none");
}

// ── V-02 streamgraph ────────────────────────────────────────────────────
function streamgraph(input: StreamInput, ctx: BuildCtx): BuiltSpec {
  const K = "V-02";
  const { categories, series } = input.data;
  capCount(K, "seri", "seri", series.length, 4, "gabungkan seri kecil menjadi \"Lainnya\" (maks 4 seri, batas 5 peran warna)");
  capCount(K, "titik waktu", "titik", categories.length, 60, "agregasi ke periode lebih kasar (maks 60 titik)");
  if (series.length < 2) throw over(K, "streamgraph butuh >= 2 seri", { quantity: "seri", unit: "seri", limit: 2, measured: series.length, suggestion: "pakai garis W-01 untuk satu seri" });
  const names = series.map((s) => s.name);
  const colours = ctx.th.series(names, input.accent?.series);
  const values = categories.flatMap((c, ci) => series.map((s, si) => ({ c, ci, s: s.name, si, v: s.values[ci] })));
  const plotH = plotHeight(ctx, K, round(ctx.widthMm * 0.42));
  return vl(ctx, plotH, {
    data: { values },
    mark: { type: "area", interpolate: "monotone", stroke: ctx.th.paper, strokeWidth: u(STROKE.sep) },
    encoding: {
      x: { field: "c", type: "ordinal", sort: { field: "ci", op: "min" }, scale: { type: "point", padding: 0 }, axis: { title: null, domain: true, ticks: true } },
      y: { field: "v", type: "quantitative", stack: input.options?.offset ?? "center", axis: null },
      color: { field: "s", type: "nominal", sort: null, scale: { domain: names, range: colours }, legend: { title: null } },
      order: { field: "si", type: "quantitative" },
    },
  });
}

// ── V-03 parallel coordinates ───────────────────────────────────────────
function parallel(input: ParallelInput, ctx: BuildCtx, dec: number): BuiltSpec {
  const K = "V-03";
  const { rows, cols, values } = input.data;
  capCount(K, "dimensi", "dimensi", cols.length, 8, "pilih maks 8 dimensi terpenting atau pisah menjadi dua gambar");
  if (cols.length < 3) throw over(K, "koordinat paralel butuh >= 3 dimensi", { quantity: "dimensi", unit: "dimensi", limit: 3, measured: cols.length, suggestion: "pakai scatter H-01 untuk 2 dimensi" });
  capCount(K, "baris", "baris", rows.length, 200, "sampel atau agregasi ke maks 200 baris");
  const accent = input.accent?.point;
  const ext = cols.map((_, k) => {
    const col = values.map((r) => r[k]);
    let lo = Math.min(...col);
    let hi = Math.max(...col);
    if (hi === lo) hi = lo + 1;
    return { lo, hi };
  });
  const order = rows.map((r, i) => ({ r, i })).sort((a, b) => Number(a.r === accent) - Number(b.r === accent));
  const lines = order.flatMap(({ r, i }) => cols.map((k, ki) => ({ r, k, ki, y: round((values[i][ki] - ext[ki].lo) / (ext[ki].hi - ext[ki].lo)), g: r === accent ? "a" : "c" })));
  const dims = cols.map((k, ki) => ({ k, ki, y0: 0, y1: 1 }));
  const tops = cols.map((k, ki) => ({ k, ki, y: 1, t: num(ext[ki].hi, dec, ctx) }));
  const bottoms = cols.map((k, ki) => ({ k, ki, y: 0, t: num(ext[ki].lo, dec, ctx) }));
  const x = { field: "k", type: "ordinal", sort: { field: "ki", op: "min" }, scale: { type: "point", padding: 0.35 }, axis: { title: null, domain: false, ticks: false, labelPadding: u(mmOfPt(SMALL_PT) + 2.4), orient: "bottom" } };
  const y = (field: string) => ({ field, type: "quantitative", scale: { domain: [0, 1], nice: false, zero: false }, axis: null });
  const plotH = plotHeight(ctx, K, round(ctx.widthMm * 0.5));
  const layer: Record<string, unknown>[] = [
    { data: { values: dims }, mark: { type: "rule", color: ctx.th.ink400, strokeWidth: u(STROKE.axis) }, encoding: { x, y: y("y0"), y2: { field: "y1" } } },
    // Context rows first, the accent row (if any) last and thicker.
    ...[
      { g: "c", color: ctx.th.ink400, w: STROKE.grid },
      { g: "a", color: ctx.th.accent, w: STROKE.accentLine },
    ]
      .filter((l) => lines.some((p) => p.g === l.g))
      .map((l) => ({
        data: { values: lines.filter((p) => p.g === l.g) },
        mark: { type: "line", color: l.color, strokeWidth: u(l.w), strokeCap: "round", strokeJoin: "round" },
        encoding: { x, y: y("y"), detail: { field: "r", type: "nominal" }, order: { field: "ki", type: "quantitative" } },
      })),
    { data: { values: tops }, mark: { type: "text", baseline: "bottom", dy: u(-0.8), font: VEGA_FONT_DATA, fontSize: S, color: ctx.th.ink700 }, encoding: { x, y: y("y"), text: { field: "t" } } },
    { data: { values: bottoms }, mark: { type: "text", baseline: "top", dy: u(0.8), font: VEGA_FONT_DATA, fontSize: S, color: ctx.th.ink700 }, encoding: { x, y: y("y"), text: { field: "t" } } },
  ];
  if (accent !== undefined && rows.includes(accent)) {
    const i = rows.indexOf(accent);
    const last = cols.length - 1;
    layer.push({
      data: { values: [{ k: cols[last], ki: last, y: round((values[i][last] - ext[last].lo) / (ext[last].hi - ext[last].lo)), t: accent }] },
      mark: { type: "text", align: "left", baseline: "middle", dx: u(1.2), fontSize: L, color: ctx.th.accent },
      encoding: { x, y: y("y"), text: { field: "t" } },
    });
  }
  return vl(ctx, plotH, { layer });
}

// ── V-04 ECDF ───────────────────────────────────────────────────────────
function ecdf(input: EcdfInput, ctx: BuildCtx, dec: number): BuiltSpec {
  const K = "V-04";
  const groups = input.data.groups;
  capCount(K, "grup", "grup", groups.length, 4, "gabungkan grup atau pisah menjadi dua gambar (maks 4 grup, batas 5 peran warna)");
  const names = groups.map((g) => g.name);
  const colours = ctx.th.series(names, input.accent?.group);
  const values = groups.flatMap((g, gi) => {
    const v = [...g.values].sort((a, b) => a - b);
    const n = v.length;
    return [{ g: g.name, gi, x: v[0], y: 0 }, ...v.map((x, i) => ({ g: g.name, gi, x, y: round((i + 1) / n) }))];
  });
  const plotH = plotHeight(ctx, K, round(ctx.widthMm * 0.42));
  return vl(ctx, plotH, {
    data: { values },
    mark: { type: "line", interpolate: "step-after", strokeWidth: u(STROKE.line) },
    encoding: {
      x: { field: "x", type: "quantitative", scale: { zero: false, nice: true }, axis: { title: input.unit ?? null, format: `,.${dec}f` } },
      y: { field: "y", type: "quantitative", scale: { domain: [0, 1], nice: false }, axis: { title: null, format: ".0%", grid: true, values: [0, 0.25, 0.5, 0.75, 1], domain: false, ticks: false } },
      color: { field: "g", type: "nominal", sort: null, scale: { domain: names, range: colours }, legend: groups.length > 1 ? { title: null } : null },
      detail: { field: "g", type: "nominal" },
      order: { field: "gi", type: "quantitative" },
    },
  });
}

// ── V-05 polar area (rose) ──────────────────────────────────────────────
function polarArea(input: PolarAreaInput, ctx: BuildCtx, dec: number): BuiltSpec {
  const K = "V-05";
  const pts = input.data.points;
  capCount(K, "kategori", "kategori", pts.length, 16, "gabungkan kategori kecil menjadi \"Lainnya\" atau pakai batang P-01");
  if (pts.length < 3) throw over(K, "polar area butuh >= 3 kategori", { quantity: "kategori", unit: "kategori", limit: 3, measured: pts.length, suggestion: "pakai batang P-01" });
  const accent = input.accent?.point;
  const labels = pts.map((p) => `${p.label}  ${num(p.value, dec, ctx, input.unit)}`);
  const labW = Math.max(...labels.map((l) => textW(l)));
  const plotH = plotHeight(ctx, K, round(Math.min(ctx.widthMm * 0.62, 100)));
  const R = Math.min(plotH / 2 - 3.2, ctx.widthMm / 2 - labW - 3);
  if (R < 14) throw over(K, `jari-jari ${R.toFixed(1)} mm terlalu kecil untuk label`, { checkId: "CAPACITY-LABELS", quantity: "lebar label terpanjang", unit: "mm", limit: round(ctx.widthMm / 2 - 17), measured: round(labW), suggestion: "persingkat label kategori atau pakai lebar 166 mm" });
  const cx = ctx.widthMm / 2;
  const cy = plotH / 2;
  const n = pts.length;
  // Equal angles, computed here (Vega-Lite stacks theta per radius value, which would draw full circles).
  const wedges = pts.map((p, i) => ({ i, a0: round((i * 2 * Math.PI) / n), a1: round(((i + 1) * 2 * Math.PI) / n), v: p.value, g: p.accent || p.label === accent ? "a" : "c" }));
  const text = pts.map((p, i) => {
    const a = ((i + 0.5) * 2 * Math.PI) / n;
    const sx = Math.sin(a);
    return {
      x: u(cx + (R + 2) * sx),
      y: u(cy - (R + 2) * Math.cos(a)),
      t: labels[i],
      al: Math.abs(sx) < 0.15 ? "center" : sx > 0 ? "left" : "right",
      g: wedges[i].g,
    };
  });
  return vl(
    ctx,
    plotH,
    {
      layer: [
        {
          data: { values: wedges },
          mark: { type: "arc", stroke: ctx.th.paper, strokeWidth: u(STROKE.sep) },
          encoding: {
            theta: { field: "a0", type: "quantitative", scale: null },
            theta2: { field: "a1" },
            radius: { field: "v", type: "quantitative", scale: { type: "sqrt", zero: true, range: [0, u(R)] } },
            color: { field: "g", type: "nominal", scale: { domain: ["c", "a"], range: [ctx.th.ink400, ctx.th.accent] }, legend: null },
            order: { field: "i", type: "quantitative" },
          },
        },
        ...(["left", "right", "center"] as const).map((al) => ({
          data: { values: text.filter((t) => t.al === al) },
          mark: { type: "text", align: al, baseline: "middle", fontSize: L, color: ctx.th.ink900 },
          encoding: { x: mm("x"), y: mm("y"), text: { field: "t" } },
        })),
      ],
    },
    "none",
  );
}

// ── V-06 radar ──────────────────────────────────────────────────────────
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v - 1e-12) return m * p;
  return 10 * p;
}

function radar(input: RadarInput, ctx: BuildCtx, dec: number): BuiltSpec {
  const K = "V-06";
  const { categories: axes, series } = input.data;
  capCount(K, "sumbu", "sumbu", axes.length, 12, "kurangi sumbu (maks 12) atau pakai batang berkelompok P-03");
  if (axes.length < 3) throw over(K, "radar butuh >= 3 sumbu", { quantity: "sumbu", unit: "sumbu", limit: 3, measured: axes.length, suggestion: "pakai batang P-01" });
  capCount(K, "seri", "seri", series.length, 3, "maks 3 profil per radar; pisah menjadi beberapa gambar");
  if (series.some((s) => s.values.some((v) => v < 0))) throw over(K, "radar butuh nilai >= 0", { quantity: "nilai negatif", unit: "nilai", limit: 0, measured: 1, suggestion: "geser skala ke >= 0 atau pakai batang P-01" });
  const max = input.options?.max ?? niceMax(Math.max(...series.flatMap((s) => s.values)));
  const names = series.map((s) => s.name);
  const colours = ctx.th.series(names, input.accent?.series);
  const labW = Math.max(...axes.map((a) => textW(a)));
  const legendH = series.length > 1 ? 6 : 0;
  const plotH = plotHeight(ctx, K, round(Math.min(ctx.widthMm * 0.62, 100) + legendH));
  const R = Math.min((plotH - legendH) / 2 - 3.6, ctx.widthMm / 2 - labW - 3);
  if (R < 14) throw over(K, `jari-jari ${R.toFixed(1)} mm terlalu kecil untuk label`, { checkId: "CAPACITY-LABELS", quantity: "lebar label sumbu terpanjang", unit: "mm", limit: round(ctx.widthMm / 2 - 17), measured: round(labW), suggestion: "persingkat nama sumbu atau pakai lebar 166 mm" });
  const cx = ctx.widthMm / 2;
  const cy = (plotH - legendH) / 2;
  const n = axes.length;
  const at = (k: number, r: number) => {
    const a = (k * 2 * Math.PI) / n;
    return { x: u(cx + r * Math.sin(a)), y: u(cy - r * Math.cos(a)), sin: Math.sin(a) };
  };
  const rings = [0.25, 0.5, 0.75, 1].flatMap((f, ri) =>
    Array.from({ length: n + 1 }, (_, k) => {
      const p = at(k % n, R * f);
      return { ring: ri, o: k, x: p.x, y: p.y };
    }),
  );
  const spokes = axes.map((_, k) => {
    const p = at(k, R);
    return { x: u(cx), y: u(cy), x2: p.x, y2: p.y };
  });
  const lines = series.flatMap((s, si) => Array.from({ length: n + 1 }, (_, k) => {
    const p = at(k % n, (R * Math.min(s.values[k % n], max)) / max);
    return { s: s.name, si, o: k, x: p.x, y: p.y };
  }));
  const labels = axes.map((a, k) => {
    const p = at(k, R + 2);
    return { x: p.x, y: p.y, t: a, al: Math.abs(p.sin) < 0.15 ? "center" : p.sin > 0 ? "left" : "right" };
  });
  const colour = { field: "s", type: "nominal", sort: null, scale: { domain: names, range: colours } };
  const layer: Record<string, unknown>[] = [
    { data: { values: rings }, mark: { type: "line", color: ctx.th.ink200, strokeWidth: u(STROKE.grid) }, encoding: { x: mm("x"), y: mm("y"), detail: { field: "ring", type: "nominal" }, order: { field: "o", type: "quantitative" } } },
    { data: { values: spokes }, mark: { type: "rule", color: ctx.th.ink200, strokeWidth: u(STROKE.grid) }, encoding: { x: mm("x"), y: mm("y"), x2: { field: "x2" }, y2: { field: "y2" } } },
    {
      data: { values: lines },
      mark: { type: "line", strokeWidth: u(STROKE.accentLine), strokeJoin: "round" },
      encoding: {
        x: mm("x"),
        y: mm("y"),
        detail: { field: "s", type: "nominal" },
        order: { field: "o", type: "quantitative" },
        color: { ...colour, legend: series.length > 1 ? { orient: "none", legendX: 0, legendY: u(plotH - 3.6), direction: "horizontal", title: null } : null },
      },
    },
    ...(["left", "right", "center"] as const).map((al) => ({
      data: { values: labels.filter((l) => l.al === al) },
      mark: { type: "text", align: al, baseline: "middle", fontSize: L, color: ctx.th.ink900 },
      encoding: { x: mm("x"), y: mm("y"), text: { field: "t" } },
    })),
    {
      // Scale value of the outer ring, just inside it beside the top spoke (the axis label sits above the ring).
      data: { values: [{ x: u(cx + 0.8), y: u(cy - R + 0.8), t: num(max, dec, ctx, input.unit) }] },
      mark: { type: "text", align: "left", baseline: "top", font: VEGA_FONT_DATA, fontSize: S, color: ctx.th.ink700 },
      encoding: { x: mm("x"), y: mm("y"), text: { field: "t" } },
    },
  ];
  return vl(ctx, plotH, { layer }, "none");
}

// ── Hierarchy helpers (V-07, V-08) ──────────────────────────────────────
interface HNode {
  id: string;
  parent?: string;
  label: string;
  size: number;
  cat: string;
  depth: number;
  leaf: boolean;
  lw: number;
}

function hierarchy(input: PartitionInput | TreeInput, darkFirst: boolean): { nodes: HNode[]; maxDepth: number; leaves: number } {
  const depth = hierarchyCheck(input.data);
  const parents = new Set(input.data.nodes.flatMap((n) => (n.parent === undefined ? [] : [n.parent])));
  const accent = input.accent?.point;
  const cats = darkFirst ? ["d1", "d2", "d3", "d3"] : ["d3", "d3", "d3", "d3"];
  const nodes = input.data.nodes.map((n) => {
    const d = depth.get(n.id) ?? 0;
    const leaf = !parents.has(n.id);
    const isAcc = accent !== undefined && (n.id === accent || n.label === accent);
    return {
      id: n.id,
      ...(n.parent !== undefined ? { parent: n.parent } : {}),
      label: n.label,
      size: leaf ? (n.value ?? 1) : 0,
      cat: d === 0 ? "root" : isAcc ? "acc" : cats[Math.min(d - 1, 3)],
      depth: d,
      leaf,
      lw: u(textW(n.label)),
    };
  });
  return { nodes, maxDepth: Math.max(...nodes.map((n) => n.depth)), leaves: nodes.filter((n) => n.leaf).length };
}

// ── V-07 sunburst / icicle (Vega partition) ─────────────────────────────
function partition(input: PartitionInput, ctx: BuildCtx): BuiltSpec {
  const K = "V-07";
  capCount(K, "simpul", "simpul", input.data.nodes.length, 200, "ringkas cabang kecil menjadi \"Lainnya\" (maks 200 simpul)");
  const h = hierarchy(input, true);
  capCount(K, "tingkat", "tingkat", h.maxDepth, 4, "maks 4 tingkat di bawah akar; pisah per cabang");
  if (h.nodes.every((n) => !n.leaf || n.size === 0)) throw over(K, "semua daun bernilai 0", { quantity: "nilai daun", unit: "nilai", limit: 1, measured: 0, suggestion: "beri nilai > 0 pada daun" });
  const th = ctx.th;
  const lh = mmOfPt(LABEL_PT);
  const fillScale = { name: "fill", type: "ordinal", domain: ["root", "d1", "d2", "d3", "acc"], range: [th.paper, th.ink700, th.ink400, th.ink200, th.accent] };
  const textScale = { name: "ink", type: "ordinal", domain: ["root", "d1", "d2", "d3", "acc"], range: [th.ink900, th.paper, th.paper, th.ink900, th.paper] };
  const form = input.options?.form ?? "sunburst";
  if (form === "icicle") {
    // The root is the first column here (not a hole in the middle): dark band, paper text.
    fillScale.range[0] = th.ink900;
    textScale.range[0] = th.paper;
    const plotH = plotHeight(ctx, K, round(Math.max(40, Math.min(h.leaves * 4.2, 160))));
    const W = ctx.widthMm;
    return {
      engine: "vega",
      plotHeightMm: plotH,
      spec: {
        width: u(W),
        height: u(plotH),
        padding: 0,
        autosize: "none",
        config: vgConfig(th),
        data: [
          {
            name: "tree",
            values: h.nodes,
            transform: [
              { type: "stratify", key: "id", parentKey: "parent" },
              { type: "partition", field: "size", sort: { field: "size", order: "descending" }, size: [u(plotH), u(W)], as: ["b0", "d0", "b1", "d1", "depth", "children"] },
            ],
          },
          { name: "labels", source: "tree", transform: [{ type: "filter", expr: `datum.b1 - datum.b0 >= ${u(lh + 0.6)} && datum.d1 - datum.d0 >= datum.lw + ${u(1.8)}` }] },
        ],
        scales: [fillScale, textScale],
        marks: [
          { type: "rect", from: { data: "tree" }, encode: { enter: { x: { field: "d0" }, x2: { field: "d1" }, y: { field: "b0" }, y2: { field: "b1" }, fill: { scale: "fill", field: "cat" }, stroke: { value: th.paper }, strokeWidth: { value: u(STROKE.sep) } } } },
          {
            type: "text",
            from: { data: "labels" },
            encode: {
              enter: {
                x: { field: "d0", offset: u(0.9) },
                y: { signal: "(datum.b0 + datum.b1) / 2" },
                text: { field: "label" },
                align: { value: "left" },
                baseline: { value: "middle" },
                font: { value: VEGA_FONT_STRUCT },
                fontSize: { value: L },
                fill: { scale: "ink", field: "cat" },
              },
            },
          },
        ],
      },
    };
  }
  const plotH = plotHeight(ctx, K, round(Math.min(ctx.widthMm * 0.62, 100)));
  const R = u(Math.min(plotH, ctx.widthMm) / 2 - 0.4);
  const cx = u(ctx.widthMm / 2);
  const cy = u(plotH / 2);
  const mid = "(datum.a0 + datum.a1) / 2";
  return {
    engine: "vega",
    plotHeightMm: plotH,
    spec: {
      width: u(ctx.widthMm),
      height: u(plotH),
      padding: 0,
      autosize: "none",
      config: vgConfig(th),
      data: [
        {
          name: "tree",
          values: h.nodes,
          transform: [
            { type: "stratify", key: "id", parentKey: "parent" },
            { type: "partition", field: "size", sort: { field: "size", order: "descending" }, size: [2 * Math.PI, R], as: ["a0", "r0", "a1", "r1", "depth", "children"] },
          ],
        },
        {
          name: "labels",
          source: "tree",
          // Radial labels: the ring is deep enough for the text and the arc wide enough for one line.
          transform: [{ type: "filter", expr: `datum.depth > 0 && datum.r1 - datum.r0 >= datum.lw + ${u(1.2)} && (datum.a1 - datum.a0) * (datum.r0 + datum.r1) / 2 >= ${u(lh + 0.8)}` }],
        },
        { name: "centre", source: "tree", transform: [{ type: "filter", expr: `datum.depth == 0 && datum.lw + ${u(1)} <= 2 * datum.r1` }] },
      ],
      scales: [fillScale, textScale],
      marks: [
        {
          type: "arc",
          from: { data: "tree" },
          encode: {
            enter: {
              x: { value: cx },
              y: { value: cy },
              startAngle: { field: "a0" },
              endAngle: { field: "a1" },
              innerRadius: { field: "r0" },
              outerRadius: { field: "r1" },
              fill: { scale: "fill", field: "cat" },
              stroke: { value: th.paper },
              strokeWidth: { value: u(STROKE.sep) },
            },
          },
        },
        {
          type: "text",
          from: { data: "labels" },
          encode: {
            enter: {
              x: { value: cx },
              y: { value: cy },
              theta: { signal: mid },
              radius: { signal: "(datum.r0 + datum.r1) / 2" },
              angle: { signal: `${mid} * 180 / PI - 90 + (${mid} > PI ? 180 : 0)` },
              text: { field: "label" },
              align: { value: "center" },
              baseline: { value: "middle" },
              font: { value: VEGA_FONT_STRUCT },
              fontSize: { value: L },
              fill: { scale: "ink", field: "cat" },
            },
          },
        },
        {
          type: "text",
          from: { data: "centre" },
          encode: { enter: { x: { value: cx }, y: { value: cy }, text: { field: "label" }, align: { value: "center" }, baseline: { value: "middle" }, font: { value: VEGA_FONT_STRUCT }, fontSize: { value: L }, fill: { value: th.ink900 } } },
        },
      ],
    },
  };
}

// ── V-08 tree / dendrogram (Vega tree) ──────────────────────────────────
function tree(input: TreeInput, ctx: BuildCtx): BuiltSpec {
  const K = "V-08";
  capCount(K, "simpul", "simpul", input.data.nodes.length, 120, "pisah per cabang (maks 120 simpul per gambar)");
  const h = hierarchy(input, false);
  const pitch = 3.6;
  const maxLeaves = Math.floor((ctx.maxPlotMm - 3.2) / pitch);
  capCount(K, "daun", "daun", h.leaves, maxLeaves, `pisah per cabang (maks ${maxLeaves} daun pada blok teks ini)`);
  capCount(K, "tingkat", "tingkat", h.maxDepth, 6, "maks 6 tingkat; pisah per cabang");
  const th = ctx.th;
  const leafW = Math.max(...h.nodes.filter((n) => n.leaf).map((n) => textW(n.label))) + 1.6;
  const root = h.nodes.find((n) => n.depth === 0)!;
  const rootW = textW(root.label) + 1.6;
  const innerMax = Math.max(0, ...h.nodes.filter((n) => !n.leaf && n.depth > 0).map((n) => textW(n.label)));
  const span = ctx.widthMm - leafW - rootW;
  const step = span / Math.max(1, h.maxDepth);
  if (step < innerMax + 2.4) {
    throw over(K, `jarak antartingkat ${step.toFixed(1)} mm < label simpul dalam ${innerMax.toFixed(1)} mm`, {
      checkId: "CAPACITY-LABELS",
      quantity: "lebar label simpul dalam",
      unit: "mm",
      limit: round(Math.max(0, step - 2.4)),
      measured: round(innerMax),
      suggestion: "persingkat label simpul dalam, kurangi tingkat, atau pakai lebar 166 mm",
    });
  }
  const plotH = plotHeight(ctx, K, round(Math.max(24, h.leaves * pitch + 3.2)));
  const nodes = h.nodes.map((n) => ({
    ...n,
    cat: n.cat === "acc" ? "acc" : n.leaf ? "leaf" : "inner",
    al: n.leaf ? "left" : "right",
    dx: n.leaf ? u(1.2) : u(-1.2),
    bl: n.leaf || n.depth === 0 ? "middle" : "bottom",
    dy: n.leaf || n.depth === 0 ? 0 : u(-0.5),
  }));
  return {
    engine: "vega",
    plotHeightMm: plotH,
    spec: {
      width: u(ctx.widthMm),
      height: u(plotH),
      padding: 0,
      autosize: "none",
      config: vgConfig(th),
      data: [
        {
          name: "tree",
          values: nodes,
          transform: [
            { type: "stratify", key: "id", parentKey: "parent" },
            { type: "tree", method: input.options?.form === "dendrogram" ? "cluster" : "tidy", size: [u(plotH - 3.2), u(span)], separation: false, as: ["y", "x", "depth", "children"] },
          ],
        },
        { name: "links", source: "tree", transform: [{ type: "treelinks" }, { type: "linkpath", orient: "horizontal", shape: "orthogonal" }] },
      ],
      scales: [
        { name: "dot", type: "ordinal", domain: ["inner", "leaf", "acc"], range: [th.ink700, th.ink400, th.accent] },
        { name: "ink", type: "ordinal", domain: ["inner", "leaf", "acc"], range: [th.ink900, th.ink900, th.accent] },
      ],
      marks: [
        {
          type: "group",
          encode: { enter: { x: { value: u(rootW) }, y: { value: u(1.6) } } },
          marks: [
            { type: "path", from: { data: "links" }, encode: { enter: { path: { field: "path" }, stroke: { value: th.ink400 }, strokeWidth: { value: u(STROKE.sep) } } } },
            { type: "symbol", from: { data: "tree" }, encode: { enter: { x: { field: "x" }, y: { field: "y" }, size: { value: u(1.05) * u(1.05) }, shape: { value: "circle" }, fill: { scale: "dot", field: "cat" }, strokeWidth: { value: 0 } } } },
            {
              type: "text",
              from: { data: "tree" },
              encode: {
                enter: {
                  x: { field: "x" },
                  y: { field: "y" },
                  dx: { field: "dx" },
                  dy: { field: "dy" },
                  text: { field: "label" },
                  align: { field: "al" },
                  baseline: { field: "bl" },
                  font: { value: VEGA_FONT_STRUCT },
                  fontSize: { value: L },
                  fill: { scale: "ink", field: "cat" },
                },
              },
            },
          ],
        },
      ],
    },
  };
}

/** Build the Vega-Lite / Vega spec of one validated input. */
export function buildVegaSpec(input: VegaChartInput, ctx: BuildCtx): BuiltSpec {
  const dec = input.dec ?? 0;
  switch (input.kind) {
    case "V-01":
      return calendar(input, ctx, dec);
    case "V-02":
      return streamgraph(input, ctx);
    case "V-03":
      return parallel(input, ctx, dec);
    case "V-04":
      return ecdf(input, ctx, dec);
    case "V-05":
      return polarArea(input, ctx, dec);
    case "V-06":
      return radar(input, ctx, dec);
    case "V-07":
      return partition(input, ctx);
    case "V-08":
      return tree(input, ctx);
  }
}
