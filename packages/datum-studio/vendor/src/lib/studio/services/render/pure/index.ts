/**
 * services/render/pure (IP-43a): orkestrator render tanpa DB.
 *
 * Dipakai layanan render (SR-15, setelah memuat revisi/job dari DB) dan CLI
 * render/benchmark (SR-33, FIX-5) agar semua jalur menjalankan urutan §8.2
 * yang sama: templat -> override -> aset -> figur -> assemble -> lint.
 */
export {
  renderSnapshot,
  pureRequestedFormats,
  PURE_DEFAULT_DOC_FORMATS,
  type PureRenderFile,
  type PureRenderOptions,
  type PureRenderResult,
} from "./render";
export { COMPOSITE_CHART_TEMPLATE, chartTemplateFor, isCompositeChart, pureChartSvg } from "./chart";
export { createDetachedJob, DetachedRenderJob, InlineSpecReader, type InlineArtifactSpec } from "./job";
export { applyRenderScope, snapshotAssetShas, type ScopedSnapshot } from "./scope";
