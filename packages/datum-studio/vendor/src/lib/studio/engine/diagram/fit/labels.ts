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
 * 3. Tidak ada: label digeser menjauhi segmen dengan garis penunjuk (`leader`).
 * 4. Masih tidak ada: label bernomor; nomor di jalur, teks lengkap di baris catatan di atas kaki.
 *    Teks label tidak pernah dihapus atau dipotong (multiset teks DATA tetap, D-491).
 * Murni dan deterministik.
 */
import type { DiagramEdgeKind } from "../../../contract";
import { measure } from "../../chart/core/textfit";
import { pt2mm, role } from "../core/tokens";
import type { Box } from "./lint";

type Pt = readonly [number, number];

export interface EdgeLabelInput {
  points: ReadonlyArray<Pt>;
  label: string;
  kind: DiagramEdgeKind;
  /** Posisi bawaan: pusat x dan garis dasar teks. */
  orig: Pt;
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
}

const railPt = (): number => role("evidence_rail").size;
const railMm = (): number => pt2mm(railPt());
/** Garis dasar label = titik jalur - pt2mm(1,2) (Garis A `build_svg`). */
export const LABEL_LIFT_MM = (): number => pt2mm(1.2);
const HARD_EPS = 0.05;

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

function scorer(ctx: EdgeLabelCtx, edges: readonly EdgeLabelInput[], placed: Map<number, Box>): Scorer {
  return {
    hard(b, self) {
      let a = 0;
      for (const n of ctx.nodeBoxes) a += inter(b, grow(n, 0.3));
      for (const o of ctx.obstacles) a += inter(b, o);
      for (const [i, p] of placed) if (i !== self) a += inter(b, grow(p, 0.4));
      const out = Math.max(0, -b[0], b[2] - ctx.W, (ctx.yMin ?? 0) - b[1], b[3] - ctx.yMax);
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

/** Segmen jalur, terpanjang dulu (urut stabil). */
function segOrder(points: ReadonlyArray<Pt>): Array<[Pt, Pt]> {
  const segs: Array<[Pt, Pt]> = [];
  for (let i = 0; i + 1 < points.length; i++) segs.push([points[i], points[i + 1]]);
  const len = (s: [Pt, Pt]) => Math.hypot(s[1][0] - s[0][0], s[1][1] - s[0][1]);
  return segs.map((s, i) => ({ s, i })).sort((a, b) => len(b.s) - len(a.s) || a.i - b.i).map((x) => x.s);
}

const T_STEPS = [0.5, 0.25, 0.75] as const;

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
  return best;
}

/**
 * Kandidat di luar jalur dengan garis penunjuk dari titik segmen ke tepi kotak terdekat.
 * Jarak bertingkat menjauhi segmen (tegak lurus) dengan tiga geseran sejajar; penunjuk tidak boleh
 * menembus simpul lain (simpul yang memuat titik jangkar sendiri dikecualikan, mis. rak).
 * Pilihan: konektor tertutup paling sedikit, lalu penunjuk terpendek.
 */
function withLeader(e: EdgeLabelInput, kw: number, ctx: EdgeLabelCtx, sc: Scorer, self: number): Cand | null {
  const s = railMm();
  const bh = s * 1.7;
  let best: { c: Cand; len: number } | null = null;
  for (const [a, b] of segOrder(e.points)) {
    const horiz = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]);
    for (const t of T_STEPS) {
      const ax = a[0] + (b[0] - a[0]) * t;
      const ay = a[1] + (b[1] - a[1]) * t;
      const inside = (n: Box) => ax >= n[0] && ax <= n[2] && ay >= n[1] && ay <= n[3];
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
  edges.forEach((e, i) => {
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
    const l = withLeader(e, kw, ctx, sc, i);
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
