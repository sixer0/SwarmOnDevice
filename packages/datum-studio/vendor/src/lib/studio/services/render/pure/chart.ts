/**
 * Render chart komposit tanpa templat dokumen (IP-43a, permintaan FIX-5, D-134).
 *
 * Layanan render (`figures.ts` `chartSvg`) merender chart tunggal dengan
 * templat dokumen, tetapi chart komposit dengan `renderComposite(spec)` tanpa
 * argumen templat, sehingga mesin diam-diam memakai `EMPTY_CHART_TEMPLATE`.
 * Modul ini menjadikan pilihan itu eksplisit: komposit SELALU diberi templat
 * bawaan `COMPOSITE_CHART_TEMPLATE` (= `EMPTY_CHART_TEMPLATE` mesin chart),
 * bukan templat dokumen. Keluarannya identik byte dengan `chartSvg` produksi;
 * penyeragaman `figures.ts` ke fungsi ini diajukan lewat `file_requests.md`.
 *
 * Modul murni: hanya mengimpor mesin chart (tanpa Prisma, tanpa I/O), sehingga
 * aman diimpor oleh `figures.ts` tanpa ketergantungan melingkar.
 */
import type { ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { EMPTY_CHART_TEMPLATE, FIGURE_MAX_HEIGHT_PARAM, FIGURE_WIDTHS_PARAM, renderChart, renderComposite, withChartLang, type ChartLang } from "../../../engine/chart/core";

/** Templat bawaan eksplisit untuk chart komposit (palet dan lantai fon dari spec, bukan dokumen). */
export const COMPOSITE_CHART_TEMPLATE: ResolvedTemplate = EMPTY_CHART_TEMPLATE;

/**
 * Templat komposit untuk satu templat dokumen (D-245 H1): `COMPOSITE_CHART_TEMPLATE`
 * ditambah HANYA batas figur turunan dokumen (`grid.allowedFigureWidthsMm`,
 * `grid.textBlockHeightMm`), agar lebar/tinggi komposit dicek terhadap kertas
 * dokumen. Palet dan lantai fon tetap bawaan (keputusan D-134 tidak berubah);
 * tanpa kunci itu di dokumen = `COMPOSITE_CHART_TEMPLATE` apa adanya.
 */
export function compositeTemplateFor(docTpl: ResolvedTemplate): ResolvedTemplate {
  const params: Record<string, ResolvedTemplate["params"][string]> = {};
  for (const k of [FIGURE_WIDTHS_PARAM, FIGURE_MAX_HEIGHT_PARAM]) {
    if (docTpl.params[k] !== undefined) params[k] = docTpl.params[k];
  }
  return Object.keys(params).length === 0 ? COMPOSITE_CHART_TEMPLATE : { ...COMPOSITE_CHART_TEMPLATE, params };
}

/** true bila spec chart adalah komposit (panel bergaya galeri). */
export function isCompositeChart(spec: StudioChartV1): boolean {
  return spec.kind === "composite";
}

/**
 * Templat yang benar-benar dipakai untuk satu spec chart: komposit memakai
 * `COMPOSITE_CHART_TEMPLATE`, chart tunggal memakai templat dokumen.
 */
export function chartTemplateFor(spec: StudioChartV1, docTpl: ResolvedTemplate): ResolvedTemplate {
  return isCompositeChart(spec) ? compositeTemplateFor(docTpl) : docTpl;
}

/**
 * Chart tunggal (templat dokumen) atau komposit (templat bawaan eksplisit). `lang` = bahasa dokumen untuk label
 * struktural di dalam gambar (baris KUNCI -> "KEY" untuk EN); tanpa nilai = ID, byte-identik dengan perilaku lama.
 */
export function pureChartSvg(spec: StudioChartV1, docTpl: ResolvedTemplate, lang?: ChartLang): SvgResult {
  return withChartLang(lang, () => (isCompositeChart(spec) ? renderComposite(spec, compositeTemplateFor(docTpl)) : renderChart(spec, docTpl)));
}
