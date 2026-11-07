/**
 * engine/chart/family-g — kerangka bersama G-01..G-04 (S43, I33).
 *
 * Semua satuan, palet, aparatus, dan penjaga berasal dari chart/core (S32): SvgDoc
 * (1 satuan pengguna = 1 mm, huruf pt fisik), peran warna P7, aparatus page/figure.
 * Berkas ini hanya menambah yang khas keluarga G: validasi bentuk `tiles`, geometri
 * grid petak, petunjuk aksen tingkat spec, parameter registri, dan penyesuaian huruf.
 *
 * Parameter registri `chart.kind.<KODE>.<nama>` berlaku penuh di kedua gaya (spec.params
 * -> tpl.params -> default registri): resep acuan pustakachart v84/v81 sama dengan
 * default registri, sehingga tidak ada pemisahan "hanya eksplisit" seperti family-p1.
 * Kunci `params` diselesaikan resolver tunggal chart/core (`core/params.ts`, D-87): alias
 * pendek sah (mis. `standardAbbrev`) dipindah ke kunci penuh + PARAM_ALIAS, lainnya
 * PARAM_IGNORED (D-58); alias aksen kontrak (`accentPoint`, `accentGroup`) dibaca.
 *
 * Deterministik: tanpa acak, tanpa waktu; urutan elemen = urutan data.
 */
import type { ChartCanvas, ChartData, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type ChartPalette, chartPalette } from "../core/palette";
import { accentOf } from "../core/params";
import { chartFloors } from "../core/prepare";
import { SvgDoc, textWidthMm, midBaseline } from "../core/svg";

export type GCode = "G-01" | "G-02" | "G-03" | "G-04";
export type GStyle = "datum" | "gallery";

export type TilesData = Extract<ChartData, { shape: "tiles" }>;
export type Tile = TilesData["tiles"][number];

export interface GCtx {
  code: GCode;
  spec: StudioChartV1;
  tpl: ResolvedTemplate;
  style: GStyle;
  pal: ChartPalette;
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

/** Ukuran huruf dasar (pt fisik). Gallery mengikuti panel Gambar 8.5; datum mengikuti PC v81/v84. */
export const TYPE_PT = {
  gallery: { label: 6.0, value: 5.8, node: 6.4, edge: 6.0 },
  datum: { label: 6.0, value: 5.8, node: 6.8, edge: 6.2 },
} as const;

/** Rambut garis (mm); lantai fotokopi 0,18 mm (DATUM-27). */
export const HAIR_MM = 0.25;

export function beginChart(code: GCode, spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, rootExtra = ""): GCtx {
  const style: GStyle = (spec.style ?? "datum") === "gallery" ? "gallery" : "datum";
  const floors = chartFloors(spec, tpl);
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = new SvgDoc(W, H, `data-chart="${code}" data-style="${style}"${rootExtra ? ` ${rootExtra}` : ""}`, floors.minFontPt);
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

export function endChart(ctx: GCtx): SvgResult {
  const { spec, doc, pal, W, H } = ctx;
  if (spec.note) noteLine(doc, spec.note, W, H - figureFootMm(spec) - 1.4, pal);
  if (spec.apparatus === "figure") figureApparatus(doc, spec, pal, H);
  return { svg: doc.toString(), widthMm: W, heightMm: H, report: { checksRun: ctx.checks, issues: ctx.issues } };
}

export function ran(ctx: GCtx, checkId: string): void {
  if (!ctx.checks.includes(checkId)) ctx.checks.push(checkId);
}

export function report(ctx: GCtx, checkId: string, detail: string): void {
  ran(ctx, checkId);
  ctx.issues.push({ checkId, status: "REPORT", detail });
}

/** Ukuran huruf efektif: tidak pernah di bawah lantai P7-36 templat. */
export function pt(ctx: GCtx, size: number): number {
  return Math.max(size, ctx.minFontPt);
}

// ── Parameter registri: API baca tunggal inti (`core/read.ts`, S84 #8) ─────

export { kindBool, kindInt, kindStr } from "../core/read";

// ── Aksen tingkat spec (D-58, delta S03-d1) ───────────────────────────────

export interface GAccentHint {
  /** Titik: label/kode/indeks 0-based (G-01 petak, G-02 titik, G-03 aliran, G-04 simpul). */
  point?: string | number;
  /** Grup: kode petak (G-01..G-03) atau id simpul (G-04). */
  group?: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/** Petunjuk aksen dari pengurai tunggal inti (`accentOf`, S84 #1); `undefined` bila tidak ada. */
export function accentHint(spec: StudioChartV1): GAccentHint | undefined {
  const a = accentOf(spec);
  if (!a || (a.point === undefined && a.group === undefined)) return undefined;
  return { ...(a.point !== undefined ? { point: a.point } : {}), ...(a.group !== undefined ? { group: a.group } : {}) };
}

export function hintMiss(ctx: GCtx, what: string): void {
  report(ctx, "ACCENT_HINT", `petunjuk aksen ${what} tidak cocok dengan data; diabaikan`);
}

/** Penjaga DATUM-26: subjek beraksen (unik) <= maks. */
export function assertAccentCount(ctx: GCtx, subjects: readonly string[]): void {
  ran(ctx, "DATUM-26");
  if (subjects.length > ctx.maxAccent) {
    throw defect("DATUM-26", `${ctx.fid} — ${subjects.length} subjek beraksen (${subjects.join(", ")}); maks ${ctx.maxAccent} aksen per gambar`, {
      code: ctx.code,
      accents: subjects.length,
    });
  }
}

// ── Data tiles ────────────────────────────────────────────────────────────

/** Data `tiles` tervalidasi: kode unik, baris/kolom bulat >= 0, nilai hingga bila ada. */
export function requireTiles(ctx: GCtx): TilesData {
  const d = ctx.spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — ${ctx.code}: data wajib`, { code: ctx.code });
  if (d.shape !== "tiles") {
    throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — ${ctx.code} membutuhkan data "tiles", diterima "${d.shape}"`, {
      code: ctx.code,
      shape: d.shape,
    });
  }
  if (!Array.isArray(d.tiles) || d.tiles.length === 0) throw defect("DC-G1", `${ctx.fid} — grafik tanpa petak`, { code: ctx.code });
  const seen = new Set<string>();
  d.tiles.forEach((t, i) => {
    if (!nonEmpty(t?.code)) throw defect("DC-G1", `${ctx.fid} — petak ${i} tanpa kode`, { code: ctx.code, index: i });
    if (seen.has(t.code)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — kode petak "${t.code}" ganda; kode harus unik (label boleh sama)`, {
        code: ctx.code,
        index: i,
      });
    }
    seen.add(t.code);
    if (!Number.isInteger(t.row) || !Number.isInteger(t.col) || t.row < 0 || t.col < 0) {
      throw new StudioEngineError("SCHEMA_INVALID", `${ctx.fid} — petak "${t.code}": row/col harus bilangan bulat >= 0`, { code: ctx.code, index: i });
    }
    if (t.value !== undefined && (typeof t.value !== "number" || !Number.isFinite(t.value))) {
      throw defect("DC-G1", `${ctx.fid} — petak "${t.code}": nilai bukan bilangan hingga`, { code: ctx.code, index: i });
    }
  });
  const cells = new Map<string, string>();
  for (const t of d.tiles) {
    const k = `${t.row},${t.col}`;
    const other = cells.get(k);
    if (other !== undefined) report(ctx, "G-TILE-OVERLAP", `petak "${t.code}" menimpa "${other}" pada baris ${t.row} kolom ${t.col}`);
    else cells.set(k, t.code);
  }
  return d;
}

/** Label tampil petak (label, cadangan kode). */
export function tileLabel(t: Tile): string {
  return nonEmpty(t.label) ? t.label : t.code;
}

// ── Geometri grid ─────────────────────────────────────────────────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Grid {
  rows: number;
  cols: number;
  cellW: number;
  cellH: number;
  /** Kiri atas sel (baris, kolom) data. */
  cell(row: number, col: number): { x: number; y: number };
}

/**
 * Grid dari baris/kolom petak (rentang min..maks) di dalam `area`. `square` = petak
 * sama besar dan berpusat (G-01); selain itu sel merentang mengisi area (skematis
 * G-02/G-03, KT-12).
 */
export function gridOf(tiles: readonly Tile[], area: Box, square: boolean): Grid {
  const r0 = Math.min(...tiles.map((t) => t.row));
  const c0 = Math.min(...tiles.map((t) => t.col));
  const rows = Math.max(...tiles.map((t) => t.row)) - r0 + 1;
  const cols = Math.max(...tiles.map((t) => t.col)) - c0 + 1;
  let cellW = area.w / cols;
  let cellH = area.h / rows;
  if (square) cellW = cellH = Math.min(cellW, cellH);
  const x0 = area.x + (area.w - cellW * cols) / 2;
  const y0 = area.y + (area.h - cellH * rows) / 2;
  return { rows, cols, cellW, cellH, cell: (row, col) => ({ x: x0 + (col - c0) * cellW, y: y0 + (row - r0) * cellH }) };
}

// ── Teks ──────────────────────────────────────────────────────────────────

/**
 * Ukuran huruf terbesar <= `basePt` yang memuat `s` dalam `maxW` mm, tidak di bawah
 * lantai. `fits` = false bila pada lantai pun teks melebihi `maxW`.
 */
export function fitPt(ctx: GCtx, s: string, maxW: number, basePt: number, face: "struct" | "data" = "struct"): { size: number; fits: boolean } {
  const base = pt(ctx, basePt);
  const w = textWidthMm(s, base, face);
  if (w <= maxW) return { size: base, fits: true };
  const scaled = (base * maxW) / Math.max(w, 1e-9);
  const size = Math.max(ctx.minFontPt, Math.floor(scaled * 10) / 10);
  return { size, fits: textWidthMm(s, size, face) <= maxW + 1e-9 };
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

/** Hex peran untuk token tinta/aksen diagram (ink900, signal, alert, ...). */
export function tokenHex(pal: ChartPalette, token: string): string {
  switch (token) {
    case "paper":
      return pal.paper;
    case "ink900":
      return pal.ink900;
    case "ink700":
      return pal.ink700;
    case "ink400":
      return pal.ink400;
    case "ink200":
      return pal.ink200;
    case "ink100":
      return pal.ink100;
    case "signal":
      return pal.role.accent;
    case "alert":
      return pal.role.limitExceeded;
    case "verd":
      return pal.role.improving;
    default:
      return pal.ink700;
  }
}

/** Isian gelap -> teks kertas; isian terang -> tinta 900. */
export function inkOn(pal: ChartPalette, fill: string): string {
  return [pal.paper, pal.ink100, pal.ink200].includes(fill) ? pal.ink900 : pal.paper;
}
