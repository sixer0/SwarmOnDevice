/**
 * Pemisahan jalur rute (FIG-02b2 P1-12) di atas `routePlaced`, hanya saat fit dan hanya bila lint
 * render pertama mengukur segmen berimpit atau persilangan (`diagramFitRoute`).
 *
 * Bekerja SETELAH detur pada polilinear akhir: segmen dalam (bukan segmen pertama/terakhir yang
 * menempel simpul) dari konektor berbeda yang berimpit (sumbu sama +/- 0,15 mm, tumpang > 1 mm)
 * dikelompokkan; tiap segmen digeser ke jalurnya sendiri (jarak `lanePositions`) dan urutan jalur
 * dipilih dari kandidat (`laneOrder`, kebalikannya, urutan asal) menurut konflik terukur
 * (`edgeConflicts`: persilangan + berimpit). Pergeseran yang membuat konektor menembus simpul atau
 * membalik segmen ujung ditolak; kelompok itu dibiarkan.
 */
import { edgeConflicts } from "../fit/lint";
import { laneOrder, lanePositions, type LaneEdge } from "../fit/lanes";

export type Pt = readonly [number, number];
type Box = { id: string; x: number; y: number; w: number; h: number };

const EPS = 1e-6;
const same = (a: Pt, b: Pt) => Math.abs(a[0] - b[0]) < EPS && Math.abs(a[1] - b[1]) < EPS;

/** Buang titik kembar, taji bolak-balik (A-B-A) dan titik segaris; ujung tetap. */
export function simplifyRoute(points: readonly Pt[]): Pt[] {
  let out: Pt[] = [];
  for (const p of points) if (!out.length || !same(out[out.length - 1], p)) out.push(p);
  let changed = true;
  while (changed && out.length > 2) {
    changed = false;
    for (let i = 1; i + 1 < out.length; i++) {
      const a = out[i - 1];
      const p = out[i];
      const b = out[i + 1];
      const colin = (Math.abs(a[0] - p[0]) < EPS && Math.abs(p[0] - b[0]) < EPS) || (Math.abs(a[1] - p[1]) < EPS && Math.abs(p[1] - b[1]) < EPS);
      if (same(a, b) || colin) {
        out = same(a, b) ? [...out.slice(0, i), ...out.slice(i + 2)] : [...out.slice(0, i), ...out.slice(i + 1)];
        changed = true;
        break;
      }
    }
  }
  return out;
}

/** Segmen polilinear menembus interior kotak (susut `pad`)? Hanya segmen sumbu-sejajar. */
function hitsBox(a: Pt, b: Pt, n: Box, pad = 0.05): boolean {
  const x1 = n.x + pad;
  const y1 = n.y + pad;
  const x2 = n.x + n.w - pad;
  const y2 = n.y + n.h - pad;
  if (Math.abs(a[1] - b[1]) < EPS) return Math.min(a[0], b[0]) < x2 && Math.max(a[0], b[0]) > x1 && y1 < a[1] && a[1] < y2;
  return Math.min(a[1], b[1]) < y2 && Math.max(a[1], b[1]) > y1 && x1 < a[0] && a[0] < x2;
}

function pathOk(pts: readonly Pt[], orig: readonly Pt[], ends: readonly [string, string], boxes: readonly Box[], W: number): boolean {
  for (const [x, y] of pts) if (x < -EPS || x > W + EPS || y < -EPS) return false;
  // segmen ujung mempertahankan arah dan panjang >= 1 mm (panah tidak terbalik ke simpul)
  for (const [i, j] of [[0, 1], [pts.length - 1, pts.length - 2]] as const) {
    const d0 = [orig[j][0] - orig[i][0], orig[j][1] - orig[i][1]];
    const d1 = [pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]];
    if (d0[0] * d1[0] + d0[1] * d1[1] <= 0) return false;
    if (Math.hypot(d1[0], d1[1]) < Math.min(1.0, Math.hypot(d0[0], d0[1])) - EPS) return false;
  }
  for (let k = 0; k + 1 < pts.length; k++) {
    for (const n of boxes) {
      if (n.id === ends[0] || n.id === ends[1]) continue;
      if (hitsBox(pts[k], pts[k + 1], n)) return false;
    }
  }
  return true;
}

interface Seg {
  e: number;
  k: number;
  hor: boolean;
  c: number;
  lo: number;
  hi: number;
}

function interiorSegs(paths: readonly Pt[][]): Seg[] {
  const out: Seg[] = [];
  paths.forEach((P, e) => {
    for (let k = 1; k + 2 < P.length; k++) {
      const a = P[k];
      const b = P[k + 1];
      const hor = Math.abs(a[1] - b[1]) < EPS;
      if (!hor && Math.abs(a[0] - b[0]) >= EPS) continue;
      const ax = hor ? 0 : 1;
      out.push({ e, k, hor, c: hor ? a[1] : a[0], lo: Math.min(a[ax], b[ax]), hi: Math.max(a[ax], b[ax]) });
    }
  });
  return out;
}

/** Kelompok segmen dalam berimpit (konektor berbeda), urut deterministik. */
function coincidentClusters(segs: readonly Seg[]): Seg[][] {
  const parent = segs.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i];
      const t = segs[j];
      if (s.e === t.e || s.hor !== t.hor || Math.abs(s.c - t.c) >= 0.15) continue;
      if (Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) > 1.0) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Seg[]>();
  segs.forEach((s, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(s);
    else groups.set(r, [s]);
  });
  return [...groups.values()].filter((g) => g.length > 1 && new Set(g.map((s) => s.e)).size === g.length);
}

function laneEdgeOf(P: readonly Pt[], s: Seg): LaneEdge {
  const ax = s.hor ? 1 : 0; // sumbu kaki
  const bx = s.hor ? 0 : 1;
  const prev = P[s.k - 1][ax] < s.c ? "up" : "down";
  const next = P[s.k + 2][ax] < s.c ? "up" : "down";
  const xp = P[s.k][bx];
  const xn = P[s.k + 1][bx];
  if (prev === next) return prev === "up" ? { top: xp, bottom: Number.NaN } : { top: Number.NaN, bottom: xp };
  return prev === "up" ? { top: xp, bottom: xn } : { top: xn, bottom: xp };
}

function shifted(P: readonly Pt[], s: Seg, m: number): Pt[] {
  const Q = [...P];
  Q[s.k] = s.hor ? [P[s.k][0], m] : [m, P[s.k][1]];
  Q[s.k + 1] = s.hor ? [P[s.k + 1][0], m] : [m, P[s.k + 1][1]];
  return Q;
}

/**
 * Varian posisi jalur: berpusat (jarak maks, lalu 0,6 mm), lalu satu sisi (semua di atas/kiri atau
 * di bawah/kanan garis asal) agar jalur di sebelah garis tepi simpul tidak ditolak.
 */
function laneVariants(n: number, c: number): number[][] {
  const out = [lanePositions(n, -Infinity, Infinity, c), lanePositions(n, c - 0.3 * (n - 1), c + 0.3 * (n - 1), c)];
  for (const p of [1.2, 0.6]) {
    out.push(Array.from({ length: n }, (_, i) => Number((c - (n - 1 - i) * p).toFixed(3))));
    out.push(Array.from({ length: n }, (_, i) => Number((c + i * p).toFixed(3))));
  }
  return out;
}

const score = (paths: readonly Pt[][]) => {
  const c = edgeConflicts(paths);
  return c.cross * 2 + c.collinear;
};

/**
 * Geser segmen dalam berimpit ke jalur sendiri. `ends` = id simpul ujung per konektor; `boxes` =
 * simpul lembar. Mengembalikan jalur baru dan jumlah segmen yang digeser (0 = tidak berubah).
 */
export function nudgeRoutes(input: readonly Pt[][], ends: ReadonlyArray<readonly [string, string]>, boxes: readonly Box[], W: number): { paths: Pt[][]; moved: number } {
  let paths = input.map((p) => simplifyRoute(p));
  const orig = paths.map((p) => [...p]);
  let best = score(paths);
  let moved = 0;
  for (let round = 0; round < 2 && best > 0; round++) {
    for (const cl of coincidentClusters(interiorSegs(paths))) {
      const c = cl.reduce((a, s) => a + s.c, 0) / cl.length;
      const items = cl.map((s) => laneEdgeOf(paths[s.e], s));
      const lo = laneOrder(items);
      const orders = [lo, [...lo].reverse(), cl.map((_, i) => i)];
      let pick: Pt[][] | null = null;
      for (const pos of laneVariants(cl.length, c)) {
        for (const ord of orders) {
          const trial = paths.map((p) => [...p]);
          let ok = true;
          ord.forEach((o, rank) => {
            const s = cl[o];
            const Q = shifted(trial[s.e], s, pos[rank]);
            if (!pathOk(Q, orig[s.e], ends[s.e], boxes, W)) ok = false;
            trial[s.e] = Q;
          });
          if (!ok) continue;
          const sc = score(trial);
          if (sc < best) {
            best = sc;
            pick = trial;
          }
        }
        if (pick) break;
      }
      if (pick) {
        paths = pick;
        moved += cl.length;
      }
    }
  }
  return { paths: moved ? paths : input.map((p) => [...p]), moved };
}
