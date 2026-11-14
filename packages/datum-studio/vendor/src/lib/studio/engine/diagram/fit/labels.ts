/**
 * engine/diagram/fit — penempatan label tepi tanpa tabrakan (FIG-02b, audit research/18 §6 P1-13).
 *
 * Masukan: posisi bawaan tiap label (`labelPos` Garis A), jalur konektor, kotak simpul, rintangan
 * lain (teks simpul, label zona/lajur), dan batas lembar (tepi kaki). Kotak label = pita knockout
 * dengan lebar mono terukur 0,6 em (`textfit` "data", huruf kapital evidence_rail) + 1,6 mm.
 *
 * Urutan:
 * 1. Label yang posisi bawaannya bebas tabrakan (simpul, rintangan, label bawaan lain, tepi lembar)
 *    tidak dipindah (pagar per unsur).
 * 2. Sisanya, berurutan: kandidat di setiap segmen (terpanjang dulu; titik 1/2, 1/4, 3/4) diberi
 *    skor = luas irisan keras (simpul, rintangan, label lain, luar lembar) lalu jumlah konektor lain
 *    yang tertutup pita (lunak). Kandidat bebas irisan keras pertama dengan skor terkecil dipakai.
 *    Bila ketiga titik tetap setiap segmen bertabrakan, label digeser sepanjang segmen (terpanjang
 *    dulu, langkah 0,5 mm) ke posisi bebas terdekat titik tengah (Swarm 1.2.6 T-04).
 * 3. Tidak ada: label digeser menjauhi segmen dengan garis penunjuk (`leader`).
 * 4. Masih tidak ada: label bernomor; nomor di jalur, teks lengkap di baris catatan di atas kaki.
 *    Teks label tidak pernah dihapus atau dipotong (multiset teks DATA tetap, D-491).
 * Swarm 1.2.8 row 57b (VIS-9, 01f §3.4): a label with `label_at` is fixed (`fixed`): its centre sits at
 * `LABEL_AT_FRACTION` of the drawn path length (`labelAtBaseline`), it is placed first and never moved; a collision
 * stays and is reported by the geometry lint (`textOverlap`, `lineThroughText`, `textOverNode`).
 * Swarm 1.2.8 row 57c (C71/C86/C101/C102/C116/C119): a position also collides (hard) when its band covers an
 * arrowhead (`heads`, the lint's `headQuad`), crosses a container rule no connector runs along (`rules`: lane rules,
 * phase separators, pool borders), covers the start or end of another connector, or leaves a stray piece of its own
 * connector beside it (shorter than `STUB_SEGMENT_MIN_MM` at the source border, shorter than 1 mm of line before the
 * head, or between `SLIVER` and 1 mm at a bend). The same tests feed the lint kind `labelCollision`, so a figure whose
 * first render breaks them is re-placed by auto-fit.
 * Murni dan deterministik.
 */
import type { DiagramEdgeKind, DiagramLabelAt } from "../../../contract";
import { measure } from "../../chart/core/textfit";
import { LABEL_AT_FRACTION, pt2mm, role } from "../core/tokens";
import { headQuad, polyHitsBox, STUB_SEGMENT_MIN_MM, type Box, type HeadSize } from "./lint";

type Pt = readonly [number, number];

export interface EdgeLabelInput {
  points: ReadonlyArray<Pt>;
  label: string;
  kind: DiagramEdgeKind;
  /** Posisi bawaan: pusat x dan garis dasar teks. */
  orig: Pt;
  /** Row 57b (VIS-9): `orig` is a `label_at` position: kept as it is, never moved. */
  fixed?: boolean;
  /** Row 57c: the connector's arrowheads (marker size), absent = none. */
  heads?: { end?: HeadSize | null; start?: HeadSize | null };
  /** Row 56d (C134 G3-09): the drawn `stroke-dasharray` (mm, from the path start), absent = solid. */
  dash?: readonly number[];
}

export type EdgeLabelMode = "keep" | "moved" | "leader" | "numbered" | "unplaced";

export interface PlacedEdgeLabel {
  mode: EdgeLabelMode;
  /** Pusat x dan garis dasar teks yang digambar di jalur (teks label, atau nomor bila `numbered`). */
  x: number;
  y: number;
  /** Teks yang digambar di jalur. */
  text: string;
  /** Lebar pita knockout (mm). */
  kw: number;
  leader?: readonly [number, number, number, number];
  number?: number;
}

export interface EdgeLabelCtx {
  W: number;
  /** Batas bawah area label (tepi atas baris kaki), `Infinity` = tanpa batas. */
  yMax: number;
  /** Batas atas area label (bawaan 0 = tepi lembar). */
  yMin?: number;
  nodeBoxes: readonly Box[];
  obstacles: readonly Box[];
  /** Label bernomor diizinkan (bawaan benar). Tidak -> posisi terbaik di jalur, mode `unplaced`. */
  allowNumbered?: boolean;
  /** Row 57c: container rules (lane rules, phase separators, pool borders) a band may not cross. */
  rules?: ReadonlyArray<{ a: Pt; b: Pt; half: number }>;
}

const railPt = (): number => role("evidence_rail").size;
const railMm = (): number => pt2mm(railPt());
/** Garis dasar label = titik jalur - pt2mm(1,2) (Garis A `build_svg`). */
export const LABEL_LIFT_MM = (): number => pt2mm(1.2);
const HARD_EPS = 0.05;

/** Row 57b (VIS-9): the point at fraction `f` (0..1) of a polyline's length (first point for an empty length). */
export function pointAtFraction(points: ReadonlyArray<Pt>, f: number): [number, number] {
  if (!points.length) return [0, 0];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) total += Math.hypot(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]);
  let rest = total * Math.min(Math.max(f, 0), 1);
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, b] = [points[i], points[i + 1]];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (rest <= len && len > 0) return [a[0] + ((b[0] - a[0]) * rest) / len, a[1] + ((b[1] - a[1]) * rest) / len];
    rest -= len;
  }
  const last = points[points.length - 1];
  return [last[0], last[1]];
}

/**
 * Row 57b (VIS-9, 01f §3.4, register N8-265 / N8-471): centre x and text baseline of a label placed `at` along its
 * drawn path: the knock-out band (`knockBox`: baseline - 1.15 s .. baseline + 0.55 s) is centred on the point at
 * `LABEL_AT_FRACTION[at]` of the path length, so the label sits on the line it names.
 */
export function labelAtBaseline(points: ReadonlyArray<Pt>, at: DiagramLabelAt): [number, number] {
  const [x, y] = pointAtFraction(points, LABEL_AT_FRACTION[at]);
  return [x, y + railMm() * 0.3];
}

/** Lebar teks evidence_rail (mono kapital 0,6 em), mm. */
export function railTextWidthMm(text: string): number {
  return measure(text.toUpperCase(), railPt(), "data");
}

/** Lebar pita knockout: lebar mono terukur + 1,6 mm. */
export function knockWidthMm(text: string): number {
  return railTextWidthMm(text) + 1.6;
}

/** Kotak pita knockout untuk pusat `cx`, garis dasar `by`, lebar `kw`. */
export function knockBox(cx: number, by: number, kw: number): Box {
  const s = railMm();
  return [cx - kw / 2, by - s * 1.15, cx + kw / 2, by + s * 0.55];
}

function inter(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

const grow = (b: Box, d: number): Box => [b[0] - d, b[1] - d, b[2] + d, b[3] + d];

/** Segmen memotong kotak (Liang-Barsky). */
export function segHitsBox(a: Pt, b: Pt, r: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const clip = (p: number, q: number): boolean => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, a[0] - r[0]) && clip(dx, r[2] - a[0]) && clip(-dy, a[1] - r[1]) && clip(dy, r[3] - a[1]) && t0 <= t1;
}

interface Scorer {
  hard(b: Box, self: number): number;
  soft(b: Box, self: number): number;
}

/** Row 57c: penalty (in the hard score's mm² unit) of one placement rule broken by a band. */
const RULE_PENALTY = 1.0;
/** Row 57c: length (mm) of a connector's start and end that a label of another connector may not cover. */
const END_CLEAR_MM = 3.0;
/** Row 57c: a visible piece shorter than this beside a band is not seen (lint `SLIVER_MM`). */
const SLIVER = 0.25;
/**
 * Row 56d (C134 G3-09): least visible source piece beside a band that stops before the run's end (the lint's tick limit
 * is half `STUB_SEGMENT_MIN_MM`; 1.24 mm beside a 2.85 mm band still read as a stray piece in the M3 eye check).
 */
const SOURCE_PIECE_MIN_MM = 1.5;
/** Row 57c: least visible line between a band and the base of its connector's arrowhead, and beside a band at a bend. */
const HEAD_LINE_MM = 1.0;

/** Row 57c: parameter interval of segment a-b inside box `r`, or null (Liang-Barsky). */
function clipSeg(a: Pt, b: Pt, r: Box): [number, number] | null {
  let t0 = 0;
  let t1 = 1;
  const d = [b[0] - a[0], b[1] - a[1]];
  const ps = [-d[0], d[0], -d[1], d[1]];
  const qs = [a[0] - r[0], r[2] - a[0], a[1] - r[1], r[3] - a[1]];
  for (let i = 0; i < 4; i++) {
    if (Math.abs(ps[i]) < 1e-12) {
      if (qs[i] < 0) return null;
      continue;
    }
    const t = qs[i] / ps[i];
    if (ps[i] < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return t1 - t0 > 1e-9 ? [t0, t1] : null;
}

/**
 * Row 57c: the band leaves a stray piece of its own connector: on each segment it covers, the visible piece between the
 * band and the segment's end is too short for its end (source border < `STUB_SEGMENT_MIN_MM`, head end < head + 1 mm,
 * bend between `SLIVER` and 1 mm).
 */
function strayPiece(e: EdgeLabelInput, b: Box): boolean {
  const runs = straightRuns(e.points);
  const n = runs.length;
  const headL = e.heads?.end ? e.heads.end.L : 0;
  const tailL = e.heads?.start ? e.heads.start.L : 0;
  for (let i = 0; i < n; i++) {
    const [a, c] = runs[i];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const t = clipSeg(a, c, b);
    if (!t) continue;
    const pieces: Array<[number, "start" | "end"]> = [];
    if (t[0] > 1e-9) pieces.push([t[0] * len, "start"]);
    if (t[1] < 1 - 1e-9) pieces.push([(1 - t[1]) * len, "end"]);
    for (const [piece, side] of pieces) {
      if (piece <= SLIVER) continue;
      const src = side === "start" && i === 0;
      const head = side === "end" && i === n - 1;
      // the lint's `stubSegment` rules: a source piece under half the threshold is a tick (c); under the threshold it is
      // detached (d) when the band also covers the bend after it, so the connector comes out of the band turned
      // Row 56d (C134 G3-09): a source piece under `SOURCE_PIECE_MIN_MM` beside a band reads as a stray tick even when
      // the band stops before the bend (gallery "1"/"2": 1.24 mm on a 10.7 mm run); the band then sits further along.
      const srcNeed = t[1] < 1 - 1e-9 ? SOURCE_PIECE_MIN_MM : STUB_SEGMENT_MIN_MM;
      const need = src ? (tailL > 0 ? tailL + HEAD_LINE_MM : srcNeed) : head ? headL + HEAD_LINE_MM : HEAD_LINE_MM;
      if (piece < need) return true;
    }
  }
  return dashFragment(e, b);
}

/**
 * Row 56d (C134 G3-09): two bands over one straight run of a connector leave a visible piece between them shorter than
 * `STUB_SEGMENT_MIN_MM` (a floating stub, lint `stubSegment` (b); row162: 1.11 mm between two labels on one run).
 */
function floatBetween(points: ReadonlyArray<Pt>, b: Box, p: Box): boolean {
  for (const [a, c] of straightRuns(points)) {
    const t1 = clipSeg(a, c, b);
    const t2 = clipSeg(a, c, p);
    if (!t1 || !t2) continue;
    const gap = (Math.max(t1[0], t2[0]) - Math.min(t1[1], t2[1])) * Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (gap > SLIVER && gap < STUB_SEGMENT_MIN_MM) return true;
  }
  return false;
}

/** Row 56d (C134 G3-09): least visible length (mm) of a dash cut by a band: half the dash, at most 1 mm. */
const DASH_FRAGMENT_MM = 1.0;

/** Row 56d: distance (mm) along `points` from the start to `pt` on the path (first segment that holds it). */
function alongPath(points: ReadonlyArray<Pt>, pt: Pt): number {
  let cum = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const [a, c] = [points[i], points[i + 1]];
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const d = Math.hypot(pt[0] - a[0], pt[1] - a[1]);
    if (len > 1e-9 && Math.abs(d + Math.hypot(c[0] - pt[0], c[1] - pt[1]) - len) < 1e-6) return cum + d;
    cum += len;
  }
  return cum;
}

/**
 * Row 56d (C134 G3-09): on a dashed connector a band edge that cuts a dash leaves the piece of it beside the band; a
 * piece shorter than `DASH_FRAGMENT_MM` (or half the dash) reads as a stray dot (MINTA / PESAN: 0.17 mm under the band).
 * Dashes of a dot pattern (<= 0.5 mm) are dots by design and never count.
 */
function dashFragment(e: EdgeLabelInput, b: Box): boolean {
  const dash = e.dash;
  if (!dash || dash.length < 2) return false;
  const pat = dash.length % 2 ? [...dash, ...dash] : [...dash];
  const period = pat.reduce((x, y) => x + y, 0);
  if (!(period > 0)) return false;
  // [start, end] of each dash in one period, with its own minimum visible piece
  const dashes: Array<[number, number, number]> = [];
  for (let i = 0, at = 0; i < pat.length; at += pat[i], i++) if (i % 2 === 0 && pat[i] > 0.5) dashes.push([at, at + pat[i], Math.min(DASH_FRAGMENT_MM, pat[i] / 2)]);
  if (!dashes.length) return false;
  const total = alongPath(e.points, e.points[e.points.length - 1]);
  for (const [a, c] of straightRuns(e.points)) {
    const t = clipSeg(a, c, b);
    if (!t) continue;
    const s0 = alongPath(e.points, a);
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const cut = [
      { s: s0 + t[0] * len, before: true },
      { s: s0 + t[1] * len, before: false },
    ];
    for (const { s, before } of cut) {
      if (s <= 1e-6 || s >= total - 1e-6) continue; // the band reaches the path end: no piece on that side
      const ph = ((s % period) + period) % period;
      for (const [d0, d1, min] of dashes) {
        if (ph <= d0 + 1e-6 || ph >= d1 - 1e-6) continue;
        const piece = Math.min(before ? ph - d0 : d1 - ph, before ? s : total - s);
        if (piece > 1e-6 && piece < min - 1e-9) return true;
      }
    }
  }
  return false;
}

/**
 * Row 57c: a band at `b` on connector `points` keeps the connector's own arrowheads visible and leaves no stray piece of
 * it (`strayPiece`); used by the first-render label position (`build/svg.ts` `labelPos`) before auto-fit is needed.
 */
export function spotClear(points: ReadonlyArray<Pt>, heads: EdgeLabelInput["heads"], b: Box, dash?: readonly number[]): boolean {
  const e: EdgeLabelInput = { points, label: "", kind: "data", orig: [0, 0], heads, ...(dash ? { dash } : {}) };
  if (strayPiece(e, b)) return false;
  const g = grow(b, 0.1);
  if (heads?.end) {
    const q = headQuad(points, heads.end);
    if (q && polyHitsBox(q, g)) return false;
  }
  if (heads?.start) {
    const q = headQuad([...points].reverse(), heads.start);
    if (q && polyHitsBox(q, g)) return false;
  }
  return true;
}

/** Row 57c: an axis rule crosses band `b` where no connector runs along it (the lint's rule test, on input points). */
function ruleCrosses(r: { a: Pt; b: Pt; half: number }, b: Box, edges: readonly EdgeLabelInput[]): boolean {
  const t = clipSeg(r.a, r.b, [b[0] - r.half, b[1] - r.half, b[2] + r.half, b[3] + r.half]);
  if (!t) return false;
  const hor = Math.abs(r.a[1] - r.b[1]) < 1e-6;
  const ver = Math.abs(r.a[0] - r.b[0]) < 1e-6;
  if (!hor && !ver) return true;
  const k = hor ? 0 : 1;
  const at = (u: number) => r.a[k] + (r.b[k] - r.a[k]) * u;
  const lo = Math.min(at(t[0]), at(t[1]));
  const hi = Math.max(at(t[0]), at(t[1]));
  const line = hor ? r.a[1] : r.a[0];
  const cover: Array<[number, number]> = [];
  for (const e of edges) {
    for (let i = 0; i + 1 < e.points.length; i++) {
      const p = e.points[i];
      const q = e.points[i + 1];
      const along = hor ? Math.abs(p[1] - q[1]) < 1e-6 && Math.abs(p[1] - line) < 0.3 : Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[0] - line) < 0.3;
      if (along) cover.push([Math.min(p[k], q[k]), Math.max(p[k], q[k])]);
    }
  }
  cover.sort((x, y) => x[0] - y[0]);
  let reach = lo;
  for (const [s0, e0] of cover) {
    if (s0 > reach + 0.05) break;
    reach = Math.max(reach, e0);
  }
  return reach < hi - 0.05;
}

function scorer(ctx: EdgeLabelCtx, edges: readonly EdgeLabelInput[], placed: Map<number, Box>): Scorer {
  // Row 57c: arrowhead regions of every connector (end and start heads).
  const quads: Pt[][] = [];
  for (const e of edges) {
    if (e.heads?.end) {
      const q = headQuad(e.points, e.heads.end);
      if (q) quads.push(q);
    }
    if (e.heads?.start) {
      const q = headQuad([...e.points].reverse(), e.heads.start);
      if (q) quads.push(q);
    }
  }
  // Row 57c: the end pieces of every connector (END_CLEAR_MM along the route from each end).
  const ends: Array<{ edge: number; a: Pt; b: Pt }> = [];
  edges.forEach((e, i) => {
    if (e.points.length < 2) return;
    for (const pts of [e.points, [...e.points].reverse()]) {
      let rest = END_CLEAR_MM;
      for (let k = 0; k + 1 < pts.length && rest > 1e-9; k++) {
        const p = pts[k];
        const q = pts[k + 1];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (len < 1e-9) continue;
        const f = Math.min(1, rest / len);
        ends.push({ edge: i, a: p, b: [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f] });
        rest -= len * f;
      }
    }
  });
  return {
    hard(b, self) {
      let a = 0;
      for (const n of ctx.nodeBoxes) a += inter(b, grow(n, 0.3));
      for (const o of ctx.obstacles) a += inter(b, o);
      for (const [i, p] of placed) if (i !== self) a += inter(b, grow(p, 0.4));
      const out = Math.max(0, -b[0], b[2] - ctx.W, (ctx.yMin ?? 0) - b[1], b[3] - ctx.yMax);
      // Row 57c: arrowheads, container rules, other connectors' ends, stray pieces of the own connector.
      const g = grow(b, 0.1);
      for (const q of quads) if (polyHitsBox(q, g)) a += RULE_PENALTY;
      for (const r of ctx.rules ?? []) if (ruleCrosses(r, b, edges)) a += RULE_PENALTY;
      // another connector's first or last END_CLEAR_MM (where the reader sees it start or arrive) stays uncovered
      for (let i = 0; i < ends.length; i++) if (ends[i].edge !== self && segHitsBox(ends[i].a, ends[i].b, g)) a += RULE_PENALTY;
      if (edges[self] && strayPiece(edges[self], b)) a += RULE_PENALTY;
      // Row 56d (C134 G3-09): this band and another placed band on one connector run leave no floating piece between them
      for (const [i, p] of placed) if (i !== self && edges.some((e) => floatBetween(e.points, b, p))) a += RULE_PENALTY;
      return a + out * (b[3] - b[1]) * 4;
    },
    soft(b, self) {
      let n = 0;
      edges.forEach((e, i) => {
        if (i === self) return;
        for (let k = 0; k + 1 < e.points.length; k++) if (segHitsBox(e.points[k], e.points[k + 1], b)) n++;
      });
      return n;
    },
  };
}

/**
 * Row 57c: the straight runs of a polyline (zero-length steps dropped, consecutive collinear steps in the same direction
 * merged), longest first (stable). A route's stubs split one visible run into pieces; the slide searches use the run.
 */
export function runOrder(points: ReadonlyArray<Pt>): Array<[Pt, Pt]> {
  const runs = straightRuns(points);
  const len = (s: [Pt, Pt]) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
  return runs.map((s, i) => ({ s, i })).sort((a, b) => len(b.s) - len(a.s) || a.i - b.i).map((x) => x.s);
}

/** Row 57c: the straight runs of a polyline in path order (see `runOrder`). */
function straightRuns(points: ReadonlyArray<Pt>): Array<[Pt, Pt]> {
  const pts: Pt[] = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push(p);
  }
  const runs: Array<[Pt, Pt]> = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const last = runs[runs.length - 1];
    if (last) {
      const [la, lb] = last;
      const cross = (lb[0] - la[0]) * (b[1] - a[1]) - (lb[1] - la[1]) * (b[0] - a[0]);
      const dot = (lb[0] - la[0]) * (b[0] - a[0]) + (lb[1] - la[1]) * (b[1] - a[1]);
      if (Math.abs(cross) < 1e-9 && dot > 0 && Math.abs(lb[0] - a[0]) < 1e-9 && Math.abs(lb[1] - a[1]) < 1e-9) {
        runs[runs.length - 1] = [la, b];
        continue;
      }
    }
    runs.push([a, b]);
  }
  return runs;
}

/** Segmen jalur, terpanjang dulu (urut stabil). */
function segOrder(points: ReadonlyArray<Pt>): Array<[Pt, Pt]> {
  const segs: Array<[Pt, Pt]> = [];
  for (let i = 0; i + 1 < points.length; i++) segs.push([points[i], points[i + 1]]);
  const len = (s: [Pt, Pt]) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
  return segs.map((s, i) => ({ s, i })).sort((a, b) => len(b.s) - len(a.s) || a.i - b.i).map((x) => x.s);
}

const T_STEPS = [0.5, 0.25, 0.75] as const;
/** Row 57c: least distance (mm) of a leader's anchor from a node outline. */
const LEADER_CLEAR_MM = 1.0;

interface Cand {
  x: number;
  y: number;
  box: Box;
  hard: number;
  soft: number;
  leader?: readonly [number, number, number, number];
}

function better(a: Cand, b: Cand | null): boolean {
  if (!b) return true;
  const ah = a.hard > HARD_EPS ? a.hard : 0;
  const bh = b.hard > HARD_EPS ? b.hard : 0;
  if (Math.abs(ah - bh) > 1e-9) return ah < bh;
  return a.soft < b.soft;
}

/** Kandidat di jalur (pusat label pada titik segmen, dijepit ke lebar lembar). */
function onPath(e: EdgeLabelInput, kw: number, W: number, sc: Scorer, self: number): Cand | null {
  let best: Cand | null = null;
  for (const [a, b] of segOrder(e.points)) {
    for (const t of T_STEPS) {
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      const x = Math.min(Math.max(px, kw / 2), Math.max(kw / 2, W - kw / 2));
      const y = py - LABEL_LIFT_MM();
      const box = knockBox(x, y, kw);
      const c: Cand = { x, y, box, hard: sc.hard(box, self), soft: sc.soft(box, self) };
      if (better(c, best)) best = c;
      if (best && best.hard <= HARD_EPS && best.soft === 0) return best;
    }
  }
  if (best && best.hard <= HARD_EPS) return best;
  // Swarm 1.2.6 T-04: the three fixed spots per segment can all sit under a node while the
  // segment still has free room (e.g. an L path running just below a row of nodes). Before the
  // caller falls back to a leader line or a number, slide the label along each segment (longest
  // first) and take a collision-free spot: fewest covered connectors, then nearest the segment
  // midpoint. Only reached when every fixed spot collides, so placements found above are unchanged.
  return scanPath(e, kw, W, sc, self) ?? scanPath(e, kw, W, sc, self, runOrder(e.points)) ?? best;
}

/** T-04: collision-free spot anywhere on a segment, longest segment first (null = none). */
function scanPath(e: EdgeLabelInput, kw: number, W: number, sc: Scorer, self: number, segs = segOrder(e.points)): Cand | null {
  const stepMm = 0.5;
  let best: { c: Cand; d: number } | null = null;
  // row 57c: also over the straight runs (`runOrder`) when no segment of the route has a free spot
  for (const [a, b] of segs) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / stepMm));
    let seg: { c: Cand; d: number } | null = null;
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const px = a[0] + (b[0] - a[0]) * t;
      const py = a[1] + (b[1] - a[1]) * t;
      const x = Math.min(Math.max(px, kw / 2), Math.max(kw / 2, W - kw / 2));
      const y = py - LABEL_LIFT_MM();
      const box = knockBox(x, y, kw);
      const hard = sc.hard(box, self);
      if (hard > HARD_EPS) continue;
      const c: Cand = { x, y, box, hard, soft: sc.soft(box, self) };
      const d = Math.abs(t - 0.5) * len;
      if (!seg || c.soft < seg.c.soft || (c.soft === seg.c.soft && d < seg.d - 1e-9)) seg = { c, d };
    }
    if (seg && seg.c.soft === 0) return seg.c;
    if (seg && (!best || seg.c.soft < best.c.soft)) best = seg;
  }
  return best ? best.c : null;
}

/**
 * Row 57c: a label beside its connector, off the line (no knock-out over it): above or below a horizontal segment,
 * right or left of a vertical one, its near band edge `BESIDE_GAP_MM` plus half the widest stroke off the line, slid along
 * the segment (longest segment first, 0.5 mm steps) to the collision-free spot nearest the segment midpoint. Used when no
 * spot on the line is free (a run shorter than label plus heads, a rule across the run).
 */
function besidePath(e: EdgeLabelInput, kw: number, W: number, sc: Scorer, self: number): Cand | null {
  const s = railMm();
  const bh = s * 1.7;
  // off the line by the gap plus half the widest stroke (accent 0.72 mm), or, when that band would touch a head, by the
  // gap plus half the widest head (the band then runs over the head); the scorer's head test decides
  const headHalf = Math.max(e.heads?.end?.W ?? 0, e.heads?.start?.W ?? 0) / 2 + 0.1;
  const offs = headHalf > 0.36 ? [BESIDE_GAP_MM + 0.36, BESIDE_GAP_MM + headHalf] : [BESIDE_GAP_MM + 0.36];
  let best: { c: Cand; d: number } | null = null;
  for (const [a, b] of runOrder(e.points)) {
    const horiz = Math.abs(b[1] - a[1]) < 1e-6;
    const vert = Math.abs(b[0] - a[0]) < 1e-6;
    if (!horiz && !vert) continue;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const n = Math.max(1, Math.ceil(len / 0.5));
    for (const side of [-1, 1]) for (const off of offs) {
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const px = a[0] + (b[0] - a[0]) * t;
        const py = a[1] + (b[1] - a[1]) * t;
        // band centre: beside the line by `off` plus half the band
        const cx = horiz ? px : px + side * (off + kw / 2);
        const cy = horiz ? py + side * (off + bh / 2) : py;
        const x = Math.min(Math.max(cx, kw / 2), Math.max(kw / 2, W - kw / 2));
        const y = cy + s * 0.3; // band centre -> baseline (knockBox: baseline - 1.15 s .. + 0.55 s)
        const box = knockBox(x, y, kw);
        const hard = sc.hard(box, self);
        if (hard > HARD_EPS) continue;
        const c: Cand = { x, y, box, hard, soft: sc.soft(box, self) };
        const d = Math.abs(t - 0.5) * len + (side < 0 ? 0 : 1e-3); // above / left first on a tie
        if (!best || c.soft < best.c.soft || (c.soft === best.c.soft && d < best.d - 1e-9)) best = { c, d };
      }
    }
    const found = best as { c: Cand; d: number } | null;
    if (found && found.c.soft === 0) return found.c;
  }
  const found = best as { c: Cand; d: number } | null;
  return found ? found.c : null;
}

/** Row 57c: some point of segment a-b (9 samples) lies within `d` of polyline `pl`. */
function nearLine(a: Pt, b: Pt, pl: ReadonlyArray<Pt>, d: number): boolean {
  const dist = (p: Pt, u: Pt, v: Pt) => {
    const dx = v[0] - u[0];
    const dy = v[1] - u[1];
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - u[0]) * dx + (p[1] - u[1]) * dy) / l2)) : 0;
    return Math.hypot(p[0] - u[0] - t * dx, p[1] - u[1] - t * dy);
  };
  for (let k = 0; k <= 8; k++) {
    const p: Pt = [a[0] + ((b[0] - a[0]) * k) / 8, a[1] + ((b[1] - a[1]) * k) / 8];
    for (let i = 0; i + 1 < pl.length; i++) if (dist(p, pl[i], pl[i + 1]) < d) return true;
  }
  return false;
}

/** Row 57c: segments a-b and c-d cross or touch (orientation test, collinear overlap included). */
function segCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const on = (p: Pt, q: Pt, r: Pt) => Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9 && Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  if (((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12))) return true;
  return (Math.abs(d1) <= 1e-12 && on(c, d, a)) || (Math.abs(d2) <= 1e-12 && on(c, d, b)) || (Math.abs(d3) <= 1e-12 && on(a, b, c)) || (Math.abs(d4) <= 1e-12 && on(a, b, d));
}

/** Row 57c: gap (mm) between a connector and the near edge of a label placed beside it. */
const BESIDE_GAP_MM = 0.4;

/**
 * Kandidat di luar jalur dengan garis penunjuk dari titik segmen ke tepi kotak terdekat.
 * Jarak bertingkat menjauhi segmen (tegak lurus) dengan tiga geseran sejajar; penunjuk tidak boleh
 * menembus simpul lain (simpul yang memuat titik jangkar sendiri dikecualikan, mis. rak).
 * Pilihan: konektor tertutup paling sedikit, lalu penunjuk terpendek.
 */
function withLeader(
  e: EdgeLabelInput,
  kw: number,
  ctx: EdgeLabelCtx,
  sc: Scorer,
  self: number,
  edges: readonly EdgeLabelInput[] = [],
  placed: ReadonlyMap<number, Box> = new Map(),
): Cand | null {
  const s = railMm();
  const bh = s * 1.7;
  let best: { c: Cand; len: number } | null = null;
  for (const [a, b] of segOrder(e.points)) {
    const horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    for (const t of T_STEPS) {
      const ax = a[0] + (b[0] - a[0]) * t;
      const ay = a[1] + (b[1] - a[1]) * t;
      const inside = (n: Box) => ax >= n[0] && ax <= n[2] && ay >= n[1] && ay <= n[3];
      // Row 57c: a leader starts on the free run of its connector: not within LEADER_CLEAR_MM of a node outline (a leader
      // along a border reads as part of the node; an anchor deep inside a node, e.g. a rack, keeps the old rule) and not
      // under its own arrowhead.
      const nearOutline = ctx.nodeBoxes.some((n) => inside(grow(n, LEADER_CLEAR_MM)) && !inside(grow(n, -LEADER_CLEAR_MM)));
      const end = e.points[e.points.length - 1];
      const underHead = e.heads?.end ? Math.hypot(end[0] - ax, end[1] - ay) < e.heads.end.L : false;
      if (nearOutline || underHead) continue;
      const centres: Array<[number, number]> = [];
      for (const sign of [-1, 1]) {
        for (let k = 0; k < 10; k++) {
          for (const along of [0, -1, 1]) {
            if (horiz) centres.push([ax + along * (kw / 2 + 1.0), ay + sign * (bh / 2 + 1.0 + k * bh * 1.1)]);
            else centres.push([ax + sign * (kw / 2 + 1.0 + k * 3.0), ay + along * (bh + 1.0)]);
          }
        }
        // geser melewati simpul yang terkena sampai bebas (mis. keluar dari badan rak)
        let cx = horiz ? ax : ax + sign * (kw / 2 + 1.0);
        let cy = horiz ? ay + sign * (bh / 2 + 1.0) : ay;
        for (let step = 0; step < 8; step++) {
          const hit = ctx.nodeBoxes.find((n) => inter(knockBox(cx, cy + s * 0.3, kw), grow(n, 0.3)) > 0);
          if (!hit) break;
          if (horiz) cy = sign < 0 ? hit[1] - 0.3 - bh / 2 - 0.6 : hit[3] + 0.3 + bh / 2 + 0.6;
          else cx = sign < 0 ? hit[0] - 0.3 - kw / 2 - 0.6 : hit[2] + 0.3 + kw / 2 + 0.6;
        }
        centres.push([cx, cy]);
      }
      for (const [cx0, cy] of centres) {
        const cx = Math.min(Math.max(cx0, kw / 2), Math.max(kw / 2, ctx.W - kw / 2));
        const y = cy + s * 0.3; // pusat kotak -> garis dasar
        const box = knockBox(cx, y, kw);
        const hard = sc.hard(box, self);
        if (hard > HARD_EPS) continue;
        const px = Math.min(Math.max(ax, box[0]), box[2]);
        const py = Math.min(Math.max(ay, box[1]), box[3]);
        if (ctx.nodeBoxes.some((n) => !inside(n) && segHitsBox([ax, ay], [px, py], grow(n, -0.3)))) continue;
        if (ctx.obstacles.some((o) => segHitsBox([ax, ay], [px, py], o))) continue; // penunjuk tidak mencoret teks
        // Row 57c: a leader crosses no other label band and no other connector (it would read as a connector itself).
        if ([...placed].some(([j, b]) => j !== self && segHitsBox([ax, ay], [px, py], grow(b, 0.2)))) continue;
        if (edges.some((o, j) => j !== self && o.points.some((p, k) => k + 1 < o.points.length && segCross([ax, ay], [px, py], p, o.points[k + 1])))) continue;
        // ... and does not run beside another connector closer than LEADER_CLEAR_MM (it would read as a doubled line)
        if (edges.some((o, j) => j !== self && nearLine([ax, ay], [px, py], o.points, LEADER_CLEAR_MM))) continue;
        const c: Cand = { x: cx, y, box, hard, soft: sc.soft(box, self), leader: [ax, ay, px, py] };
        const len = Math.hypot(px - ax, py - ay);
        if (!best || c.soft < best.c.soft || (c.soft === best.c.soft && len < best.len - 1e-9)) best = { c, len };
      }
    }
  }
  return best ? best.c : null;
}

export interface EdgeLabelPlan {
  placed: PlacedEdgeLabel[];
  /** Label bernomor, urut nomor: teks lengkap + jenis (untuk baris catatan). */
  numbered: Array<{ number: number; text: string; kind: DiagramEdgeKind }>;
}

/** Tempatkan semua label tepi (lihat kepala berkas). */
export function placeEdgeLabels(edges: readonly EdgeLabelInput[], ctx: EdgeLabelCtx): EdgeLabelPlan {
  const kws = edges.map((e) => knockWidthMm(e.label));
  const origBox = edges.map((e, i) => knockBox(e.orig[0], e.orig[1], kws[i]));
  const placed = new Map<number, Box>();
  const out: Array<PlacedEdgeLabel | null> = edges.map(() => null);
  // 1. posisi bawaan bebas tabrakan -> tetap. Dua label bawaan yang saling timpa: yang pertama tetap.
  const sc = scorer(ctx, edges, placed);
  // Row 57b (VIS-9): fixed (`label_at`) labels first, as given: they are never moved and other labels avoid them.
  edges.forEach((e, i) => {
    if (!e.fixed) return;
    out[i] = { mode: "keep", x: e.orig[0], y: e.orig[1], text: e.label, kw: kws[i] };
    if (e.label.trim()) placed.set(i, origBox[i]);
  });
  edges.forEach((e, i) => {
    if (out[i]) return;
    if (!e.label.trim()) {
      out[i] = { mode: "keep", x: e.orig[0], y: e.orig[1], text: e.label, kw: kws[i] };
      return;
    }
    if (sc.hard(origBox[i], i) <= HARD_EPS) {
      out[i] = { mode: "keep", x: e.orig[0], y: e.orig[1], text: e.label, kw: kws[i] };
      placed.set(i, origBox[i]);
    }
  });
  // 2-4. sisanya berurutan
  const numbered: EdgeLabelPlan["numbered"] = [];
  edges.forEach((e, i) => {
    if (out[i]) return;
    const kw = kws[i];
    const c = onPath(e, kw, ctx.W, sc, i);
    if (c && c.hard <= HARD_EPS) {
      out[i] = { mode: "moved", x: c.x, y: c.y, text: e.label, kw };
      placed.set(i, c.box);
      return;
    }
    // Row 57c: beside the line before a leader.
    const side = besidePath(e, kw, ctx.W, sc, i);
    if (side) {
      out[i] = { mode: "moved", x: side.x, y: side.y, text: e.label, kw };
      placed.set(i, side.box);
      return;
    }
    const l = withLeader(e, kw, ctx, sc, i, edges, placed);
    if (l && l.leader) {
      out[i] = { mode: "leader", x: l.x, y: l.y, text: e.label, kw, leader: l.leader };
      placed.set(i, l.box);
      return;
    }
    if (ctx.allowNumbered === false) {
      const b = c ?? { x: e.orig[0], y: e.orig[1], box: origBox[i] };
      out[i] = { mode: "unplaced", x: b.x, y: b.y, text: e.label, kw };
      placed.set(i, b.box);
      return;
    }
    const number = numbered.length + 1;
    const mark = String(number);
    const mkw = knockWidthMm(mark);
    const m = onPath({ ...e, label: mark }, mkw, ctx.W, sc, i) ?? { x: e.orig[0], y: e.orig[1], box: knockBox(e.orig[0], e.orig[1], mkw) };
    out[i] = { mode: "numbered", x: m.x, y: m.y, text: mark, kw: mkw, number };
    placed.set(i, m.box);
    numbered.push({ number, text: e.label, kind: e.kind });
  });
  return { placed: out as PlacedEdgeLabel[], numbered };
}

export interface NoteItem {
  number: number;
  text: string;
  kind: DiagramEdgeKind;
  /** x nomor (rata kiri) dan x teks (rata kiri), baris ke-`row`. */
  xNum: number;
  xText: number;
  row: number;
}

/** Tata baris catatan label bernomor ("1  TEKS   2  TEKS"), dibungkus ke lebar `W`. */
export function layoutNotes(items: EdgeLabelPlan["numbered"], W: number): { items: NoteItem[]; rows: number } {
  const gap = 1.2;
  const sep = 3.0;
  let x = 0;
  let row = 0;
  const out: NoteItem[] = [];
  for (const it of items) {
    const wNum = railTextWidthMm(String(it.number));
    const wTxt = railTextWidthMm(it.text);
    const need = wNum + gap + wTxt;
    if (x > 0 && x + need > W) {
      row++;
      x = 0;
    }
    out.push({ ...it, xNum: x, xText: x + wNum + gap, row });
    x += need + sep;
  }
  return { items: out, rows: items.length ? row + 1 : 0 };
}
