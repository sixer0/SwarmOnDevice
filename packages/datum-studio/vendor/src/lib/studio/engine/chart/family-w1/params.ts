/**
 * engine/chart/family-w1 — parameter khusus registri, petunjuk aksen, dan kunci
 * `params` yang diabaikan (S39).
 *
 * Resolusi parameter kode (registri S09, `chart.kind.<KODE>.<nama>`):
 *   spec.params[kunci penuh] -> tpl.params[kunci penuh] -> default ParamDef.
 * Nilai bertipe salah atau di luar `range` ParamDef -> SCHEMA_INVALID (tidak diam-diam
 * diganti default).
 *
 * Alias pendek (mis. `labelAtLineEnd` pada panel galeri S94) dan kunci tak dikenal
 * diselesaikan resolver tunggal chart/core (`core/params.ts`, D-87) sebelum renderer:
 * PARAM_ALIAS / PARAM_IGNORED dilaporkan di sana.
 */
import type { ResolvedTemplate, StudioChartV1 } from "../../../contract";
import { accentOf } from "../core/params";
import { kindBool, kindInt } from "../core/read";

export type W1Code = "W-01" | "W-03" | "W-04" | "W-05";

/** Boolean khusus kode (API baca tunggal inti `core/read.ts`, S84 #8). */
export function w1Bool(spec: StudioChartV1, tpl: ResolvedTemplate, code: W1Code, name: string, fallback: boolean): boolean {
  return kindBool({ spec, tpl, code }, name, fallback);
}

/** Bilangan bulat khusus kode dengan cek `range` ParamDef (API baca tunggal inti). */
export function w1Int(spec: StudioChartV1, tpl: ResolvedTemplate, code: W1Code, name: string, fallback: number): number {
  return kindInt({ spec, tpl, code }, name, fallback);
}

// ── Petunjuk aksen (delta S03-d1, D-58) ───────────────────────────────────

export interface AccentRequest {
  /** Nama seri beraksen (W-01, W-03, W-05). */
  series?: string;
  /** Titik beraksen: label kategori (mentah) atau indeks 0-based; `series` opsional. */
  point?: { at: string | number; series?: string };
  /** Label/nama grup (dibaca sebagai nama seri pada data series, label titik pada W-04). */
  group?: string;
}


/**
 * Petunjuk aksen dari pengurai tunggal inti (`accentOf`, S84 #1). `point` + `series` =
 * titik di dalam seri itu; `series` saja = seluruh seri; `group` = nama seri (data
 * series) atau label titik (W-04).
 */
export function accentRequest(spec: StudioChartV1): AccentRequest {
  const a = accentOf(spec);
  if (!a) return {};
  if (a.point !== undefined) {
    return { point: { at: a.point, ...(a.series !== undefined ? { series: a.series } : {}) }, ...(a.group !== undefined ? { group: a.group } : {}) };
  }
  return { ...(a.series !== undefined ? { series: a.series } : {}), ...(a.group !== undefined ? { group: a.group } : {}) };
}
