/**
 * engine/chart/family-w2 — kerangka bersama W-06..W-10 (S40).
 *
 * Memakai helper inti S32 (SvgDoc mm + pt fisik, palet/peran warna, aparatus, penjaga);
 * tidak menduplikasi. Yang ditambahkan di sini hanya yang khusus keluarga:
 *
 * - **Subjek aksen.** Lint DATUM-26 menghitung subjek beraksen sebagai pasangan
 *   `data-series#data-index`. Pada keluarga ini satu subjek digambar oleh beberapa tanda
 *   (garis + titik bump, badan + sumbu candlestick, deret barcode, pita horizon), sehingga
 *   `data-index` = indeks SUBJEK (seri / tugas / jenis kejadian / titik OHLC), sedangkan
 *   posisi di dalam subjek ditulis di `data-period` / `data-event` / `data-band`.
 * - **Petunjuk aksen** (D-58, delta S03-d1): aksen ter-normalisasi inti (`accentOf`:
 *   medan `accent` > `accent.*` > alias params, S84 #1).
 * - **Parameter.** Bekas kunci tertunda `chart.kind.W-07.todayAt|todayLabel`,
 *   `chart.kind.W-08.riskyTypes|highlightWindow` kini ParamDef registri (IP-25) dan dibaca
 *   lewat `chartParam` seperti parameter lain. Alias pendek dan kunci tak dikenal
 *   diselesaikan resolver tunggal chart/core (`core/params.ts`, D-87).
 */
import type { ChartCanvas, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { figureFootMm, apparatusMarker, figureApparatus, noteLine } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type ChartPalette, chartPalette } from "../core/palette";
import { chartFloors } from "../core/prepare";
import { SvgDoc, midBaseline } from "../core/svg";
import { accentOf } from "../core/params";

export type W2Code = "W-06" | "W-07" | "W-08" | "W-09" | "W-10";

// ── Aksen ──────────────────────────────────────────────────────────────────

export interface AccentHint {
  point?: string | number;
  group?: string;
  series?: string;
}

/** Petunjuk aksen dari pengurai tunggal inti (`accentOf`, S84 #1). */
export function accentHint(spec: StudioChartV1): AccentHint {
  return { ...(accentOf(spec) ?? {}) };
}

/** Penjaga maks subjek beraksen (P7-06, DATUM-26). */
export function assertAccentCount(spec: StudioChartV1, code: W2Code, n: number, maxAccent: number, what: string): void {
  if (n > maxAccent) {
    throw defect("DATUM-26", `${figureLabel(spec)} — ${code}: ${n} ${what} beraksen; maks ${maxAccent} aksen per gambar`, { code, accents: n });
  }
}

// ── Kerangka SVG ─────────────────────────────────────────────────────────────

export interface Frame {
  code: W2Code;
  doc: SvgDoc;
  pal: ChartPalette;
  gallery: boolean;
  W: number;
  H: number;
  /** Batas bawah area gambar (di atas catatan dan aparatus figure). */
  bottom: number;
  maxAccent: number;
  issues: LintIssue[];
}

export function openFrame(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate, code: W2Code): Frame {
  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const gallery = (spec.style ?? "datum") === "gallery";
  const pal = chartPalette(spec, tpl);
  const floors = chartFloors(spec, tpl);
  const doc = new SvgDoc(W, H, `data-chart="${code}" data-style="${gallery ? "gallery" : "datum"}"`, floors.minFontPt);
  if ((spec.apparatus ?? "page") === "page") apparatusMarker(doc, spec);
  doc.paper(pal.paper);
  const foot = figureFootMm(spec) + (spec.note ? 5 : 0);
  return { code, doc, pal, gallery, W, H, bottom: H - foot, maxAccent: floors.maxAccent, issues: [] };
}

export function closeFrame(f: Frame, spec: StudioChartV1): SvgResult {
  if (spec.note) noteLine(f.doc, spec.note, f.W, f.H - figureFootMm(spec) - 1.4, f.pal);
  if (spec.apparatus === "figure") figureApparatus(f.doc, spec, f.pal, f.H);
  const checksRun = [...new Set(f.issues.map((i) => i.checkId))];
  return { svg: f.doc.toString(), widthMm: f.W, heightMm: f.H, report: { checksRun, issues: f.issues } };
}

/** Garis dasar teks tegak-tengah (definisi tunggal inti). */
export const mid = midBaseline;

/** Data wajib dengan bentuk tertentu; selain itu SCHEMA_INVALID. */
export function requireShape<S extends NonNullable<StudioChartV1["data"]>["shape"]>(
  spec: StudioChartV1,
  code: W2Code,
  shape: S,
): Extract<NonNullable<StudioChartV1["data"]>, { shape: S }> {
  const d = spec.data;
  const fid = figureLabel(spec);
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== shape) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "${shape}", diterima "${d.shape}"`, {
      code,
      shape: d.shape,
    });
  }
  return d as Extract<NonNullable<StudioChartV1["data"]>, { shape: S }>;
}

/** Bilangan hingga atau null (seri bercelah). */
export function finiteOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** String tidak kosong atau `undefined`. */
export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
