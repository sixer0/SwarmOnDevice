/**
 * engine/chart/family-h2 — H-06 contour (S36). Acuan bentuk: pustakachart `v71_contour`
 * (PC:1053-1063: contourf ramp tinta + contour ink400 + clabel); gaya galeri: panel H-06
 * Gambar 8.2 (garis kontur ink400 tanpa isian, satu garis beraksen, sumbu L hitam, tanpa label).
 *
 * Data `matrix`: `values[r][c]` pada kisi teratur (baris x kolom, masing-masing >= 2), nilai
 * hingga. Kisi dipakai apa adanya (resampling 40 x 60 hanya jalur paritas, CHART_DATA_CONSTRAINTS).
 *
 * Algoritma (deterministik, tanpa acak): marching squares per tingkat L.
 * - Pojok sel dinilai "di atas" bila v >= L. Titik potong pada sisi sel diinterpolasi linier
 *   dan dihitung SEKALI per sisi (kunci sisi kanonik), sehingga sel bertetangga berbagi titik
 *   yang sama persis.
 * - Pelana (dua pojok diagonal di atas): diputus oleh rerata empat pojok (pusat sel). Pusat
 *   >= L -> pojok atas tersambung, garis memisahkan pojok bawah; sebaliknya garis memisahkan
 *   pojok atas. Isian memakai putusan yang sama (heksagon vs dua segitiga).
 * - Segmen dirangkai menjadi polyline lewat kunci sisi (bukan koordinat): rantai terbuka
 *   dimulai dari ujung bertetangga satu, sisanya loop tertutup; urutan = urutan sel.
 * - Isian (gaya datum): himpunan {v >= L} per tingkat, sel penuh digabung per baris menjadi
 *   persegi, sel sebagian menjadi poligon; satu `<path>` per tingkat, tingkat lebih tinggi
 *   ditumpuk di atas. Warna hanya token ramp (ink100, ink200, ink400) agar keluarga warna
 *   tetap satu (lint 25, K-32); acuan PC memakai ramp sampai ink900 — dipangkas agar label
 *   kontur ink900 tetap terbaca (deviasi tercatat).
 * - Label tingkat (gaya datum): di tengah panjang busur polyline terpanjang tingkat itu, garis
 *   diputus di bawah label (padanan `clabel(inline=True)`), tanpa kotak (P7-15). Setiap tingkat
 *   yang tergambar berlabel (acuan PC `clabel` melabel kedelapan tingkat, S79 E6/SR-48 H-06):
 *   bila polyline terpanjang < 3 x lebar celah label, garis TIDAK diputus dan label cadangan
 *   dipasang di titik tengah busurnya dengan halo kertas, dijepit ke dalam bidang plot, lalu
 *   dilaporkan (REPORT `H-06-LABEL`, D-296 FIX-C2) — tidak pernah dibuang diam-diam.
 *
 * Params (kunci pendek, spec galeri S94):
 * - `levels`: bilangan bulat 1..12 atau daftar angka eksplisit (yang di luar (min, maks)
 *   dibuang). Bilangan bulat N, gaya `datum` (S79 E6, acuan PC:1057 `contourf(levels=8)`):
 *   aturan matplotlib = tick `MaxNLocator(N + 1, min_n_ticks=1)` atas [min, maks], hanya yang
 *   di dalam (min, maks), bawaan N = 8 (fixture paritas -86..-40 -> -84..-42 langkah 6).
 *   Gaya `gallery` (panel Gambar 8.2): N garis berjarak sama di antara min dan maks, bawaan 6;
 * - `accentLevel`: "tertinggi" | "terendah" | "none" | angka (tingkat terdekat); bisa juga lewat
 *   medan `accent.point` (angka atau "tertinggi"/"terendah"). Bawaan tanpa aksen;
 * - `rowOrder`: "atas ke bawah" (bawaan; baris 0 di atas, konvensi matriks) | "bawah ke atas"
 *   (baris 0 di bawah, konvensi medan/peta), alias "topDown" | "bottomUp".
 */
import type { ChartCanvas, LintIssue, ResolvedTemplate, StudioChartV1, SvgResult } from "../../../contract";
import { fmt } from "../../bind";
import { defect } from "../core/guards";
import { maxNLocatorTicks } from "../core/numeric";
import { type SvgDoc, num, ptToMm, textWidthMm } from "../core/svg";
import { type H2Prep, assertAccentCount, closeDoc, finite, h2Enum, openDoc, prepareH2, schemaError } from "./shared";
import { fitActive, fitNote } from "../core/fit";
import { ellipsize, measure } from "../core/textfit";

/** FIG-02c: posisi label sepanjang busur (pecahan panjang) yang dicoba saat fit, tengah dulu. */
const FIT_LABEL_FRACS = [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85] as const;

const ROW_ORDER = ["atas ke bawah", "bawah ke atas", "topDown", "bottomUp"] as const;
const MAX_LEVELS = 12;
/** Bawaan jumlah tingkat: datum = PC:1057 `levels=8`; galeri = panel Gambar 8.2. */
const DEFAULT_LEVELS = { datum: 8, gallery: 6 } as const;

interface Grid {
  rows: string[];
  cols: string[];
  z: number[][];
  min: number;
  max: number;
}

type Pt = readonly [number, number];

interface Polyline {
  pts: Pt[];
  closed: boolean;
}

function requireMatrix(spec: StudioChartV1, prep: H2Prep): Grid {
  const d = spec.data;
  if (!d) throw schemaError(prep, "data wajib");
  if (d.shape !== "matrix") throw schemaError(prep, `membutuhkan data "matrix", diterima "${d.shape}"`, { shape: d.shape });
  const R = Array.isArray(d.values) ? d.values.length : 0;
  if (R === 0) throw defect("DC-G1", `${prep.fid} — grafik tanpa data`, { code: prep.code });
  const C = Array.isArray(d.values[0]) ? d.values[0].length : 0;
  if (R < 2 || C < 2) throw schemaError(prep, `kisi kontur minimal 2 x 2, diterima ${R} x ${C}`, { rows: R, cols: C });
  let min = Infinity;
  let max = -Infinity;
  d.values.forEach((row, r) => {
    if (!Array.isArray(row) || row.length !== C) throw schemaError(prep, `baris ${r} memuat ${Array.isArray(row) ? row.length : 0} nilai, bukan ${C}`, { row: r });
    row.forEach((v, c) => {
      if (!finite(v)) throw schemaError(prep, `nilai [${r}][${c}] bukan bilangan hingga`, { row: r, col: c });
      if (v < min) min = v;
      if (v > max) max = v;
    });
  });
  const rows = Array.isArray(d.rows) && d.rows.length === R ? d.rows.map(String) : Array.from({ length: R }, (_, i) => String(i));
  const cols = Array.isArray(d.cols) && d.cols.length === C ? d.cols.map(String) : Array.from({ length: C }, (_, i) => String(i));
  return { rows, cols, z: d.values, min, max };
}

function levelsOf(spec: StudioChartV1, prep: H2Prep, g: Grid): number[] {
  const v = spec.params?.levels;
  if (g.max <= g.min) return [];
  if (Array.isArray(v)) {
    const xs = v.filter(finite).filter((x) => x > g.min && x < g.max);
    return [...new Set(xs)].sort((a, b) => a - b);
  }
  const gallery = prep.style === "gallery";
  let n: number = gallery ? DEFAULT_LEVELS.gallery : DEFAULT_LEVELS.datum;
  if (v !== undefined && v !== null) {
    if (!(typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_LEVELS)) {
      throw schemaError(prep, `params.levels = ${JSON.stringify(v)} bukan bilangan bulat 1..${MAX_LEVELS} atau daftar angka`);
    }
    n = v;
  }
  if (!gallery) return maxNLocatorTicks(g.min, g.max, n + 1, 1).filter((x) => x > g.min && x < g.max);
  const span = g.max - g.min;
  return Array.from({ length: n }, (_, k) => g.min + (span * (k + 1)) / (n + 1));
}

/** Indeks tingkat beraksen; `undefined` = tanpa aksen. */
function accentLevelIndex(spec: StudioChartV1, prep: H2Prep, levels: readonly number[]): number | undefined {
  if (!levels.length) return undefined;
  const refs: Array<string | number> = [];
  const p = spec.params?.accentLevel;
  if (typeof p === "string" || typeof p === "number") refs.push(p);
  refs.push(...prep.accentRefs);
  for (const ref of refs) {
    const s = typeof ref === "string" ? ref.trim().toLowerCase() : "";
    if (s === "none" || s === "tanpa") return undefined;
    if (s === "tertinggi" || s === "highest" || s === "max") return levels.length - 1;
    if (s === "terendah" || s === "lowest" || s === "min") return 0;
    // Angka (atau string angka, desimal koma diterima) -> tingkat terdekat; seri -> yang lebih rendah.
    const x = typeof ref === "number" ? ref : s === "" ? NaN : Number(s.replace(",", "."));
    if (!Number.isFinite(x)) continue;
    let best = 0;
    levels.forEach((L, k) => {
      if (Math.abs(L - x) < Math.abs(levels[best] - x)) best = k;
    });
    return best;
  }
  return undefined;
}

/** Ramp isian ringan (token tinta saja). */
function bandFill(prep: H2Prep, k: number, n: number): string {
  const ramp = [prep.pal.ink100, prep.pal.ink200, prep.pal.ink400];
  return ramp[Math.min(ramp.length - 1, Math.floor((k * ramp.length) / Math.max(1, n)))];
}

/**
 * Satu tingkat marching squares: segmen garis (pasangan kunci sisi) dan subpath isian.
 * `P(r, c)` memetakan koordinat kisi pecahan ke mm.
 */
function marchLevel(g: Grid, L: number, P: (r: number, c: number) => Pt, wantFill: boolean): { segs: Array<[string, string]>; pts: Map<string, Pt>; fill: string[] } {
  const R = g.z.length;
  const C = g.z[0].length;
  const pts = new Map<string, Pt>();
  // Kunci sisi kanonik: h:r:c = (r,c)-(r,c+1); v:r:c = (r,c)-(r+1,c).
  const cross = (key: string): Pt => {
    const hit = pts.get(key);
    if (hit) return hit;
    const [t, rs, cs] = key.split(":");
    const r = Number(rs);
    const c = Number(cs);
    const a = g.z[r][c];
    const b = t === "h" ? g.z[r][c + 1] : g.z[r + 1][c];
    const f = (L - a) / (b - a);
    const p = t === "h" ? P(r, c + f) : P(r + f, c);
    pts.set(key, p);
    return p;
  };
  const segs: Array<[string, string]> = [];
  const fill: string[] = [];
  const poly = (ps: readonly Pt[]): string => `M${ps.map((p) => `${num(p[0])} ${num(p[1])}`).join("L")}Z`;
  for (let r = 0; r < R - 1; r++) {
    let runStart = -1;
    const flushRun = (cEnd: number): void => {
      if (runStart < 0) return;
      const a = P(r, runStart);
      const b = P(r + 1, cEnd);
      fill.push(poly([a, [b[0], a[1]], b, [a[0], b[1]]]));
      runStart = -1;
    };
    for (let c = 0; c < C - 1; c++) {
      const v = [g.z[r][c], g.z[r][c + 1], g.z[r + 1][c + 1], g.z[r + 1][c]];
      const corner: Pt[] = [P(r, c), P(r, c + 1), P(r + 1, c + 1), P(r + 1, c)];
      const edge = [`h:${r}:${c}`, `v:${r}:${c + 1}`, `h:${r + 1}:${c}`, `v:${r}:${c}`];
      const above = v.map((x) => x >= L);
      const n = above.filter(Boolean).length;
      if (n === 4) {
        if (wantFill && runStart < 0) runStart = c;
        continue;
      }
      if (wantFill) flushRun(c);
      if (n === 0) continue;
      const saddle = above[0] === above[2] && above[1] === above[3] && above[0] !== above[1];
      const centerAbove = (v[0] + v[1] + v[2] + v[3]) / 4 >= L;
      if (saddle) {
        // Pojok minoritas (kelas yang tidak memuat pusat) diisolasi oleh garis.
        for (let i = 0; i < 4; i++) {
          if (above[i] !== centerAbove) segs.push([edge[(i + 3) % 4], edge[i]]);
        }
      } else {
        const hit = [0, 1, 2, 3].filter((i) => above[i] !== above[(i + 1) % 4]);
        segs.push([edge[hit[0]], edge[hit[1]]]);
      }
      if (!wantFill) continue;
      if (saddle && !centerAbove) {
        for (let i = 0; i < 4; i++) {
          if (above[i]) fill.push(poly([cross(edge[(i + 3) % 4]), corner[i], cross(edge[i])]));
        }
      } else {
        const ring: Pt[] = [];
        for (let i = 0; i < 4; i++) {
          if (above[i]) ring.push(corner[i]);
          if (above[i] !== above[(i + 1) % 4]) ring.push(cross(edge[i]));
        }
        fill.push(poly(ring));
      }
    }
    if (wantFill) flushRun(C - 1);
  }
  for (const [a, b] of segs) {
    cross(a);
    cross(b);
  }
  return { segs, pts, fill };
}

/** Rangkai segmen (kunci sisi) menjadi polyline; deterministik menurut urutan segmen. */
function chain(segs: ReadonlyArray<[string, string]>, pts: ReadonlyMap<string, Pt>): Polyline[] {
  const at = new Map<string, number[]>();
  segs.forEach(([a, b], i) => {
    for (const k of [a, b]) {
      const l = at.get(k);
      if (l) l.push(i);
      else at.set(k, [i]);
    }
  });
  const used = new Uint8Array(segs.length);
  const out: Polyline[] = [];
  const walk = (start: number, from: string): Polyline => {
    const keys = [from];
    let cur = start;
    let key = from;
    for (;;) {
      used[cur] = 1;
      const [a, b] = segs[cur];
      key = a === key ? b : a;
      keys.push(key);
      const next = (at.get(key) ?? []).find((j) => !used[j]);
      if (next === undefined) break;
      cur = next;
    }
    const closed = keys.length > 2 && keys[0] === keys[keys.length - 1];
    const list = closed ? keys.slice(0, -1) : keys;
    return { pts: list.map((k) => pts.get(k) as Pt), closed };
  };
  segs.forEach(([a, b], i) => {
    if (used[i]) return;
    if ((at.get(a) ?? []).length === 1) out.push(walk(i, a));
    else if ((at.get(b) ?? []).length === 1) out.push(walk(i, b));
  });
  segs.forEach(([a], i) => {
    if (!used[i]) out.push(walk(i, a));
  });
  return out;
}

function lengthOf(pl: Polyline): number {
  const ps = pl.closed ? [...pl.pts, pl.pts[0]] : pl.pts;
  let s = 0;
  for (let i = 1; i < ps.length; i++) s += Math.hypot(ps[i][0] - ps[i - 1][0], ps[i][1] - ps[i - 1][1]);
  return s;
}

/** Potongan polyline pada panjang busur [s0, s1] (polyline terbuka; s dalam mm). */
function slice(ps: readonly Pt[], s0: number, s1: number): Pt[] {
  const out: Pt[] = [];
  let acc = 0;
  for (let i = 1; i < ps.length; i++) {
    const a = ps[i - 1];
    const b = ps[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const lo = acc;
    const hi = acc + len;
    acc = hi;
    if (hi < s0 || lo > s1 || len === 0) continue;
    const at = (s: number): Pt => {
      const t = Math.min(1, Math.max(0, (s - lo) / len));
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    };
    if (!out.length) out.push(at(Math.max(s0, lo)));
    out.push(at(Math.min(s1, hi)));
  }
  return out;
}

function pathOf(pieces: ReadonlyArray<{ pts: readonly Pt[]; closed: boolean }>): string {
  return pieces
    .filter((p) => p.pts.length >= 2)
    .map((p) => `M${p.pts.map((q) => `${num(q[0])} ${num(q[1])}`).join("L")}${p.closed ? "Z" : ""}`)
    .join("");
}

/** Batas: polyline terpanjang di bawah kelipatan lebar celah ini tidak diputus (label cadangan). */
const INLINE_MIN_GAPS = 3;

/**
 * Pasang label di tengah polyline terpanjang dan putus garis di bawahnya. Mengembalikan
 * potongan garis yang tersisa dan posisi label. Polyline terpanjang < `INLINE_MIN_GAPS` x
 * celah: garis utuh, label tetap di titik tengah busurnya dengan `fallback` true (pemanggil
 * memberi halo dan melaporkan). `at` hanya `undefined` bila tidak ada polyline sama sekali.
 */
function inlineLabel(
  lines: Polyline[],
  gapMm: number,
  frac = 0.5,
  pick?: number,
): { pieces: Array<{ pts: Pt[]; closed: boolean }>; at?: Pt; fallback?: { lengthMm: number } } {
  let best = -1;
  let bestLen = 0;
  lines.forEach((pl, i) => {
    const len = lengthOf(pl);
    if (len > bestLen + 1e-9) {
      best = i;
      bestLen = len;
    }
  });
  // FIG-02c: `pick` = polyline lain yang dipilih pemanggil (saat fit); bawaan = terpanjang.
  if (pick !== undefined && pick >= 0 && pick < lines.length) {
    best = pick;
    bestLen = lengthOf(lines[pick]);
  }
  const pieces: Array<{ pts: Pt[]; closed: boolean }> = lines.map((pl) => ({ pts: [...pl.pts], closed: pl.closed }));
  if (best < 0) return { pieces };
  const pl = lines[best];
  const ps = pl.closed ? [...pl.pts, pl.pts[0]] : [...pl.pts];
  // FIG-02c: `frac` (bawaan 0,5 = tengah busur, perilaku lama) dijepit agar celah tetap di busur.
  const mid = frac === 0.5 ? bestLen / 2 : Math.min(Math.max(bestLen * frac, gapMm / 2), bestLen - gapMm / 2);
  const at = slice(ps, mid, mid)[0] ?? ps[0];
  if (bestLen < gapMm * INLINE_MIN_GAPS) return { pieces, at, fallback: { lengthMm: bestLen } };
  const half = gapMm / 2;
  const rest = pl.closed
    ? [{ pts: slice([...ps, ...ps.slice(1)], mid + half, mid + bestLen - half), closed: false }]
    : [
        { pts: slice(ps, 0, mid - half), closed: false },
        { pts: slice(ps, mid + half, bestLen), closed: false },
      ];
  pieces.splice(best, 1, ...rest);
  return { pieces, at };
}

export function renderContour(spec: StudioChartV1, canvas: ChartCanvas, tpl: ResolvedTemplate): SvgResult {
  const prep = prepareH2(spec, tpl, "H-06");
  const { pal, look } = prep;
  const g = requireMatrix(spec, prep);
  const levels = levelsOf(spec, prep, g);
  const bottomUp = ["bawah ke atas", "bottomUp"].includes(h2Enum(spec, tpl, "H-06", "rowOrder", ROW_ORDER, "atas ke bawah"));
  const acc = accentLevelIndex(spec, prep, levels);
  assertAccentCount(prep, acc === undefined ? 0 : 1, "garis kontur");
  const issues: LintIssue[] = [];
  if (!levels.length) {
    issues.push({ checkId: "H-06-LEVELS", status: "REPORT", detail: `medan datar atau tanpa tingkat di dalam (${fmt(g.min, prep.dec)}, ${fmt(g.max, prep.dec)}); tidak ada garis kontur` });
  }

  const W = canvas.widthMm;
  const H = canvas.heightMm;
  const doc = openDoc(spec, prep, W, H);
  const datum = prep.style === "datum";
  const R = g.rows.length;
  const C = g.cols.length;
  const pick = (n: number): number[] => {
    const m = Math.min(5, n);
    return [...new Set(Array.from({ length: m }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, m - 1))))];
  };
  const rowTicks = pick(R);
  const colTicks = pick(C);
  const fit = fitActive();
  // FIG-02c: saat fit, talang label baris dijepit 30 % lebar (label dipotong, teks lengkap di <title>).
  const rowCapMm = fit ? W * 0.3 : Infinity;
  const tickW = datum ? Math.min(rowCapMm, Math.max(...rowTicks.map((r) => textWidthMm(g.rows[r], look.tickPt, "data")))) : 0;
  const unitBand = datum && prep.unit ? ptToMm(look.tickPt) + 1.4 : 0;
  const x0 = datum ? tickW + 2.0 : 1.2;
  const x1 = W - 1.2;
  const y0 = (datum ? 2.6 : 1.6) + unitBand;
  const y1 = H - prep.footMm - (datum ? ptToMm(look.tickPt) + 2.6 : 1.2);
  if (!(x1 - x0 > 2 && y1 - y0 > 2)) throw defect("DATUM-33", `${prep.fid} — kanvas ${W} x ${H} mm terlalu kecil untuk kontur`, { code: prep.code });
  const P = (r: number, c: number): Pt => [x0 + (c / (C - 1)) * (x1 - x0), bottomUp ? y1 - (r / (R - 1)) * (y1 - y0) : y0 + (r / (R - 1)) * (y1 - y0)];

  const marched = levels.map((L) => marchLevel(g, L, P, datum));
  if (datum) {
    marched.forEach((m, k) => {
      if (m.fill.length) doc.path(m.fill.join(""), bandFill(prep, k, levels.length), { mark: { mark: "area", series: `>= ${fmt(levels[k], prep.dec)}`, index: k } });
    });
  }

  const labels: Array<{ at: Pt; text: string; k: number; halo: boolean }> = [];
  const shortLevels: string[] = [];
  // FIG-02c (hanya saat fit): label tingkat tidak saling tumpuk — posisi sepanjang busur dicoba
  // dari tengah ke luar; kotak label yang sudah dipasang menjadi rintangan.
  const placedBoxes: Array<[number, number, number, number]> = [];
  let movedLabels = 0;
  const capMm = ptToMm(look.tickPt);
  const boxAt = (at: Pt, w: number): [number, number, number, number] => {
    const y = at[1] + capMm * 0.35;
    return [at[0] - w / 2 - 0.3, y - capMm * 0.9 - 0.2, at[0] + w / 2 + 0.3, y + capMm * 0.15 + 0.2];
  };
  const hitBox = (a: readonly number[], b: readonly number[]): boolean => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
  const inPlot = (b: readonly number[]): boolean => b[0] >= x0 && b[2] <= x1 && b[1] >= y0 - capMm && b[3] <= y1;
  marched.forEach((m, k) => {
    const lines = chain(m.segs, m.pts);
    if (!lines.length) return;
    const text = fmt(levels[k], prep.dec);
    const textW = textWidthMm(text, look.tickPt, "data");
    const gap = textW + 1.6;
    let res: ReturnType<typeof inlineLabel> = datum ? inlineLabel(lines, gap) : { pieces: lines.map((l) => ({ pts: [...l.pts], closed: l.closed })) };
    if (datum && fit && res.at && !res.fallback) {
      const wFit = measure(text, look.tickPt, "data");
      const b0 = boxAt(res.at, wFit);
      if (placedBoxes.some((q) => hitBox(q, b0)) || !inPlot(b0)) {
        // Polyline terpanjang dulu (semua pecahan), lalu polyline lain yang cukup panjang.
        const order = lines.map((pl, i) => ({ i, len: lengthOf(pl) })).filter((o) => o.len >= gap * INLINE_MIN_GAPS).sort((a, b) => b.len - a.len || a.i - b.i);
        search: for (const o of order) {
          for (const f of FIT_LABEL_FRACS) {
            const alt = inlineLabel(lines, gap, f, o.i);
            if (!alt.at || alt.fallback) continue;
            const b = boxAt(alt.at, wFit);
            if (inPlot(b) && !placedBoxes.some((q) => hitBox(q, b))) {
              res = alt;
              movedLabels++;
              break search;
            }
          }
        }
      }

      if (res.at) placedBoxes.push(boxAt(res.at, wFit));
    }
    const accent = k === acc;
    doc.path(pathOf(res.pieces), "none", {
      stroke: accent ? pal.role.accent : datum ? pal.ink700 : pal.role.contextMain,
      strokeWidthMm: accent ? look.accentMm : look.markMm,
      mark: { mark: "line", series: "isoline", index: k },
      attrs: ` data-level="${num(levels[k])}" stroke-linejoin="round"`,
    });
    if (!res.at) return;
    if (!res.fallback) {
      labels.push({ at: res.at, text, k, halo: false });
      return;
    }
    // Cadangan: garis terlalu pendek untuk diputus; label dijepit ke dalam bidang plot agar
    // tidak menabrak sumbu/tepi kanvas (busur pendek biasanya di sudut).
    const capH = ptToMm(look.tickPt);
    const cx = Math.min(x1 - textW / 2, Math.max(x0 + textW / 2, res.at[0]));
    const cy = Math.min(y1 - capH * 0.45, Math.max(y0 + capH * 0.45, res.at[1]));
    labels.push({ at: [cx, cy], text, k, halo: true });
    shortLevels.push(`${text} (${fmt(res.fallback.lengthMm, 1)} mm < ${INLINE_MIN_GAPS} x ${fmt(gap, 1)} mm)`);
  });
  if (shortLevels.length) {
    issues.push({
      checkId: "H-06-LABEL",
      status: "REPORT",
      detail: `garis kontur terlalu pendek untuk label sela pada tingkat ${shortLevels.join(", ")}; label cadangan di titik tengah garis dengan halo kertas, garis tidak diputus`,
    });
  }
  if (movedLabels) fitNote("CONTOUR_LABEL_MOVED", `${movedLabels} label tingkat kontur digeser sepanjang garisnya agar tidak bertumpuk`);
  if (fit && datum && labels.some((l) => !l.halo)) fitNote("LABEL_HALO", "label tingkat kontur diberi halo kertas (terbaca di atas batas pita isian)");
  for (const l of labels) {
    // FIG-02c: saat fit semua label tingkat berhalo kertas (label sela duduk di batas pita isian).
    const halo = l.halo || (fit && datum);
    doc.text(l.at[0], l.at[1] + ptToMm(look.tickPt) * 0.35, l.text, {
      face: "data",
      sizePt: look.tickPt,
      fill: l.k === acc ? pal.role.accent : pal.ink900,
      anchor: "middle",
      attrs: halo ? ` data-label="value" stroke="#${pal.paper}" stroke-width="0.6" paint-order="stroke"` : ' data-label="value"',
    });
  }

  drawAxes(doc, prep, g, { x0, x1, y0, y1 }, P, rowTicks, colTicks, fit ? rowCapMm : undefined);
  return closeDoc(doc, spec, prep, issues);
}

function drawAxes(
  doc: SvgDoc,
  prep: H2Prep,
  g: Grid,
  box: { x0: number; x1: number; y0: number; y1: number },
  P: (r: number, c: number) => Pt,
  rowTicks: readonly number[],
  colTicks: readonly number[],
  fitRowCapMm?: number,
): void {
  const { pal, look } = prep;
  const datum = prep.style === "datum";
  const ink = datum ? pal.ink900 : pal.role.textAxis;
  doc.open('data-axis="x"');
  doc.line(box.x0, box.y1, box.x1, box.y1, ink, look.axisMm);
  if (datum && fitRowCapMm !== undefined) {
    // FIG-02c (fit): label tick kolom dipotong ke jarak antartick; tick ujung dijaga di
    // dalam kanvas; teks lengkap di <title>.
    const xs = colTicks.map((c) => P(0, c)[0]);
    const font = { pt: look.tickPt, face: "data" as const };
    const lh = ptToMm(look.tickPt) * 1.2;
    colTicks.forEach((c, i) => {
      // Sel label = antara titik tengah ke tick tetangga (ujung: tepi kanvas); label dipotong ke
      // sel dan dijepit di dalamnya, sehingga tick ujung tidak menimpa tetangganya.
      const lo = i > 0 ? (xs[i - 1] + xs[i]) / 2 : 0.3;
      const hi = i + 1 < xs.length ? (xs[i] + xs[i + 1]) / 2 : doc.widthMm - 0.3;
      const e = ellipsize(g.cols[c], Math.max(1, hi - lo - 0.8), font);

      const w = measure(e.text, look.tickPt, "data");
      const x = Math.min(Math.max(xs[i], lo + w / 2 + 0.4), hi - w / 2 - 0.4);

      doc.textLines(x, box.y1 + ptToMm(look.tickPt) + 1.2, [e.text], { face: "data", sizePt: look.tickPt, fill: pal.ink400, anchor: "middle" }, lh, e.truncated ? g.cols[c] : undefined);
    });
  } else if (datum) {
    for (const c of colTicks) {
      // Label tepi kanan yang melewati kanvas ditambatkan ke ujungnya.
      const x = P(0, c)[0];
      const over = x + textWidthMm(g.cols[c], look.tickPt, "data") / 2 > doc.widthMm - 0.3;
      doc.text(over ? doc.widthMm - 0.3 : x, box.y1 + ptToMm(look.tickPt) + 1.2, g.cols[c], { face: "data", sizePt: look.tickPt, fill: pal.ink400, anchor: over ? "end" : "middle" });
    }
  }
  doc.close();
  doc.open('data-axis="y"');
  doc.line(box.x0, box.y0, box.x0, box.y1, ink, look.axisMm);
  if (datum && fitRowCapMm !== undefined) {
    const font = { pt: look.tickPt, face: "data" as const };
    const lh = ptToMm(look.tickPt) * 1.2;
    for (const r of rowTicks) {
      const e = ellipsize(g.rows[r], fitRowCapMm, font);
      doc.textLines(box.x0 - 1.2, P(r, 0)[1] + ptToMm(look.tickPt) * 0.35, [e.text], { face: "data", sizePt: look.tickPt, fill: pal.ink400, anchor: "end" }, lh, e.truncated ? g.rows[r] : undefined);
    }
  } else if (datum) {
    for (const r of rowTicks) doc.text(box.x0 - 1.2, P(r, 0)[1] + ptToMm(look.tickPt) * 0.35, g.rows[r], { face: "data", sizePt: look.tickPt, fill: pal.ink400, anchor: "end" });
  }

  doc.close();
  if (datum && prep.unit) doc.text(box.x0, 1.6 + ptToMm(look.tickPt) * 0.8, prep.unit, { face: "data", sizePt: look.tickPt, fill: pal.ink400 });
}
