/**
 * Modul engine/chart/family-p2 (I24, 01_specs.md §8.2), diisi S34.
 *
 * Renderer SVG kode P-09 Bullet, P-10 Waterfall, P-12 Small multiples, P-13 Quadrant,
 * P-14 Arrow chart, P-15 Table chart (§5.3). Didaftarkan lewat peta kontrak
 * `chartFamilyP2` yang disebar `CHART_RENDERERS` (contract/dispatch, D01); modul ini tidak
 * mengimpor dispatch maupun core/index (tanpa siklus impor).
 *
 * Setiap renderer: gaya `datum` (bawaan; port pustakachart bila ada acuan) dan `gallery`
 * (panel Gambar 8.1), parameter khusus registri (`chart.kind.<KODE>.*`), aksen tunggal,
 * huruf pt fisik >= `chart.minFontPt`, deterministik (masukan sama -> SVG sama). Kunci
 * `params` diselesaikan resolver tunggal chart/core (PARAM_ALIAS / PARAM_IGNORED, D-87).
 * Lint keluaran (huruf, warna, aksen, lebar, tinggi) dijalankan `renderChart`/komposit.
 */
import type { ChartRendererMap } from "../../../contract";
import { renderArrow } from "./arrow";
import { renderBullet } from "./bullet";
import { renderSmallMultiples } from "./small-multiples";
import { renderTable } from "./table";
import { renderQuadrant } from "./quadrant";
import { renderWaterfall } from "./waterfall";


/** Kode P-09, P-10, P-12..P-15 (01_specs.md §5.3). */
export const chartFamilyP2: ChartRendererMap = {
  "P-09": renderBullet,
  "P-10": renderWaterfall,
  "P-12": renderSmallMultiples,
  "P-13": renderQuadrant,
  "P-14": renderArrow,
  "P-15": renderTable,
};
