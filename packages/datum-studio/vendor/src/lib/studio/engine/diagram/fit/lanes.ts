/**
 * engine/diagram/fit — pemisahan jalur di kanal antar-lapis (FIG-02b2, audit research/18 §6 P1-12).
 *
 * Rute ortogonal 3 segmen: kaki tegak di sisi "atas" kanal (koordinat `top`), lintasan mendatar
 * pada `mid`, kaki tegak di sisi "bawah" (`bottom`). Untuk kanal mendatar (rute kiri/kanan)
 * sumbu ditukar: `top` = kaki di sisi kiri, `bottom` = kaki di sisi kanan. Tepi yang berbagi `mid`
 * berimpit; di sini tiap tepi mendapat `mid` sendiri dan urutan jalur dipilih agar persilangan
 * yang tersisa minimal (biaya berpasangan, tukar-tetangga sampai stabil). Fungsi murni.
 */

export interface LaneEdge {
  /** Koordinat kaki yang menempel sisi atas (kiri) kanal. */
  top: number;
  /** Koordinat kaki yang menempel sisi bawah (kanan) kanal. */
  bottom: number;
}

const inside = (v: number, a: number, b: number): boolean => v > Math.min(a, b) + 1e-6 && v < Math.max(a, b) - 1e-6;

/**
 * Persilangan bila `e` berada di jalur lebih atas daripada `f`: kaki atas `f` menembus lintasan
 * `e`, dan kaki bawah `e` menembus lintasan `f`.
 */
export function laneCost(e: LaneEdge, f: LaneEdge): number {
  return (inside(f.top, e.top, e.bottom) ? 1 : 0) + (inside(e.bottom, f.top, f.bottom) ? 1 : 0);
}

/** Urutan jalur atas -> bawah (indeks masukan) dengan total biaya berpasangan minimal lokal. */
export function laneOrder(items: readonly LaneEdge[]): number[] {
  // Urutan awal: menurut tujuan (kaki bawah) menurun untuk tepi ke kanan, lalu indeks.
  const ord = items.map((_, i) => i);
  ord.sort((i, j) => items[j].bottom - items[i].bottom || i - j);
  let swapped = true;
  for (let pass = 0; swapped && pass < items.length + 2; pass++) {
    swapped = false;
    for (let k = 0; k + 1 < ord.length; k++) {
      const a = items[ord[k]];
      const b = items[ord[k + 1]];
      if (laneCost(a, b) > laneCost(b, a)) {
        [ord[k], ord[k + 1]] = [ord[k + 1], ord[k]];
        swapped = true;
      }
    }
  }
  return ord;
}

/** Jarak jalur maksimum (mm) — setengah kisi vertikal; minimum 0,5 mm agar lint (0,15 mm) bersih. */
export const LANE_PITCH_MAX_MM = 2.38;
export const LANE_PITCH_MIN_MM = 0.5;

/**
 * `n` posisi jalur berbeda di dalam pita [lo, hi], berpusat pada `center` sejauh pita mengizinkan.
 * Bila pita terlalu sempit untuk jarak minimum, pita dilampaui secara simetris (dilaporkan pemanggil).
 */
export function lanePositions(n: number, lo: number, hi: number, center: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [Math.min(hi, Math.max(lo, center))];
  const room = Math.max(0, hi - lo);
  const pitch = Math.max(LANE_PITCH_MIN_MM, Math.min(LANE_PITCH_MAX_MM, room / (n - 1)));
  const span = pitch * (n - 1);
  let start = center - span / 2;
  if (span <= room) start = Math.min(Math.max(start, lo), hi - span);
  else start = (lo + hi) / 2 - span / 2;
  return Array.from({ length: n }, (_, i) => Number((start + i * pitch).toFixed(3)));
}

/**
 * Kelompok tepi yang lintasan mendatarnya saling tumpang (komponen terhubung interval); tepi
 * tunggal tidak perlu jalur sendiri. Mengembalikan daftar kelompok (indeks masukan, urut naik).
 */
export function overlapClusters(items: readonly LaneEdge[]): number[][] {
  const idx = items.map((_, i) => i).filter((i) => Math.abs(items[i].top - items[i].bottom) > 1e-6);
  idx.sort((i, j) => Math.min(items[i].top, items[i].bottom) - Math.min(items[j].top, items[j].bottom) || i - j);
  const out: number[][] = [];
  let cur: number[] = [];
  let curHi = -Infinity;
  for (const i of idx) {
    const lo = Math.min(items[i].top, items[i].bottom);
    const hi = Math.max(items[i].top, items[i].bottom);
    if (cur.length && lo < curHi - 1e-6) {
      cur.push(i);
      curHi = Math.max(curHi, hi);
    } else {
      if (cur.length > 1) out.push([...cur].sort((a, b) => a - b));
      cur = [i];
      curHi = hi;
    }
  }
  if (cur.length > 1) out.push([...cur].sort((a, b) => a - b));
  return out;
}
