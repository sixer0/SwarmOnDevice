/**
 * engine/chart/family-h1 — persiapan bersama H-01..H-05 (S35, I25).
 *
 * Parameter khusus kode dibaca dengan urutan: `spec.params["chart.kind.<KODE>.<nama>"]`
 * -> `tpl.params[...]` -> default ParamDef registri. Alias pendek (spec galeri S94) dan
 * kunci tak dikenal sudah diselesaikan resolver tunggal chart/core (`core/params.ts`,
 * D-87) sebelum renderer: PARAM_ALIAS / PARAM_IGNORED dilaporkan di sana.
 *
 * Aksen (D-58, delta S03-d1): medan `accent: true` per titik, `spec.accent`
 * (`point` label atau indeks, `group`, `series`), atau alias `params.accentPoint` /
 * `accentGroup` / `accentSeries` (diurai sekali oleh `accentOf` inti). Jumlah subjek beraksen > P7-06 -> DATUM-26.
 */
import type { LintIssue, ParamValue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { figureFootMm } from "../core/apparatus";
import { defect, figureLabel } from "../core/guards";
import { type ChartPalette, chartPalette } from "../core/palette";
import { accentOf } from "../core/params";
import { kindBool as coreKindBool, kindValue } from "../core/read";
import { chartFloors } from "../core/prepare";

export type H1Code = "H-01" | "H-02" | "H-03" | "H-04" | "H-05";
export type H1Style = "datum" | "gallery";

/**
 * Tinggi kanvas acuan pustakachart (`canvas(W, tinggi_mm)`, PC:992-1100) per kode; dipakai
 * fixture paritas CB1 (d) +/- 3 mm. Lebar acuan: H-03 166 mm, lainnya 128 mm.
 */
export const H1_REFERENCE_HEIGHT_MM: Readonly<Record<H1Code, number>> = {
  "H-01": 66,
  "H-02": 66,
  "H-03": 72,
  "H-04": 60,
  "H-05": 64,
};

/** Nilai parameter khusus kode (API baca tunggal inti `core/read.ts`, S84 #8). */
export function kindParam(spec: StudioChartV1, tpl: ResolvedTemplate, code: H1Code, name: string): ParamValue | undefined {
  return kindValue({ spec, tpl, code }, name);
}

/** Boolean khusus kode; tipe salah -> SCHEMA_INVALID (API baca tunggal inti). */
export function kindBool(spec: StudioChartV1, tpl: ResolvedTemplate, code: H1Code, name: string, fallback: boolean): boolean {
  return coreKindBool({ spec, tpl, code }, name, fallback);
}

// ── Aksen ─────────────────────────────────────────────────────────────────

export interface AccentTarget {
  point?: string | number;
  group?: string;
  series?: string;
}

/** Target aksen tingkat spec dari pengurai tunggal inti (`accentOf`, S84 #1). */
export function accentTarget(spec: StudioChartV1): AccentTarget | undefined {
  return accentOf(spec);
}

// ── Persiapan ─────────────────────────────────────────────────────────────

export interface H1Prep {
  code: H1Code;
  style: H1Style;
  fid: string;
  pal: ChartPalette;
  maxAccent: number;
  minFontPt: number;
  maxColors: number;
  /** Pita kaki (catatan + aparatus figure), mm. */
  footBand: number;
  issues: LintIssue[];
}

export function prepH1(spec: StudioChartV1, tpl: ResolvedTemplate, code: H1Code): H1Prep {
  const floors = chartFloors(spec, tpl);
  return {
    code,
    style: (spec.style ?? "datum") === "gallery" ? "gallery" : "datum",
    fid: figureLabel(spec),
    pal: chartPalette(spec, tpl),
    ...floors,
    footBand: (spec.note ? 5 : 0) + figureFootMm(spec),
    issues: [],
  };
}

/** Hasil renderer + temuan prep; `checksRun` unik berurutan (PARAM_* dilaporkan resolver core). */
export function finishH1(res: Omit<SvgResult, "report">, prep: H1Prep): SvgResult {
  const issues = [...prep.issues];
  const checksRun = [...new Set(issues.map((i) => i.checkId))];
  return { ...res, report: { checksRun, issues } };
}

// ── Data xy ───────────────────────────────────────────────────────────────

export interface XyPoint {
  index: number;
  x: number;
  y: number;
  size?: number;
  label?: string;
  group?: string;
  accent: boolean;
}

/** Data `xy` tervalidasi + aksen diterapkan. */
export function requireXy(spec: StudioChartV1, prep: H1Prep, minPoints = 1): XyPoint[] {
  const { fid, code } = prep;
  const d = spec.data;
  if (!d) throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code}: data wajib`, { code });
  if (d.shape !== "xy") {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — ${code} membutuhkan data "xy", diterima "${d.shape}"`, { code, shape: d.shape });
  }
  if (!Array.isArray(d.points) || d.points.length === 0) throw defect("DC-G1", `${fid} — grafik tanpa data`, { code });
  if (d.points.length < minPoints) {
    throw defect("DC-G1", `${fid} — ${code} membutuhkan sedikitnya ${minPoints} titik, diterima ${d.points.length}`, { code });
  }
  const pts: XyPoint[] = d.points.map((p, i) => {
    if (typeof p?.x !== "number" || typeof p?.y !== "number" || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw defect("DC-G1", `${fid} — titik data ${i} tanpa x/y hingga`, { code, index: i });
    }
    if (p.size !== undefined && (typeof p.size !== "number" || !Number.isFinite(p.size) || p.size < 0)) {
      throw new StudioEngineError("SCHEMA_INVALID", `${fid} — titik ${i}: size harus bilangan hingga >= 0`, { code, index: i });
    }
    return {
      index: i,
      x: p.x,
      y: p.y,
      ...(p.size !== undefined ? { size: p.size } : {}),
      ...(typeof p.label === "string" && p.label ? { label: p.label } : {}),
      ...(typeof p.group === "string" && p.group ? { group: p.group } : {}),
      accent: p.accent === true,
    };
  });
  const t = accentTarget(spec);
  if (t) {
    for (const p of pts) {
      if (t.point !== undefined && (typeof t.point === "number" ? p.index === t.point : p.label === t.point)) p.accent = true;
      const grp = t.group ?? t.series;
      if (grp !== undefined && p.group === grp) p.accent = true;
    }
  }
  const n = pts.filter((p) => p.accent).length;
  if (n > prep.maxAccent) {
    throw defect("DATUM-26", `${fid} — ${n} titik beraksen; maks ${prep.maxAccent} aksen per gambar (§03 §2)`, { code, accents: n });
  }
  return pts;
}

/** Nama seri titik untuk atribut `data-series`. */
export function seriesOf(p: Pick<XyPoint, "group">): string {
  return p.group ?? "data";
}
