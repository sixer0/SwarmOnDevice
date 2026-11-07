/**
 * engine/chart/core — kanvas chart mm (S32, I22 `chartCanvas`) dan finalisasi hasil.
 *
 * Kanvas tingkat atas: lebar = anggota himpunan lebar figur TURUNAN templat
 * (`figureLimits`: kolom teks atau bentang penuh; A4 = 128/166 mm), tinggi
 * (0, blok teks] mm (A4 potret 247). Token chart (huruf pt fisik, garis mm) dihitung
 * pada lebar nyata ini; tidak ada skala pasca-render (D-245 H1). Kanvas panel komposit
 * memakai lebar panel. Renderer membaca `canvas.widthMm`, bukan `spec.widthMm`.
 */
import type { ChartCanvas, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { type FigureLimits, allowedWidthsText, defect, figureLimits, figureLimitsReport, isAllowedWidth, lintChartSvg, mergeReports } from "./guards";
import { chartPalette, colorFamily } from "./palette";
import { chartFloors } from "./prepare";
import { ptToMm } from "./svg";

/** Margin plot bawaan (mm): kiri/kanan 4, atas/bawah 6 (DC column, DC:205-208). */
export const PLOT_MARGIN_MM = { left: 4, right: 4, top: 6, bottom: 6 } as const;

/**
 * Kanvas tanpa cek keanggotaan lebar (panel komposit). `maxHeightMm` = blok teks
 * turunan (wajib; tanpa bawaan A4 implisit, FIX-A2 N6).
 */
export function panelCanvas(widthMm: number, heightMm: number, maxHeightMm: number): ChartCanvas {
  if (!(widthMm > 0) || !Number.isFinite(widthMm)) {
    throw defect("G2", `lebar kanvas ${widthMm} mm tidak sah`, { widthMm });
  }
  if (!(heightMm > 0) || !Number.isFinite(heightMm) || heightMm > maxHeightMm + 1e-9) {
    throw defect("DATUM-33", `tinggi kanvas ${heightMm} mm di luar (0, ${maxHeightMm}] mm; pisah gambarnya atau kurangi kategorinya`, {
      heightMm,
      maxHeightMm,
    });
  }
  const m = PLOT_MARGIN_MM;
  return {
    widthMm: widthMm as ChartCanvas["widthMm"],
    heightMm,
    plot: {
      x: m.left,
      y: m.top,
      w: Math.max(0, widthMm - m.left - m.right),
      h: Math.max(0, heightMm - m.top - m.bottom),
    },
    ptToMm,
  };
}

/** Kanvas tingkat atas: lebar wajib anggota himpunan turunan `limits` (wajib; `figureLimits(tpl.params)`). */
export function chartCanvas(widthMm: number, heightMm: number, limits: FigureLimits): ChartCanvas {
  if (!isAllowedWidth(widthMm, limits)) {
    throw defect("G2", `lebar ${String(widthMm)} mm bukan ${allowedWidthsText(limits)}`, { widthMm, allowedWidthsMm: [...limits.widthsMm] });
  }
  return panelCanvas(widthMm, heightMm, limits.maxHeightMm);
}

/**
 * Lint keluaran tingkat atas lalu gabungkan dengan laporan renderer, termasuk peringatan
 * `FIGURE_LIMITS_DEFAULT` bila templat tidak membawa batas figur turunan (FIX-A2 N6).
 */
export function finalizeChart(res: SvgResult, spec: StudioChartV1, tpl: ResolvedTemplate): SvgResult {
  const limits = figureLimits(tpl.params);
  const pal = chartPalette(spec, tpl);
  const floors = chartFloors(spec, tpl);
  const lint = lintChartSvg(res.svg, {
    minFontPt: floors.minFontPt,
    maxColors: floors.maxColors,
    family: (h) => colorFamily(h, pal),
    widths: limits.widthsMm,
    maxHeightMm: limits.maxHeightMm,
    accentHex: pal.role.accent,
    maxAccent: floors.maxAccent,
    apparatusPage: (spec.apparatus ?? "page") === "page",
  });
  const extra =
    spec.heightMm !== undefined && Math.abs(spec.heightMm - res.heightMm) > 0.05
      ? [{ checkId: "heightMm", status: "REPORT" as const, detail: `heightMm spec ${spec.heightMm} mm, kanvas ${res.heightMm} mm (tinggi dihitung mesin)` }]
      : [];
  return { ...res, report: mergeReports(res.report, lint, { checksRun: [], issues: extra }, figureLimitsReport(tpl.params)) };
}
