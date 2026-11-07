/**
 * Modul engine/chart/family-k1 (I27, 01_specs.md §8.2), diisi S37.
 *
 * Ekspor kontrak: `chartFamilyK1: ChartRendererMap` berisi K-01 stacked bar, K-02 100 %
 * stacked bar, K-03 diverging bar, K-04 population pyramid, K-05 donut, K-06 pie
 * (01_specs.md §5.3). Registrasi lewat mekanisme kontrak: `contract/dispatch.ts` (D01)
 * menyebar peta ini ke `CHART_RENDERERS`; berkas ini tidak mengimpor dispatch.
 *
 * Tiap renderer: gaya `datum` (default) atau `gallery`, parameter khusus registri
 * (`chart.kind.<KODE>.*`, lihat berkas per keluarga), aksen (medan `accent` / alias
 * `params`), huruf dalam pt fisik (SvgDoc inti), deterministik (tanpa acak/waktu).
 * Kunci `params` diselesaikan resolver tunggal chart/core (PARAM_ALIAS / PARAM_IGNORED, D-87).
 * Lint keluaran tingkat atas dijalankan `renderChart` inti (finalizeChart).
 */
import type { ChartRendererMap } from "../../../contract";
import { renderDiverging } from "./diverging";
import { renderPie } from "./pie";
import { renderStack } from "./stack";

export { DOMINANCE_RATIO, DONUT_INNER_RATIO } from "./pie";

/**
 * Tinggi acuan pustakachart (`tinggi_mm`, mm) untuk kode ber-acuan bila spec tanpa
 * `heightMm` (CB1 (d) +/- 3 mm): K-02 v19 50 (PC:429), K-03 v21 58 (PC:446), K-04 v23 58
 * (PC:471); K-01 memakai helper `_stack_rows` yang sama dengan v19 (50). Dibaca
 * `estimateHeightMm` inti bila permintaan S37 ke S32 diterapkan; K-05/K-06 tanpa acuan.
 */
export const K1_REFERENCE_HEIGHT_MM: Readonly<Partial<Record<"K-01" | "K-02" | "K-03" | "K-04", number>>> = {
  "K-01": 50,
  "K-02": 50,
  "K-03": 58,
  "K-04": 58,
};
export { largestRemainderPercent, polar, sliceAngles, slicePath } from "./arc";


/** Kode K-01..K-06 (01_specs.md §5.3). */
export const chartFamilyK1: ChartRendererMap = {
  "K-01": (s, c, t) => renderStack("K-01", s, c, t),
  "K-02": (s, c, t) => renderStack("K-02", s, c, t),
  "K-03": (s, c, t) => renderDiverging("K-03", s, c, t),
  "K-04": (s, c, t) => renderDiverging("K-04", s, c, t),
  "K-05": (s, c, t) => renderPie("K-05", s, c, t),
  "K-06": (s, c, t) => renderPie("K-06", s, c, t),
};
