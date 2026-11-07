/**
 * engine/chart/core — skala linier dan tick "rapi" (S32).
 *
 * Garis dasar nol (CH-01, P7-04): domain bar/column/area SELALU memuat 0 bila
 * `zero` benar. Tick memakai langkah 1, 2, 2,5, 5 x 10^k. Deterministik.
 */
import { pyRound } from "../../bind";

export type Scale = (v: number) => number;

/** Pemetaan linier domain [d0, d1] ke rentang [r0, r1]; domain nol-lebar dipetakan ke r0. */
export function linearScale(d0: number, d1: number, r0: number, r1: number): Scale {
  const span = d1 - d0;
  return (v: number) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0));
}

/** Langkah rapi untuk rentang `span` dengan sasaran ~`target` interval. */
export function niceStep(span: number, target = 5): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * mag;
}

/** Jumlah desimal yang dibutuhkan untuk menulis kelipatan `step` tanpa kehilangan digit. */
export function decimalsFor(step: number): number {
  for (let d = 0; d <= 6; d++) {
    if (Math.abs(pyRound(step, d) - step) < 1e-9) return d;
  }
  return 6;
}

export interface NiceDomain {
  min: number;
  max: number;
  step: number;
  ticks: number[];
}

/**
 * Domain rapi yang memuat semua `values`. `zero` memaksa 0 di dalam domain (CH-01).
 * Tick dihitung sebagai kelipatan bulat langkah (tanpa akumulasi galat float).
 */
export function niceDomain(values: readonly number[], opts: { zero: boolean; target?: number }): NiceDomain {
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (opts.zero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  if (lo === hi) hi = lo + 1;
  const step = niceStep(hi - lo, opts.target ?? 5);
  const i0 = Math.floor(lo / step + 1e-9);
  const i1 = Math.ceil(hi / step - 1e-9);
  const dec = decimalsFor(step);
  const ticks: number[] = [];
  for (let i = i0; i <= i1; i++) ticks.push(pyRound(i * step, dec));
  return { min: ticks[0], max: ticks[ticks.length - 1], step, ticks };
}

/**
 * Domain TETAP [lo, hi] (petunjuk sumbu `chart.kind.<KODE>.axis`, IP-39): batas dipakai apa
 * adanya (garis sumbu sampai `hi`), tick = kelipatan langkah rapi DI DALAM rentang
 * (panel galeri P-11: 40..62 -> tick 40, 45, 50, 55, 60).
 */
export function fixedDomain(lo: number, hi: number, target = 5): NiceDomain {
  const step = niceStep(hi - lo, target);
  const dec = decimalsFor(step);
  const i0 = Math.ceil(lo / step - 1e-9);
  const i1 = Math.floor(hi / step + 1e-9);
  const ticks: number[] = [];
  for (let i = i0; i <= i1; i++) {
    const v = pyRound(i * step, dec);
    ticks.push(v === 0 ? 0 : v);
  }
  return { min: lo, max: hi, step, ticks };
}

/** Hasil domain berpetunjuk: `widened` = alasan bila petunjuk diperluas (REPORT AXIS_DOMAIN). */
export interface AxisDomain {
  dom: NiceDomain;
  widened?: string;
}

/**
 * Domain nilai dengan petunjuk sumbu opsional. Tanpa `axis` = `niceDomain` (perilaku lama,
 * byte-identik). Dengan `axis`: domain tetap; nilai di luar petunjuk memperluasnya (tidak
 * ada tanda di luar bingkai) dan `zero` memaksa 0 di dalam domain (CH-01), keduanya
 * dilaporkan lewat `widened`.
 */
export function axisDomain(values: readonly number[], opts: { zero: boolean; target?: number }, axis?: readonly [number, number]): AxisDomain {
  if (!axis) return { dom: niceDomain(values, opts) };
  let [lo, hi] = axis;
  const why: string[] = [];
  const vmin = Math.min(...values);
  const vmax = Math.max(...values);
  if (vmin < lo || vmax > hi) {
    lo = Math.min(lo, vmin);
    hi = Math.max(hi, vmax);
    why.push(`nilai ${vmin}..${vmax} di luar petunjuk ${axis[0]}..${axis[1]}`);
  }
  if (opts.zero && (lo > 0 || hi < 0)) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
    why.push("garis dasar nol (CH-01) memaksa 0 di dalam domain");
  }
  return { dom: fixedDomain(lo, hi, opts.target ?? 5), ...(why.length ? { widened: `domain sumbu ${lo}..${hi}: ${why.join("; ")}` } : {}) };
}
