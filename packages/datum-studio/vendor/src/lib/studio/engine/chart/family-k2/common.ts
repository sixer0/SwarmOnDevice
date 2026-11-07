/**
 * engine/chart/family-k2 — kerangka bersama K-07..K-12 (S38, I28): waffle, icon array,
 * treemap, funnel, sankey, marimekko.
 *
 * Helper geometri/warna/aparatus berasal dari chart/core (S32), diimpor per berkas
 * (`../core/svg`, `../core/palette`, ...) agar tidak menarik siklus impor contract/dispatch.
 * Berkas ini hanya menambah yang khas keluarga:
 *
 * Parameter (spec.params -> tpl.params -> default registri): kunci registri penuh
 * `chart.kind.<KODE>.<nama>`. Bekas kunci lokal K-08 `grid`/`icon`/`caption`, K-11
 * `accentLink`, K-12 `widths` kini ParamDef registri (IP-25). Alias pendek spec galeri S94
 * (`grid`, `labelsInside`, `stageValues`, ...) dan kunci tak dikenal diselesaikan resolver
 * tunggal chart/core (`core/params.ts`, D-87: PARAM_ALIAS / PARAM_IGNORED).
 *
 * Aksen (D-58, delta S03-d1): medan `spec.accent` {point, group, series} menang atas alias
 * `params.accentPoint` / `accentGroup` / `accentSeries` (CHART_ACCENT_PARAM_ALIASES);
 * `accent: true` per titik/seri tetap sah. Maks `chart.accent.maxSubjects` subjek (DATUM-26).
 *
 * Atribut tanda (spesifikasi §3.5 N2): `data-series` = bagian/grup/seri, `data-index` =
 * indeks subjek data; unit berulang (sel waffle, ikon) memakai indeks bagiannya sehingga
 * satu bagian = satu subjek pada lint 26.
 *
 * Deterministik: tanpa acak, tanpa waktu; urutan elemen = urutan panggilan; urut stabil.
 */
import type { ChartCanvas, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { PARAMS_BY_KEY } from "../../../params";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { type CategoricalPoint, defect, figureLabel, requireCategorical } from "../core/guards";
import { type ChartPalette, chartPalette, kindKey } from "../core/palette";
import { chartFloors } from "../core/prepare";
import { SvgDoc, midBaseline } from "../core/svg";
import { accentOf } from "../core/params";
import { invalidParam as coreInvalidParam, kindValue } from "../core/read";

export type K2Code = "K-07" | "K-08" | "K-09" | "K-10" | "K-11" | "K-12";
export type K2Style = "datum" | "gallery";


/** Ukuran huruf (pt fisik). Gallery mengikuti chart/core gallery.ts; datum mengikuti pustakachart (6,2-6,5 pt). */
export const TYPE_PT = {
  gallery: { label: 6.4, value: 6.4, tick: 6.0, key: 6.0, big: 8.0 },
  datum: { label: 6.5, value: 6.4, tick: 6.5, key: 6.2, big: 8.0 },
} as const;

/** Garis rambut sumbu (mm); lantai fotokopi 0,18 mm (DATUM-27). */
export const HAIR_MM = 0.25;
/** Pita baris KUNCI di atas plot (mm). */
export const KEY_BAND_MM = 5.2;

export interface K2Ctx {
  code: K2Code;
  spec: StudioChartV1;
  tpl: ResolvedTemplate;
  style: K2Style;
  pal: ChartPalette;
  maxAccent: number;
  minFontPt: number;
  dec: number;
  unit: string;
  fid: string;
  W: number;
  H: number;
  /** Area gambar (mm): x0..x1, y0..y1 (di atas pita catatan/aparatus figure). */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  doc: SvgDoc;
  issues: LintIssue[];
  checks: string[];
}

export function beginChart(code: K2Code, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): K2Ctx {
  const style: K2Style = (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
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
    x0: 0.5,
    x1: W - 0.5,
    y0: 0.8,
    y1: H - foot - 0.8,
    doc,
    issues: [],
    checks: [],
  };
}

export function endChart(ctx: K2Ctx): SvgResult {
  const { spec, doc, pal, W, H } = ctx;
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun: ctx.checks, issues: ctx.issues } };
}

/** Ukuran huruf efektif: tidak pernah di bawah lantai P7-36 templat. */
export function pt(ctx: K2Ctx, size: number): number {
  return Math.max(size, ctx.minFontPt);
}

export function report(ctx: K2Ctx, checkId: string, detail: string): void {
  if (!ctx.checks.includes(checkId)) ctx.checks.push(checkId);
  ctx.issues.push({ checkId, status: "REPORT", detail });
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

// ── Parameter ─────────────────────────────────────────────────────────────

/**
 * Pembaca parameter: API baca tunggal inti (`core/read.ts`, S84 #8). Alias pendek
 * (termasuk bekas kunci lokal K-08 `grid`/`icon`/`caption`, K-11 `accentLink`, K-12
 * `widths`, kini ParamDef registri) dipindah resolver core.
 */
export { kindBool, kindInt, kindStr, kindValue as kindParam } from "../core/read";

/** Galat parameter seragam inti; kunci = kunci penuh bila ParamDef, selain itu `params.<nama>`. */
export function invalidParam(ctx: K2Ctx, name: string, v: unknown, expected: string): StudioEngineError {
  const full = kindKey(ctx.code, name);
  return coreInvalidParam(ctx.spec, PARAMS_BY_KEY.has(full) ? full : `params.${name}`, v, expected);
}

/** Kisi "RxC" (string registri K-07) atau [baris, kolom] (spec galeri); 1..40 per sisi. */
export function kindGrid(ctx: K2Ctx, name: string): { rows: number; cols: number } | undefined {
  const v = kindValue(ctx, name);
  if (v === undefined) return undefined;
  let rows: unknown;
  let cols: unknown;
  if (typeof v === "string") {
    const m = /^([0-9]+)x([0-9]+)$/.exec(v.trim());
    if (m) {
      rows = Number(m[1]);
      cols = Number(m[2]);
    }
  } else if (Array.isArray(v) && v.length === 2) {
    [rows, cols] = v;
  }
  const ok = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 40;
  if (!ok(rows) || !ok(cols)) throw invalidParam(ctx, name, v, '"RxC" atau [baris, kolom] dengan 1..40');
  return { rows, cols };
}

// ── Aksen tingkat spec ────────────────────────────────────────────────────

export interface AccentHint {
  /** Label/id titik, atau indeks 0-based. */
  point?: string | number;
  group?: string;
  series?: string;
}

/** Petunjuk aksen dari pengurai tunggal inti (`accentOf`, S84 #1); `undefined` bila tidak ada. */
export function accentHint(spec: StudioChartV1): AccentHint | undefined {
  return accentOf(spec);
}

/** Indeks `target` di `labels` (label persis, atau indeks bulat); -1 bila tidak cocok. */
export function resolveTarget(target: string | number | undefined, labels: readonly string[]): number {
  if (target === undefined) return -1;
  if (typeof target === "number") return target >= 0 && target < labels.length ? target : -1;
  return labels.indexOf(target);
}

export function hintMiss(ctx: K2Ctx, what: string): void {
  report(ctx, "ACCENT_HINT", `petunjuk aksen ${what} tidak cocok dengan data; diabaikan`);
}

/** Penjaga DATUM-26: subjek beraksen (unik) <= maks. */
export function assertAccentCount(ctx: K2Ctx, subjects: ReadonlySet<string>): void {
  if (subjects.size > ctx.maxAccent) {
    throw defect("DATUM-26", `${ctx.fid} — ${subjects.size} subjek beraksen (${[...subjects].join(", ")}); maks ${ctx.maxAccent} aksen per gambar`, {
      code: ctx.code,
      accents: subjects.size,
    });
  }
}

// ── Data ──────────────────────────────────────────────────────────────────

/**
 * Titik kategorikal tervalidasi (core `requireCategorical`) + nilai >= 0 + petunjuk aksen
 * titik (`accent.point` label/indeks). Petunjuk grup ditangani pemanggil (K-09).
 */
export function categoricalPoints(ctx: K2Ctx): CategoricalPoint[] {
  const pts = requireCategorical(ctx.spec, ctx.code, ctx.maxAccent);
  const neg = pts.findIndex((p) => p.value < 0);
  if (neg >= 0) {
    throw defect(ctx.code, `${ctx.fid} — ${ctx.code}: nilai negatif pada titik ${neg}; komposisi hanya menerima nilai >= 0`, {
      code: ctx.code,
      index: neg,
    });
  }
  const hint = accentHint(ctx.spec);
  if (hint?.point === undefined) return pts;
  const i = resolveTarget(hint.point, pts.map((p) => p.label));
  if (i < 0) {
    hintMiss(ctx, `titik ${JSON.stringify(hint.point)}`);
    return pts;
  }
  const out = pts.map((p, k) => (k === i ? { ...p, accent: true } : p));
  assertAccentCount(ctx, new Set(out.flatMap((p, k) => (p.accent ? [`titik ${k}`] : []))));
  return out;
}

export function sum(vs: readonly number[]): number {
  return vs.reduce((a, b) => a + b, 0);
}

/**
 * Bagi `units` unit bulat ke bagian sebanding `values` dengan metode sisa terbesar
 * (jumlah tepat `units`; seri sisa diputus indeks terkecil, deterministik).
 */
export function largestRemainder(values: readonly number[], units: number): { counts: number[]; inexact: boolean } {
  const total = sum(values);
  const exact = values.map((v) => (total > 0 ? (v / total) * units : 0));
  const counts = exact.map((e) => Math.floor(e + 1e-9));
  let left = units - sum(counts);
  const order = exact
    .map((e, i) => ({ r: e - counts[i], i }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0 && k < order.length; k++, left--) counts[order[k].i]++;
  const inexact = exact.some((e) => Math.abs(e - Math.round(e)) > 1e-9);
  return { counts, inexact };
}

// ── Warna ─────────────────────────────────────────────────────────────────

/**
 * Urutan warna non-aksen per gaya (semua ramp tinta = satu keluarga warna, K-32).
 * `gallery` diberikan pemanggil sesuai panel Gambar 8.3; datum = ink900, ink400, ink200, ink100.
 */
export function contextShades(ctx: K2Ctx, gallery: readonly string[]): readonly string[] {
  const { pal } = ctx;
  return ctx.style === "gallery" ? gallery : [pal.ink900, pal.ink400, pal.ink200, pal.ink100];
}

/**
 * Warna per bagian: aksen -> peran accent; lainnya bergiliran pada `shades`.
 * Bagian non-aksen > jumlah rona -> DATUM-25 (warna bagian harus terbedakan).
 */
export function partColours(ctx: K2Ctx, accents: readonly boolean[], shades: readonly string[]): string[] {
  const nonAccent = accents.filter((a) => !a).length;
  if (nonAccent > shades.length) {
    throw defect("DATUM-25", `${ctx.fid} — ${ctx.code}: ${nonAccent} bagian non-aksen > ${shades.length} rona yang terbedakan; gabungkan bagian kecil`, {
      code: ctx.code,
      parts: accents.length,
    });
  }
  let k = 0;
  return accents.map((a) => (a ? ctx.pal.role.accent : shades[k++]));
}

/** Warna teks di atas isian: kertas pada isian gelap, ink900 pada isian terang (luminans relatif). */
export function inkOn(ctx: K2Ctx, fillHex: string): string {
  const h = fillHex.replace(/^#/, "");
  const lin = (i: number): number => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const lum = 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
  return lum < 0.3 ? ctx.pal.paper : ctx.pal.ink900;
}
