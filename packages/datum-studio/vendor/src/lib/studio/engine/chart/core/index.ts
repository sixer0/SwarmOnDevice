/**
 * Modul engine/chart/core (I22, 01_specs.md §8.2), diisi S32.
 *
 * Ekspor kontrak: `chartCanvas`, `renderChart`, `renderComposite`, `chartCore`
 * (P-01, P-02, P-11, W-02). Helper bersama untuk keluarga S33-S43 (SvgDoc, satuan pt
 * fisik, palet/peran warna, skala nol, aparatus, baris KUNCI, penjaga, lint) diekspor
 * juga; keluarga sebaiknya mengimpor dari berkas helper (`./svg`, `./palette`, ...)
 * agar tidak menarik siklus impor contract/dispatch.
 *
 * Siklus impor: dispatch mengimpor modul ini (chartCore); `CHART_RENDERERS` hanya dibaca
 * di dalam badan fungsi (lookup.ts).
 */
export { chartCanvas, finalizeChart, panelCanvas, PLOT_MARGIN_MM } from "./canvas";
export { estimateHeightMm, renderChart, DEFAULT_HEIGHT_RATIO } from "./render";
export { applyChartIntent, attachFullLabels, chartIntentOf, CHART_INTENT_FIELDS, intentSupport, orientationTarget, type AppliedIntent } from "./intent";
export {
  COMPOSITE_DEFAULT_GAP_MM,
  EMPTY_CHART_TEMPLATE,
  PANEL_AXIS_NOTE_BAND_MM,
  PANEL_CAPTION_BAND_MM,
  PANEL_DEFAULT_PLOT_MM,
  compositeHeightMm,
  compositeLayout,
  panelInner,
  renderComposite,
  type CompositeLayout,
} from "./composite";
export { chartCore, coreHeightMm } from "./families";
export {
  chartSpecFromDraft,
  customChartCode,
  isCustomChart,
  resolveCustomChart,
  toStudioChart,
  type StudioChartCustomV1,
  type StudioChartDraft,
  type StudioChartInput,
} from "./custom";
export { chartRendererFor, drawnChartDef } from "./lookup";
export {
  ACCENT_FIELD_PARAM_KEYS,
  ACCENT_HINT_KEYS,
  accentOf,
  resolveAccent,
  type AccentResolution,
  CHART_DATA_HINT_KEYS,
  CHART_PARAM_ALT_FORMS,
  aliasValueError,
  ignoredChartParamKeys,
  resolveChartParams,
  runChartRenderer,
  type ChartParamResolution,
} from "./params";
export { CHART_REFERENCE_HEIGHT_MM, referenceHeightMm } from "./heights";
export {
  CORE_FAMILY,
  accentHintSeries,
  accentHintTarget,
  chartFloors,
  isCoreCode,
  prepareCore,
  type CoreCode,
  type CoreFamily,
  type CorePrep,
} from "./prepare";
export { BAR_MAX_THICK_MM, BAR_MIN_BODY_MM, DC_BAR_ROWS, barRows, datumHeightMm, dcHeightMm } from "./datum";
export type { BarRows } from "./datum";
export {
  FIGURE_APPARATUS_BAND_MM,
  KEY_ROW_HEIGHT_MM,
  apparatusMarker,
  centredBaseline,
  figureApparatus,
  keyRow,
  noteLine,
  type KeyItem,
} from "./apparatus";
export { keyLabelText, withChartLang, type ChartLang } from "./lang";
export {
  FIGURE_LATTICE_X_PARAM,
  FIGURE_MAX_HEIGHT_PARAM,
  FIGURE_WIDTHS_PARAM,
  FIGURE_WIDTH_TOLERANCE_MM,
  FONT_PT_TOLERANCE,
  MIN_STROKE_MM,
  accentSubjectKey,
  assertChartSpec,
  assertNonNegative,
  defect,
  figureLabel,
  figureGrid,
  figureLimits,
  isAllowedWidth,
  lintChartSvg,
  mergeReports,
  requireCategorical,
  scanSvg,
  type CategoricalPoint,
  type ChartLint,
  type ChartLintOptions,
  type FigureLimits,
  type SvgScan,
} from "./guards";
export {
  chartPalette,
  chartParam,
  colorFamily,
  colorFamilyExact,
  kindKey,
  paramBool,
  paramEnum,
  paramNum,
  paramStr,
  resolveChartColor,
  type ChartPalette,
} from "./palette";
export { decimalsFor, linearScale, niceDomain, niceStep, type NiceDomain, type Scale } from "./scale";
export {
  DC_PX_PER_MM,
  FACE_DATA,
  FACE_STRUCT,
  MM_PER_PT,
  SvgDoc,
  dcPx,
  escAttr,
  escText,
  hexColor,
  num,
  ptToMm,
  textWidthMm,
  type MarkAttrs,
  type ShapeOpts,
  type TextOpts,
} from "./svg";
