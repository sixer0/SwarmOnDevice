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

// ------------------------------------------------------------------ Swarm 1.2.8 row 56d: runs off container rules
/**
 * Row 56d (C134 G3-07): a container rule of a swimlane frame as `build/svg.ts` draws it (lane rules, phase separators,
 * pool borders, pool head and lane header rules): `vertical` = a line x = `c` from `lo` to `hi` (y), else y = `c` (x).
 */
export interface RouteRule {
  vertical: boolean;
  c: number;
  lo: number;
  hi: number;
}

/** Row 56d: least distance (mm) between a connector run and a parallel container rule it lies along. */
export const RULE_CLEAR_MM = 1.0;
/** Row 56d: a run found on a rule moves this far off it (the rule stays visible beside the line). */
export const RULE_OFFSET_MM = 1.5;
/** Row 56d: least visible line kept before the arrowhead when a run moves (the default head 3.2 mm + 1 mm, as 57c). */
const RULE_HEAD_RUN_MM = 4.2;

const frameRules = new WeakMap<object, RouteRule[]>();

/** Row 56d: the swimlane frame fields this module reads (`layout-b/swimlane.ts` SwimFrame). */
interface RuleFrame {
  orientation: "horizontal" | "vertical";
  lanes: ReadonlyArray<{ lo: number; hi: number }>;
  phases: ReadonlyArray<{ lo: number; hi: number }>;
  top: number;
  headBottom: number;
  bottom: number;
  gutter: number;
  pools?: ReadonlyArray<{ lo: number; hi: number; lanes: number[] }>;
  poolHead?: number;
}

/**
 * Row 56d (C134 G3-07): record the container rules of a placed swimlane sheet (`build/place.ts`), from its frame and
 * its horizontal lane boxes, in the positions `build/svg.ts` `laneDecorSvg` / `swimFrameSvg` / `swimPoolsSvg` draw them.
 * `half` = half the pool border stroke. A sheet without a frame has no rules.
 */
export function setRouteRules(sheet: object, f: RuleFrame | undefined, lanes: ReadonlyArray<{ y: number; h: number }>, W: number, half: number): void {
  if (!f) return;
  const r: RouteRule[] = [];
  const v = (c: number, lo: number, hi: number) => r.push({ vertical: true, c, lo, hi });
  const h = (c: number, lo: number, hi: number) => r.push({ vertical: false, c, lo, hi });
  if (f.orientation === "horizontal") {
    f.phases.forEach((p, i) => i > 0 && v(p.lo, f.top, f.bottom));
    if (f.pools) {
      const strip = f.poolHead ?? 0;
      for (const p of f.pools) {
        h(p.lo, 0, W);
        h(p.hi, 0, W);
        v(half, p.lo, p.hi);
        v(W - half, p.lo, p.hi);
        v(strip, p.lo, p.hi);
        v(f.gutter, p.lo, p.hi);
        p.lanes.forEach((li, j) => j > 0 && h((f.lanes[p.lanes[j - 1]].hi + f.lanes[li].lo) / 2.0, strip, W));
      }
    } else {
      for (const ln of lanes) {
        h(ln.y, 0, W);
        if (f.gutter) v(f.gutter, ln.y, ln.y + ln.h);
      }
    }
  } else {
    f.phases.forEach((p, i) => i > 0 && h(p.lo, 0, W));
    if (f.pools) {
      const head = f.poolHead ?? f.top;
      for (const p of f.pools) {
        v(p.lo, f.top, f.bottom);
        v(p.hi, f.top, f.bottom);
        h(f.top + half, p.lo, p.hi);
        h(f.bottom, p.lo, p.hi);
        h(head, p.lo, p.hi);
        p.lanes.forEach((li, j) => j > 0 && v(f.lanes[li].lo, head, f.bottom));
      }
    } else {
      for (const ln of f.lanes) {
        if (ln.lo > 1e-6) v(ln.lo, f.top, f.bottom);
        h(f.headBottom, ln.lo, ln.hi);
      }
    }
  }
  frameRules.set(sheet, r);
}

/** Row 56d: the container rules recorded for `sheet` (empty = none). */
export function routeRulesOf(sheet: object): readonly RouteRule[] {
  return frameRules.get(sheet) ?? [];
}

/** Row 56d: maximal axis-parallel runs [first, last] point index of a polyline (zero-length steps join the run). */
function axisRuns(P: readonly Pt[]): Array<{ a: number; b: number; vertical: boolean }> {
  const out: Array<{ a: number; b: number; vertical: boolean }> = [];
  let a = 0;
  let vertical: boolean | null = null;
  for (let i = 0; i + 1 < P.length; i++) {
    const dx = Math.abs(P[i + 1][0] - P[i][0]);
    const dy = Math.abs(P[i + 1][1] - P[i][1]);
    if (dx < EPS && dy < EPS) continue;
    const vert = dx < EPS ? true : dy < EPS ? false : null;
    if (vert === null) return []; // a diagonal route (straight / curved style): not handled
    if (vertical === null) vertical = vert;
    else if (vert !== vertical) {
      out.push({ a, b: i, vertical });
      a = i;
      vertical = vert;
    }
  }
  if (vertical !== null) out.push({ a, b: P.length - 1, vertical });
  return out;
}

/**
 * Row 56d (C134 G3-07, register N8-C25): a connector run that lies on a container rule (lane rule, phase separator, pool
 * border; within `RULE_CLEAR_MM`, overlapping it by more than 1 mm) hides the rule and makes lane membership ambiguous.
 * Each such inner run (not the first or last run, which leave and enter the nodes) moves `RULE_OFFSET_MM` off the rule,
 * to the side where the route stays valid: its neighbouring runs keep their direction, the source run keeps
 * `min(own, 2 mm)`, the run into the head keeps `min(own, RULE_HEAD_RUN_MM)`, no node other than the ends is crossed,
 * no parallel rule comes within `RULE_CLEAR_MM`, and the measured conflicts (crossings, collinear runs) do not rise.
 * Collinear points of a neighbouring run passed by the move collapse onto the new corner. `skip[i]` = keep path i.
 * No rules: the input is returned as it is (byte-identical for every non-swimlane figure).
 */
export function offRules(
  input: readonly Pt[][],
  rules: readonly RouteRule[],
  ends: ReadonlyArray<readonly [string, string]>,
  boxes: readonly Box[],
  W: number,
  skip: readonly boolean[],
): Pt[][] {
  if (!rules.length) return input as Pt[][];
  let paths = input.map((p) => [...p]);
  let base = score(paths);
  for (let e = 0; e < paths.length; e++) {
    if (skip[e]) continue;
    const runs = axisRuns(paths[e]);
    for (let r = 1; r + 1 < runs.length; r++) {
      const P = paths[e];
      const { a, b, vertical } = runs[r];
      const k = vertical ? 0 : 1; // the run's fixed coordinate
      const c = P[a][k];
      const lo = Math.min(P[a][1 - k], P[b][1 - k]);
      const hi = Math.max(P[a][1 - k], P[b][1 - k]);
      if (hi - lo <= 1.0) continue;
      const near = (x: number) => rules.filter((u) => u.vertical === vertical && Math.abs(u.c - x) < RULE_CLEAR_MM - 1e-9 && Math.min(u.hi, hi) - Math.max(u.lo, lo) > 1.0);
      const on = near(c);
      if (!on.length) continue;
      const prev = runs[r - 1];
      const next = runs[r + 1];
      const cands = on.flatMap((u) => [u.c - RULE_OFFSET_MM, u.c + RULE_OFFSET_MM]).sort((x, y) => Math.abs(x - c) - Math.abs(y - c) || x - y);
      let pick: { Q: Pt[]; sc: number } | null = null;
      for (const nc of cands) {
        if (near(nc).length) continue;
        // neighbouring runs keep their direction and a visible length
        const keeps = (from: number, min: number) => {
          const d0 = c - P[from][k];
          const d1 = nc - P[from][k];
          return Math.sign(d0) === Math.sign(d1) && Math.abs(d1) >= Math.min(Math.abs(d0), min) - 1e-9;
        };
        if (!keeps(prev.a, prev.a === 0 ? 2.0 : 0.5) || !keeps(next.b, next.b === P.length - 1 ? RULE_HEAD_RUN_MM : 0.5)) continue;
        const Q = [...P];
        const set = (i: number): Pt => (k === 0 ? [nc, P[i][1]] : [P[i][0], nc]);
        for (let i = a; i <= b; i++) Q[i] = set(i);
        // collinear points of the neighbouring runs that the move passes collapse onto the corner
        for (let i = prev.a + 1; i < a; i++) if ((P[i][k] - nc) * (P[prev.a][k] - nc) < 0 || Math.abs(P[i][k] - P[prev.a][k]) > Math.abs(nc - P[prev.a][k])) Q[i] = set(i);
        for (let i = b + 1; i < next.b; i++) if ((P[i][k] - nc) * (P[next.b][k] - nc) < 0 || Math.abs(P[i][k] - P[next.b][k]) > Math.abs(nc - P[next.b][k])) Q[i] = set(i);
        let ok = Q.every(([x, y]) => x >= -EPS && x <= W + EPS && y >= -EPS);
        // no other node is crossed; the moved run itself also stays out of its own end nodes
        for (let s = 0; ok && s + 1 < Q.length; s++) {
          for (const n of boxes) {
            const own = n.id === ends[e][0] || n.id === ends[e][1];
            if ((!own || (s >= a && s < b)) && hitsBox(Q[s], Q[s + 1], n)) ok = false;
          }
        }
        if (!ok) continue;
        const trial = paths.map((p, i) => (i === e ? Q : p));
        const sc = score(trial);
        if (sc > base) continue;
        pick = { Q, sc };
        break;
      }
      if (pick) {
        paths = paths.map((p, i) => (i === e ? pick!.Q : p));
        base = pick.sc;
      }
    }
  }
  return paths;
}
