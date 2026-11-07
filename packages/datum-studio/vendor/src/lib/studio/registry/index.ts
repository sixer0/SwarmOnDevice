/** Re-ekspor registri (01_specs.md §12.1 T36): chart (T06), lint (T07), section (T35), slot + cakupan dan permukaan parameter (SR-05), jenis kontrak (C58, DC-06). */
export * from "./charts";
export * from "./contracts";
export * from "./essentials";
export * from "./lint";
export * from "./sections";
export * from "./slots";

// D-368: chart.custom (register 05 §12, C59/C60, I68; isi milik DC-26 di charts.ts) dinamai
// eksplisit agar hilangnya salah satu nama di charts.ts memecah tsc, bukan diam-diam lenyap dari barel.
export {
  CHART_CUSTOM_DATA_SHAPES,
  CHART_CUSTOM_FORM_COUNT,
  CHART_CUSTOM_FORM_IDS,
  CHART_CUSTOM_FORMS,
  resolveChartCustom,
  type ChartCustomDataShape,
  type ChartCustomFormDef,
  type ChartCustomFormId,
} from "./charts";
