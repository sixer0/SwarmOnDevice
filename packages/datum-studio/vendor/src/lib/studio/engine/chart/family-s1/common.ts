/**
 * engine/chart/family-s1 — kerangka bersama S-01..S-04 (S41, I31; 01_specs.md §3.5, §5.3, §8.2).
 *
 * Konvensi chart/core (S32) dipakai apa adanya lewat berkas helper core (bukan core/index,
 * agar tidak ikut siklus impor contract/dispatch): SvgDoc (1 satuan pengguna = 1 mm,
 * ukuran huruf pt FISIK, tidak pernah di bawah `chart.minFontPt` P7-36), palet + peran
 * warna, skala rapi, aparatus, penjaga, `data-mark`/`data-series`/`data-index` (N2).
 *
 * Parameter (D-58, D-87):
 * - kunci registri `chart.kind.<KODE>.<nama>` di spec.params, lalu templat, lalu default
 *   registri; berlaku di gaya `datum` dan `gallery`. `S-02.whisker`, `S-03/S-04.bandwidth`
 *   kini ParamDef registri (IP-25). Alias pendek spec galeri S94 dipindah ke kunci penuh oleh
 *   resolver tunggal chart/core (`core/params.ts`) sebelum renderer;
 * - petunjuk data per kode (`binEdges`, `medianLabel`, `medianTick`;
 *   `CHART_DATA_HINT_KEYS` core) dibaca bila ada; domain sumbu = ParamDef
 *   `chart.kind.<KODE>.axis` (S-01..S-04; alias `params.axis` dipindah resolver);
 * - kunci lain dibuang resolver core + REPORT `PARAM_IGNORED`, tidak pernah ditolak.
 *
 * Aksen (D-58, delta S03-d1): `spec.accent` {point, group, series} menang atas alias
 * `params.accentPoint`/`accentGroup`/`accentSeries`. Maks `chart.accent.maxSubjects`
 * subjek beraksen per gambar (DATUM-26); subjek = (data-series, data-index).
 */
import type { ChartCanvas, LintIssue, ParamValue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { fmt } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type CategoryAxisPlan, categoryAxisPlan, drawCategoryLabel } from "../core/labelfit";
import { type ChartPalette, chartPalette } from "../core/palette";
import { chartFloors } from "../core/prepare";
import { type NiceDomain, type Scale, decimalsFor, niceDomain } from "../core/scale";
import { SvgDoc, ptToMm, textWidthMm, midBaseline } from "../core/svg";
import { accentOf } from "../core/params";
import { asRange, hintBool as coreHintBool, hintRange, hintStr, hintValue, invalidParam as coreInvalidParam, kindKey, kindValue } from "../core/read";

export type S1Code = "S-01" | "S-02" | "S-03" | "S-04";
export type S1Style = "datum" | "gallery";


/** `tinggi_mm` registri pustakachart per kode (cek paritas CB1 (d)); renderer memakai kanvas apa adanya. */
export const S1_REFERENCE_HEIGHT_MM: Readonly<Record<S1Code, number>> = { "S-01": 54, "S-02": 56, "S-03": 54, "S-04": 56 };


/** Ukuran huruf (pt fisik). Datum = style_ax PC (6,5 pt tick, 6,8 pt judul sumbu); gallery = chart/core gallery.ts. */
export const TYPE_PT = {
  datum: { tick: 6.5, label: 6.5, title: 6.8, value: 6.5 },
  gallery: { tick: 6.0, label: 6.4, title: 6.0, value: 6.0 },
} as const;

/** Garis (mm); lantai fotokopi 0,18 mm (DATUM-27). */
export const HAIR_MM = 0.25;
export const GRID_MM = 0.18;
/** 0,8 pt (tepi kotak/violin PC) dan 1,6 pt (median PC). */
export const EDGE_MM = 0.8 * (25.4 / 72);
export const MEDIAN_MM = 1.6 * (25.4 / 72);

export interface S1Ctx {
  code: S1Code;
  spec: StudioChartV1;
  tpl: ResolvedTemplate;
  style: S1Style;
  pal: ChartPalette;
  type: (typeof TYPE_PT)[S1Style];
  maxAccent: number;
  minFontPt: number;
  dec: number;
  unit: string;
  fid: string;
  W: number;
  H: number;
  /** Batas bawah area gambar (di atas pita catatan/aparatus figure). */
  bottom: number;
  doc: SvgDoc;
  issues: LintIssue[];
  checks: string[];
}

/** Ukuran huruf efektif: tidak pernah di bawah lantai P7-36 templat. */
export function pt(ctx: S1Ctx, size: number): number {
  return Math.max(size, ctx.minFontPt);
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

export function report(ctx: S1Ctx, checkId: string, detail: string): void {
  if (!ctx.checks.includes(checkId)) ctx.checks.push(checkId);
  ctx.issues.push({ checkId, status: "REPORT", detail });
}

export function beginChart(code: S1Code, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): S1Ctx {
  const style: S1Style = (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
  const floors = chartFloors(spec, tpl);
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = new SvgDoc(W, H, `data-chart="${code}" data-style="${style}"`, floors.minFontPt);
  const pal = chartPalette(spec, tpl);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  const foot = figureFootMm(spec) + (spec.note ? 5 : 0);
  return {
    code,
    spec,
    tpl,
    style,
    pal,
    type: TYPE_PT[style],
    maxAccent: floors.maxAccent,
    minFontPt: floors.minFontPt,
    dec: spec.dec ?? 0,
    unit: spec.unit ?? "",
    fid: figureLabel(spec),
    W,
    H,
    bottom: H - foot,
    doc,
    issues: [],
    checks: [],
  };
}

export function endChart(ctx: S1Ctx): SvgResult {
  const { spec, doc, pal, W, H } = ctx;
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun: ctx.checks, issues: ctx.issues } };
}

// ── Parameter ──────────────────────────────────────────────────────────────

/**
 * Pembaca parameter dan petunjuk data: API baca tunggal inti (`core/read.ts`, S84 #8).
 * Kunci penuh spec -> templat -> default (alias diselesaikan core).
 */
export function kindParam(ctx: S1Ctx, name: string): ParamValue | undefined {
  return kindValue(ctx, name);
}

export { kindBool } from "../core/read";

export function hint(ctx: S1Ctx, name: string): ParamValue | undefined {
  return hintValue(ctx.spec, name);
}

export function hintBool(ctx: S1Ctx, name: string, fallback: boolean): boolean {
  return coreHintBool(ctx.spec, name, fallback);
}

export function hintString(ctx: S1Ctx, name: string): string | undefined {
  return hintStr(ctx.spec, name);
}

/**
 * Domain sumbu nilai [min, maks] (min < maks): parameter templat `chart.kind.<KODE>.axis`
 * (S-01 IP-59/FIX-A; S-02..S-04 FIX-A2; resolver memindah alias `params.axis` ke kunci penuh).
 * Cabang petunjuk `params.axis` tinggal untuk kode S1 tanpa ParamDef axis (saat ini tidak ada).
 */
export function hintAxis(ctx: S1Ctx): [number, number] | undefined {
  const full = kindValue(ctx, "axis");
  return full !== undefined ? asRange(ctx.spec, full, kindKey(ctx.code, "axis")) : hintRange(ctx.spec, "axis");
}

/** Galat parameter seragam inti (kunci apa adanya). */
export function invalidParam(ctx: S1Ctx, key: string, v: unknown, expected: string): StudioEngineError {
  return coreInvalidParam(ctx.spec, key, v, expected, ctx.code);
}

// ── Data ──────────────────────────────────────────────────────────────────

/** Data `distribution` (penjaga tunggal inti, S84 #8). */
export { requireDistribution, type DistributionGroup as Group } from "../core/guards";

// ── Aksen ─────────────────────────────────────────────────────────────────

/** Sasaran aksen grup (point > group > series dari `accentOf` inti, S84 #1); `undefined` bila tidak ada. */
export function accentTarget(spec: StudioChartV1): string | number | undefined {
  const a = accentOf(spec);
  return a?.point ?? a?.group ?? a?.series;
}

/** Indeks grup beraksen (nama persis atau indeks bulat); -1 bila tidak ada/tidak cocok (dilaporkan). */
export function accentGroupIndex(ctx: S1Ctx, names: readonly string[]): number {
  const t = accentTarget(ctx.spec);
  if (t === undefined) return -1;
  const i = typeof t === "number" ? (t >= 0 && t < names.length ? t : -1) : names.indexOf(t);
  if (i < 0) report(ctx, "ACCENT_HINT", `petunjuk aksen ${JSON.stringify(t)} tidak cocok dengan grup data; diabaikan`);
  return i;
}

/** Penjaga DATUM-26: jumlah subjek beraksen <= maks. */
export function assertAccentCount(ctx: S1Ctx, subjects: number): void {
  if (subjects > ctx.maxAccent) {
    throw defect("DATUM-26", `${ctx.fid} — ${subjects} subjek beraksen; maks ${ctx.maxAccent} aksen per gambar`, { code: ctx.code, accents: subjects });
  }
}

// ── Sumbu ─────────────────────────────────────────────────────────────────

/** Label tick terformat (koma desimal Indonesia, desimal = langkah tick). */
export function tickLabels(dom: NiceDomain): string[] {
  const d = decimalsFor(dom.step);
  return dom.ticks.map((t) => fmt(t, d));
}

/**
 * Domain sumbu nilai: `chart.kind.<KODE>.axis` (`hintAxis`; diperluas rapi bila data keluar dari rentang,
 * dilaporkan) atau domain rapi data. `zero` memaksa 0 di domain (CH-01, area/kolom).
 */
export function valueDomain(ctx: S1Ctx, lo: number, hi: number, zero: boolean, target = 5): NiceDomain {
  const ax = hintAxis(ctx);
  if (ax) {
    if (lo < ax[0] || hi > ax[1]) report(ctx, "AXIS_HINT", `data ${lo}..${hi} keluar dari params.axis ${ax[0]}..${ax[1]}; domain diperluas`);
    return niceDomain([Math.min(ax[0], lo), Math.max(ax[1], hi)], { zero, target });
  }
  return niceDomain([lo, hi], { zero, target });
}

/** Lebar label tick terlebar (mm). */
export function tickWidth(ctx: S1Ctx, labels: readonly string[]): number {
  const face = ctx.style === "datum" ? "data" : "struct";
  return Math.max(0, ...labels.map((s) => textWidthMm(s, pt(ctx, ctx.type.tick), face)));
}

function tickFont(ctx: S1Ctx): { sizePt: number; face: "data" | "struct"; fill: string } {
  return ctx.style === "datum"
    ? { sizePt: pt(ctx, ctx.type.tick), face: "data", fill: ctx.pal.ink700 }
    : { sizePt: pt(ctx, ctx.type.tick), face: "struct", fill: ctx.pal.ink400 };
}

/**
 * Sumbu nilai tegak (kiri): garis kisi ink200 (datum) di setiap tick, label tick, garis
 * sumbu y. `grid` false = tanpa garis kisi (gallery).
 */
export function drawYAxis(ctx: S1Ctx, dom: NiceDomain, sy: Scale, x0: number, x1: number, o: { grid: boolean; labels: boolean }): void {
  const { doc, pal } = ctx;
  const tf = tickFont(ctx);
  const labels = tickLabels(dom);
  if (o.grid) {
    dom.ticks.forEach((t) => doc.line(x0, sy(t), x1, sy(t), pal.ink200, GRID_MM, { attrs: ' data-grid="y"' }));
  }
  doc.open('data-axis="y"');
  doc.line(x0, sy(dom.min), x0, sy(dom.max), pal.role.textAxis, HAIR_MM);
  if (o.labels) dom.ticks.forEach((t, i) => doc.text(x0 - 1.0, mid(sy(t), tf.sizePt), labels[i], { sizePt: tf.sizePt, face: tf.face, fill: tf.fill, anchor: "end" }));
  doc.close();
}

/** Sumbu nilai mendatar (bawah): garis dasar + label tick di bawahnya. */
export function drawXAxis(ctx: S1Ctx, dom: NiceDomain, sx: Scale, y: number): void {
  const { doc, pal } = ctx;
  const tf = tickFont(ctx);
  const labels = tickLabels(dom);
  doc.open('data-axis="x"');
  doc.line(sx(dom.min), y, sx(dom.max), y, pal.role.textAxis, HAIR_MM);
  dom.ticks.forEach((t, i) => doc.text(sx(t), y + ptToMm(tf.sizePt) + 1.2, labels[i], { sizePt: tf.sizePt, face: tf.face, fill: tf.fill, anchor: "middle" }));
  doc.close();
}

/** Tinggi pita label tick di bawah sumbu x (mm). */
export function xTickBand(ctx: S1Ctx): number {
  return ptToMm(pt(ctx, ctx.type.tick)) + 2.0;
}

/**
 * Rencana label grup sumbu x bertingkat (FIG-02a P1-4): `null` di luar fit atau bila semua
 * nama muat di slotnya (jalur satu baris lama). `extraBandMm` dikurangkan dari garis dasar plot.
 */
export function groupAxisPlan(ctx: S1Ctx, names: readonly string[], x0: number, x1: number): CategoryAxisPlan | null {
  return categoryAxisPlan(names, (x1 - x0) / Math.max(1, names.length), { pt: pt(ctx, ctx.type.label) }, { maxRotateBandMm: Math.max(10, ctx.bottom * 0.4) });
}

/** Label kategori (nama grup) di bawah sumbu x, terpusat di `cx`; `plan` = rencana fit (opsional). */
export function groupLabel(ctx: S1Ctx, cx: number, y: number, name: string, plan: CategoryAxisPlan | null = null, i = 0): void {
  const size = pt(ctx, ctx.type.label);
  const o = { sizePt: size, fill: ctx.style === "datum" ? ctx.pal.ink700 : ctx.pal.ink400, anchor: "middle" as const };
  if (plan) drawCategoryLabel(ctx.doc, plan, i, cx, y + ptToMm(size) + 1.2, o);
  else ctx.doc.text(cx, y + ptToMm(size) + 1.2, name, o);
}

/** Path poligon/garis dari titik (koordinat mm, deterministik lewat `num`). */
export function pathFrom(points: ReadonlyArray<readonly [number, number]>, close: boolean, num: (v: number) => string): string {
  const d = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${num(x)} ${num(y)}`).join(" ");
  return close ? `${d} Z` : d;
}
