/**
 * engine/diagram/fit — pengurutan dalam lapis gaya Sugiyama (FIG-02b2, audit research/18 §6 P1-11).
 *
 * Fungsi murni atas id simpul: lapis tetap (tingkat agen atau longest-path), urutan dalam lapis
 * dengan barycenter dua arah + transpose lokal. Urutan agen adalah urutan awal; hasil dipakai
 * hanya bila jumlah persilangan TURUN tegas, sehingga masukan tanpa silang tidak berubah.
 * Deterministik: seri diputus oleh posisi saat ini (sort stabil).
 */

export type EdgeIds = ReadonlyArray<readonly [string, string]>;

/** Persilangan tepi antara dua lapis bersebelahan (pasangan inversi posisi). */
export function bilayerCrossings(upper: readonly string[], lower: readonly string[], edges: EdgeIds): number {
  const pu = new Map(upper.map((id, i) => [id, i]));
  const pl = new Map(lower.map((id, i) => [id, i]));
  const segs: Array<[number, number]> = [];
  for (const [a, b] of edges) {
    if (pu.has(a) && pl.has(b)) segs.push([pu.get(a)!, pl.get(b)!]);
    else if (pu.has(b) && pl.has(a)) segs.push([pu.get(b)!, pl.get(a)!]);
  }
  let n = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a1, b1] = segs[i];
      const [a2, b2] = segs[j];
      if ((a1 - a2) * (b1 - b2) < 0) n++;
    }
  }
  return n;
}

/** Jumlah persilangan semua pasangan lapis bersebelahan. */
export function totalCrossings(layers: ReadonlyArray<readonly string[]>, edges: EdgeIds): number {
  let n = 0;
  for (let i = 0; i + 1 < layers.length; i++) n += bilayerCrossings(layers[i], layers[i + 1], edges);
  return n;
}

/** Urutkan `layer` menurut barycenter posisi tetangganya di `ref`; tanpa tetangga = posisi lama. */
function barySort(layer: readonly string[], ref: readonly string[], edges: EdgeIds): string[] {
  const pr = new Map(ref.map((id, i) => [id, i]));
  const scale = ref.length > 1 ? (layer.length - 1) / (ref.length - 1) : 1;
  const key = layer.map((id, i) => {
    const ns: number[] = [];
    for (const [a, b] of edges) {
      if (a === id && pr.has(b)) ns.push(pr.get(b)!);
      else if (b === id && pr.has(a)) ns.push(pr.get(a)!);
    }
    return { id, i, k: ns.length ? (ns.reduce((s, v) => s + v, 0) / ns.length) * scale : i };
  });
  key.sort((p, q) => p.k - q.k || p.i - q.i);
  return key.map((x) => x.id);
}

/** Transpose lokal: tukar tetangga dalam lapis selama persilangan total turun. */
function transpose(layers: string[][], edges: EdgeIds): void {
  let improved = true;
  let guard = 0;
  while (improved && guard++ < 50) {
    improved = false;
    for (let li = 0; li < layers.length; li++) {
      for (let i = 0; i + 1 < layers[li].length; i++) {
        const before = totalCrossings(layers, edges);
        const L = layers[li];
        [L[i], L[i + 1]] = [L[i + 1], L[i]];
        if (totalCrossings(layers, edges) < before) improved = true;
        else [L[i], L[i + 1]] = [L[i + 1], L[i]];
      }
    }
  }
}

export interface OrderResult {
  layers: string[][];
  before: number;
  after: number;
  changed: boolean;
}

/** Barycenter dua arah (`sweeps` putaran) + transpose; hanya dipakai bila persilangan turun tegas. */
export function orderLayers(layers: ReadonlyArray<readonly string[]>, edges: EdgeIds, opts: { sweeps?: number } = {}): OrderResult {
  const init = layers.map((l) => [...l]);
  const before = totalCrossings(init, edges);
  if (before === 0) return { layers: init, before, after: 0, changed: false };
  let best = init.map((l) => [...l]);
  let bestN = before;
  const cur = init.map((l) => [...l]);
  const sweeps = opts.sweeps ?? 8;
  for (let s = 0; s < sweeps && bestN > 0; s++) {
    if (s % 2 === 0) for (let i = 1; i < cur.length; i++) cur[i] = barySort(cur[i], cur[i - 1], edges);
    else for (let i = cur.length - 2; i >= 0; i--) cur[i] = barySort(cur[i], cur[i + 1], edges);
    transpose(cur, edges);
    const n = totalCrossings(cur, edges);
    if (n < bestN) {
      bestN = n;
      best = cur.map((l) => [...l]);
    }
  }
  if (bestN >= before) return { layers: init, before, after: before, changed: false };
  return { layers: best, before, after: bestN, changed: true };
}

/** Penetapan lapis longest-path dari tepi (sumber = lapis 0); urutan dalam lapis = urutan masukan. */
export function longestPathLayers(ids: readonly string[], edges: EdgeIds): string[][] {
  const known = new Set(ids);
  const rank = new Map<string, number>(ids.map((id) => [id, 0]));
  // Relaksasi terbatas |V| putaran (siklus tidak membuat rank tak hingga).
  for (let it = 0; it < ids.length; it++) {
    let moved = false;
    for (const [a, b] of edges) {
      if (!known.has(a) || !known.has(b) || a === b) continue;
      const r = rank.get(a)! + 1;
      if (r > rank.get(b)! && r < ids.length) {
        rank.set(b, r);
        moved = true;
      }
    }
    if (!moved) break;
  }
  const out: string[][] = [];
  for (const id of ids) {
    const r = rank.get(id)!;
    while (out.length <= r) out.push([]);
    out[r].push(id);
  }
  return out.filter((l) => l.length > 0);
}
