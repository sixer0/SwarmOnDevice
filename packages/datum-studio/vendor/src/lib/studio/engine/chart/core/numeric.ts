/**
 * engine/chart/core — numerik bersama keluarga sebaran (S84 #8): satu `linspace`, satu
 * KDE Gaussian. Deterministik; urutan operasi = numpy agar paritas acuan terjaga.
 */

/**
 * `count` titik berjarak sama di [a, b] (= numpy.linspace: a + i * step, titik akhir
 * eksak b). `count` <= 1 -> `[a]` (numpy num = 1).
 */
export function linspace(a: number, b: number, count: number): number[] {
  if (count <= 1) return [a];
  const step = (b - a) / (count - 1);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(i === count - 1 ? b : a + step * i);
  return out;
}

/** KDE Gaussian (bandwidth `h` > 0) dievaluasi di `grid`. */
export function kde(values: readonly number[], grid: readonly number[], h: number): number[] {
  const n = values.length;
  const norm = 1 / (n * h * Math.sqrt(2 * Math.PI));
  return grid.map((x) => {
    let s = 0;
    for (const v of values) {
      const z = (x - v) / h;
      s += Math.exp(-0.5 * z * z);
    }
    return s * norm;
  });
}

/** Tangga langkah bawaan `matplotlib.ticker.MaxNLocator` (steps=None). */
const MPL_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/**
 * Tick `matplotlib.ticker.MaxNLocator(nbins, min_n_ticks).tick_values(vmin, vmax)` dengan
 * langkah bawaan dan `axes.autolimit_mode` "data" (port `_raw_ticks`, `scale_range`,
 * `_Edge_integer`, `_staircase`). Tick pertama <= vmin dan terakhir >= vmax (pemanggil
 * memangkas). Dipakai level kontur H-06 (`contour(levels=N)` = MaxNLocator(N + 1, 1)).
 * Nilai dibersihkan ke 12 digit bermakna agar galat titik-mengambang tidak tercetak.
 */
export function maxNLocatorTicks(vmin: number, vmax: number, nbins: number, minNTicks = 2): number[] {
  let lo = Math.min(vmin, vmax);
  let hi = Math.max(vmin, vmax);
  if (!(hi > lo)) {
    // `nonsingular`: rentang nol diperlebar seperti matplotlib (expander 1e-13 tidak berarti untuk label).
    const d = lo === 0 ? 1 : Math.abs(lo) * 0.001;
    lo -= d;
    hi += d;
  }
  const dv = hi - lo;
  const meanv = (hi + lo) / 2;
  const offset = Math.abs(meanv) / dv < 100 ? 0 : Math.sign(meanv) * 10 ** Math.floor(Math.log10(Math.abs(meanv)));
  const scale = 10 ** Math.floor(Math.log10(dv / nbins));
  const vlo = lo - offset;
  const vhi = hi - offset;
  const steps = [...MPL_STEPS.slice(0, -1).map((s) => 0.1 * s), ...MPL_STEPS, 10 * MPL_STEPS[1]].map((s) => s * scale);
  const raw = (vhi - vlo) / nbins;
  let istep = steps.findIndex((s) => s >= raw);
  if (istep < 0) istep = steps.length - 1;
  let ticks: number[] = [];
  for (let j = istep; j >= 0; j--) {
    const step = steps[j];
    const best = Math.floor(vlo / step) * step;
    const tol = offset !== 0 ? Math.min(0.4999, Math.max(1e-10, 10 ** (Math.log10(Math.abs(offset) / step) - 12))) : 1e-10;
    const divmod = (x: number): [number, number] => {
      const d = Math.floor(x / step);
      return [d, x - d * step];
    };
    const [dl, ml] = divmod(vlo - best);
    const low = Math.abs(ml / step - 1) < tol ? dl + 1 : dl;
    const [dh, mh] = divmod(vhi - best);
    const high = Math.abs(mh / step) < tol ? dh : dh + 1;
    ticks = [];
    for (let k = low; k <= high; k++) ticks.push(k * step + best);
    if (ticks.filter((t) => t <= vhi && t >= vlo).length >= minNTicks) break;
  }
  return ticks.map((t) => Number((t + offset).toPrecision(12)));
}
