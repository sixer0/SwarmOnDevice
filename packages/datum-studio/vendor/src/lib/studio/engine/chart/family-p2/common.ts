/**
 * engine/chart/family-p2 — helper bersama keluarga P-09, P-10, P-12..P-15 (S34, I24).
 *
 * Konvensi mengikuti chart/core (S32): 1 satuan pengguna = 1 mm, ukuran huruf pt FISIK
 * (tidak pernah di bawah `chart.minFontPt`, P7-36), garis >= 0,18 mm (lint 27), setiap
 * tanda data membawa `data-mark`/`data-series`/`data-index` (N2), sumbu `data-axis`.
 * Helper inti diimpor dari berkas helper core (bukan core/index) agar keluarga tidak ikut
 * siklus impor contract/dispatch.
 *
 * Parameter (D-58, D-87): resolver tunggal chart/core (`core/params.ts`) dijalankan sebelum
 * renderer: alias pendek sah sudah berada di kunci penuh `chart.kind.<KODE>.<nama>`, petunjuk
 * data per kode (`CHART_DATA_HINT_KEYS`, mis. `targets`, `axis`, `colourRule`) diteruskan,
 * kunci lain dibuang + REPORT `PARAM_IGNORED` (tidak pernah ditolak).
 */
import type { ChartCanvas, ChartCode, LintIssue, ParamValue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { normalizeHex, resolveColorToken } from "../../tokens/color";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type ChartPalette, chartPalette } from "../core/palette";
import { chartFloors } from "../core/prepare";
import { SvgDoc, ptToMm, midBaseline } from "../core/svg";
import { accentOf } from "../core/params";
import { kindBool as coreKindBool, kindValue } from "../core/read";

export type P2Code = "P-09" | "P-10" | "P-12" | "P-13" | "P-14" | "P-15";
export type P2Style = "datum" | "gallery";



/** Garis rambut sumbu (mm) dan garis kisi (mm, = lantai lint 27). */
export const HAIR_MM = 0.25;
export const GRID_MM = 0.18;

export interface P2Ctx {
  code: P2Code;
  spec: StudioChartV1;
  tpl: ResolvedTemplate;
  style: P2Style;
  pal: ChartPalette;
  W: number;
  H: number;
  /** Tinggi pita bawah yang dipakai aparatus "figure" dan `note` (mm). */
  footBand: number;
  minFontPt: number;
  maxAccent: number;
  doc: SvgDoc;
  issues: LintIssue[];
  checks: string[];
  /** Ukuran huruf efektif: tidak pernah di bawah lantai `chart.minFontPt`. */
  pt(size: number): number;
}

export function beginP2(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, code: P2Code): P2Ctx {
  const style: P2Style = (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
  const pal = chartPalette(spec, tpl);
  const floors = chartFloors(spec, tpl);
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = new SvgDoc(W, H, `data-chart="${code}" data-style="${style}"`, floors.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  const footBand = figureFootMm(spec) + (spec.note ? 5 : 0);
  return {
    code,
    spec,
    tpl,
    style,
    pal,
    W,
    H,
    footBand,
    minFontPt: floors.minFontPt,
    maxAccent: floors.maxAccent,
    doc,
    issues: [],
    checks: [],
    pt: (size: number) => Math.max(size, floors.minFontPt),
  };
}

/** Catatan, aparatus "figure", lalu hasil renderer (lint keluaran dijalankan pemanggil). */
export function finishP2(ctx: P2Ctx): SvgResult {
  const { spec, doc, pal, W, H } = ctx;
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun: [...new Set(ctx.checks)], issues: ctx.issues } };
}

/** Temuan REPORT (tidak menghentikan render). */
export function reportIssue(ctx: P2Ctx, checkId: string, detail: string): void {
  ctx.checks.push(checkId);
  ctx.issues.push({ checkId, status: "REPORT", detail });
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

// ── Parameter ──────────────────────────────────────────────────────────────

/** Nilai parameter registri kode (API baca tunggal inti `core/read.ts`, S84 #8). */
export function kindParam(spec: StudioChartV1, tpl: ResolvedTemplate, code: P2Code, name: string): ParamValue | undefined {
  return kindValue({ spec, tpl, code }, name);
}

export function kindBool(spec: StudioChartV1, tpl: ResolvedTemplate, code: P2Code, name: string, fallback: boolean): boolean {
  return coreKindBool({ spec, tpl, code }, name, fallback);
}

/** Petunjuk data non-registri (`CHART_DATA_HINT_KEYS` core) dan validator pasangan (inti). */
export { asRange, hintValue as hint, hintNum as hintNumber } from "../core/read";

// ── Aksen (medan `accent`, alias params, D-58) ────────────────────────────

export interface AccentHint {
  /** Label kategori/titik atau indeks. */
  point?: string | number;
  group?: string;
  series?: string;
}

/**
 * Petunjuk aksen tingkat spec dari pengurai tunggal inti (`accentOf`, S84 #1); lalu
 * petunjuk data kode `accentCategory` (P-14) bila tidak ada titik.
 */
export function accentHint(spec: StudioChartV1, code: P2Code): AccentHint {
  const out: AccentHint = { ...(accentOf(spec) ?? {}) };
  if (code === "P-14" && out.point === undefined) {
    const ac = spec.params?.accentCategory;
    if (typeof ac === "string" || typeof ac === "number") out.point = ac;
  }
  return out;
}

/** Cocokkan petunjuk titik (label atau indeks) ke butir ke-i. */
export function hintMatches(h: string | number | undefined, label: string | undefined, i: number): boolean {
  if (h === undefined) return false;
  return typeof h === "number" ? h === i : h === label;
}

/** Penjaga aksen per gambar (DATUM-26, P7-06). */
export function assertAccentCount(spec: StudioChartV1, code: P2Code, subjects: number, maxAccent: number, what: string): void {
  if (subjects > maxAccent) {
    throw defect("DATUM-26", `${figureLabel(spec)} — ${code}: ${subjects} ${what} beraksen; maks ${maxAccent} aksen per gambar (§03 §2)`, {
      code,
      accents: subjects,
    });
  }
}

// ── Warna ──────────────────────────────────────────────────────────────────

const PALETTE_KEYS = ["paper", "ink900", "ink700", "ink400", "ink200", "ink100", "signal", "alert", "verd"] as const;

/** tokenRef/hex -> "RRGGBB": token palet, peran chart (`accent`, ...), templat, hex literal. */
export function tokenHex(ctx: Pick<P2Ctx, "pal" | "tpl" | "spec">, ref: ParamValue | undefined, what: string): string {
  if (typeof ref === "string") {
    if ((PALETTE_KEYS as readonly string[]).includes(ref)) return ctx.pal[ref as (typeof PALETTE_KEYS)[number]];
    if (ref in ctx.pal.role) return ctx.pal.role[ref as keyof ChartPalette["role"]];
    const hex = normalizeHex(ref) ?? resolveColorToken(ctx.tpl.params, ref);
    if (hex) return hex.replace(/^#/, "").toUpperCase();
  }
  throw new StudioEngineError("SCHEMA_INVALID", `${figureLabel(ctx.spec)} — warna ${what} = ${JSON.stringify(ref)} tidak dapat diselesaikan ke hex`, {
    key: what,
  });
}

/** Luminans relatif sRGB (WCAG) hex "RRGGBB". */
export function luminance(hex: string): number {
  const h = hex.replace(/^#/, "");
  const ch = [0, 2, 4].map((o) => parseInt(h.slice(o, o + 2), 16) / 255);
  const lin = ch.map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** Warna teks di atas isian: kertas pada isian gelap, ink900 pada isian terang. */
export function textOn(fillHex: string, pal: ChartPalette): string {
  return luminance(fillHex) < 0.3 ? pal.paper : pal.ink900;
}

// ── Sumbu ──────────────────────────────────────────────────────────────────

/** Huruf tick: galeri 6,0 pt Plex Sans Condensed; datum 6,5 pt Plex Mono (angka = mono, PC:132-139). */
export function tickFont(ctx: P2Ctx): { sizePt: number; face: "struct" | "data" } {
  return ctx.style === "gallery" ? { sizePt: ctx.pt(6.0), face: "struct" } : { sizePt: ctx.pt(6.5), face: "data" };
}

/** Warna dan tebal garis sumbu: galeri ink900 (peran textAxis) 0,25 mm; datum ink400 0,6 pt (PC:109). */
export function axisStroke(ctx: P2Ctx): { color: string; width: number } {
  return ctx.style === "gallery" ? { color: ctx.pal.role.textAxis, width: HAIR_MM } : { color: ctx.pal.ink400, width: Math.max(GRID_MM, ptToMm(0.6)) };
}

export interface AxisOpts {
  /** Posisi garis sumbu (y untuk sumbu x, x untuk sumbu y). */
  at: number;
  from: number;
  to: number;
  scale: (v: number) => number;
  ticks: readonly number[];
  label: (v: number) => string;
  /** Tanda tick (galeri) 0,9 mm. */
  tickMarks?: boolean;
  /** Tanpa label tick. */
  bare?: boolean;
  /** Ukuran huruf tick (pt fisik) bila beda dari bawaan gaya; tetap dijepit lantai. */
  sizePt?: number;
  /**
   * FIG-02c (opsional, sumbu x): teks lengkap label yang dipotong -> `<g data-fit="ellipsis"><title>`.
   * Bila diisi, label digambar lewat `textLines`; tanpa medan ini jalur lama tidak berubah.
   */
  labelTitle?: (v: number) => string | undefined;
  /** FIG-02c (opsional, sumbu x): x label tick bila beda dari `scale(v)` (mis. dijepit ke sel panel). */
  labelAt?: (v: number) => number;
}

/** Sumbu x mendatar: garis + label tick di bawahnya. */
export function xAxis(ctx: P2Ctx, o: AxisOpts): void {
  const { doc } = ctx;
  const st = axisStroke(ctx);
  const tf = { ...tickFont(ctx), ...(o.sizePt !== undefined ? { sizePt: ctx.pt(o.sizePt) } : {}) };
  doc.open('data-axis="x"');
  doc.line(o.from, o.at, o.to, o.at, st.color, st.width);
  for (const t of o.ticks) {
    const x = o.scale(t);
    if (o.tickMarks) doc.line(x, o.at, x, o.at + 0.9, st.color, st.width);
    if (o.bare) continue;
    if (o.labelTitle || o.labelAt) {
      const lx = o.labelAt ? o.labelAt(t) : x;
      const opts = { sizePt: tf.sizePt, face: tf.face, fill: ctx.pal.ink400, anchor: "middle" as const };
      doc.textLines(lx, o.at + (o.tickMarks ? 3.8 : 3.4), [o.label(t)], opts, ptToMm(tf.sizePt) * 1.2, o.labelTitle?.(t));
    } else doc.text(x, o.at + (o.tickMarks ? 3.8 : 3.4), o.label(t), { sizePt: tf.sizePt, face: tf.face, fill: ctx.pal.ink400, anchor: "middle" });

  }
  doc.close();
}

/** Sumbu y tegak: garis + label tick di kirinya. */
export function yAxis(ctx: P2Ctx, o: AxisOpts): void {
  const { doc } = ctx;
  const st = axisStroke(ctx);
  const tf = { ...tickFont(ctx), ...(o.sizePt !== undefined ? { sizePt: ctx.pt(o.sizePt) } : {}) };
  doc.open('data-axis="y"');
  doc.line(o.at, o.from, o.at, o.to, st.color, st.width);
  for (const t of o.ticks) {
    const y = o.scale(t);
    if (o.tickMarks) doc.line(o.at - 0.9, y, o.at, y, st.color, st.width);
    if (!o.bare) doc.text(o.at - (o.tickMarks ? 1.6 : 1.0), mid(y, tf.sizePt), o.label(t), { sizePt: tf.sizePt, face: tf.face, fill: ctx.pal.ink400, anchor: "end" });
  }
  doc.close();
}

/** Garis kisi ink200 (dekorasi; PC style_ax). `vertical` = garis tegak di setiap tick x. */
export function gridLines(ctx: P2Ctx, vertical: boolean, positions: readonly number[], from: number, to: number): void {
  const { doc, pal } = ctx;
  doc.open('data-grid="1"');
  for (const p of positions) {
    if (vertical) doc.line(p, from, p, to, pal.ink200, GRID_MM);
    else doc.line(from, p, to, p, pal.ink200, GRID_MM);
  }
  doc.close();
}

// ── Validasi bentuk data ──────────────────────────────────────────────────

export interface SeriesData {
  categories: string[];
  series: Array<{ name: string; values: Array<number | null>; accent: boolean }>;
}

export function requireSeries(spec: StudioChartV1, code: ChartCode): SeriesData {
  const fid = figureLabel(spec);
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "series") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "series", diterima "${d.shape}"`, { code, shape: d.shape });
  }
  if (!Array.isArray(d.categories) || d.categories.length === 0 || !Array.isArray(d.series) || d.series.length === 0) {
    throw defect("DC-G1", `${fid} — grafik tanpa data`, { code });
  }
  d.categories.forEach((c, i) => {
    if (typeof c !== "string") throw new StudioEngineError("SCHEMA_INVALID", `${fid} — kategori ${i} bukan string`, { code, index: i });
  });
  const series = d.series.map((s, si) => {
    if (typeof s?.name !== "string" || !Array.isArray(s.values)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — seri ${si} tanpa nama atau nilai`, { code, series: si });
    }
    if (s.values.length !== d.categories.length) {
      throw new StudioEngineError(
        "SCHEMA_INVALID",
        `${fid} — seri "${s.name}" memuat ${s.values.length} nilai untuk ${d.categories.length} kategori`,
        { code, series: si },
      );
    }
    const values = s.values.map((v, vi) => {
      if (v === null) return null;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        throw defect("DC-G1", `${fid} — seri "${s.name}" nilai ${vi} bukan bilangan hingga`, { code, series: si, index: vi });
      }
      return v;
    });
    return { name: s.name, values, accent: s.accent === true };
  });
  return { categories: [...d.categories], series };
}

export interface XyPoint {
  x: number;
  y: number;
  label?: string;
  group?: string;
  accent: boolean;
}

export function requireXy(spec: StudioChartV1, code: ChartCode): XyPoint[] {
  const fid = figureLabel(spec);
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "xy") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "xy", diterima "${d.shape}"`, { code, shape: d.shape });
  }
  if (!Array.isArray(d.points) || d.points.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa data`, { code });
  return d.points.map((p, i) => {
    if (typeof p?.x !== "number" || typeof p?.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw defect("DC-G1", `${fid} — titik ${i} tanpa x/y hingga`, { code, index: i });
    }
    return {
      x: p.x,
      y: p.y,
      ...(typeof p.label === "string" ? { label: p.label } : {}),
      ...(typeof p.group === "string" ? { group: p.group } : {}),
      accent: p.accent === true,
    };
  });
}
