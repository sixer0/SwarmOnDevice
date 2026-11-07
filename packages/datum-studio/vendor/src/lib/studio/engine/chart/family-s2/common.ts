/**
 * engine/chart/family-s2 — helper bersama S-05..S-08 (S42, I32).
 *
 * Konvensi mengikuti chart/core (S32): 1 satuan pengguna = 1 mm, huruf pt FISIK (tidak
 * pernah di bawah `chart.minFontPt`, P7-36), garis >= 0,18 mm (lint 27), tanda data
 * membawa `data-mark`/`data-series`/`data-index` (N2), sumbu `data-axis`. Helper inti
 * diimpor dari berkas helper core (bukan core/index) agar tidak ikut siklus dispatch.
 *
 * Subjek tanda (lint 26, DATUM-26): pada chart sebaran SUBJEK adalah GRUP. Titik
 * pengamatan membawa `data-series="<grup>"` dan `data-index="<indeks grup>"`, plus
 * `data-obs="<indeks pengamatan>"`; dengan begitu satu grup beraksen = satu subjek
 * beraksen, bukan N titik. Sektor radial: `data-index` = indeks sektor.
 *
 * Parameter (D-58, D-87):
 * - kunci registri `chart.kind.<KODE>.<nama>`: spec.params -> tpl.params -> default;
 *   tipe salah -> SCHEMA_INVALID;
 * - alias pendek spec galeri S94 diselesaikan resolver tunggal chart/core (`core/params.ts`)
 *   sebelum renderer: alias sah dipindah ke kunci penuh (PARAM_ALIAS), alias bernilai tidak
 *   sah (mis. `periodOrder: "atas ke bawah ..."`) dibuang + REPORT `PARAM_IGNORED`;
 * - petunjuk data per kode (`CHART_DATA_HINT_KEYS` core) dibaca bila ada;
 * - kunci lain dibuang resolver core + REPORT `PARAM_IGNORED`, tidak pernah ditolak.
 *
 * Aksen: medan `spec.accent` {group | series | point} menang atas alias params
 * `accentGroup` / `accentSeries` / `accentPoint`. Petunjuk yang tidak cocok dengan data
 * diabaikan + REPORT `ACCENT_HINT`.
 *
 * Deterministik: tanpa RNG global, tanpa waktu. Acak semu (jitter S-06) memakai
 * mulberry32 yang dibenihi hash FNV-1a 32-bit dari kode + indeks + nama grup + benih tetap
 * 42 (= `SEED` pustakachart_data). Urutan penjumlahan float tetap (urutan data).
 */
import type { ChartCanvas, LintIssue, ParamValue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt } from "../../bind";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type CategoryAxisPlan, categoryAxisPlan, drawCategoryLabel } from "../core/labelfit";
import { type ChartPalette, chartPalette, chartParam } from "../core/palette";
import { chartFloors } from "../core/prepare";
import { type NiceDomain, type Scale, decimalsFor, niceDomain } from "../core/scale";
import { SvgDoc, ptToMm, textWidthMm, midBaseline } from "../core/svg";
import { accentOf } from "../core/params";
import type { DistributionGroup } from "../core/guards";
import { hintBool as coreHintBool, hintNum, hintValue } from "../core/read";

export type S2Code = "S-05" | "S-06" | "S-07" | "S-08";
export type S2Style = "datum" | "gallery";

/** Benih tetap acak semu (= SEED pustakachart_data.py). */
export const S2_SEED = 42;


/** Ukuran huruf (pt fisik). Gallery = chart/core gallery.ts; datum = style_ax pustakachart. */
export const TYPE_PT = {
  gallery: { label: 6.4, tick: 6.0 },
  datum: { label: 6.5, tick: 6.5, axisTitle: 6.8 },
} as const;

/** Garis (mm). */
export const HAIR_MM = 0.25;
export const GRID_MM = 0.18;
/** Spine PC `axes.linewidth` 0,6 pt; grid PC 0,4 pt. */
export const SPINE_MM = 0.6 * (25.4 / 72);
export const PC_GRID_MM = Math.max(GRID_MM, 0.4 * (25.4 / 72));

export interface S2Ctx {
  code: S2Code;
  spec: StudioChartV1;
  tpl: ResolvedTemplate;
  style: S2Style;
  pal: ChartPalette;
  maxAccent: number;
  minFontPt: number;
  dec: number;
  unit: string;
  fid: string;
  W: number;
  H: number;
  /** Batas bawah area gambar (di atas pita catatan / aparatus figure). */
  bottom: number;
  doc: SvgDoc;
  issues: LintIssue[];
  checks: string[];
}

export function beginS2(code: S2Code, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): S2Ctx {
  const style: S2Style = (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
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

export function endS2(ctx: S2Ctx): SvgResult {
  const { spec, doc, pal, W, H } = ctx;
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun: ctx.checks, issues: ctx.issues } };
}

/** Ukuran huruf efektif: tidak pernah di bawah lantai P7-36. */
export function pt(ctx: S2Ctx, size: number): number {
  return Math.max(size, ctx.minFontPt);
}

/** Cek dijalankan tanpa temuan (PASS tidak dicantumkan di `issues`). */
export function ran(ctx: S2Ctx, checkId: string): void {
  if (!ctx.checks.includes(checkId)) ctx.checks.push(checkId);
}

export function report(ctx: S2Ctx, checkId: string, detail: string): void {
  ran(ctx, checkId);
  ctx.issues.push({ checkId, status: "REPORT", detail });
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

// ── Parameter ──────────────────────────────────────────────────────────────

/**
 * Pembaca parameter: API baca tunggal inti (`core/read.ts`, S84 #8). Argumen ke-4
 * `explicitOnly` = mode eksplisit D-77 (resep acuan gaya datum).
 */
export { kindBool, kindInt } from "../core/read";

/** Petunjuk data non-registri (`CHART_DATA_HINT_KEYS` core). */
export function hint(ctx: S2Ctx, name: string): ParamValue | undefined {
  return hintValue(ctx.spec, name);
}

export function hintBool(ctx: S2Ctx, name: string, fallback: boolean): boolean {
  return coreHintBool(ctx.spec, name, fallback);
}

export function hintNumber(ctx: S2Ctx, name: string): number | undefined {
  return hintNum(ctx.spec, name);
}

/** Global P7-04 `chart.zeroBaseline` (kelas K, default true). */
export function zeroBaseline(ctx: S2Ctx): boolean {
  const v = chartParam(ctx.spec, ctx.tpl, "chart.zeroBaseline");
  return typeof v === "boolean" ? v : true;
}

// ── Data ──────────────────────────────────────────────────────────────────

/** Data `distribution` (penjaga tunggal inti, S84 #8). */
export { requireDistribution } from "../core/guards";
export type Group = DistributionGroup;

// ── Aksen ─────────────────────────────────────────────────────────────────

/** Sasaran aksen grup (group > series > point dari `accentOf` inti, S84 #1); `undefined` bila tidak ada. */
export function accentTarget(spec: StudioChartV1): string | number | undefined {
  const a = accentOf(spec);
  return a?.group ?? a?.series ?? a?.point;
}

/**
 * Indeks grup beraksen (-1 bila tidak ada). Petunjuk tidak cocok -> REPORT ACCENT_HINT.
 * Penjaga DATUM-26: 1 grup beraksen > `chart.accent.maxSubjects` -> BY_CONSTRUCTION_FAILED.
 */
export function accentGroupIndex(ctx: S2Ctx, names: readonly string[]): number {
  const t = accentTarget(ctx.spec);
  if (t === undefined) return -1;
  const i = typeof t === "number" ? (t >= 0 && t < names.length ? t : -1) : names.indexOf(t);
  if (i < 0) {
    report(ctx, "ACCENT_HINT", `petunjuk aksen ${JSON.stringify(t)} tidak cocok dengan grup data; diabaikan`);
    return -1;
  }
  if (ctx.maxAccent < 1) {
    throw defect("DATUM-26", `${ctx.fid} — aksen diminta tetapi chart.accent.maxSubjects = ${ctx.maxAccent}`, { code: ctx.code });
  }
  return i;
}

// ── Statistik dan KDE ─────────────────────────────────────────────────────

export function mean(xs: readonly number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** Median (rerata dua nilai tengah untuk n genap; = numpy.median). */
export function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Simpangan baku populasi (ddof 0, = numpy `std()`). */
export function stdPop(xs: readonly number[]): number {
  const m = mean(xs);
  let s = 0;
  for (const x of xs) s += (x - m) * (x - m);
  return Math.sqrt(s / xs.length);
}

/**
 * Lebar pita Silverman `1,06 * std * n^-0,2` (= `_kde` pustakachart PC:852-857). Sampel
 * tanpa sebaran (std 0) memakai 5 persen |nilai| (atau 1) agar kurva tetap terdefinisi.
 */
export function silvermanBw(xs: readonly number[]): number {
  const bw = 1.06 * stdPop(xs) * Math.pow(xs.length, -0.2);
  if (bw > 0) return bw;
  return Math.abs(xs[0]) * 0.05 || 1;
}


/** Numerik bersama (definisi tunggal inti, S84 #8; linspace n = 1 -> [a]). */
export { kde, linspace } from "../core/numeric";

// ── Acak semu deterministik ───────────────────────────────────────────────

/** FNV-1a 32-bit atas kode unit UTF-16. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** mulberry32: barisan [0, 1) deterministik dari benih 32-bit. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generator per grup: benih = FNV-1a("<kode>|<indeks>|<nama>") XOR S2_SEED. */
export function groupRng(code: S2Code, gi: number, name: string): () => number {
  return mulberry32((fnv1a(`${code}|${gi}|${name}`) ^ S2_SEED) >>> 0);
}

// ── Sumbu ─────────────────────────────────────────────────────────────────

export function tickLabels(dom: NiceDomain): string[] {
  const d = decimalsFor(dom.step);
  return dom.ticks.map((t) => fmt(t, d));
}

export function tickWidth(dom: NiceDomain, sizePt: number, face: "struct" | "data"): number {
  return Math.max(...tickLabels(dom).map((s) => textWidthMm(s, sizePt, face)));
}

export function valueDomain(values: readonly number[], zero: boolean): NiceDomain {
  return niceDomain(values, { zero });
}

/** Gridline horizontal pada tick (dekorasi). */
export function gridY(ctx: S2Ctx, dom: NiceDomain, sy: Scale, x0: number, x1: number, colour: string, widthMm: number): void {
  ctx.doc.open('data-grid="y"');
  for (const t of dom.ticks) ctx.doc.line(x0, sy(t), x1, sy(t), colour, widthMm);
  ctx.doc.close();
}

/** Sumbu y kiri: garis + label tick rata kanan. */
export function axisY(
  ctx: S2Ctx,
  dom: NiceDomain,
  sy: Scale,
  x0: number,
  top: number,
  base: number,
  o: { colour: string; widthMm: number; sizePt: number; face: "struct" | "data" },
): void {
  const labels = tickLabels(dom);
  ctx.doc.open('data-axis="y"');
  ctx.doc.line(x0, top, x0, base, o.colour, o.widthMm);
  dom.ticks.forEach((t, i) => {
    ctx.doc.text(x0 - 1.2, mid(sy(t), o.sizePt), labels[i], { sizePt: pt(ctx, o.sizePt), fill: ctx.pal.ink400, anchor: "end", face: o.face });
  });
  ctx.doc.close();
}

/** Sumbu x bawah bertick (nilai). */
export function axisX(
  ctx: S2Ctx,
  dom: NiceDomain,
  sx: Scale,
  base: number,
  x0: number,
  x1: number,
  o: { colour: string; widthMm: number; sizePt: number; face: "struct" | "data" },
): void {
  const labels = tickLabels(dom);
  ctx.doc.open('data-axis="x"');
  ctx.doc.line(x0, base, x1, base, o.colour, o.widthMm);
  dom.ticks.forEach((t, i) => {
    ctx.doc.text(sx(t), base + ptToMm(o.sizePt) + 1.2, labels[i], { sizePt: pt(ctx, o.sizePt), fill: ctx.pal.ink400, anchor: "middle", face: o.face });
  });
  ctx.doc.close();
}

/**
 * Kerangka kolom kategori (S-06, S-07): sumbu y nilai di kiri, satu kolom per grup,
 * label grup di bawah garis dasar. Mengembalikan geometri plot.
 */
export interface ColumnFrame {
  x0: number;
  x1: number;
  top: number;
  base: number;
  step: number;
  sy: Scale;
  dom: NiceDomain;
  centre(i: number): number;
  /** Rencana label kolom bertingkat (FIG-02a P1-4); null = jalur satu baris lama. */
  labelPlan: CategoryAxisPlan | null;
}

export function columnFrame(
  ctx: S2Ctx,
  groups: readonly Group[],
  columns: number,
  sy0: (dom: NiceDomain, top: number, base: number) => Scale,
  labels: readonly string[] = [],
): ColumnFrame {
  const { pal, doc, style } = ctx;
  const dom = valueDomain(
    groups.flatMap((g) => g.values),
    zeroBaseline(ctx),
  );
  const gal = style === "gallery";
  const T = gal ? TYPE_PT.gallery : TYPE_PT.datum;
  const face = gal ? "struct" : "data";
  const top = gal ? 1.2 : 6.0;
  const x0 = 0.5 + tickWidth(dom, T.tick, face) + 1.6;
  const x1 = ctx.W - 0.5;
  const labelPlan = labels.length
    ? categoryAxisPlan(labels, (x1 - x0) / columns, { pt: pt(ctx, gal ? TYPE_PT.gallery.label : TYPE_PT.datum.label) }, { maxRotateBandMm: Math.max(10, ctx.bottom * 0.4) })
    : null;
  const base = ctx.bottom - (gal ? 4.4 : 5.2) - (labelPlan?.extraBandMm ?? 0);
  const sy = sy0(dom, top, base);
  const step = (x1 - x0) / columns;
  if (!gal) gridY(ctx, dom, sy, x0, x1, pal.ink200, PC_GRID_MM);
  axisY(ctx, dom, sy, x0, top, base, { colour: gal ? pal.role.textAxis : pal.ink400, widthMm: gal ? HAIR_MM : SPINE_MM, sizePt: T.tick, face });
  doc.open('data-axis="x"');
  doc.line(x0, base, x1, base, gal ? pal.role.textAxis : pal.ink400, gal ? HAIR_MM : SPINE_MM);
  doc.close();
  if (!gal && ctx.unit) {
    doc.text(x0, top - ptToMm(TYPE_PT.datum.axisTitle) - 0.4, ctx.unit, { sizePt: pt(ctx, TYPE_PT.datum.axisTitle), fill: pal.ink700 });
  }
  return { x0, x1, top, base, step, sy, dom, centre: (i) => x0 + step * (i + 0.5), labelPlan };
}

/** Label kolom grup di bawah garis dasar (gallery: tick kecil + ink400; datum: ink700). */
export function columnLabel(ctx: S2Ctx, f: ColumnFrame, x: number, label: string, i = 0): void {
  const gal = ctx.style === "gallery";
  const size = pt(ctx, gal ? TYPE_PT.gallery.label : TYPE_PT.datum.label);
  if (gal) ctx.doc.line(x, f.base, x, f.base + 0.8, ctx.pal.role.textAxis, HAIR_MM);
  const o = { sizePt: size, fill: gal ? ctx.pal.ink400 : ctx.pal.ink700, anchor: "middle" as const };
  if (f.labelPlan) drawCategoryLabel(ctx.doc, f.labelPlan, i, x, f.base + (gal ? 0.9 : 1.2) + ptToMm(size), o);
  else ctx.doc.text(x, f.base + (gal ? 0.9 : 1.2) + ptToMm(size), label, o);
}

export { linearScale } from "../core/scale";
export { num, ptToMm, textWidthMm } from "../core/svg";
export type { NiceDomain, Scale };
