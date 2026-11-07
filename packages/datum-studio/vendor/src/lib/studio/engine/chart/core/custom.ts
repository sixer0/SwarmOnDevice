/**
 * engine/chart/core — dispatch `chart.custom` (DC-27; register 05 §12, D-368).
 *
 * `code = "custom"` + `form` bukan kode chart: bentuk berbatas itu dipetakan lewat I68
 * `resolveChartCustom` (registri C59, CU-01..CU-09) ke kode keluarga tergambar yang sudah
 * ada, lalu dirender oleh perender keluarga itu apa adanya. Kombinasi di luar tabel (atau
 * data di luar `categorical`/`series`/`xy`, `form` rusak/absen) -> 422 EC28
 * `CHART_CUSTOM_FORM_UNSUPPORTED` dengan `details = { form, dataShape, supported }`
 * (05 §13.1); mesin tidak menebak bentuk terdekat.
 *
 * D-368: chart.custom mempertahankan urutan data agen. CU-01 (-> P-01, yang secara bawaan
 * mengurutkan `valueDesc`) mendapat `chart.kind.P-01.sort = "natural"` di `params` spec
 * hasil dispatch (spec menang atas templat, `./read`). Spec preset tidak pernah melewati
 * modul ini, sehingga perilaku dan SVG preset tidak berubah.
 */
import type { ChartDataShape, DrawnChartCode, ParamValue, StudioChartV1 } from "../../../contract";
import { StudioEngineError } from "../../../contract/errors";
import type { ChartCustomFormV2 } from "../../../contract/types/v2/contract";
import { CHART_CUSTOM_FORMS, CHART_CUSTOM_FORM_IDS, resolveChartCustom } from "../../../registry/charts";
import { kindKey } from "./read";

/** Spec `studio.chart/v1` yang membawa bentuk kustom (masukan mesin sebelum dispatch). */
export type StudioChartCustomV1 = Omit<StudioChartV1, "kind"> & { kind: "custom"; form: ChartCustomFormV2 };

/** Masukan mesin chart: spec preset/komposit atau spec kustom. */
export type StudioChartInput = StudioChartV1 | StudioChartCustomV1;

/**
 * Bentuk longgar untuk perakit yang menyalin `code` v2 apa adanya (compose): `kind` boleh
 * `"custom"`; `form` hanya bermakna bila `kind = "custom"`. Diselesaikan `toStudioChart`.
 */
export type StudioChartDraft = Omit<StudioChartV1, "kind"> & { kind: StudioChartV1["kind"] | "custom" };

/** Kode tergambar yang urutan datanya dijaga lewat `sort = natural` (D-368). */
const NATURAL_ORDER_CODES: ReadonlySet<DrawnChartCode> = new Set(
  CHART_CUSTOM_FORMS.filter((f) => f.id === "CU-01").map((f) => f.code),
);

export function isCustomChart(spec: StudioChartInput | StudioChartDraft): spec is StudioChartCustomV1 {
  return spec.kind === "custom";
}

function dataShapeOf(spec: { data?: unknown }): ChartDataShape | null {
  const d = spec.data;
  if (typeof d !== "object" || d === null) return null;
  const shape = (d as { shape?: unknown }).shape;
  return typeof shape === "string" ? (shape as ChartDataShape) : null;
}

/**
 * Kode tergambar untuk spec kustom (I68). Di luar CU-01..CU-09 -> StudioEngineError
 * `CHART_CUSTOM_FORM_UNSUPPORTED` (EC28).
 */
export function customChartCode(spec: { form?: unknown; data?: unknown }): DrawnChartCode {
  const form = spec.form;
  const dataShape = dataShapeOf(spec);
  const code = typeof form === "object" && form !== null && dataShape !== null ? resolveChartCustom(form as ChartCustomFormV2, dataShape) : null;
  if (code === null) {
    throw new StudioEngineError(
      "CHART_CUSTOM_FORM_UNSUPPORTED",
      `chart.custom — kombinasi form ${JSON.stringify(form ?? null)} x data "${dataShape ?? "?"}" tidak didukung; pakai salah satu ${CHART_CUSTOM_FORM_IDS.join(", ")}`,
      { form: form ?? null, dataShape, supported: [...CHART_CUSTOM_FORM_IDS] },
    );
  }
  return code;
}

/**
 * Spec kustom -> spec preset kode keluarga tergambar (tanpa `form`). CU-01 mendapat
 * `sort = natural` (D-368); medan lain disalin apa adanya. Masukan tidak dimutasi.
 */
export function resolveCustomChart(spec: StudioChartCustomV1): StudioChartV1 {
  const code = customChartCode(spec);
  const out = { ...spec, kind: code } as StudioChartV1 & { form?: unknown };
  delete out.form;
  if (NATURAL_ORDER_CODES.has(code)) {
    const params: Record<string, ParamValue> = { ...spec.params, [kindKey(code, "sort")]: "natural" };
    out.params = params;
  }
  return out as StudioChartV1;
}

/** Masukan mesin -> spec preset/komposit: kustom didispatch, lainnya dikembalikan apa adanya. */
export function toStudioChart(spec: StudioChartInput): StudioChartV1 {
  return isCustomChart(spec) ? resolveCustomChart(spec) : spec;
}

/**
 * Penyelesai untuk perakit (compose): `kind = "custom"` + `form` -> dispatch; kode lain
 * dikembalikan apa adanya (objek sama, tanpa `form`), sehingga spec preset identik byte.
 */
export function chartSpecFromDraft(draft: StudioChartDraft, form: ChartCustomFormV2 | undefined): StudioChartV1 {
  if (draft.kind === "custom") return resolveCustomChart({ ...draft, kind: "custom", form: form as ChartCustomFormV2 });
  return draft as StudioChartV1;
}
