/**
 * engine/chart/family-s1 — statistik deskriptif deterministik untuk S-01..S-04 (S41).
 *
 * Metode (dipilih agar sama dengan acuan pustakachart/numpy/matplotlib):
 * - kuantil: interpolasi linier Hyndman-Fan tipe 7 (= `numpy.percentile` default, yang
 *   dipakai `ax.boxplot` dan `v55_violin` PC:871-897): posisi (n-1)p pada sampel terurut;
 * - kumis box plot: nilai data terjauh yang masih di dalam [Q1 - k IQR, Q3 + k IQR],
 *   k = 1,5 (= `whis=1.5` matplotlib); di luar itu pencilan;
 * - bin histogram: lebar sama di [min, maks], bin terakhir tertutup kanan (= `numpy.histogram`);
 *   min = maks -> [v - 0,5, v + 0,5] (numpy);
 * - KDE Gaussian: f(x) = sum exp(-((x - xi)/h)^2 / 2) / (n h sqrt(2 pi)); bandwidth
 *   "silverman" = 1,06 sigma(ddof 0) n^(-1/5) (= `_kde` PC:852-857, S-03) atau
 *   "scott" = sigma(ddof 1) n^(-1/5) (= `gaussian_kde`/`violinplot` matplotlib, S-04).
 *
 * Semua fungsi murni: tanpa acak, tanpa waktu; penjumlahan berurutan indeks tetap.
 */

/** Salinan terurut naik (tidak memutasi masukan). */
export function sortedAsc(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Kuantil tipe 7 dari sampel TERURUT naik; p di [0, 1]. */
export function quantile7(sorted: readonly number[], p: number): number {
  const n = sorted.length;
  if (n === 0) throw new RangeError("quantile7: sampel kosong");
  if (n === 1) return sorted[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function mean(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

/** Simpangan baku; `ddof` 0 (populasi, numpy default) atau 1 (sampel). */
export function stdDev(values: readonly number[], ddof: 0 | 1): number {
  const n = values.length;
  if (n - ddof <= 0) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / (n - ddof));
}

export interface BoxStats {
  n: number;
  min: number;
  max: number;
  q1: number;
  median: number;
  q3: number;
  /** Ujung kumis (nilai data). */
  whiskerLo: number;
  whiskerHi: number;
  /** Pencilan, urutan naik. */
  outliers: number[];
}

/**
 * Ringkasan box plot. `whisker` = pengali IQR (default 1,5); `Infinity` = kumis ke
 * min/maks tanpa pencilan.
 */
export function boxStats(values: readonly number[], whisker = 1.5): BoxStats {
  const s = sortedAsc(values);
  const q1 = quantile7(s, 0.25);
  const median = quantile7(s, 0.5);
  const q3 = quantile7(s, 0.75);
  const iqr = q3 - q1;
  const loFence = whisker === Infinity ? -Infinity : q1 - whisker * iqr;
  const hiFence = whisker === Infinity ? Infinity : q3 + whisker * iqr;
  const inside = s.filter((v) => v >= loFence && v <= hiFence);
  // matplotlib: kumis tidak pernah masuk ke dalam kotak (min(inside) dibatasi Q1, maks dibatasi Q3).
  const whiskerLo = inside.length ? Math.min(inside[0], q1) : q1;
  const whiskerHi = inside.length ? Math.max(inside[inside.length - 1], q3) : q3;
  return {
    n: s.length,
    min: s[0],
    max: s[s.length - 1],
    q1,
    median,
    q3,
    whiskerLo,
    whiskerHi,
    outliers: s.filter((v) => v < loFence || v > hiFence),
  };
}

export type BandwidthRule = "silverman" | "scott";

/**
 * Bandwidth KDE. Angka positif = mutlak (satuan data). Sigma 0 (semua nilai sama atau
 * n = 1) -> cadangan 5 persen |rerata| (atau 1 bila rerata 0); `degenerate` = true.
 */
export function bandwidth(values: readonly number[], rule: BandwidthRule | number): { h: number; degenerate: boolean } {
  if (typeof rule === "number") return { h: rule, degenerate: false };
  const n = values.length;
  const sigma = rule === "silverman" ? stdDev(values, 0) : stdDev(values, 1);
  const factor = rule === "silverman" ? 1.06 : 1;
  const h = factor * sigma * Math.pow(n, -0.2);
  if (h > 0 && Number.isFinite(h)) return { h, degenerate: false };
  const m = Math.abs(mean(values));
  return { h: m > 0 ? m * 0.05 : 1, degenerate: true };
}


/** Numerik bersama (definisi tunggal inti, S84 #8). */
import { kde, linspace } from "../core/numeric";

export { kde, linspace };

export interface HistogramBins {
  edges: number[];
  counts: number[];
  /** Nilai di luar tepi eksplisit (tidak dihitung). */
  outside: number;
}

/** Tepi bin lebar sama di [min, maks] (numpy). */
export function equalEdges(sorted: readonly number[], bins: number): number[] {
  let lo = sorted[0];
  let hi = sorted[sorted.length - 1];
  if (lo === hi) {
    lo -= 0.5;
    hi += 0.5;
  }
  return linspace(lo, hi, bins + 1);
}

/** Hitung frekuensi per bin; bin [e_i, e_{i+1}) kecuali bin terakhir [e_{k-1}, e_k]. */
export function histogram(values: readonly number[], edges: readonly number[]): HistogramBins {
  const k = edges.length - 1;
  const counts = new Array<number>(k).fill(0);
  let outside = 0;
  for (const v of values) {
    if (v < edges[0] || v > edges[k]) {
      outside++;
      continue;
    }
    // Pencarian biner: indeks i terbesar dengan edges[i] <= v, dibatasi k - 1.
    let lo = 0;
    let hi = k;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (edges[mid] <= v) lo = mid;
      else hi = mid;
    }
    counts[Math.min(lo, k - 1)]++;
  }
  return { edges: [...edges], counts, outside };
}

/** Jumlah bin aturan Sturges: ceil(log2 n) + 1. */
export function sturgesBins(n: number): number {
  return Math.ceil(Math.log2(Math.max(1, n))) + 1;
}
