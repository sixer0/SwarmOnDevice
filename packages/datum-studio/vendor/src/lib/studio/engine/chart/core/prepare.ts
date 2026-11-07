/**
 * engine/chart/core — persiapan data kode inti P-01, P-02, P-11, W-02 (S32).
 *
 * Parameter registri yang dibaca (spec.params -> tpl.params -> default):
 * - P-01 `sort` (valueDesc | valueAsc | byDifference | natural; byDifference pada satu
 *   seri = valueDesc), `accent` (topBarOnly: bila tidak ada aksen eksplisit, batang
 *   teratas setelah urut diberi aksen; none: semua aksen dibuang), `valueLabel`
 *   (barEnd | inside | none);
 * - P-11 `limitLine.labelled` (cadangan P7-32), `overLimitColour` (cadangan peran
 *   limitExceeded);
 * - W-02 `maxPeriods` (maks 12 periode);
 * - petunjuk galeri (IP-41c): P-02/W-02 `valueLabel` (bool, label nilai kolom), P-11
 *   `axis` (domain tercetak [min, maks], core/scale.ts `axisDomain`);
 * - global P7-04 `chart.zeroBaseline`, P7-06 `chart.accent.maxSubjects`,
 *   P7-17 `chart.maxColors`, P7-36 `chart.minFontPt`.
 */
import type { ChartCode, ResolvedTemplate, StudioChartV1 } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import { type CategoricalPoint, assertNonNegative, defect, figureLabel, requireCategorical } from "./guards";
import { type ChartPalette, chartPalette, kindKey, paramBool, paramEnum, paramNum, resolveChartColor } from "./palette";
import { accentOf } from "./params";
import { kindAxis } from "./read";

export type CoreFamily = "bar" | "column" | "threshold";
export type CoreCode = "P-01" | "P-02" | "P-11" | "W-02";

export const CORE_FAMILY: Readonly<Record<CoreCode, CoreFamily>> = {
  "P-01": "bar",
  "P-02": "column",
  "P-11": "threshold",
  "W-02": "column",
};

export function isCoreCode(code: string): code is CoreCode {
  return Object.prototype.hasOwnProperty.call(CORE_FAMILY, code);
}

const SORT = ["valueDesc", "valueAsc", "byDifference", "natural"] as const;
const ACCENT = ["topBarOnly", "none"] as const;
const VALUE_LABEL = ["barEnd", "inside", "none"] as const;

export interface CorePrep {
  code: CoreCode;
  family: CoreFamily;
  pts: CategoricalPoint[];
  dec: number;
  unit: string;
  pal: ChartPalette;
  valueLabel: (typeof VALUE_LABEL)[number];
  /** P-02/W-02: label nilai di atas kolom (petunjuk `valueLabel`, bawaan true). */
  columnValueLabels: boolean;
  /** P-11: domain sumbu tercetak (petunjuk `axis`); `undefined` = domain otomatis. */
  axis: [number, number] | undefined;
  limit: number | null;
  limitLabel: string | undefined;
  limitLabelled: boolean;
  overColour: string;
  zero: boolean;
  maxAccent: number;
  minFontPt: number;
  maxColors: number;
}

/** Global P7 yang berlaku untuk semua kode (dipakai juga oleh renderChart/komposit). */
export function chartFloors(spec: StudioChartV1, tpl: ResolvedTemplate): { maxAccent: number; minFontPt: number; maxColors: number } {
  return {
    maxAccent: paramNum(spec, tpl, "chart.accent.maxSubjects", 1),
    minFontPt: Math.max(5.5, paramNum(spec, tpl, "chart.minFontPt", 5.5)),
    maxColors: paramNum(spec, tpl, "chart.maxColors", 5),
  };
}

export function prepareCore(spec: StudioChartV1, tpl: ResolvedTemplate, code: CoreCode): CorePrep {
  const fid = figureLabel(spec);
  const family = CORE_FAMILY[code];
  const floors = chartFloors(spec, tpl);
  let pts = applyAccentHint(spec, code, requireCategorical(spec, code, floors.maxAccent), floors.maxAccent);
  assertNonNegative(spec, code, pts);

  let valueLabel: CorePrep["valueLabel"] = "barEnd";
  if (code === "P-01") {
    const sort = paramEnum(spec, tpl, kindKey(code, "sort"), SORT, "valueDesc");
    if (sort !== "natural") {
      const dir = sort === "valueAsc" ? 1 : -1;
      // Urut stabil: indeks asal memutus seri (deterministik lintas mesin JS).
      pts = pts
        .map((p, i) => ({ p, i }))
        .sort((a, b) => (a.p.value - b.p.value) * dir || a.i - b.i)
        .map((x) => x.p);
    }
    const accent = paramEnum(spec, tpl, kindKey(code, "accent"), ACCENT, "topBarOnly");
    if (accent === "none") pts = pts.map((p) => ({ ...p, accent: false }));
    else if (!pts.some((p) => p.accent) && floors.maxAccent >= 1) pts = pts.map((p, i) => ({ ...p, accent: i === 0 }));
    valueLabel = paramEnum(spec, tpl, kindKey(code, "valueLabel"), VALUE_LABEL, "barEnd");
  }

  if (code === "W-02") {
    const maxPeriods = paramNum(spec, tpl, kindKey(code, "maxPeriods"), 12);
    if (pts.length > maxPeriods) {
      throw defect(kindKey(code, "maxPeriods"), `${fid} — ${pts.length} periode > ${maxPeriods}; ganti line (W-01)`, {
        code,
        periods: pts.length,
      });
    }
  }

  const limit = spec.limit ?? null;
  if (limit !== null && (typeof limit !== "number" || !Number.isFinite(limit))) {
    throw new StudioEngineError("SCHEMA_INVALID", `${fid} — limit bukan bilangan hingga`, { code });
  }
  if (family === "threshold" && limit === null) {
    throw defect("DC-G5", `${fid} — keluarga "threshold" tanpa nilai batas; sebuah batas yang tidak digambar bukan batas`, { code });
  }

  const pal = chartPalette(spec, tpl);
  const labelledKey = kindKey("P-11", "limitLine.labelled");
  const limitLabelled =
    code === "P-11"
      ? paramBool(spec, tpl, labelledKey, paramBool(spec, tpl, "chart.threshold.limitLineLabelled", true))
      : paramBool(spec, tpl, "chart.threshold.limitLineLabelled", true);
  const overColour =
    code === "P-11" ? resolveChartColor(spec, tpl, kindKey("P-11", "overLimitColour"), pal.role.limitExceeded) : pal.role.limitExceeded;

  return {
    code,
    family,
    pts,
    dec: spec.dec ?? 0,
    unit: spec.unit ?? "",
    pal,
    valueLabel,
    columnValueLabels: code === "P-02" || code === "W-02" ? paramBool(spec, tpl, kindKey(code, "valueLabel"), true) : true,
    axis: code === "P-11" ? kindAxis({ spec, tpl, code }) : undefined,
    limit,
    limitLabel: spec.limitLabel,
    limitLabelled,
    overColour,
    zero: paramBool(spec, tpl, "chart.zeroBaseline", true),
    ...floors,
  };
}

// ── Petunjuk aksen (D-58; satu pengurai `accentOf`, S84 #1) ───────────────

/**
 * Sasaran aksen kategori kode inti: `accent.point` (label atau indeks 0-based), lalu
 * `accent.group`. Aksen tingkat SERI tidak berlaku pada kode inti (satu seri) dan
 * dilaporkan `ACCENT_HINT` oleh renderer inti.
 */
export function accentHintTarget(spec: StudioChartV1): string | number | undefined {
  const a = accentOf(spec);
  return a?.point ?? a?.group;
}

/** Petunjuk aksen tingkat seri (`accent.series` ter-normalisasi); `undefined` bila tidak ada. */
export function accentHintSeries(spec: StudioChartV1): string | undefined {
  return accentOf(spec)?.series;
}

/** Terapkan petunjuk aksen ke titik berlabel sama (atau berindeks sama); yang tak cocok diabaikan. */
function applyAccentHint(spec: StudioChartV1, code: ChartCode, pts: CategoricalPoint[], maxAccent: number): CategoricalPoint[] {
  const t = accentHintTarget(spec);
  const hit = (p: CategoricalPoint, i: number): boolean => (typeof t === "number" ? i === t : p.label === t);
  if (t === undefined || !pts.some(hit)) return pts;
  const out = pts.map((p, i) => (hit(p, i) ? { ...p, accent: true } : p));
  const n = out.filter((p) => p.accent).length;
  if (n > maxAccent) {
    throw defect("DATUM-26", `${figureLabel(spec)} — ${n} batang beraksen (data + petunjuk aksen); maks ${maxAccent}`, { code, accents: n });
  }
  return out;
}
