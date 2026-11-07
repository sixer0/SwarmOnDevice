/**
 * Modul engine/chart/family-w2 (I30, 01_specs.md §8.2), diisi S40: W-06 bump, W-07 gantt
 * (milestone, garis hari ini), W-08 barcode, W-09 horizon (pita terlipat deterministik),
 * W-10 candlestick. Terdaftar ke `CHART_RENDERERS` lewat `chartFamilyW2` (dispatch D01).
 *
 * Semua renderer: gaya `datum` (bawaan) dan `gallery` (panel Gambar 8.4), aksen tunggal
 * (medan `accent` / alias params / flag data), huruf pt fisik, sumbu waktu Indonesia,
 * deterministik (masukan sama -> SVG sama). Kunci `params` diselesaikan resolver tunggal
 * chart/core (`core/params.ts`, D-87): alias pendek sah -> kunci penuh (PARAM_ALIAS),
 * lainnya PARAM_IGNORED (D-58). Bekas kunci tertunda W-07/W-08 kini ParamDef registri (IP-25).
 */
import type { ChartRendererMap } from "../../../contract";
import { renderBarcode } from "./barcode";
import { renderBump } from "./bump";
import { renderCandlestick } from "./candlestick";
import { renderGantt } from "./gantt";
import { renderHorizon } from "./horizon";

/**
 * Tinggi kanvas acuan pustakachart (`canvas(W, tinggi_mm)`: v45_bump 62, v94_gantt 62,
 * v60_barcode 40) untuk spec tanpa `heightMm` (CB1 (d) +-3 mm). Dibaca core
 * `estimateHeightMm` lewat `CHART_REFERENCE_HEIGHT_MM` (IP-25); W-09/W-10 tanpa acuan.
 */
export const W2_REFERENCE_HEIGHT_MM: Readonly<Partial<Record<"W-06" | "W-07" | "W-08", number>>> = {
  "W-06": 62,
  "W-07": 62,
  "W-08": 40,
};

/** Kode W-06..W-10 (01_specs.md §5.3). */
export const chartFamilyW2: ChartRendererMap = {
  "W-06": renderBump,
  "W-07": renderGantt,
  "W-08": renderBarcode,
  "W-09": renderHorizon,
  "W-10": renderCandlestick,
};
